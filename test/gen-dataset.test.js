// The synthetic-data labels are only useful if they're exact. These tests pin the
// geometry to known values on an identity scene, confirm the ellipse label tracks
// a real tilt, and prove a generated capture round-trips through the real decoder.
import test from "node:test";
import assert from "node:assert/strict";
import { renderScene } from "../tools/scene.js";
import { makePRNG } from "../tools/distort.js";
import { decodeColorRobust } from "../src/robust.js";

// An identity scene: code placed 1:1 at the frame center, no distortion. We don't
// know D up front (it depends on payload), so size/out are set from the symbol by
// using a generous OUT and a centered unit placement — checked via the labels.
function identityScene(out) {
  return {
    out, bg: "solid", size: out, cxFrac: 0.5, cyFrac: 0.5,
    rot: 0, persp: 0, perspAxis: 0, blur: 0, noise: 0, scratches: 0, color: null,
  };
}

test("identity scene: center, ray and round pupil are exact", () => {
  const rng = makePRNG(7);
  // Centered, unrotated, no-perspective placement: a pure scale+translation keeps
  // the circle a circle and the ray pointing north, regardless of OUT vs base D.
  const OUT = 400;
  const { label } = renderScene("hello iris", identityScene(OUT), rng);
  assert.equal(label.width, OUT);
  // Pupil center sits at the frame center.
  assert.ok(Math.abs(label.center[0] - OUT / 2) < 1.5, `center.x ${label.center[0]}`);
  assert.ok(Math.abs(label.center[1] - OUT / 2) < 1.5, `center.y ${label.center[1]}`);
  // No rotation → ray points north (≈0°/360°).
  const ray = Math.min(label.ray_deg, 360 - label.ray_deg);
  assert.ok(ray < 1.5, `ray ${label.ray_deg}`);
  // No perspective → pupil image is a circle (a ≈ b).
  assert.ok(Math.abs(label.ellipse.a - label.ellipse.b) < 1.0, `a=${label.ellipse.a} b=${label.ellipse.b}`);
});

test("perspective makes the pupil ellipse eccentric", () => {
  const rng = makePRNG(3);
  const scene = { ...identityScene(420), size: 360, persp: 0.3 };
  const { label } = renderScene("scan me", scene, rng);
  // A keystone tilt must squash one axis: a strictly greater than b.
  assert.ok(label.ellipse.a - label.ellipse.b > 5, `expected eccentric, got a=${label.ellipse.a} b=${label.ellipse.b}`);
});

test("bbox tightly bounds the visible disc, not the square card", () => {
  const rng = makePRNG(9);
  const scene = { ...identityScene(420), size: 320, rot: 0.7, persp: 0.2, perspAxis: 0.5 };
  const { label } = renderScene("tight box", scene, rng);
  const [bx, by, bw, bh] = label.bbox;
  // The 4 disc-boundary points and the center all fall inside the box.
  for (const [x, y] of label.quad) {
    assert.ok(x >= bx - 1 && x <= bx + bw + 1 && y >= by - 1 && y <= by + bh + 1, `quad pt ${x},${y} outside bbox`);
  }
  assert.ok(label.center[0] > bx && label.center[0] < bx + bw, "center x in bbox");
  // Disc encloses the pupil, and the box hugs the disc (≈2·radius, not the loose square).
  assert.ok(label.radius > label.pupil_radius, "disc radius > pupil radius");
  assert.ok(Math.max(bw, bh) < 2.5 * label.radius, `bbox ${bw}x${bh} too loose for radius ${label.radius}`);
});

test("ray_tip keypoint lies along the ray direction from center", () => {
  const rng = makePRNG(5);
  const scene = { ...identityScene(380), size: 300, rot: 1.1, persp: 0.15, perspAxis: 0.3 };
  const { label } = renderScene("ray tip", scene, rng);
  // Direction from center to ray_tip must match ray_deg (0°=up, clockwise).
  const dx = label.ray_tip[0] - label.center[0];
  const dy = label.ray_tip[1] - label.center[1];
  const tipDeg = ((Math.atan2(dx, -dy) * 180 / Math.PI) + 360) % 360;
  let d = Math.abs(tipDeg - label.ray_deg) % 360;
  if (d > 180) d = 360 - d;
  assert.ok(d < 3, `ray_tip direction ${tipDeg.toFixed(1)} vs ray_deg ${label.ray_deg}`);
  // The tip is farther out than the pupil (it's at the outer ring).
  assert.ok(Math.hypot(dx, dy) > label.pupil_radius, "ray_tip beyond pupil");
});

test("a distorted capture still decodes with src/robust.js", () => {
  // robust.js localizes by "non-white = symbol", so we present the code the way it
  // expects — centered on white — with a real geometric distortion (rotation +
  // mild perspective). This proves the synthetic warp stays inside the decoder's
  // envelope; locating a code on a cluttered background is the stage-1 model's job.
  const rng = makePRNG(42);
  const scene = {
    out: 480, bg: "white", size: 480 * 0.9, cxFrac: 0.5, cyFrac: 0.5,
    rot: 0.6, persp: 0.18, perspAxis: 0.4, blur: 0.8, noise: 0.02, scratches: 0, color: null,
  };
  const { grid, label } = renderScene("iris round trip", scene, rng);
  const res = decodeColorRobust(grid, { budgetMs: 2000 });
  assert.equal(res.text, "iris round trip");
  // The decoded symbol's ring count matches the label.
  assert.equal(res.params.K, label.K);
});
