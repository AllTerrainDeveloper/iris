// Robust color decode (Track-2). Recovers center, scale, any rotation AND
// perspective from a distorted RGB grid, then samples + RS/erasure-corrects.
//
//  • Rotation (Reddy & Chatterji, Fourier–Mellin): a rotation is a shift along
//    the angle axis. We get candidate angles from the full-radius registration
//    ray AND from palette-snap alignment (so a scratch over the ray doesn't break
//    orientation); RS+CRC is the final arbiter.
//  • Perspective (AGENTS.md §3 step 3): the image of a circle is an ELLIPSE. We
//    fit the outer boundary for the affine part, then add a Klein/PROJECTIVE disk
//    offset (seeded from the bullseye core) for the non-linear foreshortening — a
//    full homography of the disk. (A conformal Blaschke map can't: real camera
//    foreshortening keeps straight chords straight, which conformal maps don't.)
//  • Scratches: damaged cells become Reed–Solomon ERASURES (half the parity cost
//    of unknown errors) — the decoder rebuilds what's hidden.
//
// Speed: per-pixel nearest-palette index, "clean" and "near-white" masks are
// precomputed ONCE, so the thousands of geometry evaluations are O(1) lookups.

import { segCounts, ringMidU } from "./params.js";
import { bitsToBytes } from "./bits.js";
import { decodeStream } from "./blocks.js";
import { COLOR_PROFILE, SCHEDULES_COLOR, PALETTE } from "./color.js";

// Monotonic clock for the optional decode budget (browser + Node).
const now = (typeof performance !== "undefined" && performance.now)
  ? () => performance.now()
  : () => Date.now();

// ── Photometric calibration ──────────────────────────────────────────────────

// Flatten spatially varying illumination (a shadow across the print). The local
// white level is estimated per tile from near-white pixels — min(r,g,b) is high
// ONLY for whites (saturated palette colors and ink drop at least one channel) —
// as the tile's 95th percentile of that min. Tiles that saw no white (deep in
// the pupil, or all-color cells) inherit the level from their neighbours; the
// field is smoothed, bilinearly upsampled, and each pixel is scaled so paper
// reads uniformly white. Gain is relative to the GLOBAL white point, so this is
// an identity on evenly lit images; the global stretch below then fixes overall
// level and per-channel casts.
function flattenIllumination(grid) {
  const { width: W, height: H, data } = grid;
  const TILE = 48;
  const tx = Math.ceil(W / TILE);
  const ty = Math.ceil(H / TILE);
  const hists = Array.from({ length: tx * ty }, () => new Uint32Array(256));
  const counts = new Uint32Array(tx * ty);
  for (let y = 0; y < H; y++) {
    const tyi = (y / TILE) | 0;
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 3;
      const w = Math.min(data[o], data[o + 1], data[o + 2]);
      const t = tyi * tx + ((x / TILE) | 0);
      hists[t][w]++;
      counts[t]++;
    }
  }
  const p95 = (h, n) => {
    let acc = 0;
    for (let v = 255; v >= 0; v--) {
      acc += h[v];
      if (acc >= 0.05 * n) return v;
    }
    return 0;
  };
  const field = new Float32Array(tx * ty);
  const valid = new Uint8Array(tx * ty);
  let globalWhite = 0;
  for (let t = 0; t < tx * ty; t++) {
    field[t] = p95(hists[t], counts[t]);
    valid[t] = field[t] >= 60 ? 1 : 0; // below this there's no credible paper white
    if (field[t] > globalWhite) globalWhite = field[t];
  }
  if (globalWhite < 60) return grid; // no white anywhere — nothing to calibrate
  // Fill white-less tiles from neighbours (repeat until the field is dense).
  for (let pass = 0; pass < tx + ty; pass++) {
    let missing = 0;
    for (let t = 0; t < tx * ty; t++) {
      if (valid[t]) continue;
      let s = 0;
      let n = 0;
      const x = t % tx;
      const y = (t / tx) | 0;
      for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const xx = x + ox;
        const yy = y + oy;
        if (xx < 0 || yy < 0 || xx >= tx || yy >= ty) continue;
        const tt = yy * tx + xx;
        if (valid[tt]) { s += field[tt]; n++; }
      }
      if (n) { field[t] = s / n; valid[t] = 2; } // 2 = filled this pass
      else missing++;
    }
    for (let t = 0; t < tx * ty; t++) if (valid[t] === 2) valid[t] = 1;
    if (!missing) break;
  }
  // One smoothing pass so tile seams don't imprint on the gain field.
  const smooth = new Float32Array(tx * ty);
  for (let y = 0; y < ty; y++)
    for (let x = 0; x < tx; x++) {
      let s = 0;
      let n = 0;
      for (let oy = -1; oy <= 1; oy++)
        for (let ox = -1; ox <= 1; ox++) {
          const xx = x + ox;
          const yy = y + oy;
          if (xx < 0 || yy < 0 || xx >= tx || yy >= ty) continue;
          s += field[yy * tx + xx];
          n++;
        }
      smooth[y * tx + x] = s / n;
    }
  // Bilinear gain per pixel, capped so deep shadows don't explode sensor noise.
  const out = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    const fy = Math.min(ty - 1, Math.max(0, y / TILE - 0.5));
    const y0 = fy | 0;
    const y1 = Math.min(ty - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < W; x++) {
      const fx = Math.min(tx - 1, Math.max(0, x / TILE - 0.5));
      const x0 = fx | 0;
      const x1 = Math.min(tx - 1, x0 + 1);
      const wx = fx - x0;
      const local =
        smooth[y0 * tx + x0] * (1 - wx) * (1 - wy) +
        smooth[y0 * tx + x1] * wx * (1 - wy) +
        smooth[y1 * tx + x0] * (1 - wx) * wy +
        smooth[y1 * tx + x1] * wx * wy;
      const gain = Math.min(4, globalWhite / Math.max(24, local));
      const o = (y * W + x) * 3;
      out[o] = Math.min(255, data[o] * gain);
      out[o + 1] = Math.min(255, data[o + 1] * gain);
      out[o + 2] = Math.min(255, data[o + 2] * gain);
    }
  }
  return { width: W, height: H, data: out };
}

// Per-channel levels stretch: map each channel's 1st percentile to 0 and its
// 99th to 255. A symbol always contains near-black ink (pupil, ray) and a big
// near-white region (background/quiet zone), so those percentiles ARE the
// image's black and white points — undoing dim lighting AND color casts (a
// warm cast lowers the blue white-point; the stretch restores it) before any
// pixel is classified against the pure palette. Identity on clean renders.
// Spatially varying light (a shadow) is flattened first, so the stretch sees a
// uniformly lit image.
export function normalizeGrid(rawGrid) {
  const grid = flattenIllumination(rawGrid);
  const { width, height, data } = grid;
  const n = width * height;
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  for (let i = 0, o = 0; i < n; i++, o += 3) {
    hist[0][data[o]]++;
    hist[1][data[o + 1]]++;
    hist[2][data[o + 2]]++;
  }
  const percentile = (h, q) => {
    const target = q * n;
    let acc = 0;
    for (let v = 0; v < 256; v++) {
      acc += h[v];
      if (acc >= target) return v;
    }
    return 255;
  };
  const out = new Uint8Array(n * 3);
  for (let c = 0; c < 3; c++) {
    const lo = percentile(hist[c], 0.01);
    const hi = percentile(hist[c], 0.99);
    if (hi - lo < 32) return grid; // flat image — no contrast to calibrate from
    const scale = 255 / (hi - lo);
    const lut = new Uint8Array(256);
    for (let v = 0; v < 256; v++) lut[v] = Math.max(0, Math.min(255, Math.round((v - lo) * scale)));
    for (let i = 0, o = c; i < n; i++, o += 3) out[o] = lut[data[o]];
  }
  return { width, height, data: out };
}

// ── Pixel maps & sampling ────────────────────────────────────────────────────

// Precompute per-pixel palette index, "clean" (interior of a solid cell) and
// "near-white" masks. This is the cache that makes the search fast.
//
// A 3×3 MODE (majority) filter denoises the index map: salt-and-pepper noise is
// isolated single pixels, so it is never the mode of its own neighbourhood and
// gets overwritten by the surrounding cell colour. "clean" then means strong
// local agreement (≥6/9 share the mode) — true at cell interiors, false on
// boundaries and on noise — which is exactly the signal snap & the fail-fast
// gate want. Without this, ~10% pixel noise alone drops snap below threshold.
function buildMaps(grid) {
  const { width: W, height: H, data } = grid;
  const raw = new Uint8Array(W * H); // per-pixel nearest palette colour
  for (let i = 0, o = 0; i < W * H; i++, o += 3) {
    const r = data[o];
    const g = data[o + 1];
    const b = data[o + 2];
    let best = 0;
    let bd = Infinity;
    for (let k = 0; k < 8; k++) {
      const d = (r - PALETTE[k][0]) ** 2 + (g - PALETTE[k][1]) ** 2 + (b - PALETTE[k][2]) ** 2;
      if (d < bd) { bd = d; best = k; }
    }
    raw[i] = best;
  }
  const idx = new Uint8Array(W * H);
  const clean = new Uint8Array(W * H);
  const white = new Uint8Array(W * H);
  const cnt = new Int16Array(8);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      cnt.fill(0);
      let tot = 0;
      for (let oy = -1; oy <= 1; oy++) {
        const yy = y + oy;
        if (yy < 0 || yy >= H) continue;
        for (let ox = -1; ox <= 1; ox++) {
          const xx = x + ox;
          if (xx < 0 || xx >= W) continue;
          cnt[raw[yy * W + xx]]++;
          tot++;
        }
      }
      let mode = 0;
      for (let k = 1; k < 8; k++) if (cnt[k] > cnt[mode]) mode = k;
      const i = y * W + x;
      idx[i] = mode;
      // Strong local agreement = solid-cell interior (robust to 1–2 noise pixels).
      if (cnt[mode] * 9 >= 6 * tot) clean[i] = 1;
      if (mode === 7) white[i] = 1;
    }
  return { W, H, idx, clean, white };
}

const idxAt = (m, px, py) => {
  const x = Math.round(px);
  const y = Math.round(py);
  if (x < 0 || y < 0 || x >= m.W || y >= m.H) return 7;
  return m.idx[y * m.W + x];
};
const cleanAt = (m, px, py) => {
  const x = Math.round(px);
  const y = Math.round(py);
  return x >= 0 && y >= 0 && x < m.W && y < m.H ? m.clean[y * m.W + x] : 0;
};
// 3×3 majority palette index (used for the final decode pass).
function idxMajority(m, px, py) {
  const cx = Math.round(px);
  const cy = Math.round(py);
  const cnt = [0, 0, 0, 0, 0, 0, 0, 0];
  let any = false;
  for (let oy = -1; oy <= 1; oy++)
    for (let ox = -1; ox <= 1; ox++) {
      const x = cx + ox;
      const y = cy + oy;
      if (x < 0 || y < 0 || x >= m.W || y >= m.H) continue;
      cnt[m.idx[y * m.W + x]]++;
      any = true;
    }
  if (!any) return 7;
  let bi = 0;
  for (let k = 1; k < 8; k++) if (cnt[k] > cnt[bi]) bi = k;
  return bi;
}

// Normalized disk coord -> pixel. The image of a circle under a real camera is a
// projective (not conformal) view, so the disk automorphism must be PROJECTIVE:
// the Klein/Beltrami translation moving the disk centre to a=(ax,ay). It preserves
// the unit circle (so the ellipse fit still pins the boundary) while reproducing
// the true foreshortening — straight chords stay straight, unlike a Blaschke map.
// Derivation: a Lorentz boost to "velocity" a in the hyperboloid model of the disk
//   t = 1 + a·z,  γ = 1/√(1-|a|²),  k = (γ-1)(a·z)/|a|²
//   z' = ( a·(γ+k) + z ) / (γ·t)
// Then pixel = O + affine M · z'. (a=0 → identity → pure ellipse/affine.)
function mapPoint(O, M, nx, ny, ax = 0, ay = 0) {
  let wr = nx;
  let wi = ny;
  const a2 = ax * ax + ay * ay;
  if (a2 > 1e-12) {
    const g = 1 / Math.sqrt(Math.max(1e-9, 1 - a2));
    const adotz = ax * nx + ay * ny;
    const k = ((g - 1) * adotz) / a2;
    const t = 1 + adotz;
    const inv = 1 / (g * (Math.abs(t) < 1e-6 ? (t < 0 ? -1e-6 : 1e-6) : t));
    wr = (ax * (g + k) + nx) * inv;
    wi = (ay * (g + k) + ny) * inv;
  }
  return [O[0] + M[0] * wr + M[1] * wi, O[1] + M[2] * wr + M[3] * wi];
}

// ── Geometry: locate & ellipse fit ───────────────────────────────────────────

function locate(grid) {
  const { width: W, height: H, data } = grid;
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 3;
      if (!(data[o] > 235 && data[o + 1] > 235 && data[o + 2] > 235)) { sx += x; sy += y; n++; }
    }
  }
  if (n < 50) throw new Error("no symbol found (image looks blank)");
  const cx = sx / n;
  const cy = sy / n;
  const maxR = Math.ceil(Math.hypot(Math.max(cx, W - cx), Math.max(cy, H - cy)));
  const count = new Float64Array(maxR + 1);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 3;
      if (data[o] > 235 && data[o + 1] > 235 && data[o + 2] > 235) continue;
      const r = Math.round(Math.hypot(x - cx, y - cy));
      if (r <= maxR) count[r]++;
    }
  }
  const density = (r) => count[r] / (2 * Math.PI * (r + 0.5));
  const inner = [];
  for (let r = 3; r < maxR / 3; r++) inner.push(density(r));
  inner.sort((a, b) => a - b);
  const D = inner.length ? inner[Math.floor(inner.length / 2)] : 0;
  let radiusPx = 3;
  for (let r = 3; r <= maxR; r++) if (density(r) > 0.5 * D) radiusPx = r;
  return { cx, cy, radiusPx };
}

function solve(A, b) {
  const n = b.length;
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    if (Math.abs(A[piv][col]) < 1e-12) return null;
    [A[col], A[piv]] = [A[piv], A[col]];
    [b[col], b[piv]] = [b[piv], b[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = A[r][col] / A[col][col];
      for (let c = col; c < n; c++) A[r][c] -= f * A[col][c];
      b[r] -= f * b[col];
    }
  }
  return b.map((v, i) => v / A[i][i]);
}

// Fit the outer boundary to an ellipse; returns { O, M } (M maps unit circle ->
// ellipse). Falls back to a circle if the fit is poor.
function fitEllipse(m, cx, cy, radiusPx) {
  const fallback = { O: [cx, cy], M: [radiusPx, 0, 0, radiusPx] };
  const STEPS = 360;
  const pts = [];
  const nonWhite = (r, th) => {
    const x = Math.round(cx + r * Math.sin(th));
    const y = Math.round(cy - r * Math.cos(th));
    return x >= 0 && y >= 0 && x < m.W && y < m.H && !m.white[y * m.W + x];
  };
  for (let s = 0; s < STEPS; s++) {
    const th = (s / STEPS) * 2 * Math.PI;
    for (let r = radiusPx * 1.25; r > radiusPx * 0.4; r -= 1.5) {
      if (nonWhite(r, th) && nonWhite(r - 4, th)) {
        pts.push([cx + r * Math.sin(th), cy - r * Math.cos(th)]);
        break;
      }
    }
  }
  if (pts.length < 40) return fallback;
  const radii = pts.map((q) => Math.hypot(q[0] - cx, q[1] - cy)).sort((a, b) => a - b);
  const med = radii[radii.length >> 1];
  const good = pts.filter((q) => Math.abs(Math.hypot(q[0] - cx, q[1] - cy) - med) < 0.35 * med);
  if (good.length < 30) return fallback;

  const A = [[0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0]];
  const rhs = [0, 0, 0, 0, 0];
  for (const [pxv, pyv] of good) {
    const X = (pxv - cx) / radiusPx;
    const Y = (pyv - cy) / radiusPx;
    const row = [X * X, X * Y, Y * Y, X, Y];
    for (let i = 0; i < 5; i++) {
      for (let j = 0; j < 5; j++) A[i][j] += row[i] * row[j];
      rhs[i] += row[i];
    }
  }
  const sol = solve(A, rhs);
  if (!sol) return fallback;
  const [a, b, c, d, e] = sol;
  const f = -1;
  const cen = solve([[2 * a, b], [b, 2 * c]], [-d, -e]);
  if (!cen) return fallback;
  const [ux, uy] = cen;
  const fp = a * ux * ux + b * ux * uy + c * uy * uy + d * ux + e * uy + f;
  const A2 = a;
  const B2 = b / 2;
  const C2 = c;
  const tr = A2 + C2;
  const det = A2 * C2 - B2 * B2;
  const disc = Math.sqrt(Math.max(0, (tr / 2) ** 2 - det));
  const l1 = tr / 2 + disc;
  const l2 = tr / 2 - disc;
  if (l1 <= 0 || l2 <= 0 || -fp <= 0) return fallback;
  const ev = (l) => {
    let vx = B2;
    let vy = l - A2;
    if (Math.abs(vx) < 1e-9 && Math.abs(vy) < 1e-9) { vx = 1; vy = 0; }
    const nn = Math.hypot(vx, vy);
    return [vx / nn, vy / nn];
  };
  const [v1x, v1y] = ev(l1);
  const [v2x, v2y] = ev(l2);
  const s1 = Math.sqrt(-fp / l1) * radiusPx;
  const s2 = Math.sqrt(-fp / l2) * radiusPx;
  let M = [v1x * s1, v2x * s2, v1y * s1, v2y * s2];
  if (M[0] * M[3] - M[1] * M[2] < 0) M = [M[0], -M[1], M[2], -M[3]];
  if (s1 > radiusPx * 2.2 || s2 < radiusPx * 0.3) return fallback;
  return { O: [cx + ux * radiusPx, cy + uy * radiusPx], M };
}

// ── Candidate scoring ────────────────────────────────────────────────────────

// Candidate rotation angles from the full-radius registration ray (dark run).
function rayCandidates(m, O, M, ax = 0, ay = 0) {
  const BINS = 1440;
  const RAD = 24;
  const score = new Float32Array(BINS);
  for (let b = 0; b < BINS; b++) {
    const theta = (b / BINS) * 2 * Math.PI;
    const sin = Math.sin(theta);
    const cos = Math.cos(theta);
    let s = 0;
    for (let j = 0; j < RAD; j++) {
      const rn = 0.5 + (0.45 * j) / (RAD - 1);
      const [px, py] = mapPoint(O, M, rn * sin, -rn * cos, ax, ay);
      if (idxAt(m, px, py) === 0) s++;
    }
    score[b] = s;
  }
  let maxS = 0;
  for (let b = 0; b < BINS; b++) if (score[b] > maxS) maxS = score[b];
  const T = Math.max(maxS * 0.7, RAD * 0.5);
  let start = 0;
  for (let b = 0; b < BINS; b++) if (score[b] < T) { start = b; break; }
  const runs = [];
  let inRun = false;
  let runStartI = 0;
  let strength = 0;
  for (let i = 0; i <= BINS; i++) {
    const b = (start + i) % BINS;
    const hi = i < BINS && score[b] >= T;
    if (hi) {
      if (!inRun) { inRun = true; runStartI = i; strength = 0; }
      strength += score[b];
    } else if (inRun) {
      // The ray is cell 0, centered on theta0, so use the run CENTRE (not its start).
      const cb = (((start + (runStartI + i - 1) / 2) % BINS) + BINS) % BINS;
      runs.push({ theta: (cb / BINS) * 2 * Math.PI, strength });
      inRun = false;
    }
  }
  runs.sort((a, b) => b.strength - a.strength);
  return runs.slice(0, 8).map((r) => r.theta);
}

// Fraction of data cells landing on a clean palette color (no RS). Peaks at the
// correct geometry even if the ray is damaged — used to find rotation robustly.
function snapScore(m, p, K, N, O, M, theta0, ax, ay, stride = 1) {
  const outerU = p.Rp + K * p.dr;
  let good = 0;
  let total = 0;
  let ci = 0;
  for (let k = 0; k < K; k++) {
    const rn = ringMidU(k, p) / outerU;
    const dk = (2 * Math.PI) / N[k];
    for (let i = 1; i < N[k]; i++) {
      if (ci++ % stride) continue;
      const theta = theta0 + i * dk; // cell i centered on i·dk (ray = cell 0 on theta0)
      const [px, py] = mapPoint(O, M, rn * Math.sin(theta), -rn * Math.cos(theta), ax, ay);
      if (cleanAt(m, px, py)) good++;
      total++;
    }
  }
  return total ? good / total : 0;
}

// Fraction of registration-ray cells (segment 0) that are black — a strong
// disambiguator when the ray is intact (used for perspective ranking).
function rayFrac(m, p, K, N, O, M, theta0, ax, ay) {
  const outerU = p.Rp + K * p.dr;
  let dark = 0;
  for (let k = 0; k < K; k++) {
    const rn = ringMidU(k, p) / outerU;
    const t = theta0; // registration ray = cell 0, centered on theta0
    const [px, py] = mapPoint(O, M, rn * Math.sin(t), -rn * Math.cos(t), ax, ay);
    if (idxAt(m, px, py) === 0) dark++;
  }
  return dark / K;
}
const rankScore = (m, p, K, N, O, M, t, ax, ay, stride = 1) =>
  snapScore(m, p, K, N, O, M, t, ax, ay, stride) + 2 * rayFrac(m, p, K, N, O, M, t, ax, ay);

// Rotation candidates at a given projective offset, best first. Snap is
// cell-PERIODIC (it measures "on a cell", not "the right cell") and its plateau
// centres drift by up to a cell under anti-aliasing, so we DON'T collapse to
// centres. Instead we keep every fine-resolution angle whose cells are well
// aligned (snap near its max) and rank them by registration-ray darkness — the
// one true rotation is the angle that puts segment 0 of every ring on black.
function thetaCandidates(m, p, K, N, O, M, ax = 0, ay = 0) {
  const STEPS = Math.max(180, N[K - 1] * 5);
  const snap = new Float32Array(STEPS);
  let mx = 0;
  for (let s = 0; s < STEPS; s++) {
    snap[s] = snapScore(m, p, K, N, O, M, (s / STEPS) * 2 * Math.PI, ax, ay, 2);
    if (snap[s] > mx) mx = snap[s];
  }
  // Relative threshold: blur + noise can pull the peak snap well below 1, so a
  // fixed floor would yield zero candidates. Track angles near whatever max the
  // image supports (with a low absolute floor to reject pure garbage geometry).
  const T = Math.max(0.5, mx - 0.08);
  const out = [];
  for (let s = 0; s < STEPS; s++) {
    if (snap[s] < T) continue;
    const theta = (s / STEPS) * 2 * Math.PI;
    out.push({ theta, r: rayFrac(m, p, K, N, O, M, theta, ax, ay) });
  }
  out.sort((a, b) => b.r - a.r);
  return out.slice(0, 6).map((o) => o.theta);
}

// Connected near-white streaks inside the disk that are too long to be a single
// white data cell = scratches. Returns a dilated per-pixel damage mask.
function damageMask(m, O, M) {
  const { W, H, white } = m;
  const det = M[0] * M[3] - M[1] * M[2] || 1e-9;
  const i0 = M[3] / det;
  const i1 = -M[1] / det;
  const i2 = -M[2] / det;
  const i3 = M[0] / det;
  const meanAxis = (Math.hypot(M[0], M[2]) + Math.hypot(M[1], M[3])) / 2;
  const inside = new Uint8Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      if (!white[y * W + x]) continue;
      const dx = x - O[0];
      const dy = y - O[1];
      const vx = i0 * dx + i1 * dy;
      const vy = i2 * dx + i3 * dy;
      if (vx * vx + vy * vy < 0.98 * 0.98) inside[y * W + x] = 1; // inside the ellipse
    }
  const seen = new Uint8Array(W * H);
  const mask = new Uint8Array(W * H);
  const longSide = 0.18 * meanAxis;
  const stack = [];
  const visit = (j) => {
    if (inside[j] && !seen[j]) {
      seen[j] = 1;
      stack.push(j);
    }
  };
  for (let s = 0; s < W * H; s++) {
    if (!inside[s] || seen[s]) continue;
    // Flood-fill the connected white component, tracking its bounding box.
    let minx = W, miny = H, maxx = 0, maxy = 0;
    const comp = [];
    visit(s);
    while (stack.length) {
      const idx = stack.pop();
      comp.push(idx);
      const x = idx % W;
      const y = (idx / W) | 0;
      if (x < minx) minx = x;
      if (x > maxx) maxx = x;
      if (y < miny) miny = y;
      if (y > maxy) maxy = y;
      if (x > 0) visit(idx - 1);
      if (x < W - 1) visit(idx + 1);
      if (y > 0) visit(idx - W);
      if (y < H - 1) visit(idx + W);
    }
    // Long components are scratches; isolated white data cells are short.
    if (maxx - minx > longSide || maxy - miny > longSide) for (const idx of comp) mask[idx] = 1;
  }
  const dil = new Uint8Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      if (!mask[y * W + x]) continue;
      for (let oy = -2; oy <= 2; oy++)
        for (let ox = -2; ox <= 2; ox++) {
          const xx = x + ox;
          const yy = y + oy;
          if (xx >= 0 && yy >= 0 && xx < W && yy < H) dil[yy * W + xx] = 1;
        }
    }
  return dil;
}

// Sample all data cells (skipping segment 0) and RS-decode; damaged cells -> erasures.
function attempt(m, p, K, N, O, M, theta0, ax, ay, damage) {
  const outerU = p.Rp + K * p.dr;
  const bits = [];
  const eraseCells = [];
  let ci = 0;
  let cleanN = 0;
  let cleanTot = 0;
  for (let k = 0; k < K; k++) {
    const rn = ringMidU(k, p) / outerU;
    const dk = (2 * Math.PI) / N[k];
    for (let i = 1; i < N[k]; i++) {
      const theta = theta0 + i * dk; // cell i centered on i·dk (ray = cell 0 on theta0)
      const [px, py] = mapPoint(O, M, rn * Math.sin(theta), -rn * Math.cos(theta), ax, ay);
      const v = idxMajority(m, px, py);
      for (let bb = p.bitsPerCell - 1; bb >= 0; bb--) bits.push((v >> bb) & 1);
      const xx = Math.round(px);
      const yy = Math.round(py);
      const inB = xx >= 0 && yy >= 0 && xx < m.W && yy < m.H;
      if (damage && inB && damage[yy * m.W + xx]) eraseCells.push(ci);
      else {
        cleanTot++;
        if (inB && m.clean[yy * m.W + xx]) cleanN++;
      }
      ci++;
    }
  }
  // Fail-fast: wrong geometry sprays cells across boundaries -> few land on a pure
  // palette color. Skip the (3×) RS work unless the geometry looks plausible.
  if (cleanTot && cleanN / cleanTot < 0.55) return null;
  const cells = N.reduce((a, b) => a + b, 0) - K;
  const totalBytes = Math.floor((cells * p.bitsPerCell) / 8);

  const eraseBytes = new Set();
  for (const c of eraseCells) {
    const b0 = (3 * c) >> 3;
    const b1 = (3 * c + 2) >> 3;
    if (b0 < totalBytes) eraseBytes.add(b0);
    if (b1 < totalBytes) eraseBytes.add(b1);
  }
  const erasures = [...eraseBytes].sort((a, b) => a - b);
  const code = bitsToBytes(bits.slice(0, totalBytes * 8));

  // Sample once; decodeStream tries each adaptive parity level (the encoder
  // used the highest that fit) across the interleaved RS blocks. Erasures
  // (scratched cells) are routed to their blocks and used where they fit.
  return decodeStream(code, totalBytes, erasures);
}

// ── Search configuration & geometry helpers ──────────────────────────────────

const SCALE_TRIM = [1.0, 0.97, 1.03]; // radius-estimate corrections
// Max ellipse axis ratio treated as "no perspective". Kept tight: a real
// keystone (even persp 0.2) already shows ratio ~1.15, and must be routed to the
// perspective phase, NOT the scratched-ray brute force (whose snap gate saturates
// and sprays thousands of futile RS attempts). Pure rotation keeps the symbol
// circular (ratio ≈ 1.0), so genuine scratched-ray cases still qualify.
const NEAR_CIRCULAR = 1.08;

const scaleM = (M, f) => [M[0] * f, M[1] * f, M[2] * f, M[3] * f];
const meanAxisLen = (M) => (Math.hypot(M[0], M[2]) + Math.hypot(M[1], M[3])) / 2;
const axisRatio = (M) => {
  const a = Math.hypot(M[0], M[2]);
  const b = Math.hypot(M[1], M[3]);
  return Math.max(a, b) / Math.min(a, b);
};
const maskHasInk = (mask) => mask.some((v) => v !== 0);

// Module size implied if the image were schedule K; the true K matches the
// profile's render size (p.u) most closely.
const impliedModuleSize = (p, M, K) => meanAxisLen(M) / (p.Rp + K * p.dr);

// Ring schedules whose implied module size is physically plausible.
const viableK = (p, M) =>
  SCHEDULES_COLOR.filter((K) => {
    const u = impliedModuleSize(p, M, K);
    return u >= 3 && u <= 30;
  });

// Viable schedules, most-likely (best-fitting module size) first.
const schedulesByFit = (p, M) =>
  viableK(p, M).sort((a, b) => Math.abs(impliedModuleSize(p, M, a) - p.u) - Math.abs(impliedModuleSize(p, M, b) - p.u));

// Image of the symbol centre, from the dark bullseye core (the pupil dot + ring
// sit AT the disk centre). Under perspective this lands well away from the fitted
// ellipse centre O — that displacement IS the projective foreshortening, so it
// seeds the Klein offset directly: image(centre) = O + M·a  ⇒  a = M⁻¹(core − O).
// Cheap, ray-independent, and (unlike snap/ray proxies) it does NOT saturate.
function coreOffset(m, O, M) {
  const det = M[0] * M[3] - M[1] * M[2] || 1e-9;
  const i0 = M[3] / det, i1 = -M[1] / det, i2 = -M[2] / det, i3 = M[0] / det;
  let sx = 0, sy = 0, n = 0;
  for (let y = 0; y < m.H; y++)
    for (let x = 0; x < m.W; x++) {
      if (m.idx[y * m.W + x] !== 0) continue; // black pixels only
      const dx = x - O[0], dy = y - O[1];
      const vx = i0 * dx + i1 * dy, vy = i2 * dx + i3 * dy;
      if (vx * vx + vy * vy < 0.45 * 0.45) { sx += x; sy += y; n++; } // inner core
    }
  if (n < 12) return [0, 0];
  const dx = sx / n - O[0], dy = sy / n - O[1];
  let ax = i0 * dx + i1 * dy, ay = i2 * dx + i3 * dy;
  const r = Math.hypot(ax, ay);
  if (r > 0.6) { ax *= 0.6 / r; ay *= 0.6 / r; } // clamp inside the disk
  return [ax, ay];
}

// Offsets to try, closest to the seed first: a fine local grid around the seed
// (where the true offset lies once the core is found) then a coarse global net
// as a fallback when the core estimate is poor (heavy damage over the pupil).
function offsetCandidates(seed) {
  const [sx, sy] = seed;
  const seen = new Set();
  const out = [];
  const add = (ax, ay) => {
    if (ax * ax + ay * ay > 0.5) return;
    const key = `${ax.toFixed(3)},${ay.toFixed(3)}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push([ax, ay]);
  };
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) add(sx + dx * 0.045, sy + dy * 0.045);
  for (const ax of [-0.3, -0.15, 0, 0.15, 0.3]) for (const ay of [-0.3, -0.15, 0, 0.15, 0.3]) add(ax, ay);
  const d2 = (p) => (p[0] - sx) ** 2 + (p[1] - sy) ** 2;
  return out.sort((a, b) => d2(a) - d2(b));
}

// Memoized ring-segment schedules.
const Ncache = new Map();
const getN = (K, p) => {
  if (!Ncache.has(K)) Ncache.set(K, segCounts(K, p));
  return Ncache.get(K);
};

export const _internal = { buildMaps, locate, fitEllipse, rayCandidates, snapScore, attempt };

// ── Decoding ─────────────────────────────────────────────────────────────────

// Try one candidate pose across the small scale corrections. `ctx` bundles the
// precomputed maps, profile and damage mask shared by every attempt.
function tryPose(ctx, K, N, O, M, theta0, ax, ay) {
  for (const f of SCALE_TRIM) {
    const Mf = scaleM(M, f);
    const text = attempt(ctx.maps, ctx.p, K, N, O, Mf, theta0, ax, ay, ctx.damage);
    if (text !== null) return { text, params: { K, N }, geom: { O, M: Mf, theta0, a: [ax, ay] } };
  }
  return null;
}

// Phase 1 — planar: lock onto the registration ray, on both the circle and the
// fitted ellipse. Covers rotation, scale, translation, noise, blur, mild perspective.
function decodePlanar(ctx) {
  for (const { O, M } of [ctx.circle, ctx.ellipse]) {
    const angles = rayCandidates(ctx.maps, O, M);
    for (const K of viableK(ctx.p, M)) {
      if (now() > ctx.deadline) return null;
      const N = getN(K, ctx.p);
      for (const theta0 of angles) {
        const hit = tryPose(ctx, K, N, O, M, theta0, 0, 0);
        if (hit) return hit;
      }
    }
  }
  return null;
}

// Phase 1.5 — the registration ray was destroyed by a scratch. Snap is
// cell-periodic so it can't localize the absolute angle; brute-force it and let
// RS+CRC decide. Only for near-circular, actually-damaged symbols — otherwise
// phase 1 or the perspective phase already applies.
function decodeScratchedRay(ctx) {
  if (axisRatio(ctx.ellipse.M) >= NEAR_CIRCULAR || !maskHasInk(ctx.damage)) return null;
  const { O, M } = ctx.circle;
  for (const K of viableK(ctx.p, M)) {
    const N = getN(K, ctx.p);
    const stepDeg = Math.max(1.5, 360 / N[K - 1] / 3); // ≤ 240 steps
    for (let deg = 0; deg < 360; deg += stepDeg) {
      if (now() > ctx.deadline) return null; // out of budget — give up gracefully
      const theta0 = (deg * Math.PI) / 180;
      if (snapScore(ctx.maps, ctx.p, K, N, O, M, theta0, 0, 0, 4) < 0.7) continue; // skip misaligned
      const hit = tryPose(ctx, K, N, O, M, theta0, 0, 0);
      if (hit) return hit;
    }
  }
  return null;
}

// Coordinate-ascent polish of a grid seed: nudge (ax, ay, theta0) to maximize the
// score, so steep perspective lands exactly between grid points.
function refinePose(ctx, K, N, O, M, seed) {
  let { ax, ay, theta0 } = seed;
  let best = rankScore(ctx.maps, ctx.p, K, N, O, M, theta0, ax, ay);
  for (let step = 0.05; step >= 0.0125; step /= 2) {
    let improved = true;
    while (improved) {
      improved = false;
      const moves = [
        [ax + step, ay, theta0], [ax - step, ay, theta0],
        [ax, ay + step, theta0], [ax, ay - step, theta0],
        [ax, ay, theta0 + step * 0.08], [ax, ay, theta0 - step * 0.08],
      ];
      for (const [nx, ny, nt] of moves) {
        if (nx * nx + ny * ny > 0.85) continue;
        const s = rankScore(ctx.maps, ctx.p, K, N, O, M, nt, nx, ny);
        if (s > best) {
          best = s;
          ax = nx;
          ay = ny;
          theta0 = nt;
          improved = true;
        }
      }
    }
  }
  return { theta0, ax, ay };
}

// Phase 2 — perspective. The disk images to an ellipse (affine M), and a
// Klein/projective offset a=(ax,ay) in mapPoint adds the TRUE non-linear
// foreshortening (a conformal Blaschke map can't — straight chords must stay
// straight under a real camera). With few rings, snap and ray-darkness both
// saturate (almost any pose lands on solid colour at some angle), so they can't
// rank the offset. Instead we SEED a from the bullseye core (coreOffset, which
// does NOT saturate), try offsets closest-to-seed first, recover rotation from
// the snap plateaus per offset (ray-independent), and let RS+CRC be the sole
// arbiter — polishing the winner off-grid for steep tilt.
function decodePerspective(ctx) {
  const { maps, p } = ctx;
  const { O, M } = ctx.ellipse;
  const offsets = offsetCandidates(coreOffset(maps, O, M));
  for (const K of schedulesByFit(p, M)) {
    const N = getN(K, p);
    for (const [ax, ay] of offsets) {
      if (now() > ctx.deadline) return null; // out of budget — give up gracefully
      for (const theta0 of thetaCandidates(maps, p, K, N, O, M, ax, ay)) {
        const hit = tryPose(ctx, K, N, O, M, theta0, ax, ay);
        if (hit) return hit;
        // Off-grid polish (ray-darkness driven) for tilt between grid points.
        const r = refinePose(ctx, K, N, O, M, { ax, ay, theta0 });
        if (r.ax !== ax || r.ay !== ay || r.theta0 !== theta0) {
          const hit2 = tryPose(ctx, K, N, O, M, r.theta0, r.ax, r.ay);
          if (hit2) return hit2;
        }
      }
    }
  }
  return null;
}

/**
 * Decode a (possibly distorted) RGB grid back to text. Tries three strategies in
 * increasing cost — planar ray-lock, scratched-ray brute force, then full
 * perspective search — and returns { text, params, geom } or throws.
 */
export function decodeColorRobust(rawGrid, opts = {}) {
  const p = { ...COLOR_PROFILE, ...(opts.profile || {}) };
  const grid = normalizeGrid(rawGrid); // undo dim lighting / color cast first
  const maps = buildMaps(grid);
  const { cx, cy, radiusPx } = locate(grid);
  const ellipse = fitEllipse(maps, cx, cy, radiusPx);
  const ctx = {
    maps,
    p,
    circle: { O: [cx, cy], M: [radiusPx, 0, 0, radiusPx] },
    ellipse,
    damage: damageMask(maps, ellipse.O, ellipse.M),
    // Optional wall-clock budget (ms). The geometry search is exhaustive, so a
    // hard input (or a large payload) can otherwise run for seconds; interactive
    // callers (the web Robustness Lab) pass a budget to cap the worst case.
    deadline: opts.budgetMs > 0 ? now() + opts.budgetMs : Infinity,
  };

  const result = decodePlanar(ctx) || decodeScratchedRay(ctx) || decodePerspective(ctx);
  if (!result) throw new Error("no decodable IRIS color symbol found");
  return result;
}
