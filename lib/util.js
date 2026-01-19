/* eslint-disable jsdoc/require-jsdoc */
'use strict';

function safeId(id) {
	return String(id).replace(/[^\w.-]/g, '_');
}

// Many values come as integer in hundredths of °C (e.g. 1838 => 18.38)
function numToC(v) {
	if (v === undefined || v === null) {
		return null;
	}
	const n = Number(v);
	if (!Number.isFinite(n)) {
		return null;
	}
	if (Math.abs(n) >= 100) {
		return Math.round((n / 100) * 100) / 100;
	}
	return Math.round(n * 100) / 100;
}

function cToNum(tempC) {
	const n = Number(tempC);
	if (!Number.isFinite(n)) {
		return null;
	}
	return Math.round(n * 100);
}

module.exports = { safeId, numToC, cToNum };
