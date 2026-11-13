'use strict';

// ============================================================================
// Device protocol of WD5-series thermostats (OWD5 / MWD5) – BETA
//
// Observed on an OWD5 thermostat with firmware 1013W220. Framing and TLS are
// the same as on WG4; the field layout differs.
//
// Every message: 1 sequence number. An acknowledgement is `1=<seq> 3=1`.
// Messages that want an answer carry 4=1.
//
// Thermostat -> gateway
//   5   login: 5.1 serial, 5.2 device type, 5.3 firmware, 5.5 clock {h,m,s}
//   6   heartbeat (~1/min): 6.1 time, 6.2 room temperature (1/100 °C),
//       6.3 floor temperature (1/100 °C), 6.4 heating, 6.5..6.7 unknown
//   7   device info: 7.2 name, 7.3 time zone (s), 7.16 MAC, …
//   8   schedule: 8.2 days {1 day, 2 events {1 {h,m,s}, 2 temp 1/100 °C, …}}
//   9   state (only the fields that matter for the current mode)
//   12  clock: 12.1 time, 12.2 time zone (s)
//
// Gateway -> thermostat
//   12  login answer / heartbeat answer: 12.1 server time
//   10  after login: 10.1 time, 10.2 = 1 (request for the full upload)
//   9   command: complete state
//
// State (field 9)
//   9.1 time of change, 9.2 regulation mode (cloud codes: 1 schedule,
//   2 comfort, 3 manual, 6 frost protection, 8 boost, 9 eco),
//   9.3 comfort {1 setpoint, 2 end}, 9.4 manual {1 setpoint},
//   9.5 vacation {1 enabled, 2 begin, 3 end, 4 setpoint}, 9.6 boost {1 end},
//   9.7 frost protection {1 setpoint}, 9.8 / 9.9 unknown.
//   Setpoints are in 1/200 °C. Date/times are thermostat-local:
//   {1 {1 year, 2 month, 3 day}, 2 {1 hour, 2 minute, 3 second}}; 1970-01-01
//   means "not set".
//
// Times in 9.1 / 12.1 are seconds since 2000-01-01 UTC.
// ============================================================================

const { Message, encodeField, setField } = require('./protobuf');
const { deviceTime } = require('./protocol');

const FIELD_SEQUENCE = 1;
const FIELD_ACKNOWLEDGED = 3;
const FIELD_WANTS_ANSWER = 4;
const FIELD_TELEMETRY = 6;
const FIELD_DEVICE_INFO = 7;
const FIELD_SCHEDULE = 8;
const FIELD_STATE = 9;

const MODE_SCHEDULE = 1;
const MODE_COMFORT = 2;
const MODE_MANUAL = 3;
const MODE_FROST = 6;
const MODE_BOOST = 8;
const MODE_ECO = 9;
const MODE_VACATION = 4;

const S_TIME = 1;
const S_MODE = 2;
const S_COMFORT = 3;
const S_MANUAL = 4;
const S_VACATION = 5;
const S_BOOST = 6;
const S_FROST = 7;

const SETPOINT_SCALE = 200;

/**
 * @param {number} v wire setpoint (1/200 °C)
 * @returns {number} °C
 */
function spToC(v) {
	return Math.round((v * 100) / SETPOINT_SCALE) / 100;
}

/**
 * @param {number} c °C
 * @returns {number} wire setpoint (1/200 °C)
 */
function cToSp(c) {
	return Math.round(c * SETPOINT_SCALE);
}

/**
 * Decode a local date/time struct.
 *
 * @param {Message|null} m struct
 * @returns {string} `YYYY-MM-DDTHH:MM:SS` (thermostat-local), '' if not set
 */
function decodeDateTime(m) {
	if (!m) {
		return '';
	}
	const d = m.message(1);
	const t = m.message(2);
	const y = d?.varint(1) ?? 0;
	if (!y || y <= 1970) {
		return '';
	}
	const p = v => String(v ?? 0).padStart(2, '0');
	return `${y}-${p(d?.varint(2))}-${p(d?.varint(3))}T${p(t?.varint(1))}:${p(t?.varint(2))}:${p(t?.varint(3))}`;
}

/**
 * Decode a date struct {1 year, 2 month, 3 day} in the cloud's format.
 *
 * @param {Message|null} d struct
 * @returns {string} `YYYY-MM-DDT00:00:00`, '' if not set (1970)
 */
function decodeDate(d) {
	const y = d?.varint(1) ?? 0;
	if (!y || y <= 1970) {
		return '';
	}
	const p = v => String(v ?? 0).padStart(2, '0');
	return `${y}-${p(d?.varint(2))}-${p(d?.varint(3))}T00:00:00`;
}

/**
 * Encode a date struct {1 year, 2 month, 3 day}.
 *
 * @param {{y: number, m: number, d: number}|null} date date; null = not set (1970-01-01)
 * @returns {Buffer} struct
 */
function encodeDate(date) {
	const v = date || { y: 1970, m: 1, d: 1 };
	return Buffer.concat([encodeField(1, v.y), encodeField(2, v.m), encodeField(3, v.d)]);
}

/**
 * Parse a vacation day as the adapter states hold it (`YYYY-MM-DD`,
 * `YYYY-MM-DDTHH:MM:SS` or `DD.MM.YYYY`).
 *
 * @param {string} text day
 * @returns {{y: number, m: number, d: number}|null} date, null if not a valid day
 */
function parseDay(text) {
	const s = String(text || '').trim();
	let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
	let y;
	let mo;
	let d;
	if (m) {
		[y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
	} else {
		m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s);
		if (!m) {
			return null;
		}
		[y, mo, d] = [Number(m[3]), Number(m[2]), Number(m[1])];
	}
	const check = new Date(Date.UTC(y, mo - 1, d));
	if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) {
		return null;
	}
	return { y, m: mo, d };
}

/**
 * Encode a local date/time struct.
 *
 * @param {Date|null} local Date whose UTC fields hold the thermostat-local time; null = not set
 * @returns {Buffer} struct
 */
function encodeDateTime(local) {
	const y = local ? local.getUTCFullYear() : 1970;
	const mo = local ? local.getUTCMonth() + 1 : 1;
	const d = local ? local.getUTCDate() : 1;
	const h = local ? local.getUTCHours() : 0;
	const mi = local ? local.getUTCMinutes() : 0;
	const s = local ? local.getUTCSeconds() : 0;
	return Buffer.concat([
		encodeField(1, Buffer.concat([encodeField(1, y), encodeField(2, mo), encodeField(3, d)])),
		encodeField(2, Buffer.concat([encodeField(1, h), encodeField(2, mi), encodeField(3, s)])),
	]);
}

/**
 * Heartbeat (field 6).
 *
 * @param {Message} message message
 * @returns {Record<string, any>} decoded values
 */
function decodeTelemetry(message) {
	const out = {};
	const t = message.message(FIELD_TELEMETRY);
	if (!t) {
		return out;
	}
	const room = t.varint(2);
	const floor = t.varint(3);
	const heating = t.varint(4);
	if (room !== null) {
		out.roomTemperature = room / 100;
	}
	if (floor !== null) {
		out.floorTemperature = floor / 100;
	}
	if (heating !== null) {
		out.heating = heating === 1;
	}
	return out;
}

/**
 * State (field 9) and device info (field 7).
 *
 * @param {Message} message message
 * @returns {Record<string, any>} decoded values
 */
function decodeState(message) {
	const out = {};
	const s = message.message(FIELD_STATE);
	if (s) {
		const mode = s.varint(S_MODE);
		if (mode !== null) {
			out.regulationMode = mode;
		}
		const comfort = s.message(S_COMFORT);
		if (comfort) {
			const sp = comfort.varint(1);
			if (sp !== null) {
				out.comfortSetpoint = spToC(sp);
			}
			out.comfortEnd = decodeDateTime(comfort.message(2));
		}
		const manual = s.message(S_MANUAL);
		const msp = manual?.varint(1);
		if (msp !== null && msp !== undefined) {
			out.manualSetpoint = spToC(msp);
		}
		const boost = s.message(S_BOOST);
		if (boost) {
			out.boostEnd = decodeDateTime(boost.message(1));
		}
		const vacation = s.message(S_VACATION);
		if (vacation) {
			const en = vacation.varint(1);
			if (en !== null) {
				out.vacationEnabled = en === 1;
			}
			const vsp = vacation.varint(4);
			if (vsp !== null) {
				out.vacationSetpoint = spToC(vsp);
			}
			if (vacation.has(2)) {
				out.vacationBegin = decodeDate(vacation.message(2));
			}
			if (vacation.has(3)) {
				out.vacationEnd = decodeDate(vacation.message(3));
			}
		}
		const fsp = s.message(S_FROST)?.varint(1);
		if (fsp !== null && fsp !== undefined) {
			out.frostProtectionSetpoint = spToC(fsp);
		}
	}
	const info = message.message(FIELD_DEVICE_INFO);
	if (info) {
		const name = info.data(2);
		if (name) {
			out.room = name.toString('utf8');
		}
		const tz = info.varint(3);
		if (tz !== null) {
			out.timeZoneSec = tz;
		}
		const load = info.varint(17);
		if (load !== null) {
			out.loadWatts = load;
		}
	}
	return out;
}

/**
 * A complete state as the vendor gateway sends it, built from known values.
 * Used when no command of the vendor gateway has been seen yet.
 *
 * @param {{comfortSetpoint?: number, manualSetpoint?: number, vacationSetpoint?: number, frostProtectionSetpoint?: number}} v known values in °C
 * @returns {Buffer} encoded state
 */
function defaultState(v) {
	const unset = encodeDateTime(null);
	const unsetDate = Buffer.concat([encodeField(1, 1970), encodeField(2, 1), encodeField(3, 1)]);
	return Buffer.concat([
		encodeField(S_TIME, deviceTime()),
		encodeField(S_MODE, MODE_SCHEDULE),
		encodeField(S_COMFORT, Buffer.concat([encodeField(1, cToSp(v.comfortSetpoint ?? 21)), encodeField(2, unset)])),
		encodeField(S_MANUAL, encodeField(1, cToSp(v.manualSetpoint ?? 0))),
		encodeField(
			S_VACATION,
			Buffer.concat([
				encodeField(1, 0),
				encodeField(2, unsetDate),
				encodeField(3, unsetDate),
				encodeField(4, cToSp(v.vacationSetpoint ?? 5)),
			]),
		),
		encodeField(S_BOOST, encodeField(1, unset)),
		encodeField(S_FROST, encodeField(1, cToSp(v.frostProtectionSetpoint ?? 5))),
		encodeField(8, 1),
		encodeField(9, 0),
	]);
}

/**
 * Change a complete state for a new mode.
 *
 * @param {Buffer} base complete state (template)
 * @param {object} change change
 * @param {number} [change.mode] regulation mode; omitted = keep
 * @param {{enabled: boolean, begin: {y: number, m: number, d: number}|null, end: {y: number, m: number, d: number}|null}} [change.vacation] vacation
 * @param {number} [change.tempC] setpoint for comfort / manual in °C
 * @param {Date|null} [change.end] end of comfort / boost (UTC fields = thermostat-local time)
 * @param {Date} [moment] time of change
 * @returns {Buffer} encoded state
 */
function changedState(base, change, moment) {
	let s = setField(base, S_TIME, deviceTime(moment));
	if (change.mode !== undefined) {
		s = setField(s, S_MODE, change.mode);
	}
	const sub = n => Message.parse(s).data(n) || Buffer.alloc(0);
	if (change.vacation) {
		// Like the vendor gateway: enabled flag and days; the vacation
		// setpoint (9.5.4) is kept as the thermostat has it.
		let v = sub(S_VACATION);
		v = setField(v, 1, change.vacation.enabled ? 1 : 0);
		v = setField(v, 2, encodeDate(change.vacation.begin));
		v = setField(v, 3, encodeDate(change.vacation.end));
		s = setField(s, S_VACATION, v);
	}
	if (change.mode === MODE_MANUAL && change.tempC !== undefined) {
		s = setField(s, S_MANUAL, setField(sub(S_MANUAL), 1, cToSp(change.tempC)));
	}
	if (change.mode === MODE_COMFORT) {
		let c = sub(S_COMFORT);
		if (change.tempC !== undefined) {
			c = setField(c, 1, cToSp(change.tempC));
		}
		c = setField(c, 2, encodeDateTime(change.end || null));
		s = setField(s, S_COMFORT, c);
	}
	if (change.mode === MODE_BOOST) {
		s = setField(s, S_BOOST, setField(sub(S_BOOST), 1, encodeDateTime(change.end || null)));
	}
	return s;
}

/**
 * Command message like the vendor gateway sends it.
 *
 * @param {number} sequence sequence number
 * @param {Buffer} state complete state
 * @returns {Buffer} message
 */
function command(sequence, state) {
	return Buffer.concat([
		encodeField(FIELD_SEQUENCE, sequence),
		encodeField(FIELD_WANTS_ANSWER, 1),
		encodeField(FIELD_STATE, state),
	]);
}

/**
 * @param {Message} message message
 * @returns {boolean} an acknowledgement (`1=<seq> 3=1`)
 */
function isAnswer(message) {
	return message.has(FIELD_ACKNOWLEDGED) && !message.has(FIELD_WANTS_ANSWER);
}

/**
 * Local "now + minutes" as Date whose UTC fields hold the thermostat-local time.
 *
 * @param {number} minutes minutes from now
 * @param {number} tzSec offset of the thermostat to UTC in seconds
 * @returns {Date} local time
 */
function localIn(minutes, tzSec) {
	return new Date(Date.now() + minutes * 60_000 + tzSec * 1000);
}

/**
 * Answer to a message that wants one (4=1), like the vendor gateway sends it:
 * `1=<seq> 3=1 12={1=server time}`.
 *
 * @param {number} sequence sequence number of the message
 * @param {Date} [moment] server time
 * @returns {Buffer} message
 */
function answer(sequence, moment) {
	return Buffer.concat([
		encodeField(FIELD_SEQUENCE, sequence),
		encodeField(FIELD_ACKNOWLEDGED, 1),
		encodeField(12, encodeField(1, deviceTime(moment))),
	]);
}

/**
 * Answer to the login: `1=<seq> 3=1 4=1 12={1=server time}`.
 *
 * @param {number} sequence sequence number of the login
 * @param {Date} [moment] server time
 * @returns {Buffer} message
 */
function loginAnswer(sequence, moment) {
	return Buffer.concat([
		encodeField(FIELD_SEQUENCE, sequence),
		encodeField(FIELD_ACKNOWLEDGED, 1),
		encodeField(FIELD_WANTS_ANSWER, 1),
		encodeField(12, encodeField(1, deviceTime(moment))),
	]);
}

/**
 * Request for the full upload, sent after the login answer:
 * `1=0 4=1 10={1=server time 2=1}`.
 *
 * @param {Date} [moment] server time
 * @returns {Buffer} message
 */
function uploadRequest(moment) {
	return Buffer.concat([
		encodeField(FIELD_SEQUENCE, 0),
		encodeField(FIELD_WANTS_ANSWER, 1),
		encodeField(10, Buffer.concat([encodeField(1, deviceTime(moment)), encodeField(2, 1)])),
	]);
}

/**
 * @param {Message} message message
 * @returns {boolean} the message wants an answer
 */
function wantsAnswer(message) {
	return message.varint(FIELD_WANTS_ANSWER) === 1 && !message.has(FIELD_ACKNOWLEDGED);
}

/**
 * Weekly schedule (field 8): 8.2 holds the days as repeated field 1
 * {1 day (1 = Monday?), 2 events (repeated)}; an event is
 * {1 {h, m, s}, 2 temperature in 1/100 °C, 3 flag (probably "active"),
 * 4 flag (probably "next day")}.
 *
 * @param {Message} message message
 * @returns {Array<{day: number, events: Array<{time: string, temperature: number, active: boolean, nextDay: boolean}>}>|null} schedule
 */
function decodeSchedule(message) {
	const schedule = message.message(FIELD_SCHEDULE);
	const week = schedule?.message(2);
	if (!week) {
		return null;
	}
	const pad = v => String(v ?? 0).padStart(2, '0');
	const days = [];
	for (const f of week.fields) {
		if (f.number !== 1 || !Buffer.isBuffer(f.value)) {
			continue;
		}
		const day = Message.parse(f.value);
		const events = [];
		for (const e of day.fields) {
			if (e.number !== 2 || !Buffer.isBuffer(e.value)) {
				continue;
			}
			const ev = Message.parse(e.value);
			const t = ev.message(1);
			events.push({
				time: `${pad(t?.varint(1))}:${pad(t?.varint(2))}:${pad(t?.varint(3))}`,
				temperature: (ev.varint(2) ?? 0) / 100,
				active: ev.varint(3) === 1,
				nextDay: ev.varint(4) === 1,
			});
		}
		days.push({ day: day.varint(1) ?? 0, events });
	}
	return days;
}

/**
 * Regulation mode for a vacation change, like the vendor gateway sets it:
 * a vacation that has begun (begin <= today <= end) switches to vacation
 * mode at once (observed). Disabling a running vacation returns to the
 * schedule (assumed, not observed yet). Otherwise the mode is kept.
 *
 * @param {{enabled: boolean, begin: {y: number, m: number, d: number}|null, end: {y: number, m: number, d: number}|null}} vacation vacation
 * @param {number|undefined} currentMode current regulation mode
 * @param {Date} todayLocal Date whose UTC fields hold the thermostat-local time
 * @returns {number|undefined} mode to set; undefined = keep
 */
function vacationMode(vacation, currentMode, todayLocal) {
	const key = d => d.y * 10000 + d.m * 100 + d.d;
	const today = key({ y: todayLocal.getUTCFullYear(), m: todayLocal.getUTCMonth() + 1, d: todayLocal.getUTCDate() });
	if (vacation.enabled && vacation.begin && vacation.end) {
		if (key(vacation.begin) <= today && today <= key(vacation.end)) {
			return MODE_VACATION;
		}
		return currentMode === MODE_VACATION ? MODE_SCHEDULE : undefined;
	}
	return currentMode === MODE_VACATION ? MODE_SCHEDULE : undefined;
}

module.exports = {
	FIELD_STATE,
	FIELD_SCHEDULE,
	MODE_SCHEDULE,
	MODE_COMFORT,
	MODE_MANUAL,
	MODE_FROST,
	MODE_BOOST,
	MODE_ECO,
	MODE_VACATION,
	vacationMode,
	decodeTelemetry,
	decodeState,
	decodeSchedule,
	decodeDateTime,
	decodeDate,
	encodeDate,
	parseDay,
	encodeDateTime,
	defaultState,
	changedState,
	command,
	isAnswer,
	answer,
	loginAnswer,
	uploadRequest,
	wantsAnswer,
	localIn,
	spToC,
	cToSp,
};
