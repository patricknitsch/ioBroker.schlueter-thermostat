'use strict';

const assert = require('node:assert/strict');
const { ActiveSetpoint, sourceOf, scheduleSetpoint } = require('../lib/active-setpoint');

const DEV = 'groups.1.thermostats.2';

/**
 * @param {Record<string, any>} states state values by id
 * @returns {any} fake adapter
 */
function fakeAdapter(states) {
	const written = {};
	return {
		written,
		getStateAsync: async id => (id in states ? { val: states[id] } : null),
		safeSetState: (id, st) => (written[id] = st.val),
		setTimeout: (fn, ms) => setTimeout(fn, ms),
		clearTimeout: t => clearTimeout(t),
	};
}

describe('active setpoint', () => {
	it('maps the regulation modes to their setpoint', () => {
		assert.equal(sourceOf(2), 'setpoint.comfort');
		assert.equal(sourceOf(3), 'setpoint.manual');
		assert.equal(sourceOf(4), 'vacation.temperature');
		assert.equal(sourceOf(6), 'setpoint.frostProtection');
		for (const mode of [1, 8, 9, 0]) {
			assert.equal(sourceOf(mode), null);
		}
	});

	it('writes the setpoint of the current mode (state or fixed), null for unknown modes', async () => {
		const states = {
			[`${DEV}.regulationMode`]: 3,
			[`${DEV}.setpoint.manual`]: 25,
			[`${DEV}.setpoint.comfort`]: 23,
			[`${DEV}.setpoint.frostProtection`]: 5,
			[`${DEV}.vacation.temperature`]: 5,
		};
		const a = fakeAdapter(states);
		const s = new ActiveSetpoint(a);
		assert.equal(await s.update(DEV), 25);
		states[`${DEV}.regulationMode`] = 2;
		assert.equal(await s.update(DEV), 23);
		states[`${DEV}.regulationMode`] = 6;
		assert.equal(await s.update(DEV), 5);
		states[`${DEV}.regulationMode`] = 8; // boost: fixed 35 °C
		assert.equal(await s.update(DEV), 35);
		states[`${DEV}.regulationMode`] = 9; // eco: fixed 20 °C
		assert.equal(await s.update(DEV), 20);
		states[`${DEV}.regulationMode`] = 7; // unknown mode
		assert.equal(await s.update(DEV), null);
		assert.equal(a.written[`${DEV}.setpoint.active`], null);
	});

	it('debounces a burst of updates into one', async () => {
		const states = { [`${DEV}.regulationMode`]: 3, [`${DEV}.setpoint.manual`]: 21 };
		const a = fakeAdapter(states);
		let reads = 0;
		const get = a.getStateAsync;
		a.getStateAsync = async id => {
			reads++;
			return get(id);
		};
		const s = new ActiveSetpoint(a);
		s.schedule(DEV);
		s.schedule(DEV);
		s.schedule(DEV);
		await new Promise(r => setTimeout(r, 300));
		assert.equal(reads, 2); // regulationMode + setpoint.manual, once
		assert.equal(a.written[`${DEV}.setpoint.active`], 21);
		s.stop();
	});

	// The real schedule of the OWD5 used for testing: all 7 days alike,
	// only 05:00 (23 °C) and 23:00 (20 °C) active.
	const week = [];
	for (let day = 1; day <= 7; day++) {
		week.push(
			{ day, time: '05:00:00', temperature: 23, active: true, nextDay: false },
			{ day, time: '09:00:00', temperature: 20, active: false, nextDay: false },
			{ day, time: '12:00:00', temperature: 25, active: false, nextDay: false },
			{ day, time: '23:00:00', temperature: 20, active: true, nextDay: false },
		);
	}
	// 13.11.2026 is a Friday (day5)
	const at = (d, h, m) => new Date(Date.UTC(2026, 10, d, h, m));

	it('follows the active schedule events (inactive ones are ignored)', () => {
		assert.equal(scheduleSetpoint(week, at(13, 14, 40)), 23);
		assert.equal(scheduleSetpoint(week, at(13, 23, 30)), 20);
		assert.equal(scheduleSetpoint(week, at(13, 4, 59)), 20); // still the 23:00 of Thursday
		assert.equal(scheduleSetpoint(week, at(13, 5, 0)), 23);
	});

	it('numbers the days Monday = 1 and wraps over the week', () => {
		const onlyMonday = [{ day: 1, time: '06:00:00', temperature: 21, active: true, nextDay: false }];
		// Monday 16.11.2026 07:00 and Sunday 15.11.2026 (before Monday 06:00 of the next week)
		assert.equal(scheduleSetpoint(onlyMonday, at(16, 7, 0)), 21);
		assert.equal(scheduleSetpoint(onlyMonday, at(15, 12, 0)), 21);
		const mondaySunday = [
			{ day: 1, time: '06:00:00', temperature: 21, active: true, nextDay: false },
			{ day: 7, time: '10:00:00', temperature: 18, active: true, nextDay: false },
		];
		assert.equal(scheduleSetpoint(mondaySunday, at(15, 12, 0)), 18); // Sunday
		assert.equal(scheduleSetpoint(mondaySunday, at(16, 5, 0)), 18); // Monday before 06:00
	});

	it('puts next-day events after midnight', () => {
		const late = [
			{ day: 5, time: '18:00:00', temperature: 22, active: true, nextDay: false },
			{ day: 5, time: '01:00:00', temperature: 17, active: true, nextDay: true }, // Saturday 01:00
		];
		assert.equal(scheduleSetpoint(late, at(13, 23, 0)), 22);
		assert.equal(scheduleSetpoint(late, at(14, 2, 0)), 17);
	});

	it('returns null without active events', () => {
		assert.equal(
			scheduleSetpoint(
				[{ day: 1, time: '06:00:00', temperature: 21, active: false, nextDay: false }],
				at(13, 12, 0),
			),
			null,
		);
	});

	it('reads the schedule states in schedule mode', async () => {
		const states = { [`${DEV}.regulationMode`]: 1 };
		const a = fakeAdapter(states);
		a.thermostatTimeZoneSec = { 2: 3600 };
		a.getStatesAsync = async () => {
			const out = {};
			for (const e of week) {
				const i = ['05:00:00', '09:00:00', '12:00:00', '23:00:00'].indexOf(e.time);
				const p = `schlueter-thermostat.0.${DEV}.schedule.day${e.day}.event${i}`;
				out[`${p}.time`] = { val: e.time };
				out[`${p}.temperature`] = { val: e.temperature };
				out[`${p}.active`] = { val: e.active };
				out[`${p}.nextDay`] = { val: e.nextDay };
			}
			return out;
		};
		const val = await new ActiveSetpoint(a).update(DEV);
		assert.ok(val === 23 || val === 20);
	});
});
