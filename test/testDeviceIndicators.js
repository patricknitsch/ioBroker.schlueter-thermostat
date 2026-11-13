'use strict';

const assert = require('node:assert/strict');
const { thermostatIndicators, instanceIndicators } = require('../lib/dm-indicators');

const BASE = 'schlueter-thermostat.0.groups.101254.thermostats.258188';

describe('device manager indicators', () => {
	it('read the thermostat states live', () => {
		const list = thermostatIndicators(BASE, { local: true });
		const byId = Object.fromEntries(list.map(i => [i.id, i]));
		const stateOf = id => /** @type {any} */ (byId[id].value).stateId;
		assert.equal(stateOf('connection'), `${BASE}.connection`);
		assert.equal(stateOf('heating'), `${BASE}.heating`);
		assert.equal(stateOf('roomTemperature'), `${BASE}.temperature.room`);
		assert.equal(stateOf('floorTemperature'), `${BASE}.temperature.floor`);
		assert.equal(stateOf('regulationMode'), `${BASE}.regulationMode`);
		assert.equal(stateOf('vacation'), `${BASE}.vacation.enabled`);
		assert.equal(stateOf('energy'), `${BASE}.energy.value0`);
		// "Off" must stay visible
		assert.equal(byId.heating.hideIfEmpty, false);
		// ids are unique
		assert.equal(new Set(list.map(i => i.id)).size, list.length);
	});

	it('names every regulation mode and ends with a catch-all level', () => {
		const mode = thermostatIndicators(BASE, { local: false }).find(i => i.id === 'regulationMode');
		const levels = mode?.levels || [];
		const text = v => /** @type {any} */ (levels.find(l => l.value === v)?.text)?.de;
		assert.equal(text(1), 'Zeitplan');
		assert.equal(text(4), 'Urlaub');
		assert.equal(text(8), 'Boost');
		assert.equal(text(9), 'Eco');
		assert.equal(levels[levels.length - 1].value, undefined);
	});

	it('shows the gateway indicators in the toolbar only with local control', () => {
		// the card always shows cloud / relay / local
		assert.ok(thermostatIndicators(BASE, { local: false }).some(i => i.id === 'connection'));
		assert.deepEqual(
			instanceIndicators('schlueter-thermostat.0', { local: false }).map(i => i.id),
			['cloud'],
		);
		assert.deepEqual(
			instanceIndicators('schlueter-thermostat.0', { local: true }).map(i => i.id),
			['cloud', 'localGateway', 'vendorGateway'],
		);
	});

	it('uses valid SVG data URIs as icons', () => {
		for (const ind of [
			...thermostatIndicators(BASE, { local: true }),
			...instanceIndicators('x', { local: true }),
		]) {
			const icons = [ind.icon, ind.iconOn, ...(ind.levels || []).map(l => l.icon)].filter(Boolean);
			for (const uri of icons) {
				assert.match(String(uri), /^data:image\/svg\+xml;base64,/);
				const svg = Buffer.from(String(uri).split(',')[1], 'base64').toString();
				assert.match(svg, /^<svg [^>]*><path fill="#[0-9a-f]{6}" d="[^"]+"\/><\/svg>$/);
			}
		}
	});

	it('shows the energy source that fits the local mode', () => {
		const ids = mode => thermostatIndicators(BASE, { local: mode !== 'off', mode });
		const stateOf = (list, id) => /** @type {any} */ (list.find(i => i.id === id)?.value)?.stateId;

		const cloud = ids('off');
		assert.equal(stateOf(cloud, 'energy'), `${BASE}.energy.value0`);
		assert.ok(!cloud.some(i => i.id === 'energyEstimated'));

		const relay = ids('relay');
		assert.equal(stateOf(relay, 'energy'), `${BASE}.energy.value0`);
		assert.equal(relay.find(i => i.id === 'energyEstimated')?.defaultVisible, false);

		// local only: the cloud gets no data, its energy stands still
		const local = ids('local');
		assert.ok(!local.some(i => i.id === 'energy'));
		assert.equal(stateOf(local, 'energyEstimated'), `${BASE}.energy.estimatedToday`);
		assert.notEqual(local.find(i => i.id === 'energyEstimated')?.defaultVisible, false);
	});
});

describe('device manager indicators: setpoint', () => {
	it('shows the active setpoint', () => {
		const { thermostatIndicators } = require('../lib/dm-indicators');
		const base = 'schlueter-thermostat.0.groups.1.thermostats.2';
		const sp = thermostatIndicators(base, { local: false }).find(i => i.id === 'setpoint');
		assert.equal(/** @type {any} */ (sp?.value).stateId, `${base}.setpoint.active`);
		assert.equal(sp?.showValue, true);
	});
});
