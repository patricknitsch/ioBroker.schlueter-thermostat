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

	describe('weekly schedule page', () => {
		/**
		 * @param {Record<string, any>} states states by id relative to the namespace
		 * @returns {{dm: any, written: Record<string, any>, applied: any[], messages: any[]}} device manager with a fake adapter
		 */
		const setup = states => {
			/** @type {Record<string, any>} */
			const written = {};
			/** @type {any[]} */
			const applied = [];
			const fake = /** @type {any} */ ({
				namespace: ns,
				config: { localMode: 'relay' },
				on() {},
				getObjectAsync: async () => ({ native: { serialNumber: '1021410' } }),
				getStateAsync: async id => (id in states ? { val: states[id] } : null),
				setStateAsync: async (id, st) => (written[id] = st.val),
				local: { apply: async (...args) => applied.push(args) && true },
			});
			return { dm: new SchlueterDeviceManagement(fake), written, applied, messages: [] };
		};
		const prefix = 'groups.101254.thermostats.258188';
		const program = () => {
			/** @type {Record<string, any>} */
			const states = {};
			for (let d = 1; d <= 7; d++) {
				for (let e = 0; e < 6; e++) {
					states[`${prefix}.apply.scheduleProgram.day${d}.event${e}.time`] = '05:00';
					states[`${prefix}.apply.scheduleProgram.day${d}.event${e}.temperature`] = 20;
					states[`${prefix}.apply.scheduleProgram.day${d}.event${e}.active`] = false;
				}
			}
			return states;
		};

		it('shows a tab per day and sends the changed events locally', async () => {
			const { dm, written, applied } = setup(program());
			/** @type {any[]} */
			const messages = [];
			/** @type {any} */
			let form = null;
			const context = {
				showMessage: async m => messages.push(m),
				showForm: async (schema, opts) => {
					form = { schema, opts };
					return { ...opts.data, d6e0temperature: 24, d6e0time: '06:30' };
				},
			};
			await dm._editSchedule('101254/258188', context);
			assert.equal(form.schema.type, 'tabs');
			assert.deepEqual(Object.keys(form.schema.items), ['day1', 'day2', 'day3', 'day4', 'day5', 'day6', 'day7']);
			assert.equal(form.schema.items.day1.label.de, 'Montag');
			assert.equal(Object.keys(form.schema.items.day7.items).length, 18);
			assert.deepEqual(written, {
				[`${prefix}.apply.scheduleProgram.day6.event0.time`]: '06:30',
				[`${prefix}.apply.scheduleProgram.day6.event0.temperature`]: 24,
			});
			assert.deepEqual(applied, [['scheduleProgram', '1021410', prefix]]);
			assert.match(messages[0].de, /übernommen/);
		});

		it('explains that editing needs local control', async () => {
			const { dm, applied } = setup({});
			/** @type {any[]} */
			const messages = [];
			await dm._editSchedule('101254/258188', {
				showMessage: async m => messages.push(m),
				showForm: async () => assert.fail('no form without local control'),
			});
			assert.match(messages[0].en, /local control/);
			assert.deepEqual(applied, []);
		});

		it('offers the page as a device action', async () => {
			const { dm } = setup(program());
			/** @type {any[]} */
			const added = [];
			dm.adapter.getDevicesAsync = async () => [
				{
					_id: `${ns}.${prefix}`,
					common: { name: 'Bad' },
					native: { groupId: '101254', thermostatId: '258188' },
				},
			];
			await dm.loadDevices({ setTotalDevices() {}, addDevice: d => added.push(d) });
			assert.equal(added[0].actions[0].id, 'schedule');
			assert.equal(typeof added[0].actions[0].handler, 'function');
		});
	});
});
