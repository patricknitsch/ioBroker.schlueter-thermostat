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

/**
 * @param {number} mode regulation mode
 * @returns {string|null} state holding the setpoint of the mode; null: no setpoint (schedule, boost, eco, …)
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
		}
		a.safeSetState(`${devId}.setpoint.active`, { val, ack: true });
		return val;
	}

	stop() {
		for (const t of this.timers.values()) {
			this.adapter.clearTimeout(t);
		}
		this.timers.clear();
	}
}

module.exports = { ActiveSetpoint, sourceOf };
