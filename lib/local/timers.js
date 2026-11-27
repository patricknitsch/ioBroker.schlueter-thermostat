'use strict';

// ============================================================================
// Timers of the local gateway
//
// With the adapter as host its timers are used: ioBroker clears them on
// unload and tracks timers left running. Without a host (tests, use outside
// ioBroker) Node's own timers are used. While the adapter shuts down it
// refuses new timers (returns nothing); Node's timer takes over then, so
// stop() keeps its time limit.
// ============================================================================

/**
 * @typedef {object} Timers
 * @property {(fn: () => void, ms: number) => any} setTimeout start a timeout
 * @property {(handle: any) => void} clearTimeout stop a timeout
 * @property {(fn: () => void, ms: number) => any} setInterval start an interval
 * @property {(handle: any) => void} clearInterval stop an interval
 */

/** @type {Timers} */
const NODE_TIMERS = {
	setTimeout: globalThis.setTimeout.bind(globalThis),
	clearTimeout: globalThis.clearTimeout.bind(globalThis),
	setInterval: globalThis.setInterval.bind(globalThis),
	clearInterval: globalThis.clearInterval.bind(globalThis),
};

/**
 * @param {any} [host] object with setTimeout / clearTimeout / setInterval / clearInterval (the adapter)
 * @returns {Timers} timers of the host, Node's where the host has none or refuses one
 */
function createTimers(host) {
	if (!host || typeof host.setTimeout !== 'function' || typeof host.setInterval !== 'function') {
		return NODE_TIMERS;
	}
	return {
		setTimeout: (fn, ms) => host.setTimeout(fn, ms) ?? NODE_TIMERS.setTimeout(fn, ms),
		setInterval: (fn, ms) => host.setInterval(fn, ms) ?? NODE_TIMERS.setInterval(fn, ms),
		clearTimeout: handle => {
			if (handle !== undefined && handle !== null) {
				host.clearTimeout(handle);
				// a handle of the fallback is not known to the host
				NODE_TIMERS.clearTimeout(handle);
			}
		},
		clearInterval: handle => {
			if (handle !== undefined && handle !== null) {
				host.clearInterval(handle);
				NODE_TIMERS.clearInterval(handle);
			}
		},
	};
}

module.exports = { createTimers, NODE_TIMERS };
