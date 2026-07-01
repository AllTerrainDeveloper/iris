// RS block structure for the color profile (AGENTS.md §2.6): independent
// Reed–Solomon blocks with their bytes interleaved, shared by the encoder and
// every decoder (clean, robust, markers) so the layout can't drift.
//
// Why blocks: RS over GF(256) is only defined for codewords of ≤ 255 bytes —
// the locator roots α^i repeat with period 255, so in a longer "codeword"
// error positions become ambiguous and correction silently fails. Large ring
// schedules (K ≥ 16) hold thousands of bytes, so the stream is split into
// ceil(totalBytes/255) blocks, each a valid RS code with its own parity.
//
// Why interleaving: cells are laid out ring by ring, so localized damage (a
// scratch, a smudge) is a BURST of consecutive bad bytes. Transmitting byte j
// of every block before byte j+1 of any block (QR's interleave) spreads a
// burst evenly across blocks, so each block sees only burst/nb of it.

import { rsEncode, rsCorrect } from "./rs.js";
import { readFrame, FRAME_HEADER } from "./frame.js";

/** Max RS codeword length over GF(256). */
export const MAX_BLOCK = 255;

// Adaptive ECC: small payloads leave spare room in the symbol, so we spend it on
// parity. Encode picks the HIGHEST level that still fits; the decoder tries each.
// (Large payloads fall back to 0.3, preserving max capacity.)
export const PARITY_LEVELS = Object.freeze([0.7, 0.5, 0.3]);
export const parityFor = (totalBytes, level) =>
  Math.max(2, Math.min(totalBytes - 1, Math.round(totalBytes * level)));

/**
 * Split `totalBytes` (with `parity` total parity bytes) into RS blocks of
 * ≤ MAX_BLOCK bytes. Returns [{ total, parity, data }] — earlier blocks take
 * the remainders, so blocks differ by at most one byte in each field.
 */
export function blockLayout(totalBytes, parity) {
  const nb = Math.max(1, Math.ceil(totalBytes / MAX_BLOCK));
  const blocks = [];
  for (let i = 0; i < nb; i++) {
    const total = Math.floor(totalBytes / nb) + (i < totalBytes % nb ? 1 : 0);
    const par = Math.floor(parity / nb) + (i < parity % nb ? 1 : 0);
    blocks.push({ total, parity: par, data: total - par });
  }
  return blocks;
}

// Transmitted-order byte positions: all data bytes interleaved across blocks
// (byte 0 of each block, then byte 1 of each, …), then all parity bytes the
// same way. Returns, for each block, the transmitted index of each of its
// codeword bytes — a single map serves interleave, de-interleave and erasures.
function transmitMap(blocks) {
  const map = blocks.map((b) => new Int32Array(b.total));
  let pos = 0;
  const maxData = Math.max(...blocks.map((b) => b.data));
  for (let j = 0; j < maxData; j++) {
    for (let bi = 0; bi < blocks.length; bi++) {
      if (j < blocks[bi].data) map[bi][j] = pos++;
    }
  }
  const maxPar = Math.max(...blocks.map((b) => b.parity));
  for (let j = 0; j < maxPar; j++) {
    for (let bi = 0; bi < blocks.length; bi++) {
      if (j < blocks[bi].parity) map[bi][blocks[bi].data + j] = pos++;
    }
  }
  return map;
}

/**
 * RS-encode a `dataBytes`-long message into the interleaved transmitted stream
 * of `totalBytes` bytes. With a single block this is exactly rsEncode — the
 * wire format for small symbols is unchanged.
 */
export function encodeBlocks(msg, totalBytes, parity) {
  const blocks = blockLayout(totalBytes, parity);
  const map = transmitMap(blocks);
  const out = new Uint8Array(totalBytes);
  let off = 0;
  for (let bi = 0; bi < blocks.length; bi++) {
    const b = blocks[bi];
    const code = rsEncode(msg.subarray(off, off + b.data), b.parity);
    for (let j = 0; j < b.total; j++) out[map[bi][j]] = code[j];
    off += b.data;
  }
  return out;
}

/**
 * De-interleave + RS-correct a transmitted stream. `erasures` lists known-bad
 * byte positions in TRANSMITTED order (e.g. cells under a scratch); each is
 * routed to its block and used when that block's parity can afford it.
 * Returns the corrected concatenated data bytes, or null if any block fails.
 */
export function correctBlocks(code, totalBytes, parity, erasures = []) {
  const blocks = blockLayout(totalBytes, parity);
  const map = transmitMap(blocks);
  const eraseSet = new Set(erasures);
  const out = new Uint8Array(totalBytes - parity);
  let off = 0;
  for (let bi = 0; bi < blocks.length; bi++) {
    const b = blocks[bi];
    const cw = new Uint8Array(b.total);
    const erase = [];
    for (let j = 0; j < b.total; j++) {
      cw[j] = code[map[bi][j]];
      if (eraseSet.has(map[bi][j])) erase.push(j);
    }
    const fixed = rsCorrect(cw, b.parity, erase.length <= b.parity ? erase : []);
    if (!fixed) return null;
    out.set(fixed.subarray(0, b.data), off);
    off += b.data;
  }
  return out;
}

/**
 * The shared tail of every color decode path: given the sampled transmitted
 * stream, try each adaptive parity level (the encoder used the highest that
 * fit), RS-correct per block, and verify the payload frame. RS + CRC are the
 * arbiters, so a wrong level (or wrong geometry) returns null rather than
 * garbage. Returns the decoded text or null.
 */
export function decodeStream(code, totalBytes, erasures = []) {
  for (const level of PARITY_LEVELS) {
    const parity = parityFor(totalBytes, level);
    const dataBytes = totalBytes - parity;
    if (dataBytes < FRAME_HEADER) continue;
    const data = correctBlocks(code, totalBytes, parity, erasures);
    if (!data) continue;
    const text = readFrame(data, dataBytes);
    if (text !== null) return text;
  }
  return null;
}
