'use strict';

const assert = require('node:assert/strict');
const tls = require('node:tls');
const { createTimers, NODE_TIMERS } = require('../lib/local/timers');
const { LocalGateway } = require('../lib/local/gateway');
const { generateCertificate } = require('../lib/local/cert');

/**
 * Host with the timer methods of an adapter; records the calls.
 *
 * @param {{refuse?: boolean}} [opts] refuse new timers like an adapter that shuts down
 * @returns {any} host
 */
function fakeHost(opts = {}) {
	const calls = [];
	return {
		calls,
		setTimeout(fn, ms) {
			calls.push(['setTimeout', ms]);
			return opts.refuse ? undefined : NODE_TIMERS.setTimeout(fn, ms);
		},
		clearTimeout(handle) {
			calls.push(['clearTimeout']);
			NODE_TIMERS.clearTimeout(handle);
		},
		setInterval(fn, ms) {
			calls.push(['setInterval', ms]);
			return opts.refuse ? undefined : NODE_TIMERS.setInterval(fn, ms);
		},
		clearInterval(handle) {
			calls.push(['clearInterval']);
			NODE_TIMERS.clearInterval(handle);
		},
	};
}

describe('local gateway: timers', () => {
	it("uses Node's timers without a host", () => {
		assert.equal(createTimers(), NODE_TIMERS);
		assert.equal(createTimers({}), NODE_TIMERS);
	});

	it('uses the timers of the host', async () => {
		const host = fakeHost();
		const timers = createTimers(host);
		await new Promise(resolve => timers.setTimeout(() => resolve(undefined), 5));
		const interval = timers.setInterval(() => {}, 1000);
		timers.clearInterval(interval);
		timers.clearTimeout(undefined);
		assert.deepEqual(host.calls, [['setTimeout', 5], ['setInterval', 1000], ['clearInterval']]);
	});

	it("falls back to Node's timers while the host refuses new ones (unload)", async () => {
		const host = fakeHost({ refuse: true });
		const timers = createTimers(host);
		let fired = false;
		await new Promise(resolve =>
			timers.setTimeout(() => {
				fired = true;
				resolve(undefined);
			}, 5),
		);
		assert.ok(fired);
		const handle = timers.setTimeout(() => assert.fail('cleared timeout fired'), 5);
		timers.clearTimeout(handle);
		await new Promise(resolve => NODE_TIMERS.setTimeout(() => resolve(undefined), 20));
	});

	it('runs the timers of the gateway on the host', async function () {
		this.timeout(10000);
		const host = fakeHost();
		const cert = generateCertificate('gateway.test');
		const gateway = new LocalGateway({
			mode: 'local',
			cert: cert.cert,
			key: cert.key,
			listenPort: 0,
			listenHost: '127.0.0.1',
			timerHost: host,
			timeouts: { login: 200 },
		});
		await gateway.start();
		try {
			// a connection without login is closed by the login timer of the host
			const socket = tls.connect({ host: '127.0.0.1', port: Number(gateway.port), rejectUnauthorized: false });
			await new Promise(resolve => socket.once('close', resolve));
			assert.ok(host.calls.some(c => c[0] === 'setTimeout' && c[1] === 200));
		} finally {
			await gateway.stop();
		}
	});
});
