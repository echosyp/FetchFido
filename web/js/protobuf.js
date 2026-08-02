// @ts-check
/**
 * Minimal protobuf wire-format reader.
 *
 * This exists so the app has no dependency tree. It decodes only; it does not
 * encode messages beyond the few bytes needed to talk to a radio, and it knows
 * nothing about .proto schemas -- callers map field numbers themselves.
 *
 * Wire format reference: field tag = (field_number << 3) | wire_type.
 */

export const WIRE = {
  VARINT: 0,
  I64: 1,
  LEN: 2,
  I32: 5,
};

export class Reader {
  /** @param {Uint8Array} buf */
  constructor(buf) {
    this.buf = buf;
    this.pos = 0;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  get done() {
    return this.pos >= this.buf.length;
  }

  /**
   * Read a base-128 varint.
   *
   * Accumulates with multiplication rather than `<<`, because JavaScript's
   * bitwise operators coerce to signed 32-bit and would silently corrupt any
   * value above 2^31 -- which includes ordinary node IDs.
   * @returns {number}
   */
  varint() {
    let result = 0;
    let shift = 0;
    for (;;) {
      if (this.pos >= this.buf.length) throw new RangeError('truncated varint');
      const b = this.buf[this.pos++];
      result += (b & 0x7f) * Math.pow(2, shift);
      if ((b & 0x80) === 0) break;
      shift += 7;
      if (shift > 63) throw new RangeError('varint overruns 64 bits');
    }
    return result;
  }

  /** Signed varint using zigzag encoding. @returns {number} */
  zigzag() {
    const n = this.varint();
    return (n % 2 === 0) ? n / 2 : -(n + 1) / 2;
  }

  /**
   * Varint holding a signed int32.
   *
   * Protobuf sign-extends a negative int32 to a full ten-byte varint rather
   * than zigzagging it, so -95 arrives as 2^64-95. That cannot be accumulated
   * as a double without losing precision, so this reads the byte stream and
   * keeps only the low 32 bits, letting `|` and `<<` do the sign wrap.
   * RSSI is always negative, so this path is exercised constantly.
   * @returns {number}
   */
  int32() {
    let result = 0;
    let shift = 0;
    for (;;) {
      if (this.pos >= this.buf.length) throw new RangeError('truncated varint');
      const b = this.buf[this.pos++];
      if (shift < 32) result |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
      if (shift > 70) throw new RangeError('varint overruns 64 bits');
    }
    return result | 0;
  }

  /** @returns {number} */
  u32() {
    this.require(4);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  /** @returns {number} */
  i32() {
    this.require(4);
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }

  /** @returns {number} */
  f32() {
    this.require(4);
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }

  /** @returns {Uint8Array} */
  bytes() {
    const len = this.varint();
    this.require(len);
    const out = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }

  /** @param {number} n */
  require(n) {
    if (this.pos + n > this.buf.length) throw new RangeError('truncated field');
  }

  /** @param {number} wire */
  skip(wire) {
    switch (wire) {
      case WIRE.VARINT: this.varint(); break;
      case WIRE.I64: this.require(8); this.pos += 8; break;
      case WIRE.LEN: this.bytes(); break;
      case WIRE.I32: this.require(4); this.pos += 4; break;
      default: throw new RangeError('unknown wire type ' + wire);
    }
  }

  /**
   * Iterate fields. The handler returns true if it consumed the value; any
   * field it declines is skipped, so unknown fields and future schema
   * additions pass through harmlessly.
   * @param {(field: number, wire: number, r: Reader) => boolean} handler
   */
  each(handler) {
    while (!this.done) {
      const tag = this.varint();
      const field = Math.floor(tag / 8);
      const wire = tag % 8;
      const before = this.pos;
      if (!handler(field, wire, this)) {
        this.skip(wire);
      } else if (this.pos === before) {
        // Handler claimed the field but read nothing; skip so we cannot spin.
        this.skip(wire);
      }
    }
  }
}

/**
 * Encode a varint. Used only for the handful of bytes we send to a radio.
 * @param {number} n
 * @returns {number[]}
 */
export function putVarint(n) {
  const out = [];
  let v = n;
  while (v > 0x7f) {
    out.push((v % 128) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return out;
}

/**
 * Encode a single length-delimited or varint field.
 * @param {number} field
 * @param {number} wire
 * @param {number[]} body
 * @returns {number[]}
 */
export function putField(field, wire, body) {
  return [...putVarint(field * 8 + wire), ...body];
}
