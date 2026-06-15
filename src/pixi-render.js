// PixiJS v8 (WebGL) renderer for the IRIS "blobs" style — METABALLS, the fast way.
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
// INDEPENDENT of cell count — so big payloads can't blow up the browser.
//
// PIXI v8 is supplied by the caller: pass `opts.PIXI` (`import * as PIXI from
// "pixi.js"`) or rely on a global `PIXI` (CDN). IRIS stays zero-dependency. The
// v8 renderer initialises asynchronously, so `renderBlobCanvas` returns a Promise.
import { PALETTE, WHITE_TINT_RGB, FRAME_WIDTH_U } from "./color.js";
import { imageSizePx } from "./params.js";

const globalPixi = () => (typeof PIXI !== "undefined" ? PIXI : null);
const resolvePixi = (opts) => (opts && opts.PIXI) || globalPixi();

// Tangential reach vs angular cell pitch. 1.5 overlaps neighbours enough to soften
// the bead necks into smoother rings while cell CORES stay pure enough to decode —
// a field-decode sweep is clean+robust safe through ~1.8 (2.0 breaks clean decode).
const RAD_TAN = 1.5;
const RAD_RAD = 0.49; // radial reach vs ring width — MUST stay < 0.5 (no cross-level blend)
const THRESHOLD = 0.12; // iso-surface level; lower fills the necks (rings can't merge: RAD_RAD<0.5)
const GRAD_SCALE = 26.0; // field-gradient → surface-normal strength (visual only)
// Accumulate into a plain RGBA8 target (works everywhere — no half-float render
// dependency). Contributions are pre-scaled by ACCUM so the additive sum (≤~1.2
// where blobs overlap) never clamps; the composite divides it back out.
const ACCUM = 0.4;

// Pixi v8's WebGL backend wants GLSL ES 3.00 for `in`/`out`/UBOs; it doesn't add
// the #version directive for raw `gl` shaders, so we lead with it ourselves.
const HEAD = "#version 300 es\nprecision highp float;\n";

// Pixi v8 won't reliably bind custom UBOs to a Mesh shader, so instead of uniforms
// we BAKE the per-render scalars (size, texel, threshold) straight into the GLSL as
// literals — the only bound resource left is the accumulation texture sampler. We
// compute clip space directly (matching Pixi's screen projection, so the field
// aligns with the Graphics fiducials); the accumulation render-texture is stored
// bottom-up, so the composite pass flips V when sampling it.
const glf = (n) => (Number.isInteger(n) ? n.toFixed(1) : String(n));
const toClip = (size) =>
  `vec2 cl = world / vec2(${glf(size)}) * 2.0 - 1.0; cl.y = -cl.y; gl_Position = vec4(cl, 0.0, 1.0);`;

// Pass 1 — accumulate. One quad per blob; the GPU additively sums vec4(colour·f, f).
const accVert = (size) => `${HEAD}
in vec2 aCorner;  // quad corner in [-1,1] (also the blob-local coord)
in vec2 aCenter;  // blob centre, px
in vec2 aRadial;  // unit radial direction
in vec2 aRadii;   // (tangential reach, radial reach), px
in vec3 aColor;
out vec2 vLocal;
out vec3 vColor;
void main() {
  vec2 tang = vec2(-aRadial.y, aRadial.x);
  vec2 world = aCenter + aCorner.x * aRadii.x * tang + aCorner.y * aRadii.y * aRadial;
  ${toClip(size)}
  vLocal = aCorner;
  vColor = aColor;
}`;
const ACC_FRAG = `${HEAD}
in vec2 vLocal;
in vec3 vColor;
out vec4 fragColor;
void main() {
  float t = 1.0 - dot(vLocal, vLocal); // finite-support ellipse bump
  if (t <= 0.0) discard;
  float f = t * t;
  fragColor = vec4(vColor * f, f) * ${glf(ACCUM)}; // additive Σ colour·f, Σ f (pre-scaled)
}`;

// Pass 2 — composite. Threshold the field, normalise colour, shade from gradient.
const compVert = (size) => `${HEAD}
in vec2 aPosition;
in vec2 aUV;
out vec2 vUV;
void main() {
  vec2 world = aPosition;
  ${toClip(size)}
  vUV = aUV;
}`;
const compFrag = (size, res) => `${HEAD}
in vec2 vUV;
out vec4 fragColor;
uniform sampler2D uAccum;
const vec2 uTexel = vec2(${glf(1 / (size * res))});
const float uThreshold = ${glf(THRESHOLD)};
const float uGradScale = ${glf(GRAD_SCALE)};
const float uScale = ${glf(ACCUM)};
void main() {
  vec4 acc = texture(uAccum, vUV);
  float field = acc.a / uScale;
  float alpha = smoothstep(uThreshold * 0.85, uThreshold * 1.15, field);
  if (alpha <= 0.0) discard;
  vec3 base = acc.rgb / max(acc.a, 1e-4); // pure at cell cores (pre-scale cancels)
  float fx = (texture(uAccum, vUV + vec2(uTexel.x, 0.0)).a - texture(uAccum, vUV - vec2(uTexel.x, 0.0)).a) / uScale;
  float fy = (texture(uAccum, vUV + vec2(0.0, uTexel.y)).a - texture(uAccum, vUV - vec2(0.0, uTexel.y)).a) / uScale;
  vec3 N = normalize(vec3(-vec2(fx, fy) * uGradScale, 1.0));
  vec3 L = normalize(vec3(-0.5, -0.7, 0.75));
  vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
  float core = smoothstep(uThreshold, uThreshold * 2.5, field);
  float diff = max(0.0, dot(N, L));
  float spec = pow(max(0.0, dot(N, H)), 28.0) * 0.5 * core;
  float lambert = 0.68 + 0.40 * diff;
  vec3 shaded = clamp(base * lambert + vec3(spec), 0.0, 1.0);
  fragColor = vec4(shaded * alpha, alpha); // premultiplied
}`;

const superSample = (size) => Math.max(1, Math.min(3, Math.round(1200 / size)));

// Cache one WebGL renderer per (size@resolution). Keyed + retained (not destroyed
// on mismatch) so concurrent callers — e.g. the generator preview AND the Lab —
// never tear down a renderer the other is mid-render with. Capped to a few live
// GL contexts; the oldest is evicted when the cap is hit.
const renderers = new Map();
function getRenderer(PX, size, res) {
  const key = `${size}@${res}`;
  if (!renderers.has(key)) {
    if (renderers.size >= 4) {
      const oldest = renderers.keys().next().value;
      const p = renderers.get(oldest);
      renderers.delete(oldest);
      Promise.resolve(p).then((r) => r.destroy()).catch(() => {});
    }
    renderers.set(key, PX.autoDetectRenderer({
      width: size, height: size, resolution: res, preference: "webgl",
      backgroundAlpha: 0, antialias: false,
    }));
  }
  return renderers.get(key);
}

const P = (cx, cy, r, a) => [cx + r * Math.sin(a), cy - r * Math.cos(a)];

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
      // Every cell emits a blob (white → faint tint) so the ring connects through
      // white cells instead of breaking; the tint still decodes as white at the core.
      const rgb = v === 7 ? WHITE_TINT_RGB : PALETTE[v];
      const a = i * dk;
      const rx = Math.sin(a), ry = -Math.cos(a); // unit radial direction
      blobs.push({ x: c + rmid * rx, y: c + rmid * ry, rx, ry, radTan, radRad, rgb });
    }
  }
  return blobs;
}

// Batched geometry: 6 vertices (2 triangles) per blob, no index buffer.
function buildAccMesh(PX, blobs, size) {
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
  const geometry = new PX.Geometry({
    attributes: {
      aCorner: { buffer: corner, format: "float32x2" },
      aCenter: { buffer: center, format: "float32x2" },
      aRadial: { buffer: radial, format: "float32x2" },
      aRadii: { buffer: radii, format: "float32x2" },
      aColor: { buffer: color, format: "float32x3" },
    },
  });
  const shader = PX.Shader.from({ gl: { vertex: accVert(size), fragment: ACC_FRAG } });
  const mesh = new PX.Mesh({ geometry, shader });
  mesh.blendMode = "add"; // additive accumulation
  return mesh;
}

function buildFiducials(PX, sym, size) {
  const { Rp, dr, K, N, u } = sym.params;
  const c = size / 2;
  const g = new PX.Graphics();
  // Registration ray: solid continuous wedge per ring.
  for (let k = 0; k < K; k++) {
    const r0 = (Rp + k * dr) * u, r1 = (Rp + (k + 1) * dr) * u, dk = (2 * Math.PI) / N[k];
    const a0 = -0.5 * dk, a1 = 0.5 * dk, S = 6;
    const pts = [...P(c, c, r0, a0)];
    for (let s = 0; s <= S; s++) pts.push(...P(c, c, r1, a0 + (a1 - a0) * (s / S)));
    for (let s = 0; s <= S; s++) pts.push(...P(c, c, r0, a1 - (a1 - a0) * (s / S)));
    g.poly(pts).fill(0x000000);
  }
  // Crisp outer frame ring at the data edge (matches every other style).
  g.circle(c, c, (Rp + K * dr) * u).stroke({ width: FRAME_WIDTH_U * u, color: 0x000000 });
  // Pupil bullseye.
  g.circle(c, c, Rp * u).fill(0x000000);
  g.circle(c, c, (Rp - 2) * u).fill(0xffffff);
  g.circle(c, c, 2 * u).fill(0x000000);
  return g;
}

/**
 * Render the blob (metaball) style to a fresh white canvas (async — Pixi v8 inits
 * asynchronously). `sym` is an `encodeColor(...)` symbol. Pass `opts.PIXI` or rely
 * on a global `PIXI`; `opts.supersample` overrides the auto factor. Resolves to an
 * HTMLCanvasElement, or null if PIXI is unavailable (browser only).
 */
export async function renderBlobCanvas(sym, opts = {}) {
  const PX = resolvePixi(opts);
  if (!PX) return null;
  const size = imageSizePx(sym.params.K, sym.params);
  const res = opts.supersample || superSample(size);
  const r = await getRenderer(PX, size, res);

  // Pass 1 — accumulate the field into a render texture.
  const accRT = PX.RenderTexture.create({
    width: size, height: size, resolution: res, scaleMode: "nearest", antialias: false,
  });
  const accMesh = buildAccMesh(PX, buildBlobs(sym, size), size);
  r.render({ container: accMesh, target: accRT, clear: true });

  // Pass 2 — composite (threshold + gradient shading) with solid fiducials on top.
  const comp = new PX.Mesh({
    geometry: new PX.Geometry({
      attributes: {
        aPosition: { buffer: new Float32Array([0, 0, size, 0, size, size, 0, size]), format: "float32x2" },
        aUV: { buffer: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), format: "float32x2" },
      },
      indexBuffer: new Uint32Array([0, 1, 2, 0, 2, 3]),
    }),
    shader: PX.Shader.from({
      gl: { vertex: compVert(size), fragment: compFrag(size, res) },
      resources: { uAccum: accRT.source },
    }),
  });
  const stage = new PX.Container();
  stage.addChild(comp, buildFiducials(PX, sym, size));
  const gpu = r.extract.canvas(stage);

  accRT.destroy(true);
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

/** True if a PIXI instance is available (via `opts.PIXI` or a global `PIXI`). */
export const pixiAvailable = (opts) => !!resolvePixi(opts);
