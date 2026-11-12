/* eslint-disable jsdoc/require-jsdoc */
'use strict';

// ============================================================================
// Minimal protobuf wire format helpers for the local device gateway.
//
// The thermostats speak protobuf without a published schema, so messages are
// handled by field number only. A field is changed inside the encoded message
// itself: everything the thermostat sent that we do not understand goes back
// byte for byte.
//
// Framing on the TCP/TLS stream: 0x08, the length of the message as varint,
// then the protobuf message.
// ============================================================================

const VARINT = 0;
const FIXED64 = 1;
const LENGTH_DELIMITED = 2;
const FIXED32 = 5;

const FRAME_MARKER = 0x08;
/** Real frames stay well below 1 KiB; refuse anything absurd. */
const MAX_FRAME = 64 * 1024;
/** The length of a frame of at most MAX_FRAME bytes fits into three bytes. */
const MAX_LENGTH_BYTES = 3;
const MAX_VARINT_BYTES = 10;
const FIXED_SIZES = { [FIXED32]: 4, [FIXED64]: 8 };

/**
 * Read an unsigned varint.
 *
 * Values above 2^53 lose precision; the device protocol never uses them.
 *
 * @param {Buffer} data encoded data
 * @param {number} [offset] start offset
 * @returns {[number, number]} value and offset after the varint
 */
function readVarint(data, offset = 0) {
	let value = 0;
	let factor = 1;
	for (let i = 0; i < MAX_VARINT_BYTES; i++) {
		const pos = offset + i;
		if (pos >= data.length) {
			throw new Error('Truncated protobuf varint');
		}
		const byte = data[pos];
		value += (byte & 0x7f) * factor;
		factor *= 128;
		if (!(byte & 0x80)) {
			return [value, pos + 1];
		}
	}
	throw new Error('Oversized protobuf varint');
}

/**
 * Encode an unsigned varint.
 *
 * @param {number} value non-negative integer
 * @returns {Buffer} encoded varint
 */
function encodeVarint(value) {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new Error(`A protobuf varint must be a non-negative integer, got ${value}`);
	}
	const out = [];
	let v = value;
	while (v > 0x7f) {
		out.push((v % 128) | 0x80);
		v = Math.floor(v / 128);
	}
	out.push(v);
	return Buffer.from(out);
}

/**
 * @typedef {{number: number, wireType: number, value: number|Buffer, start: number, end: number}} Field
 */

/**
 * Scan all fields of a message.
 *
 * @param {Buffer} data encoded message
 * @returns {Field[]} fields in wire order
 */
function scan(data) {
	const fields = [];
	let offset = 0;
	while (offset < data.length) {
		const start = offset;
		let tag;
		[tag, offset] = readVarint(data, offset);
		const number = Math.floor(tag / 8);
		const wireType = tag % 8;
		if (!number) {
			throw new Error('Invalid protobuf field number zero');
		}
		let value;
		if (wireType === VARINT) {
			[value, offset] = readVarint(data, offset);
		} else if (wireType === LENGTH_DELIMITED) {
			let len;
			[len, offset] = readVarint(data, offset);
			value = data.subarray(offset, offset + len);
			offset += len;
		} else if (FIXED_SIZES[wireType]) {
			value = data.subarray(offset, offset + FIXED_SIZES[wireType]);
			offset += FIXED_SIZES[wireType];
		} else {
			throw new Error(`Unsupported protobuf wire type ${wireType}`);
		}
		if (offset > data.length) {
			throw new Error('Truncated protobuf field');
		}
		fields.push({ number, wireType, value, start, end: offset });
	}
	return fields;
}

/**
 * A parsed protobuf message (fields by number, in wire order).
 */
class Message {
	/**
	 * @param {Buffer} raw encoded message
	 * @param {Field[]} fields parsed fields
	 */
	constructor(raw, fields) {
		this.raw = raw;
		this.fields = fields;
	}

	/**
	 * Parse an encoded message.
	 *
	 * @param {Buffer} data encoded message
	 * @returns {Message} parsed message
	 */
	static parse(data) {
		const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
		return new Message(buf, scan(buf));
	}

	/**
	 * @param {number} number field number
	 * @returns {boolean} whether the field is present
	 */
	has(number) {
		return this.fields.some(f => f.number === number);
	}

	/** @returns {Set<number>} the field numbers in the message */
	get numbers() {
		return new Set(this.fields.map(f => f.number));
	}

	/**
	 * @param {number} number field number
	 * @returns {number} how often the field occurs
	 */
	count(number) {
		return this.fields.filter(f => f.number === number).length;
	}

	/**
	 * @param {number} number field number
	 * @returns {Field|undefined} the first occurrence of a field
	 */
	first(number) {
		return this.fields.find(f => f.number === number);
	}

	/**
	 * @param {number} number field number
	 * @returns {number|null} the value if the first occurrence is a varint
	 */
	varint(number) {
		const f = this.first(number);
		return f && typeof f.value === 'number' ? f.value : null;
	}

	/**
	 * @param {number} number field number
	 * @returns {Buffer|null} the content if the first occurrence is length-delimited
	 */
	data(number) {
		const f = this.first(number);
		return f && f.wireType === LENGTH_DELIMITED && Buffer.isBuffer(f.value) ? f.value : null;
	}

	/**
	 * Parse a length-delimited field as nested message.
	 *
	 * @param {number} number field number
	 * @returns {Message|null} nested message
	 */
	message(number) {
		const d = this.data(number);
		return d === null ? null : Message.parse(d);
	}
}

/**
 * Encode a number as varint field, or bytes as length-delimited field.
 *
 * @param {number} number field number
 * @param {number|Buffer} value value
 * @returns {Buffer} encoded field
 */
function encodeField(number, value) {
	if (typeof value === 'number') {
		return Buffer.concat([encodeVarint(number * 8 + VARINT), encodeVarint(value)]);
	}
	const buf = Buffer.isBuffer(value) ? value : Buffer.from(value);
	return Buffer.concat([encodeVarint(number * 8 + LENGTH_DELIMITED), encodeVarint(buf.length), buf]);
}

/**
 * Return a message with one field set and every other byte kept.
 *
 * The first occurrence is replaced, later ones are dropped. A missing field is
 * inserted before the first field with a higher number.
 *
 * @param {Buffer} data encoded message
 * @param {number} number field number
 * @param {number|Buffer} value new value
 * @returns {Buffer} encoded message
 */
function setField(data, number, value) {
	const encoded = encodeField(number, value);
	const spans = scan(data);
	const present = spans.some(f => f.number === number);
	const chunks = [];
	let placed = false;
	for (const f of spans) {
		if (f.number === number) {
			if (!placed) {
				chunks.push(encoded);
				placed = true;
			}
			continue;
		}
		if (!present && !placed && f.number > number) {
			chunks.push(encoded);
			placed = true;
		}
		chunks.push(data.subarray(f.start, f.end));
	}
	if (!placed) {
		chunks.push(encoded);
	}
	return Buffer.concat(chunks);
}

/**
 * Wrap a message in a frame.
 *
 * @param {Buffer} message encoded message
 * @returns {Buffer} frame
 */
function encodeFrame(message) {
	return Buffer.concat([Buffer.from([FRAME_MARKER]), encodeVarint(message.length), message]);
}

/**
 * Incremental frame reader for a byte stream.
 *
 * push() returns the complete frame bodies; a malformed stream throws.
 */
class FrameReader {
	constructor() {
		/** @type {Buffer} */
		this.buffer = Buffer.alloc(0);
	}

	/**
	 * @param {Buffer} chunk received bytes
	 * @returns {Buffer[]} complete message bodies
	 */
	push(chunk) {
		this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
		const out = [];
		for (;;) {
			const body = this._next();
			if (!body) {
				break;
			}
			out.push(body);
		}
		return out;
	}

	_next() {
		const buf = this.buffer;
		if (!buf.length) {
			return null;
		}
		if (buf[0] !== FRAME_MARKER) {
			throw new Error(`A frame starts with 0x08, not with 0x${buf[0].toString(16).padStart(2, '0')}`);
		}
		let size = 0;
		let factor = 1;
		let offset = 1;
		let complete = false;
		for (let i = 0; i < MAX_LENGTH_BYTES; i++) {
			if (offset >= buf.length) {
				return null;
			}
			const byte = buf[offset++];
			size += (byte & 0x7f) * factor;
			factor *= 128;
			if (!(byte & 0x80)) {
				complete = true;
				break;
			}
		}
		if (!complete) {
			throw new Error(`The length of a frame takes at most ${MAX_LENGTH_BYTES} bytes`);
		}
		if (size > MAX_FRAME) {
			throw new Error(`A frame of ${size} bytes exceeds the limit of ${MAX_FRAME}`);
		}
		if (buf.length < offset + size) {
			return null;
		}
		const body = buf.subarray(offset, offset + size);
		this.buffer = buf.subarray(offset + size);
		return Buffer.from(body);
	}
}

module.exports = {
	VARINT,
	LENGTH_DELIMITED,
	FRAME_MARKER,
	MAX_FRAME,
	readVarint,
	encodeVarint,
	encodeField,
	setField,
	encodeFrame,
	FrameReader,
	Message,
};
