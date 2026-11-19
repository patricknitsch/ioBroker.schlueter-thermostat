'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { getThermostatOptions } = require('../lib/web-components');

const ROOT = path.join(__dirname, '..');
const ADMIN = path.join(ROOT, 'admin');
const MANIFEST = 'webcomponents/thermostat-card.json';
const BASE = 'schlueter-thermostat.0.groups.101254.thermostats.258188';
const TAG = 'schlueter-thermostat-card';
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
	function mockSocket(values) {
		const writes = [];
		const states = Object.fromEntries(Object.entries(values).map(([k, val]) => [`${BASE}.${k}`, { val }]));
		return {
			writes,
			systemLang: 'de',
			subscribeState: async (ids, cb) => ids.forEach(id => cb(id, states[id] || null)),
			unsubscribeState: () => {},
			getState: async id => states[id] || null,
			getObject: async () => null,
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
		assert.equal(root.querySelector('.name').textContent, 'Bad');
		assert.match(root.querySelector('.big').textContent, /21,4/);
		assert.match(root.querySelector('.target .value').textContent, /23,0/);
		assert.equal(root.querySelector('.btn.active').dataset.apply, 'eco');
		assert.match(root.querySelector('.indicators').textContent, /Relay/);
		el.remove();
	});

	it('applies schedule and eco at once through the apply buttons', async () => {
		const socket = mockSocket(sample);
		const el = await mount(socket);
		el.shadowRoot.querySelector('[data-apply="schedule"]').click();
		await tick();
		assert.deepEqual(socket.writes, [['apply.schedule.apply', true]]);
		el.remove();
	});

	it('stores the values of a dialog before pressing apply', async () => {
		const socket = mockSocket(sample);
		const el = await mount(socket);
		el.dialogs = { open: async () => ({ setpoint: 24.5, durationMinutes: 90 }) };
		el.shadowRoot.querySelector('[data-apply="comfort"]').click();
		await tick();
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
		el.shadowRoot.querySelector('[data-apply="boost"]').click();
		await tick();
		assert.deepEqual(socket.writes, []);
		el.remove();
	});

	it('disables the controls of a thermostat that is offline in the cloud', async () => {
		const socket = mockSocket({ ...sample, online: false, connection: 'cloud' });
		const el = await mount(socket);
		const root = el.shadowRoot;
		assert.ok(root.querySelector('.header.offline'));
		assert.ok(root.querySelector('[data-apply="eco"]').disabled);
		root.querySelector('[data-apply="eco"]').click();
		await tick();
		assert.deepEqual(socket.writes, []);
		el.remove();
	});

	it('writes nothing in edit mode', async () => {
		const socket = mockSocket(sample);
		const el = await mount(socket);
		el.editMode = true;
		await tick();
		el.shadowRoot.querySelector('[data-apply="eco"]').click();
		await tick();
		assert.deepEqual(socket.writes, []);
		el.remove();
	});

	it('takes the first thermostat of the instance without a setting', async () => {
		const el = await mount(mockSocket(sample), {});
		await tick();
		await tick();
		assert.equal(el.shadowRoot.querySelector('.name').textContent, 'Bad');
		el.remove();
	});
});
