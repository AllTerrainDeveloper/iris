// RGB calibration markers — an optional, purely-additive fiducial upgrade.
//
// Three coloured dots (R, G, B) sit in the OUTER quiet zone — past the black frame
// edge, on the blank white ring — in a Y (one opposite the north ray). Since the quiet
// zone carries no data, they cost ZERO capacity and touch no cell: a marker code has
// the exact same payload as a plain one (a standard decoder still reads it), plus three
// dots outside the disc. On white they're trivially detectable, and they give:
//   • extra non-collinear correspondences → a robust perspective homography, and
//   • R/G/B (+ black pupil, white zone) colour references for calibration.
//
// Opt-in via `encode(text, { markers: true })`. Decode geometry is validated on clean
// captures (see test/markers.test.js); robustness under heavy warp is a work in progress.

import { segCounts, ringMidU, MARKERS, markerFrontal } from "./params.js";
import { bitsToBytes } from "./bits.js";
import { decodeStream } from "./blocks.js";
import { COLOR_PROFILE, SCHEDULES_COLOR, nearestColor } from "./color.js";
import { _internal as robustInternal, normalizeGrid } from "./robust.js";

// ── Homography (Hartley-normalized least-squares DLT, N≥4 correspondences) ────

function solve8(M, r) {
  const n = 8;
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let k = c + 1; k < n; k++) if (Math.abs(M[k][c]) > Math.abs(M[piv][c])) piv = k;
    [M[c], M[piv]] = [M[piv], M[c]];
    [r[c], r[piv]] = [r[piv], r[c]];
    const d = M[c][c] || 1e-12;
    for (let k = 0; k < n; k++) {
      if (k === c) continue;
      const f = M[k][c] / d;
      for (let j = c; j < n; j++) M[k][j] -= f * M[c][j];
      r[k] -= f * r[c];
    }
  }
  return Array.from({ length: n }, (_, i) => r[i] / (M[i][i] || 1e-12));
}

function rawDLT(pts) {
  const M = Array.from({ length: 8 }, () => new Float64Array(8));
  const r = new Float64Array(8);
  for (const { f, i } of pts) {
    const [x, y] = f, [X, Y] = i;
    const rows = [[x, y, 1, 0, 0, 0, -X * x, -X * y, X], [0, 0, 0, x, y, 1, -Y * x, -Y * y, Y]];
    for (const row of rows) {
      for (let a = 0; a < 8; a++) { r[a] += row[a] * row[8]; for (let b = 0; b < 8; b++) M[a][b] += row[a] * row[b]; }
    }
  }
  return [...solve8(M, r), 1];
}

// Similarity transform mapping a point set to centroid 0, mean distance √2 (Hartley).
function normMatrix(pl) {
  let mx = 0, my = 0;
  for (const p of pl) { mx += p[0]; my += p[1]; }
  mx /= pl.length; my /= pl.length;
  let d = 0;
  for (const p of pl) d += Math.hypot(p[0] - mx, p[1] - my);
  d /= pl.length;
  const s = d > 1e-9 ? Math.SQRT2 / d : 1;
  return [s, 0, -s * mx, 0, s, -s * my, 0, 0, 1];
}
const ap3 = (T, x, y) => [T[0] * x + T[1] * y + T[2], T[3] * x + T[4] * y + T[5]];
const mul3 = (A, B) => { const C = new Array(9).fill(0); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) C[i * 3 + j] += A[i * 3 + k] * B[k * 3 + j]; return C; };
function inv3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C || 1e-12;
  return [A / det, (c * h - b * i) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, (c * d - a * f) / det, C / det, (b * g - a * h) / det, (a * e - b * d) / det];
}

/**
 * Fit a homography from correspondences [{ f:[x,y] (frontal), i:[X,Y] (image) }].
 * Coordinates are Hartley-normalized first — frontal points are ~unit scale but image
 * points span hundreds of px, and without normalization the DLT normal equations are
 * badly ill-conditioned (the classic homography pitfall).
 */
export function fitHomography(pts) {
  const Tf = normMatrix(pts.map((p) => p.f));
  const Ti = normMatrix(pts.map((p) => p.i));
  const np = pts.map((p) => ({ f: ap3(Tf, p.f[0], p.f[1]), i: ap3(Ti, p.i[0], p.i[1]) }));
  const H = mul3(mul3(inv3(Ti), rawDLT(np)), Tf);
  return H.map((v) => v / (H[8] || 1e-12));
}

export function applyHomography(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

// ── Homography-based cell sampler / decoder ──────────────────────────────────

function sampleAt(grid, px, py) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      const x = Math.round(px) + ox, y = Math.round(py) + oy;
      if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) continue;
      const o = (y * grid.width + x) * 3;
      r += grid.data[o]; g += grid.data[o + 1]; b += grid.data[o + 2]; n++;
    }
  }
  return n ? nearestColor(r / n, g / n, b / n) : 7;
}

/**
 * Decode an RGB grid by sampling each data cell through a known homography H
 * (frontal unit-disk → image). `scale` globally trims the sampling radius (a small
 * search covers residual geometry error). Returns { text, K } or null.
 */
export function decodeViaHomography(grid, H, scale = 1, p = COLOR_PROFILE) {
  for (const K of SCHEDULES_COLOR) {
    const radiusU = p.Rp + K * p.dr + p.quiet;
    const N = segCounts(K, p);
    const bits = [];
    for (let k = 0; k < K; k++) {
      const rho = (scale * ringMidU(k, p)) / radiusU;
      const dk = (2 * Math.PI) / N[k];
      for (let i = 1; i < N[k]; i++) {   // segment 0 is the ray; markers reserve no cells
        const th = i * dk;
        const [px, py] = applyHomography(H, rho * Math.sin(th), -rho * Math.cos(th));
        const v = sampleAt(grid, px, py);
        for (let b = p.bitsPerCell - 1; b >= 0; b--) bits.push((v >> b) & 1);
      }
    }
    const cells = N.reduce((a, b) => a + b, 0) - K;
    const totalBytes = Math.floor((cells * p.bitsPerCell) / 8);
    const code = bitsToBytes(bits.slice(0, totalBytes * 8));
    const text = decodeStream(code, totalBytes);
    if (text !== null) return { text, K };
  }
  return null;
}

// ── RGB marker + pupil detection ─────────────────────────────────────────────

// Find each RGB marker's centroid. They sit in the QUIET ZONE, so we only search the
// annulus OUTSIDE the fitted disc ellipse (rr > 1) — crucially NOT overlapping the data
// disc, where same-coloured DATA cells would otherwise drag the centroid to the middle.
function detectMarkers(grid, O, M) {
  const { width: W, height: H, data } = grid;
  const det = M[0] * M[3] - M[1] * M[2] || 1e-9;
  const i0 = M[3] / det, i1 = -M[1] / det, i2 = -M[2] / det, i3 = M[0] / det;
  const domCh = (rgb) => (rgb[0] > 200 ? 0 : rgb[1] > 200 ? 1 : 2); // marker's dominant channel
  const markerCh = MARKERS.map((m) => domCh(m.rgb));
  const acc = MARKERS.map(() => [0, 0, 0]);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x - O[0], dy = y - O[1];
      const u = i0 * dx + i1 * dy, v = i2 * dx + i3 * dy;
      const rr = Math.hypot(u, v);
      if (rr < 1.02 || rr > 1.55) continue;            // quiet zone only, never the data
      const o = (y * W + x) * 3, r = data[o], g = data[o + 1], b = data[o + 2];
      const mx = Math.max(r, g, b);
      if (mx - Math.min(r, g, b) < 45) continue;        // must be saturated (not white/black)
      const ch = mx === r ? 0 : mx === g ? 1 : 2;       // this pixel's dominant channel
      for (let j = 0; j < MARKERS.length; j++) {
        if (ch === markerCh[j]) { acc[j][0] += x; acc[j][1] += y; acc[j][2]++; }
      }
    }
  }
  return acc.map((a) => (a[2] > 3 ? [a[0] / a[2], a[1] / a[2]] : null));
}

// Pupil centre = centroid of the small central black dot. Kept TIGHT (rr < ~0.13) so the
// black registration ray (a spoke through the centre) doesn't drag the estimate.
function findPupil(grid, O, M) {
  const { width: W, height: H, data } = grid;
  const det = M[0] * M[3] - M[1] * M[2] || 1e-9;
  const i0 = M[3] / det, i1 = -M[1] / det, i2 = -M[2] / det, i3 = M[0] / det;
  let sx = 0, sy = 0, n = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x - O[0], dy = y - O[1];
      const u = i0 * dx + i1 * dy, v = i2 * dx + i3 * dy;
      if (u * u + v * v > 0.13 * 0.13) continue;
      const o = (y * W + x) * 3;
      if (Math.max(data[o], data[o + 1], data[o + 2]) < 80) { sx += x; sy += y; n++; }
    }
  }
  return n > 10 ? [sx / n, sy / n] : O;
}

/**
 * Decode a marker-bearing RGB grid (a disc cropped roughly onto white) via the RGB
 * markers: rough-localize (reusing the robust decoder's locate + ellipse fit), detect
 * the 3 quiet-zone RGB dots + the pupil, fit a homography, and sample every cell through
 * it. Pass `{ pupil, markerPts }` to supply exact geometry (e.g. from an ML detector) and
 * skip detection. Returns { text, K } or null.
 *
 * STATUS: geometry-driven decode, validated on clean/mild captures. Robustness under
 * heavy warp is a work in progress (the crop must keep the quiet-zone markers in-frame).
 */
export function decodeColorMarkers(rawGrid, opts = {}) {
  const grid = normalizeGrid(rawGrid); // undo dim lighting / color cast first
  let pts;
  if (opts.pupil && opts.markerPts && opts.markerPts.length === MARKERS.length) {
    pts = [{ f: [0, 0], i: opts.pupil }];
    MARKERS.forEach((mk, j) => pts.push({ f: markerFrontal(mk), i: opts.markerPts[j] }));
  } else {
    const { buildMaps, locate, fitEllipse } = robustInternal;
    let O, M;
    try {
      const maps = buildMaps(grid);
      const loc = locate(grid);
      ({ O, M } = fitEllipse(maps, loc.cx, loc.cy, loc.radiusPx));
    } catch { return null; }
    const found = detectMarkers(grid, O, M);
    if (found.some((f) => !f)) return null;             // need all 3 markers
    pts = [{ f: [0, 0], i: findPupil(grid, O, M) }];
    MARKERS.forEach((mk, j) => pts.push({ f: markerFrontal(mk), i: found[j] }));
  }
  const H = fitHomography(pts);
  for (const scale of [1, 0.98, 1.02, 0.96, 1.04]) {
    const r = decodeViaHomography(grid, H, scale);
    if (r) return r;
  }
  return null;
}
