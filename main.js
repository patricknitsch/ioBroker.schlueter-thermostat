'use strict';

// ============================================================================
// schlueter-thermostat
// - Reads:   OWD5 GroupContents + EnergyUsage
// - Writes:  OCD5 UpdateThermostat
// - Exposes: schedule + energy as individual states
// ============================================================================

const utils = require('@iobroker/adapter-core');
const { OJClient } = require('./lib/oj-client');
const { safeId, numToC, cToNum } = require('./lib/util');

class SchlueterThermostat extends utils.Adapter {
	constructor(options) {
		super({ ...options, name: 'schlueter-thermostat' });

		// Keep original adapter-core methods (avoid wrapper recursion)
		this._origSetObjectNotExistsAsync = this.setObjectNotExistsAsync.bind(this);
		this._origSetState = this.setState.bind(this);

		/** @type {OJClient|null} */
		this.client = null;

		/** @type {Record<string,string>} GroupId -> SerialNumber */
		this.groupSerial = {};
		/** @type {Record<string,string>} GroupId -> ThermostatId */
		this.groupThermostatId = {};

		/** @type {Record<string,string>} GroupId -> ThermostatName */
		this.groupNameCache = {};
		/** @type {Record<string,string>} GroupId -> ComfortEndTime ISO */
		this.groupComfortEnd = {};

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
			clientSwVersion: Number(this.config.clientSWVersion) || 1,
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

		await this.safeSetObjectNotExists('thermostats', { type: 'channel', common: { name: 'Groups' }, native: {} });

		const intervalSec = Math.max(15, Number(this.config.pollIntervalSec) || 60);
		await this.pollOnce();

		// Subscribe writable states
		this.subscribeStates('thermostats.*.setpoint.manualSet');
		this.subscribeStates('thermostats.*.setpoint.comfortSet');
		this.subscribeStates('thermostats.*.regulationModeSet');

		this.pollTimer = setInterval(() => {
			this.pollOnce().catch(err => this.log.warn(`Poll error: ${err?.message || err}`));
		}, intervalSec * 1000);
	}

	// ============================================================================
	// FUNCTIONS
	// ============================================================================

	async pollOnce() {
		this.log.debug('pollOnce(): polling groups from cloud');
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
			const groups = await client.getAllGroups();
			this.log.debug(`Reading groups done: count=${groups.length}`);
			this.safeSetState('info.connection', true, true);

			for (const g of groups) {
				if (this.unloading) {
					break;
				}
				await this.upsertGroup(g);
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

	async upsertGroup(g) {
		this.log.debug(
			`upsertGroup(): GroupId=${g.groupId}, SerialNumber=${g.serialNumber || ''}, ThermostatId=${g.thermostatId || ''}`,
		);
		const groupId = String(g.groupId);
		if (!groupId) {
			return;
		}

		const devId = `thermostats.${safeId(groupId)}`;

		// cache ids
		if (g.serialNumber) {
			this.groupSerial[groupId] = String(g.serialNumber);
		}
		if (g.thermostatId) {
			this.groupThermostatId[groupId] = String(g.thermostatId);
		}
		if (g.thermostatName) {
			this.groupNameCache[groupId] = String(g.thermostatName);
		}
		if (g.comfortEndTime) {
			this.groupComfortEnd[groupId] = String(g.comfortEndTime);
		}

		await this.safeSetObjectNotExists(devId, {
			type: 'device',
			common: { name: g.groupName || `Group ${groupId}` },
			native: { groupId, serialNumber: g.serialNumber || '', thermostatId: g.thermostatId || '' },
		});

		const ensureState = async (id, common) => {
			await this.safeSetObjectNotExists(id, { type: 'state', common, native: {} });
		};

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

		// writable
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

		// set values
		this.safeSetState(`${devId}.online`, { val: Boolean(g.online), ack: true });
		this.safeSetState(`${devId}.heating`, { val: Boolean(g.heating), ack: true });

		const rt = numToC(g.roomTemperature);
		const ft = numToC(g.floorTemperature);
		if (rt !== null) {
			this.safeSetState(`${devId}.temperature.room`, { val: rt, ack: true });
		}
		if (ft !== null) {
			this.safeSetState(`${devId}.temperature.floor`, { val: ft, ack: true });
		}

		const ms = numToC(g.manualModeSetpoint);
		const cs = numToC(g.comfortSetpoint);
		if (ms !== null) {
			this.safeSetState(`${devId}.setpoint.manual`, { val: ms, ack: true });
			this.safeSetState(`${devId}.setpoint.manualSet`, { val: ms, ack: true });
		}
		if (cs !== null) {
			this.safeSetState(`${devId}.setpoint.comfort`, { val: cs, ack: true });
			this.safeSetState(`${devId}.setpoint.comfortSet`, { val: cs, ack: true });
		}

		const mode = Number(g.regulationMode ?? 0);
		this.safeSetState(`${devId}.regulationMode`, { val: mode, ack: true });
		this.safeSetState(`${devId}.regulationModeSet`, { val: mode, ack: true });

		// Schedule as individual states
		if (g.schedule && Array.isArray(g.schedule.Days)) {
			for (const day of g.schedule.Days) {
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

		// Energy as individual kWh values
		const client = this.client;
		const tid = g.groupSerial ? String(g.groupSerial) : null;
		if (client && tid) {
			try {
				this.log.debug(`Energy: requesting usage for Serial=${tid}`);
				const energy = await client.getEnergyUsage(tid, {
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
				this.log.debug(`Energy not available for ${groupId}: ${e?.message || e}`);
			}
		}
	}

	// ============================================================================
	// ON STATE CHANGE
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
		const idx = parts.indexOf('thermostats');
		if (idx === -1 || parts.length < idx + 2) {
			return;
		}

		const groupId = parts[idx + 1];
		const sub = parts.slice(idx + 2).join('.');

		const serial = this.groupSerial[groupId];
		if (!serial) {
			this.log.warn(`Write ignored: SerialNumber unknown for group ${groupId} (not discovered yet).`);
			return;
		}
		const thermostatName = this.groupNameCache[groupId] || `Group ${groupId}`;
		const comfortEndTime = this.groupComfortEnd[groupId] || new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

		try {
			if (sub === 'setpoint.manualSet') {
				const tempC = Number(state.val);
				this.log.debug(`Write: UpdateThermostat serial=${serial} (manualSetpoint)`);
				this.log.debug(`Write: UpdateThermostat serial=${serial} (comfortSetpoint)`);
				this.log.debug(`Write: UpdateThermostat serial=${serial} (regulationMode)`);
				await client.updateThermostat(serial, {
					ThermostatName: thermostatName,
					//ComfortEndTime: comfortEndTime,
					RegulationMode: 3,
					ManualModeSetpoint: cToNum(tempC),
				});
				this.safeSetState(id, { val: tempC, ack: true });
			} else if (sub === 'setpoint.comfortSet') {
				const tempC = Number(state.val);
				await client.updateThermostat(serial, {
					ThermostatName: thermostatName,
					ComfortEndTime: comfortEndTime,
					RegulationMode: 2,
					ComfortSetpoint: cToNum(tempC),
				});
				this.groupComfortEnd[groupId] = comfortEndTime;
				this.safeSetState(id, { val: tempC, ack: true });
			} else if (sub === 'regulationModeSet') {
				const mode = Number(state.val);
				await client.updateThermostat(serial, {
					ThermostatName: thermostatName,
					//ComfortEndTime: comfortEndTime,
					RegulationMode: mode,
				});
				this.safeSetState(id, { val: mode, ack: true });
			} else {
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
				await Promise.race([p, new Promise(res => setTimeout(res, 5000))]);
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
