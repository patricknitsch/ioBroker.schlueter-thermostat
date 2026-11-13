/* eslint-disable jsdoc/require-jsdoc */
'use strict';

// ============================================================================
// Device handler for WG4-series thermostats (UWG4 / AWG4, North America)
//
// Login in field 6 (6.2 serial). Answering locally needs the "profile": the
// two answers the vendor gateway sends after the uploads (fields 10 and 18),
// recorded while relaying. Commands: schedule and permanent hold.
// Field layout: see protocol.js.
// ============================================================================

const { Message, FrameReader, encodeFrame, encodeField } = require('./protobuf');
const P = require('./protocol');

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
 * @param {Profile} profile profile
 * @returns {{configuration: string, support: string}} hex strings (to store as JSON)
 */
function profileToJson(profile) {
	return { configuration: profile.configuration.toString('hex'), support: profile.support.toString('hex') };
}

/**
 * @param {any} data stored data
 * @returns {Profile|null} profile, null if invalid
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

class Wg4Handler {
	/**
	 * @param {import('./gateway').LocalGateway} gateway gateway core
	 */
	constructor(gateway) {
		this.gw = gateway;
		this.name = 'wg4';
	}

	/**
	 * @param {Message} message first message of a connection
	 * @returns {{serial: string, text: string}|null} login data
	 */
	detectLogin(message) {
		const serial = P.loginSerial(message);
		return serial ? { serial, text: `Thermostat ${serial} logged in` } : null;
	}

	initLink(link) {
		link.data = { state: null, schedule: null, configuration: null, support: null };
	}

	describe(message) {
		return P.describe(message);
	}

	isAnswer(message) {
		return P.isAnswer(message);
	}

	/**
	 * Frames that start local answering, or null if the thermostat cannot be
	 * answered (no recorded profile).
	 *
	 * @param {any} link link
	 * @returns {Buffer|null} frames
	 */
	startAnswering(link) {
		if (!this.gw.profiles.get(link.serial)) {
			this.gw._event(
				`Refusing thermostat ${link.serial}: no recorded profile to answer it with yet ` +
					'(run relay mode with a working internet connection once)',
				'warn',
			);
			return null;
		}
		const seq = Message.parse(link.login).varint(P.FIELD_SEQUENCE) || 0;
		return encodeFrame(P.loginAcknowledgement(seq));
	}

	/**
	 * @param {any} link link
	 * @param {Message} message message of the thermostat (no acknowledgement)
	 * @returns {Buffer|null} answer frames
	 */
	answer(link, message) {
		const profile = this.gw.profiles.get(link.serial);
		const seq = message.varint(P.FIELD_SEQUENCE) || 0;
		const kind = message.varint(P.FIELD_KIND);
		if (kind === P.KIND_SCHEDULE_UPLOAD) {
			return Buffer.concat([encodeFrame(P.acknowledgement(seq)), profile.support]);
		}
		if (kind === P.KIND_STATE_UPLOAD) {
			return Buffer.concat([encodeFrame(P.acknowledgement(seq)), profile.configuration]);
		}
		return seq ? encodeFrame(P.acknowledgement(seq)) : null;
	}

	/**
	 * Decode a message of either side and keep what later commands need.
	 *
	 * @param {any} link link
	 * @param {Message} message message
	 * @returns {Record<string, any>} decoded values
	 */
	observe(link, message) {
		const fields =
			message.has(P.FIELD_STATE) || message.has(P.FIELD_DEVICE_INFO)
				? P.decodeState(message) // throws on a malformed state before it is kept
				: P.decodeTelemetry(message);
		const schedule = message.data(P.FIELD_SCHEDULE);
		if (schedule) {
			link.data.schedule = Buffer.from(schedule);
		}
		const state = message.data(P.FIELD_STATE);
		if (state) {
			link.data.state = Buffer.from(state);
		}
		return fields;
	}

	/**
	 * A message of the vendor gateway: record the profile, then decode.
	 *
	 * @param {any} link link
	 * @param {Buffer} frame complete frame
	 * @param {Message} message message
	 * @returns {Record<string, any>} decoded values
	 */
	observeVendor(link, frame, message) {
		this._record(link, frame, message);
		// A change made in the vendor's app arrives as a command.
		return this.observe(link, message);
	}

	_record(link, frame, message) {
		const n = P.responseField(message);
		if (n === null) {
			return;
		}
		if (n === P.FIELD_CONFIGURATION) {
			link.data.configuration = frame;
		} else {
			link.data.support = frame;
		}
		if (!link.data.configuration || !link.data.support) {
			return;
		}
		const profile = { configuration: link.data.configuration, support: link.data.support };
		const known = this.gw.profiles.get(link.serial);
		if (known && known.configuration.equals(profile.configuration) && known.support.equals(profile.support)) {
			return;
		}
		this.gw.profiles.set(link.serial, profile);
		this.gw._event(`Recorded the profile of thermostat ${link.serial}`, 'info');
		this.gw.emit('profile', link.serial, profile);
	}

	canCommand(link) {
		return !!link.data.state;
	}

	timeZoneSec() {
		return null;
	}

	/**
	 * @param {any} link link
	 * @param {{mode: number, tempC?: number|null}} change regulation mode and setpoint
	 * @returns {{build: (seq: number) => Buffer, done: () => Record<string, any>}} command
	 */
	command(link, change) {
		if (!link.data.state) {
			throw new Error('The thermostat has not reported its state yet.');
		}
		const state = P.changedState(link.data.state, change.mode, change.tempC ?? null);
		return {
			build: seq => P.command(seq, state, link.data.schedule),
			done: () => {
				link.data.state = state;
				return P.decodeState(Message.parse(encodeField(P.FIELD_STATE, state)));
			},
		};
	}
}

module.exports = { Wg4Handler, isValidProfile, profileToJson, profileFromJson };
