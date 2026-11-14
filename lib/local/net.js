'use strict';

// ============================================================================
// Network helpers of the local device gateway.
// ============================================================================

const os = require('node:os');
const https = require('node:https');

/**
 * Private, loopback, link-local or CGNAT IPv4 address. The vendor gateway is
 * always public; a private answer comes from a local DNS record pointing here.
 *
 * @param {string} ip IPv4 address
 * @returns {boolean} private
 */
function isPrivateIPv4(ip) {
	const p = ip.split('.').map(Number);
	return (
		p[0] === 10 ||
		p[0] === 127 ||
		(p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
		(p[0] === 192 && p[1] === 168) ||
		(p[0] === 169 && p[1] === 254) ||
		(p[0] === 100 && p[1] >= 64 && p[1] <= 127)
	);
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

module.exports = { isPrivateIPv4, localAddresses, dohLookup };
