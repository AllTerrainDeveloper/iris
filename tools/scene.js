// Scene synthesis shared by the Node dataset generator (gen-dataset.js) and the
// browser test harness (web/detect.js). Browser-SAFE: imports only src/color.js
// and distort.js — no node:* builtins — so it loads as a native ES module in the
// page exactly like the rest of web/ imports src/ with no build step.
//
// renderScene() reuses the real encoder, drops the code into a scene under a KNOWN
// warp, and returns { grid, label } where every label is computed from that warp
// (exact ground truth — never hand-annotated). Pass scene.bgGrid to composite onto
// a real photo instead of a procedural background.

import { encodeColor, renderColorRaster, PALETTE, COLOR_PROFILE } from "../src/color.js";
import {
  homography, applyH, circleConic, warpConic, conicToEllipse,
  warpComposite, gaussianBlur, addNoise, drawScratch, colorTransform, applyColorRGB,
  makeBackground,
} from "./distort.js";

const DEG = 180 / Math.PI;

export const round1 = (v) => Math.round(v * 10) / 10;
export const round3 = (v) => Math.round(v * 1000) / 1000;

// Random human-ish payloads so symbol size (K) varies across a set.
export const WORDS = ["iris", "hello", "scan me", "https://iris.dev", "v2 color",
  "the quick brown fox", "lorem ipsum dolor sit amet", "payload", "2026", "北京",
  "radial code", "reed-solomon", "QR successor", "open source", "beta"];

export function randomText(rng) {
  const n = rng.int(1, 4);
  const parts = [];
  for (let i = 0; i < n; i++) parts.push(rng.pick(WORDS));
  return parts.join(" ").slice(0, 80);
}

/**
 * Random scene: where the code lands in the frame and what the camera did to it.
 * Ranges mirror web/lab.js's randomize() so we stay inside the decoder's envelope.
 */
export function randomScene(rng, OUT) {
  return {
    out: OUT,
    bg: rng.pick(["solid", "gradient", "noise", "checker"]),
    size: rng.range(0.34, 0.82) * OUT,
    cxFrac: rng.range(0.30, 0.70),
    cyFrac: rng.range(0.30, 0.70),
    rot: rng.range(-Math.PI, Math.PI),
    persp: rng.range(0, 0.35),
    perspAxis: rng.range(0, Math.PI),
    blur: rng.range(0, 2.2),
    noise: rng.range(0, 0.10),
    scratches: rng.int(0, 3),
    color: {
      gain: [rng.range(0.7, 1.3), rng.range(0.7, 1.3), rng.range(0.7, 1.3)],
      offset: [rng.range(-18, 18), rng.range(-18, 18), rng.range(-18, 18)],
      gamma: [rng.range(0.85, 1.2), rng.range(0.85, 1.2), rng.range(0.85, 1.2)],
    },
  };
}

/**
 * Realistic CAPTURE envelope for training a LOCALIZER. randomScene() is the
 * decoder's torture test — scratches slashing through the code, heavy blur — which
 * teaches a detector noisy geometry (a scratched fiducial isn't where to learn the
 * center from). A localizer should instead see what a camera actually produces:
 * perspective, rotation, scale, lighting, mild blur/noise — fiducials intact.
 */
export function realisticScene(rng, OUT) {
  return {
    out: OUT,
    bg: rng.pick(["solid", "gradient", "noise", "checker"]),
    size: rng.range(0.40, 0.82) * OUT,
    cxFrac: rng.range(0.32, 0.68),
    cyFrac: rng.range(0.32, 0.68),
    rot: rng.range(-Math.PI, Math.PI),
    persp: rng.range(0, 0.33),
    perspAxis: rng.range(0, Math.PI),
    blur: rng.range(0, 1.3),
    noise: rng.range(0, 0.05),
    scratches: 0,
    color: {
      gain: [rng.range(0.75, 1.25), rng.range(0.75, 1.25), rng.range(0.75, 1.25)],
      offset: [rng.range(-16, 16), rng.range(-16, 16), rng.range(-16, 16)],
      gamma: [rng.range(0.85, 1.2), rng.range(0.85, 1.2), rng.range(0.85, 1.2)],
    },
  };
}

const cloneGrid = (g) => ({ width: g.width, height: g.height, data: new Uint8Array(g.data) });

/**
 * Render one scene + its exact labels. `scene` may come from randomScene() or be
 * hand-built. `scene.bgGrid` (an OUT×OUT RGB grid) composites the code onto a real
 * photo. Returns { grid, label }; grid is an RGB {width,height,data}.
 */
export function renderScene(text, scene, rng) {
  const sym = encodeColor(text, { markers: !!scene.markers });
  const base = renderColorRaster(sym);     // D×D, white background, code centered
  const D = base.width;
  const p = { ...COLOR_PROFILE, ...sym.params };
  const rpPx = p.Rp * p.u;                  // pupil radius in base px
  const baseCx = D / 2;
  const baseCy = D / 2;
  const maskRadius = D / 2;                  // inscribed disc — keeps the quiet zone

  const OUT = scene.out;
  const half = scene.size / 2;
  const px = scene.cxFrac * OUT;
  const py = scene.cyFrac * OUT;
  const top = 1 - scene.persp;
  const ca = Math.cos(scene.rot);
  const sa = Math.sin(scene.rot);
  const pa = scene.perspAxis ?? 0;
  const pac = Math.cos(pa);
  const pas = Math.sin(pa);
  const place = (x, y) => {
    const lx = pac * x + pas * y;
    const ly = -pas * x + pac * y;
    const kx = lx * (ly < 0 ? top : 1);      // keystone shortens the "far" half
    const rx = pac * kx - pas * ly;
    const ry = pas * kx + pac * ly;
    return [px + (ca * rx - sa * ry), py + (sa * rx + ca * ry)];
  };
  const src = [[0, 0], [D, 0], [D, D], [0, D]];
  const dst = [place(-half, -half), place(half, -half), place(half, half), place(-half, half)];

  const Hf = homography(src, dst);           // base -> out (labels)
  const Hinv = homography(dst, src);          // out -> base (sampling)

  const out = scene.bgGrid ? cloneGrid(scene.bgGrid) : makeBackground(OUT, OUT, scene.bg, rng);
  warpComposite(base, out, Hinv, dst, { cx: baseCx, cy: baseCy, maskRadius });

  for (let i = 0; i < (scene.scratches || 0); i++) {
    const a = rng.range(0, Math.PI * 2);
    const reach = scene.size * 0.75;
    const ox = px + rng.range(-1, 1) * scene.size * 0.2;
    const oy = py + rng.range(-1, 1) * scene.size * 0.2;
    drawScratch(out, {
      x0: ox - Math.cos(a) * reach, y0: oy - Math.sin(a) * reach,
      x1: ox + Math.cos(a) * reach, y1: oy + Math.sin(a) * reach,
      width: rng.range(4, 16),
    });
  }

  if (scene.color) colorTransform(out, scene.color);
  const blurred = scene.blur > 0 ? gaussianBlur(out, scene.blur) : out;
  if (scene.noise > 0) addNoise(blurred, scene.noise, rng);

  // ── Exact labels (computed from the known geometry, not detected) ───────────
  const center = applyH(Hf, baseCx, baseCy);                       // pupil center (= disc center point)
  const rayTip = applyH(Hf, baseCx, baseCy - rpPx);               // north in base → ray direction
  const ray_deg = ((Math.atan2(rayTip[0] - center[0], -(rayTip[1] - center[1])) * DEG) + 360) % 360;
  // Outer end of the registration spoke (the black ray reaches the outer data ring).
  // A keypoint at the visible spoke tip lets a model recover rotation as atan2(tip-center).
  const rOuter = (p.Rp + sym.params.K * p.dr) * p.u;
  const rayTipOuter = applyH(Hf, baseCx, baseCy - rOuter);

  // The VISIBLE code is the disc (radius = maskRadius). Label that ellipse — it's
  // what a detector should box/track, and what the harness paints. (The pupil is a
  // tiny inner feature; its radius is reported separately for the robust.js seed.)
  const disc = conicToEllipse(warpConic(circleConic(baseCx, baseCy, maskRadius), Hinv));
  const pupil = conicToEllipse(warpConic(circleConic(baseCx, baseCy, rpPx), Hinv));
  const cphi = Math.cos(disc.phi), sphi = Math.sin(disc.phi);
  // Tight axis-aligned box of the rotated disc ellipse (not the invisible square).
  const ex = Math.hypot(disc.a * cphi, disc.b * sphi);
  const ey = Math.hypot(disc.a * sphi, disc.b * cphi);
  const bbox = [round1(disc.cx - ex), round1(disc.cy - ey), round1(2 * ex), round1(2 * ey)];
  // Quad = the 4 axis endpoints ON the disc boundary (visible, usable for homography).
  const pt = (t) => {
    const ct = Math.cos(t), st = Math.sin(t);
    return [round1(disc.cx + disc.a * cphi * ct - disc.b * sphi * st),
            round1(disc.cy + disc.a * sphi * ct + disc.b * cphi * st)];
  };
  const quad = [pt(0), pt(Math.PI / 2), pt(Math.PI), pt(3 * Math.PI / 2)];
  const palette_observed = scene.color
    ? PALETTE.map((c) => applyColorRGB(c, scene.color))
    : PALETTE.map((c) => [...c]);

  const label = {
    width: OUT, height: OUT, text, K: sym.params.K,
    bbox,
    center: [round1(center[0]), round1(center[1])],
    radius: round1((disc.a + disc.b) / 2),
    pupil_radius: round1((pupil.a + pupil.b) / 2),
    ray_deg: round1(ray_deg),
    ray_tip: [round1(rayTipOuter[0]), round1(rayTipOuter[1])],
    ellipse: { cx: round1(disc.cx), cy: round1(disc.cy), a: round1(disc.a), b: round1(disc.b), phi_deg: round1(disc.phi * DEG) },
    quad,
    color: scene.color
      ? { gain: scene.color.gain.map(round3), offset: scene.color.offset.map(round1), gamma: scene.color.gamma.map(round3) }
      : null,
    palette_observed,
    distort: {
      rot_deg: round1(((scene.rot || 0) * DEG)),
      scale: round3(scene.size / D),
      persp: round3(scene.persp || 0),
      blur: round1(scene.blur || 0),
      noise: round3(scene.noise || 0),
      scratches: scene.scratches || 0,
    },
  };
  return { grid: blurred, label };
}
