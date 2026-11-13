/* eslint-disable jsdoc/require-jsdoc */
'use strict';

// ============================================================================
// Local control (BETA) – glue between the adapter and the local device gateway
//
// Local values go into the SAME per-thermostat states as the cloud values
// (groups.<G>.thermostats.<T>.*). While a thermostat is connected locally,
// the local values win and the cloud poll skips those states.
//
// Additional states:
//   info.localListening, info.localUpstreamStatus, info.localUpstreamFingerprint,
//   info.localConnected, info.localLastEvent              gateway status
//   <thermostat>.connection                                cloud / relay / local
//   <thermostat>.energy.loadWatts / estimatedToday / estimatedTotal
// ============================================================================

const fs = require('node:fs');
const path = require('node:path');

const dns = require('node:dns').promises;
const { LocalGateway, profileFromJson, profileToJson, localAddresses, isPrivateIPv4 } = require('./local/gateway');
const { ensureCertificate } = require('./local/cert');
const P = require('./local/protocol');
const W = require('./local/wd5');
const { writeScheduleStates } = require('./writers');

const STORE_NAME = 'local-gateway.json';

/** Local value -> state of the thermostat (same ids and units as the cloud). */
const MAIN_STATES = {
	online: 'online',
	heating: 'heating',
	roomTemperature: 'temperature.room',
	floorTemperature: 'temperature.floor',
	regulationMode: 'regulationMode',
	manualSetpoint: 'setpoint.manual',
	comfortSetpoint: 'setpoint.comfort',
	frostProtectionSetpoint: 'setpoint.frostProtection',
	comfortEnd: 'endTime.comfort',
	boostEnd: 'endTime.boost',
	vacationEnabled: 'vacation.enabled',
	vacationSetpoint: 'vacation.temperature',
	room: 'thermostatName',
	firmware: 'softwareVersion',
};

/** States only the local gateway provides. */
const LOCAL_ONLY_STATES = {
	connection: {
		name: 'Connection (cloud / relay / local)',
		type: 'string',
		role: 'text',
		states: { cloud: 'Cloud', relay: 'Relay (local + cloud)', local: 'Local only' },
	},
	'energy.loadWatts': { name: 'Heating load', type: 'number', role: 'value.power', unit: 'W' },
	'energy.estimatedToday': {
		name: 'Energy today (estimated from heating time x load)',
		type: 'number',
		role: 'value.energy',
		unit: 'kWh',
	},
	'energy.estimatedTotal': {
		name: 'Energy total (estimated from heating time x load)',
		type: 'number',
		role: 'value.energy',
		unit: 'kWh',
	},
};

class LocalManager {
	/**
	 * @param {any} adapter adapter instance
	 */
	constructor(adapter) {
		this.adapter = adapter;
		this.cfg = adapter.config;
		this.mode = String(this.cfg.localMode || 'off');
		this.gateway = null;
		this.dataDir = '';
		this.store = { pin: '', lastIp: '', profiles: {}, energy: {} };
		/** serial -> {at, heating} last heating report (energy estimate) */
		this.heatingTrack = new Map();
		this.lastStoreSave = 0;
		/** serial -> devId */
		this.devBySerial = new Map();
		/** serial -> pending fields while the device is not known yet */
		this.pending = new Map();
		this.ensured = new Set();
		/** serial -> last values reported locally (while connected) */
		this.values = new Map();
	}

	get enabled() {
		return this.mode === 'relay' || this.mode === 'local';
	}

	get allowCommands() {
		return this.enabled && this.cfg.localAllowCommands === true;
	}

	// ------------------------------------------------------------------------

	async start() {
		await this._loadKnownSerials();
		await this._removeOldLocalObjects();
		if (!this.enabled) {
			await this._checkStaleDnsRecord();
			return;
		}
		const a = this.adapter;
		a.log.warn(
			`Local control (BETA) enabled in "${this.mode}" mode. This feature is experimental – please report your observations.`,
		);

		await this._ensureRootObjects();

		// loaded here so the module can be used without a running js-controller (tests)
		this.dataDir = require('@iobroker/adapter-core').getAbsoluteInstanceDataDir(a);
		this._loadStore();

		const host = String(this.cfg.localUpstreamHost || '').trim();
		let cert;
		try {
			cert = ensureCertificate(this.dataDir, host || 'thermostat-gateway.local');
			if (cert.created) {
				a.log.info(`Local gateway: created a self-signed certificate in ${this.dataDir}`);
			}
		} catch (e) {
			a.log.error(`Local gateway: cannot create certificate: ${e?.message || e}`);
			return;
		}

		const listenPort = this._port(this.cfg.localListenPort, 9513);
		const profiles = new Map();
		for (const [serial, data] of Object.entries(this.store.profiles || {})) {
			const p = profileFromJson(data);
			if (p) {
				profiles.set(serial, p);
			}
		}

		const gw = new LocalGateway({
			mode: this.mode === 'local' ? 'local' : 'relay',
			cert: cert.cert,
			key: cert.key,
			listenPort,
			upstreamHost: host,
			upstreamPort: this._port(this.cfg.localUpstreamPort, listenPort),
			upstreamIp: String(this.cfg.localUpstreamIp || '').trim(),
			upstreamPin: String(this.cfg.localUpstreamPin || '').trim() || this.store.pin || '',
			cachedUpstreamIp: this.store.lastIp || '',
			profiles,
			allowedSerials: new Set(this.devBySerial.keys()),
		});
		this.gateway = gw;

		gw.on('log', (level, text) => {
			const fn = level === 'warn' ? 'warn' : level === 'info' ? 'info' : 'debug';
			a.log[fn](`Local gateway: ${text}`);
			a.safeSetState('info.localLastEvent', { val: text.slice(0, 500), ack: true });
		});
		gw.on('state', (serial, fields) => this._onState(serial, fields).catch(() => {}));
		gw.on('profile', (serial, profile) => {
			this.store.profiles[serial] = profileToJson(profile);
			this._saveStore();
		});
		gw.on('resolved', ip => {
			this.store.lastIp = ip;
			this._saveStore();
		});
		gw.on('pin', fp => {
			this.store.pin = fp;
			this._saveStore();
		});
		gw.on('upstream', status => {
			a.safeSetState('info.localUpstreamStatus', { val: status, ack: true });
			a.safeSetState('info.localUpstreamFingerprint', { val: gw.upstreamFingerprint || '', ack: true });
		});
		gw.on('unknownProtocol', info => {
			a.log.warn(
				`Local gateway: the thermostat at ${info.who} uses a protocol that is not understood yet ` +
					'(traffic is passed through unchanged and logged at debug level). Please report a debug log.',
			);
		});

		if (this.mode === 'relay' && !host && !this.cfg.localUpstreamIp) {
			a.log.warn(
				'Local gateway: no hostname/IP of the vendor device gateway configured – relaying is not possible. ' +
					'The SNI of incoming connections is logged at debug level to help finding it.',
			);
		}

		try {
			await gw.start();
			a.safeSetState('info.localListening', { val: true, ack: true });
		} catch (e) {
			a.log.error(`Local gateway: ${e?.message || e}`);
			a.safeSetState('info.localListening', { val: false, ack: true });
			this.gateway = null;
		}
	}

	/**
	 * Local control is off, but a local DNS record may still send the
	 * thermostat here – then it reaches neither this host nor the cloud.
	 */
	async _checkStaleDnsRecord() {
		const host = String(this.cfg.localUpstreamHost || '').trim();
		if (!host) {
			return;
		}
		try {
			const addrs = await dns.lookup(host, { all: true });
			const own = localAddresses();
			const hit = addrs.find(x => own.has(x.address) || isPrivateIPv4(x.address));
			if (hit) {
				this.adapter.log.warn(
					`Local control is off, but ${host} still resolves to the local address ${hit.address} ` +
						'(local DNS record). ' +
						'The thermostat cannot reach the cloud and shows offline. Remove the local DNS record ' +
						'(e.g. in Pi-hole) and power-cycle the thermostat, or switch local mode to "Relay".',
				);
			}
		} catch {
			// name not resolvable here – nothing to warn about
		}
	}

	async stop() {
		if (this.enabled && this.dataDir) {
			this._saveStore();
		}
		const gw = this.gateway;
		this.gateway = null;
		if (gw) {
			await gw.stop();
		}
	}

	// ------------------------------------------------------------------------
	// Mapping serial -> device
	// ------------------------------------------------------------------------

	/**
	 * Called from the cloud poll for every thermostat.
	 *
	 * @param {string} serial serial number
	 * @param {string} devId device id
	 */
	registerThermostat(serial, devId) {
		if (!serial) {
			return;
		}
		const known = this.devBySerial.get(serial);
		this.devBySerial.set(serial, devId);
		this.gateway?.allowedSerials.add(serial);
		if (known !== devId && this.pending.has(serial)) {
			const fields = this.pending.get(serial);
			this.pending.delete(serial);
			this._onState(serial, fields).catch(() => {});
		}
	}

	async _loadKnownSerials() {
		try {
			const objs = await this.adapter.getAdapterObjectsAsync();
			for (const [fullId, obj] of Object.entries(objs || {})) {
				if (obj?.type === 'device' && obj.native?.serialNumber) {
					const id = fullId.startsWith(`${this.adapter.namespace}.`)
						? fullId.slice(this.adapter.namespace.length + 1)
						: fullId;
					this.devBySerial.set(String(obj.native.serialNumber), id);
				}
			}
		} catch (e) {
			this.adapter.log.debug(`Local gateway: cannot read known thermostats: ${e?.message || e}`);
		}
	}

	// ------------------------------------------------------------------------
	// Commands
	// ------------------------------------------------------------------------

	/**
	 * @param {string} serial serial number
	 * @returns {boolean} the thermostat is connected to the local gateway
	 */
	isConnected(serial) {
		return !!this.gateway && this.gateway.connected.includes(serial);
	}

	/**
	 * Main states (relative to the device) the local gateway currently provides.
	 *
	 * @param {string} serial serial number
	 * @returns {Set<string>} state ids
	 */
	localStateIds(serial) {
		const out = new Set(['online']);
		for (const key of Object.keys(this.values.get(serial) || {})) {
			if (MAIN_STATES[key]) {
				out.add(MAIN_STATES[key]);
			} else if (key === 'schedule') {
				out.add('schedule');
			}
		}
		return out;
	}

	/**
	 * @param {string} serial serial number
	 * @returns {boolean} a local command can be sent now
	 */
	canCommand(serial) {
		return this.allowCommands && !!this.gateway && this.gateway.canCommand(serial);
	}

	/**
	 * Apply a mode locally. Supported: schedule, manual (permanent hold).
	 *
	 * @param {string} modeFolder apply folder name
	 * @param {string} serial serial number
	 * @param {string} devPrefix device id
	 * @returns {Promise<boolean>} true if handled locally
	 */
	async apply(modeFolder, serial, devPrefix) {
		if (!this.canCommand(serial)) {
			return false;
		}
		const a = this.adapter;
		const gw = /** @type {LocalGateway} */ (this.gateway);
		const info = gw.info(serial);
		const readNum = async (id, def, min, max) => {
			const st = await a.getStateAsync(`${devPrefix}.apply.${id}`);
			const n = Number(st?.val);
			return Math.min(max, Math.max(min, Number.isFinite(n) ? n : def));
		};
		const halfDegree = n => Math.round(n * 2) / 2;

		if (info?.variant === 'wd5') {
			let tz = info.timeZoneSec;
			if (tz === null) {
				const id = devPrefix.split('.').pop() || '';
				tz = Number(a.thermostatTimeZoneSec?.[id]) || 0;
			}
			/** @type {{mode: number, tempC?: number, end?: Date|null}|null} */
			let change = null;
			if (modeFolder === 'schedule') {
				change = { mode: W.MODE_SCHEDULE };
			} else if (modeFolder === 'manual') {
				change = { mode: W.MODE_MANUAL, tempC: halfDegree(await readNum('manual.setpoint', 21, 5, 35)) };
			} else if (modeFolder === 'comfort') {
				const tempC = halfDegree(await readNum('comfort.setpoint', 22, 12, 35));
				const minutes = Math.trunc(await readNum('comfort.durationMinutes', 180, 1, 1440));
				change = { mode: W.MODE_COMFORT, tempC, end: W.localIn(minutes, tz) };
			} else if (modeFolder === 'boost') {
				const minutes = Math.trunc(await readNum('boost.durationMinutes', 60, 1, 1440));
				change = { mode: W.MODE_BOOST, end: W.localIn(minutes, tz) };
			} else if (modeFolder === 'eco') {
				change = { mode: W.MODE_ECO };
			} else if (modeFolder === 'frostProtection') {
				change = { mode: W.MODE_FROST };
			}
			if (!change) {
				return false;
			}
			await gw.setModeWd5(serial, change);
		} else if (modeFolder === 'schedule') {
			await gw.setMode(serial, P.REGULATION_SCHEDULE);
		} else if (modeFolder === 'manual') {
			await gw.setMode(serial, P.REGULATION_MANUAL, halfDegree(await readNum('manual.setpoint', 21, 5, 35)));
		} else {
			return false;
		}
		a.log.info(`Local gateway: applied "${modeFolder}" to thermostat ${serial} locally`);
		return true;
	}

	// ------------------------------------------------------------------------
	// States
	// ------------------------------------------------------------------------

	async _onState(serial, fields) {
		const a = this.adapter;
		if (this.gateway) {
			a.safeSetState('info.localConnected', { val: this.gateway.connected.join(','), ack: true });
		}
		const devId = this.devBySerial.get(serial);
		if (!devId) {
			this.pending.set(serial, { ...(this.pending.get(serial) || {}), ...fields });
			return;
		}
		await this._ensureDeviceObjects(devId);
		this._writeMainStates(serial, devId, fields);

		if (fields.online !== undefined) {
			const connection = fields.online ? (fields.relayed ? 'relay' : 'local') : 'cloud';
			a.safeSetState(`${devId}.connection`, { val: connection, ack: true });
		}
		if (typeof fields.schedule === 'string') {
			await this._writeSchedule(serial, devId, fields.schedule);
		}
		const energy = this._trackEnergy(serial, fields);
		if (Number(fields.loadWatts) > 0) {
			a.safeSetState(`${devId}.energy.loadWatts`, { val: Number(fields.loadWatts), ack: true });
		}
		if (energy.energyToday !== undefined) {
			a.safeSetState(`${devId}.energy.estimatedToday`, { val: energy.energyToday, ack: true });
			a.safeSetState(`${devId}.energy.estimatedTotal`, { val: energy.energyTotal, ack: true });
		}
	}

	/**
	 * Write the schedule reported by the thermostat into the same schedule
	 * states the cloud fills (day<WeekDayGrpNo>.event<ScheduleType>).
	 *
	 * @param {string} serial serial number
	 * @param {string} devId device id
	 * @param {string} json schedule as decoded by the gateway
	 */
	async _writeSchedule(serial, devId, json) {
		let days;
		try {
			days = JSON.parse(json);
		} catch {
			return;
		}
		if (!Array.isArray(days) || !days.length) {
			return;
		}
		const schedule = {
			Days: days.map(d => ({
				WeekDayGrpNo: d.day,
				Events: (d.events || []).map((e, i) => ({
					ScheduleType: i,
					Clock: e.time,
					Temperature: Math.round(e.temperature * 100),
					Active: e.active,
					EventIsOnNextDay: e.nextDay,
				})),
			})),
		};
		await writeScheduleStates(this.adapter, devId, schedule);
		const known = this.values.get(serial) || {};
		known.schedule = true;
		this.values.set(serial, known);
	}

	/**
	 * Estimate the energy from the heating time and the heating load. The
	 * thermostat reports whether it heats about once a minute; the time since
	 * the previous report is counted with the heating state of that report.
	 * Gaps longer than 5 minutes (disconnects) are not counted.
	 *
	 * @param {string} serial serial number
	 * @param {Record<string, any>} fields reported values
	 * @returns {Record<string, number>} energyToday / energyTotal in kWh, if changed
	 */
	_trackEnergy(serial, fields) {
		if (fields.online === false) {
			this.heatingTrack.delete(serial);
			return {};
		}
		const now = Date.now();
		const d = new Date(now);
		const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
		const e = (this.store.energy[serial] = this.store.energy[serial] || { day, today: 0, total: 0 });
		if (Number(fields.loadWatts) > 0) {
			e.loadWatts = Number(fields.loadWatts); // device info, sent once per connection
		}
		if (typeof fields.heating !== 'boolean') {
			return {};
		}
		const load = Number(e.loadWatts);
		const prev = this.heatingTrack.get(serial);
		this.heatingTrack.set(serial, { at: now, heating: fields.heating });
		if (e.day !== day) {
			e.day = day;
			e.today = 0;
		}
		if (prev && prev.heating && Number.isFinite(load) && load > 0) {
			const dtMs = now - prev.at;
			if (dtMs > 0 && dtMs <= 5 * 60_000) {
				const kWh = (load * dtMs) / 3_600_000 / 1000;
				e.today += kWh;
				e.total += kWh;
			}
		}
		if (now - this.lastStoreSave > 10 * 60_000) {
			this.lastStoreSave = now;
			this._saveStore();
		}
		const round = v => Math.round(v * 1000) / 1000;
		return { energyToday: round(e.today), energyTotal: round(e.total) };
	}

	/**
	 * Mirror locally reported values into the main states of the device, so
	 * they show the real state of the thermostat in every mode.
	 *
	 * @param {string} serial serial number
	 * @param {string} devId device id
	 * @param {Record<string, any>} fields reported values
	 */
	_writeMainStates(serial, devId, fields) {
		if (fields.online === false) {
			// The cloud poll takes over again.
			this.values.delete(serial);
			return;
		}
		const known = { ...(this.values.get(serial) || {}) };
		for (const [key, val] of Object.entries(fields)) {
			const id = MAIN_STATES[key];
			if (!id || val === undefined || val === null) {
				continue;
			}
			if ((key === 'comfortEnd' || key === 'boostEnd') && !val) {
				continue; // "not set" – keep the last end time, like the cloud path
			}
			known[key] = val;
			this.adapter.safeSetState(`${devId}.${id}`, { val, ack: true });
		}
		this.values.set(serial, known);
	}

	async _ensureDeviceObjects(devId) {
		if (this.ensured.has(devId)) {
			return;
		}
		for (const [id, common] of Object.entries(LOCAL_ONLY_STATES)) {
			await this.adapter.safeSetObjectNotExists(`${devId}.${id}`, {
				type: 'state',
				common: { ...common, read: true, write: false },
				native: {},
			});
		}
		this.ensured.add(devId);
	}

	async _ensureRootObjects() {
		const a = this.adapter;
		const states = {
			localListening: { name: 'Local gateway listening', type: 'boolean', role: 'indicator' },
			localUpstreamStatus: { name: 'Local gateway: vendor gateway status', type: 'string', role: 'text' },
			localUpstreamFingerprint: {
				name: 'Local gateway: vendor gateway certificate (SHA-256)',
				type: 'string',
				role: 'text',
			},
			localConnected: { name: 'Local gateway: connected thermostats (serials)', type: 'string', role: 'text' },
			localLastEvent: { name: 'Local gateway: last event', type: 'string', role: 'text' },
		};
		for (const [key, common] of Object.entries(states)) {
			await a.safeSetObjectNotExists(`info.${key}`, {
				type: 'state',
				common: { ...common, read: true, write: false },
				native: {},
			});
		}
		a.safeSetState('info.localListening', { val: false, ack: true });
		a.safeSetState('info.localConnected', { val: '', ack: true });
	}

	/** Objects of the first beta (separate local.* trees) are removed. */
	async _removeOldLocalObjects() {
		const a = this.adapter;
		if (typeof a.safeDelObject !== 'function' || typeof a.safeGetObject !== 'function') {
			return;
		}
		const ids = ['local', ...[...this.devBySerial.values()].map(devId => `${devId}.local`)];
		for (const id of ids) {
			try {
				if (await a.safeGetObject(id)) {
					await a.safeDelObject(id, { recursive: true });
					a.log.info(`Local gateway: removed old objects ${id}.*`);
				}
			} catch {
				// ignore
			}
		}
	}

	// ------------------------------------------------------------------------
	// Persistent store (pin + profiles)
	// ------------------------------------------------------------------------

	_loadStore() {
		try {
			const file = path.join(this.dataDir, STORE_NAME);
			if (fs.existsSync(file)) {
				const data = JSON.parse(fs.readFileSync(file, 'utf8'));
				this.store = {
					pin: String(data.pin || ''),
					lastIp: String(data.lastIp || ''),
					profiles: data.profiles || {},
					energy: data.energy || {},
				};
			}
		} catch (e) {
			this.adapter.log.warn(`Local gateway: cannot read ${STORE_NAME}: ${e?.message || e}`);
		}
	}

	_saveStore() {
		try {
			fs.mkdirSync(this.dataDir, { recursive: true });
			fs.writeFileSync(path.join(this.dataDir, STORE_NAME), JSON.stringify(this.store, null, 2), { mode: 0o600 });
		} catch (e) {
			this.adapter.log.warn(`Local gateway: cannot write ${STORE_NAME}: ${e?.message || e}`);
		}
	}

	_port(v, def) {
		const n = Math.trunc(Number(v));
		return Number.isFinite(n) && n > 0 && n < 65536 ? n : def;
	}
}

module.exports = { LocalManager };
