'use strict';

const assert = require('node:assert/strict');
const tls = require('node:tls');

const {
	Message,
	FrameReader,
	encodeField,
	encodeFrame,
	encodeVarint,
	readVarint,
	setField,
} = require('../lib/local/protobuf');
const P = require('../lib/local/protocol');
const { LocalGateway, profileFromJson, profileToJson } = require('../lib/local/gateway');
const { generateCertificate } = require('../lib/local/cert');

// Captured from real WG4 thermostats: permanent hold, mode 3, temporary
// setpoint 9.4.1 = 2666 (13.33 °C), permanent setpoint 9.5.1 = 2888 (14.44 °C).
const PERMANENT_STATE = Buffer.from('08c5e4f4920310031a020800220908ea1410809cf692032a0308c8163000', 'hex');
// A heartbeat (field 15).
const TELEMETRY = Buffer.from('08930328017a0e08f10f1000200028003000388c04', 'hex');
// The answer of the vendor's gateway to a login with sequence number 29.
const CLOUD_LOGIN_ACK = Buffer.from('081d18012001620608c5e4f49203', 'hex');

const SERIAL = '1234567';
const ACCOUNT = Buffer.concat([
	encodeField(1, Buffer.from('user@example.com')),
	encodeField(2, Buffer.from(SERIAL)),
	encodeField(3, 10207),
]);
const LOGIN = Buffer.concat([encodeField(1, 29), encodeField(5, 1), encodeField(6, ACCOUNT)]);
const CONFIGURATION = Buffer.concat([encodeField(1, 2), encodeField(5, 1), encodeField(10, Buffer.from([0x08, 0x01]))]);
const SUPPORT = Buffer.concat([encodeField(1, 3), encodeField(5, 1), encodeField(18, Buffer.from([0x08, 0x02]))]);
const STATE_UPLOAD = Buffer.concat([
	encodeField(1, 30),
	encodeField(2, P.KIND_STATE_UPLOAD),
	encodeField(5, 1),
	encodeField(8, Buffer.from([0x08, 0x07])),
	encodeField(9, PERMANENT_STATE),
]);

const CERT = generateCertificate('gateway.test');
const UPSTREAM_CERT = generateCertificate('vendor.test');

/**
 * A TLS client that collects the frames it receives.
 *
 * @param {number} port gateway port
 * @returns {Promise<{socket: tls.TLSSocket, frames: Message[], raw: Buffer[], next: (pred?: Function) => Promise<Message>}>} client
 */
function connectThermostat(port) {
	return new Promise((resolve, reject) => {
		const socket = tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false, servername: 'gateway.test' });
		const reader = new FrameReader();
		const frames = [];
		const raw = [];
		const waiters = [];
		const flush = () => {
			for (const w of [...waiters]) {
				const idx = frames.findIndex(w.pred);
				if (idx !== -1) {
					waiters.splice(waiters.indexOf(w), 1);
					w.resolve(frames.splice(idx, 1)[0]);
				}
			}
		};
		socket.on('data', chunk => {
			raw.push(chunk);
			try {
				for (const body of reader.push(chunk)) {
					frames.push(Message.parse(body));
				}
			} catch {
				// raw tests only look at raw bytes
			}
			flush();
		});
		socket.once('secureConnect', () =>
			resolve({
				socket,
				frames,
				raw,
				next: (pred = () => true) =>
					new Promise((res, rej) => {
						waiters.push({ pred, resolve: res });
						flush();
						setTimeout(() => rej(new Error('timeout waiting for frame')), 3000).unref();
					}),
			}),
		);
		socket.once('error', reject);
	});
}

/**
 * A fake vendor gateway.
 *
 * @param {(socket: tls.TLSSocket, chunk: Buffer, state: any) => void} onData handler
 * @returns {Promise<{server: tls.Server, port: number, received: Buffer[]}>} server
 */
function fakeUpstream(onData) {
	return new Promise(resolve => {
		const received = [];
		const server = tls.createServer({ cert: UPSTREAM_CERT.cert, key: UPSTREAM_CERT.key }, socket => {
			const state = { reader: new FrameReader() };
			socket.on('data', chunk => {
				received.push(chunk);
				onData(socket, chunk, state);
			});
			socket.on('error', () => {});
		});
		server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, received }));
	});
}

const wait = ms => new Promise(r => setTimeout(r, ms));

describe('local gateway: protobuf', () => {
	it('round-trips varints', () => {
		for (const v of [0, 1, 127, 128, 300, 2 ** 31, 2 ** 40]) {
			const [back, end] = readVarint(encodeVarint(v));
			assert.equal(back, v);
			assert.equal(end, encodeVarint(v).length);
		}
	});

	it('sets a field and keeps every other byte', () => {
		const msg = Buffer.concat([encodeField(1, 5), encodeField(3, Buffer.from('abc')), encodeField(7, 9)]);
		const changed = setField(msg, 3, Buffer.from('xy'));
		const parsed = Message.parse(changed);
		assert.equal(parsed.varint(1), 5);
		assert.equal(parsed.data(3).toString(), 'xy');
		assert.equal(parsed.varint(7), 9);
		// inserted in order
		const inserted = Message.parse(setField(msg, 5, 1));
		assert.deepEqual(
			inserted.fields.map(f => f.number),
			[1, 3, 5, 7],
		);
	});

	it('reads frames split across chunks', () => {
		const frame = encodeFrame(TELEMETRY);
		const reader = new FrameReader();
		assert.deepEqual(reader.push(frame.subarray(0, 3)), []);
		const bodies = reader.push(Buffer.concat([frame.subarray(3), frame]));
		assert.equal(bodies.length, 2);
		assert.ok(bodies[0].equals(TELEMETRY));
	});

	it('rejects a stream that is not framed', () => {
		assert.throws(() => new FrameReader().push(Buffer.from('GET / HTTP/1.1')));
	});
});

describe('local gateway: protocol', () => {
	it('builds acknowledgements like the vendor gateway', () => {
		assert.equal(P.acknowledgement(403).toString('hex'), '0893031801');
	});

	it('decodes a real state', () => {
		const fields = P.decodeState(Message.parse(encodeField(P.FIELD_STATE, PERMANENT_STATE)));
		assert.equal(fields.regulationMode, 3);
		assert.equal(fields.comfortSetpoint, 13.33);
		assert.equal(fields.manualSetpoint, 14.44);
		assert.equal(fields.targetTemperature, 14.44);
	});

	it('decodes a real heartbeat', () => {
		const fields = P.decodeTelemetry(Message.parse(TELEMETRY));
		assert.equal(fields.floorTemperature, 20.33);
		assert.equal(fields.heating, false);
	});

	it('changes mode and setpoint of the permanent hold only', () => {
		const changed = P.changedState(PERMANENT_STATE, P.REGULATION_MANUAL, 21.5, new Date(Date.UTC(2026, 0, 1)));
		const fields = P.decodeState(Message.parse(encodeField(P.FIELD_STATE, changed)));
		assert.equal(fields.regulationMode, 3);
		assert.equal(fields.manualSetpoint, 21.5);
		assert.equal(fields.comfortSetpoint, 13.33);
		assert.equal(Message.parse(changed).varint(1), P.deviceTime(new Date(Date.UTC(2026, 0, 1))));
	});

	it('reads the serial of a login and hides it in logs', () => {
		const msg = Message.parse(LOGIN);
		assert.equal(P.loginSerial(msg), SERIAL);
		assert.equal(P.describe(msg), 'login');
	});

	it('recognises the answers that make up a profile', () => {
		assert.equal(P.responseField(Message.parse(CONFIGURATION)), P.FIELD_CONFIGURATION);
		assert.equal(P.responseField(Message.parse(SUPPORT)), P.FIELD_SUPPORT);
		assert.equal(P.responseField(Message.parse(TELEMETRY)), null);
	});
});

describe('local gateway: relay', function () {
	this.timeout(10000);
	let gateway;
	let upstream;

	afterEach(async () => {
		await gateway?.stop();
		await new Promise(r => (upstream ? upstream.server.close(() => r()) : r()));
		gateway = null;
		upstream = null;
	});

	it('relays a thermostat, records its profile and sends commands directly', async () => {
		upstream = await fakeUpstream((socket, chunk, st) => {
			for (const body of st.reader.push(chunk)) {
				const m = Message.parse(body);
				if (m.has(P.FIELD_LOGIN)) {
					socket.write(encodeFrame(CLOUD_LOGIN_ACK));
				} else if (m.varint(P.FIELD_KIND) === P.KIND_STATE_UPLOAD) {
					socket.write(Buffer.concat([encodeFrame(P.acknowledgement(30)), encodeFrame(CONFIGURATION)]));
				} else if (m.varint(P.FIELD_KIND) === P.KIND_SCHEDULE_UPLOAD) {
					socket.write(Buffer.concat([encodeFrame(P.acknowledgement(31)), encodeFrame(SUPPORT)]));
				}
			}
		});
		gateway = new LocalGateway({
			mode: 'relay',
			cert: CERT.cert,
			key: CERT.key,
			listenPort: 0,
			listenHost: '127.0.0.1',
			upstreamHost: 'vendor.test',
			upstreamIp: '127.0.0.1',
			upstreamPort: upstream.port,
			allowedSerials: new Set([SERIAL]),
			allowLocalUpstream: true,
		});
		const states = [];
		const profiles = [];
		let pin = null;
		gateway.on('state', (serial, fields) => states.push({ serial, ...fields }));
		gateway.on('profile', (serial, profile) => profiles.push({ serial, profile }));
		gateway.on('pin', fp => (pin = fp));
		await gateway.start();

		const t = await connectThermostat(gateway.port);
		t.socket.write(encodeFrame(LOGIN));
		const ack = await t.next();
		assert.ok(ack.raw.equals(CLOUD_LOGIN_ACK));
		assert.match(pin, /^[0-9a-f]{64}$/);

		t.socket.write(encodeFrame(STATE_UPLOAD));
		await t.next(m => m.has(P.FIELD_CONFIGURATION));
		const schedUpload = Buffer.concat([encodeField(1, 31), encodeField(2, P.KIND_SCHEDULE_UPLOAD), encodeField(5, 1)]);
		t.socket.write(encodeFrame(schedUpload));
		await t.next(m => m.has(P.FIELD_SUPPORT));
		await wait(50);

		assert.equal(profiles.length, 1);
		assert.equal(profiles[0].serial, SERIAL);
		assert.ok(profileFromJson(profileToJson(profiles[0].profile)));
		assert.ok(states.some(s => s.online === true && s.relayed === true));
		assert.ok(states.some(s => s.regulationMode === 3 && s.manualSetpoint === 14.44));
		assert.ok(gateway.canCommand(SERIAL));

		// A command goes straight to the thermostat; its answer is not passed on.
		const before = Buffer.concat(upstream.received).length;
		const done = gateway.setMode(SERIAL, P.REGULATION_MANUAL, 22);
		const cmd = await t.next(m => m.has(P.FIELD_STATE));
		assert.equal(cmd.varint(1), 101);
		assert.equal(P.decodeState(cmd).manualSetpoint, 22);
		t.socket.write(encodeFrame(Buffer.concat([encodeField(1, 101), encodeField(3, 1)])));
		await done;
		await wait(50);
		assert.equal(Buffer.concat(upstream.received).length, before);
		assert.ok(states.some(s => s.manualSetpoint === 22));

		// Heartbeats are relayed and decoded.
		t.socket.write(encodeFrame(TELEMETRY));
		await wait(100);
		assert.ok(states.some(s => s.floorTemperature === 20.33));
		assert.ok(Buffer.concat(upstream.received).length > before);

		// A message that cannot be decoded is still relayed and keeps the link.
		const odd = encodeFrame(Buffer.concat([encodeField(1, 40), encodeField(9, Buffer.from([0xff]))]));
		const sentBefore = Buffer.concat(upstream.received).length;
		t.socket.write(odd);
		await wait(100);
		assert.equal(Buffer.concat(upstream.received).length, sentBefore + odd.length);
		assert.ok(gateway.connected.includes(SERIAL));

		t.socket.destroy();
		await wait(100);
		assert.ok(states.some(s => s.online === false));
	});

	it('passes unknown traffic through unchanged', async () => {
		upstream = await fakeUpstream((socket, chunk) => socket.write(Buffer.concat([Buffer.from('echo:'), chunk])));
		gateway = new LocalGateway({
			mode: 'relay',
			cert: CERT.cert,
			key: CERT.key,
			listenPort: 0,
			listenHost: '127.0.0.1',
			upstreamIp: '127.0.0.1',
			upstreamPort: upstream.port,
			allowLocalUpstream: true,
		});
		let unknown = null;
		gateway.on('unknownProtocol', info => (unknown = info));
		await gateway.start();
		const t = await connectThermostat(gateway.port);
		t.socket.write(Buffer.from([0x17, 0x00, 0x42, 0x43]));
		await wait(300);
		assert.ok(unknown);
		assert.equal(Buffer.concat(upstream.received).toString('hex'), '17004243');
		assert.equal(Buffer.concat(t.raw).toString('hex'), Buffer.concat([Buffer.from('echo:'), Buffer.from([0x17, 0, 0x42, 0x43])]).toString('hex'));
		t.socket.destroy();
	});

	it('refuses a vendor gateway whose certificate does not match the pin', async () => {
		upstream = await fakeUpstream(() => {});
		gateway = new LocalGateway({
			mode: 'relay',
			cert: CERT.cert,
			key: CERT.key,
			listenPort: 0,
			listenHost: '127.0.0.1',
			upstreamIp: '127.0.0.1',
			upstreamPort: upstream.port,
			upstreamPin: '00'.repeat(32),
			allowLocalUpstream: true,
		});
		await gateway.start();
		const t = await connectThermostat(gateway.port);
		t.socket.write(encodeFrame(LOGIN));
		await wait(300);
		assert.equal(gateway.upstreamStatus, 'untrusted');
		assert.equal(upstream.received.length, 0);
		// no profile -> the thermostat is not answered
		assert.equal(gateway.connected.length, 0);
		t.socket.destroy();
	});
});

describe('local gateway: local mode', function () {
	this.timeout(10000);

	it('answers a thermostat with its recorded profile', async () => {
		const profile = { configuration: encodeFrame(CONFIGURATION), support: encodeFrame(SUPPORT) };
		const gateway = new LocalGateway({
			mode: 'local',
			cert: CERT.cert,
			key: CERT.key,
			listenPort: 0,
			listenHost: '127.0.0.1',
			profiles: new Map([[SERIAL, profile]]),
		});
		await gateway.start();
		try {
			const t = await connectThermostat(gateway.port);
			t.socket.write(encodeFrame(LOGIN));
			const ack = await t.next();
			assert.equal(ack.varint(1), 29);
			assert.equal(ack.varint(3), 1);
			assert.ok(ack.has(12));

			t.socket.write(encodeFrame(STATE_UPLOAD));
			const a = await t.next();
			assert.equal(a.varint(1), 30);
			const conf = await t.next();
			assert.ok(conf.raw.equals(CONFIGURATION));

			const done = gateway.setMode(SERIAL, P.REGULATION_SCHEDULE);
			const cmd = await t.next(m => m.has(P.FIELD_STATE));
			assert.equal(P.decodeState(cmd).regulationMode, 1);
			t.socket.write(encodeFrame(Buffer.concat([encodeField(1, cmd.varint(1)), encodeField(3, 1)])));
			await done;

			// A refused command is reported.
			const refused = gateway.setMode(SERIAL, P.REGULATION_MANUAL, 20);
			const cmd2 = await t.next(m => m.has(P.FIELD_STATE));
			t.socket.write(encodeFrame(Buffer.concat([encodeField(1, cmd2.varint(1)), encodeField(3, 0)])));
			await assert.rejects(refused, /refused/);
			t.socket.destroy();
		} finally {
			await gateway.stop();
		}
	});

	it('refuses a thermostat without a profile', async () => {
		const gateway = new LocalGateway({
			mode: 'local',
			cert: CERT.cert,
			key: CERT.key,
			listenPort: 0,
			listenHost: '127.0.0.1',
		});
		await gateway.start();
		try {
			const t = await connectThermostat(gateway.port);
			const closed = new Promise(r => t.socket.once('close', r));
			t.socket.write(encodeFrame(LOGIN));
			await closed;
			assert.equal(gateway.connected.length, 0);
		} finally {
			await gateway.stop();
		}
	});

	it('rejects commands for a thermostat that is not connected', async () => {
		const gateway = new LocalGateway({ mode: 'local', cert: CERT.cert, key: CERT.key, listenPort: 0 });
		await assert.rejects(gateway.setMode(SERIAL, 1), /not connected/);
	});
});
