/* eslint-disable jsdoc/require-jsdoc */
'use strict';

const { cToNum } = require('./util');
const { nowPlusMinutesThermostatLocalNoZ } = require('./time');

const EXTRA_ENDTIME_SEC_BOOST = 0;
const EXTRA_ENDTIME_SEC_COMFORT = 0;

function createApplyRouter(adapter) {
	const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

	const readNum = async (sid, def) => {
		const st = await adapter.getStateAsync(sid);
		const n = Number(st?.val);
		return Number.isFinite(n) ? n : def;
	};

	const readStr = async (sid, def = '') => {
		const st = await adapter.getStateAsync(sid);
		return st?.val !== undefined ? String(st.val) : def;
	};

	const readBool = async (sid, def = false) => {
		const st = await adapter.getStateAsync(sid);
		if (typeof st?.val === 'boolean') {
			return st.val;
		}
		if (st?.val === 1 || st?.val === '1') {
			return true;
		}
		if (st?.val === 0 || st?.val === '0') {
			return false;
		}
		return def;
	};

	const handlers = {
		// =================== SCHEDULE ===================
		schedule: async ({ serial, baseName }) => {
			await adapter.client.updateThermostat(serial, {
				ThermostatName: baseName,
				RegulationMode: 1,
			});
		},

		// =================== COMFORT ====================
		comfort: async ({ devPrefix, serial, baseName, thermostatId }) => {
			let tempC = await readNum(`${devPrefix}.apply.comfort.setpoint`, 22);
			tempC = clamp(tempC, 12, 35);

			let dur = await readNum(`${devPrefix}.apply.comfort.durationMinutes`, 180);
			dur = clamp(Math.trunc(dur), 1, 24 * 60);

			let tzSec = Number(adapter.thermostatTimeZoneSec[thermostatId]);
			if (!Number.isFinite(tzSec)) {
				tzSec = 0;
			}

			const comfortEnd = nowPlusMinutesThermostatLocalNoZ(dur, tzSec + EXTRA_ENDTIME_SEC_COMFORT);

			await adapter.client.updateThermostat(serial, {
				ThermostatName: baseName,
				RegulationMode: 2,
				ComfortSetpoint: cToNum(tempC),
				ComfortEndTime: comfortEnd,
			});

			adapter.safeSetState(`${devPrefix}.endTime.comfort`, { val: comfortEnd, ack: true });
		},

		// =================== MANUAL =====================
		manual: async ({ devPrefix, serial, baseName }) => {
			let tempC = await readNum(`${devPrefix}.apply.manual.setpoint`, 21);
			tempC = clamp(tempC, 12, 35);

			await adapter.client.updateThermostat(serial, {
				ThermostatName: baseName,
				RegulationMode: 3,
				ManualModeSetpoint: cToNum(tempC),
			});
		},

		// =================== BOOST ======================
		boost: async ({ devPrefix, serial, baseName, thermostatId }) => {
			let dur = await readNum(`${devPrefix}.apply.boost.durationMinutes`, 60);
			dur = clamp(Math.trunc(dur), 1, 24 * 60);

			let tzSec = Number(adapter.thermostatTimeZoneSec[thermostatId]);
			if (!Number.isFinite(tzSec)) {
				tzSec = 0;
			}

			const boostEnd = nowPlusMinutesThermostatLocalNoZ(dur, tzSec + EXTRA_ENDTIME_SEC_BOOST);

			await adapter.client.updateThermostat(serial, {
				ThermostatName: baseName,
				RegulationMode: 8,
				BoostEndTime: boostEnd,
			});

			adapter.safeSetState(`${devPrefix}.endTime.boost`, { val: boostEnd, ack: true });
		},

		// =================== ECO ========================
		eco: async ({ serial, baseName }) => {
			await adapter.client.updateThermostat(serial, {
				ThermostatName: baseName,
				RegulationMode: 9,
			});
		},

		// =================== VACATION ===================
		vacation: async ({ devPrefix, serial, baseName }) => {
			const enabled = await readBool(`${devPrefix}.apply.vacation.enabled`, false);
			const begin = await readStr(`${devPrefix}.apply.vacation.begin`, '');
			const end = await readStr(`${devPrefix}.apply.vacation.end`, '');

			let tempC = await readNum(`${devPrefix}.apply.vacation.temperature`, 12);
			tempC = clamp(tempC, 5, 35);

			await adapter.client.updateThermostat(serial, {
				ThermostatName: baseName,
				VacationEnabled: enabled,
				VacationBeginDay: begin,
				VacationEndDay: end,
				VacationTemperature: cToNum(tempC),
			});

			adapter.safeSetState(`${devPrefix}.vacation.enabled`, { val: enabled, ack: true });
			adapter.safeSetState(`${devPrefix}.vacation.begin`, { val: begin, ack: true });
			adapter.safeSetState(`${devPrefix}.vacation.end`, { val: end, ack: true });
			adapter.safeSetState(`${devPrefix}.vacation.temperature`, { val: tempC, ack: true });
		},
	};

	return async ctx => {
		const fn = handlers[ctx.modeFolder];
		if (!fn) {
			adapter.log.warn(`Apply ignored: unknown mode "${ctx.modeFolder}" (${ctx.id})`);
			return;
		}
		await fn(ctx);
	};
}

module.exports = { createApplyRouter };
