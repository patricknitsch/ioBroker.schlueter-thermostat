'use strict';

// ============================================================================
// Messages between a thermostat and its device gateway (local mode, beta).
//
// There is no published specification. The field numbers below are those
// observed on WG4-series thermostats. Whether WD5-series thermostats (OWD5 /
// MWD5) use the same layout is NOT confirmed yet – the gateway therefore logs
// every message so the protocol can be verified on real hardware.
//
// Every message has a sequence number in field 1. An acknowledgement repeats
// that number with field 3 = 1. Field 5 is 1 on most messages (meaning unknown).
//
// From the thermostat:
//   field 6          login: 6.1 account e-mail, 6.2 serial number
//   field 2 = 6      upload of schedule and settings
//   field 2 = 4      full upload after login: 7 device info, 8 schedule, 9 state
//   field 9 alone    changed at the wall
//   field 7 alone    device info changed
//   field 15         heartbeat (~1/min): 15.1 floor temp (1/100 °C), 15.2 heating
//   fields 1 and 3   acknowledgement of a command
//
// To the thermostat:
//   field 12         login answer: 12.1 server time
//   field 10         configuration (answer to the full upload)
//   field 18         support information (answer to the schedule upload)
//   fields 8 and 9   command: schedule + state to take over
//
// State (field 9): 9.1 time of change, 9.2 regulation mode, 9.4 temporary hold
// (9.4.1 setpoint, 9.4.2 end time), 9.5 permanent hold (9.5.1 setpoint).
// Device info: 7.2 room name, 7.9 current target setpoint.
//
// Setpoints on the wire are 1/200 °C, the floor temperature 1/100 °C.
// Times are seconds since 2000-01-01 UTC.
// ============================================================================

const { Message, encodeField, setField } = require('./protobuf');

const FIELD_SEQUENCE = 1;
const FIELD_KIND = 2;
const FIELD_ACKNOWLEDGED = 3;
const FIELD_5 = 5;
const FIELD_LOGIN = 6;
const FIELD_DEVICE_INFO = 7;
const FIELD_SCHEDULE = 8;
const FIELD_STATE = 9;
const FIELD_CONFIGURATION = 10;
const FIELD_SERVER_TIME = 12;
const FIELD_TELEMETRY = 15;
const FIELD_SUPPORT = 18;

const KIND_STATE_UPLOAD = 4;
const KIND_SCHEDULE_UPLOAD = 6;

const REGULATION_SCHEDULE = 1;
const REGULATION_COMFORT = 2;
const REGULATION_MANUAL = 3;
const REGULATION_VACATION = 4;

const EPOCH_MS = Date.UTC(2000, 0, 1);
const WIRE_SCALE = 200;

const STATE_TIME = 1;
const STATE_MODE = 2;
const TEMPORARY_HOLD = 4;
const PERMANENT_HOLD = 5;
const HOLD_SETPOINT = 1;
const HOLD_END_TIME = 2;
const LOGIN_SERIAL = 2;
const INFO_ROOM = 2;
const INFO_TARGET = 9;
const TELEMETRY_FLOOR = 1;
const TELEMETRY_HEATING = 2;

const HOLD_FIELDS = { [REGULATION_COMFORT]: TEMPORARY_HOLD, [REGULATION_MANUAL]: PERMANENT_HOLD };
const MODE_NAMES = {
	[REGULATION_SCHEDULE]: 'schedule',
	[REGULATION_COMFORT]: 'temporary hold',
	[REGULATION_MANUAL]: 'permanent hold',
	[REGULATION_VACATION]: 'vacation',
};

/**
 * @param {Date} [moment] moment, now when omitted
 * @returns {number} seconds since 2000-01-01 UTC
 */
function deviceTime(moment) {
	const ms = (moment || new Date()).getTime();
	return Math.floor((ms - EPOCH_MS) / 1000);
}

/**
 * @param {number} seconds device time
 * @returns {Date} as Date
 */
function fromDeviceTime(seconds) {
	return new Date(EPOCH_MS + seconds * 1000);
}

/**
 * @param {number} sequence sequence number
 * @returns {Buffer} acknowledgement message
 */
function acknowledgement(sequence) {
	return Buffer.concat([encodeField(FIELD_SEQUENCE, sequence), encodeField(FIELD_ACKNOWLEDGED, 1)]);
}

/**
 * Answer to a login, which also tells the thermostat the time (UTC).
 *
 * @param {number} sequence sequence number of the login
 * @param {Date} [moment] server time
 * @returns {Buffer} message
 */
function loginAcknowledgement(sequence, moment) {
	return Buffer.concat([
		acknowledgement(sequence),
		encodeField(4, 1),
		encodeField(FIELD_SERVER_TIME, encodeField(1, deviceTime(moment))),
	]);
}

/**
 * @param {Message} message message
 * @returns {string|null} serial number from a login
 */
function loginSerial(message) {
	let login;
	try {
		login = message.message(FIELD_LOGIN);
	} catch {
		return null;
	}
	if (!login) {
		return null;
	}
	const serial = login.data(LOGIN_SERIAL);
	if (!serial || !serial.length) {
		return null;
	}
	return serial.toString('utf8');
}

/**
 * @param {number} setpoint setpoint on the wire (1/200 °C)
 * @returns {number} °C rounded to 0.01
 */
function wireToC(setpoint) {
	return Math.round((setpoint * 100) / WIRE_SCALE) / 100;
}

/**
 * @param {number} tempC °C
 * @returns {number} setpoint on the wire (1/200 °C)
 */
function cToWire(tempC) {
	return Math.round(tempC * WIRE_SCALE);
}

/**
 * @param {Message} state parsed state (field 9)
 * @returns {Record<number, number>} setpoint by hold field
 */
function holdSetpoints(state) {
	/** @type {Record<number, number>} */
	const out = {};
	for (const hold of [TEMPORARY_HOLD, PERMANENT_HOLD]) {
		const m = state.message(hold);
		const sp = m ? m.varint(HOLD_SETPOINT) : null;
		if (sp !== null) {
			out[hold] = sp;
		}
	}
	return out;
}

/**
 * @typedef {{regulationMode?: number, comfortSetpoint?: number, manualSetpoint?: number, targetTemperature?: number, room?: string, floorTemperature?: number, heating?: boolean, online?: boolean, relayed?: boolean}} DecodedState
 */

/**
 * Decode state (field 9) and device info (field 7).
 *
 * @param {Message} message message from the thermostat or a command to it
 * @returns {DecodedState} decoded values
 */
function decodeState(message) {
	const out = {};
	const state = message.message(FIELD_STATE);
	if (state) {
		const mode = state.varint(STATE_MODE);
		if (mode !== null) {
			out.regulationMode = mode;
		}
		const sps = holdSetpoints(state);
		if (sps[TEMPORARY_HOLD] !== undefined) {
			out.comfortSetpoint = wireToC(sps[TEMPORARY_HOLD]);
		}
		if (sps[PERMANENT_HOLD] !== undefined) {
			out.manualSetpoint = wireToC(sps[PERMANENT_HOLD]);
		}
		const active = mode === null ? undefined : HOLD_FIELDS[mode];
		if (active !== undefined && sps[active] !== undefined) {
			out.targetTemperature = wireToC(sps[active]);
		}
	}
	const info = message.message(FIELD_DEVICE_INFO);
	if (info) {
		const room = info.data(INFO_ROOM);
		if (room) {
			out.room = room.toString('utf8');
		}
		const target = info.varint(INFO_TARGET);
		if (target !== null) {
			out.targetTemperature = wireToC(target);
		}
	}
	return out;
}

/**
 * Decode the heartbeat (field 15).
 *
 * @param {Message} message message from the thermostat
 * @returns {DecodedState} decoded values
 */
function decodeTelemetry(message) {
	const out = {};
	const t = message.message(FIELD_TELEMETRY);
	if (!t) {
		return out;
	}
	const floor = t.varint(TELEMETRY_FLOOR);
	if (floor !== null) {
		out.floorTemperature = Math.round(floor) / 100;
	}
	const heating = t.varint(TELEMETRY_HEATING);
	if (heating !== null) {
		out.heating = Boolean(heating);
	}
	return out;
}

/**
 * The thermostat's own state with a new time, mode and (optionally) setpoint.
 *
 * The setpoint of a hold goes into the field of that hold. Everything else
 * stays as the thermostat sent it.
 *
 * @param {Buffer} state last state (field 9) of the thermostat
 * @param {number} mode regulation mode
 * @param {number|null} [tempC] setpoint in °C for temporary/permanent hold
 * @param {Date} [moment] time of change
 * @returns {Buffer} encoded state
 */
function changedState(state, mode, tempC = null, moment) {
	let changed = setField(state, STATE_TIME, deviceTime(moment));
	changed = setField(changed, STATE_MODE, mode);
	const hold = HOLD_FIELDS[mode];
	if (hold !== undefined && tempC !== null && tempC !== undefined) {
		const current = Message.parse(state).data(hold) || Buffer.alloc(0);
		changed = setField(changed, hold, setField(current, HOLD_SETPOINT, cToWire(tempC)));
	}
	return changed;
}

/**
 * Build the command that makes the thermostat take over a state.
 *
 * @param {number} sequence sequence number
 * @param {Buffer} state state to take over
 * @param {Buffer|null} [schedule] last schedule of the thermostat
 * @returns {Buffer} message
 */
function command(sequence, state, schedule) {
	const parts = [encodeField(FIELD_SEQUENCE, sequence), encodeField(FIELD_5, 1)];
	if (schedule && schedule.length) {
		parts.push(encodeField(FIELD_SCHEDULE, schedule));
	}
	parts.push(encodeField(FIELD_STATE, state));
	return Buffer.concat(parts);
}

/**
 * Whether a message is one of the two answers following a login.
 *
 * @param {Message} message message
 * @returns {number|null} FIELD_CONFIGURATION / FIELD_SUPPORT or null
 */
function responseField(message) {
	const numbers = message.numbers;
	for (const n of [FIELD_CONFIGURATION, FIELD_SUPPORT]) {
		const allowed = new Set([FIELD_SEQUENCE, FIELD_5, n]);
		const onlyAllowed = [...numbers].every(x => allowed.has(x));
		if (onlyAllowed && message.count(n) === 1 && message.data(n) !== null) {
			return n;
		}
	}
	return null;
}

/**
 * Whether the thermostat answers a message that was sent to it.
 *
 * @param {Message} message message
 * @returns {boolean} acknowledgement
 */
function isAnswer(message) {
	return message.has(FIELD_ACKNOWLEDGED) && !message.has(FIELD_KIND);
}

/**
 * @param {number|Buffer} value field value
 * @returns {string} short representation
 */
function brief(value) {
	if (typeof value === 'number') {
		return String(value);
	}
	try {
		const fields = Message.parse(value).fields;
		return `{${fields.map(f => `${f.number}: ${typeof f.value === 'number' ? f.value : f.value.toString('hex')}`).join(', ')}}`;
	} catch {
		return value.toString('hex');
	}
}

/**
 * Summarise a message for debug logs. A login is named but never shown
 * (it holds the account's e-mail address).
 *
 * @param {Message} message message
 * @returns {string} summary
 */
function describe(message) {
	if (message.has(FIELD_LOGIN)) {
		return 'login';
	}
	const parts = [
		`seq=${message.varint(FIELD_SEQUENCE)}`,
		`fields=${[...message.numbers].sort((a, b) => a - b).join(',')}`,
	];
	const kind = message.varint(FIELD_KIND);
	if (kind !== null) {
		parts.push(`kind=${kind}`);
	}
	try {
		const state = message.message(FIELD_STATE);
		if (state) {
			const mode = state.varint(STATE_MODE);
			parts.push(`mode=${mode} (${MODE_NAMES[mode] || 'unknown'})`);
			const sps = holdSetpoints(state);
			if (sps[TEMPORARY_HOLD] !== undefined) {
				parts.push(`temporary=${wireToC(sps[TEMPORARY_HOLD])}C`);
				const hold = state.message(TEMPORARY_HOLD);
				const until = hold ? hold.varint(HOLD_END_TIME) : null;
				if (until !== null) {
					parts.push(`until=${fromDeviceTime(until).toISOString()}`);
				}
			}
			if (sps[PERMANENT_HOLD] !== undefined) {
				parts.push(`permanent=${wireToC(sps[PERMANENT_HOLD])}C`);
			}
			const shown = new Set([STATE_TIME, STATE_MODE, TEMPORARY_HOLD, PERMANENT_HOLD]);
			for (const f of [...state.fields].sort((a, b) => a.number - b.number)) {
				if (!shown.has(f.number)) {
					shown.add(f.number);
					parts.push(`9.${f.number}=${brief(f.value)}`);
				}
			}
		}
		const info = message.message(FIELD_DEVICE_INFO);
		const target = info ? info.varint(INFO_TARGET) : null;
		if (target !== null) {
			parts.push(`target=${wireToC(target)}C`);
		}
		const tel = decodeTelemetry(message);
		if (tel.floorTemperature !== undefined) {
			parts.push(`floor=${tel.floorTemperature}C`);
		}
		if (tel.heating !== undefined) {
			parts.push(`heating=${tel.heating ? 1 : 0}`);
		}
	} catch {
		parts.push('undecodable');
	}
	return parts.join(' ');
}

/**
 * Login of a WD5-series thermostat (observed on OWD5 firmware 1013W220):
 * field 5 holds 5.1 serial, 5.2 device type(?), 5.3 firmware, 5.5 local
 * time {1: h, 2: m, 3: s}. Unlike WG4 there is no account e-mail.
 *
 * @param {Message} message first message of a connection
 * @returns {{serial: string, deviceType: number|null, firmware: string, clock: string}|null} login data
 */
function wd5Login(message) {
	try {
		const login = message.message(5);
		if (!login) {
			return null;
		}
		const serial = login.data(1);
		if (!serial || !serial.length || !isPrintable(serial)) {
			return null;
		}
		const firmware = login.data(3);
		const time = login.message(5);
		const pad = v => String(v ?? 0).padStart(2, '0');
		return {
			serial: serial.toString('utf8'),
			deviceType: login.varint(2),
			firmware: firmware && isPrintable(firmware) ? firmware.toString('utf8') : '',
			clock: time ? `${pad(time.varint(1))}:${pad(time.varint(2))}:${pad(time.varint(3))}` : '',
		};
	} catch {
		return null;
	}
}

/**
 * @param {Buffer} buf bytes
 * @returns {boolean} printable ASCII only
 */
function isPrintable(buf) {
	return buf.length > 0 && buf.every(b => b >= 0x20 && b <= 0x7e);
}

/**
 * Generic, schema-less representation of a message for protocol analysis,
 * e.g. `1=3 4=1 5={1="1021410" 2=3}`.
 *
 * @param {Message} message message
 * @param {number} [depth] nesting depth
 * @returns {string} representation
 */
function dump(message, depth = 0) {
	return message.fields
		.map(f => {
			if (typeof f.value === 'number') {
				return `${f.number}=${f.value}`;
			}
			if (f.wireType !== 2) {
				return `${f.number}=0x${f.value.toString('hex')}`;
			}
			if (f.value.length && isPrintable(f.value)) {
				return `${f.number}="${f.value.toString('utf8')}"`;
			}
			if (depth < 6 && f.value.length) {
				try {
					return `${f.number}={${dump(Message.parse(f.value), depth + 1)}}`;
				} catch {
					// not a nested message
				}
			}
			return `${f.number}=0x${f.value.toString('hex')}`;
		})
		.join(' ');
}

module.exports = {
	FIELD_SEQUENCE,
	FIELD_KIND,
	FIELD_ACKNOWLEDGED,
	FIELD_LOGIN,
	FIELD_DEVICE_INFO,
	FIELD_SCHEDULE,
	FIELD_STATE,
	FIELD_CONFIGURATION,
	FIELD_TELEMETRY,
	FIELD_SUPPORT,
	KIND_STATE_UPLOAD,
	KIND_SCHEDULE_UPLOAD,
	REGULATION_SCHEDULE,
	REGULATION_COMFORT,
	REGULATION_MANUAL,
	REGULATION_VACATION,
	deviceTime,
	fromDeviceTime,
	acknowledgement,
	loginAcknowledgement,
	loginSerial,
	wd5Login,
	dump,
	decodeState,
	decodeTelemetry,
	changedState,
	command,
	responseField,
	isAnswer,
	describe,
	wireToC,
	cToWire,
};
