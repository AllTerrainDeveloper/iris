// IRIS v2 — color profile. Each cell carries 3 bits via an 8-color palette
// (JAB-Code-style density, ISO/IEC 23634 idea), no per-cell clock tax. This is
// the high-capacity path; it trades the v1 self-clocking robustness for ~3 bits
// per cell and much smaller cells. Geometry & RS are reused from the core.
//
// Capacity grows outward (AGENTS.md §2.3): pick the smallest ring schedule that
// fits, the decoder infers it by trying each and checking RS + CRC.

import { segCounts, ringMidU, imageSizePx } from "./params.js";
import { rsEncode, rsCorrect } from "./rs.js";
import { bytesToBits, bitsToBytes, crc16 } from "./bits.js";
import { sector } from "./render-svg.js";

/** Dense color profile (3 bits/cell). */
export const COLOR_PROFILE = Object.freeze({
  u: 10, // px per module unit
  Rp: 6, // pupil radius (u)
  dr: 2, // ring radial width (u) — denser than v1's 3
  sSeg: 2, // arc length per cell (u) — denser than v1's 4
  quiet: 4,
  parity: 0.3,
  bitsPerCell: 3,
});

// Ring counts the encoder may pick / decoder will try. Capacity grows fast, so
// small payloads get small symbols and large ones scale outward.
export const SCHEDULES_COLOR = Object.freeze([4, 6, 8, 12, 16, 24, 32, 48, 64]);

// 8-color palette, index === 3-bit value. Cube corners: max separation.
export const PALETTE = Object.freeze([
  [0, 0, 0], // 0 black
  [255, 0, 0], // 1 red
  [0, 255, 0], // 2 green
  [0, 0, 255], // 3 blue
  [255, 255, 0], // 4 yellow
  [255, 0, 255], // 5 magenta
  [0, 255, 255], // 6 cyan
  [255, 255, 255], // 7 white
]);

const HEX = PALETTE.map(([r, g, b]) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`);

const FRAME_HEADER = 4; // len(2) + crc(2)

// Adaptive ECC: small payloads leave spare room in the symbol, so we spend it on
// parity. Encode picks the HIGHEST level that still fits; the decoder tries each.
// (Large payloads fall back to 0.3, preserving max capacity.)
export const PARITY_LEVELS = Object.freeze([0.7, 0.5, 0.3]);
export const parityFor = (totalBytes, level) =>
  Math.max(2, Math.min(totalBytes - 1, Math.round(totalBytes * level)));

export function nearestColor(r, g, b) {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < PALETTE.length; i++) {
    const [pr, pg, pb] = PALETTE[i];
    const d = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** Encode text into a color Symbol { params, cells, meta }. */
export function encodeColor(text, opts = {}) {
  const p = { ...COLOR_PROFILE, ...(opts.profile || {}) };
  const payload = new TextEncoder().encode(text);
  if (payload.length > 0xffff) throw new Error("payload too large (max 65535 bytes)");

  for (const K of SCHEDULES_COLOR) {
    const N = segCounts(K, p);
    const cells = N.reduce((a, b) => a + b, 0);
    const usable = cells - K; // segment 0 of each ring reserved for the registration ray
    const rawBits = usable * p.bitsPerCell;
    const totalBytes = Math.floor(rawBits / 8);
    // Highest parity level whose data area still holds the payload.
    let parity = 0;
    for (const level of PARITY_LEVELS) {
      const pr = parityFor(totalBytes, level);
      if (totalBytes - pr >= FRAME_HEADER + payload.length) {
        parity = pr;
        break;
      }
    }
    if (!parity) continue; // even the lowest level doesn't fit — try a bigger K
    const dataBytes = totalBytes - parity;

    const msg = new Uint8Array(dataBytes);
    msg[0] = (payload.length >> 8) & 0xff;
    msg[1] = payload.length & 0xff;
    const c = crc16(payload);
    msg[2] = (c >> 8) & 0xff;
    msg[3] = c & 0xff;
    msg.set(payload, FRAME_HEADER);

    const code = rsEncode(msg, parity); // totalBytes
    const bits = bytesToBits(code); // totalBytes*8 <= rawBits

    // Pack bits into 3-bit cell values, ring by ring (AGENTS.md §2.5). Segment 0
    // of every ring is reserved (stays 0 = black) to form the registration ray.
    const cellVals = N.map((n) => new Uint8Array(n));
    let bi = 0;
    for (let k = 0; k < K; k++) {
      for (let i = 1; i < N[k]; i++) {
        let v = 0;
        for (let b = 0; b < p.bitsPerCell; b++) {
          v = (v << 1) | (bi < bits.length ? bits[bi] : 0);
          bi++;
        }
        cellVals[k][i] = v;
      }
    }

    return {
      profile: "color",
      params: { ...p, K, N },
      cells: cellVals,
      meta: {
        totalBytes,
        parity,
        dataBytes,
        capacityBytes: dataBytes - FRAME_HEADER,
        cells,
        dataCells: usable,
        bitsPerCell: p.bitsPerCell,
      },
    };
  }
  throw new Error("payload too large for available ring schedules");
}

// --- Rendering ---------------------------------------------------------------

// Returns the [r,g,b] color at module-space (ru,theta), or null for blank/white.
function colorAt(ru, theta, sym) {
  const { Rp, dr, K, N } = sym.params;
  // Pupil bullseye in black for localization (AGENTS.md §2.2). Orientation comes
  // from the registration ray (segment 0 of every ring), not a pupil spur.
  if (ru <= 2) return PALETTE[0];
  if (ru >= Rp - 2 && ru <= Rp) return PALETTE[0];
  if (ru < Rp) return null;
  const outer = Rp + K * dr;
  if (ru > outer) return null;
  const k = Math.floor((ru - Rp) / dr);
  if (k >= K) return null;
  const dk = (2 * Math.PI) / N[k];
  const i = Math.floor(theta / dk);
  return PALETTE[sym.cells[k][i]];
}

/** Color Symbol -> RGB grid { width, height, data: Uint8Array (RGB triplets) }. */
export function renderColorRaster(sym) {
  const p = sym.params;
  const D = imageSizePx(p.K, p);
  const cx = D / 2;
  const cy = D / 2;
  const data = new Uint8Array(D * D * 3).fill(255); // white background
  for (let y = 0; y < D; y++) {
    for (let x = 0; x < D; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const ru = Math.hypot(dx, dy) / p.u;
      let theta = Math.atan2(dx, -dy);
      if (theta < 0) theta += 2 * Math.PI;
      const col = colorAt(ru, theta, sym);
      if (col) {
        const o = (y * D + x) * 3;
        data[o] = col[0];
        data[o + 1] = col[1];
        data[o + 2] = col[2];
      }
    }
  }
  return { width: D, height: D, data };
}

/** Color Symbol -> SVG string. */
export function renderColorSVG(sym) {
  const p = sym.params;
  const { Rp, dr, K, N, u } = p;
  const D = imageSizePx(K, p);
  const c = D / 2;
  const out = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${D}" height="${D}" viewBox="0 0 ${D} ${D}">`,
    `<rect width="${D}" height="${D}" fill="#fff"/>`,
  ];
  // Data cells, grouped by color for compact output.
  const byColor = HEX.map(() => []);
  for (let k = 0; k < K; k++) {
    const r0 = (Rp + k * dr) * u;
    const r1 = (Rp + (k + 1) * dr) * u;
    const dk = (2 * Math.PI) / N[k];
    for (let i = 0; i < N[k]; i++) {
      const v = sym.cells[k][i];
      if (v === 7) continue; // white === background, skip
      byColor[v].push(sector(c, r0, r1, i * dk, (i + 1) * dk));
    }
  }
  for (let v = 0; v < HEX.length; v++) {
    if (byColor[v].length) out.push(`<g fill="${HEX[v]}">${byColor[v].join("")}</g>`);
  }
  // Pupil bullseye (black, on top for crisp localization). The registration ray
  // (segment 0 of every ring) is already drawn above as black cells.
  out.push(`<g fill="#000">`);
  out.push(`<circle cx="${c}" cy="${c}" r="${Rp * u}"/>`);
  out.push(`<circle cx="${c}" cy="${c}" r="${(Rp - 2) * u}" fill="#fff"/>`);
  out.push(`<circle cx="${c}" cy="${c}" r="${2 * u}"/>`);
  out.push(`</g></svg>`);
  return out.join("");
}

// --- Decoding ----------------------------------------------------------------

function sampleColor(grid, cx, cy, ru, theta, u) {
  const px = cx + ru * u * Math.sin(theta);
  const py = cy - ru * u * Math.cos(theta);
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      const x = Math.round(px) + ox;
      const y = Math.round(py) + oy;
      if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) continue;
      const o = (y * grid.width + x) * 3;
      r += grid.data[o];
      g += grid.data[o + 1];
      b += grid.data[o + 2];
      n++;
    }
  }
  if (!n) return 7;
  return nearestColor(r / n, g / n, b / n);
}

/** Decode an RGB grid to text. Returns { text, params } or throws. */
export function decodeColor(grid, opts = {}) {
  const p = { ...COLOR_PROFILE, ...(opts.profile || {}) };
  const cx = grid.width / 2;
  const cy = grid.height / 2;

  for (const K of SCHEDULES_COLOR) {
    const radiusU = p.Rp + K * p.dr + p.quiet;
    const u = grid.width / (2 * radiusU);
    const N = segCounts(K, p);

    const bits = [];
    for (let k = 0; k < K; k++) {
      const rmid = ringMidU(k, p);
      const dk = (2 * Math.PI) / N[k];
      for (let i = 1; i < N[k]; i++) {
        // skip segment 0 (registration ray)
        const v = sampleColor(grid, cx, cy, rmid, (i + 0.5) * dk, u);
        for (let b = p.bitsPerCell - 1; b >= 0; b--) bits.push((v >> b) & 1);
      }
    }

    const cells = N.reduce((a, b) => a + b, 0) - K;
    const totalBytes = Math.floor((cells * p.bitsPerCell) / 8);
    const code = bitsToBytes(bits.slice(0, totalBytes * 8));
    for (const level of PARITY_LEVELS) {
      const parity = parityFor(totalBytes, level);
      const dataBytes = totalBytes - parity;
      if (dataBytes < FRAME_HEADER) continue;
      const corrected = rsCorrect(code, parity);
      if (!corrected) continue;
      const len = (corrected[0] << 8) | corrected[1];
      if (4 + len > dataBytes) continue;
      const stored = (corrected[2] << 8) | corrected[3];
      const payload = corrected.slice(4, 4 + len);
      if (crc16(payload) !== stored) continue;
      return { text: new TextDecoder().decode(payload), params: { K, N } };
    }
  }
  throw new Error("no decodable IRIS color symbol found");
}
