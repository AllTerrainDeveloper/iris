// IRIS v2 — color profile. Each cell carries 3 bits via an 8-color palette
// (JAB-Code-style density, ISO/IEC 23634 idea), no per-cell clock tax. This is
// the high-capacity path; it trades the v1 self-clocking robustness for ~3 bits
// per cell and much smaller cells. Geometry & RS are reused from the core.
//
// Capacity grows outward (AGENTS.md §2.3): pick the smallest ring schedule that
// fits, the decoder infers it by trying each and checking RS + CRC.

import { segCounts, ringMidU, imageSizePx } from "./params.js";
import { rsEncode, rsCorrect } from "./rs.js";
import { bytesToBits, bitsToBytes } from "./bits.js";
import { FRAME_HEADER, writeFrame, readFrame } from "./frame.js";
import { sector, svgNum } from "./render-svg.js";

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

// White (palette index 7) is the background colour, so on their own white cells
// leave gaps and make each ring look like scattered "jewels" rather than a solid
// disc. For the seamless-disc look we paint them a faint tint instead — light
// enough that nearestColor()/locate() still classify it as white (every channel
// > 235, nearest palette entry is white), so the change is invisible to every
// decoder while the rings read as continuous bands.
export const WHITE_TINT_RGB = Object.freeze([237, 239, 245]);
const WHITE_TINT_HEX = `#${WHITE_TINT_RGB.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
// Crisp black ring framing the disc, drawn at the data edge (cell centres sit at
// ring mids, well inside, so sampling is unaffected). Shared by every renderer.
export const FRAME_WIDTH_U = 0.5;

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

    const msg = writeFrame(payload, dataBytes);
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
  if (ru > outer) {
    // Crisp black frame just outside the data, in the quiet zone (cosmetic; cell
    // centres are at ring mids, well inside, so sampling/decoding is unaffected).
    return ru <= outer + FRAME_WIDTH_U ? PALETTE[0] : null;
  }
  const k = Math.floor((ru - Rp) / dr);
  if (k >= K) return null;
  const dk = (2 * Math.PI) / N[k];
  // Cell i is CENTERED on angle i·dk (so cell 0 — the registration ray — is centered
  // on the vertical axis and renders symmetric). Nearest-cell = round, with wrap.
  let i = Math.round(theta / dk) % N[k];
  if (i < 0) i += N[k];
  const v = sym.cells[k][i];
  return v === 7 ? WHITE_TINT_RGB : PALETTE[v]; // white cells faintly tinted (seamless bands)
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

/**
 * Color Symbol -> SVG string. `opts.style` picks the cell aesthetic:
 *   "slices" (default) — annular sectors filling each cell (max ink → most robust).
 *   "dots"             — a crisp filled circle at each cell centre.
 *   "blobs"            — soft radial-gradient circles that overlap and blend.
 * The pupil bullseye AND the registration ray (segment 0 of every ring) are ALWAYS
 * drawn solid — they are the decoder's localization/orientation fiducials, and a
 * dotted ray measurably hurts robustness (see test/robust.test.js).
 */
export function renderColorSVG(sym, opts = {}) {
  const style = opts.style || "slices";
  const p = sym.params;
  const { Rp, dr, K, N, u } = p;
  const D = imageSizePx(K, p);
  const c = D / 2;
  const out = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${D}" height="${D}" viewBox="0 0 ${D} ${D}">`,
    `<rect width="${D}" height="${D}" fill="#fff"/>`,
  ];
  // Blobs need one soft radial gradient per colour (objectBoundingBox so a single
  // def serves every blob of that colour; the faded rim is what lets them blend).
  if (style === "blobs") {
    out.push("<defs>");
    for (let v = 0; v < HEX.length; v++) {
      if (v === 7) continue; // white === background, no blob
      out.push(
        `<radialGradient id="iris-blob-${v}">` +
          `<stop offset="55%" stop-color="${HEX[v]}"/>` +
          `<stop offset="100%" stop-color="${HEX[v]}" stop-opacity="0"/>` +
          `</radialGradient>`,
      );
    }
    out.push("</defs>");
  }
  const byColor = HEX.map(() => []); // solid shapes, grouped by colour
  const tint = []; // faint-tint sectors for white cells (slices) → gap-free bands
  const blobs = []; // gradient-filled circles (their own fill)
  for (let k = 0; k < K; k++) {
    const r0 = (Rp + k * dr) * u;
    const r1 = (Rp + (k + 1) * dr) * u;
    const dk = (2 * Math.PI) / N[k];
    const rmid = (Rp + k * dr + dr / 2) * u;
    for (let i = 0; i < N[k]; i++) {
      const v = sym.cells[k][i];
      // Slices style, and the registration ray (i===0) in every style, stay solid
      // sectors; in slices, white cells are tinted (not skipped) so each ring is a
      // seamless band. In dots/blobs a white cell is left as open background.
      const solid = style === "slices" || i === 0;
      if (solid) {
        // Cell i is centered on angle i·dk, so cell 0's wedge straddles vertical symmetrically.
        const sec = sector(c, r0, r1, (i - 0.5) * dk, (i + 0.5) * dk);
        (v === 7 ? tint : byColor[v]).push(sec);
        continue;
      }
      if (v === 7) continue; // dots/blobs: white === background
      const a = i * dk;
      const cx = svgNum(c + rmid * Math.sin(a));
      const cy = svgNum(c - rmid * Math.cos(a));
      const arc = rmid * dk;
      if (style === "dots") {
        const R = svgNum(0.42 * Math.min(r1 - r0, arc));
        byColor[v].push(`<circle cx="${cx}" cy="${cy}" r="${R}"/>`); // inherits group fill
      } else {
        const R = svgNum(0.62 * Math.min(r1 - r0, arc)); // larger → neighbours overlap
        blobs.push(`<circle cx="${cx}" cy="${cy}" r="${R}" fill="url(#iris-blob-${v})"/>`);
      }
    }
  }
  if (tint.length) out.push(`<g fill="${WHITE_TINT_HEX}">${tint.join("")}</g>`);
  if (blobs.length) out.push(`<g>${blobs.join("")}</g>`);
  for (let v = 0; v < HEX.length; v++) {
    if (byColor[v].length) out.push(`<g fill="${HEX[v]}">${byColor[v].join("")}</g>`);
  }
  // Crisp outer frame ring on every style so the disc has a clean circular edge.
  const rFrame = (Rp + K * dr) * u;
  out.push(
    `<circle cx="${c}" cy="${c}" r="${svgNum(rFrame)}" fill="none" stroke="#000" stroke-width="${svgNum(FRAME_WIDTH_U * u)}"/>`,
  );
  // Pupil bullseye (black, on top for crisp localization). The registration ray
  // (segment 0 of every ring) is already drawn above as solid black cells.
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
        // skip segment 0 (registration ray); cell i is centered on angle i·dk
        const v = sampleColor(grid, cx, cy, rmid, i * dk, u);
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
      const text = readFrame(corrected, dataBytes);
      if (text === null) continue;
      return { text, params: { K, N } };
    }
  }
  throw new Error("no decodable IRIS color symbol found");
}
