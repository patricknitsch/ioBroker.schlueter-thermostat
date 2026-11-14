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

	it('lays out every row within 12 columns on desktop and phone', async () => {
		const { schema } = /** @type {any} */ (await dm['getDeviceDetails']('101254/258188'));
		const items = Object.values(schema.items).map(i => /** @type {any} */ (i));
		for (const bp of ['sm', 'xs']) {
			for (const it of items) {
				assert.ok(it[bp] >= 1 && it[bp] <= 12, `${bp} width of ${it.type}`);
			}
		}
		// desktop: label left, row content beside it, no row wider than 12
		const rows = [];
		for (const it of items) {
			if (it.newLine || !rows.length) {
				rows.push(0);
			}
			rows[rows.length - 1] += it.sm;
		}
		assert.ok(
			rows.every(cols => cols <= 12),
			JSON.stringify(rows),
		);
		// phone: every label takes the full width (fields below it)
		assert.ok(items.filter(it => it.type === 'staticText').every(it => it.xs === 12));
		// no divider bar
		assert.ok(!items.some(it => it.type === 'divider'));
	});
});
