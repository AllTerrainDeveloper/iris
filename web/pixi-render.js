// PixiJS (WebGL) renderer for the IRIS "blobs" style — METABALLS, the fast way.
//
// Each data cell is an anisotropic metaball: wide ALONG its ring (so angular
// neighbours merge into gooey liquid bands, colours blending at the necks) but
// radially confined to < half the ring spacing, so LEVELS NEVER BLEND.
//
// Performance: the field is built by ADDITIVE BLENDING — every blob is a small
// quad drawn in ONE batched draw call into a float buffer (pass 1). A single
// full-screen pass then thresholds the iso-surface, normalises the colour and
// shades it from the analytic field gradient (continuous → seamless necks, no
// creases; cell cores keep a pure hue → still decodes). Cost is O(image area),
// INDEPENDENT of cell count — so big payloads can't blow up the browser. (The old
// per-pixel-loops-over-every-cell shader was O(pixels × cells) and would hang.)
//
// Uses the global `PIXI` (CDN). Returns null if PIXI is unavailable.
import { PALETTE } from "../src/color.js";
import { imageSizePx } from "../src/params.js";

const RAD_TAN = 1.0; // tangential reach vs angular cell pitch (≤1 keeps cell centres pure)
const RAD_RAD = 0.49; // radial reach vs ring width — MUST stay < 0.5 (no cross-level blend)
const THRESHOLD = 0.2; // iso-surface level on the accumulated field
const GRAD_SCALE = 26.0; // field-gradient → surface-normal strength (visual only)

// Pass 1 — accumulate. One quad per blob; the GPU additively sums vec4(colour·f, f).
const ACC_VERT = `
precision highp float;
attribute vec2 aCorner;  // quad corner in [-1,1] (also the blob-local coord)
attribute vec2 aCenter;  // blob centre, px
attribute vec2 aRadial;  // unit radial direction
attribute vec2 aRadii;   // (tangential reach, radial reach), px
attribute vec3 aColor;
uniform mat3 projectionMatrix;
uniform mat3 translationMatrix;
varying vec2 vLocal;
varying vec3 vColor;
void main() {
  vec2 tang = vec2(-aRadial.y, aRadial.x);
  vec2 world = aCenter + aCorner.x * aRadii.x * tang + aCorner.y * aRadii.y * aRadial;
  vLocal = aCorner;
  vColor = aColor;
  gl_Position = vec4((projectionMatrix * translationMatrix * vec3(world, 1.0)).xy, 0.0, 1.0);
}`;
const ACC_FRAG = `
precision highp float;
varying vec2 vLocal;
varying vec3 vColor;
void main() {
  float t = 1.0 - dot(vLocal, vLocal); // finite-support ellipse bump
  if (t <= 0.0) discard;
  float f = t * t;
  gl_FragColor = vec4(vColor * f, f); // additive: Σ colour·f  in rgb,  Σ f  in a
}`;

// Pass 2 — composite. Threshold the field, normalise colour, shade from gradient.
const COMP_VERT = `
precision highp float;
attribute vec2 aVertexPosition;
attribute vec2 aUv;
uniform mat3 projectionMatrix;
uniform mat3 translationMatrix;
varying vec2 vUv;
void main() {
  vUv = aUv;
  gl_Position = vec4((projectionMatrix * translationMatrix * vec3(aVertexPosition, 1.0)).xy, 0.0, 1.0);
}`;
const COMP_FRAG = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uAccum;
uniform vec2 uTexel;
uniform float uThreshold;
uniform float uGradScale;
void main() {
  vec4 acc = texture2D(uAccum, vUv);
  float field = acc.a;
  float alpha = smoothstep(uThreshold * 0.85, uThreshold * 1.15, field);
  if (alpha <= 0.0) discard;
  vec3 base = acc.rgb / max(field, 1e-4); // pure at cell cores
  // Surface normal from the field gradient (continuous across merged blobs).
  float fx = texture2D(uAccum, vUv + vec2(uTexel.x, 0.0)).a - texture2D(uAccum, vUv - vec2(uTexel.x, 0.0)).a;
  float fy = texture2D(uAccum, vUv + vec2(0.0, uTexel.y)).a - texture2D(uAccum, vUv - vec2(0.0, uTexel.y)).a;
  vec3 N = normalize(vec3(-vec2(fx, fy) * uGradScale, 1.0));
  vec3 L = normalize(vec3(-0.5, -0.7, 0.75));
  vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
  float core = smoothstep(uThreshold, uThreshold * 2.5, field);
  float diff = max(0.0, dot(N, L));
  float spec = pow(max(0.0, dot(N, H)), 28.0) * 0.5 * core;
  float lambert = 0.68 + 0.40 * diff;
  vec3 shaded = clamp(base * lambert + vec3(spec), 0.0, 1.0);
  gl_FragColor = vec4(shaded * alpha, alpha); // premultiplied
}`;

let renderer = null;
let rKey = "";
const ok = () => typeof PIXI !== "undefined";

const superSample = (size) => Math.max(1, Math.min(3, Math.round(1200 / size)));

function getRenderer(size, res) {
  const key = `${size}@${res}`;
  if (renderer && rKey === key) return renderer;
  if (renderer) renderer.destroy();
  renderer = new PIXI.Renderer({
    width: size, height: size, backgroundAlpha: 0, antialias: false,
    resolution: res, autoDensity: false, preserveDrawingBuffer: true,
  });
  rKey = key;
  return renderer;
}

const P = (cx, cy, r, a) => [cx + r * Math.sin(a), cy - r * Math.cos(a)];

// Batched geometry: 6 vertices (2 triangles) per blob, no index buffer.
function buildAccMesh(blobs) {
  const n = blobs.length;
  const CORNERS = [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]];
  const corner = new Float32Array(n * 6 * 2);
  const center = new Float32Array(n * 6 * 2);
  const radial = new Float32Array(n * 6 * 2);
  const radii = new Float32Array(n * 6 * 2);
  const color = new Float32Array(n * 6 * 3);
  for (let i = 0; i < n; i++) {
    const b = blobs[i];
    for (let v = 0; v < 6; v++) {
      const o2 = (i * 6 + v) * 2, o3 = (i * 6 + v) * 3;
      corner[o2] = CORNERS[v][0]; corner[o2 + 1] = CORNERS[v][1];
      center[o2] = b.x; center[o2 + 1] = b.y;
      radial[o2] = b.rx; radial[o2 + 1] = b.ry;
      radii[o2] = b.radTan; radii[o2 + 1] = b.radRad;
      color[o3] = b.rgb[0] / 255; color[o3 + 1] = b.rgb[1] / 255; color[o3 + 2] = b.rgb[2] / 255;
    }
  }
  const geometry = new PIXI.Geometry()
    .addAttribute("aCorner", corner, 2)
    .addAttribute("aCenter", center, 2)
    .addAttribute("aRadial", radial, 2)
    .addAttribute("aRadii", radii, 2)
    .addAttribute("aColor", color, 3);
  const shader = PIXI.Shader.from(ACC_VERT, ACC_FRAG, {});
  const mesh = new PIXI.Mesh(geometry, shader);
  mesh.state.blendMode = PIXI.BLEND_MODES.ADD; // additive accumulation
  return mesh;
}

function buildBlobs(sym, size) {
  const { Rp, dr, K, N, u } = sym.params;
  const c = size / 2;
  const blobs = [];
  for (let k = 0; k < K; k++) {
    const rmid = (Rp + (k + 0.5) * dr) * u;
    const dk = (2 * Math.PI) / N[k];
    const radTan = RAD_TAN * rmid * dk;
    const radRad = RAD_RAD * dr * u;
    for (let i = 1; i < N[k]; i++) {
      const v = sym.cells[k][i];
      if (v === 7) continue; // white === background
      const a = i * dk;
      const rx = Math.sin(a), ry = -Math.cos(a); // unit radial direction
      blobs.push({ x: c + rmid * rx, y: c + rmid * ry, rx, ry, radTan, radRad, rgb: PALETTE[v] });
    }
  }
  return blobs;
}

function buildFiducials(sym, size) {
  const { Rp, dr, K, N, u } = sym.params;
  const c = size / 2;
  const g = new PIXI.Graphics();
  // Registration ray: solid continuous wedge per ring.
  for (let k = 0; k < K; k++) {
    const r0 = (Rp + k * dr) * u, r1 = (Rp + (k + 1) * dr) * u, dk = (2 * Math.PI) / N[k];
    const a0 = -0.5 * dk, a1 = 0.5 * dk, S = 6;
    g.beginFill(0x000000);
    g.moveTo(...P(c, c, r0, a0));
    for (let s = 0; s <= S; s++) g.lineTo(...P(c, c, r1, a0 + (a1 - a0) * (s / S)));
    for (let s = 0; s <= S; s++) g.lineTo(...P(c, c, r0, a1 - (a1 - a0) * (s / S)));
    g.closePath();
    g.endFill();
  }
  // Pupil bullseye.
  g.beginFill(0x000000).drawCircle(c, c, Rp * u).endFill();
  g.beginFill(0xffffff).drawCircle(c, c, (Rp - 2) * u).endFill();
  g.beginFill(0x000000).drawCircle(c, c, 2 * u).endFill();
  return g;
}

/** Render the blob (metaball) style to a fresh white canvas, or null if no PIXI. */
export function renderBlobCanvas(sym, opts = {}) {
  if (!ok()) return null;
  const size = imageSizePx(sym.params.K, sym.params);
  const res = opts.supersample || superSample(size);
  const r = getRenderer(size, res);

  // Pass 1 — accumulate the field into a float render texture.
  const accRT = PIXI.RenderTexture.create({
    width: size, height: size, resolution: res,
    format: PIXI.FORMATS.RGBA, type: PIXI.TYPES.HALF_FLOAT, scaleMode: PIXI.SCALE_MODES.NEAREST,
  });
  const accMesh = buildAccMesh(buildBlobs(sym, size));
  r.render(accMesh, { renderTexture: accRT, clear: true });

  // Pass 2 — composite (threshold + gradient shading) with solid fiducials on top.
  const comp = new PIXI.Mesh(
    new PIXI.Geometry()
      .addAttribute("aVertexPosition", [0, 0, size, 0, size, size, 0, size], 2)
      .addAttribute("aUv", [0, 0, 1, 0, 1, 1, 0, 1], 2)
      .addIndex([0, 1, 2, 0, 2, 3]),
    PIXI.Shader.from(COMP_VERT, COMP_FRAG, {
      uAccum: accRT, uTexel: [1 / (size * res), 1 / (size * res)],
      uThreshold: THRESHOLD, uGradScale: GRAD_SCALE,
    }),
  );
  const stage = new PIXI.Container();
  stage.addChild(comp, buildFiducials(sym, size));
  const gpu = r.extract.canvas(stage);

  accRT.destroy(true);
  accMesh.geometry.destroy();
  accMesh.destroy();
  stage.destroy({ children: true });

  const out = document.createElement("canvas");
  out.width = out.height = gpu.width;
  const ctx = out.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(gpu, 0, 0, out.width, out.height);
  return out;
}

export const pixiAvailable = ok;
