/* eslint-disable jsdoc/require-jsdoc */
'use strict';

const { cToNum } = require('./util');
const { nowPlusMinutesThermostatLocalNoZ } = require('./time');
const SEND_EXTRA_ENDTIME_SEC = 3600; // +1h extra (required by device/backend behavior)

function createApplyRouter(adapter) {
	const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

	const readNum = async (sid, def) => {
		const st = await adapter.getStateAsync(sid);
		const n = Number(st?.val);
		return Number.isFinite(n) ? n : def;
	};

	const handlers = {
		comfort: async ({ devPrefix, serial, baseName, thermostatId }) => {
			let tempC = await readNum(`${devPrefix}.apply.comfort.setpoint`, 22);
			tempC = clamp(tempC, 12, 35);

			let dur = await readNum(`${devPrefix}.apply.comfort.durationMinutes`, 180);
			dur = clamp(Math.trunc(dur), 1, 24 * 60);

			let tzSec = Number(adapter.thermostatTimeZoneSec[thermostatId]);
			if (!Number.isFinite(tzSec)) {
				tzSec = 0;
			}

			// IMPORTANT: add +1h on top (as requested)
			const comfortEnd = nowPlusMinutesThermostatLocalNoZ(dur, tzSec + SEND_EXTRA_ENDTIME_SEC);

			await adapter.client.updateThermostat(serial, {
				ThermostatName: baseName,
				RegulationMode: 2,
				ComfortSetpoint: cToNum(tempC),
				ComfortEndTime: comfortEnd,
			});

			adapter.safeSetState(`${devPrefix}.endTime.comfort`, { val: comfortEnd, ack: true });
		},

		boost: async ({ devPrefix, serial, baseName, thermostatId }) => {
			let dur = await readNum(`${devPrefix}.apply.boost.durationMinutes`, 60);
			dur = clamp(Math.trunc(dur), 1, 24 * 60);

			let tzSec = Number(adapter.thermostatTimeZoneSec[thermostatId]);
			if (!Number.isFinite(tzSec)) {
				tzSec = 0;
			}

			// IMPORTANT: add +1h on top (as requested)
			const boostEnd = nowPlusMinutesThermostatLocalNoZ(dur, tzSec + SEND_EXTRA_ENDTIME_SEC);

			await adapter.client.updateThermostat(serial, {
				ThermostatName: baseName,
				RegulationMode: 8,
				BoostEndTime: boostEnd,
			});

			adapter.safeSetState(`${devPrefix}.endTime.boost`, { val: boostEnd, ack: true });
		},
	};

	return async ctx => handlers[ctx.modeFolder]?.(ctx);
}

module.exports = { createApplyRouter };
