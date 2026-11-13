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
const { LocalGateway } = require('../lib/local/gateway');
const { profileFromJson, profileToJson } = require('../lib/local/handler-wg4');
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
		server.listen(0, '127.0.0.1', () =>
			resolve({ server, port: /** @type {import('node:net').AddressInfo} */ (server.address()).port, received }),
		);
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
		assert.equal(String(parsed.data(3)), 'xy');
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
		await /** @type {Promise<void>} */ (new Promise(r => (upstream ? upstream.server.close(() => r()) : r())));
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
		let pin = /** @type {string | null} */ (null);
		gateway.on('state', (serial, fields) => states.push({ serial, ...fields }));
		gateway.on('profile', (serial, profile) => profiles.push({ serial, profile }));
		gateway.on('pin', fp => (pin = fp));
		await gateway.start();

		const t = await connectThermostat(Number(gateway.port));
		t.socket.write(encodeFrame(LOGIN));
		const ack = await t.next();
		assert.ok(ack.raw.equals(CLOUD_LOGIN_ACK));
		assert.match(String(pin), /^[0-9a-f]{64}$/);

		t.socket.write(encodeFrame(STATE_UPLOAD));
		await t.next(m => m.has(P.FIELD_CONFIGURATION));
		const schedUpload = Buffer.concat([
			encodeField(1, 31),
			encodeField(2, P.KIND_SCHEDULE_UPLOAD),
			encodeField(5, 1),
		]);
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

	it('relays a WD5 thermostat frame by frame', async () => {
		// Real first frame of an OWD5 thermostat (firmware 1013W220).
		const wd5Login = Buffer.from(
			'0825080120012a1f0a073130323134313010031a08313031335732323020012a060806100e1833',
			'hex',
		);
		const answer = encodeFrame(Buffer.concat([encodeField(1, 1), encodeField(3, 1)]));
		upstream = await fakeUpstream((socket, chunk, st) => {
			for (const body of st.reader.push(chunk)) {
				if (Message.parse(body).has(5)) {
					socket.write(answer);
				}
			}
		});
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
		const states = [];
		let unknown = false;
		gateway.on('state', (serial, fields) => states.push({ serial, ...fields }));
		gateway.on('unknownProtocol', () => (unknown = true));
		const logs = [];
		gateway.on('log', (level, text) => logs.push(text));
		await gateway.start();

		const t = await connectThermostat(Number(gateway.port));
		t.socket.write(wd5Login);
		const ack = await t.next();
		assert.equal(ack.varint(3), 1);
		assert.equal(Buffer.concat(upstream.received).toString('hex'), wd5Login.toString('hex'));
		assert.equal(unknown, false);
		assert.ok(states.some(x => x.serial === '1021410' && x.firmware === '1013W220'));
		assert.ok(states.some(x => x.serial === '1021410' && x.online === true && x.relayed === true));
		assert.ok(logs.some(l => l.includes('1=1 3=1')));
		assert.equal(gateway.canCommand('1021410'), false);

		const next = encodeFrame(Buffer.concat([encodeField(1, 2), encodeField(7, Buffer.from([0x08, 0x05]))]));
		t.socket.write(next);
		await wait(100);
		assert.ok(Buffer.concat(upstream.received).subarray(wd5Login.length).equals(next));
		t.socket.destroy();
	});

	it('decodes a WD5 thermostat and sends local commands like the vendor gateway', async () => {
		const W = require('../lib/local/wd5');
		const wd5Login = Buffer.from(
			'0825080120012a1f0a073130323134313010031a08313031335732323020012a060806100e1833',
			'hex',
		);
		const dateTime = (y, mo, d, h, mi, sec) =>
			Buffer.concat([
				encodeField(1, Buffer.concat([encodeField(1, y), encodeField(2, mo), encodeField(3, d)])),
				encodeField(2, Buffer.concat([encodeField(1, h), encodeField(2, mi), encodeField(3, sec)])),
			]);
		// Shapes as logged from a real OWD5 thermostat.
		const upload = Buffer.concat([
			encodeField(1, 13),
			encodeField(4, 1),
			encodeField(
				7,
				Buffer.concat([encodeField(1, 847837681), encodeField(2, Buffer.from('Bad')), encodeField(3, 3600)]),
			),
			encodeField(
				9,
				Buffer.concat([
					encodeField(1, 847837681),
					encodeField(2, 1),
					encodeField(5, encodeField(1, 0)),
					encodeField(8, 1),
					encodeField(9, 0),
				]),
			),
		]);
		const heartbeat = Buffer.concat([
			encodeField(1, 14),
			encodeField(4, 1),
			encodeField(
				6,
				Buffer.concat([
					encodeField(1, 847862621),
					encodeField(2, 1973),
					encodeField(3, 3301),
					encodeField(4, 1),
					encodeField(5, 1),
				]),
			),
		]);
		// Command of the vendor gateway (manual 23 °C).
		const cloudState = Buffer.concat([
			encodeField(1, 847862879),
			encodeField(2, 3),
			encodeField(3, Buffer.concat([encodeField(1, 4600), encodeField(2, dateTime(1970, 1, 1, 0, 0, 0))])),
			encodeField(4, encodeField(1, 4600)),
			encodeField(7, encodeField(1, 1000)),
			encodeField(8, 1),
			encodeField(9, 0),
		]);
		let upSocket = /** @type {any} */ (null);
		upstream = await fakeUpstream((socket, chunk, st) => {
			upSocket = socket;
			for (const body of st.reader.push(chunk)) {
				const m = Message.parse(body);
				if (m.has(4)) {
					socket.write(encodeFrame(Buffer.concat([encodeField(1, m.varint(1) ?? 0), encodeField(3, 1)])));
				}
			}
		});
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
		const states = [];
		gateway.on('state', (serial, fields) => states.push({ serial, ...fields }));
		await gateway.start();
		const t = await connectThermostat(Number(gateway.port));
		t.socket.write(wd5Login);
		await t.next();
		t.socket.write(encodeFrame(upload));
		t.socket.write(encodeFrame(heartbeat));
		await t.next(m => m.varint(1) === 14);
		assert.ok(gateway.canCommand('1021410'));
		assert.ok(states.some(x => x.roomTemperature === 19.73 && x.floorTemperature === 33.01 && x.heating === true));
		assert.ok(states.some(x => x.room === 'Bad' && x.regulationMode === 1));

		// The vendor gateway changes the mode; it becomes the template.
		upSocket.write(encodeFrame(Buffer.concat([encodeField(1, 3), encodeField(4, 1), encodeField(9, cloudState)])));
		await t.next(m => m.varint(1) === 3);
		assert.ok(states.some(x => x.regulationMode === 3 && x.manualSetpoint === 23));

		const before = Buffer.concat(upstream.received).length;
		const done = gateway.setModeWd5('1021410', { mode: W.MODE_COMFORT, tempC: 24.5, end: W.localIn(60, 3600) });
		const cmd = await t.next(m => m.varint(1) === 101);
		assert.equal(cmd.varint(4), 1);
		const decoded = W.decodeState(cmd);
		assert.equal(decoded.regulationMode, 2);
		assert.equal(decoded.comfortSetpoint, 24.5);
		assert.equal(decoded.manualSetpoint, 23);
		assert.equal(decoded.frostProtectionSetpoint, 5);
		assert.match(decoded.comfortEnd, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/);
		t.socket.write(encodeFrame(Buffer.concat([encodeField(1, 101), encodeField(3, 1)])));
		await done;
		await wait(50);
		// The answer to an own command is not passed on to the vendor gateway.
		assert.equal(Buffer.concat(upstream.received).length, before);
		t.socket.destroy();
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
		const t = await connectThermostat(Number(gateway.port));
		t.socket.write(Buffer.from([0x17, 0x00, 0x42, 0x43]));
		await wait(300);
		assert.ok(unknown);
		assert.equal(Buffer.concat(upstream.received).toString('hex'), '17004243');
		assert.equal(
			Buffer.concat(t.raw).toString('hex'),
			Buffer.concat([Buffer.from('echo:'), Buffer.from([0x17, 0, 0x42, 0x43])]).toString('hex'),
		);
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
		const t = await connectThermostat(Number(gateway.port));
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
			const t = await connectThermostat(Number(gateway.port));
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
			t.socket.write(encodeFrame(Buffer.concat([encodeField(1, cmd.varint(1) ?? 0), encodeField(3, 1)])));
			await done;

			// A refused command is reported.
			const refused = gateway.setMode(SERIAL, P.REGULATION_MANUAL, 20);
			const cmd2 = await t.next(m => m.has(P.FIELD_STATE));
			t.socket.write(encodeFrame(Buffer.concat([encodeField(1, cmd2.varint(1) ?? 0), encodeField(3, 0)])));
			await assert.rejects(refused, /refused/);
			t.socket.destroy();
		} finally {
			await gateway.stop();
		}
	});

	for (const variant of ['local', 'relay-fallback']) {
		it(`answers a WD5 thermostat itself (${variant})`, async () => {
			const W = require('../lib/local/wd5');
			const wd5Login = Buffer.from(
				'0825080120012a1f0a073130323134313010031a08313031335732323020012a060806100e1833',
				'hex',
			);
			const gateway = new LocalGateway({
				mode: variant === 'local' ? 'local' : 'relay',
				cert: CERT.cert,
				key: CERT.key,
				listenPort: 0,
				listenHost: '127.0.0.1',
				// relay-fallback: nothing listens on port 1, the vendor gateway is unreachable
				upstreamIp: '127.0.0.1',
				upstreamPort: 1,
				allowLocalUpstream: true,
			});
			const states = [];
			gateway.on('state', (serial, fields) => states.push({ serial, ...fields }));
			await gateway.start();
			try {
				const t = await connectThermostat(Number(gateway.port));
				t.socket.write(wd5Login);
				const loginAnswer = await t.next(m => m.varint(1) === 1);
				assert.equal(loginAnswer.varint(3), 1);
				assert.equal(loginAnswer.varint(4), 1);
				assert.ok(loginAnswer.has(12));
				const request = await t.next(m => m.has(10));
				assert.equal(request.varint(1), 0);
				assert.equal(request.message(10)?.varint(2), 1);
				assert.ok(states.some(x => x.online === true && x.relayed === false));

				// acknowledgement of the request needs no answer; upload and heartbeat do
				t.socket.write(encodeFrame(Buffer.concat([encodeField(1, 0), encodeField(3, 1)])));
				const upload = Buffer.concat([
					encodeField(1, 13),
					encodeField(4, 1),
					encodeField(9, Buffer.concat([encodeField(1, 847837681), encodeField(2, 1), encodeField(8, 1)])),
				]);
				t.socket.write(encodeFrame(upload));
				const ack = await t.next(m => m.varint(1) === 13);
				assert.equal(ack.varint(3), 1);
				assert.ok(ack.has(12));
				assert.ok(gateway.canCommand('1021410'));

				const done = gateway.setModeWd5('1021410', { mode: W.MODE_MANUAL, tempC: 21.5 });
				const cmd = await t.next(m => m.varint(1) === 101);
				assert.equal(W.decodeState(cmd).manualSetpoint, 21.5);
				t.socket.write(encodeFrame(Buffer.concat([encodeField(1, 101), encodeField(3, 1)])));
				await done;
				t.socket.destroy();
			} finally {
				await gateway.stop();
			}
		});
	}

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
			const t = await connectThermostat(Number(gateway.port));
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

describe('local manager: main states', () => {
	it('mirrors local values into the main states and tells the cloud poll to skip them', async () => {
		const { LocalManager } = require('../lib/local-manager');
		const written = {};
		const adapter = {
			config: { localMode: 'relay' },
			namespace: 'schlueter-thermostat.0',
			log: { debug() {}, info() {}, warn() {}, error() {} },
			safeSetState: (id, st) => (written[id] = st.val),
			safeSetObjectNotExists: async () => {},
			safeGetObject: async () => null,
			safeSetObject: async () => {},
		};
		const m = new LocalManager(adapter);
		const dev = 'groups.1.thermostats.2';
		const gw = { connected: ['1021410'], isRelayed: () => false, allowedSerials: new Set(), stop: async () => {} };
		m.gateway = /** @type {any} */ (gw);
		m.registerThermostat('1021410', dev);
		await m._onState('1021410', { online: true, relayed: false });
		await m._onState('1021410', { roomTemperature: 19.73, floorTemperature: 33.01, heating: true });
		await m._onState('1021410', { regulationMode: 3, manualSetpoint: 23, boostEnd: '' });

		assert.equal(written[`${dev}.online`], true);
		assert.equal(written[`${dev}.temperature.room`], 19.73);
		assert.equal(written[`${dev}.temperature.floor`], 33.01);
		assert.equal(written[`${dev}.heating`], true);
		assert.equal(written[`${dev}.regulationMode`], 3);
		assert.equal(written[`${dev}.setpoint.manual`], 23);
		assert.equal(written[`${dev}.endTime.boost`], undefined);
		assert.equal(written[`${dev}.connection`], 'local');
		assert.ok(!Object.keys(written).some(id => id.includes('.local.')));

		// Schedule, name, firmware and frost protection land in the same states as the cloud values.
		const schedule = [{ day: 1, events: [{ time: '05:00:00', temperature: 23, active: true, nextDay: false }] }];
		await m._onState('1021410', {
			schedule: JSON.stringify(schedule),
			room: 'Bad',
			firmware: '1013W220',
			frostProtectionSetpoint: 5,
		});
		assert.equal(written[`${dev}.schedule.day1.event0.time`], '05:00:00');
		assert.equal(written[`${dev}.schedule.day1.event0.temperature`], 23);
		assert.equal(written[`${dev}.schedule.day1.event0.active`], true);
		assert.equal(written[`${dev}.schedule.day1.event0.type`], 0);
		assert.equal(written[`${dev}.thermostatName`], 'Bad');
		assert.equal(written[`${dev}.softwareVersion`], '1013W220');
		assert.equal(written[`${dev}.setpoint.frostProtection`], 5);

		const skip = m.localStateIds('1021410');
		for (const id of [
			'online',
			'heating',
			'temperature.room',
			'temperature.floor',
			'regulationMode',
			'setpoint.manual',
		]) {
			assert.ok(skip.has(id), id);
		}
		assert.ok(!skip.has('setpoint.comfort'));
		assert.ok(skip.has('schedule'));
		assert.ok(skip.has('thermostatName'));

		// After a disconnect the cloud values are written again.
		gw.connected = [];
		await m._onState('1021410', { online: false, relayed: false });
		assert.deepEqual([...m.localStateIds('1021410')], ['online']);
		assert.equal(written[`${dev}.connection`], 'cloud');
	});
});

describe('local manager: energy estimate', () => {
	it('counts heating time x load between heartbeats', async () => {
		const { LocalManager } = require('../lib/local-manager');
		const written = {};
		const adapter = {
			config: { localMode: 'relay' },
			namespace: 'schlueter-thermostat.0',
			log: { debug() {}, info() {}, warn() {}, error() {} },
			safeSetState: (id, st) => (written[id] = st.val),
			safeSetObjectNotExists: async () => {},
			safeGetObject: async () => null,
			safeSetObject: async () => {},
		};
		const m = new LocalManager(adapter);
		m._saveStore = () => {};
		const dev = 'groups.1.thermostats.2';
		m.registerThermostat('1021410', dev);
		const realNow = Date.now;
		let now = realNow();
		Date.now = () => now;
		try {
			await m._onState('1021410', { online: true });
			await m._onState('1021410', { loadWatts: 350, room: 'Bad' });
			await m._onState('1021410', { heating: true });
			now += 60_000;
			await m._onState('1021410', { heating: true }); // 1 min at 350 W
			now += 60_000;
			await m._onState('1021410', { heating: false }); // 1 min at 350 W
			now += 60_000;
			await m._onState('1021410', { heating: false }); // off
			now += 10 * 60_000;
			await m._onState('1021410', { heating: true }); // gap > 5 min is not counted
		} finally {
			Date.now = realNow;
		}
		// 2 minutes x 350 W = 0.01167 kWh
		assert.equal(written[`${dev}.energy.estimatedToday`], 0.012);
		assert.equal(written[`${dev}.energy.estimatedTotal`], 0.012);
		assert.equal(written[`${dev}.energy.loadWatts`], 350);
	});
});

describe('local manager: cloud writes in local-only mode', () => {
	const make = config => {
		const { LocalManager } = require('../lib/local-manager');
		return new LocalManager({ config, log: {}, namespace: 'x' });
	};

	it('blocks cloud applies only in local-only mode', () => {
		assert.equal(make({ localMode: 'off' }).cloudApplyBlockedReason(), null);
		assert.equal(make({ localMode: 'relay', localAllowCommands: true }).cloudApplyBlockedReason(), null);
		assert.match(
			String(make({ localMode: 'local', localAllowCommands: true }).cloudApplyBlockedReason()),
			/not supported locally/,
		);
		assert.match(
			String(make({ localMode: 'local', localAllowCommands: false }).cloudApplyBlockedReason()),
			/Send commands locally/,
		);
	});
});

describe('local manager: cloud poll interval', () => {
	it('polls the cloud less often only while every thermostat is connected locally', () => {
		const { LocalManager } = require('../lib/local-manager');
		const m = new LocalManager({ config: { localMode: 'relay', localCloudPollSec: 300 }, log: {}, namespace: 'x' });
		const connected = new Set();
		m.isConnected = serial => connected.has(serial);
		assert.equal(m.cloudPollIntervalMs(['a', 'b'], 15_000), 15_000);
		connected.add('a');
		assert.equal(m.cloudPollIntervalMs(['a', 'b'], 15_000), 15_000);
		connected.add('b');
		assert.equal(m.cloudPollIntervalMs(['a', 'b'], 15_000), 300_000);
		// never faster than the normal interval
		assert.equal(m.cloudPollIntervalMs(['a', 'b'], 600_000), 600_000);
		assert.equal(m.cloudPollIntervalMs([], 15_000), 15_000);

		const off = new LocalManager({ config: { localMode: 'relay', localCloudPollSec: 0 }, log: {}, namespace: 'x' });
		off.isConnected = () => true;
		assert.equal(off.cloudPollIntervalMs(['a'], 15_000), 15_000);
	});
});

describe('local manager: DNS check', () => {
	const make = () => {
		const { LocalManager } = require('../lib/local-manager');
		return new LocalManager({ config: { localMode: 'relay' }, log: {}, namespace: 'x' });
	};

	it('reports a hostname that points to this host with an open port', async () => {
		const net = require('node:net');
		const server = net.createServer(s => s.destroy());
		await /** @type {Promise<void>} */ (new Promise(r => server.listen(0, '127.0.0.1', () => r())));
		try {
			const r = await make().diagnose(
				'localhost',
				/** @type {import('node:net').AddressInfo} */ (server.address()).port,
			);
			assert.equal(r.ok, true);
			assert.equal(r.local, '127.0.0.1');
			assert.match(r.text, /^OK:/);
		} finally {
			server.close();
		}
	});

	it('reports a closed port', async () => {
		const r = await make().diagnose('localhost', 1);
		assert.equal(r.ok, false);
		assert.equal(r.portOpen, false);
		assert.match(r.text, /does not answer/);
	});

	it('reports a missing hostname', async () => {
		const r = await make().diagnose('', 9513);
		assert.equal(r.ok, false);
		assert.match(r.text, /No hostname/);
	});
});

describe('local manager: no connection warning', () => {
	it('warns once when no thermostat connected and clears the warning on connect', async () => {
		const { LocalManager } = require('../lib/local-manager');
		const warnings = [];
		const infos = [];
		let fire = /** @type {any} */ (null);
		const adapter = {
			config: { localMode: 'relay', localUpstreamHost: 'gw.example', notifyEnabled: false },
			namespace: 'x',
			log: { warn: t => warnings.push(t), info: t => infos.push(t), debug() {}, error() {} },
			setTimeout: (fn, ms) => {
				assert.equal(ms, 10 * 60_000);
				fire = fn;
				return 1;
			},
			clearTimeout: () => {},
			safeSetState: () => {},
			safeSetObjectNotExists: async () => {},
		};
		const m = new LocalManager(adapter);
		m.gateway = /** @type {any} */ ({
			connected: [],
			port: 9513,
			allowedSerials: new Set(),
			stop: async () => {},
			isRelayed: () => true,
		});
		m._startNoConnectionWatch();
		fire();
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /No thermostat has connected .* gw\.example/);

		m.registerThermostat('1021410', 'groups.1.thermostats.2');
		await m._onState('1021410', { online: true, relayed: true });
		assert.ok(infos.some(t => /is connected now/.test(t)));
	});
});

describe('local gateway: several thermostats', function () {
	this.timeout(10000);

	it('keeps thermostats apart: states and commands per serial', async () => {
		const W = require('../lib/local/wd5');
		const wd5Login = serial =>
			encodeFrame(
				Buffer.concat([
					encodeField(1, 1),
					encodeField(4, 1),
					encodeField(
						5,
						Buffer.concat([
							encodeField(1, Buffer.from(serial)),
							encodeField(2, 3),
							encodeField(3, Buffer.from('1013W220')),
						]),
					),
				]),
			);
		const upload = room =>
			encodeFrame(
				Buffer.concat([
					encodeField(1, 13),
					encodeField(4, 1),
					encodeField(7, Buffer.concat([encodeField(2, Buffer.from(room)), encodeField(3, 3600)])),
					encodeField(9, Buffer.concat([encodeField(1, 847837681), encodeField(2, 1)])),
				]),
			);
		const gateway = new LocalGateway({
			mode: 'local',
			cert: CERT.cert,
			key: CERT.key,
			listenPort: 0,
			listenHost: '127.0.0.1',
			allowedSerials: new Set(['1000001', '1000002']),
		});
		const states = [];
		gateway.on('state', (serial, fields) => states.push({ serial, ...fields }));
		await gateway.start();
		try {
			const bad = await connectThermostat(Number(gateway.port));
			const kitchen = await connectThermostat(Number(gateway.port));
			bad.socket.write(wd5Login('1000001'));
			kitchen.socket.write(wd5Login('1000002'));
			await bad.next(m => m.has(10));
			await kitchen.next(m => m.has(10));
			bad.socket.write(upload('Bad'));
			kitchen.socket.write(upload('Kueche'));
			await bad.next(m => m.varint(1) === 13);
			await kitchen.next(m => m.varint(1) === 13);

			assert.deepEqual(gateway.connected.sort(), ['1000001', '1000002']);
			assert.ok(states.some(x => x.serial === '1000001' && x.room === 'Bad'));
			assert.ok(states.some(x => x.serial === '1000002' && x.room === 'Kueche'));

			// A command reaches only its own thermostat.
			const done = gateway.setModeWd5('1000002', { mode: W.MODE_MANUAL, tempC: 22 });
			const cmd = await kitchen.next(m => m.has(9) && m.varint(4) === 1);
			kitchen.socket.write(encodeFrame(Buffer.concat([encodeField(1, cmd.varint(1) ?? 0), encodeField(3, 1)])));
			await done;
			await wait(50);
			assert.ok(!bad.frames.some(m => m.has(9)));

			// One thermostat going offline does not affect the other.
			bad.socket.destroy();
			await wait(100);
			assert.deepEqual(gateway.connected, ['1000002']);
			assert.ok(gateway.canCommand('1000002'));
			kitchen.socket.destroy();
		} finally {
			await gateway.stop();
		}
	});
});

describe('local manager: DNS check on start', () => {
	it('does not warn when this host resolves the name to the cloud, but keeps it as hint', async () => {
		const { LocalManager } = require('../lib/local-manager');
		const logs = /** @type {{ warn: string[], info: string[], debug: string[] }} */ ({
			warn: [],
			info: [],
			debug: [],
		});
		const m = new LocalManager({
			config: { localMode: 'local' },
			namespace: 'x',
			log: { warn: t => logs.warn.push(t), info: t => logs.info.push(t), debug: t => logs.debug.push(t) },
		});
		m.diagnose = async () => ({
			ok: false,
			addresses: ['40.68.93.45'],
			local: null,
			portOpen: null,
			text: 'cloud',
		});
		await m._checkDnsRecordOnStart('gw.example');
		assert.equal(logs.warn.length, 0);
		assert.equal(m.dnsHint, 'cloud');

		m.diagnose = async () => ({
			ok: true,
			addresses: ['192.168.1.2'],
			local: '192.168.1.2',
			portOpen: true,
			text: 'OK',
		});
		await m._checkDnsRecordOnStart('gw.example');
		assert.equal(m.dnsHint, '');
		assert.ok(logs.info.some(t => /DNS check – OK/.test(t)));
	});
});

describe('local gateway: WD5 vacation', () => {
	const W = require('../lib/local/wd5');
	const P = require('../lib/local/protocol');
	const date = (y, m, d) => Buffer.concat([encodeField(1, y), encodeField(2, m), encodeField(3, d)]);
	const dateTime = (y, mo, d, h, mi, s) =>
		Buffer.concat([
			encodeField(1, date(y, mo, d)),
			encodeField(2, Buffer.concat([encodeField(1, h), encodeField(2, mi), encodeField(3, s)])),
		]);
	const state = vacation =>
		Buffer.concat([
			encodeField(1, 847890037),
			encodeField(2, 1),
			encodeField(3, Buffer.concat([encodeField(1, 4600), encodeField(2, dateTime(1970, 1, 1, 0, 0, 0))])),
			encodeField(4, encodeField(1, 0)),
			encodeField(5, vacation),
			encodeField(6, encodeField(1, dateTime(1970, 1, 1, 0, 0, 0))),
			encodeField(7, encodeField(1, 1000)),
			encodeField(8, 1),
			encodeField(9, 0),
		]);
	const without = state(
		Buffer.concat([
			encodeField(1, 0),
			encodeField(2, date(1970, 1, 1)),
			encodeField(3, date(1970, 1, 1)),
			encodeField(4, 1000),
		]),
	);
	// As the vendor gateway sent it on a real OWD5 (vacation 2027-01-01 .. 2027-01-02).
	const cloud = state(
		Buffer.concat([
			encodeField(1, 1),
			encodeField(2, date(2027, 1, 1)),
			encodeField(3, date(2027, 1, 2)),
			encodeField(4, 1000),
		]),
	);

	it('builds the vacation command exactly like the vendor gateway (setpoint kept)', () => {
		const ours = W.changedState(
			without,
			{ mode: 1, vacation: { enabled: true, begin: W.parseDay('2027-01-01'), end: W.parseDay('2027-01-02') } },
			new Date(Date.UTC(2000, 0, 1) + 847890037 * 1000),
		);
		assert.equal(P.dump(Message.parse(ours)), P.dump(Message.parse(cloud)));
		const fields = W.decodeState(Message.parse(encodeField(9, ours)));
		assert.equal(fields.vacationEnabled, true);
		assert.equal(fields.vacationBegin, '2027-01-01T00:00:00');
		assert.equal(fields.vacationEnd, '2027-01-02T00:00:00');
		assert.equal(fields.vacationSetpoint, 5);
		assert.equal(fields.regulationMode, 1);
	});

	it('parses vacation days in the formats of the states', () => {
		assert.deepEqual(W.parseDay('2027-01-01'), { y: 2027, m: 1, d: 1 });
		assert.deepEqual(W.parseDay('2027-01-02T00:00:00'), { y: 2027, m: 1, d: 2 });
		assert.deepEqual(W.parseDay('24.12.2026'), { y: 2026, m: 12, d: 24 });
		assert.equal(W.parseDay('2027-02-30'), null);
		assert.equal(W.parseDay(''), null);
	});
});

describe('local gateway: WD5 vacation mode', () => {
	const W = require('../lib/local/wd5');
	// 13.11.2026 14:10 thermostat-local, as in the captured log
	const today = new Date(Date.UTC(2026, 10, 13, 14, 10, 0));
	const v = (enabled, begin, end) => ({ enabled, begin: W.parseDay(begin), end: W.parseDay(end) });

	it('switches to vacation mode at once when the vacation has begun (observed)', () => {
		assert.equal(W.vacationMode(v(true, '2026-11-13', '2026-11-14'), 1, today), 4);
		assert.equal(W.vacationMode(v(true, '2026-11-10', '2026-11-13'), 3, today), 4);
	});

	it('keeps the mode for a vacation in the future (observed)', () => {
		assert.equal(W.vacationMode(v(true, '2027-01-01', '2027-01-03'), 1, today), undefined);
	});

	it('returns to the schedule when a running vacation is disabled or moved (assumed)', () => {
		assert.equal(W.vacationMode(v(false, '2026-11-13', '2026-11-14'), 4, today), 1);
		assert.equal(W.vacationMode(v(true, '2027-01-01', '2027-01-03'), 4, today), 1);
		assert.equal(W.vacationMode(v(false, '', ''), 3, today), undefined);
	});
});

describe('local manager: mode off', () => {
	const fs = require('node:fs');
	const os = require('node:os');
	const path = require('node:path');
	const net = require('node:net');

	const freePort = () =>
		new Promise(resolve => {
			const s = net.createServer();
			s.listen(0, () => {
				const { port } = /** @type {any} */ (s.address());
				s.close(() => resolve(port));
			});
		});

	it('warns once per thermostat that still connects to this host', async () => {
		const { LocalManager } = require('../lib/local-manager');
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'schlueter-'));
		fs.writeFileSync(path.join(dir, 'local-gateway.json'), '{}');
		const port = await freePort();
		const warnings = [];
		const m = new LocalManager({
			config: { localMode: 'off', localListenPort: port, notifyEnabled: false },
			namespace: 'x',
			log: { warn: t => warnings.push(t), info() {}, debug() {} },
		});
		m._instanceDataDir = () => dir;
		await m._watchStaleDnsRecord();
		await /** @type {Promise<void>} */ (new Promise(r => m.staleWatch?.once('listening', () => r()) ?? r()));
		try {
			for (let i = 0; i < 2; i++) {
				await new Promise(resolve => {
					const c = net.connect({ host: '127.0.0.1', port });
					c.on('close', resolve);
					c.on('error', resolve);
				});
			}
			await wait(50);
			assert.equal(warnings.length, 1);
			assert.match(warnings[0], /Local control is off, but a thermostat .* is trying to connect/);
		} finally {
			await m.stop();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it('opens no port when local control was never used', async () => {
		const { LocalManager } = require('../lib/local-manager');
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'schlueter-'));
		const m = new LocalManager({ config: { localMode: 'off' }, namespace: 'x', log: { debug() {} } });
		m._instanceDataDir = () => dir;
		await m._watchStaleDnsRecord();
		assert.equal(m.staleWatch, null);
		fs.rmSync(dir, { recursive: true, force: true });
	});
});

describe('local manager: cloud-only users', () => {
	it('create only the connection state, no empty estimate states', async () => {
		const { LocalManager } = require('../lib/local-manager');
		const created = [];
		const m = new LocalManager({
			config: { localMode: 'off' },
			namespace: 'x',
			log: { debug() {} },
			safeSetObjectNotExists: async id => created.push(id),
			safeSetState: () => {},
		});
		await m._syncConnection('1021410', 'groups.1.thermostats.2', 'test');
		assert.deepEqual(created, ['groups.1.thermostats.2.connection']);
	});
});

describe('local manager: local connection lost / restored', () => {
	const make = () => {
		const { LocalManager } = require('../lib/local-manager');
		const logs = /** @type {{ warn: string[], info: string[] }} */ ({ warn: [], info: [] });
		const timers = [];
		const adapter = {
			config: { localMode: 'relay', notifyEnabled: false },
			namespace: 'x',
			log: { warn: t => logs.warn.push(t), info: t => logs.info.push(t), debug() {}, error() {} },
			setTimeout: (fn, ms) => {
				const t = { fn, ms, cleared: false };
				timers.push(t);
				return t;
			},
			clearTimeout: t => (t.cleared = true),
			safeSetState: () => {},
			safeSetObjectNotExists: async () => {},
			safeGetObject: async () => ({ common: { name: 'Bad' } }),
		};
		const m = new LocalManager(adapter);
		m.gateway = /** @type {any} */ ({
			connected: [],
			port: 9513,
			allowedSerials: new Set(),
			stop: async () => {},
			isRelayed: () => true,
		});
		m.registerThermostat('1021410', 'groups.1.thermostats.2');
		const fire = () =>
			timers.filter(t => !t.cleared && t.ms === 2 * 60_000).forEach(t => ((t.cleared = true), t.fn()));
		return { m, logs, timers, fire };
	};

	it('reports a loss after the grace time and the return after it', async () => {
		const { m, logs, fire } = make();
		await m._onState('1021410', { online: false, relayed: false });
		fire();
		await wait(10);
		assert.equal(logs.warn.length, 1);
		assert.match(logs.warn[0], /local connection of Bad lost/);

		/** @type {any} */ (m.gateway).connected = ['1021410'];
		await m._onState('1021410', { online: true, relayed: true });
		await wait(10);
		assert.ok(logs.info.some(t => /local connection of Bad restored/.test(t)));
	});

	it('stays quiet for a short reconnect and while stopping', async () => {
		const { m, logs, timers } = make();
		await m._onState('1021410', { online: false, relayed: false });
		/** @type {any} */ (m.gateway).connected = ['1021410'];
		await m._onState('1021410', { online: true, relayed: true });
		assert.ok(timers.every(t => t.cleared || t.ms !== 2 * 60_000));
		assert.ok(!logs.info.some(t => /restored/.test(t)));

		await m.stop();
		m.gateway = /** @type {any} */ ({
			connected: [],
			port: 9513,
			allowedSerials: new Set(),
			stop: async () => {},
			isRelayed: () => true,
		});
		await m._onState('1021410', { online: false, relayed: false });
		assert.equal(timers.filter(t => !t.cleared && t.ms === 2 * 60_000).length, 0);
		assert.equal(logs.warn.length, 0);
	});
});

describe('local manager: connection state', () => {
	it('heals a wrong connection value on the next cloud poll, from the gateway itself', async () => {
		const { LocalManager } = require('../lib/local-manager');
		const written = [];
		const m = new LocalManager({
			config: { localMode: 'local' },
			namespace: 'x',
			log: { debug() {}, info() {}, warn() {} },
			safeSetObjectNotExists: async () => {},
			safeSetState: (id, st) => id.endsWith('.connection') && written.push(st.val),
		});
		const gw = /** @type {any} */ ({
			connected: [],
			isRelayed: () => false,
			allowedSerials: new Set(),
			stop: async () => {},
		});
		m.gateway = /** @type {any} */ (gw);
		const dev = 'groups.1.thermostats.2';
		m.registerThermostat('1021410', dev); // first poll: not connected yet
		await wait(10);
		assert.deepEqual(written, ['cloud']);

		// the thermostat is connected locally, but the event got lost / overtaken
		gw.connected = ['1021410'];
		m.registerThermostat('1021410', dev); // next poll
		await wait(10);
		assert.deepEqual(written, ['cloud', 'local']);

		// nothing is written while the value is right
		m.registerThermostat('1021410', dev);
		await wait(10);
		assert.deepEqual(written, ['cloud', 'local']);

		// relay
		gw.isRelayed = () => true;
		m.registerThermostat('1021410', dev);
		await wait(10);
		assert.deepEqual(written, ['cloud', 'local', 'relay']);
	});
});
