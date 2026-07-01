// Robust decode under geometric + photometric distortion (partial Track-2).

import { test } from "node:test";
import assert from "node:assert/strict";

import { encodeColor, renderColorRaster } from "../src/color.js";
import { decodeColorRobust } from "../src/robust.js";

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 0x100000000);
}

// Bilinear sample of an RGB grid (mimics canvas interpolation / anti-aliasing).
function bilinear(grid, x, y) {
  const { width: W, height: H, data } = grid;
  if (x < 0 || y < 0 || x >= W - 1 || y >= H - 1) return [255, 255, 255];
  const xi = x | 0;
  const yi = y | 0;
  const fx = x - xi;
  const fy = y - yi;
  const at = (xx, yy, c) => data[(yy * W + xx) * 3 + c];
  const out = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const top = at(xi, yi, c) * (1 - fx) + at(xi + 1, yi, c) * fx;
    const bot = at(xi, yi + 1, c) * (1 - fx) + at(xi + 1, yi + 1, c) * fx;
    out[c] = top * (1 - fy) + bot * fy;
  }
  return out;
}

// Mild box blur to simulate the browser's SVG->canvas anti-aliasing.
function blur(grid) {
  const { width: W, height: H, data } = grid;
  const out = new Uint8Array(data.length);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      for (let c = 0; c < 3; c++) {
        let s = 0;
        let n = 0;
        for (let oy = -1; oy <= 1; oy++)
          for (let ox = -1; ox <= 1; ox++) {
            const xx = x + ox;
            const yy = y + oy;
            if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
            s += data[(yy * W + xx) * 3 + c];
            n++;
          }
        out[(y * W + x) * 3 + c] = s / n;
      }
    }
  }
  return { width: W, height: H, data: out };
}

// dest = center + scale*R(angle)*(src-center) + t, bilinear, optional noise.
function transform(grid, { angle = 0, scale = 1, tx = 0, ty = 0, noise = 0, seed = 1 } = {}) {
  const { width: W, height: H } = grid;
  const out = new Uint8Array(W * H * 3).fill(255);
  const cx = W / 2;
  const cy = H / 2;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const rand = rng(seed);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = (x - cx - tx) / scale;
      const v = (y - cy - ty) / scale;
      const sx = cos * u + sin * v + cx;
      const sy = -sin * u + cos * v + cy;
      const o = (y * W + x) * 3;
      const [r, g, b] = bilinear(grid, sx, sy);
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
      if (noise > 0 && rand() < noise) {
        out[o] = rand() * 256;
        out[o + 1] = rand() * 256;
        out[o + 2] = rand() * 256;
      }
    }
  }
  return { width: W, height: H, data: out };
}

// 4-point homography (output->source) for perspective warping in tests.
function homography(from, to) {
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

// Apply perspective (keystone) + rotation to a grid via bilinear inverse map.
function perspective(grid, { persp = 0, rot = 0 } = {}) {
  const { width: W, height: H } = grid;
  const cx = W / 2;
  const cy = H / 2;
  const hw = W / 2 - 2;
  const hh = H / 2 - 2;
  const top = 1 - persp;
  const a = (rot * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const place = (x, y) => [cx + (cos * x - sin * y), cy + (sin * x + cos * y)];
  const dst = [place(-hw * top, -hh), place(hw * top, -hh), place(hw, hh), place(-hw, hh)];
  const src = [
    [0, 0],
    [W, 0],
    [W, H],
    [0, H],
  ];
  const Hm = homography(dst, src);
  const out = new Uint8Array(W * H * 3).fill(255);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const w = Hm[6] * x + Hm[7] * y + 1;
      const sx = (Hm[0] * x + Hm[1] * y + Hm[2]) / w;
      const sy = (Hm[3] * x + Hm[4] * y + Hm[5]) / w;
      const o = (y * W + x) * 3;
      const [r, g, b] = bilinear(grid, sx, sy);
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
    }
  }
  return { width: W, height: H, data: out };
}

const MSG = "robustness test — IRIS v2 🌀";

test("robust decode: clean", () => {
  assert.equal(decodeColorRobust(renderColorRaster(encodeColor(MSG))).text, MSG);
});

test("robust decode: every rotation 0..355° (incl -84°)", () => {
  const base = blur(renderColorRaster(encodeColor(MSG))); // simulate AA
  const angles = [];
  for (let a = 0; a < 360; a += 5) angles.push(a);
  angles.push(-84, -84 + 360); // the reported failure case
  for (const deg of angles) {
    const grid = transform(base, { angle: (deg * Math.PI) / 180 });
    assert.equal(decodeColorRobust(grid).text, MSG, `failed at ${deg}°`);
  }
});

test("robust decode: rotation + scale + translation + AA", () => {
  const base = blur(renderColorRaster(encodeColor(MSG)));
  for (const deg of [-84, 23, 137, -160]) {
    const grid = transform(base, {
      angle: (deg * Math.PI) / 180,
      scale: 0.75,
      tx: 20,
      ty: -14,
    });
    assert.equal(decodeColorRobust(grid).text, MSG, `failed at ${deg}°`);
  }
});

test("robust decode: rotation + additive noise (ECC recovers)", () => {
  const base = renderColorRaster(encodeColor(MSG));
  const grid = transform(base, { angle: (-84 * Math.PI) / 180, noise: 0.03, seed: 7 });
  assert.equal(decodeColorRobust(grid).text, MSG);
});

test("robust decode: rotation + scratch wedge (ECC recovers)", () => {
  const grid = transform(renderColorRaster(encodeColor(MSG)), { angle: (-84 * Math.PI) / 180 });
  const cx = grid.width / 2;
  const cy = grid.height / 2;
  for (let r = 0; r < grid.width / 2; r++) {
    for (let a = -8; a <= 8; a++) {
      const theta = (a * Math.PI) / 180;
      const x = Math.round(cx + r * Math.sin(theta));
      const y = Math.round(cy - r * Math.cos(theta));
      if (x >= 0 && y >= 0 && x < grid.width && y < grid.height) {
        const o = (y * grid.width + x) * 3;
        grid.data[o] = grid.data[o + 1] = grid.data[o + 2] = 255;
      }
    }
  }
  assert.equal(decodeColorRobust(grid).text, MSG);
});

// Paint a straight white slash across the grid (a scratch).
function slash(grid, x0, y0, x1, y1, width) {
  const { width: W, height: H, data } = grid;
  const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0));
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const cx = x0 + (x1 - x0) * t;
    const cy = y0 + (y1 - y0) * t;
    for (let oy = -width; oy <= width; oy++)
      for (let ox = -width; ox <= width; ox++) {
        const x = Math.round(cx + ox);
        const y = Math.round(cy + oy);
        if (x >= 0 && y >= 0 && x < W && y < H) {
          const o = (y * W + x) * 3;
          data[o] = data[o + 1] = data[o + 2] = 255;
        }
      }
  }
  return grid;
}

test("robust decode: thick scratch across the symbol (erasure recovery)", () => {
  const grid = renderColorRaster(encodeColor(MSG));
  const D = grid.width;
  slash(grid, 0, D * 0.35, D, D * 0.62, 5); // wide diagonal slash
  assert.equal(decodeColorRobust(grid).text, MSG);
});

test("robust decode: two scratches + rotation (erasure recovery)", () => {
  const grid = transform(renderColorRaster(encodeColor(MSG)), { angle: (-84 * Math.PI) / 180 });
  const D = grid.width;
  slash(grid, D * 0.2, 0, D * 0.45, D, 4);
  slash(grid, 0, D * 0.7, D, D * 0.55, 4);
  assert.equal(decodeColorRobust(grid).text, MSG);
});

const PMSG = "hello iris";

test("robust decode: perspective (ellipse + Klein/projective rectification)", () => {
  const base = renderColorRaster(encodeColor(PMSG));
  for (const persp of [0.1, 0.2, 0.3, 0.35]) {
    const grid = perspective(base, { persp });
    assert.equal(decodeColorRobust(grid).text, PMSG, `failed at persp ${persp}`);
  }
});

test("robust decode: perspective + rotation", () => {
  const base = renderColorRaster(encodeColor(PMSG));
  for (const [persp, rot] of [[0.3, -84], [0.25, 130], [0.35, 47]]) {
    const grid = perspective(base, { persp, rot });
    assert.equal(decodeColorRobust(grid).text, PMSG, `failed at persp ${persp}, rot ${rot}`);
  }
});

// Regression — the reported Robustness Lab failure: a short URL decoded fine flat
// but FAILED under a mild tilt + odd rotation (e.g. -44°, persp 0.26). The cause
// was modelling perspective with a CONFORMAL (Blaschke) disk map, which can't
// represent a real camera's projective foreshortening. The fix uses a projective
// (Klein) disk offset seeded from the bullseye core. This must hold at EVERY
// rotation and a range of tilts — a single failing angle is a broken product.
test("robust decode: URL under perspective across all rotations", () => {
  const URL = "http://quick-hacks.me";
  const base = renderColorRaster(encodeColor(URL));
  assert.equal(decodeColorRobust(perspective(base, { persp: 0.26, rot: -44 })).text, URL, "the reported case");
  for (const persp of [0.2, 0.26, 0.3]) {
    for (let rot = -150; rot <= 150; rot += 30) {
      const grid = perspective(base, { persp, rot });
      assert.equal(decodeColorRobust(grid).text, URL, `failed at persp ${persp}, rot ${rot}`);
    }
  }
});

// Regression (Robustness Lab): perspective + blur + heavy salt-and-pepper noise.
// 11% pixel noise ALONE used to drop the peak palette-snap below a fixed 0.8
// candidate-threshold, yielding zero rotation candidates and an instant fail —
// even though the data was fully recoverable. The index map is now mode-filtered
// (noise pixels are never the local majority) and the snap threshold is relative.
// Each distortion here is individually mild; combined they must still decode.
test("robust decode: perspective + blur + 11% noise", () => {
  const TEXT = "hello iris";
  const base = renderColorRaster(encodeColor(TEXT));
  for (const [persp, rot] of [[0.2, 0], [0.2, -44], [0.15, 130]]) {
    const g = blur(blur(perspective(base, { persp, rot }))); // two box passes ≈ wider blur
    const rand = rng(1337);
    for (let i = 0; i < g.width * g.height; i++) {
      if (rand() < 0.11) {
        const o = i * 3;
        g.data[o] = rand() * 256;
        g.data[o + 1] = rand() * 256;
        g.data[o + 2] = rand() * 256;
      }
    }
    assert.equal(decodeColorRobust(g).text, TEXT, `failed at persp ${persp}, rot ${rot}`);
  }
});

test("robust decode: scratch destroys the registration ray (ray-independent)", () => {
  // The reported case: short payload, odd rotation, a scratch running along the ray.
  for (const deg of [-162, 23, 200, 300, 45]) {
    const sym = encodeColor("hello iris");
    const g = transform(renderColorRaster(sym), { angle: (deg * Math.PI) / 180 });
    const D = g.width;
    const cx = D / 2;
    const cy = D / 2;
    const a = (deg * Math.PI) / 180;
    slash(g, cx, cy, cx + (D / 2) * Math.sin(a), cy - (D / 2) * Math.cos(a), 4);
    assert.equal(decodeColorRobust(g).text, "hello iris", `failed at ${deg}°`);
  }
});

test("robust decode: two scratches + rotation, small payload (adaptive ECC)", () => {
  // The reported case: "hello iris" + two scratches at odd angles. Small payloads
  // use high adaptive parity, so this recovers fast.
  for (const deg of [-91, -162, 30, 200, 300]) {
    const g = transform(renderColorRaster(encodeColor("hello iris")), { angle: (deg * Math.PI) / 180 });
    const D = g.width;
    slash(g, 0, D * 0.35, D, D * 0.5, 4);
    slash(g, D * 0.55, 0, D * 0.4, D, 4);
    const t0 = performance.now();
    assert.equal(decodeColorRobust(g).text, "hello iris", `failed at ${deg}°`);
    assert.ok(performance.now() - t0 < 300, `too slow at ${deg}°`);
  }
});

test("robust decode: speed (<60ms typical payload)", () => {
  const grid = transform(renderColorRaster(encodeColor("https://iris.dev/x")), {
    angle: (200 * Math.PI) / 180,
  });
  const t0 = performance.now();
  decodeColorRobust(grid);
  const ms = performance.now() - t0;
  assert.ok(ms < 60, `decode took ${ms.toFixed(1)}ms`);
});

// Simulate lighting: per-channel gain (color cast) + offset (ambient bounce).
function relight(grid, gains, offset = 0) {
  const out = new Uint8Array(grid.data.length);
  for (let i = 0; i < grid.data.length; i++) {
    out[i] = Math.max(0, Math.min(255, grid.data[i] * gains[i % 3] + offset));
  }
  return { width: grid.width, height: grid.height, data: out };
}

test("robust decode: dim warm lighting (photometric calibration)", () => {
  const base = renderColorRaster(encodeColor(MSG));
  // Warm indoor light at ~half brightness — every channel off, blue worst.
  const grid = relight(base, [0.62, 0.55, 0.42], 12);
  assert.equal(decodeColorRobust(grid).text, MSG);
});

test("robust decode: cool overexposed lighting + rotation", () => {
  const base = blur(renderColorRaster(encodeColor(MSG)));
  const lit = relight(base, [0.7, 0.8, 0.9], 40);
  const grid = transform(lit, { angle: (117 * Math.PI) / 180 });
  assert.equal(decodeColorRobust(grid).text, MSG);
});

test("robust decode: dim light + noise + scratch (calibration composes)", () => {
  // Scratch the print, photograph it rotated with sensor noise, under dim
  // light — the lighting applies to the WHOLE capture, scratch included.
  const base = renderColorRaster(encodeColor(MSG));
  const cx = base.width / 2;
  for (let r = 0; r < base.width / 2; r++) {
    for (let a = -6; a <= 6; a++) {
      const theta = ((a + 45) * Math.PI) / 180;
      const x = Math.round(cx + r * Math.sin(theta));
      const y = Math.round(cx - r * Math.cos(theta));
      if (x >= 0 && y >= 0 && x < base.width && y < base.height) {
        const o = (y * base.width + x) * 3;
        base.data[o] = base.data[o + 1] = base.data[o + 2] = 255;
      }
    }
  }
  const shot = transform(base, { angle: (-30 * Math.PI) / 180, noise: 0.02, seed: 3 });
  const grid = relight(shot, [0.6, 0.58, 0.5], 10);
  assert.equal(decodeColorRobust(grid).text, MSG);
});

// Spatially varying light: linear shadow ramp across the capture.
function shadow(grid, { from = 1.0, to = 0.4, offset = 6, vertical = false } = {}) {
  const { width: W, height: H, data } = grid;
  const out = new Uint8Array(data.length);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const t = vertical ? y / H : x / W;
      const gain = from + (to - from) * t;
      const o = (y * W + x) * 3;
      for (let c = 0; c < 3; c++) out[o + c] = Math.max(0, Math.min(255, data[o + c] * gain + offset));
    }
  }
  return { width: W, height: H, data: out };
}

test("robust decode: shadow gradient across the symbol", () => {
  const grid = shadow(renderColorRaster(encodeColor(MSG)), { from: 1.0, to: 0.4 });
  assert.equal(decodeColorRobust(grid).text, MSG);
});

test("robust decode: vertical shadow + rotation + blur", () => {
  const base = blur(renderColorRaster(encodeColor(MSG)));
  const shot = transform(base, { angle: (63 * Math.PI) / 180 });
  const grid = shadow(shot, { from: 0.95, to: 0.5, vertical: true });
  assert.equal(decodeColorRobust(grid).text, MSG);
});

test("robust decode: shadow + warm cast composes with the global stretch", () => {
  const shot = shadow(renderColorRaster(encodeColor(MSG)), { from: 1.0, to: 0.55 });
  const grid = relight(shot, [1.0, 0.88, 0.72], 0);
  assert.equal(decodeColorRobust(grid).text, MSG);
});
