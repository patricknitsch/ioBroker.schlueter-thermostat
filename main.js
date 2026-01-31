'use strict';

// ============================================================================
// schlueter-thermostat
// Cloud-only adapter for OJ Microline / Schlüter OWD5/OCD5
//
// Structure:
// groups.<GroupId>              (device, name = GroupName)
//   .thermostats                (channel)
//     .<ThermostatId>           (device, name = ThermostatName)
//        .temperature.*         (read-only)
//        .setpoint.*            (read-only)
//        .regulationMode        (read-only)
//        .endTime.*             (read-only; shown as thermostat-local no-Z)
//        .vacation.*            (read-only)
//        .schedule.*            (read-only)
//        .energy.*              (read-only)
//        .apply.*               (writeable controls; apply-only)
//
// Robustness:
// - Poll interval min 10s, clamp to Node max timer
// - If poll fails, info.connection = false
// - Warn once when thermostat turns offline
// - Block ALL writes unless thermostat is online
// - Apply-only concept: only pressing apply.*.apply sends data
// - Time handling:
//   - Incoming EndTimes from cloud -> displayed as thermostat-local no-Z using TimeZone (sec)
//   - Outgoing EndTimes for comfort/boost -> sent as thermostat-local no-Z using TimeZone (sec)
// ============================================================================

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

		/** ThermostatId -> SerialNumber */
		this.thermostatSerial = {};
		/** ThermostatId -> GroupId */
		this.thermostatGroup = {};
		/** ThermostatId -> ThermostatName */
		this.thermostatNameCache = {};
		/** ThermostatId -> TimeZone seconds (e.g. 3600 / 7200) */
		this.thermostatTimeZoneSec = {};

		/** GroupId -> GroupName */
		this.groupNameCache = {};

		/** ThermostatId -> last known online */
		this.lastOnline = {};
		/** ThermostatId -> did we already warn for current offline phase? */
		this.warnedOffline = {};
		/** CloudOffline */
		this.pollFailCount = 0;
		this.POLL_FAIL_THRESHOLD = 3;
		this.warnedNoCloud = false;
		/** devId -> legacy deleted */
		this.legacyStatesDeleted = {};

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

	_isCommError(err) {
		const msg = String(err?.message || err).toLowerCase();

		// typische Netzwerk-/Transportfehler
		if (
			msg.includes('econnrefused') ||
			msg.includes('econnreset') ||
			msg.includes('etimedout') ||
			msg.includes('timeout') ||
			msg.includes('enotfound') ||
			msg.includes('eai_again') ||
			msg.includes('socket hang up') ||
			msg.includes('network') ||
			msg.includes('getaddrinfo') ||
			msg.includes('connection') ||
			msg.includes('unable to connect')
		) {
			return true;
		}

		// falls deine OJClient Errors Statuscodes tragen
		const status = err?.statusCode ?? err?.status ?? err?.response?.status;
		if (Number.isFinite(status)) {
			// 5xx = Server unreachable-ish, 401/403 = auth broken (auch "connection" im Sinne von nicht nutzbar)
			if (status >= 500) {
				return true;
			}
			if (status === 401 || status === 403) {
				return true;
			}
		}

		return false;
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

	async deleteOldWritableStates(devId) {
		if (this.legacyStatesDeleted[devId]) {
			return;
		}
		this.legacyStatesDeleted[devId] = true;

		// Old direct-write states that should not exist anymore
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
	// Small helpers
	// ============================================================================

	_getTzSecFromThermostat(thermostatId, t) {
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
		// Prefer cache from poll (exact ThermostatId key, not safeId)
		if (typeof this.lastOnline[thermostatId] === 'boolean') {
			return this.lastOnline[thermostatId];
		}

		// Fallback: read state once
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
		this.log.info('onReady(): starting adapter');
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

		// Cleanup legacy object tree from old versions (optional via config)
		if (this.config.legacyCleanup === true) {
			await this.legacyCleanup();
		} else {
			this.log.debug('legacyCleanup(): disabled by config');
		}

		// Poll interval: min 10 seconds; clamp to Node max delay
		const MAX_TIMER_MS = 2147483647;
		const intervalSecRaw = Number(this.config.pollIntervalSec);
		const intervalSec = Number.isFinite(intervalSecRaw) ? intervalSecRaw : 60;
		const intervalMs = Math.min(MAX_TIMER_MS, Math.max(10_000, Math.trunc(intervalSec * 1000)));

		await this.pollOnce();

		// Subscribe ONLY apply buttons
		this.subscribeStates('groups.*.thermostats.*.apply.*.apply');

		this.pollTimer = this.setInterval(() => {
			this.pollOnce().catch(err => this.log.warn(`Poll error: ${err?.message || err}`));
		}, intervalMs);
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
			const data = await client.getGroupContents();
			const groups = Array.isArray(data?.GroupContents) ? data.GroupContents : [];

			// success: mark connected + reset fail counters
			this.safeSetState('info.connection', true, true);
			this.pollFailCount = 0;
			this.warnedNoCloud = false;

			for (const group of groups) {
				if (this.unloading) {
					break;
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
				if (this.unloading) {
					return;
				}

				const comm = this._isCommError(err);

				if (comm) {
					this.pollFailCount += 1;

					if (this.pollFailCount >= this.POLL_FAIL_THRESHOLD) {
						this.safeSetState('info.connection', false, true);

						if (!this.warnedNoCloud) {
							this.log.warn(
								`Cloud communication failed ${this.pollFailCount}x. Adapter set info.connection=false. Last error: ${err?.message || err}`,
							);
							this.warnedNoCloud = true;
						} else {
							this.log.debug(
								`Cloud communication still failing (${this.pollFailCount}x): ${err?.message || err}`,
							);
						}
					} else {
						this.log.warn(
							`Cloud poll failed (${this.pollFailCount}/${this.POLL_FAIL_THRESHOLD}): ${err?.message || err}`,
						);
					}
				} else {
					this.log.warn(`Poll error (non-comm): ${err?.message || err}`);
				}
			})
			.finally(() => {
				this.pollInFlight = false;
			});

		return this.pollPromise;
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

		const devId = `groups.${safeId(groupId)}.thermostats.${safeId(thermostatId)}`;

		// Cache mappings
		const serial = t?.SerialNumber ? String(t.SerialNumber) : '';
		if (serial) {
			this.thermostatSerial[thermostatId] = serial;
		}
		this.thermostatGroup[thermostatId] = groupId;

		const thermostatName = String(t?.ThermostatName || `Thermostat ${thermostatId}`);
		this.thermostatNameCache[thermostatId] = thermostatName;

		// TimeZone seconds (finite!)
		const tzSec = this._getTzSecFromThermostat(thermostatId, t);
		this.thermostatTimeZoneSec[thermostatId] = tzSec;

		// Ensure objects
		await ensureThermostatObjects(this, devId, { groupId, thermostatId, serialNumber: serial }, thermostatName);
		await ensureApplyObjects(this, devId);

		// Delete legacy direct-write states once
		await this.deleteOldWritableStates(devId);

		// Online transition warning (once)
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

		// Incoming EndTimes shown as thermostat-local no-Z
		const comfortEndLocal = toThermostatLocalNoZFromAny(t?.ComfortEndTime || '', tzSec);
		const boostEndLocal = toThermostatLocalNoZFromAny(t?.BoostEndTime || '', tzSec);

		// Write read-only states
		await writeThermostatStates(this, devId, t, { comfortEndLocal, boostEndLocal });

		// Non-destructive prefill of apply.*
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
	// ON STATE CHANGE (apply-only writes)
	// ============================================================================

	async onStateChange(id, state) {
		this.log.debug(`onStateChange(): id=${id} val=${state?.val}`);

		// ignore acked changes
		if (!state || state.ack) {
			return;
		}

		// only apply buttons
		if (!id.endsWith('.apply')) {
			return;
		}

		const client = this.client;
		if (!client) {
			return;
		}

		try {
			const conn = await this.getStateAsync('info.connection');
			if (!conn || conn.val !== true) {
				if (!this.warnedNoCloud) {
					this.log.warn(`Write blocked: no cloud connection (info.connection=false) id=${id}`);
					this.warnedNoCloud = true;
				}
				this.safeSetState(id, { val: false, ack: true });
				return;
			}
		} catch {
			// If we cannot read info.connection, be safe and block
			this.log.warn(`Write blocked: unable to read info.connection id=${id}`);
			this.safeSetState(id, { val: false, ack: true });
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
		const modeFolder = parts[idxApply + 1];

		// block writes if thermostat offline
		const online = await this._isThermostatOnline(groupId, thermostatId);
		if (!online) {
			this.log.warn(`Write blocked: thermostat offline (ThermostatId=${thermostatId}) id=${id}`);
			this.safeSetState(id, { val: false, ack: true });
			return;
		}

		// SerialNumber for writes (cache -> object fallback)
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

		try {
			await this.applyRouter({
				modeFolder,
				id,
				devPrefix,
				serial,
				thermostatId, // IMPORTANT for TZ-based EndTime send
				baseName,
			});
		} catch (e) {
			const comm = this._isCommError(e);
			this.log.error(`Apply failed for ${id}: ${e?.message || e}`);

			if (comm) {
				// on communication error, set connection false
				this.safeSetState('info.connection', false, true);
				this.warnedNoCloud = false;
			}
		} finally {
			this.safeSetState(id, { val: false, ack: true });
		}
	}

	// ============================================================================
	// ON UNLOAD
	// ============================================================================

	async onUnload(callback) {
		try {
			this.log.info('onUnload(): stopping adapter');
			this.unloading = true;

			if (this.pollTimer) {
				this.clearInterval(this.pollTimer);
			}

			// Wait for in-flight poll (best effort)
			const p = this.pollPromise;
			if (p) {
				// Use native setTimeout here to avoid:
				// "setTimeout called, but adapter is shutting down"
				await Promise.race([p, new Promise(resolve => setTimeout(resolve, 5000))]);
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
