/* eslint-disable jsdoc/require-jsdoc */
'use strict';

const axios = require('axios');

class OJClient {
	/**
	 * @param {{log:any, provider:'owd5', baseUrlOwd5?:string, username:string, password:string, apiKey:string, customerId:number}} cfg
	 */
	constructor(cfg) {
		this.log = cfg.log;
		this.provider = (cfg.provider || 'owd5').toLowerCase();
		this.username = cfg.username;
		this.password = cfg.password;
		this.apiKey = cfg.apiKey;
		this.customerId = cfg.customerId;

		this.baseUrlOwd5 = (cfg.baseUrlOwd5 || 'https://owd5-mh015-app.ojelectronics.com').replace(/\/+$/, '');

		this.sessionId = null;

		this.http = axios.create({
			timeout: 20000,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	async close() {
		/* nothing to do */
	}

	async login() {
		if (this.provider !== 'owd5') {
			throw new Error('This build is configured for OWD5 cloud only.');
		}

		const url = `${this.baseUrlOwd5}/api/UserProfile/SignIn`;
		const payload = {
			APIKEY: this.apiKey,
			ClientSWVersion: 1,
			CustomerId: this.customerId,
			Password: this.password,
			UserName: this.username,
		};

		const { data } = await this.http.post(url, payload);
		if (!data || data.ErrorCode !== 0 || !data.SessionId) {
			throw new Error(`OWD5 login failed: ${JSON.stringify(data)}`);
		}
		this.sessionId = data.SessionId;
		this.log.info('Logged in (OWD5).');
	}

	async ensureSession() {
		if (!this.sessionId) {
			await this.login();
		}
	}

	/**
	 * Normalize from observed OWD5 structure:
	 * GroupContents: [{ GroupId, GroupName, RegulationMode, Schedule, ManualModeSetpoint, ComfortSetpoint, Thermostats:[{Id,SerialNumber,Online,Heating,RoomTemperature,FloorTemperature,...}] }]
	 *
	 * We expose one "thermostat item" per **GroupId** (controllable via UpdateGroup),
	 * and attach the first thermostat's Id as thermostatId for energy usage.
	 */
	async getAllThermostats() {
		await this.ensureSession();

		const url = `${this.baseUrlOwd5}/api/Group/GroupContents`;
		const { data } = await this.http.get(url, { params: { sessionid: this.sessionId, APIKEY: this.apiKey } });

		const thermostats = [];
		const groups = data?.GroupContents || [];
		for (const g of groups) {
			const groupId = g?.GroupId;
			const groupName = g?.GroupName;

			const firstT = Array.isArray(g?.Thermostats) && g.Thermostats.length ? g.Thermostats[0] : null;

			thermostats.push({
				groupId,
				groupName,
				// prefer thermostat-level values when present, else group-level fallbacks
				thermostatId: firstT?.Id ?? null,
				serialNumber: firstT?.SerialNumber ?? null,
				online: firstT?.Online ?? true,
				heating: firstT?.Heating ?? false,
				roomTemperature: firstT?.RoomTemperature ?? g?.RoomTemperature,
				floorTemperature: firstT?.FloorTemperature ?? g?.FloorTemperature,
				regulationMode: firstT?.RegulationMode ?? g?.RegulationMode,
				manualModeSetpoint: firstT?.ManualModeSetpoint ?? g?.ManualModeSetpoint,
				comfortSetpoint: firstT?.ComfortSetpoint ?? g?.ComfortSetpoint,
				schedule: firstT?.Schedule ?? g?.Schedule,
				rawGroup: g,
				rawThermostat: firstT,
			});
		}

		return { thermostats, raw: data };
	}

	// ---- Writes (Group/UpdateGroup) ----

	async _updateGroup(setGroup) {
		await this.ensureSession();

		const url = `${this.baseUrlOwd5}/api/Group/UpdateGroup`;
		const payload = {
			APIKEY: this.apiKey,
			SetGroup: setGroup,
		};

		const { data } = await this.http.post(url, payload, { params: { sessionid: this.sessionId } });
		if (data?.ErrorCode && data.ErrorCode !== 0) {
			throw new Error(`UpdateGroup failed: ${JSON.stringify(data)}`);
		}
		return data;
	}

	async setManualSetpointByGroup(groupId, setpointHundredths) {
		// In many installs manual mode is RegulationMode=3, but you can also set only the setpoint.
		return this._updateGroup({
			GroupId: Number(groupId),
			ManualModeSetpoint: setpointHundredths,
			RegulationMode: 3,
		});
	}

	async setComfortSetpointByGroup(groupId, setpointHundredths) {
		return this._updateGroup({
			GroupId: Number(groupId),
			ComfortSetpoint: setpointHundredths,
		});
	}

	async setRegulationModeByGroup(groupId, mode) {
		return this._updateGroup({
			GroupId: Number(groupId),
			RegulationMode: Number(mode),
		});
	}

	async getEnergyUsageForThermostat(thermostatId, opts) {
		await this.ensureSession();

		const url = `${this.baseUrlOwd5}/api/EnergyUsage/GetEnergyUsage`;
		const payload = {
			APIKEY: this.apiKey,
			DateTime: new Date().toISOString(),
			History: opts?.history ?? 0,
			ThermostatID: String(thermostatId),
			ViewType: opts?.viewType ?? 2,
		};

		const { data } = await this.http.post(url, payload, { params: { sessionid: this.sessionId } });

		if (data?.ErrorCode && data.ErrorCode !== 0) {
			throw new Error(`GetEnergyUsage failed: ${JSON.stringify(data)}`);
		}
		return data;
	}
}

module.exports = { OJClient };
