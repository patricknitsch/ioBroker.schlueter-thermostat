/* eslint-disable jsdoc/require-jsdoc */
'use strict';

// Incoming Cloud → Thermostat Anzeigezeit (lokal, ohne Z)
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

	return stripMsKeepLocalNoZ(s);
}

// 🔥 FIX: Outgoing now Thermostat-Localtime instead of UTC
function nowPlusMinutesThermostatLocalNoZ(minutes, timeZoneSec) {
	const tz = Number.isFinite(timeZoneSec) ? timeZoneSec : 0;
	const utcMs = Date.now() + minutes * 60 * 1000;
	const localMs = utcMs + tz * 1000;

	const d = new Date(localMs);
	const pad = n => String(n).padStart(2, '0');

	return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(
		d.getUTCMinutes(),
	)}:${pad(d.getUTCSeconds())}`;
}

function formatThermostatLocalNoZFromUtcMs(utcMs, timeZoneSec) {
	const tz = Number.isFinite(timeZoneSec) ? timeZoneSec : 0;
	const localMs = utcMs + tz * 1000;
	const d = new Date(localMs);
	const pad = n => String(n).padStart(2, '0');

	return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(
		d.getUTCMinutes(),
	)}:${pad(d.getUTCSeconds())}`;
}

function stripMsKeepLocalNoZ(s) {
	return String(s)
		.replace(/\.\d{1,3}/, '')
		.replace(/[zZ]$/, '');
}

module.exports = {
	toThermostatLocalNoZFromAny,
	nowPlusMinutesThermostatLocalNoZ,
};
