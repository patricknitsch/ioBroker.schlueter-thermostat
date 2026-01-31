/* eslint-disable jsdoc/require-jsdoc */
'use strict';

const { numToC } = require('./util');

async function writeThermostatStates(adapter, devId, t, { comfortEndLocal, boostEndLocal }) {
	adapter.safeSetState(`${devId}.online`, { val: Boolean(t?.Online), ack: true });
	adapter.safeSetState(`${devId}.heating`, { val: Boolean(t?.Heating), ack: true });
	adapter.safeSetState(`${devId}.thermostatName`, { val: String(t?.ThermostatName || ''), ack: true });

	const rt = numToC(t?.RoomTemperature);
	const ft = numToC(t?.FloorTemperature);
	if (rt !== null) {
		adapter.safeSetState(`${devId}.temperature.room`, { val: rt, ack: true });
	}
	if (ft !== null) {
		adapter.safeSetState(`${devId}.temperature.floor`, { val: ft, ack: true });
	}

	const ms = numToC(t?.ManualModeSetpoint);
	const cs = numToC(t?.ComfortSetpoint);
	if (ms !== null) {
		adapter.safeSetState(`${devId}.setpoint.manual`, { val: ms, ack: true });
	}
	if (cs !== null) {
		adapter.safeSetState(`${devId}.setpoint.comfort`, { val: cs, ack: true });
	}

	adapter.safeSetState(`${devId}.regulationMode`, { val: Number(t?.RegulationMode ?? 0), ack: true });

	if (comfortEndLocal) {
		adapter.safeSetState(`${devId}.endTime.comfort`, { val: comfortEndLocal, ack: true });
	}
	if (boostEndLocal) {
		adapter.safeSetState(`${devId}.endTime.boost`, { val: boostEndLocal, ack: true });
	}

	const vEnabled = Boolean(t?.VacationEnabled);
	const vBegin = String(t?.VacationBeginDay || '');
	const vEnd = String(t?.VacationEndDay || '');
	adapter.safeSetState(`${devId}.vacation.enabled`, { val: vEnabled, ack: true });
	if (vBegin) {
		adapter.safeSetState(`${devId}.vacation.begin`, { val: vBegin, ack: true });
	}
	if (vEnd) {
		adapter.safeSetState(`${devId}.vacation.end`, { val: vEnd, ack: true });
	}

	const vTempC = numToC(t?.VacationTemperature);
	if (vTempC !== null) {
		adapter.safeSetState(`${devId}.vacation.temperature`, { val: vTempC, ack: true });
	}
}

// Prefill apply.* without overwriting user edits
async function prefillApplyNonDestructive(adapter, devId, t) {
	await setIfEmpty(adapter, `${devId}.apply.name.value`, String(t?.ThermostatName || ''));

	await setIfEmpty(adapter, `${devId}.apply.vacation.enabled`, Boolean(t?.VacationEnabled));
	await setIfEmpty(adapter, `${devId}.apply.vacation.begin`, String(t?.VacationBeginDay || ''));
	await setIfEmpty(adapter, `${devId}.apply.vacation.end`, String(t?.VacationEndDay || ''));

	const vTempC = numToC(t?.VacationTemperature);
	if (vTempC !== null) {
		await setIfEmpty(adapter, `${devId}.apply.vacation.temperature`, vTempC);
	}
}

async function setIfEmpty(adapter, id, value) {
	try {
		const st = await adapter.getStateAsync(id);
		if (!st || st.val === null || st.val === undefined || st.val === '') {
			adapter.safeSetState(id, { val: value, ack: true });
			return;
		}
		if (typeof st.val === 'number' && Number.isNaN(st.val)) {
			adapter.safeSetState(id, { val: value, ack: true });
		}
	} catch {
		// ignore
	}
}

async function writeScheduleStates(adapter, devId, schedule) {
	const ensureState = async (id, common) => {
		await adapter.safeSetObjectNotExists(id, { type: 'state', common, native: {} });
	};

	if (!schedule || !Array.isArray(schedule.Days)) {
		return;
	}

	for (const day of schedule.Days) {
		const wd = String(day.WeekDayGrpNo ?? '');
		if (!wd) {
			continue;
		}

		const dayCh = `${devId}.schedule.day${wd}`;
		await adapter.safeSetObjectNotExists(dayCh, { type: 'channel', common: { name: `Day ${wd}` }, native: {} });

		const events = Array.isArray(day.Events) ? day.Events : [];
		for (let i = 0; i < events.length; i++) {
			const ev = events[i];
			const evCh = `${dayCh}.event${i}`;
			await adapter.safeSetObjectNotExists(evCh, { type: 'channel', common: { name: `Event ${i}` }, native: {} });

			await ensureState(`${evCh}.type`, {
				name: 'ScheduleType',
				type: 'number',
				role: 'value',
				read: true,
				write: false,
			});
			await ensureState(`${evCh}.time`, {
				name: 'Clock',
				type: 'string',
				role: 'text',
				read: true,
				write: false,
			});
			await ensureState(`${evCh}.temperature`, {
				name: 'Temperature',
				type: 'number',
				role: 'value.temperature',
				unit: '°C',
				read: true,
				write: false,
			});
			await ensureState(`${evCh}.active`, {
				name: 'Active',
				type: 'boolean',
				role: 'indicator',
				read: true,
				write: false,
			});
			await ensureState(`${evCh}.nextDay`, {
				name: 'EventIsOnNextDay',
				type: 'boolean',
				role: 'indicator',
				read: true,
				write: false,
			});

			adapter.safeSetState(`${evCh}.type`, { val: Number(ev.ScheduleType ?? 0), ack: true });
			adapter.safeSetState(`${evCh}.time`, { val: String(ev.Clock ?? ''), ack: true });

			const temp = numToC(ev.Temperature);
			if (temp !== null) {
				adapter.safeSetState(`${evCh}.temperature`, { val: temp, ack: true });
			}

			adapter.safeSetState(`${evCh}.active`, { val: Boolean(ev.Active), ack: true });
			adapter.safeSetState(`${evCh}.nextDay`, { val: Boolean(ev.EventIsOnNextDay), ack: true });
		}
	}
}

async function writeEnergyStates(adapter, devId, serial, { history, viewType }) {
	try {
		const ensureState = async (id, common) => {
			await adapter.safeSetObjectNotExists(id, { type: 'state', common, native: {} });
		};

		adapter.log.debug(`Energy: requesting usage for SerialNumber=${serial}`);
		const energy = await adapter.client.getEnergyUsage(serial, { history, viewType });

		const usage = energy?.EnergyUsage?.[0]?.Usage || [];

		await ensureState(`${devId}.energy.count`, {
			name: 'Values count',
			type: 'number',
			role: 'value',
			read: true,
			write: false,
		});
		adapter.safeSetState(`${devId}.energy.count`, { val: usage.length, ack: true });

		for (let i = 0; i < usage.length; i++) {
			const sid = `${devId}.energy.value${i}`;
			await ensureState(sid, {
				name: `Energy Day -${i}`,
				type: 'number',
				role: 'value.energy',
				unit: 'kWh',
				read: true,
				write: false,
			});

			const v = Number(usage[i]?.EnergyKWattHour);
			if (Number.isFinite(v)) {
				adapter.safeSetState(sid, { val: v, ack: true });
			}
		}
	} catch (e) {
		adapter.log.debug(`Energy not available for SerialNumber=${serial}: ${e?.message || e}`);
	}
}

module.exports = {
	writeThermostatStates,
	prefillApplyNonDestructive,
	writeScheduleStates,
	writeEnergyStates,
};
