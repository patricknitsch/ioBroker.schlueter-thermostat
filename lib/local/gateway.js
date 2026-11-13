/* eslint-disable jsdoc/require-jsdoc */
'use strict';

// ============================================================================
// Local device gateway (BETA) – core
//
// A thermostat that resolves the hostname of the vendor's device gateway to
// this machine (local DNS record) connects here via TLS. The core handles
// everything that is the same for every thermostat series:
//
//  - TLS server, framing, connection lifecycle and timeouts
//  - login detection: each device handler (handler-wg4.js, handler-wd5.js)
//    is asked whether the first message is its login
//  - relay: frames are passed on to the vendor's gateway; the handler decodes
//    them on the way
//  - local answering (local mode, or relay without the vendor's gateway):
//    the handler builds the answers; the vendor's gateway is retried every
//    5 minutes in relay mode
//  - commands with acknowledgement (the handler builds the message)
//  - unknown protocol: byte-for-byte pass-through, logged as hex
//  - the vendor's gateway itself: see upstream.js
//
// Device handler interface:
//   name                               'wg4' | 'wd5'
//   detectLogin(message)               {serial, text, fields?} | null
//   initLink(link)                     sets link.data
//   describe(message)                  text for the debug log
//   isAnswer(message)                  message acknowledges something
//   startAnswering(link)               frames after the login | null (refuse)
//   answer(link, message)              answer frames | null
//   observe(link, message)             decoded values (thermostat -> us)
//   observeVendor(link, frame, msg)    decoded values (vendor -> thermostat)
//   canCommand(link), timeZoneSec(link)
//   command(link, change)              {build(seq), done()}
// ============================================================================

const { EventEmitter } = require('node:events');
const tls = require('node:tls');

const { Message, FrameReader, encodeFrame } = require('./protobuf');
const { VendorGateway, UPSTREAM_STATUS } = require('./upstream');
const { Wg4Handler } = require('./handler-wg4');
const { Wd5Handler } = require('./handler-wd5');

const FIELD_SEQUENCE = 1;
const FIELD_ACKNOWLEDGED = 3;

const LOGIN_TIMEOUT_MS = 30_000;
const IDLE_TIMEOUT_MS = 180_000;
const ACK_TIMEOUT_MS = 10_000;
const UPSTREAM_TIMEOUT_MS = 10_000;
const UPSTREAM_RETRY_MS = 300_000;
const FIRST_SEQUENCE = 101;
const HISTORY_SIZE = 300;
const RAW_LOG_BYTES = 256;

// Cipher suites the thermostats are known to accept come first.
const CIPHERS = ['AES256-SHA256', 'AES128-SHA256', 'AES256-SHA', 'AES128-SHA', tls.DEFAULT_CIPHERS].join(':');

class Link {
	/**
	 * @param {import('node:tls').TLSSocket} socket thermostat socket
	 * @param {string} who description for logs
	 */
	constructor(socket, who) {
		this.socket = socket;
		this.who = who;
		/** @type {string|null} */
		this.serial = null;
		/** @type {any} device handler, known after the login */
		this.handler = null;
		/** @type {Record<string, any>} handler-specific data */
		this.data = {};
		/** @type {import('node:tls').TLSSocket|null} */
		this.upstream = null;
		this.reader = new FrameReader();
		this.downReader = new FrameReader();
		this.downParsing = true;
		this.raw = false;
		this.answering = false;
		this.closed = false;
		/** @type {Set<number>} */
		this.sent = new Set();
		/** @type {Map<number, {resolve: Function, reject: Function}>} */
		this.pending = new Map();
		/** @type {Promise<any>} */
		this.lock = Promise.resolve();
		/** @type {Buffer|null} */
		this.login = null;
		/** @type {Buffer[]} */
		this.queued = [];
		this.timers = [];
	}
}

class LocalGateway extends EventEmitter {
	/**
	 * @param {object} opts options
	 * @param {'relay'|'local'} opts.mode gateway mode
	 * @param {string} opts.cert PEM certificate
	 * @param {string} opts.key PEM key
	 * @param {number} opts.listenPort port to listen on
	 * @param {string} [opts.listenHost] address to listen on
	 * @param {string} [opts.upstreamHost] hostname of the vendor's device gateway
	 * @param {number} [opts.upstreamPort] port of the vendor's device gateway
	 * @param {string} [opts.upstreamIp] fixed IP of the vendor's device gateway
	 * @param {string} [opts.upstreamPin] SHA-256 fingerprint (hex) of the vendor's certificate
	 * @param {string[]} [opts.dnsServers] public DNS servers to resolve upstreamHost
	 * @param {Map<string, import('./handler-wg4').Profile>} [opts.profiles] recorded WG4 profiles by serial
	 * @param {Set<string>} [opts.allowedSerials] serials that may connect (empty = all)
	 * @param {object} [opts.timeouts] override timeouts (tests)
	 * @param {string} [opts.cachedUpstreamIp] last address that worked (fallback)
	 * @param {boolean} [opts.allowLocalUpstream] allow an upstream address on this machine (tests)
	 */
	constructor(opts) {
		super();
		this.mode = opts.mode === 'local' ? 'local' : 'relay';
		this.cert = opts.cert;
		this.key = opts.key;
		this.listenPort = opts.listenPort;
		this.listenHost = opts.listenHost || '0.0.0.0';
		this.profiles = opts.profiles || new Map();
		this.allowedSerials = opts.allowedSerials || new Set();
		this.timeouts = {
			login: LOGIN_TIMEOUT_MS,
			idle: IDLE_TIMEOUT_MS,
			ack: ACK_TIMEOUT_MS,
			upstream: UPSTREAM_TIMEOUT_MS,
			retry: UPSTREAM_RETRY_MS,
			...(opts.timeouts || {}),
		};

		this.vendor = new VendorGateway({
			host: opts.upstreamHost,
			port: opts.upstreamPort || opts.listenPort,
			ip: opts.upstreamIp,
			pin: opts.upstreamPin,
			dnsServers: opts.dnsServers,
			cachedIp: opts.cachedUpstreamIp,
			allowLocal: opts.allowLocalUpstream,
			timeoutMs: this.timeouts.upstream,
			ciphers: CIPHERS,
		});
		this.vendor.on('log', (level, text) => this._event(text, level));
		this.vendor.on('status', status => this.emit('upstream', status));
		this.vendor.on('resolved', ip => this.emit('resolved', ip));
		this.vendor.on('pin', fp => this.emit('pin', fp));
		this.links = new Map();
		this.allLinks = new Set();
		this.sequence = FIRST_SEQUENCE - 1;
		this.history = [];
		this.server = null;
		/** device handlers, tried in this order on login */
		/** @type {any[]} */
		this.handlers = [new Wg4Handler(this), new Wd5Handler(this)];
	}

	// ------------------------------------------------------------------------
	// Lifecycle
	// ------------------------------------------------------------------------

	/** @returns {Promise<void>} resolves when listening */
	start() {
		if (this.server) {
			return Promise.resolve();
		}
		const server = tls.createServer(
			{
				cert: this.cert,
				key: this.key,
				minVersion: 'TLSv1.2',
				ciphers: CIPHERS,
				handshakeTimeout: this.timeouts.login,
			},
			socket => this._accept(socket),
		);
		server.on('connection', raw => {
			this._event(`TCP connection from ${raw.remoteAddress}:${raw.remotePort}, starting TLS handshake`, 'info');
		});
		server.on('tlsClientError', (err, socket) => {
			this._event(
				`The TLS handshake with ${socket?.remoteAddress || 'unknown'} failed: ${err?.message || err}`,
				'info',
			);
		});
		return new Promise((resolve, reject) => {
			const onError = err => {
				server.removeListener('listening', onListening);
				reject(new Error(`Unable to listen on port ${this.listenPort}: ${err?.message || err}`));
			};
			const onListening = () => {
				server.removeListener('error', onError);
				server.on('error', err => this._event(`Gateway server error: ${err?.message || err}`, 'warn'));
				this.server = server;
				this._event(`The gateway listens on port ${this.port} (${this.mode} mode)`, 'info');
				resolve();
			};
			server.once('error', onError);
			server.once('listening', onListening);
			server.listen(this.listenPort, this.listenHost);
		});
	}

	/** @returns {number|null} port while listening */
	get port() {
		const addr = this.server?.address();
		return addr && typeof addr === 'object' ? addr.port : null;
	}

	/** @returns {Promise<void>} resolves when stopped */
	async stop() {
		const server = this.server;
		this.server = null;
		for (const link of [...this.allLinks]) {
			this._close(link);
		}
		if (server) {
			await /** @type {Promise<void>} */ (
				new Promise(resolve => {
					const t = setTimeout(resolve, 5000);
					server.close(() => {
						clearTimeout(t);
						resolve();
					});
				})
			);
		}
	}

	/** @returns {string|null} status of the vendor gateway (connected / unreachable / untrusted) */
	get upstreamStatus() {
		return this.vendor.status;
	}

	/** @returns {string|null} SHA-256 fingerprint of the vendor gateway's certificate */
	get upstreamFingerprint() {
		return this.vendor.fingerprint;
	}

	/** @returns {string[]} connected serials */
	get connected() {
		return [...this.links.keys()];
	}

	/**
	 * @param {string} serial serial number
	 * @returns {boolean} connected and state known (commands possible)
	 */
	canCommand(serial) {
		const link = this.links.get(serial);
		return !!link && !link.closed && !link.raw && !!link.handler && link.handler.canCommand(link);
	}

	/**
	 * @param {string} serial serial number
	 * @returns {{variant: string, timeZoneSec: number|null}|null} info about a connected thermostat
	 */
	info(serial) {
		const link = this.links.get(serial);
		if (!link || !link.handler) {
			return null;
		}
		return { variant: link.handler.name, timeZoneSec: link.handler.timeZoneSec(link) };
	}

	/**
	 * @param {string} serial serial number
	 * @returns {boolean} relayed to the vendor's gateway
	 */
	isRelayed(serial) {
		const link = this.links.get(serial);
		return !!link && !!link.upstream && !link.answering;
	}

	// ------------------------------------------------------------------------
	// Commands
	// ------------------------------------------------------------------------

	/**
	 * Send a change to a thermostat and wait for its confirmation. The device
	 * handler builds the message. Never queued for later: a setpoint applied
	 * hours late does more harm than an error.
	 *
	 * @param {string} serial serial number
	 * @param {{mode?: number, tempC?: number|null, end?: Date|null, vacation?: object}} change change
	 * @returns {Promise<void>} resolves when acknowledged
	 */
	apply(serial, change) {
		const link = this.links.get(serial);
		if (!link) {
			return Promise.reject(new Error('The thermostat is not connected to the local gateway.'));
		}
		const run = async () => {
			if (link.closed) {
				throw new Error('The thermostat disconnected from the local gateway.');
			}
			if (link.raw || !link.handler) {
				throw new Error('The protocol of this thermostat is not understood (pass-through only).');
			}
			const cmd = link.handler.command(link, change);
			await this._sendCommand(link, cmd.build);
			this._emitState(link.serial, cmd.done());
		};
		const p = link.lock.then(run, run);
		link.lock = p.catch(() => {});
		return p;
	}

	/**
	 * WG4: regulation mode with optional setpoint of a hold.
	 *
	 * @param {string} serial serial number
	 * @param {number} mode regulation mode
	 * @param {number|null} [tempC] setpoint in °C
	 * @returns {Promise<void>} resolves when acknowledged
	 */
	setMode(serial, mode, tempC = null) {
		return this.apply(serial, { mode, tempC });
	}

	/**
	 * WD5: mode with optional setpoint and end time.
	 *
	 * @param {string} serial serial number
	 * @param {{mode?: number, tempC?: number, end?: Date|null, vacation?: object}} change change
	 * @returns {Promise<void>} resolves when acknowledged
	 */
	setModeWd5(serial, change) {
		const link = this.links.get(serial);
		if (!link || link.handler?.name !== 'wd5') {
			return Promise.reject(new Error('The WD5 thermostat is not connected to the local gateway.'));
		}
		return this.apply(serial, change);
	}

	_sendCommand(link, build) {
		this.sequence += 1;
		const seq = this.sequence;
		link.sent.add(seq);
		this._event(`Sending command ${seq} to thermostat ${link.serial}`);
		return /** @type {Promise<void>} */ (
			new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					link.pending.delete(seq);
					this._event(`Thermostat ${link.serial} did not answer command ${seq}`);
					reject(new Error('The thermostat did not acknowledge the command.'));
				}, this.timeouts.ack);
				link.pending.set(seq, {
					resolve: ok => {
						clearTimeout(timer);
						link.pending.delete(seq);
						if (ok) {
							this._event(`Thermostat ${link.serial} acknowledged command ${seq}`);
							resolve();
						} else {
							this._event(`Thermostat ${link.serial} refused command ${seq}`);
							reject(new Error('The thermostat refused the command.'));
						}
					},
					reject: err => {
						clearTimeout(timer);
						link.pending.delete(seq);
						reject(err);
					},
				});
				try {
					link.socket.write(encodeFrame(build(seq)));
				} catch (e) {
					link.pending.get(seq)?.reject(e);
				}
			})
		);
	}

	// ------------------------------------------------------------------------
	// Connection handling
	// ------------------------------------------------------------------------

	_accept(socket) {
		const who = socket.remoteAddress || 'unknown';
		const link = new Link(socket, who);
		this.allLinks.add(link);
		const cipher = socket.getCipher?.();
		const sni = socket.servername || '-';
		this._event(
			`Connection from ${who}, secured with ${socket.getProtocol?.() || '?'} (${cipher?.name || '?'}), SNI=${sni}`,
			'info',
		);

		const loginTimer = setTimeout(() => {
			if (!link.serial && !link.raw) {
				this._event(`Closing the connection of ${who}: no login within ${this.timeouts.login / 1000}s`);
				this._close(link);
			}
		}, this.timeouts.login);
		link.timers.push(loginTimer);

		socket.setTimeout(this.timeouts.idle);
		socket.on('timeout', () => {
			this._event(`Closing the connection of ${this._name(link)}: it went quiet`);
			this._close(link);
		});
		socket.on('error', err => this._event(`Connection error of ${this._name(link)}: ${err?.message || err}`));
		socket.on('close', () => this._disconnected(link));
		socket.on('data', chunk => {
			try {
				this._onThermostatData(link, chunk);
			} catch (e) {
				this._event(`Closing the connection of ${this._name(link)}: ${e?.message || e}`);
				this._close(link);
			}
		});
	}

	_name(link) {
		return link.serial ? `thermostat ${link.serial}` : link.who;
	}

	_onThermostatData(link, chunk) {
		if (link.closed) {
			return;
		}
		if (link.raw) {
			this._rawLog('thermostat -> gateway', link, chunk);
			if (link.upstream) {
				link.upstream.write(chunk);
			}
			return;
		}

		let bodies;
		try {
			bodies = link.reader.push(chunk);
		} catch (e) {
			this._unknownProtocol(link, e, []);
			return;
		}

		for (let i = 0; i < bodies.length; i++) {
			if (link.closed) {
				return;
			}
			const body = bodies[i];
			let message;
			try {
				message = Message.parse(body);
			} catch (e) {
				this._unknownProtocol(link, e, bodies.slice(i));
				return;
			}
			if (!link.handler) {
				if (!this._onLogin(link, body, message)) {
					this._unknownProtocol(link, new Error('the first message is not a known login'), bodies.slice(i));
					return;
				}
				continue;
			}
			this._onMessage(link, body, message);
		}
	}

	/**
	 * A message of a logged-in thermostat.
	 *
	 * @param {Link} link link
	 * @param {Buffer} body frame body
	 * @param {Message} message parsed message
	 */
	_onMessage(link, body, message) {
		const h = link.handler;
		this._log('Thermostat', link, message);
		if (h.detectLogin(message)) {
			throw new Error('A second login on the same connection');
		}
		if (link.answering) {
			if (h.isAnswer(message)) {
				this._acknowledged(link, message);
				return;
			}
			this._observe(link, () => h.observe(link, message));
			const answer = h.answer(link, message);
			if (answer) {
				link.socket.write(answer);
			}
			return;
		}
		if (!link.upstream) {
			link.queued.push(body); // waiting for the vendor gateway
			return;
		}
		if (h.isAnswer(message) && this._acknowledged(link, message)) {
			return; // the vendor gateway never sent this command
		}
		this._observe(link, () => h.observe(link, message));
		link.upstream.write(encodeFrame(body));
	}

	/**
	 * The stream does not match the known framing. In relay mode we keep the
	 * thermostat working by passing all bytes through unchanged, and log them.
	 *
	 * @param {Link} link link
	 * @param {Error} err parse error
	 * @param {Buffer[]} bodies frame bodies not handled yet
	 */
	_unknownProtocol(link, err, bodies) {
		if (this.mode !== 'relay' || link.answering) {
			this._event(
				`Closing the connection of ${this._name(link)}: protocol not understood (${err?.message || err})`,
			);
			this._close(link);
			return;
		}
		this._event(
			`The data of ${this._name(link)} does not match the known protocol (${err?.message || err}); ` +
				'switching to pass-through and logging the traffic as hex',
			'warn',
		);
		this.emit('unknownProtocol', { who: link.who, serial: link.serial, error: String(err?.message || err) });
		link.raw = true;
		// Everything received but not forwarded yet, in the original order.
		const pendingBytes = Buffer.concat([
			...(link.queued || []).map(b => encodeFrame(b)),
			...bodies.map(b => encodeFrame(b)),
			link.reader.buffer,
		]);
		link.queued = [];
		link.reader = new FrameReader();
		if (pendingBytes.length) {
			this._rawLog('thermostat -> gateway', link, pendingBytes);
		}
		const forward = () => {
			if (pendingBytes.length && link.upstream) {
				link.upstream.write(pendingBytes);
			}
		};
		if (link.upstream) {
			forward();
		} else {
			link.socket.pause();
			this.vendor
				.open()
				.then(up => {
					if (!up) {
						this._event(`Closing ${this._name(link)}: vendor gateway not available for pass-through`);
						this._close(link);
						return;
					}
					this._attachUpstream(link, up);
					forward();
					link.socket.resume();
				})
				.catch(() => this._close(link));
		}
	}

	/**
	 * First message of a connection: find the handler whose login it is.
	 *
	 * @param {Link} link link
	 * @param {Buffer} body frame body
	 * @param {Message} message parsed message
	 * @returns {boolean} a known login
	 */
	_onLogin(link, body, message) {
		let handler = null;
		let info = null;
		for (const h of this.handlers) {
			info = h.detectLogin(message);
			if (info) {
				handler = h;
				break;
			}
		}
		if (!handler || !info) {
			return false;
		}
		const serial = info.serial;
		link.handler = handler;
		link.serial = serial;
		link.login = body;
		link.queued = [];
		handler.initLink(link);
		this._event(`${info.text} from ${link.who}`, 'info');
		if (info.fields) {
			this._emitState(serial, info.fields);
		}
		if (this.allowedSerials.size && !this.allowedSerials.has(serial)) {
			if (this.mode === 'local') {
				this._event(`Refusing thermostat ${serial}: it is not on the account`, 'warn');
				this._close(link);
				return true;
			}
			// Relay never blocks a thermostat: the serial in the login may be
			// formatted differently from the one the cloud reports.
			this._event(
				`Thermostat ${serial} is not among the known serials (${[...this.allowedSerials].join(', ')}); relaying anyway`,
				'warn',
			);
		}

		if (this.mode === 'local') {
			this._startAnswering(link, false);
			return true;
		}

		link.socket.pause();
		this.vendor
			.open()
			.then(up => {
				if (link.closed) {
					up?.destroy();
					return;
				}
				if (!up) {
					// Keep the thermostat under control while the vendor gateway is away.
					this._startAnswering(link, true);
					return;
				}
				this._attachUpstream(link, up);
				up.write(encodeFrame(body));
				this._connected(link);
				this._flushQueued(link);
			})
			.catch(e => {
				this._event(`Relay setup failed for ${serial}: ${e?.message || e}`);
				this._close(link);
			})
			.finally(() => {
				if (!link.closed) {
					link.socket.resume();
				}
			});
		return true;
	}

	/**
	 * Answer the thermostat locally (local mode, or relay without the vendor gateway).
	 *
	 * @param {Link} link link
	 * @param {boolean} retryUpstream relay mode: try the vendor gateway again
	 */
	_startAnswering(link, retryUpstream) {
		const frames = link.handler.startAnswering(link);
		if (!frames) {
			this._close(link);
			return;
		}
		link.answering = true;
		link.socket.write(frames);
		this._connected(link);
		this._flushQueued(link);
		if (retryUpstream) {
			this._retryUpstream(link);
		}
	}

	_flushQueued(link) {
		for (const queued of link.queued.splice(0)) {
			this._onThermostatData(link, encodeFrame(queued));
		}
	}

	/**
	 * While a thermostat that should be relayed is answered locally, try the
	 * vendor gateway every few minutes and reconnect the thermostat once it
	 * works again (it is relayed then).
	 *
	 * @param {Link} link link
	 */
	_retryUpstream(link) {
		const timer = setInterval(() => {
			this.vendor
				.open()
				.then(up => {
					if (!up) {
						return;
					}
					up.destroy();
					this._event(`The vendor gateway can be used again; reconnecting thermostat ${link.serial}`, 'info');
					this._close(link);
				})
				.catch(() => {});
		}, this.timeouts.retry);
		link.timers.push(timer);
	}

	_attachUpstream(link, up) {
		link.upstream = up;
		up.on('data', chunk => this._onUpstreamData(link, chunk));
		up.on('error', err =>
			this._event(`Vendor gateway connection error (${this._name(link)}): ${err?.message || err}`),
		);
		up.on('close', () => {
			if (!link.closed) {
				this._event(`The vendor gateway closed the connection of ${this._name(link)}`);
				this._close(link);
			}
		});
	}

	_onUpstreamData(link, chunk) {
		if (link.closed) {
			return;
		}
		// Byte-exact forwarding first; what follows only looks at the data.
		link.socket.write(chunk);
		if (link.raw) {
			this._rawLog('vendor -> thermostat', link, chunk);
			return;
		}
		if (!link.downParsing || !link.handler) {
			return;
		}
		let bodies;
		try {
			bodies = link.downReader.push(chunk);
		} catch (e) {
			link.downParsing = false;
			this._event(`The vendor gateway sent ${this._name(link)} data that is not understood: ${e?.message || e}`);
			return;
		}
		for (const body of bodies) {
			let message;
			try {
				message = Message.parse(body);
			} catch {
				this._event(
					`The vendor gateway sent ${this._name(link)} a message of ${body.length} bytes that is not understood`,
				);
				continue;
			}
			this._log('Vendor gateway', link, message);
			this._observe(link, () => link.handler.observeVendor(link, encodeFrame(body), message));
		}
	}

	/**
	 * Let the handler decode a message. Decoding must never break a working
	 * connection: a message that does not match the known layout is only logged.
	 *
	 * @param {Link} link link
	 * @param {() => Record<string, any>} decode decoder
	 */
	_observe(link, decode) {
		try {
			const fields = decode();
			if (fields && Object.keys(fields).length) {
				this._emitState(link.serial, fields);
			}
		} catch (e) {
			this._event(`A message of ${this._name(link)} could not be decoded: ${e?.message || e}`);
		}
	}

	_acknowledged(link, message) {
		const seq = message.varint(FIELD_SEQUENCE);
		if (seq === null || !link.sent.has(seq)) {
			return false;
		}
		link.sent.delete(seq);
		link.pending.get(seq)?.resolve(message.varint(FIELD_ACKNOWLEDGED) === 1);
		return true;
	}

	_emitState(serial, fields) {
		try {
			this.emit('state', serial, fields);
		} catch {
			// listeners must not break a connection
		}
	}

	_connected(link) {
		const previous = this.links.get(link.serial);
		this.links.set(link.serial, link);
		if (previous && previous !== link) {
			this._close(previous);
		}
		const relayed = !!link.upstream && !link.answering;
		this._event(
			`Thermostat ${link.serial} is connected; it is ${relayed ? 'relayed to the vendor gateway' : 'answered locally'}`,
			'info',
		);
		this._emitState(link.serial, { online: true, relayed });
	}

	_disconnected(link) {
		this._close(link);
		this.allLinks.delete(link);
		if (link.serial && this.links.get(link.serial) === link) {
			this.links.delete(link.serial);
			this._event(`Thermostat ${link.serial} is offline`, 'info');
			this._emitState(link.serial, { online: false, relayed: false });
		}
	}

	_close(link) {
		if (link.closed) {
			return;
		}
		link.closed = true;
		for (const t of link.timers) {
			clearTimeout(t);
			clearInterval(t);
		}
		for (const p of [...link.pending.values()]) {
			p.reject(new Error('The thermostat disconnected'));
		}
		try {
			link.socket.destroy();
		} catch {
			// ignore
		}
		if (link.upstream) {
			try {
				link.upstream.destroy();
			} catch {
				// ignore
			}
		}
	}

	// ------------------------------------------------------------------------
	// Logging
	// ------------------------------------------------------------------------

	_log(sender, link, message) {
		this._event(`${sender} (thermostat ${link.serial}): ${link.handler.describe(message)}`);
	}

	_rawLog(direction, link, chunk) {
		const shown = chunk.subarray(0, RAW_LOG_BYTES).toString('hex');
		const more = chunk.length > RAW_LOG_BYTES ? '…' : '';
		this._event(`RAW ${direction} (${this._name(link)}) ${chunk.length} bytes: ${shown}${more}`);
	}

	_event(text, level = 'debug') {
		const line = `${new Date().toISOString()} ${text}`;
		this.history.push(line);
		if (this.history.length > HISTORY_SIZE) {
			this.history.splice(0, this.history.length - HISTORY_SIZE);
		}
		this.emit('log', level, text);
	}
}

module.exports = { LocalGateway, UPSTREAM_STATUS };
