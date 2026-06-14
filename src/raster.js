// Rasterize a Symbol to a binary grayscale grid, and read/write PGM (P5).
// The renderer and the decoder share the SAME polar geometry, so a clean
// render round-trips exactly (AGENTS.md §2.7 determinism).

import { imageSizePx } from "./params.js";

/** A grid is { width, height, data: Uint8Array } where data is 0..255 gray. */

// Pixel -> polar. Angle 0 at top, increasing clockwise (AGENTS.md §2.5).
function polar(dx, dy, u) {
  const ru = Math.hypot(dx, dy) / u;
  let theta = Math.atan2(dx, -dy);
  if (theta < 0) theta += 2 * Math.PI;
  return { ru, theta };
}

/** True if module-space point (ru in u, theta in rad) is inked for this symbol. */
function inkAt(ru, theta, sym) {
  const { Rp, dr, K, N } = sym.params;

  // Pupil (AGENTS.md §2.2): center dot + invariant outer ring, white gap between,
  // plus a north spur spoke at 12 o'clock (AGENTS.md §2.4).
  if (ru <= 2) return true;
  if (ru >= Rp - 2 && ru <= Rp) return true;
  if (ru < Rp) {
    const d0 = (2 * Math.PI) / N[0];
    return theta < d0 * 0.3 && ru >= 2; // north spur fills the gap under seg 0's tick
  }

  // Data rings (AGENTS.md §2.3, §2.4).
  const outer = Rp + K * dr;
  if (ru > outer) return false;
  const k = Math.floor((ru - Rp) / dr);
  if (k >= K) return false;
  const dk = (2 * Math.PI) / N[k];
  const i = Math.floor(theta / dk);
  const phase = (theta - i * dk) / dk;
  if (phase < 0.3) return true; // self-clocking start tick (always inked)
  return sym.ringBits[k][i] === 1; // data cell
}

/** Symbol -> grayscale grid (0 = ink, 255 = blank). */
export function renderRaster(sym) {
  const p = sym.params;
  const D = imageSizePx(p.K, p);
  const cx = D / 2;
  const cy = D / 2;
  const data = new Uint8Array(D * D).fill(255);
  for (let y = 0; y < D; y++) {
    for (let x = 0; x < D; x++) {
      const { ru, theta } = polar(x + 0.5 - cx, y + 0.5 - cy, p.u);
      if (inkAt(ru, theta, sym)) data[y * D + x] = 0;
    }
  }
  return { width: D, height: D, data };
}

/** Grid -> PGM (P5) binary buffer. */
export function gridToPGM(grid) {
  const header = `P5\n${grid.width} ${grid.height}\n255\n`;
  return Buffer.concat([Buffer.from(header, "ascii"), Buffer.from(grid.data)]);
}

// Parse the 4-token Netpbm header (magic, width, height, maxval); returns the
// token strings plus the offset of the pixel data (one byte past maxval).
function parsePnmHeader(buf) {
  let pos = 0;
  const tokens = [];
  while (tokens.length < 4 && pos < buf.length) {
    while (pos < buf.length && /\s/.test(String.fromCharCode(buf[pos]))) pos++;
    if (buf[pos] === 0x23) {
      while (pos < buf.length && buf[pos] !== 0x0a) pos++;
      continue;
    }
    let tok = "";
    while (pos < buf.length && !/\s/.test(String.fromCharCode(buf[pos]))) {
      tok += String.fromCharCode(buf[pos++]);
    }
    tokens.push(tok);
  }
  return { tokens, pos: pos + 1 }; // skip single whitespace after maxval
}

/** PGM (P5) binary buffer -> grayscale grid. */
export function pgmToGrid(buf) {
  const { tokens, pos } = parsePnmHeader(buf);
  const [magic, w, h] = tokens;
  if (magic !== "P5") throw new Error("not a binary PGM (P5) file");
  const width = Number(w);
  const height = Number(h);
  return { width, height, data: new Uint8Array(buf.subarray(pos, pos + width * height)) };
}

/** RGB grid -> PPM (P6) binary buffer (for color symbols). */
export function gridToPPM(grid) {
  const header = `P6\n${grid.width} ${grid.height}\n255\n`;
  return Buffer.concat([Buffer.from(header, "ascii"), Buffer.from(grid.data)]);
}

/** PPM (P6) binary buffer -> RGB grid. */
export function ppmToGrid(buf) {
  const { tokens, pos } = parsePnmHeader(buf);
  const [magic, w, h] = tokens;
  if (magic !== "P6") throw new Error("not a binary PPM (P6) file");
  const width = Number(w);
  const height = Number(h);
  return { width, height, data: new Uint8Array(buf.subarray(pos, pos + width * height * 3)) };
}
