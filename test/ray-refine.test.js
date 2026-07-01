// The hybrid detector's rotation comes from refineRayPolar (a polar scan for the
// black registration spoke). Its accuracy hinges on the geometry: rays must shoot
// from the PUPIL center (label.center) and be bounded by the disc ellipse centroid
// (label.ellipse). These tests pin that on rendered scenes with known geometry.
import test from "node:test";
import assert from "node:assert/strict";
import { renderScene, randomScene } from "../tools/scene.js";
import { makePRNG } from "../tools/distort.js";
import { refineRayPolar } from "../web/ray-refine.js";

const angErr = (p, t) => { const d = Math.abs(p - t) % 360; return d > 180 ? 360 - d : d; };
// refineRayPolar(grid, ox, oy, ex, ey, a, b, phiRad): origin = pupil center, ellipse = centroid+axes.
const findRay = (grid, label) => {
  const e = label.ellipse;
  return refineRayPolar(grid, label.center[0], label.center[1], e.cx, e.cy, e.a, e.b, e.phi_deg * Math.PI / 180).ray_deg;
};

test("polar ray finder is near-exact on a clean upright code", () => {
  const rng = makePRNG(3);
  const scene = { out: 512, bg: "solid", size: 360, cxFrac: 0.5, cyFrac: 0.5,
    rot: 0, persp: 0, perspAxis: 0, blur: 0, noise: 0, scratches: 0, color: null };
  const { grid, label } = renderScene("upright", scene, rng);
  assert.ok(angErr(findRay(grid, label), label.ray_deg) < 4, `clean ray off by ${angErr(findRay(grid, label), label.ray_deg).toFixed(1)}°`);
});

test("polar ray finder tracks rotation under perspective across the circle", () => {
  for (const deg of [30, 90, 150, 210, 300]) {
    const rng = makePRNG(100 + deg);
    const scene = { out: 512, bg: "gradient", size: 380, cxFrac: 0.5, cyFrac: 0.5,
      rot: deg * Math.PI / 180, persp: 0.28, perspAxis: 0.5, blur: 0.4, noise: 0, scratches: 0, color: null };
    const { grid, label } = renderScene("rot", scene, rng);
    assert.ok(angErr(findRay(grid, label), label.ray_deg) < 10, `rot ${deg}: off by ${angErr(findRay(grid, label), label.ray_deg).toFixed(1)}°`);
  }
});

test("≥90% of realistic captures land within 10° of the true ray", () => {
  const errs = [];
  for (let i = 0; i < 120; i++) {
    const rng = makePRNG(7000 + i);
    const scene = randomScene(rng, 512);
    scene.scratches = 0;                       // a scratch through the 1-cell spoke is the irreducible hard case
    const { grid, label } = renderScene("s" + i, scene, rng);
    errs.push(angErr(findRay(grid, label), label.ray_deg));
  }
  errs.sort((a, b) => a - b);
  const within10 = errs.filter((e) => e < 10).length / errs.length;
  const median = errs[errs.length >> 1];
  assert.ok(median < 5, `median ray error ${median.toFixed(1)}° should be tiny`);
  assert.ok(within10 >= 0.9, `only ${(within10 * 100).toFixed(0)}% within 10° (want ≥90%)`);
});
