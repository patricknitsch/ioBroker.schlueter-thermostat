/* eslint-disable jsdoc/require-jsdoc */
'use strict';

// ============================================================================
// Local control (BETA) – glue between the adapter and the local device gateway
//
// Objects:
//   local                          (channel)  gateway status
//     .listening                   bool
//     .upstreamStatus              string     connected / unreachable / untrusted
//     .upstreamFingerprint         string     SHA-256 of the vendor certificate
//     .connected                   string     comma separated serials
//     .lastEvent                   string
//   groups.<G>.thermostats.<T>.local (channel) values reported over the LAN
//     .online, .relayed, .floorTemperature, .heating, .regulationMode,
//     .manualSetpoint, .comfortSetpoint, .targetTemperature, .lastSeen
// ============================================================================

const fs = require('node:fs');
const path = require('node:path');
const utils = require('@iobroker/adapter-core');

const { LocalGateway, profileFromJson, profileToJson } = require('./local/gateway');
const { ensureCertificate } = require('./local/cert');
const P = require('./local/protocol');
const W = require('./local/wd5');

const STORE_NAME = 'local-gateway.json';

const DEVICE_STATES = {
	online: { name: 'Connected to local gateway', type: 'boolean', role: 'indicator.reachable' },
	relayed: { name: 'Relayed to vendor cloud', type: 'boolean', role: 'indicator' },
	roomTemperature: { name: 'Room temperature (local)', type: 'number', role: 'value.temperature', unit: '°C' },
	floorTemperature: { name: 'Floor temperature (local)', type: 'number', role: 'value.temperature', unit: '°C' },
	heating: { name: 'Heating (local)', type: 'boolean', role: 'indicator.working' },
	regulationMode: { name: 'Regulation mode (local)', type: 'number', role: 'value' },
	manualSetpoint: { name: 'Manual setpoint (local)', type: 'number', role: 'value.temperature', unit: '°C' },
	comfortSetpoint: { name: 'Comfort setpoint (local)', type: 'number', role: 'value.temperature', unit: '°C' },
	comfortEnd: { name: 'Comfort end, thermostat-local (local)', type: 'string', role: 'text' },
	boostEnd: { name: 'Boost end, thermostat-local (local)', type: 'string', role: 'text' },
	vacationEnabled: { name: 'Vacation enabled (local)', type: 'boolean', role: 'indicator' },
	vacationSetpoint: { name: 'Vacation setpoint (local)', type: 'number', role: 'value.temperature', unit: '°C' },
	frostProtectionSetpoint: {
		name: 'Frost protection setpoint (local)',
		type: 'number',
		role: 'value.temperature',
		unit: '°C',
	},
	targetTemperature: { name: 'Target temperature (local)', type: 'number', role: 'value.temperature', unit: '°C' },
	room: { name: 'Room name (local)', type: 'string', role: 'text' },
	firmware: { name: 'Firmware (local)', type: 'string', role: 'info.firmware' },
	lastSeen: { name: 'Last message (local)', type: 'number', role: 'date' },
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
		this.store = { pin: '', lastIp: '', profiles: {} };
		/** serial -> devId */
		this.devBySerial = new Map();
		/** serial -> pending fields while the device is not known yet */
		this.pending = new Map();
		this.ensured = new Set();
	}

	get enabled() {
		return this.mode === 'relay' || this.mode === 'local';
	}

	get allowCommands() {
		return this.enabled && this.cfg.localAllowCommands === true;
	}

	// ------------------------------------------------------------------------

	async start() {
		if (!this.enabled) {
			return;
		}
		const a = this.adapter;
		a.log.warn(
			`Local control (BETA) enabled in "${this.mode}" mode. This feature is experimental – please report your observations.`,
		);

		await this._ensureRootObjects();
		await this._loadKnownSerials();

		this.dataDir = utils.getAbsoluteInstanceDataDir(a);
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
			a.safeSetState('local.lastEvent', { val: text.slice(0, 500), ack: true });
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
			a.safeSetState('local.upstreamStatus', { val: status, ack: true });
			a.safeSetState('local.upstreamFingerprint', { val: gw.upstreamFingerprint || '', ack: true });
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
			a.safeSetState('local.listening', { val: true, ack: true });
		} catch (e) {
			a.log.error(`Local gateway: ${e?.message || e}`);
			a.safeSetState('local.listening', { val: false, ack: true });
			this.gateway = null;
		}
	}

	async stop() {
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
			a.safeSetState('local.connected', { val: this.gateway.connected.join(','), ack: true });
		}
		const devId = this.devBySerial.get(serial);
		if (!devId) {
			this.pending.set(serial, { ...(this.pending.get(serial) || {}), ...fields });
			return;
		}
		await this._ensureDeviceObjects(devId);
		const base = `${devId}.local`;
		for (const [key, val] of Object.entries(fields)) {
			if (DEVICE_STATES[key] && val !== undefined && val !== null) {
				a.safeSetState(`${base}.${key}`, { val, ack: true });
			}
		}
		if (fields.online !== false) {
			a.safeSetState(`${base}.lastSeen`, { val: Date.now(), ack: true });
		}
	}

	async _ensureDeviceObjects(devId) {
		if (this.ensured.has(devId)) {
			return;
		}
		const a = this.adapter;
		await a.safeSetObjectNotExists(`${devId}.local`, {
			type: 'channel',
			common: { name: 'Local gateway (beta)' },
			native: {},
		});
		for (const [key, common] of Object.entries(DEVICE_STATES)) {
			await a.safeSetObjectNotExists(`${devId}.local.${key}`, {
				type: 'state',
				common: { ...common, read: true, write: false },
				native: {},
			});
		}
		this.ensured.add(devId);
	}

	async _ensureRootObjects() {
		const a = this.adapter;
		await a.safeSetObjectNotExists('local', {
			type: 'channel',
			common: { name: 'Local gateway (beta)' },
			native: {},
		});
		const states = {
			listening: { name: 'Gateway listening', type: 'boolean', role: 'indicator' },
			upstreamStatus: { name: 'Vendor gateway status', type: 'string', role: 'text' },
			upstreamFingerprint: { name: 'Vendor gateway certificate (SHA-256)', type: 'string', role: 'text' },
			connected: { name: 'Connected thermostats (serials)', type: 'string', role: 'text' },
			lastEvent: { name: 'Last gateway event', type: 'string', role: 'text' },
		};
		for (const [key, common] of Object.entries(states)) {
			await a.safeSetObjectNotExists(`local.${key}`, {
				type: 'state',
				common: { ...common, read: true, write: false },
				native: {},
			});
		}
		a.safeSetState('local.listening', { val: false, ack: true });
		a.safeSetState('local.connected', { val: '', ack: true });
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
