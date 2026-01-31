/* eslint-disable jsdoc/require-jsdoc */
'use strict';

// Incoming EndTime -> thermostat local no-Z:
// - if has Z/offset => parse instant and convert to thermostat local
// - if naive => treat as thermostat local and normalize (strip ms)
function toThermostatLocalNoZFromAny(value, timeZoneSec) {
	if (!value) {
		return '';
	}
	const s = String(value).trim();
	if (!s) {
		return '';
	}

	const hasZone = /[zZ]$/.test(s) || /[+-]\d{2}:?\d{2}$/.test(s);

	if (hasZone) {
		const d = new Date(s);
		if (Number.isNaN(d.getTime())) {
			return '';
		}
		return formatThermostatLocalNoZFromUtcMs(d.getTime(), timeZoneSec);
	}

	const noZone = stripMsKeepLocalNoZ(s);
	const m = noZone.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
	if (!m) {
		return noZone;
	}

	const year = m[1];
	const mon = m[2];
	const day = m[3];
	const hh = m[4];
	const mm = m[5];
	const ss = m[6] ? m[6] : '00';

	return `${year}-${mon}-${day}T${hh}:${mm}:${ss}`;
}

// OUTGOING: UTC without Z, without ms -> "YYYY-MM-DDTHH:mm:ss"
function nowPlusMinutesUtcNoZ(minutes) {
	const utcMs = Date.now() + minutes * 60 * 1000;
	return new Date(utcMs)
		.toISOString()
		.replace(/\.\d{3}Z$/, '')
		.replace(/Z$/, '');
}

function pad2(n) {
	return String(n).padStart(2, '0');
}

function formatThermostatLocalNoZFromUtcMs(utcMs, timeZoneSec) {
	const tz = Number.isFinite(timeZoneSec) ? timeZoneSec : 0;
	const localMs = utcMs + tz * 1000;
	const d = new Date(localMs);

	// use UTC getters because we shifted already
	return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}T${pad2(d.getUTCHours())}:${pad2(
		d.getUTCMinutes(),
	)}:${pad2(d.getUTCSeconds())}`;
}

function stripMsKeepLocalNoZ(s) {
	const x = String(s).trim();
	const msStripped = x.replace(/\.\d{1,3}(?=($|[zZ]|[+-]\d{2}:?\d{2}$))/, '');
	return msStripped.replace(/[zZ]$/, '').replace(/[+-]\d{2}:?\d{2}$/, '');
}

module.exports = {
	toThermostatLocalNoZFromAny,
	nowPlusMinutesUtcNoZ,
};
