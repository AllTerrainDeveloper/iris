// IRIS "colour wheel" render. Crisp concentric arcs (like the slices style), but
// each cell's colour blends into its angular neighbours at the shared edge — so
// the disc reads as a smooth, detailed colour wheel instead of hard segments.
// Cell CENTRES stay pure (a plateau in the blend), so the symbol still decodes.
//
// Pure JS, no dependencies — runs in the browser (paint the grid into a Canvas
// via ImageData) and in Node (tests / PNG export). Returns an RGB grid shaped
// exactly like renderColorRaster: { width, height, data: Uint8Array (RGB) }.
// Ring boundaries are kept crisp on purpose: blending radially too would smear
// the concentric structure into noise.

import { PALETTE, WHITE_TINT_RGB } from "./color.js";
import { imageSizePx } from "./params.js";

const lerp = (a, b, t) => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t),
];

/**
 * Render a colour Symbol to a blended-arc "wheel" RGB grid.
 * @param {object} sym  an `encodeColor(...)` symbol
 * @param {object} [opts]
 * @param {number} [opts.blend=0.6] seam blend width: 0 = hard slices, 1 = fully smooth wheel
 * @param {number} [opts.scale=1]   supersample factor for a crisper raster
 */
export function renderWheelGrid(sym, opts = {}) {
  const blend = opts.blend ?? 0.6;
  const p = sym.params;
  const { Rp, dr, K, N } = p;
  const baseD = imageSizePx(K, p);
  // Supersample small symbols for crisp seams; keep big ones bounded (this is a
  // CPU per-pixel render, so cap the work for large payloads).
  const scale = opts.scale ?? Math.max(1, Math.min(2, Math.round(900 / baseD)));
  const u = p.u * scale;
  const D = Math.round(baseD * scale);
  const c = D / 2;
  const outer = Rp + K * dr;

  // Blend only within a band of half-width `tz` (in cell units) around each seam;
  // outside it the colour is the flat cell value, so centres stay pure/decodable.
  const tz = Math.max(1e-3, 0.5 * blend);
  const weight = (frac) => {
    if (frac <= 0.5 - tz) return 0;
    if (frac >= 0.5 + tz) return 1;
    const t = (frac - (0.5 - tz)) / (2 * tz);
    return t * t * (3 - 2 * t); // smoothstep
  };
  const cellColor = (k, i) => {
    const n = N[k];
    const v = sym.cells[k][((i % n) + n) % n];
    return v === 7 ? WHITE_TINT_RGB : PALETTE[v];
  };
  const ringColor = (k, theta) => {
    const dk = (2 * Math.PI) / N[k];
    const fi = theta / dk; // cell i is centred on angle i·dk
    const i0 = Math.floor(fi);
    return lerp(cellColor(k, i0), cellColor(k, i0 + 1), weight(fi - i0));
  };

  const data = new Uint8Array(D * D * 3).fill(255); // white background
  for (let y = 0; y < D; y++) {
    for (let x = 0; x < D; x++) {
      const dx = x + 0.5 - c;
      const dy = y + 0.5 - c;
      const ru = Math.hypot(dx, dy) / u;
      let rgb = null;
      if (ru <= 2 || (ru >= Rp - 2 && ru <= Rp)) rgb = PALETTE[0]; // pupil bullseye
      else if (ru < Rp) rgb = null; // pupil gap stays white
      else if (ru <= outer) {
        let theta = Math.atan2(dx, -dy);
        if (theta < 0) theta += 2 * Math.PI;
        const k = Math.min(K - 1, Math.floor((ru - Rp) / dr));
        rgb = ringColor(k, theta);
      } else if (ru <= outer + 0.5) rgb = PALETTE[0]; // crisp outer frame
      if (rgb) {
        const o = (y * D + x) * 3;
        data[o] = rgb[0];
        data[o + 1] = rgb[1];
        data[o + 2] = rgb[2];
      }
    }
  }
  return { width: D, height: D, data };
}
