// main.js
'use strict';

// ============================================================================
// schlueter-thermostat
// Cloud-only adapter for OJ Microline / Schlüter OWD5/OCD5
//
// Time handling (FINAL):
// - OUTGOING EndTimes (Comfort/Boost): send UTC time WITHOUT Z and WITHOUT ms:
//     "YYYY-MM-DDTHH:mm:ss"
//   Reason: backend interprets naive timestamps as UTC and applies thermostat TimeZone.
//   This fixes the "need 2h to get 1h" symptom.
// - INCOMING EndTimes:
//   - if cloud returns "…Z" or "+/-HH:MM": convert to thermostat local no-Z (device display)
//   - if cloud returns naive "YYYY-…": treat as thermostat local, strip ms if any
// ============================================================================

const utils = require('@iobroker/adapter-core');
const { OJClient } = require('./lib/oj-client');
const { safeId, numToC, cToNum } = require('./lib/util');

class SchlueterThermostat extends utils.Adapter {
	constructor(options) {
		super({ ...options, name: 'schlueter-thermostat' });

		// Keep original adapter-core methods (avoid wrapper recursion)
		this._origSetObjectNotExistsAsync = this.setObjectNotExistsAsync.bind(this);
		this._origSetObjectAsync = this.setObject.bind(this);
		this._origGetObjectAsync = this.getObjectAsync.bind(this);
		this._origSetState = this.setState.bind(this);

		this.client = null;

		/** ThermostatId -> SerialNumber */
		this.thermostatSerial = {};
		/** ThermostatId -> GroupId */
		this.thermostatGroup = {};
		/** ThermostatId -> ThermostatName */
		this.thermostatNameCache = {};

		/** ThermostatId -> ComfortEndTime (thermostat local no-Z) */
		this.thermostatComfortEnd = {};
		/** ThermostatId -> BoostEndTime (thermostat local no-Z) */
		this.thermostatBoostEnd = {};

		/** ThermostatId -> VacationEnabled */
		this.thermostatVacationEnabled = {};
		/** ThermostatId -> VacationBeginDay */
		this.thermostatVacationBegin = {};
		/** ThermostatId -> VacationEndDay */
		this.thermostatVacationEnd = {};
		/** ThermostatId -> VacationTemperature (numeric units) */
		this.thermostatVacationTemp = {};

		/** ThermostatId -> TimeZone offset seconds (e.g. 3600) */
		this.thermostatTimeZoneSec = {};

		/** GroupId -> GroupName */
		this.groupNameCache = {};

		/** ThermostatId -> last known online */
		this.lastOnline = {};
		/** ThermostatId -> did we already warn for current offline phase? */
		this.warnedOffline = {};
		/** devId -> legacy deleted */
		this.legacyStatesDeleted = {};

		this.pollTimer = null;
		this.unloading = false;
		this.pollInFlight = false;
		this.pollPromise = null;

		this.on('ready', this.onReady.bind(this));
		this.on('stateChange', this.onStateChange.bind(this));
		this.on('unload', this.onUnload.bind(this));
	}

	// ============================================================================
	// Helpers (safe DB calls)
	// ============================================================================

	_isConnClosed(err) {
		return String(err?.message || err).includes('Connection is closed');
	}

	async safeSetObjectNotExists(id, obj) {
		try {
			await this._origSetObjectNotExistsAsync(id, obj);
		} catch (e) {
			if (this.unloading || this._isConnClosed(e)) {
				return;
			}
			throw e;
		}
	}

	async safeSetObject(id, obj) {
		try {
			await this._origSetObjectAsync(id, obj);
		} catch (e) {
			if (this.unloading || this._isConnClosed(e)) {
				return;
			}
			throw e;
		}
	}

	safeSetState(id, val, ack = true) {
		try {
			this._origSetState(id, val, ack);
		} catch (e) {
			if (this.unloading || this._isConnClosed(e)) {
				return;
			}
			throw e;
		}
	}

	async safeGetObject(id) {
		try {
			return await this._origGetObjectAsync(id);
		} catch (e) {
			if (this.unloading || this._isConnClosed(e)) {
				return null;
			}
			throw e;
		}
	}

	async safeDelObject(id, options = {}) {
		try {
			await this.delObjectAsync(id, options);
		} catch (e) {
			if (this.unloading || this._isConnClosed(e)) {
				return;
			}

			const msg = String(e?.message || e);
			if (msg.includes('not exist') || msg.includes('Not exists') || msg.includes('does not exist')) {
				return;
			}
			throw e;
		}
	}

	// ============================================================================
	// Legacy cleanup
	// ============================================================================

	async legacyCleanup() {
		try {
			const legacyRoot = await this.safeGetObject('thermostats');
			if (!legacyRoot) {
				this.log.debug('legacyCleanup(): no legacy root "thermostats" found - nothing to delete.');
				return;
			}

			this.log.warn('legacyCleanup(): deleting legacy object tree "thermostats.*" (recursive).');
			await this.safeDelObject('thermostats', { recursive: true });
			this.log.warn('legacyCleanup(): legacy object tree deleted successfully.');
		} catch (e) {
			this.log.warn(`legacyCleanup(): failed to delete legacy objects: ${e?.message || e}`);
		}
	}

	async deleteOldWritableStates(devId) {
		if (this.legacyStatesDeleted[devId]) {
			return;
		}
		this.legacyStatesDeleted[devId] = true;

		const legacyIds = [
			`${devId}.setpoint.manualSet`,
			`${devId}.setpoint.comfortSet`,
			`${devId}.regulationModeSet`,
			`${devId}.thermostatNameSet`,
			`${devId}.endTime.comfortSet`,
			`${devId}.endTime.boostSet`,
			`${devId}.vacation.enabledSet`,
			`${devId}.vacation.beginSet`,
			`${devId}.vacation.endSet`,
			`${devId}.vacation.temperatureSet`,
		];

		for (const id of legacyIds) {
			try {
				await this.safeDelObject(id);
				this.log.debug(`Deleted legacy state: ${id}`);
			} catch (e) {
				this.log.debug(`Could not delete legacy state ${id}: ${e?.message || e}`);
			}
		}
	}

	// ============================================================================
	// Time helpers
	// ============================================================================

	_getTzSec(thermostatId, t) {
		const cached = this.thermostatTimeZoneSec[thermostatId];
		if (Number.isFinite(cached)) {
			return cached;
		}

		const parsed = Number(t?.TimeZone);
		if (Number.isFinite(parsed)) {
			return parsed;
		}

		return 0;
	}

	_pad2(n) {
		return String(n).padStart(2, '0');
	}

	// OUTGOING: UTC without Z, without ms -> "YYYY-MM-DDTHH:mm:ss"
	_nowPlusMinutesUtcNoZ(minutes) {
		const utcMs = Date.now() + minutes * 60 * 1000;
		// toISOString() -> "...SSSZ" => remove ".SSS" and trailing "Z"
		return new Date(utcMs)
			.toISOString()
			.replace(/\.\d{3}Z$/, '')
			.replace(/Z$/, '');
	}

	// Convert an instant to thermostat-local without Z for display/storage
	_formatThermostatLocalNoZFromUtcMs(utcMs, timeZoneSec) {
		const tz = Number.isFinite(timeZoneSec) ? timeZoneSec : 0;
		const localMs = utcMs + tz * 1000;
		const d = new Date(localMs);

		return `${d.getUTCFullYear()}-${this._pad2(d.getUTCMonth() + 1)}-${this._pad2(d.getUTCDate())}T${this._pad2(
			d.getUTCHours(),
		)}:${this._pad2(d.getUTCMinutes())}:${this._pad2(d.getUTCSeconds())}`;
	}

	_stripMsKeepLocalNoZ(s) {
		if (!s) {
			return '';
		}
		const x = String(s).trim();
		if (!x) {
			return '';
		}

		// strip .SSS if present
		const msStripped = x.replace(/\.\d{1,3}(?=($|[zZ]|[+-]\d{2}:?\d{2}$))/, '');

		// remove zone suffix if any (caller decides when to keep zone)
		return msStripped.replace(/[zZ]$/, '').replace(/[+-]\d{2}:?\d{2}$/, '');
	}

	// Incoming EndTime -> thermostat local no-Z:
	// - has Z/offset => parse instant and convert to thermostat local
	// - naive => treat as thermostat local and normalize (strip ms)
	_toThermostatLocalNoZFromAny(value, timeZoneSec) {
		if (!value) {
			return '';
		}
		const s = String(value).trim();
		if (!s) {
			return '';
		}

		const hasZone = /[zZ]$/.test(s) || /[+-]\d{2}:?\d{2}$/.test(s);

		if (hasZone) {
			const d = new Date(s);
			if (Number.isNaN(d.getTime())) {
				return '';
			}
			return this._formatThermostatLocalNoZFromUtcMs(d.getTime(), timeZoneSec);
		}

		const noZone = this._stripMsKeepLocalNoZ(s);
		const m = noZone.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
		if (!m) {
			return noZone;
		}

		const year = m[1];
		const mon = m[2];
		const day = m[3];
		const hh = m[4];
		const mm = m[5];
		const ss = m[6] ? m[6] : '00';

		return `${year}-${mon}-${day}T${hh}:${mm}:${ss}`;
	}

	async _getSerialFromObject(groupId, thermostatId) {
		const oid = `groups.${safeId(groupId)}.thermostats.${safeId(thermostatId)}`;
		const obj = await this.safeGetObject(oid);
		return obj?.native?.serialNumber ? String(obj.native.serialNumber) : '';
	}

	async _isThermostatOnline(groupId, thermostatId) {
		if (typeof this.lastOnline[thermostatId] === 'boolean') {
			return this.lastOnline[thermostatId];
		}

		const devId = `groups.${safeId(groupId)}.thermostats.${safeId(thermostatId)}`;
		try {
			const st = await this.getStateAsync(`${devId}.online`);
			if (st && typeof st.val === 'boolean') {
				return st.val;
			}
		} catch {
			// ignore
		}
		return false;
	}

	// ============================================================================
	// ON READY
	// ============================================================================

	async onReady() {
		this.log.debug('onReady(): starting adapter');
		this.safeSetState('info.connection', false, true);

		if (!this.config.username || !this.config.password || !this.config.apiKey || !this.config.customerId) {
			this.log.error('Missing config (username/password/apiKey/customerId).');
			return;
		}

		this.client = new OJClient({
			log: this.log,
			baseUrlOwd5: this.config.baseUrlOwd5,
			baseUrlOcd5: this.config.baseUrlOcd5,
			username: this.config.username,
			password: this.config.password,
			apiKey: this.config.apiKey,
			customerId: Number(this.config.customerId),
		});

		try {
			this.log.debug('Login: calling OWD5 SignIn');
			await this.client.login();
			this.log.debug('Login successful');
			this.safeSetState('info.connection', true, true);
		} catch (e) {
			this.log.error(`Login failed: ${e?.message || e}`);
			return;
		}

		await this.safeSetObjectNotExists('groups', { type: 'channel', common: { name: 'Groups' }, native: {} });

		if (this.config.legacyCleanup === true) {
			await this.legacyCleanup();
		} else {
			this.log.debug('legacyCleanup(): disabled by config');
		}

		const intervalSec = Math.max(10, Number(this.config.pollIntervalSec) || 60);

		await this.pollOnce();

		// Subscribe ONLY apply buttons
		this.subscribeStates('groups.*.thermostats.*.apply.*.apply');

		this.pollTimer = setInterval(() => {
			this.pollOnce().catch(err => this.log.warn(`Poll error: ${err?.message || err}`));
		}, intervalSec * 1000);
	}

	// ============================================================================
	// POLL
	// ============================================================================

	async pollOnce() {
		this.log.debug('pollOnce(): polling GroupContents from cloud');
		if (this.unloading || this.pollInFlight) {
			return;
		}

		const client = this.client;
		if (!client) {
			return;
		}

		this.pollInFlight = true;

		this.pollPromise = (async () => {
			this.log.debug('Reading groups: OWD5 GroupContents');
			const data = await client.getGroupContents();
			const groups = Array.isArray(data?.GroupContents) ? data.GroupContents : [];
			this.log.debug(`Reading groups done: count=${groups.length}`);
			this.safeSetState('info.connection', true, true);

			for (const group of groups) {
				if (this.unloading) {
					break;
				}

				await this.upsertGroup(group);

				const thermostats = Array.isArray(group?.Thermostats) ? group.Thermostats : [];
				for (const t of thermostats) {
					if (this.unloading) {
						break;
					}
					await this.upsertThermostat(group, t);
				}
			}
		})()
			.catch(err => {
				if (!this.unloading) {
					this.safeSetState('info.connection', false, true);
					this.log.warn(`Poll error: ${err?.message || err}`);
				}
			})
			.finally(() => {
				this.pollInFlight = false;
			});

		return this.pollPromise;
	}

	// ============================================================================
	// UPSERT: GROUP
	// ============================================================================

	async upsertGroup(group) {
		const groupId = String(group?.GroupId ?? '');
		if (!groupId) {
			return;
		}

		const groupName = String(group?.GroupName || `Group ${groupId}`);
		this.groupNameCache[groupId] = groupName;

		const groupDev = `groups.${safeId(groupId)}`;
		this.log.debug(`upsertGroup(): GroupId=${groupId} GroupName=${groupName}`);

		await this.safeSetObjectNotExists(groupDev, {
			type: 'device',
			common: { name: groupName },
			native: { groupId },
		});

		await this.safeSetObjectNotExists(`${groupDev}.thermostats`, {
			type: 'channel',
			common: { name: 'Thermostats' },
			native: {},
		});

		const cur = await this.safeGetObject(groupDev);
		if (cur && cur.common?.name !== groupName) {
			await this.safeSetObject(groupDev, {
				...cur,
				common: { ...(cur.common || {}), name: groupName },
			});
		}
	}

	// ============================================================================
	// UPSERT: THERMOSTAT
	// ============================================================================

	async upsertThermostat(group, t) {
		const groupId = String(group?.GroupId ?? '');
		const thermostatId = String(t?.Id ?? '');
		if (!groupId || !thermostatId) {
			return;
		}

		const groupDev = `groups.${safeId(groupId)}`;
		const devId = `${groupDev}.thermostats.${safeId(thermostatId)}`;

		const serial = t?.SerialNumber ? String(t.SerialNumber) : '';
		if (serial) {
			this.thermostatSerial[thermostatId] = serial;
		}
		this.thermostatGroup[thermostatId] = groupId;

		const thermostatName = String(t?.ThermostatName || `Thermostat ${thermostatId}`);
		this.thermostatNameCache[thermostatId] = thermostatName;

		// cache timezone
		const parsedTz = Number(t?.TimeZone);
		if (Number.isFinite(parsedTz)) {
			this.thermostatTimeZoneSec[thermostatId] = parsedTz;
		}
		const tzSec = this._getTzSec(thermostatId, t);

		// cache vacation
		if (typeof t?.VacationEnabled === 'boolean') {
			this.thermostatVacationEnabled[thermostatId] = Boolean(t.VacationEnabled);
		}
		if (t?.VacationBeginDay) {
			this.thermostatVacationBegin[thermostatId] = String(t.VacationBeginDay);
		}
		if (t?.VacationEndDay) {
			this.thermostatVacationEnd[thermostatId] = String(t.VacationEndDay);
		}
		if (t?.VacationTemperature !== undefined && t?.VacationTemperature !== null) {
			this.thermostatVacationTemp[thermostatId] = Number(t.VacationTemperature);
		}

		this.log.debug(
			`upsertThermostat(): GroupId=${groupId} ThermostatId=${thermostatId} Serial=${serial} Name=${thermostatName} TZsec=${tzSec}`,
		);

		await this.safeSetObjectNotExists(devId, {
			type: 'device',
			common: { name: thermostatName },
			native: { groupId, thermostatId, serialNumber: serial },
		});

		const cur = await this.safeGetObject(devId);
		if (cur && cur.common?.name !== thermostatName) {
			await this.safeSetObject(devId, {
				...cur,
				common: { ...(cur.common || {}), name: thermostatName },
			});
		}

		await this.deleteOldWritableStates(devId);

		const ensureState = async (id, common) => {
			await this.safeSetObjectNotExists(id, { type: 'state', common, native: {} });
		};

		// Common states
		await ensureState(`${devId}.online`, {
			name: 'Online',
			type: 'boolean',
			role: 'indicator.reachable',
			read: true,
			write: false,
		});
		await ensureState(`${devId}.heating`, {
			name: 'Heating',
			type: 'boolean',
			role: 'indicator.working',
			read: true,
			write: false,
		});
		await ensureState(`${devId}.thermostatName`, {
			name: 'Thermostat name',
			type: 'string',
			role: 'text',
			read: true,
			write: false,
		});
		await ensureState(`${devId}.temperature.room`, {
			name: 'Room temperature',
			type: 'number',
			role: 'value.temperature',
			unit: '°C',
			read: true,
			write: false,
		});
		await ensureState(`${devId}.temperature.floor`, {
			name: 'Floor temperature',
			type: 'number',
			role: 'value.temperature',
			unit: '°C',
			read: true,
			write: false,
		});

		await ensureState(`${devId}.setpoint.manual`, {
			name: 'Manual setpoint',
			type: 'number',
			role: 'value.temperature',
			unit: '°C',
			read: true,
			write: false,
		});
		await ensureState(`${devId}.setpoint.comfort`, {
			name: 'Comfort setpoint',
			type: 'number',
			role: 'value.temperature',
			unit: '°C',
			read: true,
			write: false,
		});
		await ensureState(`${devId}.regulationMode`, {
			name: 'Regulation mode',
			type: 'number',
			role: 'value',
			read: true,
			write: false,
		});

		// EndTime
		await this.safeSetObjectNotExists(`${devId}.endTime`, {
			type: 'channel',
			common: { name: 'End times' },
			native: {},
		});
		await ensureState(`${devId}.endTime.comfort`, {
			name: 'Comfort end time',
			type: 'string',
			role: 'date',
			read: true,
			write: false,
		});
		await ensureState(`${devId}.endTime.boost`, {
			name: 'Boost end time',
			type: 'string',
			role: 'date',
			read: true,
			write: false,
		});

		// Vacation
		await this.safeSetObjectNotExists(`${devId}.vacation`, {
			type: 'channel',
			common: { name: 'Vacation' },
			native: {},
		});
		await ensureState(`${devId}.vacation.enabled`, {
			name: 'Vacation enabled',
			type: 'boolean',
			role: 'switch',
			read: true,
			write: false,
		});
		await ensureState(`${devId}.vacation.begin`, {
			name: 'Vacation begin day',
			type: 'string',
			role: 'date',
			read: true,
			write: false,
		});
		await ensureState(`${devId}.vacation.end`, {
			name: 'Vacation end day',
			type: 'string',
			role: 'date',
			read: true,
			write: false,
		});
		await ensureState(`${devId}.vacation.temperature`, {
			name: 'Vacation temperature',
			type: 'number',
			role: 'value.temperature',
			unit: '°C',
			read: true,
			write: false,
		});

		// Schedule & Energy channels
		await this.safeSetObjectNotExists(`${devId}.schedule`, {
			type: 'channel',
			common: { name: 'Schedule' },
			native: {},
		});
		await this.safeSetObjectNotExists(`${devId}.energy`, {
			type: 'channel',
			common: { name: 'Energy' },
			native: {},
		});

		// APPLY controls
		await this.ensureApplyStates(devId);

		// ------------------------------------------------------------------------
		// Write values
		// ------------------------------------------------------------------------

		const onlineNow = Boolean(t?.Online);
		this.safeSetState(`${devId}.online`, { val: onlineNow, ack: true });

		const prevOnline = this.lastOnline[thermostatId];
		if (prevOnline === true && onlineNow === false && !this.warnedOffline[thermostatId]) {
			const tName = this.thermostatNameCache[thermostatId] || `Thermostat ${thermostatId}`;
			const gName = this.groupNameCache[groupId] || `Group ${groupId}`;
			this.log.warn(`Thermostat OFFLINE: ${gName} / ${tName} (ThermostatId=${thermostatId})`);
			this.warnedOffline[thermostatId] = true;
		}
		if (onlineNow === true) {
			this.warnedOffline[thermostatId] = false;
		}
		this.lastOnline[thermostatId] = onlineNow;

		this.safeSetState(`${devId}.heating`, { val: Boolean(t?.Heating), ack: true });
		this.safeSetState(`${devId}.thermostatName`, { val: String(t?.ThermostatName || ''), ack: true });

		const rt = numToC(t?.RoomTemperature);
		const ft = numToC(t?.FloorTemperature);
		if (rt !== null) {
			this.safeSetState(`${devId}.temperature.room`, { val: rt, ack: true });
		}
		if (ft !== null) {
			this.safeSetState(`${devId}.temperature.floor`, { val: ft, ack: true });
		}

		const ms = numToC(t?.ManualModeSetpoint);
		const cs = numToC(t?.ComfortSetpoint);
		if (ms !== null) {
			this.safeSetState(`${devId}.setpoint.manual`, { val: ms, ack: true });
		}
		if (cs !== null) {
			this.safeSetState(`${devId}.setpoint.comfort`, { val: cs, ack: true });
		}

		this.safeSetState(`${devId}.regulationMode`, { val: Number(t?.RegulationMode ?? 0), ack: true });

		// EndTimes: store as THERMOSTAT LOCAL no-Z (device-display style)
		const comfortEndLocal = this._toThermostatLocalNoZFromAny(t?.ComfortEndTime || '', tzSec);
		const boostEndLocal = this._toThermostatLocalNoZFromAny(t?.BoostEndTime || '', tzSec);

		if (comfortEndLocal) {
			this.thermostatComfortEnd[thermostatId] = comfortEndLocal;
			this.safeSetState(`${devId}.endTime.comfort`, { val: comfortEndLocal, ack: true });
		}
		if (boostEndLocal) {
			this.thermostatBoostEnd[thermostatId] = boostEndLocal;
			this.safeSetState(`${devId}.endTime.boost`, { val: boostEndLocal, ack: true });
		}

		const vEnabled = Boolean(t?.VacationEnabled);
		const vBegin = String(t?.VacationBeginDay || '');
		const vEnd = String(t?.VacationEndDay || '');
		this.safeSetState(`${devId}.vacation.enabled`, vEnabled, true);
		if (vBegin) {
			this.safeSetState(`${devId}.vacation.begin`, vBegin, true);
		}
		if (vEnd) {
			this.safeSetState(`${devId}.vacation.end`, vEnd, true);
		}

		const vTempC = numToC(t?.VacationTemperature);
		if (vTempC !== null) {
			this.safeSetState(`${devId}.vacation.temperature`, vTempC, true);
		}

		// Schedule as individual states
		const schedule = t?.Schedule;
		if (schedule && Array.isArray(schedule.Days)) {
			for (const day of schedule.Days) {
				const wd = String(day.WeekDayGrpNo ?? '');
				if (!wd) {
					continue;
				}

				const dayCh = `${devId}.schedule.day${wd}`;
				await this.safeSetObjectNotExists(dayCh, {
					type: 'channel',
					common: { name: `Day ${wd}` },
					native: {},
				});

				const events = Array.isArray(day.Events) ? day.Events : [];
				for (let i = 0; i < events.length; i++) {
					const ev = events[i];
					const evCh = `${dayCh}.event${i}`;
					await this.safeSetObjectNotExists(evCh, {
						type: 'channel',
						common: { name: `Event ${i}` },
						native: {},
					});

					await ensureState(`${evCh}.type`, {
						name: 'ScheduleType',
						type: 'number',
						role: 'value',
						read: true,
						write: false,
					});
					await ensureState(`${evCh}.time`, {
						name: 'Clock',
						type: 'string',
						role: 'text',
						read: true,
						write: false,
					});
					await ensureState(`${evCh}.temperature`, {
						name: 'Temperature',
						type: 'number',
						role: 'value.temperature',
						unit: '°C',
						read: true,
						write: false,
					});
					await ensureState(`${evCh}.active`, {
						name: 'Active',
						type: 'boolean',
						role: 'indicator',
						read: true,
						write: false,
					});
					await ensureState(`${evCh}.nextDay`, {
						name: 'EventIsOnNextDay',
						type: 'boolean',
						role: 'indicator',
						read: true,
						write: false,
					});

					this.safeSetState(`${evCh}.type`, { val: Number(ev.ScheduleType ?? 0), ack: true });
					this.safeSetState(`${evCh}.time`, { val: String(ev.Clock ?? ''), ack: true });
					const temp = numToC(ev.Temperature);
					if (temp !== null) {
						this.safeSetState(`${evCh}.temperature`, { val: temp, ack: true });
					}
					this.safeSetState(`${evCh}.active`, { val: Boolean(ev.Active), ack: true });
					this.safeSetState(`${evCh}.nextDay`, { val: Boolean(ev.EventIsOnNextDay), ack: true });
				}
			}
		}

		// Energy
		if (this.client && serial) {
			try {
				this.log.debug(`Energy: requesting usage for SerialNumber=${serial}`);
				const energy = await this.client.getEnergyUsage(serial, {
					history: Number(this.config.energyHistory) || 0,
					viewType: Number(this.config.energyViewType) || 2,
				});

				const usage = energy?.EnergyUsage?.[0]?.Usage || [];

				await ensureState(`${devId}.energy.count`, {
					name: 'Values count',
					type: 'number',
					role: 'value',
					read: true,
					write: false,
				});
				this.safeSetState(`${devId}.energy.count`, { val: usage.length, ack: true });

				for (let i = 0; i < usage.length; i++) {
					const sid = `${devId}.energy.value${i}`;
					await ensureState(sid, {
						name: `Energy value ${i}`,
						type: 'number',
						role: 'value.energy',
						unit: 'kWh',
						read: true,
						write: false,
					});

					const v = Number(usage[i]?.EnergyKWattHour);
					if (Number.isFinite(v)) {
						this.safeSetState(sid, { val: v, ack: true });
					}
				}
			} catch (e) {
				this.log.debug(`Energy not available for ThermostatId=${thermostatId}: ${e?.message || e}`);
			}
		}
	}

	async ensureApplyStates(devId) {
		const ensureState = async (id, common) => {
			await this.safeSetObjectNotExists(id, { type: 'state', common, native: {} });
		};

		await this.safeSetObjectNotExists(`${devId}.apply`, { type: 'channel', common: { name: 'Apply' }, native: {} });

		// schedule (mode 1)
		await this.safeSetObjectNotExists(`${devId}.apply.schedule`, {
			type: 'channel',
			common: { name: 'Schedule mode' },
			native: {},
		});
		await ensureState(`${devId}.apply.schedule.apply`, {
			name: 'Apply schedule mode (RegulationMode=1)',
			type: 'boolean',
			role: 'button',
			read: true,
			write: true,
			def: false,
		});

		// comfort (mode 2: setpoint + endTime)
		await this.safeSetObjectNotExists(`${devId}.apply.comfort`, {
			type: 'channel',
			common: { name: 'Comfort mode' },
			native: {},
		});
		await ensureState(`${devId}.apply.comfort.setpoint`, {
			name: 'Comfort setpoint',
			type: 'number',
			role: 'level.temperature',
			unit: '°C',
			read: true,
			write: true,
			min: 12,
			max: 35,
		});
		await ensureState(`${devId}.apply.comfort.durationMinutes`, {
			name: 'Comfort duration (minutes)',
			type: 'number',
			role: 'value',
			read: true,
			write: true,
			min: 1,
			max: 24 * 60,
			def: 180,
		});
		await ensureState(`${devId}.apply.comfort.apply`, {
			name: 'Apply comfort mode',
			type: 'boolean',
			role: 'button',
			read: true,
			write: true,
			def: false,
		});

		// manual (mode 3: setpoint)
		await this.safeSetObjectNotExists(`${devId}.apply.manual`, {
			type: 'channel',
			common: { name: 'Manual mode' },
			native: {},
		});
		await ensureState(`${devId}.apply.manual.setpoint`, {
			name: 'Manual setpoint',
			type: 'number',
			role: 'level.temperature',
			unit: '°C',
			read: true,
			write: true,
			min: 12,
			max: 35,
		});
		await ensureState(`${devId}.apply.manual.apply`, {
			name: 'Apply manual mode',
			type: 'boolean',
			role: 'button',
			read: true,
			write: true,
			def: false,
		});

		// boost (mode 8: endTime + duration)
		await this.safeSetObjectNotExists(`${devId}.apply.boost`, {
			type: 'channel',
			common: { name: 'Boost mode' },
			native: {},
		});
		await ensureState(`${devId}.apply.boost.durationMinutes`, {
			name: 'Boost duration (minutes)',
			type: 'number',
			role: 'value',
			read: true,
			write: true,
			min: 1,
			max: 24 * 60,
			def: 60,
		});
		await ensureState(`${devId}.apply.boost.apply`, {
			name: 'Apply boost mode',
			type: 'boolean',
			role: 'button',
			read: true,
			write: true,
			def: false,
		});

		// eco (mode 9)
		await this.safeSetObjectNotExists(`${devId}.apply.eco`, {
			type: 'channel',
			common: { name: 'Eco mode' },
			native: {},
		});
		await ensureState(`${devId}.apply.eco.apply`, {
			name: 'Apply eco mode (RegulationMode=9)',
			type: 'boolean',
			role: 'button',
			read: true,
			write: true,
			def: false,
		});
	}

	// ============================================================================
	// ON STATE CHANGE (apply-only writes)
	// ============================================================================

	async onStateChange(id, state) {
		this.log.debug(`onStateChange(): id=${id} val=${state?.val}`);
		if (!state || state.ack) {
			return;
		}

		const client = this.client;
		if (!client) {
			return;
		}

		const parts = id.split('.');
		const idxG = parts.indexOf('groups');
		const idxT = parts.indexOf('thermostats');
		const idxApply = parts.indexOf('apply');
		if (idxG === -1 || idxT === -1 || idxApply === -1) {
			return;
		}

		const groupId = parts[idxG + 1];
		const thermostatId = parts[idxT + 1];

		const isApplyButton = id.endsWith('.apply');
		if (!isApplyButton) {
			return;
		}

		const online = await this._isThermostatOnline(groupId, thermostatId);
		if (!online) {
			this.log.warn(`Write blocked: thermostat offline (ThermostatId=${thermostatId}) id=${id}`);
			this.safeSetState(id, { val: false, ack: true });
			return;
		}

		let serial = this.thermostatSerial[thermostatId];
		if (!serial) {
			serial = await this._getSerialFromObject(groupId, thermostatId);
			if (serial) {
				this.thermostatSerial[thermostatId] = serial;
			}
		}
		if (!serial) {
			this.log.warn(`Apply ignored: SerialNumber unknown for thermostat ${thermostatId} (not discovered yet).`);
			this.safeSetState(id, { val: false, ack: true });
			return;
		}

		const devPrefix = `groups.${safeId(groupId)}.thermostats.${safeId(thermostatId)}`;
		const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

		const readNum = async (sid, def) => {
			const st = await this.getStateAsync(sid);
			const n = Number(st?.val);
			return Number.isFinite(n) ? n : def;
		};

		const baseName = this.thermostatNameCache[thermostatId] || `Thermostat ${thermostatId}`;

		try {
			const modeFolder = parts[idxApply + 1]; // schedule / comfort / manual / boost / eco

			if (modeFolder === 'schedule') {
				await client.updateThermostat(serial, { ThermostatName: baseName, RegulationMode: 1 });
			} else if (modeFolder === 'comfort') {
				let tempC = await readNum(`${devPrefix}.apply.comfort.setpoint`, 22);
				tempC = clamp(tempC, 12, 35);

				let dur = await readNum(`${devPrefix}.apply.comfort.durationMinutes`, 180);
				dur = clamp(Math.trunc(dur), 1, 24 * 60);

				// OUTGOING: UTC no-Z to match backend behavior
				const comfortEnd = this._nowPlusMinutesUtcNoZ(dur);

				await client.updateThermostat(serial, {
					ThermostatName: baseName,
					RegulationMode: 2,
					ComfortSetpoint: cToNum(tempC),
					ComfortEndTime: comfortEnd,
				});

				// mirror the value we sent (note: displayed as local elsewhere)
				this.safeSetState(`${devPrefix}.endTime.comfort`, { val: comfortEnd, ack: true });
			} else if (modeFolder === 'manual') {
				let tempC = await readNum(`${devPrefix}.apply.manual.setpoint`, 21);
				tempC = clamp(tempC, 12, 35);

				await client.updateThermostat(serial, {
					ThermostatName: baseName,
					RegulationMode: 3,
					ManualModeSetpoint: cToNum(tempC),
				});
			} else if (modeFolder === 'boost') {
				let dur = await readNum(`${devPrefix}.apply.boost.durationMinutes`, 60);
				dur = clamp(Math.trunc(dur), 1, 24 * 60);

				// OUTGOING: UTC no-Z to match backend behavior
				const boostEnd = this._nowPlusMinutesUtcNoZ(dur);

				await client.updateThermostat(serial, {
					ThermostatName: baseName,
					RegulationMode: 8,
					BoostEndTime: boostEnd,
				});

				this.safeSetState(`${devPrefix}.endTime.boost`, { val: boostEnd, ack: true });
			} else if (modeFolder === 'eco') {
				await client.updateThermostat(serial, { ThermostatName: baseName, RegulationMode: 9 });
			} else {
				this.log.debug(`Apply ignored: unknown mode folder "${modeFolder}" (${id})`);
			}

			this.safeSetState(id, { val: false, ack: true });
		} catch (e) {
			this.log.error(`Apply failed for ${id}: ${e?.message || e}`);
			this.safeSetState(id, { val: false, ack: true });
		}
	}

	// ============================================================================
	// ON UNLOAD
	// ============================================================================

	async onUnload(callback) {
		try {
			this.log.debug('onUnload(): stopping adapter');
			this.unloading = true;

			if (this.pollTimer) {
				clearInterval(this.pollTimer);
			}

			const p = this.pollPromise;
			if (p) {
				let timeoutId = null;
				const timeoutPromise = new Promise(resolve => {
					timeoutId = setTimeout(resolve, 5000);
				});
				await Promise.race([p, timeoutPromise]);
				if (timeoutId) {
					clearTimeout(timeoutId);
				}
			}

			callback();
		} catch (e) {
			this.log.error(`onUnload error: ${e?.message || e}`);
			callback();
		}
	}
}

// ============================================================================
// START
// ============================================================================

if (require.main !== module) {
	module.exports = options => new SchlueterThermostat(options);
} else {
	(() => new SchlueterThermostat())();
}
