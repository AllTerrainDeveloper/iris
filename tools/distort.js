// Synthetic-capture primitives for the IRIS detector dataset (zero-dependency).
//
// These are the *camera/scene* effects the localizer must learn to see through —
// the same families the Robustness Lab (web/lab.js) exercises, ported off the DOM
// canvas to pure Node so they run headless and emit exact ground truth:
//
//   • homography()           4-point projective map (copied from web/lab.js so the
//                            warp matches what decodeColorRobust is tuned for).
//   • circleConic / warpConic / conicToEllipse
//                            the pupil circle pushed through the homography is an
//                            ELLIPSE; we transform its conic matrix exactly (no
//                            point-fit) so the perspective label is ground truth.
//   • warpComposite()        place + warp the symbol into a larger scene, bilinear.
//   • gaussianBlur / addNoise / drawScratch / colorTransform / background
//
// Image type throughout is the repo's RGB grid: { width, height, data:Uint8Array }
// with 3 bytes/pixel — so results drop straight into gridToPPM / decodeColorRobust.

// ── Seeded PRNG (reproducible datasets) ──────────────────────────────────────

/** Mulberry32 — deterministic [0,1) stream from a 32-bit seed. */
export function makePRNG(seed) {
  let s = seed >>> 0;
  const rng = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
  rng.range = (lo, hi) => lo + (hi - lo) * rng();
  rng.int = (lo, hi) => Math.floor(rng.range(lo, hi + 1));
  rng.pick = (arr) => arr[rng.int(0, arr.length - 1)];
  return rng;
}

// ── 3×3 linear algebra (row-major length-9 arrays) ───────────────────────────

const matMul3 = (A, B) => {
  const C = new Array(9).fill(0);
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++)
      for (let k = 0; k < 3; k++) C[r * 3 + c] += A[r * 3 + k] * B[k * 3 + c];
  return C;
};
const matT3 = (M) => [M[0], M[3], M[6], M[1], M[4], M[7], M[2], M[5], M[8]];

/** Apply a 3×3 homography to a point, returning the de-homogenized [x,y]. */
export function applyH(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

/**
 * Solve the 8×8 system for the homography mapping the 4 points `from` -> `to`.
 * Returns a length-9 row-major matrix (h8 fixed to 1). Verbatim port of
 * web/lab.js so the synthetic warp is identical to the lab the decoder targets.
 */
export function homography(from, to) {
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = from[i];
    const [X, Y] = to[i];
    A.push([x, y, 1, 0, 0, 0, -X * x, -X * y]);
    b.push(X);
    A.push([0, 0, 0, x, y, 1, -Y * x, -Y * y]);
    b.push(Y);
  }
  for (let col = 0; col < 8; col++) {
    let piv = col;
    for (let r = col + 1; r < 8; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    [A[col], A[piv]] = [A[piv], A[col]];
    [b[col], b[piv]] = [b[piv], b[col]];
    const d = A[col][col] || 1e-9;
    for (let r = 0; r < 8; r++) {
      if (r === col) continue;
      const f = A[r][col] / d;
      for (let c = col; c < 8; c++) A[r][c] -= f * A[col][c];
      b[r] -= f * b[col];
    }
  }
  const h = b.map((v, i) => v / (A[i][i] || 1e-9));
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

// ── Conics: the pupil circle's exact image under a homography ─────────────────

/** Symmetric conic matrix (length-9) for the circle |p - (cx,cy)| = r. */
export function circleConic(cx, cy, r) {
  // x² + y² - 2cx·x - 2cy·y + (cx²+cy²-r²) = 0
  return [1, 0, -cx, 0, 1, -cy, -cx, -cy, cx * cx + cy * cy - r * r];
}

/**
 * Push a conic from the base frame into the output frame. `Hinv` maps output ->
 * base (so a base point p_base = Hinv·p_out); a point lies on the imaged conic iff
 * p_outᵀ (Hinvᵀ Q Hinv) p_out = 0. Hence Q' = Hinvᵀ Q Hinv — exact, no sampling.
 */
export function warpConic(Q, Hinv) {
  return matMul3(matMul3(matT3(Hinv), Q), Hinv);
}

/** Conic matrix (length-9) -> ellipse {cx,cy,a,b,phi}. `a`>=`b`; `phi` in rad. */
export function conicToEllipse(Q) {
  const A = Q[0];
  const B = 2 * Q[1];
  const C = Q[4];
  const D = 2 * Q[2];
  const E = 2 * Q[5];
  const F = Q[8];
  const disc = B * B - 4 * A * C; // < 0 for an ellipse
  const cx = (2 * C * D - B * E) / disc;
  const cy = (2 * A * E - B * D) / disc;
  // Conic value at the center; the centered ellipse is A x'² + B x'y' + C y'² = -Fc.
  const Fc = A * cx * cx + B * cx * cy + C * cy * cy + D * cx + E * cy + F;
  const tr = A + C;
  const root = Math.sqrt(Math.max(0, (A - C) * (A - C) + B * B));
  const l1 = (tr + root) / 2;
  const l2 = (tr - root) / 2;
  const ax1 = Math.sqrt(Math.max(0, -Fc / l1));
  const ax2 = Math.sqrt(Math.max(0, -Fc / l2));
  const a = Math.max(ax1, ax2);
  const b = Math.min(ax1, ax2);
  // Orientation of the major axis (eigenvector of the larger semi-axis).
  let phi = 0.5 * Math.atan2(B, A - C);
  if (ax2 > ax1) phi += Math.PI / 2;
  return { cx, cy, a, b, phi };
}

// ── Pixel operations on RGB grids ────────────────────────────────────────────

const clamp8 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v) | 0;

/** Fresh RGB grid filled with a constant [r,g,b]. */
export function solidGrid(W, H, rgb) {
  const data = new Uint8Array(W * H * 3);
  for (let i = 0; i < W * H; i++) {
    data[i * 3] = rgb[0];
    data[i * 3 + 1] = rgb[1];
    data[i * 3 + 2] = rgb[2];
  }
  return { width: W, height: H, data };
}

/**
 * Warp `base` into `dst` corners inside scene `out`, sampling bilinearly.
 * `Hinv` maps out -> base. Only pixels whose base coordinate falls within
 * `maskRadius` of the base center (cx,cy) are painted, so the round code lands on
 * the scene background and the square's corners stay transparent (realistic).
 * Returns the painted bounding box {x0,y0,x1,y1} (handy for later scratch/region ops).
 */
export function warpComposite(base, out, Hinv, dst, { cx, cy, maskRadius }) {
  const { width: BW, height: BH, data: bd } = base;
  const { width: OW, height: OH, data: od } = out;
  const r2 = maskRadius * maskRadius;
  let x0 = OW, y0 = OH, x1 = 0, y1 = 0;
  for (const [px, py] of dst) {
    x0 = Math.min(x0, px); y0 = Math.min(y0, py);
    x1 = Math.max(x1, px); y1 = Math.max(y1, py);
  }
  x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
  x1 = Math.min(OW - 1, Math.ceil(x1)); y1 = Math.min(OH - 1, Math.ceil(y1));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const [bx, by] = applyH(Hinv, x + 0.5, y + 0.5);
      const ddx = bx - cx;
      const ddy = by - cy;
      if (ddx * ddx + ddy * ddy > r2) continue;
      if (bx < 0 || by < 0 || bx >= BW - 1 || by >= BH - 1) continue;
      // Bilinear sample of the base.
      const xi = bx | 0;
      const yi = by | 0;
      const fx = bx - xi;
      const fy = by - yi;
      const o00 = (yi * BW + xi) * 3;
      const o10 = o00 + 3;
      const o01 = o00 + BW * 3;
      const o11 = o01 + 3;
      const oo = (y * OW + x) * 3;
      for (let ch = 0; ch < 3; ch++) {
        const top = bd[o00 + ch] * (1 - fx) + bd[o10 + ch] * fx;
        const bot = bd[o01 + ch] * (1 - fx) + bd[o11 + ch] * fx;
        od[oo + ch] = (top * (1 - fy) + bot * fy) | 0;
      }
    }
  }
  return { x0, y0, x1, y1 };
}

/** Separable Gaussian blur in place-ish (returns a new grid). sigma in px. */
export function gaussianBlur(grid, sigma) {
  if (sigma <= 0) return grid;
  const { width: W, height: H, data } = grid;
  const rad = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float32Array(2 * rad + 1);
  let sum = 0;
  for (let i = -rad; i <= rad; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k[i + rad] = v;
    sum += v;
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  const tmp = new Float32Array(W * H * 3);
  const outData = new Uint8Array(W * H * 3);
  // Horizontal pass: data -> tmp.
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let r = 0, g = 0, b = 0;
      for (let i = -rad; i <= rad; i++) {
        let xx = x + i;
        if (xx < 0) xx = 0; else if (xx >= W) xx = W - 1;
        const o = (y * W + xx) * 3;
        const w = k[i + rad];
        r += data[o] * w; g += data[o + 1] * w; b += data[o + 2] * w;
      }
      const o = (y * W + x) * 3;
      tmp[o] = r; tmp[o + 1] = g; tmp[o + 2] = b;
    }
  }
  // Vertical pass: tmp -> outData.
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let r = 0, g = 0, b = 0;
      for (let i = -rad; i <= rad; i++) {
        let yy = y + i;
        if (yy < 0) yy = 0; else if (yy >= H) yy = H - 1;
        const o = (yy * W + x) * 3;
        const w = k[i + rad];
        r += tmp[o] * w; g += tmp[o + 1] * w; b += tmp[o + 2] * w;
      }
      const o = (y * W + x) * 3;
      outData[o] = clamp8(r); outData[o + 1] = clamp8(g); outData[o + 2] = clamp8(b);
    }
  }
  return { width: W, height: H, data: outData };
}

/** Salt-and-pepper: each pixel has probability `p` of becoming a random color. */
export function addNoise(grid, p, rng) {
  if (p <= 0) return;
  const { data } = grid;
  for (let i = 0; i < data.length; i += 3) {
    if (rng() < p) {
      data[i] = rng() * 256;
      data[i + 1] = rng() * 256;
      data[i + 2] = rng() * 256;
    }
  }
}

/** A near-white streak across the symbol (Reed–Solomon-erasure territory). */
export function drawScratch(grid, { x0, y0, x1, y1, width }) {
  const { width: W, height: H, data } = grid;
  const vx = x1 - x0;
  const vy = y1 - y0;
  const len2 = vx * vx + vy * vy || 1;
  const hw = width / 2;
  const bx0 = Math.max(0, Math.floor(Math.min(x0, x1) - hw));
  const by0 = Math.max(0, Math.floor(Math.min(y0, y1) - hw));
  const bx1 = Math.min(W - 1, Math.ceil(Math.max(x0, x1) + hw));
  const by1 = Math.min(H - 1, Math.ceil(Math.max(y0, y1) + hw));
  for (let y = by0; y <= by1; y++) {
    for (let x = bx0; x <= bx1; x++) {
      let t = ((x - x0) * vx + (y - y0) * vy) / len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = x - (x0 + t * vx);
      const dy = y - (y0 + t * vy);
      if (dx * dx + dy * dy <= hw * hw) {
        const o = (y * W + x) * 3;
        data[o] = data[o + 1] = data[o + 2] = 250;
      }
    }
  }
}

/**
 * Illuminant / camera response: per-channel gamma then gain+offset. This is the
 * exact transform a calibration step must invert; `applyColorRGB` is exported so
 * the generator can also report what the known palette colors LOOK like after it.
 */
export function applyColorRGB([r, g, b], { gain, offset, gamma }) {
  const f = (v, c) => clamp8(255 * Math.pow(v / 255, gamma[c]) * gain[c] + offset[c]);
  return [f(r, 0), f(g, 1), f(b, 2)];
}

export function colorTransform(grid, params) {
  const { data } = grid;
  for (let i = 0; i < data.length; i += 3) {
    const [r, g, b] = applyColorRGB([data[i], data[i + 1], data[i + 2]], params);
    data[i] = r; data[i + 1] = g; data[i + 2] = b;
  }
}

// ── Scene backgrounds ────────────────────────────────────────────────────────

const randRGB = (rng) => [rng.int(0, 255), rng.int(0, 255), rng.int(0, 255)];

/** Build a scene-sized background. Kind ∈ solid|gradient|noise|checker. */
export function makeBackground(W, H, kind, rng) {
  if (kind === "white") return solidGrid(W, H, [255, 255, 255]);
  const grid = solidGrid(W, H, randRGB(rng));
  const { data } = grid;
  if (kind === "solid") return grid;
  if (kind === "gradient") {
    const a = randRGB(rng);
    const b = randRGB(rng);
    const horiz = rng() < 0.5;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const t = horiz ? x / (W - 1) : y / (H - 1);
        const o = (y * W + x) * 3;
        for (let c = 0; c < 3; c++) data[o + c] = clamp8(a[c] * (1 - t) + b[c] * t);
      }
    }
    return grid;
  }
  if (kind === "checker") {
    const a = randRGB(rng);
    const b = randRGB(rng);
    const sz = rng.int(12, 40);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const c = ((x / sz) | 0) + ((y / sz) | 0);
        const col = c & 1 ? a : b;
        const o = (y * W + x) * 3;
        data[o] = col[0]; data[o + 1] = col[1]; data[o + 2] = col[2];
      }
    }
    return grid;
  }
  // noise: random speckle over a base color.
  for (let i = 0; i < data.length; i += 3) {
    if (rng() < 0.5) { data[i] = rng.int(0, 255); data[i + 1] = rng.int(0, 255); data[i + 2] = rng.int(0, 255); }
  }
  return grid;
}
