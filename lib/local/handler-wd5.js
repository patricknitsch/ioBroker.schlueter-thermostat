/* eslint-disable jsdoc/require-jsdoc */
'use strict';

// ============================================================================
// Device handler for WD5-series thermostats (OWD5 / MWD5)
//
// Login in field 5 (5.1 serial, 5.3 firmware, 5.5 clock). Answering locally
// needs no recorded data: login answer, upload request and acknowledgements
// with server time. Commands are complete states like the vendor gateway
// sends them (its last command is the template). Field layout: see wd5.js.
// ============================================================================

const { Message, encodeFrame, encodeField } = require('./protobuf');
const P = require('./protocol');
const W = require('./wd5');

class Wd5Handler {
	/**
	 * @param {import('./gateway').LocalGateway} gateway gateway core
	 */
	constructor(gateway) {
		this.gw = gateway;
		this.name = 'wd5';
	}

	/**
	 * @param {Message} message first message of a connection
	 * @returns {{serial: string, text: string, fields: Record<string, any>}|null} login data
	 */
	detectLogin(message) {
		const info = P.wd5Login(message);
		if (!info) {
			return null;
		}
		return {
			serial: info.serial,
			text:
				`WD5 thermostat ${info.serial} logged in ` +
				`(type ${info.deviceType}, firmware ${info.firmware || '?'}, clock ${info.clock || '?'})`,
			fields: { firmware: info.firmware },
		};
	}

	initLink(link) {
		/** last complete state the vendor gateway (or we) sent; values; upload seen */
		link.data = { template: null, values: {}, ready: false };
	}

	describe(message) {
		return P.dump(message);
	}

	isAnswer(message) {
		return W.isAnswer(message);
	}

	/**
	 * @param {any} link link
	 * @returns {Buffer} login answer and request for the full upload
	 */
	startAnswering(link) {
		const seq = Message.parse(link.login || Buffer.alloc(0)).varint(1) || 0;
		return Buffer.concat([encodeFrame(W.loginAnswer(seq)), encodeFrame(W.uploadRequest())]);
	}

	/**
	 * @param {any} link link
	 * @param {Message} message message of the thermostat (no acknowledgement)
	 * @returns {Buffer|null} answer frame
	 */
	answer(link, message) {
		return W.wantsAnswer(message) ? encodeFrame(W.answer(message.varint(1) || 0)) : null;
	}

	/**
	 * @param {any} link link
	 * @param {Message} message message of the thermostat
	 * @returns {Record<string, any>} decoded values
	 */
	observe(link, message) {
		if (message.has(W.FIELD_STATE) || message.has(7)) {
			link.data.ready = true;
		}
		return this._decode(link, message);
	}

	/**
	 * @param {any} link link
	 * @param {Buffer} frame complete frame
	 * @param {Message} message message of the vendor gateway
	 * @returns {Record<string, any>} decoded values
	 */
	observeVendor(link, frame, message) {
		const state = message.data(W.FIELD_STATE);
		if (state) {
			// A change made in the vendor's app; also the template for own commands.
			link.data.template = Buffer.from(state);
		}
		return this._decode(link, message);
	}

	_decode(link, message) {
		const fields = { ...W.decodeTelemetry(message), ...W.decodeState(message) };
		const schedule = W.decodeSchedule(message);
		if (schedule) {
			fields.schedule = JSON.stringify(schedule);
		}
		Object.assign(link.data.values, fields);
		return fields;
	}

	canCommand(link) {
		return link.data.ready;
	}

	timeZoneSec(link) {
		const tz = link.data.values.timeZoneSec;
		return Number.isFinite(tz) ? tz : null;
	}

	/**
	 * @param {any} link link
	 * @param {{mode: number, tempC?: number, end?: Date|null}} change change
	 * @returns {{build: (seq: number) => Buffer, done: () => Record<string, any>}} command
	 */
	command(link, change) {
		if (!link.data.ready) {
			throw new Error('The thermostat has not reported its state yet.');
		}
		const base = link.data.template || W.defaultState(link.data.values);
		const state = W.changedState(base, change);
		return {
			build: seq => W.command(seq, state),
			done: () => {
				link.data.template = state;
				return this._decode(link, Message.parse(encodeField(W.FIELD_STATE, state)));
			},
		};
	}
}

module.exports = { Wd5Handler };
