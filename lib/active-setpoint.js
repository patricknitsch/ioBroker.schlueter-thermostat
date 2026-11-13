'use strict';

// ============================================================================
// Active setpoint: the setpoint of the regulation mode that is in effect, as
// one state (setpoint.active) for the Device Manager card and scripts.
// Filled from the same states the cloud and the local gateway write, so it
// works in every mode.
// ============================================================================

/** Regulation mode -> state (relative to the device) holding its setpoint. */
const SOURCES = {
	2: 'setpoint.comfort',
	3: 'setpoint.manual',
	4: 'vacation.temperature',
	6: 'setpoint.frostProtection',
};

const DEBOUNCE_MS = 200;
const MODE_SCHEDULE = 1;
const DAY_MIN = 1440;
const WEEK_MIN = 7 * DAY_MIN;

/**
 * Setpoint of the weekly schedule at a given moment.
 *
 * Days are numbered like the schedule states: day1 = Monday … day7 = Sunday.
 * Only active events count; an event with "next day" lies after midnight of
 * its day. The setpoint is the one of the last event that has begun; before
 * the first event of the week, the last event of the previous week applies.
 *
 * @param {Array<{day: number, time: string, temperature: number, active: boolean, nextDay: boolean}>} events schedule events
 * @param {Date} localNow Date whose UTC fields hold the thermostat-local time
 * @returns {number|null} setpoint in °C, null without active events
 */
function scheduleSetpoint(events, localNow) {
	const dow = ((localNow.getUTCDay() + 6) % 7) + 1; // Monday = 1
	const now = (dow - 1) * DAY_MIN + localNow.getUTCHours() * 60 + localNow.getUTCMinutes();
	let best = null;
	let last = null;
	for (const e of events) {
		const m = /^(\d{1,2}):(\d{2})/.exec(String(e.time || ''));
		if (!e.active || !m || !Number.isFinite(e.temperature) || e.day < 1 || e.day > 7) {
			continue;
		}
		const pos = ((e.day - 1) * DAY_MIN + Number(m[1]) * 60 + Number(m[2]) + (e.nextDay ? DAY_MIN : 0)) % WEEK_MIN;
		if (pos <= now && (!best || pos > best.pos)) {
			best = { pos, t: e.temperature };
		}
		if (!last || pos > last.pos) {
			last = { pos, t: e.temperature };
		}
	}
	return (best || last)?.t ?? null;
}

/**
 * @param {number} mode regulation mode
 * @returns {string|null} state holding the setpoint of the mode; null: none (schedule is computed, boost, eco, …)
 */
function sourceOf(mode) {
	return SOURCES[mode] || null;
}

/**
 * Keeps setpoint.active up to date. Updates are debounced per device, so a
 * burst of state writes (poll, local report) leads to one read.
 */
class ActiveSetpoint {
	/**
	 * @param {any} adapter adapter (getStateAsync, safeSetState, setTimeout, clearTimeout)
	 */
	constructor(adapter) {
		this.adapter = adapter;
		/** @type {Map<string, any>} */
		this.timers = new Map();
	}

	/**
	 * @param {string} devId device id
	 */
	schedule(devId) {
		const a = this.adapter;
		const pending = this.timers.get(devId);
		if (pending) {
			a.clearTimeout(pending);
		}
		this.timers.set(
			devId,
			a.setTimeout(() => {
				this.timers.delete(devId);
				this.update(devId).catch(() => {});
			}, DEBOUNCE_MS),
		);
	}

	/**
	 * @param {string} devId device id
	 * @returns {Promise<number|null>} the active setpoint written
	 */
	async update(devId) {
		const a = this.adapter;
		const mode = Number((await a.getStateAsync(`${devId}.regulationMode`))?.val);
		const source = sourceOf(mode);
		let val = null;
		if (source) {
			const n = Number((await a.getStateAsync(`${devId}.${source}`))?.val);
			val = Number.isFinite(n) ? n : null;
		} else if (mode === MODE_SCHEDULE) {
			val = scheduleSetpoint(await this._readSchedule(devId), this._localNow(devId));
		}
		a.safeSetState(`${devId}.setpoint.active`, { val, ack: true });
		return val;
	}

	/**
	 * @param {string} devId device id
	 * @returns {Promise<Array<{day: number, time: string, temperature: number, active: boolean, nextDay: boolean}>>} events
	 */
	async _readSchedule(devId) {
		const states = (await this.adapter.getStatesAsync(`${devId}.schedule.*`)) || {};
		/** @type {Record<string, any>} */
		const byEvent = {};
		for (const [id, st] of Object.entries(states)) {
			const m = /\.schedule\.day(\d+)\.event(\d+)\.(time|temperature|active|nextDay)$/.exec(id);
			if (!m || !st) {
				continue;
			}
			const key = `${m[1]}/${m[2]}`;
			byEvent[key] = byEvent[key] || { day: Number(m[1]) };
			byEvent[key][m[3]] = st.val;
		}
		return Object.values(byEvent).map(e => ({
			day: e.day,
			time: String(e.time ?? ''),
			temperature: Number(e.temperature),
			active: e.active === true,
			nextDay: e.nextDay === true,
		}));
	}

	/**
	 * @param {string} devId device id
	 * @returns {Date} Date whose UTC fields hold the thermostat-local time
	 */
	_localNow(devId) {
		const thermostatId = devId.split('.').pop() || '';
		const tz = Number(this.adapter.thermostatTimeZoneSec?.[thermostatId]);
		const offsetSec = Number.isFinite(tz) ? tz : -new Date().getTimezoneOffset() * 60;
		return new Date(Date.now() + offsetSec * 1000);
	}

	stop() {
		for (const t of this.timers.values()) {
			this.adapter.clearTimeout(t);
		}
		this.timers.clear();
	}
}

module.exports = { ActiveSetpoint, sourceOf, scheduleSetpoint };
