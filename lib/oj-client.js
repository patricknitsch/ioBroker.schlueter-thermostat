// lib/oj-client.js
/* eslint-disable jsdoc/require-jsdoc */
'use strict';

const axios = require('axios');

// ============================================================================
// OJ Cloud Client (OWD5 read + OCD5 write)
// - Reads:   OWD5 GroupContents, OWD5 EnergyUsage
// - Writes:  OCD5 UpdateThermostat
//
// Robustness:
// - If a request fails with 401/403, we re-login once and retry once.
// ============================================================================

class OJClient {
	/**
	 * @param {{log:any, baseUrlOwd5?:string, baseUrlOcd5?:string, username:string, password:string, apiKey:string, customerId:number}} cfg # param cfg.log - Logger (must have debug/info/warn/error methods)
	 * # param cfg.baseUrlOwd5 - Base URL for OWD5 API (default: 'https://owd5-mh015-app.ojelectronics.com')
	 * # param cfg.baseUrlOcd5 - Base URL for OCD5 API (default: 'https://ocd5.azurewebsites.net')
	 * # param cfg.username - Username for login
	 * # param cfg.password - Password for login
	 * # param cfg.apiKey - API key for login
	 * # param cfg.customerId - Customer ID for login
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
		this._loginInFlight = null;

		this.http = axios.create({
			timeout: 20000,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	_formatIsoNoMsNoZ(value) {
		if (!value) {
			return '';
		}
		const d = value instanceof Date ? value : new Date(String(value));
		if (Number.isNaN(d.getTime())) {
			return String(value)
				.trim()
				.replace(/\.\d{3}Z$/, '')
				.replace(/Z$/, '')
				.replace(/\.\d{3}$/, '');
		}
		return d.toISOString().replace(/\.\d{3}Z$/, '');
	}

	async login() {
		if (this._loginInFlight) {
			return this._loginInFlight;
		}

		this._loginInFlight = (async () => {
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
		})().finally(() => {
			this._loginInFlight = null;
		});

		return this._loginInFlight;
	}

	async ensureSession() {
		if (!this.sessionId) {
			await this.login();
		}
	}

	_isAuthError(err) {
		const status = err?.response?.status;
		return status === 401 || status === 403;
	}

	async _requestWithReloginOnce(fn, label) {
		await this.ensureSession();

		try {
			return await fn();
		} catch (err) {
			if (this._isAuthError(err)) {
				this.log.warn(`${label}: got ${err?.response?.status} - re-login and retry once`);
				this.sessionId = null;
				await this.login();
				return await fn();
			}
			throw err;
		}
	}

	async getGroupContents() {
		const url = `${this.baseUrlOwd5}/api/Group/GroupContents`;
		return this._requestWithReloginOnce(async () => {
			this.log.debug(`GroupContents: GET ${url}`);
			const { data } = await this.http.get(url, { params: { sessionid: this.sessionId, APIKEY: this.apiKey } });
			if (data?.ErrorCode && data.ErrorCode !== 0) {
				throw new Error(`GroupContents failed: ${JSON.stringify(data)}`);
			}
			return data;
		}, 'GroupContents');
	}

	async updateThermostat(serialNumber, fields) {
		const url = `${this.baseUrlOcd5}/api/Thermostat/UpdateThermostat`;
		return this._requestWithReloginOnce(async () => {
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
		}, 'UpdateThermostat');
	}

	async getEnergyUsage(serialNumber, opts) {
		const url = `${this.baseUrlOwd5}/api/EnergyUsage/GetEnergyUsage`;
		return this._requestWithReloginOnce(async () => {
			const payload = {
				APIKEY: this.apiKey,
				DateTime: this._formatIsoNoMsNoZ(new Date(Date.now() + 24 * 60 * 60 * 1000)), // tomorrow
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
		}, 'GetEnergyUsage');
	}
}

module.exports = { OJClient };
