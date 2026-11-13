/* eslint-disable jsdoc/require-jsdoc */
'use strict';

// ============================================================================
// Local device gateway (BETA)
//
// A thermostat that resolves the hostname of the vendor's device gateway to
// this machine (local DNS record) connects here via TLS.
//
// Modes:
//  - relay: the connection is passed on to the vendor's gateway, so the app
//           keeps working. Everything the thermostat reports is decoded on
//           the way. The two answers the vendor's gateway sends after login
//           are recorded as the thermostat's "profile". If the vendor's
//           gateway cannot be used, a thermostat with a profile is answered
//           locally, and the vendor's gateway is retried every 5 minutes.
//  - local: the gateway answers the thermostat itself with the recorded
//           profile and never contacts the vendor's gateway.
//
// Commands (schedule / permanent hold with setpoint) go straight to the
// thermostat in both modes and wait for its acknowledgement.
//
// If the data on the connection does not match the known framing (protocol of
// the thermostat series not confirmed yet), the relay falls back to a pure
// byte-for-byte pass-through and logs the traffic as hex for analysis.
// ============================================================================

const { EventEmitter } = require('node:events');
const tls = require('node:tls');
const os = require('node:os');
const crypto = require('node:crypto');
const net = require('node:net');
const https = require('node:https');
const { Resolver, lookup } = require('node:dns').promises;

const { Message, FrameReader, encodeFrame, encodeField } = require('./protobuf');
const P = require('./protocol');
const W = require('./wd5');

const LOGIN_TIMEOUT_MS = 30_000;
const IDLE_TIMEOUT_MS = 180_000;
const ACK_TIMEOUT_MS = 10_000;
const UPSTREAM_TIMEOUT_MS = 10_000;
const UPSTREAM_RETRY_MS = 300_000;
const FIRST_SEQUENCE = 101;
const HISTORY_SIZE = 300;
const RAW_LOG_BYTES = 256;
const DEFAULT_DNS_SERVERS = ['1.1.1.1', '8.8.8.8'];
const RESOLVE_CACHE_MS = 3600_000;

// Cipher suites the thermostats are known to accept come first.
const CIPHERS = ['AES256-SHA256', 'AES128-SHA256', 'AES256-SHA', 'AES128-SHA', tls.DEFAULT_CIPHERS].join(':');

const UPSTREAM_STATUS = Object.freeze({
	CONNECTED: 'connected',
	UNREACHABLE: 'unreachable',
	UNTRUSTED: 'untrusted',
});

/**
 * @typedef {{configuration: Buffer, support: Buffer}} Profile complete answer frames (fields 10 and 18)
 */

/**
 * Check that a profile consists of the two expected answer frames.
 *
 * @param {Profile} profile profile
 * @returns {boolean} valid
 */
function isValidProfile(profile) {
	const check = (frame, field) => {
		try {
			const r = new FrameReader();
			const bodies = r.push(Buffer.from(frame));
			return bodies.length === 1 && r.buffer.length === 0 && P.responseField(Message.parse(bodies[0])) === field;
		} catch {
			return false;
		}
	};
	return !!profile && check(profile.configuration, P.FIELD_CONFIGURATION) && check(profile.support, P.FIELD_SUPPORT);
}

/**
 * Profile -> JSON-serialisable object.
 *
 * @param {Profile} profile profile
 * @returns {{configuration: string, support: string}} hex strings
 */
function profileToJson(profile) {
	return { configuration: profile.configuration.toString('hex'), support: profile.support.toString('hex') };
}

/**
 * JSON object -> profile (null if invalid).
 *
 * @param {any} data stored data
 * @returns {Profile|null} profile
 */
function profileFromJson(data) {
	try {
		const p = {
			configuration: Buffer.from(String(data.configuration), 'hex'),
			support: Buffer.from(String(data.support), 'hex'),
		};
		return isValidProfile(p) ? p : null;
	} catch {
		return null;
	}
}

/**
 * @returns {Set<string>} IPv4/IPv6 addresses of this host
 */
function localAddresses() {
	const out = new Set(['127.0.0.1', '::1']);
	for (const list of Object.values(os.networkInterfaces())) {
		for (const a of list || []) {
			out.add(a.address);
		}
	}
	return out;
}

/**
 * Resolve a hostname via a DNS-over-HTTPS JSON endpoint.
 *
 * @param {string} url endpoint with query
 * @returns {Promise<string[]>} A records
 */
function dohLookup(url) {
	return new Promise((resolve, reject) => {
		const req = https.get(url, { headers: { accept: 'application/dns-json' }, timeout: 4000 }, res => {
			let data = '';
			res.setEncoding('utf8');
			res.on('data', d => (data += d));
			res.on('end', () => {
				try {
					const json = JSON.parse(data);
					resolve((json.Answer || []).filter(a => a.type === 1).map(a => String(a.data)));
				} catch (e) {
					reject(e);
				}
			});
		});
		req.on('timeout', () => req.destroy(new Error('timeout')));
		req.on('error', reject);
	});
}

class Link {
	/**
	 * @param {import('node:tls').TLSSocket} socket thermostat socket
	 * @param {string} who description for logs
	 */
	constructor(socket, who) {
		this.socket = socket;
		this.who = who;
		this.serial = null;
		this.upstream = null;
		this.reader = new FrameReader();
		this.downReader = new FrameReader();
		this.downParsing = true;
		this.raw = false;
		this.answering = false;
		this.closed = false;
		this.state = null;
		this.schedule = null;
		this.configuration = null;
		this.support = null;
		this.sent = new Set();
		this.pending = new Map();
		this.lock = Promise.resolve();
		/** @type {'wg4'|'wd5'} */
		this.variant = 'wg4';
		/** @type {Buffer|null} last complete state the vendor gateway sent (WD5) */
		this.wd5Template = null;
		/** @type {Record<string, any>} last known values (WD5) */
		this.wd5Values = {};
		this.wd5Ready = false;
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
	 * @param {Map<string, Profile>} [opts.profiles] recorded profiles by serial
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
		this.upstreamHost = opts.upstreamHost || '';
		this.upstreamPort = opts.upstreamPort || opts.listenPort;
		this.upstreamIp = opts.upstreamIp || '';
		this.upstreamPin = String(opts.upstreamPin || '')
			.replace(/:/g, '')
			.trim()
			.toLowerCase();
		this.dnsServers = opts.dnsServers && opts.dnsServers.length ? opts.dnsServers : DEFAULT_DNS_SERVERS;
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

		this.allowLocalUpstream = !!opts.allowLocalUpstream;
		this.cachedUpstreamIp = opts.cachedUpstreamIp || '';
		/** @type {{ip: string, at: number}|null} */
		this.resolved = null;
		this.upstreamStatus = null;
		this.upstreamFingerprint = null;
		this.links = new Map();
		this.allLinks = new Set();
		this.sequence = FIRST_SEQUENCE - 1;
		this.history = [];
		this.server = null;
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
		if (!link || link.closed || link.raw) {
			return false;
		}
		return link.variant === 'wd5' ? link.wd5Ready : !!link.state;
	}

	/**
	 * @param {string} serial serial number
	 * @returns {{variant: string, timeZoneSec: number|null}|null} info about a connected thermostat
	 */
	info(serial) {
		const link = this.links.get(serial);
		if (!link) {
			return null;
		}
		const tz = link.wd5Values.timeZoneSec;
		return { variant: link.variant, timeZoneSec: Number.isFinite(tz) ? tz : null };
	}

	/**
	 * Change the mode of a WD5 thermostat and wait for its confirmation.
	 * The command is built like the vendor gateway's: the last complete state
	 * it sent (or one built from known values) with mode, setpoint and end
	 * time changed.
	 *
	 * @param {string} serial serial number
	 * @param {{mode: number, tempC?: number, end?: Date|null}} change change
	 * @returns {Promise<void>} resolves when acknowledged
	 */
	setModeWd5(serial, change) {
		const link = this.links.get(serial);
		if (!link || link.variant !== 'wd5') {
			return Promise.reject(new Error('The WD5 thermostat is not connected to the local gateway.'));
		}
		const run = async () => {
			if (link.closed) {
				throw new Error('The thermostat disconnected from the local gateway.');
			}
			if (!link.wd5Ready) {
				throw new Error('The thermostat has not reported its state yet.');
			}
			const base = link.wd5Template || W.defaultState(link.wd5Values);
			const state = W.changedState(base, change);
			await this._sendCommand(link, seq => W.command(seq, state));
			link.wd5Template = state;
			this._observeWd5(link, Message.parse(encodeField(W.FIELD_STATE, state)), false);
		};
		const p = link.lock.then(run, run);
		link.lock = p.catch(() => {});
		return p;
	}

	/**
	 * @param {string} serial serial number
	 * @returns {boolean} relayed to the vendor's gateway
	 */
	isRelayed(serial) {
		const link = this.links.get(serial);
		return !!link && !!link.upstream;
	}

	// ------------------------------------------------------------------------
	// Commands
	// ------------------------------------------------------------------------

	/**
	 * Put a thermostat into a regulation mode and wait for its confirmation.
	 * Never queued for later: a setpoint applied hours late does more harm
	 * than an error.
	 *
	 * @param {string} serial serial number
	 * @param {number} mode regulation mode (1 schedule, 2 temporary, 3 permanent)
	 * @param {number|null} [tempC] setpoint in °C for a hold
	 * @returns {Promise<void>} resolves when acknowledged
	 */
	setMode(serial, mode, tempC = null) {
		const link = this.links.get(serial);
		if (!link) {
			return Promise.reject(new Error('The thermostat is not connected to the local gateway.'));
		}
		const run = async () => {
			if (link.closed) {
				throw new Error('The thermostat disconnected from the local gateway.');
			}
			if (link.raw) {
				throw new Error('The protocol of this thermostat is not understood (pass-through only).');
			}
			if (!link.state) {
				throw new Error('The thermostat has not reported its state yet.');
			}
			const state = P.changedState(link.state, mode, tempC);
			await this._sendCommand(link, seq => P.command(seq, state, link.schedule));
			link.state = state;
			const decoded = P.decodeState(Message.parse(encodeField(P.FIELD_STATE, state)));
			this._emitState(link.serial, decoded);
		};
		const p = link.lock.then(run, run);
		link.lock = p.catch(() => {});
		return p;
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
			if (!link.serial) {
				const wd5 = P.loginSerial(message) ? null : P.wd5Login(message);
				if (wd5) {
					this._onWd5Login(link, body, wd5);
					continue;
				}
				if (!P.loginSerial(message)) {
					this._unknownProtocol(
						link,
						new Error('the first message is not a login with a serial number'),
						bodies.slice(i),
					);
					return;
				}
				this._onLogin(link, body, message);
				continue;
			}
			this._log('Thermostat', link, message);
			if (link.variant === 'wd5') {
				if (W.isAnswer(message) && this._acknowledged(link, message)) {
					continue; // the vendor gateway never sent this command
				}
				this._observeWd5(link, message, true);
				if (link.answering) {
					this._serveWd5(link, message);
					continue;
				}
				if (link.upstream) {
					link.upstream.write(encodeFrame(body));
				} else {
					link.queued.push(body);
				}
				continue;
			}
			if (message.has(P.FIELD_LOGIN)) {
				throw new Error('A second login on the same connection');
			}
			if (link.upstream && !link.answering) {
				if (P.isAnswer(message) && this._acknowledged(link, message)) {
					continue; // the vendor's gateway never sent this command
				}
				this._observe(link, message);
				link.upstream.write(encodeFrame(body));
			} else if (link.answering) {
				this._serveLocally(link, message);
			} else {
				// waiting for the upstream connection: keep the frame
				link.queued = link.queued || [];
				link.queued.push(body);
			}
		}
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
			this._openUpstream()
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

	_onLogin(link, body, message) {
		const serial = P.loginSerial(message);
		if (!serial) {
			throw new Error('The first message is not a login with a serial number');
		}
		link.serial = serial;
		this._event(`Thermostat ${serial} logged in from ${link.who}`);
		if (this.allowedSerials.size && !this.allowedSerials.has(serial)) {
			if (this.mode === 'local') {
				this._event(`Refusing thermostat ${serial}: it is not on the account`, 'warn');
				this._close(link);
				return;
			}
			// Relay never blocks a thermostat: the serial in the login may be
			// formatted differently from the one the cloud reports.
			this._event(
				`Thermostat ${serial} is not among the known serials (${[...this.allowedSerials].join(', ')}); relaying anyway`,
				'warn',
			);
		}
		link.login = body;
		link.queued = [];

		if (this.mode === 'local') {
			this._startAnswering(link, false);
			return;
		}

		link.socket.pause();
		this._openUpstream()
			.then(up => {
				if (link.closed) {
					up?.destroy();
					return;
				}
				if (!up) {
					this._startAnswering(link, true);
					return;
				}
				this._attachUpstream(link, up);
				up.write(encodeFrame(body));
				this._connected(link);
				for (const queued of link.queued.splice(0)) {
					this._onThermostatData(link, encodeFrame(queued));
				}
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
	}

	/**
	 * WD5-series login. The protocol after the login is not decoded yet, so
	 * the thermostat is only relayed (frames are logged for analysis).
	 *
	 * @param {Link} link link
	 * @param {Buffer} body login frame body
	 * @param {{serial: string, deviceType: number|null, firmware: string, clock: string}} info login data
	 */
	_onWd5Login(link, body, info) {
		link.serial = info.serial;
		link.variant = 'wd5';
		link.login = body;
		link.queued = [];
		this._event(
			`WD5 thermostat ${info.serial} logged in from ${link.who} ` +
				`(type ${info.deviceType}, firmware ${info.firmware || '?'}, clock ${info.clock || '?'})`,
			'info',
		);
		this._emitState(info.serial, { firmware: info.firmware });
		if (this.mode === 'local') {
			this._answerWd5(link, false);
			return;
		}
		link.socket.pause();
		this._openUpstream()
			.then(up => {
				if (link.closed) {
					up?.destroy();
					return;
				}
				if (!up) {
					// Keep the thermostat under control while the cloud is away.
					this._answerWd5(link, true);
					return;
				}
				this._attachUpstream(link, up);
				up.write(encodeFrame(body));
				this._connected(link);
				for (const queued of link.queued.splice(0)) {
					up.write(encodeFrame(queued));
				}
			})
			.catch(e => {
				this._event(`Relay setup failed for ${info.serial}: ${e?.message || e}`);
				this._close(link);
			})
			.finally(() => {
				if (!link.closed) {
					link.socket.resume();
				}
			});
	}

	/**
	 * Answer a WD5 thermostat locally, the way the vendor gateway does.
	 *
	 * @param {Link} link link
	 * @param {boolean} retryUpstream relay mode: try the vendor gateway again
	 */
	_answerWd5(link, retryUpstream) {
		link.answering = true;
		const seq = Message.parse(link.login || Buffer.alloc(0)).varint(1) || 0;
		link.socket.write(Buffer.concat([encodeFrame(W.loginAnswer(seq)), encodeFrame(W.uploadRequest())]));
		this._connected(link);
		for (const queued of link.queued.splice(0)) {
			this._onThermostatData(link, encodeFrame(queued));
		}
		if (retryUpstream) {
			this._retryUpstream(link);
		}
	}

	/**
	 * @param {Link} link link
	 * @param {Message} message message of the thermostat
	 */
	_serveWd5(link, message) {
		if (!W.wantsAnswer(message)) {
			return; // acknowledgements need no answer
		}
		link.socket.write(encodeFrame(W.answer(message.varint(1) || 0)));
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
			this._openUpstream()
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
		if (!link.downParsing) {
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
			try {
				const message = Message.parse(body);
				this._log('Vendor gateway', link, message);
				if (link.variant === 'wd5') {
					const state = message.data(W.FIELD_STATE);
					if (state) {
						// A change made in the vendor's app; also the template for own commands.
						link.wd5Template = Buffer.from(state);
					}
					this._observeWd5(link, message, false);
					continue;
				}
				this._record(link, encodeFrame(body), message);
				// A change made in the vendor's app arrives as a command.
				this._observe(link, message);
			} catch {
				this._event(
					`The vendor gateway sent ${this._name(link)} a message of ${body.length} bytes that is not understood`,
				);
			}
		}
	}

	_startAnswering(link, retryUpstream) {
		const profile = this.profiles.get(link.serial);
		if (!profile) {
			this._event(
				`Refusing thermostat ${link.serial}: no recorded profile to answer it with yet ` +
					'(run relay mode with a working internet connection once)',
				'warn',
			);
			this._close(link);
			return;
		}
		link.answering = true;
		const seq = Message.parse(link.login).varint(P.FIELD_SEQUENCE) || 0;
		link.socket.write(encodeFrame(P.loginAcknowledgement(seq)));
		this._connected(link);
		for (const queued of (link.queued || []).splice(0)) {
			this._onThermostatData(link, encodeFrame(queued));
		}
		if (retryUpstream) {
			this._retryUpstream(link);
		}
	}

	_serveLocally(link, message) {
		const profile = this.profiles.get(link.serial);
		this._observe(link, message);
		const seq = message.varint(P.FIELD_SEQUENCE) || 0;
		const kind = message.varint(P.FIELD_KIND);
		let answer = null;
		if (kind === P.KIND_SCHEDULE_UPLOAD) {
			answer = Buffer.concat([encodeFrame(P.acknowledgement(seq)), profile.support]);
		} else if (kind === P.KIND_STATE_UPLOAD) {
			answer = Buffer.concat([encodeFrame(P.acknowledgement(seq)), profile.configuration]);
		} else if (P.isAnswer(message)) {
			this._acknowledged(link, message);
			return;
		} else if (seq) {
			answer = encodeFrame(P.acknowledgement(seq));
		}
		if (answer) {
			link.socket.write(answer);
		}
	}

	_record(link, frame, message) {
		const n = P.responseField(message);
		if (n === null) {
			return;
		}
		if (n === P.FIELD_CONFIGURATION) {
			link.configuration = frame;
		} else {
			link.support = frame;
		}
		if (!link.configuration || !link.support) {
			return;
		}
		const profile = { configuration: link.configuration, support: link.support };
		const known = this.profiles.get(link.serial);
		if (known && known.configuration.equals(profile.configuration) && known.support.equals(profile.support)) {
			return;
		}
		this.profiles.set(link.serial, profile);
		this._event(`Recorded the profile of thermostat ${link.serial}`, 'info');
		this.emit('profile', link.serial, profile);
	}

	_acknowledged(link, message) {
		const seq = message.varint(P.FIELD_SEQUENCE);
		if (seq === null || !link.sent.has(seq)) {
			return false;
		}
		link.sent.delete(seq);
		link.pending.get(seq)?.resolve(message.varint(P.FIELD_ACKNOWLEDGED) === 1);
		return true;
	}

	/**
	 * @param {Link} link link
	 * @param {Message} message message
	 * @param {boolean} fromThermostat sent by the thermostat
	 */
	_observeWd5(link, message, fromThermostat) {
		try {
			const fields = { ...W.decodeTelemetry(message), ...W.decodeState(message) };
			if (fromThermostat && (message.has(W.FIELD_STATE) || message.has(7))) {
				link.wd5Ready = true;
			}
			if (Object.keys(fields).length) {
				Object.assign(link.wd5Values, fields);
				this._emitState(link.serial, fields);
			}
		} catch (e) {
			this._event(`A message of ${this._name(link)} could not be decoded: ${e?.message || e}`);
		}
	}

	_observe(link, message) {
		// Decoding must never break a working connection: a message that does
		// not match the known layout is only logged.
		try {
			this._decode(link, message);
		} catch (e) {
			this._event(
				`A message of ${this._name(link)} could not be decoded (${e?.message || e}): ${message.raw.toString('hex')}`,
			);
		}
	}

	_decode(link, message) {
		let fields;
		if (message.has(P.FIELD_STATE) || message.has(P.FIELD_DEVICE_INFO)) {
			fields = P.decodeState(message); // throws on a malformed state before it is kept
		} else {
			fields = P.decodeTelemetry(message);
		}
		const schedule = message.data(P.FIELD_SCHEDULE);
		if (schedule) {
			link.schedule = Buffer.from(schedule);
		}
		const state = message.data(P.FIELD_STATE);
		if (state) {
			link.state = Buffer.from(state);
		}
		if (Object.keys(fields).length) {
			this._emitState(link.serial, fields);
		}
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
	// Upstream (vendor's gateway)
	// ------------------------------------------------------------------------

	/**
	 * Find the real address of the vendor gateway. The local DNS record points
	 * the hostname at this machine, and networks with Pi-hole often block DNS
	 * to other servers, so several ways are tried in turn.
	 *
	 * @returns {Promise<string>} IPv4 address
	 */
	async _resolveUpstream() {
		if (this.upstreamIp) {
			return this.upstreamIp;
		}
		if (!this.upstreamHost) {
			throw new Error('No hostname of the vendor gateway configured');
		}
		if (this.resolved && Date.now() - this.resolved.at < RESOLVE_CACHE_MS) {
			return this.resolved.ip;
		}
		const own = localAddresses();
		const pick = addrs => (addrs || []).find(a => net.isIPv4(a) && !own.has(a)) || null;
		const host = this.upstreamHost;
		/** @type {Array<[string, () => Promise<string[]>]>} */
		const attempts = [
			[
				'public DNS',
				async () => {
					const resolver = new Resolver({ timeout: 1500, tries: 1 });
					resolver.setServers(this.dnsServers);
					return resolver.resolve4(host);
				},
			],
			['DNS over HTTPS (Cloudflare)', () => dohLookup(`https://1.1.1.1/dns-query?name=${host}&type=A`)],
			['DNS over HTTPS (Google)', () => dohLookup(`https://8.8.8.8/resolve?name=${host}&type=A`)],
			['system resolver', async () => (await lookup(host, { all: true, family: 4 })).map(a => a.address)],
		];
		const errors = [];
		for (const [name, fn] of attempts) {
			try {
				const ip = pick(await fn());
				if (ip) {
					if (this.resolved?.ip !== ip) {
						this._event(`Resolved ${host} to ${ip} via ${name}`, 'info');
						this.emit('resolved', ip);
					}
					this.resolved = { ip, at: Date.now() };
					return ip;
				}
				errors.push(`${name}: only local addresses`);
			} catch (e) {
				errors.push(`${name}: ${e?.code || e?.message || e}`);
			}
		}
		if (this.cachedUpstreamIp) {
			this._event(`Using the last known address ${this.cachedUpstreamIp} of ${host} (${errors.join('; ')})`);
			return this.cachedUpstreamIp;
		}
		throw new Error(errors.join('; '));
	}

	/** @returns {Promise<import('node:tls').TLSSocket|null>} trusted upstream socket or null */
	async _openUpstream() {
		let ip;
		try {
			ip = await this._resolveUpstream();
		} catch (e) {
			this._event(`The vendor gateway cannot be resolved: ${e?.message || e}`);
			this._setUpstream(UPSTREAM_STATUS.UNREACHABLE);
			return null;
		}
		if (!this.allowLocalUpstream && localAddresses().has(ip)) {
			this._event(`The configured vendor gateway address ${ip} is this machine; refusing to loop`, 'warn');
			this._setUpstream(UPSTREAM_STATUS.UNREACHABLE);
			return null;
		}
		const socket = await new Promise(resolve => {
			const s = tls.connect({
				host: ip,
				port: this.upstreamPort,
				servername: this.upstreamHost || undefined,
				rejectUnauthorized: false, // self-signed; checked against the pin below
				minVersion: 'TLSv1.2',
				ciphers: CIPHERS,
			});
			const timer = setTimeout(() => {
				s.destroy();
				this._event(`The vendor gateway at ${ip} did not answer in time`);
				resolve(null);
			}, this.timeouts.upstream);
			s.once('secureConnect', () => {
				clearTimeout(timer);
				resolve(s);
			});
			s.once('error', err => {
				clearTimeout(timer);
				this._event(`The vendor gateway at ${ip} cannot be used: ${err?.message || err}`);
				resolve(null);
			});
		});
		if (!socket) {
			this._setUpstream(UPSTREAM_STATUS.UNREACHABLE);
			return null;
		}
		const raw = socket.getPeerCertificate()?.raw;
		const fp = crypto
			.createHash('sha256')
			.update(raw || Buffer.alloc(0))
			.digest('hex');
		this.upstreamFingerprint = fp;
		if (!this.upstreamPin) {
			// Trust on first use: remember the certificate seen now.
			this.upstreamPin = fp;
			this._event(`Pinned the certificate of the vendor gateway at ${ip}: ${fp}`, 'info');
			this.emit('pin', fp);
		} else if (fp !== this.upstreamPin) {
			socket.destroy();
			this._setUpstream(UPSTREAM_STATUS.UNTRUSTED, ip);
			return null;
		}
		this._setUpstream(UPSTREAM_STATUS.CONNECTED, ip);
		return socket;
	}

	_setUpstream(status, ip) {
		if (status === this.upstreamStatus) {
			return;
		}
		this.upstreamStatus = status;
		if (status === UPSTREAM_STATUS.UNTRUSTED) {
			this._event(
				`The certificate of the vendor gateway at ${ip} does not match the pin, so nothing is sent to it. ` +
					`Its SHA-256 fingerprint is ${this.upstreamFingerprint}`,
				'warn',
			);
		} else {
			this._event(`The vendor gateway is ${status}`, 'info');
		}
		this.emit('upstream', status);
	}

	// ------------------------------------------------------------------------
	// Logging
	// ------------------------------------------------------------------------

	_log(sender, link, message) {
		const text = link.variant === 'wd5' ? P.dump(message) : P.describe(message);
		this._event(`${sender} (thermostat ${link.serial}): ${text}`);
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

module.exports = {
	LocalGateway,
	UPSTREAM_STATUS,
	profileToJson,
	profileFromJson,
	isValidProfile,
};
