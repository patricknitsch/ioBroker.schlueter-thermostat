/* eslint-disable jsdoc/require-jsdoc */
'use strict';

const axios = require('axios');

// ============================================================================
// OJ Cloud Client (OWD5 read + OCD5 write)
// - Reads:   OWD5 GroupContents, OWD5 EnergyUsage
// - Writes:  OCD5 UpdateThermostat
// ============================================================================

class OJClient {
	/**
	 * @param {{log:any, baseUrlOwd5?:string, baseUrlOcd5?:string, username:string, password:string, apiKey:string, customerId:number}} cfg
	 */
	constructor(cfg) {
		this.log = cfg.log;
		this.username = cfg.username;
		this.password = cfg.password;
		this.apiKey = cfg.apiKey;
		this.customerId = cfg.customerId;

		this.baseUrlOwd5 = (cfg.baseUrlOwd5 || 'https://owd5-mh015-app.ojelectronics.com').replace(/\/+$/, '');
		this.baseUrlOcd5 = (cfg.baseUrlOcd5 || 'https://ocd5.azurewebsites.net').replace(/\/+$/, '');

		this.sessionId = null;

		this.http = axios.create({
			timeout: 20000,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	async login() {
		const url = `${this.baseUrlOwd5}/api/UserProfile/SignIn`;
		const payload = {
			APIKEY: this.apiKey,
			UserName: this.username,
			Password: this.password,
			CustomerId: this.customerId,
		};

		this.log.debug(`OWD5 login: POST ${url} (CustomerId=${this.customerId}, UserName=${this.username})`);
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

	async getGroupContents() {
		await this.ensureSession();
		const url = `${this.baseUrlOwd5}/api/Group/GroupContents`;
		this.log.debug(`GroupContents: GET ${url}`);
		const { data } = await this.http.get(url, { params: { sessionid: this.sessionId, APIKEY: this.apiKey } });
		if (data?.ErrorCode && data.ErrorCode !== 0) {
			throw new Error(`GroupContents failed: ${JSON.stringify(data)}`);
		}
		return data;
	}

	/**
	 * Returns one normalized entry per group (GroupId) using first thermostat for live values.
	 */
	async getAllGroups() {
		const data = await this.getGroupContents();
		const groups = data?.GroupContents || [];
		const out = [];
		for (const g of groups) {
			const firstT = Array.isArray(g?.Thermostats) && g.Thermostats.length ? g.Thermostats[0] : null;
			out.push({
				groupId: g?.GroupId,
				groupName: g?.GroupName,
				thermostatId: firstT?.Id ?? null, // for energy endpoint
				serialNumber: firstT?.SerialNumber ?? null, // for OCD5 update
				thermostatName: firstT?.ThermostatName ?? null,
				comfortEndTime: firstT?.ComfortEndTime ?? null,
				online: firstT?.Online ?? true,
				heating: firstT?.Heating ?? false,
				roomTemperature: firstT?.RoomTemperature ?? null,
				floorTemperature: firstT?.FloorTemperature ?? null,
				regulationMode: firstT?.RegulationMode ?? g?.RegulationMode ?? null,
				manualModeSetpoint: firstT?.ManualModeSetpoint ?? g?.ManualModeSetpoint ?? null,
				comfortSetpoint: firstT?.ComfortSetpoint ?? g?.ComfortSetpoint ?? null,
				schedule: firstT?.Schedule ?? g?.Schedule ?? null,
				rawGroup: g,
				rawThermostat: firstT,
			});
		}
		return out;
	}

	async updateThermostat(serialNumber, fields) {
		await this.ensureSession();
		const url = `${this.baseUrlOcd5}/api/Thermostat/UpdateThermostat`;
		const payload = {
			APIKEY: this.apiKey,
			SetThermostat: {
				SerialNumber: String(serialNumber),
				...fields,
			},
		};
		this.log.debug(
			`UpdateThermostat: POST ${url} (SerialNumber=${serialNumber}) fields=${Object.keys(fields || {}).join(',')}`,
		);
		const { data } = await this.http.post(url, payload, { params: { sessionid: this.sessionId } });
		if (data?.ErrorCode && data.ErrorCode !== 0) {
			throw new Error(`UpdateThermostat failed: ${JSON.stringify(data)}`);
		}
		return data;
	}

	async getEnergyUsage(serialNumber, opts) {
		await this.ensureSession();
		const url = `${this.baseUrlOwd5}/api/EnergyUsage/GetEnergyUsage`;
		const payload = {
			APIKEY: this.apiKey,
			DateTime: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // tomorrow
			History: opts?.history ?? 0,
			ThermostatID: String(serialNumber),
			ViewType: opts?.viewType ?? 2,
		};
		this.log.debug(
			`GetEnergyUsage: POST ${url} (ThermostatID=${serialNumber}, ViewType=${payload.ViewType}, History=${payload.History}, DateTime=${payload.DateTime})`,
		);
		const { data } = await this.http.post(url, payload, { params: { sessionid: this.sessionId } });
		if (data?.ErrorCode && data.ErrorCode !== 0) {
			throw new Error(`GetEnergyUsage failed: ${JSON.stringify(data)}`);
		}
		return data;
	}
}

module.exports = { OJClient };
