'use strict';

// ============================================================================
// schlueter-thermostat
// Cloud-only adapter for OJ Microline / Schlüter OWD5/OCD5
//
// Object structure (NEW):
// groups.<GroupId>              (device, name = GroupName)
//   .thermostats                (channel)
//     .<ThermostatId>           (device, name = ThermostatName)
//        .temperature.*
//        .setpoint.*
//        .regulationMode*
//        .endTime.*
//        .vacation.*
//        .schedule.*
//        .energy.*
//
// Reads:
// - OWD5: GroupContents (groups + thermostats + schedules)
// - OWD5: EnergyUsage  (per thermostat serial number)
//
// Writes:
// - OCD5: UpdateThermostat (per thermostat serial number)
// ============================================================================

const utils = require('@iobroker/adapter-core');
const { OJClient } = require('./lib/oj-client');
const { safeId, numToC, cToNum } = require('./lib/util');

class SchlueterThermostat extends utils.Adapter {
	constructor(options) {
		super({ ...options, name: 'schlueter-thermostat' });

		// Keep original adapter-core methods (avoid wrapper recursion)
		this._origSetObjectNotExistsAsync = this.setObjectNotExistsAsync.bind(this);
		this._origSetObjectAsync = this.setObjectAsync.bind(this);
		this._origGetObjectAsync = this.getObjectAsync.bind(this);
		this._origSetState = this.setState.bind(this);

		this.client = null;

		// ------------------------------------------------------------------------
		// Caches / mappings (NEW: keyed by ThermostatId)
		// ------------------------------------------------------------------------

		/** ThermostatId -> SerialNumber */
		this.thermostatSerial = {};
		/** ThermostatId -> GroupId */
		this.thermostatGroup = {};
		/** ThermostatId -> ThermostatName */
		this.thermostatNameCache = {};

		/** ThermostatId -> ComfortEndTime ISO */
		this.thermostatComfortEnd = {};
		/** ThermostatId -> BoostEndTime ISO */
		this.thermostatBoostEnd = {};

		/** ThermostatId -> VacationEnabled */
		this.thermostatVacationEnabled = {};
		/** ThermostatId -> VacationBeginDay */
		this.thermostatVacationBegin = {};
		/** ThermostatId -> VacationEndDay */
		this.thermostatVacationEnd = {};
		/** ThermostatId -> VacationTemperature (numeric units) */
		this.thermostatVacationTemp = {};

		/** GroupId -> GroupName */
		this.groupNameCache = {};

		// ------------------------------------------------------------------------

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

	// ============================================================================
	// Legacy cleanup helpers
	// ============================================================================

	async safeDelObject(id, options = {}) {
		try {
			// delObjectAsync is provided by adapter-core
			await this.delObjectAsync(id, options);
		} catch (e) {
			if (this.unloading || this._isConnClosed(e)) {
				return;
			}
			// Ignore "not exists" style errors safely
			const msg = String(e?.message || e);
			if (msg.includes('not exist') || msg.includes('Not exists') || msg.includes('does not exist')) {
				return;
			}
			throw e;
		}
	}

	async legacyCleanup() {
		// Remove legacy object tree from older adapter versions.
		// Old root: schlueter-thermostat.0.thermostats.*
		// New root: schlueter-thermostat.0.groups.*
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
		// Cleanup legacy object tree from old versions
		await this.legacyCleanup();

		const intervalSec = Math.max(15, Number(this.config.pollIntervalSec) || 60);
		await this.pollOnce();

		// ------------------------------------------------------------------------
		// Subscribe writable states
		// ------------------------------------------------------------------------
		this.subscribeStates('groups.*.thermostats.*.setpoint.manualSet');
		this.subscribeStates('groups.*.thermostats.*.setpoint.comfortSet');
		this.subscribeStates('groups.*.thermostats.*.regulationModeSet');
		this.subscribeStates('groups.*.thermostats.*.thermostatNameSet');

		this.subscribeStates('groups.*.thermostats.*.endTime.comfortSet');
		this.subscribeStates('groups.*.thermostats.*.endTime.boostSet');

		this.subscribeStates('groups.*.thermostats.*.vacation.enabledSet');
		this.subscribeStates('groups.*.thermostats.*.vacation.beginSet');
		this.subscribeStates('groups.*.thermostats.*.vacation.endSet');
		this.subscribeStates('groups.*.thermostats.*.vacation.temperatureSet');

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

		// Ensure thermostats channel
		await this.safeSetObjectNotExists(`${groupDev}.thermostats`, {
			type: 'channel',
			common: { name: 'Thermostats' },
			native: {},
		});

		// Update device name if it changed
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

		// Cache mappings
		const serial = t?.SerialNumber ? String(t.SerialNumber) : '';
		if (serial) {
			this.thermostatSerial[thermostatId] = serial;
		}
		this.thermostatGroup[thermostatId] = groupId;

		const thermostatName = String(t?.ThermostatName || `Thermostat ${thermostatId}`);
		this.thermostatNameCache[thermostatId] = thermostatName;

		if (t?.ComfortEndTime) {
			this.thermostatComfortEnd[thermostatId] = String(t.ComfortEndTime);
		}
		if (t?.BoostEndTime) {
			this.thermostatBoostEnd[thermostatId] = String(t.BoostEndTime);
		}

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
			`upsertThermostat(): GroupId=${groupId} ThermostatId=${thermostatId} Serial=${serial} Name=${thermostatName}`,
		);

		await this.safeSetObjectNotExists(devId, {
			type: 'device',
			common: { name: thermostatName },
			native: { groupId, thermostatId, serialNumber: serial },
		});

		// Update device name if it changed
		const cur = await this.safeGetObject(devId);
		if (cur && cur.common?.name !== thermostatName) {
			await this.safeSetObject(devId, {
				...cur,
				common: { ...(cur.common || {}), name: thermostatName },
			});
		}

		const ensureState = async (id, common) => {
			await this.safeSetObjectNotExists(id, { type: 'state', common, native: {} });
		};

		// ------------------------------------------------------------------------
		// Common states
		// ------------------------------------------------------------------------

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
		await ensureState(`${devId}.thermostatNameSet`, {
			name: 'Set thermostat name',
			type: 'string',
			role: 'text',
			read: true,
			write: true,
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

		// Writable
		await ensureState(`${devId}.setpoint.manualSet`, {
			name: 'Set manual setpoint',
			type: 'number',
			role: 'level.temperature',
			unit: '°C',
			read: true,
			write: true,
		});
		await ensureState(`${devId}.setpoint.comfortSet`, {
			name: 'Set comfort setpoint',
			type: 'number',
			role: 'level.temperature',
			unit: '°C',
			read: true,
			write: true,
		});
		await ensureState(`${devId}.regulationModeSet`, {
			name: 'Set regulation mode',
			type: 'number',
			role: 'level',
			read: true,
			max: 9,
			write: true,
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
		await ensureState(`${devId}.endTime.comfortSet`, {
			name: 'Set comfort end time (ISO or minutes)',
			type: 'string',
			role: 'date',
			read: true,
			write: true,
		});
		await ensureState(`${devId}.endTime.boost`, {
			name: 'Boost end time',
			type: 'string',
			role: 'date',
			read: true,
			write: false,
		});
		await ensureState(`${devId}.endTime.boostSet`, {
			name: 'Set boost end time (ISO or minutes)',
			type: 'string',
			role: 'date',
			read: true,
			write: true,
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
		await ensureState(`${devId}.vacation.enabledSet`, {
			name: 'Set vacation enabled',
			type: 'boolean',
			role: 'switch',
			read: true,
			write: true,
		});
		await ensureState(`${devId}.vacation.begin`, {
			name: 'Vacation begin day',
			type: 'string',
			role: 'date',
			read: true,
			write: false,
		});
		await ensureState(`${devId}.vacation.beginSet`, {
			name: 'Set vacation begin day (ISO)',
			type: 'string',
			role: 'date',
			read: true,
			write: true,
		});
		await ensureState(`${devId}.vacation.end`, {
			name: 'Vacation end day',
			type: 'string',
			role: 'date',
			read: true,
			write: false,
		});
		await ensureState(`${devId}.vacation.endSet`, {
			name: 'Set vacation end day (ISO)',
			type: 'string',
			role: 'date',
			read: true,
			write: true,
		});
		await ensureState(`${devId}.vacation.temperature`, {
			name: 'Vacation temperature',
			type: 'number',
			role: 'value.temperature',
			unit: '°C',
			read: true,
			write: false,
		});
		await ensureState(`${devId}.vacation.temperatureSet`, {
			name: 'Set vacation temperature',
			type: 'number',
			role: 'level.temperature',
			unit: '°C',
			read: true,
			write: true,
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

		// ------------------------------------------------------------------------
		// Write values (read-only + mirror to writable states)
		// ------------------------------------------------------------------------

		this.safeSetState(`${devId}.online`, { val: Boolean(t?.Online), ack: true });
		this.safeSetState(`${devId}.heating`, { val: Boolean(t?.Heating), ack: true });

		this.safeSetState(`${devId}.thermostatName`, { val: String(t?.ThermostatName || ''), ack: true });
		this.safeSetState(`${devId}.thermostatNameSet`, { val: String(t?.ThermostatName || ''), ack: true });

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
			this.safeSetState(`${devId}.setpoint.manualSet`, { val: ms, ack: true });
		}
		if (cs !== null) {
			this.safeSetState(`${devId}.setpoint.comfort`, { val: cs, ack: true });
			this.safeSetState(`${devId}.setpoint.comfortSet`, { val: cs, ack: true });
		}

		const mode = Number(t?.RegulationMode ?? 0);
		this.safeSetState(`${devId}.regulationMode`, { val: mode, ack: true });
		this.safeSetState(`${devId}.regulationModeSet`, { val: mode, ack: true });

		const comfortEnd = String(t?.ComfortEndTime || '');
		const boostEnd = String(t?.BoostEndTime || '');
		if (comfortEnd) {
			this.safeSetState(`${devId}.endTime.comfort`, comfortEnd, true);
			this.safeSetState(`${devId}.endTime.comfortSet`, comfortEnd, true);
		}
		if (boostEnd) {
			this.safeSetState(`${devId}.endTime.boost`, boostEnd, true);
			this.safeSetState(`${devId}.endTime.boostSet`, boostEnd, true);
		}

		const vEnabled = Boolean(t?.VacationEnabled);
		const vBegin = String(t?.VacationBeginDay || '');
		const vEnd = String(t?.VacationEndDay || '');
		this.safeSetState(`${devId}.vacation.enabled`, vEnabled, true);
		this.safeSetState(`${devId}.vacation.enabledSet`, vEnabled, true);
		if (vBegin) {
			this.safeSetState(`${devId}.vacation.begin`, vBegin, true);
			this.safeSetState(`${devId}.vacation.beginSet`, vBegin, true);
		}
		if (vEnd) {
			this.safeSetState(`${devId}.vacation.end`, vEnd, true);
			this.safeSetState(`${devId}.vacation.endSet`, vEnd, true);
		}
		const vTempC = numToC(t?.VacationTemperature);
		if (vTempC !== null) {
			this.safeSetState(`${devId}.vacation.temperature`, vTempC, true);
			this.safeSetState(`${devId}.vacation.temperatureSet`, vTempC, true);
		}

		// ------------------------------------------------------------------------
		// Schedule as individual states
		// ------------------------------------------------------------------------

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

		// ------------------------------------------------------------------------
		// Energy as individual kWh values (serial number)
		// ------------------------------------------------------------------------

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

	// ============================================================================
	// WRITE HELPERS
	// ============================================================================

	_nowPlusMinutesIso(minutes) {
		return new Date(Date.now() + minutes * 60 * 1000).toISOString();
	}

	_parseIsoOrMinutes(value, defaultMinutes) {
		const v = value === null || value === undefined ? '' : String(value).trim();
		if (!v) {
			return this._nowPlusMinutesIso(defaultMinutes);
		}

		// Numeric minutes (e.g. "60")
		const asNum = Number(v);
		if (Number.isFinite(asNum) && v.match(/^\d+(\.\d+)?$/)) {
			return this._nowPlusMinutesIso(asNum);
		}

		// ISO-like string
		const d = new Date(v);
		if (!Number.isNaN(d.getTime())) {
			return d.toISOString();
		}

		// Fallback
		return this._nowPlusMinutesIso(defaultMinutes);
	}

	async _getSerialFromObject(groupId, thermostatId) {
		const oid = `groups.${safeId(groupId)}.thermostats.${safeId(thermostatId)}`;
		const obj = await this.safeGetObject(oid);
		const serial = obj?.native?.serialNumber ? String(obj.native.serialNumber) : '';
		return serial;
	}

	// ============================================================================
	// ON STATE CHANGE (writes)
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
		if (idxG === -1 || idxT === -1 || parts.length < idxT + 2) {
			return;
		}

		const groupId = parts[idxG + 1];
		const thermostatId = parts[idxT + 1];
		const sub = parts.slice(idxT + 2).join('.');

		// SerialNumber for writes
		let serial = this.thermostatSerial[thermostatId];
		if (!serial) {
			serial = await this._getSerialFromObject(groupId, thermostatId);
			if (serial) {
				this.thermostatSerial[thermostatId] = serial;
			}
		}
		if (!serial) {
			this.log.warn(`Write ignored: SerialNumber unknown for thermostat ${thermostatId} (not discovered yet).`);
			return;
		}

		const thermostatName = this.thermostatNameCache[thermostatId] || `Thermostat ${thermostatId}`;

		const comfortEndTime = this.thermostatComfortEnd[thermostatId] || this._nowPlusMinutesIso(120);
		const boostEndTime = this.thermostatBoostEnd[thermostatId] || this._nowPlusMinutesIso(60);

		const baseUpdate = {
			ThermostatName: thermostatName,
			ComfortEndTime: comfortEndTime,
			BoostEndTime: boostEndTime,
			VacationEnabled: Boolean(this.thermostatVacationEnabled?.[thermostatId]),
			VacationBeginDay: this.thermostatVacationBegin?.[thermostatId] || '1970-01-01T00:00:00',
			VacationEndDay: this.thermostatVacationEnd?.[thermostatId] || '1970-01-01T00:00:00',
			...(this.thermostatVacationTemp?.[thermostatId] !== undefined
				? { VacationTemperature: this.thermostatVacationTemp[thermostatId] }
				: {}),
		};

		// Convenience for state paths
		const devPrefix = `groups.${safeId(groupId)}.thermostats.${safeId(thermostatId)}`;

		try {
			// ----------------------------------------------------------------------
			// Setpoints
			// ----------------------------------------------------------------------

			if (sub === 'setpoint.manualSet') {
				const tempC = Number(state.val);
				this.log.debug(`Write: UpdateThermostat serial=${serial} (ManualModeSetpoint=${tempC}C)`);
				await client.updateThermostat(serial, {
					...baseUpdate,
					RegulationMode: 3,
					ManualModeSetpoint: cToNum(tempC),
				});
				this.safeSetState(id, { val: tempC, ack: true });
			} else if (sub === 'setpoint.comfortSet') {
				const tempC = Number(state.val);
				this.log.debug(`Write: UpdateThermostat serial=${serial} (ComfortSetpoint=${tempC}C)`);
				await client.updateThermostat(serial, {
					...baseUpdate,
					RegulationMode: 2,
					ComfortSetpoint: cToNum(tempC),
				});
				this.safeSetState(id, { val: tempC, ack: true });

				// ----------------------------------------------------------------------
				// Regulation mode (boost rule)
				// ----------------------------------------------------------------------
			} else if (sub === 'regulationModeSet') {
				const mode = Number(state.val);

				// Boost is mode 8 and requires BoostEndTime (+1 hour)
				if (mode === 8) {
					const boostToSend = this._nowPlusMinutesIso(60);
					this.log.debug(`Write: Boost mode=8 serial=${serial} BoostEndTime=${boostToSend}`);
					await client.updateThermostat(serial, {
						...baseUpdate,
						RegulationMode: 8,
						BoostEndTime: boostToSend,
					});
					this.thermostatBoostEnd[thermostatId] = boostToSend;
					this.safeSetState(`${devPrefix}.endTime.boost`, boostToSend, true);
					this.safeSetState(`${devPrefix}.endTime.boostSet`, boostToSend, true);
				} else {
					this.log.debug(`Write: UpdateThermostat serial=${serial} (RegulationMode=${mode})`);
					await client.updateThermostat(serial, {
						...baseUpdate,
						RegulationMode: mode,
					});
				}

				this.safeSetState(id, { val: mode, ack: true });

				// ----------------------------------------------------------------------
				// Thermostat name
				// ----------------------------------------------------------------------
			} else if (sub === 'thermostatNameSet') {
				const newName = String(state.val || '').trim();
				if (!newName) {
					throw new Error('Invalid thermostat name');
				}

				this.log.debug(`Write: UpdateThermostat serial=${serial} (ThermostatName=${newName})`);
				await client.updateThermostat(serial, {
					...baseUpdate,
					ThermostatName: newName,
				});

				this.thermostatNameCache[thermostatId] = newName;
				this.safeSetState(id, { val: newName, ack: true });
				this.safeSetState(`${devPrefix}.thermostatName`, { val: newName, ack: true });

				// ----------------------------------------------------------------------
				// End times
				// ----------------------------------------------------------------------
			} else if (sub === 'endTime.comfortSet') {
				const comfortToSend = this._parseIsoOrMinutes(state.val, 120);
				this.log.debug(`Write: UpdateThermostat serial=${serial} (ComfortEndTime=${comfortToSend})`);

				await client.updateThermostat(serial, {
					...baseUpdate,
					ComfortEndTime: comfortToSend,
				});

				this.thermostatComfortEnd[thermostatId] = comfortToSend;
				this.safeSetState(id, { val: comfortToSend, ack: true });
				this.safeSetState(`${devPrefix}.endTime.comfort`, { val: comfortToSend, ack: true });
			} else if (sub === 'endTime.boostSet') {
				const boostToSend = this._parseIsoOrMinutes(state.val, 60);
				this.log.debug(`Write: UpdateThermostat serial=${serial} (BoostEndTime=${boostToSend}, mode=8)`);

				await client.updateThermostat(serial, {
					...baseUpdate,
					RegulationMode: 8,
					BoostEndTime: boostToSend,
				});

				this.thermostatBoostEnd[thermostatId] = boostToSend;
				this.safeSetState(id, { val: boostToSend, ack: true });
				this.safeSetState(`${devPrefix}.endTime.boost`, { val: boostToSend, ack: true });

				// ----------------------------------------------------------------------
				// Vacation
				// ----------------------------------------------------------------------
			} else if (sub === 'vacation.enabledSet') {
				const enabled = Boolean(state.val);
				this.log.debug(`Write: UpdateThermostat serial=${serial} (VacationEnabled=${enabled})`);

				await client.updateThermostat(serial, {
					...baseUpdate,
					VacationEnabled: enabled,
				});

				this.thermostatVacationEnabled[thermostatId] = enabled;
				this.safeSetState(id, { val: enabled, ack: true });
				this.safeSetState(`${devPrefix}.vacation.enabled`, { val: enabled, ack: true });
			} else if (sub === 'vacation.beginSet') {
				const beginIso = this._parseIsoOrMinutes(state.val, 0);
				this.log.debug(`Write: UpdateThermostat serial=${serial} (VacationBeginDay=${beginIso})`);

				await client.updateThermostat(serial, {
					...baseUpdate,
					VacationBeginDay: beginIso,
				});

				this.thermostatVacationBegin[thermostatId] = beginIso;
				this.safeSetState(id, { val: beginIso, ack: true });
				this.safeSetState(`${devPrefix}.vacation.begin`, { val: beginIso, ack: true });
			} else if (sub === 'vacation.endSet') {
				const endIso = this._parseIsoOrMinutes(state.val, 0);
				this.log.debug(`Write: UpdateThermostat serial=${serial} (VacationEndDay=${endIso})`);

				await client.updateThermostat(serial, {
					...baseUpdate,
					VacationEndDay: endIso,
				});

				this.thermostatVacationEnd[thermostatId] = endIso;
				this.safeSetState(id, { val: endIso, ack: true });
				this.safeSetState(`${devPrefix}.vacation.end`, { val: endIso, ack: true });
			} else if (sub === 'vacation.temperatureSet') {
				const tempC = Number(state.val);
				this.log.debug(`Write: UpdateThermostat serial=${serial} (VacationTemperature=${tempC}C)`);

				const tempNum = cToNum(tempC);

				await client.updateThermostat(serial, {
					...baseUpdate,
					VacationTemperature: tempNum,
				});

				this.thermostatVacationTemp[thermostatId] = tempNum;
				this.safeSetState(id, { val: tempC, ack: true });
				this.safeSetState(`${devPrefix}.vacation.temperature`, { val: tempC, ack: true });

				// ----------------------------------------------------------------------
				// Unknown writable state
				// ----------------------------------------------------------------------
			} else {
				this.log.debug(`Write ignored (unknown sub-path): ${sub}`);
				this.safeSetState(id, { val: state.val, ack: true });
			}
		} catch (e) {
			this.log.error(`Write failed for ${id}: ${e?.message || e}`);
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

			// Wait for an in-flight poll to finish (best effort)
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
		} catch {
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
