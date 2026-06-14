// PixiJS (WebGL) renderer for the IRIS "blobs" style — METABALLS.
//
// Each data cell is a metaball (an inverse-square field source) at its cell
// centre, coloured by its palette entry. The fragment shader sums every cell's
// field; where the sum crosses a threshold there is "surface", so neighbouring
// blobs MERGE with smooth organic necks (mercury / lava-lamp), and the colour at
// each pixel is the field-WEIGHTED BLEND of the contributing cells — so colours
// blend exactly where blobs stick together. Inverse-square falloff means a cell's
// own field dominates at its centre, so centres stay pure → the symbol decodes.
// No blur: edges are a hard threshold (1px antialias only). Pupil + registration
// ray are drawn solid on top (fiducials).
//
// Uses the global `PIXI` (CDN). Returns null if PIXI is unavailable.
import { PALETTE } from "../src/color.js";
import { imageSizePx } from "../src/params.js";

// Tunables. RADIUS_FRAC sets each blob's influence vs its cell pitch; THRESHOLD
// is the iso-surface level. Together they decide how readily blobs merge: necks
// form between adjacent coloured cells, but a background (white) cell's centre
// stays below threshold so it reads as background.
// Anisotropic metaballs: WIDE along the ring (tangential) so angular neighbours
// merge into a thick gooey concentric band, and radially CONFINED so each level
// is independent. RAD_RAD is kept just under 0.5 (half the ring spacing): then no
// pixel is ever inside two rings' blobs at once, so colours NEVER blend between
// levels — the merging/blending is strictly within a ring. Lower THRESHOLD fattens
// the blobs toward filling the ring (a thin seam still separates the levels).
const RAD_TAN = 1.0; // tangential reach vs angular cell pitch (≤1 keeps cell centres pure)
const RAD_RAD = 0.49; // radial reach vs ring width — MUST stay < 0.5 (no cross-level blend)
const THRESHOLD = 0.2; // iso-surface level (lower → thicker bands)

const VERT = `
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

const FRAG = `
precision highp float;
varying vec2 vUv;
uniform vec2 uResolution;
uniform vec2 uCenter;
uniform sampler2D uData;   // width=count, height=2: row0=(x,y,radTan,radRad), row1=(r,g,b)
uniform float uCount;
uniform float uThreshold;
const int MAXC = 1024;
void main() {
  vec2 p = vUv * uResolution;
  float field = 0.0;  // surface field (smooth, finite support)
  float wsum = 0.0;   // colour weight (sharper → nearest blob dominates, necks blend 2)
  vec3 col = vec3(0.0);
  vec2 grad = vec2(0.0); // ANALYTIC gradient of the field → continuous surface normal
  for (int i = 0; i < MAXC; i++) {
    if (float(i) >= uCount) break;
    float u = (float(i) + 0.5) / uCount;
    vec4 a = texture2D(uData, vec2(u, 0.25)); // x, y, radTan, radRad
    vec3 c = texture2D(uData, vec2(u, 0.75)).rgb;
    vec2 d = p - a.xy;
    // Decompose into radial / tangential about the symbol centre → anisotropic blob.
    vec2 rad = normalize(a.xy - uCenter);
    vec2 tang = vec2(-rad.y, rad.x);
    float dr = dot(d, rad) / a.w;      // a.w = radial reach
    float dt = dot(d, tang) / a.z;     // a.z = tangential reach
    float t = 1.0 - (dr * dr + dt * dt); // finite support ellipse: 0 outside the blob
    if (t <= 0.0) continue;
    float f = t * t;     // Wyvill-ish smooth bump
    float w = f * f;     // sharper weight keeps colours vivid, blends only at necks
    field += f;
    wsum += w;
    col += c * w;
    // d(t²)/dp = 2t·dt/dp,  dt/dp = -2(dr·rad/radRad + dt·tang/radTan)
    grad += -4.0 * t * (dr * rad / a.w + dt * tang / a.z);
  }
  float alpha = smoothstep(uThreshold * 0.85, uThreshold * 1.15, field);
  if (alpha <= 0.0) discard;
  col /= max(wsum, 1e-4); // flat blended base colour (pure at cell cores)

  // Glossy liquid shading. The normal comes from the field GRADIENT (the true
  // iso-surface slope), which is continuous across merged blobs — so necks shade
  // seamlessly, no creases at the joints. At a cell core grad≈0 → normal faces the
  // viewer → uniform light → core keeps its pure hue (decodes); the highlight sits
  // on the light-facing slopes, off-centre.
  vec3 N = normalize(vec3(-grad * 6.0, 1.0));
  vec3 L = normalize(vec3(-0.5, -0.7, 0.75));
  vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));      // viewer along +z
  float core = smoothstep(uThreshold, uThreshold * 2.5, field); // 0 at rim, 1 in core
  float diff = max(0.0, dot(N, L));
  float spec = pow(max(0.0, dot(N, H)), 28.0) * 0.5;
  float lambert = 0.68 + 0.40 * diff;
  vec3 shaded = clamp(col * lambert + vec3(spec) * core, 0.0, 1.0);
  gl_FragColor = vec4(shaded * alpha, alpha); // premultiplied
}`;

let renderer = null;
let rKey = ""; // size@resolution the current renderer was built for
const ok = () => typeof PIXI !== "undefined";

// Supersample so the smooth metaball shading isn't upscaled (= pixelated) on
// retina displays: render at `res`× and let it display downscaled. Capped so the
// backing canvas stays ~≤1200px even for big symbols.
const superSample = (size) => Math.max(1, Math.min(3, Math.round(1200 / size)));

function getRenderer(size, res) {
  const key = `${size}@${res}`;
  if (renderer && rKey === key) return renderer;
  if (renderer) renderer.destroy();
  renderer = new PIXI.Renderer({
    width: size, height: size, backgroundAlpha: 0, antialias: true,
    resolution: res, autoDensity: false, preserveDrawingBuffer: true,
  });
  rKey = key;
  return renderer;
}

const P = (cx, cy, r, a) => [cx + r * Math.sin(a), cy - r * Math.cos(a)];

function buildStage(sym, size) {
  const p = sym.params;
  const { Rp, dr, K, N, u } = p;
  const c = size / 2;
  const stage = new PIXI.Container();

  // Collect one metaball per coloured data cell (skip white background and the
  // registration ray, which is drawn solid).
  const blobs = [];
  for (let k = 0; k < K; k++) {
    const rmid = (Rp + (k + 0.5) * dr) * u;
    const dk = (2 * Math.PI) / N[k];
    const radTan = RAD_TAN * rmid * dk; // along the ring → merges angular neighbours
    const radRad = RAD_RAD * dr * u; // across rings → small, leaves a gap between levels
    for (let i = 1; i < N[k]; i++) {
      const v = sym.cells[k][i];
      if (v === 7) continue; // white === background
      const [x, y] = P(c, c, rmid, i * dk); // centered convention
      blobs.push({ x, y, radTan, radRad, rgb: PALETTE[v] });
    }
  }

  if (blobs.length) {
    const count = blobs.length;
    const buf = new Float32Array(count * 2 * 4); // 2 rows (pos+radius, color) x RGBA
    for (let i = 0; i < count; i++) {
      const b = blobs[i];
      buf[i * 4 + 0] = b.x; buf[i * 4 + 1] = b.y; buf[i * 4 + 2] = b.radTan; buf[i * 4 + 3] = b.radRad;
      const o = (count + i) * 4; // row 1
      buf[o + 0] = b.rgb[0] / 255; buf[o + 1] = b.rgb[1] / 255; buf[o + 2] = b.rgb[2] / 255; buf[o + 3] = 1;
    }
    const tex = PIXI.Texture.fromBuffer(buf, count, 2, {
      format: PIXI.FORMATS.RGBA, type: PIXI.TYPES.FLOAT, scaleMode: PIXI.SCALE_MODES.NEAREST,
    });
    const geometry = new PIXI.Geometry()
      .addAttribute("aVertexPosition", [0, 0, size, 0, size, size, 0, size], 2)
      .addAttribute("aUv", [0, 0, 1, 0, 1, 1, 0, 1], 2)
      .addIndex([0, 1, 2, 0, 2, 3]);
    const shader = PIXI.Shader.from(VERT, FRAG, {
      uResolution: [size, size], uCenter: [c, c], uData: tex, uCount: count, uThreshold: THRESHOLD,
    });
    stage.addChild(new PIXI.Mesh(geometry, shader));
  }

  // Registration ray: solid continuous wedge per ring (fiducial).
  const ray = new PIXI.Graphics();
  for (let k = 0; k < K; k++) {
    const r0 = (Rp + k * dr) * u, r1 = (Rp + (k + 1) * dr) * u, dk = (2 * Math.PI) / N[k];
    const a0 = -0.5 * dk, a1 = 0.5 * dk, S = 6;
    ray.beginFill(0x000000);
    ray.moveTo(...P(c, c, r0, a0));
    for (let s = 0; s <= S; s++) ray.lineTo(...P(c, c, r1, a0 + (a1 - a0) * (s / S)));
    for (let s = 0; s <= S; s++) ray.lineTo(...P(c, c, r0, a1 - (a1 - a0) * (s / S)));
    ray.closePath();
    ray.endFill();
  }
  stage.addChild(ray);

  // Pupil bullseye.
  const pupil = new PIXI.Graphics();
  pupil.beginFill(0x000000).drawCircle(c, c, Rp * u).endFill();
  pupil.beginFill(0xffffff).drawCircle(c, c, (Rp - 2) * u).endFill();
  pupil.beginFill(0x000000).drawCircle(c, c, 2 * u).endFill();
  stage.addChild(pupil);

  return { stage, dispose: () => stage.destroy({ children: true, texture: true }) };
}

/** Render the blob (metaball) style to a fresh white canvas, or null if no PIXI. */
export function renderBlobCanvas(sym, opts = {}) {
  if (!ok()) return null;
  const size = imageSizePx(sym.params.K, sym.params);
  // Supersample for crisp DISPLAY; callers that distort/decode (the Lab) pass
  // supersample:1 to keep the pixel count — and the work — at native resolution.
  const res = opts.supersample || superSample(size);
  const r = getRenderer(size, res);
  const { stage, dispose } = buildStage(sym, size); // logical coords; shader runs at res×
  r.render(stage);
  const gpu = r.extract.canvas(stage); // size·res px → supersampled
  dispose();
  const out = document.createElement("canvas");
  out.width = out.height = gpu.width;
  const ctx = out.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(gpu, 0, 0, out.width, out.height);
  return out;
}

export const pixiAvailable = ok;
