'use strict';

const assert = require('node:assert/strict');
const { ActiveSetpoint, sourceOf } = require('../lib/active-setpoint');

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

	it('writes the setpoint of the current mode, and null for modes without one', async () => {
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
		states[`${DEV}.regulationMode`] = 1;
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
});
