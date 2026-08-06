// @ts-check
/**
 * Meshtastic stream framing.
 *
 * Confirmed against real hardware 2026-08-05.
 *
 * The HTTP transport returns bare protobuf, but the serial (and TCP) stream
 * protocol wraps each FromRadio message in a four-byte header:
 *
 *     0x94 0xC3 <length-high> <length-low> <payload...>
 *
 * Two things make this more than a trivial parse:
 *
 *  1. The device also writes **plain-text debug logs to the same port**. Any
 *     bytes outside a frame are log output and must be discarded, not fed to
 *     the protobuf reader.
 *  2. Reads arrive in arbitrary chunks. A header can be split across two
 *     reads, so the parser has to be a resumable state machine rather than
 *     something that assumes whole frames.
 */

export const MAGIC1 = 0x94;
export const MAGIC2 = 0xc3;

/** Firmware caps a message well below this; anything larger is desync. */
export const MAX_FRAME = 512;

const STATE = {
  MAGIC1: 0,
  MAGIC2: 1,
  LEN_HI: 2,
  LEN_LO: 3,
  PAYLOAD: 4,
};

export class StreamFramer {
  /**
   * @param {(frame: Uint8Array) => void} onFrame
   * @param {(text: string) => void} [onText] receives discarded log output
   */
  constructor(onFrame, onText) {
    this._onFrame = onFrame;
    this._onText = onText;
    this._state = STATE.MAGIC1;
    this._len = 0;
    /** @type {number[]} */
    this._payload = [];
    /** @type {number[]} */
    this._text = [];
    this.framesSeen = 0;
    this.bytesDiscarded = 0;
  }

  /**
   * Feed bytes as they arrive.
   * @param {Uint8Array} chunk
   */
  push(chunk) {
    for (const b of chunk) this._byte(b);
    this._flushText();
  }

  /** @param {number} b */
  _byte(b) {
    switch (this._state) {
      case STATE.MAGIC1:
        if (b === MAGIC1) {
          this._state = STATE.MAGIC2;
        } else {
          this._discard(b);
        }
        return;

      case STATE.MAGIC2:
        if (b === MAGIC2) {
          this._state = STATE.LEN_HI;
        } else if (b === MAGIC1) {
          // 0x94 0x94 0xC3 -- the first was log output, stay armed.
          this._discard(MAGIC1);
        } else {
          // False start; both bytes were log output.
          this._discard(MAGIC1);
          this._discard(b);
          this._state = STATE.MAGIC1;
        }
        return;

      case STATE.LEN_HI:
        this._len = b * 256;
        this._state = STATE.LEN_LO;
        return;

      case STATE.LEN_LO:
        this._len += b;
        if (this._len === 0) {
          // Empty frame: valid, carries nothing.
          this._state = STATE.MAGIC1;
          return;
        }
        if (this._len > MAX_FRAME) {
          // Almost certainly a magic sequence inside log text. Resynchronise
          // rather than waiting for bytes that will never come.
          this._state = STATE.MAGIC1;
          this._len = 0;
          return;
        }
        this._payload = [];
        this._state = STATE.PAYLOAD;
        return;

      case STATE.PAYLOAD:
        this._payload.push(b);
        if (this._payload.length === this._len) {
          this.framesSeen++;
          this._onFrame(new Uint8Array(this._payload));
          this._payload = [];
          this._len = 0;
          this._state = STATE.MAGIC1;
        }
        return;
    }
  }

  /** @param {number} b */
  _discard(b) {
    this.bytesDiscarded++;
    if (this._onText) this._text.push(b);
  }

  /** Surface discarded bytes as text, a line at a time where possible. */
  _flushText() {
    if (!this._onText || this._text.length === 0) return;
    const s = new TextDecoder().decode(new Uint8Array(this._text));
    this._text = [];
    for (const line of s.split(/\r?\n/)) {
      if (line.trim()) this._onText(line);
    }
  }
}

/**
 * Wrap a payload for sending to the radio.
 * @param {Uint8Array} payload
 * @returns {Uint8Array}
 */
export function frame(payload) {
  const out = new Uint8Array(payload.length + 4);
  out[0] = MAGIC1;
  out[1] = MAGIC2;
  out[2] = (payload.length >> 8) & 0xff;
  out[3] = payload.length & 0xff;
  out.set(payload, 4);
  return out;
}
