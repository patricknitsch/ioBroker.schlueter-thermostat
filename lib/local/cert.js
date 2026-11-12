'use strict';

// ============================================================================
// Self-signed certificate for the local device gateway.
//
// The thermostat connects via TLS but does not validate the server
// certificate, so a self-signed one created on this host is sufficient. It is
// generated once in the instance data directory and reused afterwards.
// ============================================================================

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const CERT_NAME = 'gateway.crt';
const KEY_NAME = 'gateway.key';

/**
 * Create a self-signed RSA-2048 certificate (valid 10 years).
 *
 * @param {string} commonName CN / SAN of the certificate
 * @returns {{cert: string, key: string}} PEM strings
 */
function generateCertificate(commonName) {
	const forge = require('node-forge');
	const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
		modulusLength: 2048,
		publicKeyEncoding: { type: 'spki', format: 'pem' },
		privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
	});

	const cert = forge.pki.createCertificate();
	cert.publicKey = forge.pki.publicKeyFromPem(publicKey);
	cert.serialNumber = `01${crypto.randomBytes(15).toString('hex')}`;
	const now = Date.now();
	cert.validity.notBefore = new Date(now - 24 * 3600 * 1000);
	cert.validity.notAfter = new Date(now + 3650 * 24 * 3600 * 1000);
	const attrs = [{ name: 'commonName', value: commonName }];
	cert.setSubject(attrs);
	cert.setIssuer(attrs);
	cert.setExtensions([{ name: 'subjectAltName', altNames: [{ type: 2, value: commonName }] }]);
	cert.sign(forge.pki.privateKeyFromPem(privateKey), forge.md.sha256.create());

	return { cert: forge.pki.certificateToPem(cert), key: privateKey };
}

/**
 * Return the gateway certificate, generating it on first use.
 *
 * @param {string} dir directory to store the files in
 * @param {string} commonName CN used when generating
 * @returns {{cert: string, key: string, created: boolean}} PEM strings
 */
function ensureCertificate(dir, commonName) {
	const certPath = path.join(dir, CERT_NAME);
	const keyPath = path.join(dir, KEY_NAME);
	if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
		return { cert: fs.readFileSync(certPath, 'utf8'), key: fs.readFileSync(keyPath, 'utf8'), created: false };
	}
	fs.mkdirSync(dir, { recursive: true });
	const { cert, key } = generateCertificate(commonName || 'thermostat-gateway.local');
	fs.writeFileSync(keyPath, key, { mode: 0o600 });
	fs.writeFileSync(certPath, cert);
	return { cert, key, created: true };
}

module.exports = { ensureCertificate, generateCertificate };
