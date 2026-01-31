/* eslint-disable jsdoc/require-jsdoc */
'use strict';

const { cToNum } = require('./util'); // ok, kein Zyklus
const { nowPlusMinutesUtcNoZ } = require('./time');

function createApplyRouter(adapter) {
	const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

	const readNum = async (sid, def) => {
		const st = await adapter.getStateAsync(sid);
		const n = Number(st?.val);
		return Number.isFinite(n) ? n : def;
	};

	const readStr = async (sid, def = '') => {
		const st = await adapter.getStateAsync(sid);
		const v = st?.val;
		return v === null || v === undefined ? def : String(v);
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
		schedule: async ({ serial, baseName }) => {
			await adapter.client.updateThermostat(serial, { ThermostatName: baseName, RegulationMode: 1 });
		},

		comfort: async ({ devPrefix, serial, baseName }) => {
			let tempC = await readNum(`${devPrefix}.apply.comfort.setpoint`, 22);
			tempC = clamp(tempC, 12, 35);

			let dur = await readNum(`${devPrefix}.apply.comfort.durationMinutes`, 180);
			dur = clamp(Math.trunc(dur), 1, 24 * 60);

			const comfortEnd = nowPlusMinutesUtcNoZ(dur);

			await adapter.client.updateThermostat(serial, {
				ThermostatName: baseName,
				RegulationMode: 2,
				ComfortSetpoint: cToNum(tempC),
				ComfortEndTime: comfortEnd,
			});

			adapter.safeSetState(`${devPrefix}.endTime.comfort`, { val: comfortEnd, ack: true });
		},

		manual: async ({ devPrefix, serial, baseName }) => {
			let tempC = await readNum(`${devPrefix}.apply.manual.setpoint`, 21);
			tempC = clamp(tempC, 12, 35);

			await adapter.client.updateThermostat(serial, {
				ThermostatName: baseName,
				RegulationMode: 3,
				ManualModeSetpoint: cToNum(tempC),
			});
		},

		boost: async ({ devPrefix, serial, baseName }) => {
			let dur = await readNum(`${devPrefix}.apply.boost.durationMinutes`, 60);
			dur = clamp(Math.trunc(dur), 1, 24 * 60);

			const boostEnd = nowPlusMinutesUtcNoZ(dur);

			await adapter.client.updateThermostat(serial, {
				ThermostatName: baseName,
				RegulationMode: 8,
				BoostEndTime: boostEnd,
			});

			adapter.safeSetState(`${devPrefix}.endTime.boost`, { val: boostEnd, ack: true });
		},

		eco: async ({ serial, baseName }) => {
			await adapter.client.updateThermostat(serial, { ThermostatName: baseName, RegulationMode: 9 });
		},

		name: async ({ devPrefix, serial, thermostatId, baseName }) => {
			const newNameRaw = await readStr(`${devPrefix}.apply.name.value`, baseName);
			const newName = newNameRaw.trim();
			if (!newName) {
				adapter.log.warn(`Apply ignored: empty thermostat name (${devPrefix})`);
				return;
			}

			await adapter.client.updateThermostat(serial, { ThermostatName: newName });

			adapter.thermostatNameCache[thermostatId] = newName;
			adapter.safeSetState(`${devPrefix}.thermostatName`, { val: newName, ack: true });
			adapter.safeSetState(`${devPrefix}.apply.name.value`, { val: newName, ack: true });
		},

		vacation: async ({ devPrefix, serial, thermostatId, baseName }) => {
			const enabled = await readBool(`${devPrefix}.apply.vacation.enabled`, false);
			const begin = (await readStr(`${devPrefix}.apply.vacation.begin`, '')).trim();
			const end = (await readStr(`${devPrefix}.apply.vacation.end`, '')).trim();

			let tempC = await readNum(`${devPrefix}.apply.vacation.temperature`, 12);
			tempC = clamp(tempC, 5, 35);

			const isDay = s => /^\d{4}-\d{2}-\d{2}$/.test(s);
			if (begin && !isDay(begin)) {
				adapter.log.warn(`Vacation begin not YYYY-MM-DD: "${begin}"`);
			}
			if (end && !isDay(end)) {
				adapter.log.warn(`Vacation end not YYYY-MM-DD: "${end}"`);
			}

			await adapter.client.updateThermostat(serial, {
				ThermostatName: baseName,
				VacationEnabled: enabled,
				...(begin ? { VacationBeginDay: begin } : {}),
				...(end ? { VacationEndDay: end } : {}),
				VacationTemperature: cToNum(tempC),
			});

			adapter.safeSetState(`${devPrefix}.vacation.enabled`, { val: enabled, ack: true });
			if (begin) {
				adapter.safeSetState(`${devPrefix}.vacation.begin`, { val: begin, ack: true });
			}
			if (end) {
				adapter.safeSetState(`${devPrefix}.vacation.end`, { val: end, ack: true });
			}
			adapter.safeSetState(`${devPrefix}.vacation.temperature`, { val: tempC, ack: true });

			adapter.thermostatVacationEnabled[thermostatId] = enabled;
			adapter.thermostatVacationBegin[thermostatId] = begin;
			adapter.thermostatVacationEnd[thermostatId] = end;
			adapter.thermostatVacationTemp[thermostatId] = cToNum(tempC);
		},
	};

	return async ctx => {
		const fn = handlers[ctx.modeFolder];
		if (!fn) {
			adapter.log.debug(`Apply ignored: unknown mode folder "${ctx.modeFolder}" (${ctx.id})`);
			return;
		}
		await fn(ctx);
	};
}

module.exports = { createApplyRouter };
