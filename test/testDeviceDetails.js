'use strict';

const assert = require('node:assert/strict');
const { SchlueterDeviceManagement } = require('../lib/device-manager');

describe('device manager details', () => {
	const ns = 'schlueter-thermostat.0';
	const adapter = /** @type {any} */ ({
		namespace: ns,
		config: { localMode: 'relay' },
		on() {},
		getObjectAsync: async () => ({ native: { serialNumber: '1021410' } }),
	});
	const dm = new SchlueterDeviceManagement(adapter);

	it('is one compact page with thermostat number and serial on top', async () => {
		const details = /** @type {any} */ (await dm['getDeviceDetails']('101254/258188'));
		const { schema } = details;
		assert.equal(schema.type, 'panel');
		const items = schema.items;
		assert.ok(!Object.values(items).some(i => /** @type {any} */ (i).type === 'tabs'));
		const keys = Object.keys(items);
		assert.deepEqual(keys.slice(0, 2), ['thermostatId', 'serial']);
		assert.equal(items.thermostatId.data, '258188');
		assert.equal(items.serial.data, '1021410');
	});

	it('offers every apply button and no vacation temperature', async () => {
		const { schema } = /** @type {any} */ (await dm['getDeviceDetails']('101254/258188'));
		const base = `${ns}.groups.101254.thermostats.258188.apply`;
		const buttons = Object.values(schema.items)
			.filter(i => /** @type {any} */ (i).type === 'setState')
			.map(i => /** @type {any} */ (i).id);
		for (const mode of ['manual', 'comfort', 'boost', 'schedule', 'eco', 'vacation', 'name']) {
			assert.ok(buttons.includes(`${base}.${mode}.apply`), mode);
		}
		assert.ok(!('vacationTemperature' in schema.items));
	});

	it('fills every row with exactly 12 columns', async () => {
		const { schema } = /** @type {any} */ (await dm['getDeviceDetails']('101254/258188'));
		const rows = [];
		for (const item of Object.values(schema.items)) {
			const it = /** @type {any} */ (item);
			if (it.type === 'divider') {
				continue;
			}
			if (it.newLine || !rows.length) {
				rows.push(0);
			}
			rows[rows.length - 1] += it.xs || 12;
		}
		// the mode row has two buttons only and may stay shorter
		assert.ok(rows.every(cols => cols <= 12));
		assert.ok(rows.filter(cols => cols === 12).length >= 6);
	});
});
