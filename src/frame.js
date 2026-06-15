// The payload frame carried inside every IRIS RS message — shared by all
// profiles (mono, color, robust) so the layout lives in exactly one place.
//
//   [0..1] payload length  (uint16 BE)
//   [2..3] CRC-16 of payload (BE)
//   [4..]  UTF-8 payload, then zero padding to fill the data area.

import { crc16 } from "./bits.js";

/** Bytes of frame overhead before the payload: length (2) + CRC (2). */
export const FRAME_HEADER = 4;

/**
 * Pack `payload` bytes into a `dataBytes`-long frame (length + CRC + payload,
 * zero-padded). Callers guarantee `dataBytes >= FRAME_HEADER + payload.length`.
 */
export function writeFrame(payload, dataBytes) {
  const msg = new Uint8Array(dataBytes);
  msg[0] = (payload.length >> 8) & 0xff;
  msg[1] = payload.length & 0xff;
  const c = crc16(payload);
  msg[2] = (c >> 8) & 0xff;
  msg[3] = c & 0xff;
  msg.set(payload, FRAME_HEADER);
  return msg;
}

/**
 * Recover the UTF-8 text from a corrected RS message, or `null` if the framed
 * length overflows the data area or the CRC doesn't match — both signal that
 * this candidate geometry/schedule is wrong and the decoder should keep trying.
 */
export function readFrame(msg, dataBytes) {
  const len = (msg[0] << 8) | msg[1];
  if (FRAME_HEADER + len > dataBytes) return null;
  const stored = (msg[2] << 8) | msg[3];
  const payload = msg.slice(FRAME_HEADER, FRAME_HEADER + len);
  if (crc16(payload) !== stored) return null;
  return new TextDecoder().decode(payload);
}
