/* eslint-disable jsdoc/require-jsdoc */
'use strict';

// ============================================================================
// Connection to the vendor's device gateway (used by the relay)
//
// The local DNS record points the gateway hostname at this machine, so the
// real address is resolved via public DNS, DNS over HTTPS, the system
// resolver (private answers are ignored) or the last address that worked.
// The vendor's certificate is self-signed; it is pinned on first use and
// compared on every connection.
// ============================================================================

const { EventEmitter } = require('node:events');
const tls = require('node:tls');
const crypto = require('node:crypto');
const net = require('node:net');
const { Resolver, lookup } = require('node:dns').promises;

const { isPrivateIPv4, localAddresses, dohLookup } = require('./net');

const DEFAULT_DNS_SERVERS = ['1.1.1.1', '8.8.8.8'];
const RESOLVE_CACHE_MS = 3600_000;
const UPSTREAM_TIMEOUT_MS = 10_000;

const UPSTREAM_STATUS = Object.freeze({
	CONNECTED: 'connected',
	UNREACHABLE: 'unreachable',
	UNTRUSTED: 'untrusted',
});

/**
 * Events: 'log' (level, text), 'status' (status), 'resolved' (ip), 'pin' (fingerprint).
 */
class VendorGateway extends EventEmitter {
	/**
	 * @param {object} opts options
	 * @param {string} [opts.host] hostname of the vendor's device gateway
	 * @param {number} opts.port port of the vendor's device gateway
	 * @param {string} [opts.ip] fixed address
	 * @param {string} [opts.pin] SHA-256 fingerprint (hex) of the vendor's certificate
	 * @param {string[]} [opts.dnsServers] public DNS servers
	 * @param {string} [opts.cachedIp] last address that worked (fallback)
	 * @param {boolean} [opts.allowLocal] allow an address on this machine (tests)
	 * @param {number} [opts.timeoutMs] connect timeout
	 * @param {string} opts.ciphers TLS cipher list
	 */
	constructor(opts) {
		super();
		this.host = opts.host || '';
		this.port = opts.port;
		this.ip = opts.ip || '';
		this.pin = String(opts.pin || '')
			.replace(/:/g, '')
			.trim()
			.toLowerCase();
		this.dnsServers = opts.dnsServers && opts.dnsServers.length ? opts.dnsServers : DEFAULT_DNS_SERVERS;
		this.cachedIp = opts.cachedIp || '';
		this.allowLocal = !!opts.allowLocal;
		this.timeoutMs = opts.timeoutMs || UPSTREAM_TIMEOUT_MS;
		this.ciphers = opts.ciphers;
		/** @type {{ip: string, at: number}|null} */
		this.resolved = null;
		/** @type {string|null} */
		this.status = null;
		/** @type {string|null} */
		this.fingerprint = null;
	}

	_event(text, level = 'debug') {
		this.emit('log', level, text);
	}

	/**
	 * Find the real address of the vendor gateway. The local DNS record points
	 * the hostname at this machine, and networks with Pi-hole often block DNS
	 * to other servers, so several ways are tried in turn.
	 *
	 * @returns {Promise<string>} IPv4 address
	 */
	async resolve() {
		if (this.ip) {
			return this.ip;
		}
		if (!this.host) {
			throw new Error('No hostname of the vendor gateway configured');
		}
		if (this.resolved && Date.now() - this.resolved.at < RESOLVE_CACHE_MS) {
			return this.resolved.ip;
		}
		const own = localAddresses();
		const pick = addrs =>
			(addrs || []).find(a => net.isIPv4(a) && !own.has(a) && (this.allowLocal || !isPrivateIPv4(a))) || null;
		const host = this.host;
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
		if (this.cachedIp) {
			this._event(`Using the last known address ${this.cachedIp} of ${host} (${errors.join('; ')})`);
			return this.cachedIp;
		}
		throw new Error(errors.join('; '));
	}

	/** @returns {Promise<import('node:tls').TLSSocket|null>} trusted upstream socket or null */
	async open() {
		let ip;
		try {
			ip = await this.resolve();
		} catch (e) {
			this._event(`The vendor gateway cannot be resolved: ${e?.message || e}`);
			this._setStatus(UPSTREAM_STATUS.UNREACHABLE);
			return null;
		}
		if (!this.allowLocal && localAddresses().has(ip)) {
			this._event(`The configured vendor gateway address ${ip} is this machine; refusing to loop`, 'warn');
			this._setStatus(UPSTREAM_STATUS.UNREACHABLE);
			return null;
		}
		const socket = await new Promise(resolve => {
			const s = tls.connect({
				host: ip,
				port: this.port,
				servername: this.host || undefined,
				rejectUnauthorized: false, // self-signed; checked against the pin below
				minVersion: 'TLSv1.2',
				ciphers: this.ciphers,
			});
			const timer = setTimeout(() => {
				s.destroy();
				this._event(`The vendor gateway at ${ip} did not answer in time`);
				resolve(null);
			}, this.timeoutMs);
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
			this._setStatus(UPSTREAM_STATUS.UNREACHABLE);
			return null;
		}
		const raw = socket.getPeerCertificate()?.raw;
		const fp = crypto
			.createHash('sha256')
			.update(raw || Buffer.alloc(0))
			.digest('hex');
		this.fingerprint = fp;
		if (!this.pin) {
			// Trust on first use: remember the certificate seen now.
			this.pin = fp;
			this._event(`Pinned the certificate of the vendor gateway at ${ip}: ${fp}`, 'info');
			this.emit('pin', fp);
		} else if (fp !== this.pin) {
			socket.destroy();
			this._setStatus(UPSTREAM_STATUS.UNTRUSTED, ip);
			return null;
		}
		this._setStatus(UPSTREAM_STATUS.CONNECTED, ip);
		return socket;
	}

	_setStatus(status, ip) {
		if (status === this.status) {
			return;
		}
		this.status = status;
		if (status === UPSTREAM_STATUS.UNTRUSTED) {
			this._event(
				`The certificate of the vendor gateway at ${ip} does not match the pin, so nothing is sent to it. ` +
					`Its SHA-256 fingerprint is ${this.fingerprint}`,
				'warn',
			);
		} else {
			this._event(`The vendor gateway is ${status}`, 'info');
		}
		this.emit('status', status);
	}
}

module.exports = { VendorGateway, UPSTREAM_STATUS };
