'use strict';

const utils = require('@iobroker/adapter-core');
const { OJClient } = require('./lib/oj-client');
const { safeId, numToC, cToNum } = require('./lib/util');

class SchlueterThermostat extends utils.Adapter {
	constructor(options) {
		super({ ...options, name: 'schlueter-thermostat' });

		this.client = null;
		this.pollTimer = null;

		this.on('ready', this.onReady.bind(this));
		this.on('stateChange', this.onStateChange.bind(this));
		this.on('unload', this.onUnload.bind(this));
	}

	async onReady() {
		this.setState('info.connection', false, true);

		const provider = 'owd5';
		if (!this.config.username || !this.config.password) {
			this.log.error('Missing username/password in adapter config.');
			return;
		}
		if (provider === 'owd5' && (!this.config.apiKey || !this.config.customerId)) {
			this.log.error('Provider=owd5 requires apiKey and customerId.');
			return;
		}

		this.client = new OJClient({
			log: this.log,
			provider,
			baseUrlOwd5: this.config.baseUrlOwd5,
			username: this.config.username,
			password: this.config.password,
			apiKey: this.config.apiKey,
			customerId: Number(this.config.customerId),
			clientSwVersion: Number(this.config.clientSWVersion) || 1,
		});

		try {
			await this.client.login();
			this.setState('info.connection', true, true);
		} catch (e) {
			this.log.error(`Login failed: ${e?.message || e}`);
			this.setState('info.connection', false, true);
			return;
		}

		await this.setObjectNotExistsAsync('thermostats', {
			type: 'channel',
			common: { name: 'Thermostats / Groups' },
			native: {},
		});

		const intervalSec = Math.max(15, Number(this.config.pollIntervalSec) || 60);

		await this.pollOnce();

		this.pollTimer = setInterval(() => {
			this.pollOnce().catch(err => this.log.warn(`Poll error: ${err?.message || err}`));
		}, intervalSec * 1000);
	}

	async pollOnce() {
		const client = this.client;
		if (!client) {
			return;
		}

		const data = await client.getAllThermostats();
		this.setState('info.connection', true, true);

		for (const t of data.thermostats || []) {
			await this.upsertThermostat(t);
		}
	}

	async upsertThermostat(t) {
		// For OWD5 we treat each GroupId as the controllable entity (UpdateGroup).
		// Energy endpoint uses thermostatId (t.thermostatId).
		const groupId = String(t.groupId);
		if (!groupId) {
			return;
		}
		const client = this.client;
		if (!client) {
			return;
		}

		const devId = `thermostats.${safeId(groupId)}`;

		await this.setObjectNotExistsAsync(devId, {
			type: 'device',
			common: { name: t.groupName || t.name || `Group ${groupId}` },
			native: {
				groupId,
				thermostatId: t.thermostatId ? String(t.thermostatId) : '',
				serialNumber: t.serialNumber || '',
			},
		});

		const ensureState = async (id, common) => {
			await this.setObjectNotExistsAsync(id, { type: 'state', common, native: {} });
		};

		// Read-only indicators
		await ensureState(`${devId}.online`, {
			name: 'Online',
			type: 'boolean',
			role: 'indicator.reachable',
			read: true,
			write: false,
		});
		await ensureState(`${devId}.heating`, {
			name: 'Heating active',
			type: 'boolean',
			role: 'indicator.working',
			read: true,
			write: false,
		});

		// Temperatures
		await ensureState(`${devId}.temperature.room`, {
			name: 'Room temperature (°C)',
			type: 'number',
			role: 'value.temperature',
			unit: '°C',
			read: true,
			write: false,
		});
		await ensureState(`${devId}.temperature.floor`, {
			name: 'Floor temperature (°C)',
			type: 'number',
			role: 'value.temperature',
			unit: '°C',
			read: true,
			write: false,
		});

		// Setpoints + modes (read)
		await ensureState(`${devId}.setpoint.manual`, {
			name: 'Manual setpoint (°C)',
			type: 'number',
			role: 'value.temperature',
			unit: '°C',
			read: true,
			write: false,
		});
		await ensureState(`${devId}.setpoint.comfort`, {
			name: 'Comfort setpoint (°C)',
			type: 'number',
			role: 'value.temperature',
			unit: '°C',
			read: true,
			write: false,
		});
		await ensureState(`${devId}.regulationMode`, {
			name: 'Regulation mode (read)',
			type: 'number',
			role: 'value',
			read: true,
			write: false,
		});

		// Writeable controls
		await ensureState(`${devId}.setpoint.manualSet`, {
			name: 'Set manual setpoint (°C)',
			type: 'number',
			role: 'level.temperature',
			unit: '°C',
			read: true,
			write: true,
		});
		await ensureState(`${devId}.setpoint.comfortSet`, {
			name: 'Set comfort setpoint (°C)',
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

		// Schedule raw JSON
		await ensureState(`${devId}.schedule.json`, {
			name: 'Schedule (raw JSON)',
			type: 'string',
			role: 'json',
			read: true,
			write: false,
		});

		// Energy
		await this.setObjectNotExistsAsync(`${devId}.energy`, {
			type: 'channel',
			common: { name: 'Energy' },
			native: {},
		});
		await ensureState(`${devId}.energy.current.json`, {
			name: 'Energy usage (raw JSON)',
			type: 'string',
			role: 'json',
			read: true,
			write: false,
		});

		// ---- Values from your observed OWD5 structure ----
		const online = Boolean(t.online);
		const heating = Boolean(t.heating);

		const room = numToC(t.roomTemperature);
		const floor = numToC(t.floorTemperature);

		const manualSetpoint = numToC(t.manualModeSetpoint);
		const comfortSetpoint = numToC(t.comfortSetpoint);

		const regulationMode = Number(t.regulationMode ?? 0);

		await this.setState(`${devId}.online`, { val: online, ack: true });
		await this.setState(`${devId}.heating`, { val: heating, ack: true });

		if (room !== null) {
			await this.setState(`${devId}.temperature.room`, { val: room, ack: true });
		}
		if (floor !== null) {
			await this.setState(`${devId}.temperature.floor`, { val: floor, ack: true });
		}

		if (manualSetpoint !== null) {
			await this.setState(`${devId}.setpoint.manual`, { val: manualSetpoint, ack: true });
			await this.setState(`${devId}.setpoint.manualSet`, { val: manualSetpoint, ack: true });
		}
		if (comfortSetpoint !== null) {
			await this.setState(`${devId}.setpoint.comfort`, { val: comfortSetpoint, ack: true });
			await this.setState(`${devId}.setpoint.comfortSet`, { val: comfortSetpoint, ack: true });
		}

		await this.setState(`${devId}.regulationMode`, { val: regulationMode, ack: true });
		await this.setState(`${devId}.regulationModeSet`, { val: regulationMode, ack: true });

		if (t.schedule) {
			await this.setState(`${devId}.schedule.json`, { val: JSON.stringify(t.schedule), ack: true });
		}

		// Energy usage uses thermostatId (t.thermostatId = Thermostats[].Id)
		if (t.thermostatId) {
			try {
				const energy = await client.getEnergyUsageForThermostat(String(t.thermostatId), {
					history: Number(this.config.energyHistory) || 0,
					viewType: Number(this.config.energyViewType) || 2,
				});
				if (energy) {
					await this.setState(`${devId}.energy.current.json`, {
						val: JSON.stringify(energy),
						ack: true,
					});
				}
			} catch (e) {
				this.log.debug(`Energy not available for group ${groupId}: ${e?.message || e}`);
			}
		}
	}

	async onStateChange(id, state) {
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

		const groupId = parts[idx + 1]; // our ioBroker device id equals GroupId
		const sub = parts.slice(idx + 2).join('.');

		try {
			if (sub === 'setpoint.manualSet') {
				const tempC = Number(state.val);
				await client.setManualSetpointByGroup(groupId, cToNum(tempC));
				await this.setState(id, { val: tempC, ack: true });
			} else if (sub === 'setpoint.comfortSet') {
				const tempC = Number(state.val);
				await client.setComfortSetpointByGroup(groupId, cToNum(tempC));
				await this.setState(id, { val: tempC, ack: true });
			} else if (sub === 'regulationModeSet') {
				const mode = Number(state.val);
				await client.setRegulationModeByGroup(groupId, mode);
				await this.setState(id, { val: mode, ack: true });
			} else {
				this.log.debug(`Unhandled writable state: ${id}`);
				await this.setState(id, { val: state.val, ack: true });
			}
		} catch (e) {
			this.log.error(`Write failed for ${id}: ${e?.message || e}`);
		}
	}

	async onUnload(callback) {
		try {
			if (this.pollTimer) {
				clearInterval(this.pollTimer);
			}
			if (this.client) {
				await this.client.close();
			}
			callback();
		} catch (e) {
			this.log.error(`Write failed for ${e?.message || e}`);
			callback();
		}
	}
}

if (require.main !== module) {
	module.exports = options => new SchlueterThermostat(options);
} else {
	(() => new SchlueterThermostat())();
}
