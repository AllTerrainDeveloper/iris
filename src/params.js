// IRIS geometry & profile (AGENTS.md §2). All sizes in module units `u`;
// the renderer maps u -> pixels. Geometry is polar around the symbol center.

/** Default profile `iris-m` v1 (AGENTS.md §2, §7). */
export const DEFAULT_PROFILE = Object.freeze({
  u: 8, // pixels per module unit
  Rp: 6, // pupil radius (u)
  dr: 3, // ring radial width (u)
  sSeg: 4, // target arc length per segment (u)
  quiet: 4, // quiet zone (u)
  parity: 0.3, // ECC parity ratio (AGENTS.md §2.6)
});

// Ring schedules the encoder may pick from / the decoder will try (AGENTS.md §2.3).
// Each is just a ring count K; N_k depends only on k, so schedules are prefixes.
export const SCHEDULES = Object.freeze([4, 6, 8, 10, 12]);

/** Mid radius (u) of ring k (AGENTS.md §2.1). */
export function ringMidU(k, p = DEFAULT_PROFILE) {
  return p.Rp + p.dr * (k + 0.5);
}

/**
 * Segments-per-ring for rings 0..K-1 (AGENTS.md §2.3): N_k from constant arc
 * length, snapped to the nearest even number, clamped so N_k >= N_{k-1}.
 */
export function segCounts(K, p = DEFAULT_PROFILE) {
  const N = [];
  let prev = 0;
  for (let k = 0; k < K; k++) {
    const r = ringMidU(k, p);
    let n = 2 * Math.round((2 * Math.PI * r) / p.sSeg / 2); // nearest even
    if (n < 4) n = 4;
    if (n < prev) n = prev;
    N.push(n);
    prev = n;
  }
  return N;
}

/** Total raw data bits available for a given ring count (1 bit/segment, v1). */
export function capacityBits(K, p = DEFAULT_PROFILE) {
  return segCounts(K, p).reduce((a, b) => a + b, 0);
}

/**
 * Mono-profile RS layout for segment counts `N` (AGENTS.md §2.6): raw capacity,
 * codeword length, parity bytes (30% default) and usable data bytes. The encoder
 * and decoder MUST agree on these byte counts for a clean render to round-trip,
 * so the arithmetic lives here once rather than being repeated in each pipeline.
 */
export function monoLayout(N, p = DEFAULT_PROFILE) {
  const cap = N.reduce((a, b) => a + b, 0);
  const totalBytes = Math.floor(cap / 8);
  const parity = Math.max(2, Math.round(totalBytes * p.parity));
  return { cap, totalBytes, parity, dataBytes: totalBytes - parity };
}

/** Square image side in pixels for a symbol with K rings (AGENTS.md §2.1). */
export function imageSizePx(K, p = DEFAULT_PROFILE) {
  const radiusU = p.Rp + K * p.dr + p.quiet;
  return Math.round(2 * radiusU * p.u);
}

// ── RGB calibration markers (optional color-profile fiducials) ───────────────
// Three coloured "glints" in the OUTER quiet zone — past the black frame edge, on the
// blank white ring — arranged in a Y (one opposite the north ray). Because the quiet
// zone carries NO data, the markers cost ZERO capacity and don't touch any cell: a
// marker code has the exact same payload as a plain one, just with 3 dots painted
// outside the disc. They give the decoder (src/markers.js):
//   • extra non-collinear point correspondences → a robust perspective homography, and
//   • known R/G/B references (+ black pupil, white zone) → colour calibration.
// The geometry lives here (pure geometry) so encoder/renderer/decoder agree.

// Fixed marker positions: normalized radius (of the full disc incl. quiet zone), angle
// (deg, 0=up CW), and colour. rho ≈ 0.9 sits in the quiet zone, outside the frame ring.
export const MARKERS = Object.freeze([
  { rho: 0.9, deg: 180, rgb: [255, 0, 0] }, // opposite the north ray (bottom)
  { rho: 0.9, deg: 300, rgb: [0, 255, 0] },
  { rho: 0.9, deg: 60, rgb: [0, 0, 255] },
]);

/** Marker radius in module units — fits inside the (4u) quiet zone. */
export const MARKER_R_U = 1.5;

/** Frontal unit-disk coord (x right, y down; 0=up, clockwise) of marker `m`. */
export function markerFrontal(m) {
  const th = (m.deg * Math.PI) / 180;
  return [m.rho * Math.sin(th), -m.rho * Math.cos(th)];
}
