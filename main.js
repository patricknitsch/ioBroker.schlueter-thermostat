'use strict';

const utils = require('@iobroker/adapter-core');
const { OJClient } = require('./lib/oj-client');
const { safeId } = require('./lib/util');

const { ensureGroupObjects, ensureThermostatObjects, ensureApplyObjects } = require('./lib/objects');
const { toThermostatLocalNoZFromAny } = require('./lib/time');
const {
	writeThermostatStates,
	prefillApplyNonDestructive,
	writeScheduleStates,
	writeEnergyStates,
} = require('./lib/writers');
const { createApplyRouter } = require('./lib/apply-handlers');

class SchlueterThermostat extends utils.Adapter {
	constructor(options) {
		super({ ...options, name: 'schlueter-thermostat' });

		// Keep original adapter-core methods (avoid wrapper recursion)
		this._origSetObjectNotExistsAsync = this.setObjectNotExistsAsync.bind(this);
		this._origSetObjectAsync = this.setObject.bind(this);
		this._origGetObjectAsync = this.getObjectAsync.bind(this);
		this._origSetState = this.setState.bind(this);

		this.client = null;

		this.thermostatSerial = {};
		this.thermostatGroup = {};
		this.thermostatNameCache = {};
		this.thermostatTimeZoneSec = {};

		this.lastOnline = {};
		this.warnedOffline = {};
		this.legacyStatesDeleted = {};

		this.groupNameCache = {};

		this.pollTimer = null;
		this.unloading = false;
		this.pollInFlight = false;
		this.pollPromise = null;

		this.applyRouter = createApplyRouter(this);

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
	// onReady
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

		const MAX_TIMER_MS = 2147483647; // Node.js max setTimeout/setInterval delay (~24.8 days)

		const intervalSecRaw = Number(this.config.pollIntervalSec);
		const intervalSec = Number.isFinite(intervalSecRaw) ? intervalSecRaw : 60;

		// min 10s, max MAX_TIMER_MS
		const intervalMs = Math.min(MAX_TIMER_MS, Math.max(10_000, Math.trunc(intervalSec * 1000)));

		await this.pollOnce();

		// Subscribe ONLY apply buttons
		this.subscribeStates('groups.*.thermostats.*.apply.*.apply');

		this.pollTimer = this.setInterval(() => {
			this.pollOnce().catch(err => this.log.warn(`Poll error: ${err?.message || err}`));
		}, intervalMs);
	}

	// ============================================================================
	// Poll
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
			const data = await client.getGroupContents();
			const groups = Array.isArray(data?.GroupContents) ? data.GroupContents : [];
			this.safeSetState('info.connection', true, true);

			for (const group of groups) {
				if (this.unloading) {
					break;
				}

				const groupId = String(group?.GroupId ?? '');
				if (!groupId) {
					continue;
				}

				await ensureGroupObjects(this, group);

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
	// Upsert thermostat
	// ============================================================================

	async upsertThermostat(group, t) {
		const groupId = String(group?.GroupId ?? '');
		const thermostatId = String(t?.Id ?? '');
		if (!groupId || !thermostatId) {
			return;
		}

		const devId = `groups.${safeId(groupId)}.thermostats.${safeId(thermostatId)}`;

		// Cache essentials
		const serial = t?.SerialNumber ? String(t.SerialNumber) : '';
		if (serial) {
			this.thermostatSerial[thermostatId] = serial;
		}
		this.thermostatGroup[thermostatId] = groupId;

		const thermostatName = String(t?.ThermostatName || `Thermostat ${thermostatId}`);
		this.thermostatNameCache[thermostatId] = thermostatName;

		const parsedTz = Number(t?.TimeZone);
		if (Number.isFinite(parsedTz)) {
			this.thermostatTimeZoneSec[thermostatId] = parsedTz;
		}
		const tzSec = this._getTzSec(thermostatId, t);

		// Ensure objects exist
		await ensureThermostatObjects(this, devId, { groupId, thermostatId, serialNumber: serial }, thermostatName);
		await ensureApplyObjects(this, devId);

		// Delete legacy direct-write states once
		await this.deleteOldWritableStates(devId);

		// Online transition warn
		const onlineNow = Boolean(t?.Online);
		const prevOnline = this.lastOnline[thermostatId];
		if (prevOnline === true && onlineNow === false && !this.warnedOffline[thermostatId]) {
			const gName = this.groupNameCache[groupId] || `Group ${groupId}`;
			this.log.warn(`Thermostat OFFLINE: ${gName} / ${thermostatName} (ThermostatId=${thermostatId})`);
			this.warnedOffline[thermostatId] = true;
		}
		if (onlineNow === true) {
			this.warnedOffline[thermostatId] = false;
		}
		this.lastOnline[thermostatId] = onlineNow;

		// EndTimes incoming -> thermostat local no-Z
		const comfortEndLocal = toThermostatLocalNoZFromAny(t?.ComfortEndTime || '', tzSec);
		const boostEndLocal = toThermostatLocalNoZFromAny(t?.BoostEndTime || '', tzSec);

		// Write read-only states
		await writeThermostatStates(this, devId, t, { comfortEndLocal, boostEndLocal });

		// Non-destructive prefill of apply.* (does not overwrite user edits)
		await prefillApplyNonDestructive(this, devId, t);

		// Schedule
		await writeScheduleStates(this, devId, t?.Schedule);

		// Energy
		if (this.client && serial) {
			await writeEnergyStates(this, devId, serial, {
				history: Number(this.config.energyHistory) || 0,
				viewType: Number(this.config.energyViewType) || 2,
			});
		}
	}

	// ============================================================================
	// Apply-only writes
	// ============================================================================

	async onStateChange(id, state) {
		this.log.debug(`onStateChange(): id=${id} val=${state?.val}`);
		if (!state || state.ack) {
			return;
		}

		if (!id.endsWith('.apply')) {
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

		// block writes if offline
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
			this.log.warn(`Apply ignored: SerialNumber unknown for thermostat ${thermostatId}.`);
			this.safeSetState(id, { val: false, ack: true });
			return;
		}

		const devPrefix = `groups.${safeId(groupId)}.thermostats.${safeId(thermostatId)}`;
		const baseName = this.thermostatNameCache[thermostatId] || `Thermostat ${thermostatId}`;
		const modeFolder = parts[idxApply + 1];

		try {
			await this.applyRouter({
				modeFolder,
				id,
				devPrefix,
				serial,
				thermostatId,
				baseName,
			});
		} catch (e) {
			this.log.error(`Apply failed for ${id}: ${e?.message || e}`);
		} finally {
			this.safeSetState(id, { val: false, ack: true });
		}
	}

	// ============================================================================
	// onUnload
	// ============================================================================

	async onUnload(callback) {
		try {
			this.log.debug('onUnload(): stopping adapter');
			this.unloading = true;

			if (this.pollTimer) {
				this.clearInterval(this.pollTimer);
			}

			// Wait for in-flight poll (best effort)
			const p = this.pollPromise;
			if (p) {
				let timeoutId = null;

				const timeoutPromise = new Promise(resolve => {
					timeoutId = this.setTimeout(resolve, 5000, undefined);
				});

				await Promise.race([p, timeoutPromise]);

				if (timeoutId) {
					this.clearTimeout(timeoutId);
				}
			}

			callback();
		} catch (e) {
			this.log.error(`onUnload error: ${e?.message || e}`);
			callback();
		}
	}
}

if (require.main !== module) {
	module.exports = options => new SchlueterThermostat(options);
} else {
	(() => new SchlueterThermostat())();
}
