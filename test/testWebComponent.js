'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { getThermostatOptions } = require('../lib/web-components');

const ROOT = path.join(__dirname, '..');
const ADMIN = path.join(ROOT, 'admin');
const MANIFEST = 'webcomponents/thermostat-card.json';
const BASE = 'schlueter-thermostat.0.groups.101254.thermostats.258188';
const TAG = 'iob-schlueter-thermostat-card';
/** DOM of happy-dom, registered while the element tests run */
const dom = () => /** @type {any} */ (globalThis).document;

/** @param {string} file path below admin/ */
const readAdmin = file => fs.readFileSync(path.join(ADMIN, file), 'utf8');

describe('web component: manifest and bundle', () => {
	it('has a valid manifest whose files exist', async () => {
		const { checkManifest } = await import('@iobroker/web-components');
		const manifest = JSON.parse(readAdmin(MANIFEST));
		assert.equal(checkManifest(manifest), null);
		assert.equal(manifest.tag, TAG);
		assert.ok(fs.existsSync(path.join(ADMIN, 'webcomponents', manifest.module)));
		assert.ok(fs.existsSync(path.join(ADMIN, 'webcomponents', manifest.icon)));
	});

	it('is listed in io-package.json as a plain manifest path, which every host reads', async () => {
		// devices 4.4 skips entries in the object short form, so the list holds plain paths only
		const { getWebComponentSources } = await import('@iobroker/web-components');
		const io = JSON.parse(fs.readFileSync(path.join(ROOT, 'io-package.json'), 'utf8'));
		const list = io.common.webComponents;
		assert.deepEqual(list, [MANIFEST]);
		const sources = getWebComponentSources(
			[{ _id: 'system.adapter.schlueter-thermostat.0', common: { webComponents: list } }],
			'http://localhost:8081/',
		);
		assert.equal(sources.length, 1);
		assert.match(sources[0].url, /\/adapter\/schlueter-thermostat\/webcomponents\/thermostat-card\.json$/);
	});

	it('ships a bundle that is built from the current source (run `npm run build`)', async () => {
		const { build } = await import('esbuild');
		const result = await build({
			entryPoints: [path.join(ROOT, 'src-webcomponents/thermostat-card.js')],
			bundle: true,
			format: 'esm',
			target: 'es2022',
			minify: true,
			legalComments: 'none',
			write: false,
			logLevel: 'silent',
		});
		assert.equal(result.outputFiles[0].text, readAdmin('webcomponents/thermostat-card.js'));
	});
});

describe('web component: thermostat list (getThermostats)', () => {
	it('lists the thermostat devices with their group, sorted', async () => {
		const adapter = {
			namespace: 'schlueter-thermostat.0',
			getDevicesAsync: async () => [
				{ _id: `${BASE}`, common: { name: 'Bathroom' } },
				{ _id: 'schlueter-thermostat.0.groups.101254.thermostats.1', common: { name: { en: 'Kitchen' } } },
				{ _id: 'schlueter-thermostat.0.something.else', common: { name: 'Other' } },
			],
			getObjectAsync: async id =>
				id === 'schlueter-thermostat.0.groups.101254' ? { common: { name: 'Ground floor' } } : null,
		};
		const options = await getThermostatOptions(/** @type {any} */ (adapter));
		assert.deepEqual(options, [
			{ value: BASE, label: 'Bathroom (Ground floor)' },
			{ value: 'schlueter-thermostat.0.groups.101254.thermostats.1', label: 'Kitchen (Ground floor)' },
		]);
	});
});

describe('web component: element', function () {
	this.timeout(10000);
	/** @type {any} */
	let GlobalRegistrator;

	before(async () => {
		({ GlobalRegistrator } = await import('@happy-dom/global-registrator'));
		GlobalRegistrator.register({ url: 'http://localhost:8081/adapter/schlueter-thermostat/webcomponents/' });
		// browser code: not part of the Node type check (see tsconfig.webcomponents.json)
		const source = '../src-webcomponents/thermostat-card.js';
		await import(source);
	});

	after(async () => {
		await GlobalRegistrator.unregister();
	});

	/** Socket of a host with the states of one thermostat; records the writes */
	function mockSocket(values, objects = {}) {
		const writes = [];
		const states = Object.fromEntries(Object.entries(values).map(([k, val]) => [`${BASE}.${k}`, { val }]));
		return {
			writes,
			systemLang: 'de',
			subscribeState: async (ids, cb) => ids.forEach(id => cb(id, states[id] || null)),
			unsubscribeState: () => {},
			getState: async id => states[id] || null,
			getObject: async id => objects[id] || null,
			subscribeObject: async () => {},
			unsubscribeObject: async () => {},
			getObjectViewSystem: async () => ({ [BASE]: { _id: BASE } }),
			setState: async (id, val) => {
				writes.push([id.slice(BASE.length + 1), val]);
			},
		};
	}

	/** @returns {Promise<void>} after the element drew */
	const tick = () => new Promise(resolve => setTimeout(resolve, 10));

	/**
	 * Pick a mode in the list of the overview
	 *
	 * @param {any} el element
	 * @param {string} apply apply folder of the mode
	 */
	const choose = async (el, apply) => {
		const select = el.shadowRoot.querySelector('select[data-mode]');
		select.value = apply;
		select.dispatchEvent(new /** @type {any} */ (globalThis).Event('change', { bubbles: true }));
		await tick();
	};

	/**
	 * @param {any} socket mock socket
	 * @param {Record<string, string>} [settings] settings of the host
	 */
	async function mount(socket, settings = { thermostat: BASE }) {
		const el = /** @type {any} */ (dom().createElement(TAG));
		el.socket = socket;
		el.settings = settings;
		dom().body.appendChild(el);
		await tick();
		await tick();
		return el;
	}

	const sample = {
		online: true,
		heating: true,
		thermostatName: 'Bad',
		connection: 'relay',
		'temperature.room': 21.44,
		'temperature.floor': 24.6,
		'setpoint.active': 23,
		regulationMode: 9,
	};

	it('shows name, temperatures and the active mode', async () => {
		const el = await mount(mockSocket(sample));
		const root = el.shadowRoot;
		assert.equal(root.querySelector('.name').textContent, 'Bad (258188)');
		assert.match(root.querySelector('.big').textContent, /21,4/);
		assert.match(root.querySelector('.target .value').textContent, /23,0/);
		assert.equal(root.querySelector('select[data-mode]').value, 'eco');
		assert.match(root.querySelector('.indicators').textContent, /Relay/);
		el.remove();
	});

	it('shows the numbers of thermostat and group in the header', async () => {
		const el = await mount(mockSocket(sample));
		const root = el.shadowRoot;
		// without objects: from the object id
		assert.equal(root.querySelector('.name').textContent, 'Bad (258188)');
		assert.equal(root.querySelector('.sub').textContent, 'Gruppe (101254)');
		el.remove();
	});

	it('takes group name and serial number from the objects', async () => {
		const objects = {
			[BASE]: {
				common: { name: 'Bad' },
				native: { thermostatId: 258188, groupId: 101254, serialNumber: '1234567' },
			},
			'schlueter-thermostat.0.groups.101254': { common: { name: 'Erdgeschoss' } },
		};
		const el = await mount(mockSocket(sample, objects));
		const root = el.shadowRoot;
		assert.equal(root.querySelector('.sub').textContent, 'Erdgeschoss (101254) · SN 1234567');
		assert.match(root.querySelector('.name').title, /Seriennummer: 1234567/);
		el.remove();
	});

	it('applies schedule and eco at once from the mode list', async () => {
		const socket = mockSocket(sample);
		const el = await mount(socket);
		await choose(el, 'schedule');
		assert.deepEqual(socket.writes, [['apply.schedule.apply', true]]);
		el.remove();
	});

	it('stores the values of a dialog before pressing apply', async () => {
		const socket = mockSocket(sample);
		const el = await mount(socket);
		el.dialogs = { open: async () => ({ setpoint: 24.5, durationMinutes: 90 }) };
		await choose(el, 'comfort');
		assert.deepEqual(socket.writes, [
			['apply.comfort.setpoint', 24.5],
			['apply.comfort.durationMinutes', 90],
			['apply.comfort.apply', true],
		]);
		el.remove();
	});

	it('sends nothing when the dialog is cancelled', async () => {
		const socket = mockSocket(sample);
		const el = await mount(socket);
		el.dialogs = { open: async () => null };
		await choose(el, 'boost');
		assert.deepEqual(socket.writes, []);
		el.remove();
	});

	it('disables the controls of a thermostat that is offline in the cloud', async () => {
		const socket = mockSocket({ ...sample, online: false, connection: 'cloud' });
		const el = await mount(socket);
		const root = el.shadowRoot;
		assert.ok(root.querySelector('.header.offline'));
		assert.ok(root.querySelector('select[data-mode]').disabled);
		await choose(el, 'eco');
		assert.deepEqual(socket.writes, []);
		el.remove();
	});

	it('writes nothing in edit mode', async () => {
		const socket = mockSocket(sample);
		const el = await mount(socket);
		el.editMode = true;
		await tick();
		await choose(el, 'eco');
		assert.deepEqual(socket.writes, []);
		el.remove();
	});

	it('takes the first thermostat of the instance without a setting', async () => {
		const el = await mount(mockSocket(sample), {});
		await tick();
		await tick();
		assert.equal(el.shadowRoot.querySelector('.name').textContent, 'Bad (258188)');
		el.remove();
	});

	it('shows a mode without a choice of its own (frost protection) without offering it', async () => {
		const el = await mount(mockSocket({ ...sample, regulationMode: 6 }));
		const select = el.shadowRoot.querySelector('select[data-mode]');
		assert.equal(select.value, '');
		assert.match(select.selectedOptions[0].textContent, /Frostschutz/);
		el.remove();
	});

	it('shows end times and vacation on the times page', async () => {
		const el = await mount(
			mockSocket({
				...sample,
				regulationMode: 2,
				'endTime.comfort': '2027-01-02T18:30:00',
				'vacation.enabled': true,
				'vacation.begin': '2027-02-01T00:00:00',
				'vacation.end': '2027-02-08T00:00:00',
			}),
		);
		el.shadowRoot.querySelector('[data-page="times"]').click();
		await tick();
		const text = el.shadowRoot.querySelector('.rows').textContent;
		assert.match(text, /Komfort bis\s*2027-01-02 18:30/);
		assert.match(text, /2027-02-01 – 2027-02-08/);
		assert.ok(!el.shadowRoot.querySelector('select[data-mode]'));
		el.remove();
	});

	/** @returns {Record<string, unknown>} a week with the editable copy of local control */
	const week = () => {
		/** @type {Record<string, unknown>} */
		const values = { ...sample };
		for (let d = 1; d <= 7; d++) {
			for (let e = 0; e < 6; e++) {
				const time = `${String(5 + e * 3).padStart(2, '0')}:00`;
				values[`schedule.day${d}.event${e}.time`] = `${time}:00`;
				values[`schedule.day${d}.event${e}.temperature`] = 20;
				values[`schedule.day${d}.event${e}.active`] = e === 0;
				values[`apply.scheduleProgram.day${d}.event${e}.time`] = time;
				values[`apply.scheduleProgram.day${d}.event${e}.temperature`] = 20;
				values[`apply.scheduleProgram.day${d}.event${e}.active`] = e === 0;
			}
		}
		return values;
	};

	it('subscribes the schedule only on its page and sends the edited events', async () => {
		const socket = mockSocket(week());
		/** @type {string[]} */
		const subscribed = [];
		const subscribe = socket.subscribeState;
		socket.subscribeState = async (ids, cb) => {
			subscribed.push(...ids);
			return subscribe(ids, cb);
		};
		const el = await mount(socket);
		assert.ok(!subscribed.some(id => id.includes('.schedule.')));
		el.shadowRoot.querySelector('[data-page="schedule"]').click();
		await tick();
		await tick();
		assert.ok(subscribed.includes(`${BASE}.apply.scheduleProgram.day7.event5.active`));
		const root = el.shadowRoot;
		assert.ok(root.querySelector('[data-send]').disabled);
		root.querySelector('[data-day="6"]').click();
		await tick();
		const temp = root.querySelector('input[data-k="6.0.temperature"]');
		temp.value = '24';
		temp.dispatchEvent(new /** @type {any} */ (globalThis).Event('input', { bubbles: true }));
		const active = root.querySelector('input[data-k="6.1.active"]');
		active.checked = true;
		active.dispatchEvent(new /** @type {any} */ (globalThis).Event('change', { bubbles: true }));
		assert.ok(!root.querySelector('[data-send]').disabled);
		root.querySelector('[data-send]').click();
		await tick();
		assert.deepEqual(socket.writes, [
			['apply.scheduleProgram.day6.event0.temperature', 24],
			['apply.scheduleProgram.day6.event1.active', true],
			['apply.scheduleProgram.apply', true],
		]);
		el.remove();
	});

	it('shows the schedule read-only without local control', async () => {
		const values = Object.fromEntries(
			Object.entries(week()).filter(([k]) => !k.startsWith('apply.scheduleProgram')),
		);
		const el = await mount(mockSocket(values));
		el.shadowRoot.querySelector('[data-page="schedule"]').click();
		await tick();
		await tick();
		const root = el.shadowRoot;
		assert.equal(root.querySelector('input[data-k="1.0.time"]').value, '05:00');
		assert.ok(root.querySelector('input[data-k="1.0.time"]').disabled);
		assert.ok(!root.querySelector('[data-send]'));
		assert.match(root.querySelector('.hint').textContent, /lokaler Steuerung/);
		el.remove();
	});
});
