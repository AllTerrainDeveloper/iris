// IRIS detector test harness. Shows a random capture — the code pasted into a
// procedural scene OR your own photo, at any size/rotation/perspective/blur/noise —
// runs a "detector" on it, and PAINTS the prediction (center, pupil ellipse, ray,
// bbox, quad) over the image, next to the exact ground truth + an error readout.
//
// Two detectors, switchable live:
//   • Oracle  — returns the known label, optionally jittered, so the whole harness
//               (scene synthesis → overlay → error metrics) works BEFORE any model
//               exists. Slide the jitter up to preview how a noisy model would look.
//   • ONNX    — runs a real exported model via onnxruntime-web (CDN global `ort`).
//               A small CNN (web/models/iris-detector.onnx, from
//               tools/train_detector.py) AUTO-LOADS on startup; or drop in your own.
//               It predicts a pupil-center keypoint + a DISC SEGMENTATION MASK (we fit
//               the ellipse from the mask — ~0.5% size error, vs ~25% for the old
//               regression head). A polar scan (ray-refine.js) finds the rotation, and
//               the geometry crops the disc for the real decoder. Contract marked below.
//
// Scenes are produced by the SAME tools/scene.js the trainer uses, so what you see
// here is exactly the input distribution the model is trained on. No build step.

import { renderScene, randomScene, realisticScene, randomText } from "../tools/scene.js";
import { makePRNG } from "../tools/distort.js";
import { refineRayPolar } from "./ray-refine.js";
import { decodeColorRobust } from "../src/robust.js";

const $ = (id) => document.getElementById(id);
const DEG = Math.PI / 180;

const els = {
  canvas: $("view"),
  next: $("next"),
  source: $("source"),
  envelope: $("envelope"),
  distort: $("distort"),
  distortVal: $("distortVal"),
  detector: $("detector"),
  jitterRow: $("jitterRow"),
  jitter: $("jitter"),
  jitterVal: $("jitterVal"),
  onnxRow: $("onnxRow"),
  onnxFile: $("onnxFile"),
  onnxStatus: $("onnxStatus"),
  noColor: $("noColor"),
  showTruth: $("showTruth"),
  markers: $("markersToggle"),
  photoInput: $("photoInput"),
  photoCount: $("photoCount"),
  drop: $("drop"),
  info: $("info"),
};

const state = {
  seed: 1,
  photos: [],        // array of OUT×OUT RGB grids (loaded images)
  ort: null,         // onnxruntime InferenceSession
  OUT: 512,
};

// ── Painting helpers ─────────────────────────────────────────────────────────

function gridToImageData(ctx, grid) {
  const img = ctx.createImageData(grid.width, grid.height);
  const d = img.data;
  for (let i = 0, j = 0; i < grid.data.length; i += 3, j += 4) {
    d[j] = grid.data[i]; d[j + 1] = grid.data[i + 1]; d[j + 2] = grid.data[i + 2]; d[j + 3] = 255;
  }
  return img;
}

// Draw the full fiducial set for one prediction in `color`.
function paintPrediction(ctx, p, color, { dashed = false } = {}) {
  ctx.save();
  ctx.lineWidth = 2;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  if (dashed) ctx.setLineDash([6, 5]);

  // bbox
  if (p.bbox) ctx.strokeRect(p.bbox[0], p.bbox[1], p.bbox[2], p.bbox[3]);

  // quad
  if (p.quad) {
    ctx.beginPath();
    p.quad.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.stroke();
  }

  // pupil ellipse (perspective)
  if (p.ellipse) {
    const e = p.ellipse;
    ctx.beginPath();
    ctx.ellipse(e.cx, e.cy, Math.max(1, e.a), Math.max(1, e.b), (e.phi_deg || 0) * DEG, 0, Math.PI * 2);
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.lineWidth = 2;
  }

  // center crosshair
  if (p.center) {
    const [cx, cy] = p.center;
    ctx.beginPath();
    ctx.moveTo(cx - 9, cy); ctx.lineTo(cx + 9, cy);
    ctx.moveTo(cx, cy - 9); ctx.lineTo(cx, cy + 9);
    ctx.stroke();
    // ray (rotation): 0° = up, increasing clockwise. radius is the disc radius now.
    if (p.ray_deg != null) {
      const r = (p.radius || 30) * 0.95;
      const a = p.ray_deg * DEG;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.sin(a) * r, cy - Math.cos(a) * r);
      ctx.lineWidth = 3;
      ctx.stroke();
    }
  }
  ctx.restore();
}

// ── Detectors ────────────────────────────────────────────────────────────────

// Box-Muller normal sample.
function gauss() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Oracle: the ground truth as the "prediction", optionally jittered by `sigma` px
// (angles by sigma/3 deg, axes by sigma/2 px) to simulate an imperfect model.
function detectOracle(label, sigma) {
  const j = (v) => v + gauss() * sigma;
  const e = label.ellipse;
  return {
    center: [j(label.center[0]), j(label.center[1])],
    radius: label.radius + gauss() * sigma * 0.5,
    ray_deg: label.ray_deg + gauss() * sigma / 3,
    ellipse: { cx: j(e.cx), cy: j(e.cy), a: e.a + gauss() * sigma * 0.5, b: e.b + gauss() * sigma * 0.5, phi_deg: e.phi_deg + gauss() * sigma / 3 },
    bbox: label.bbox,
    quad: label.quad,
  };
}

// ONNX input side (px) and disc-mask resolution (tools/train_detector.py).
const ONNX_S = 96, ONNX_HF = 24;

// Fit the disc ellipse from the segmentation mask (HF×HF probabilities) by weighted
// moments — precise size + eccentricity, no regression-to-the-mean. Returns OUT-px
// {cx, cy, a, b, phiRad}.
function fitEllipseFromMask(y, off, W) {
  const HF = ONNX_HF, cell = W / HF;
  let tot = 0, sx = 0, sy = 0;
  for (let i = 0; i < HF; i++) for (let j = 0; j < HF; j++) { const w = y[off + i * HF + j]; tot += w; sx += w * j; sy += w * i; }
  if (tot < 1) return null;
  const mx = sx / tot, my = sy / tot;
  let cxx = 0, cyy = 0, cxy = 0;
  for (let i = 0; i < HF; i++) for (let j = 0; j < HF; j++) { const w = y[off + i * HF + j], dj = j - mx, di = i - my; cxx += w * dj * dj; cyy += w * di * di; cxy += w * dj * di; }
  cxx /= tot; cyy /= tot; cxy /= tot;
  const tr = cxx + cyy, d = Math.sqrt(Math.max(0, (cxx - cyy) ** 2 / 4 + cxy * cxy));
  const a = 2 * Math.sqrt(Math.max(tr / 2 + d, 1e-6)) * cell;
  const b = 2 * Math.sqrt(Math.max(tr / 2 - d, 1e-6)) * cell;
  const phiRad = Math.abs(cxy) > 1e-9 ? Math.atan2(tr / 2 + d - cxx, cxy) : (cxx >= cyy ? 0 : Math.PI / 2);
  return { cx: (mx + 0.5) * cell, cy: (my + 0.5) * cell, a, b, phiRad };
}

// ONNX: run a real model. CONTRACT (matches tools/train_detector.py):
//   input  : float32 [1,3,S,S], raw pixels in [0,1], NCHW
//   output : float32 [1, 2+HF*HF] = [cx/W, cy/W, disc_mask(HF×HF, sigmoid)]
//            (pupil center keypoint + disc segmentation mask).
async function detectOnnx(session, grid) {
  const S = ONNX_S;
  // Preprocess: resize the OUT×OUT capture to S×S, NCHW float32 in [0,1].
  const tmp = document.createElement("canvas");
  tmp.width = tmp.height = grid.width;
  tmp.getContext("2d").putImageData(gridToImageData(tmp.getContext("2d"), grid), 0, 0);
  const rc = document.createElement("canvas");
  rc.width = rc.height = S;
  const rctx = rc.getContext("2d");
  rctx.drawImage(tmp, 0, 0, S, S);
  const px = rctx.getImageData(0, 0, S, S).data;
  const chw = new Float32Array(3 * S * S);
  for (let i = 0, n = S * S; i < n; i++) {
    chw[i] = px[i * 4] / 255;
    chw[i + n] = px[i * 4 + 1] / 255;
    chw[i + 2 * n] = px[i * 4 + 2] / 255;
  }
  const out = await session.run({ [session.inputNames[0]]: new ort.Tensor("float32", chw, [1, 3, S, S]) });
  const y = out[session.outputNames[0]].data;

  // Postprocess: pupil center (radial origin) + the disc ellipse fit from the mask.
  const W = grid.width;
  const cx = y[0] * W, cy = y[1] * W;                  // pupil center keypoint
  const m = fitEllipseFromMask(y, 2, W) || { cx, cy, a: W * 0.3, b: W * 0.3, phiRad: 0 };
  const ex = m.cx, ey = m.cy, a = m.a, b = m.b, phiRad = m.phiRad;
  const ray = refineRayPolar(grid, cx, cy, ex, ey, a, b, phiRad).ray_deg;
  // Tight axis-aligned box of the (rotated) disc ellipse.
  const exx = Math.hypot(a * Math.cos(phiRad), b * Math.sin(phiRad));
  const eyy = Math.hypot(a * Math.sin(phiRad), b * Math.cos(phiRad));
  return {
    center: [cx, cy], radius: (a + b) / 2, ray_deg: ray,
    ellipse: { cx: ex, cy: ey, a, b, phi_deg: phiRad / DEG },
    bbox: [ex - exx, ey - eyy, 2 * exx, 2 * eyy],
    quad: null,
  };
}

// ── Scene sourcing ───────────────────────────────────────────────────────────

// Cover-fit an <img> into an OUT×OUT RGB grid for use as scene.bgGrid.
function photoToGrid(img, OUT) {
  const c = document.createElement("canvas");
  c.width = c.height = OUT;
  const ctx = c.getContext("2d");
  const s = Math.max(OUT / img.width, OUT / img.height);
  const w = img.width * s, h = img.height * s;
  ctx.drawImage(img, (OUT - w) / 2, (OUT - h) / 2, w, h);
  const id = ctx.getImageData(0, 0, OUT, OUT).data;
  const data = new Uint8Array(OUT * OUT * 3);
  for (let i = 0, j = 0; i < id.length; i += 4, j += 3) { data[j] = id[i]; data[j + 1] = id[i + 1]; data[j + 2] = id[i + 2]; }
  return { width: OUT, height: OUT, data };
}

// ── Main loop ────────────────────────────────────────────────────────────────

// Stage 2 of the pipeline: hand the located code to the REAL decoder. We cut the disc
// out of the cluttered scene and re-center it on white — the framing decodeColorRobust
// expects (it then recovers rotation/perspective/scale and RS-decodes the payload).
// The disc ellipse comes from the SEGMENTATION mask (≈0.5% precise — no regression to the
// mean), so a plain tight ellipse mask frames the disc correctly.
//
// The output is scale-FITTED into the frame (`scale = 2R/sz`): a large code (K8, big
// radius) must not be clipped by the size cap — clipping the outer rings off a long,
// low-ECC payload was the dominant decode failure. Cap is 768 so even big discs keep
// enough resolution for their tiny outer cells.
function cropEllipse(grid, ex, ey, a, b, phiRad) {
  const { width: W, height: H, data } = grid;
  const R = Math.max(a, b) * 1.02, sz = Math.max(48, Math.min(768, Math.round(2 * R)));
  const out = new Uint8Array(sz * sz * 3).fill(255);
  const c = Math.cos(phiRad), s = Math.sin(phiRad), half = sz / 2, scale = (2 * R) / sz;
  for (let oy = 0; oy < sz; oy++) {
    for (let ox = 0; ox < sz; ox++) {
      const dx = (ox - half) * scale, dy = (oy - half) * scale;
      const u = (dx * c + dy * s) / a, v = (-dx * s + dy * c) / b;
      if (u * u + v * v > 1) continue;                          // outside the disc → white
      const sx = Math.round(ex + dx), sy = Math.round(ey + dy);
      if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue;
      const si = (sy * W + sx) * 3, oi = (oy * sz + ox) * 3;
      out[oi] = data[si]; out[oi + 1] = data[si + 1]; out[oi + 2] = data[si + 2];
    }
  }
  return { width: sz, height: sz, data: out };
}

function nextSample() {
  state.seed = (state.seed * 1103515245 + 12345) >>> 0;  // advance to a NEW capture
  newSample();
}

async function newSample() {
  const OUT = state.OUT;
  const rng = makePRNG(state.seed);  // same seed ⇒ re-render the SAME code (slider/toggles adjust it)
  const text = randomText(rng);
  // The detector is built for realistic CAPTURES; randomScene is the DECODER's torture
  // envelope (scratches through the code), so it's an opt-in stress test here, not the
  // default — otherwise we'd be grading the detector on the wrong distribution.
  const torture = els.envelope && els.envelope.value === "torture";
  const scene = (torture ? randomScene : realisticScene)(rng, OUT);
  const useMarkers = !!(els.markers && els.markers.checked);
  scene.markers = useMarkers;                 // render the catchlight fiducials
  // Distortion slider: scale every nuisance factor (0% = clean, 100% = full envelope),
  // leaving pose (rotation/scale/position) alone so the detector is still exercised.
  const amt = els.distort ? +els.distort.value / 100 : 1;
  scene.blur *= amt;
  scene.noise *= amt;
  scene.scratches = Math.round(scene.scratches * amt);
  scene.persp *= amt;
  if (scene.color) {
    scene.color.gain = scene.color.gain.map((g) => 1 + (g - 1) * amt);
    scene.color.offset = scene.color.offset.map((o) => o * amt);
    scene.color.gamma = scene.color.gamma.map((g) => 1 + (g - 1) * amt);
  }
  if (els.noColor.checked) scene.color = null;

  // Background source: a loaded photo (if any & selected) or a procedural scene.
  const usePhoto = els.source.value === "photo" && state.photos.length;
  if (usePhoto) scene.bgGrid = state.photos[rng.int(0, state.photos.length - 1)];

  const { grid, label } = renderScene(text, scene, rng);

  // Run the detector.
  let pred;
  const t0 = performance.now();
  if (els.detector.value === "onnx" && state.ort) {
    try { pred = await detectOnnx(state.ort, grid); }
    catch (e) { els.onnxStatus.textContent = `run error: ${e.message}`; pred = detectOracle(label, +els.jitter.value); }
  } else {
    pred = detectOracle(label, +els.jitter.value);
  }
  const ms = (performance.now() - t0).toFixed(1);

  // Paint capture + overlays.
  const cv = els.canvas;
  cv.width = cv.height = OUT;
  const ctx = cv.getContext("2d");
  ctx.putImageData(gridToImageData(ctx, grid), 0, 0);
  if (els.showTruth.checked) paintPrediction(ctx, label, "rgba(56,189,248,0.9)", { dashed: true }); // truth = cyan dashed
  paintPrediction(ctx, pred, "rgba(244,63,94,0.95)");                                                // pred  = rose solid

  // Stage 2 — actually DECODE the payload: mask the disc out with the (precise,
  // mask-derived) ellipse and hand it to the real decoder (src/robust.js). A small scale
  // search covers the residual ~few-% mask error + the decoder's ±3% tolerance; RS+CRC
  // picks the crop that actually decoded.
  // RGB markers (when on) live in the quiet zone and don't touch the data, so a marker
  // code decodes exactly like a plain one — we always use the fast robust path here. The
  // markers just render (a fiducial preview); their homography decode is CLI/test-only.
  let decoded = null, decMs = 0;
  {
    const e = pred.ellipse, phiR = (e.phi_deg || 0) * DEG;
    const td0 = performance.now();
    // The segmentation ellipse is ~0.5% precise, so a tiny scale search suffices. The
    // budget needs to be generous: a long (K8) payload has many ring schedules to try,
    // and a too-short budget timed out before finding it — that was the bulk of the
    // remaining gap. End-to-end ≈ 90% on realistic captures (near the ~91% ceiling).
    for (const f of [1.0, 0.96, 1.04]) {
      try {
        const r = decodeColorRobust(cropEllipse(grid, e.cx, e.cy, e.a * f, e.b * f, phiR), { budgetMs: 900 });
        if (r) { decoded = r; break; }
      } catch { /* try the next scale */ }
    }
    decMs = performance.now() - td0;
  }
  const decHtml = decoded
    ? (decoded.text === label.text
        ? `<span style="color:#34d399">✓ "${decoded.text}"</span>`
        : `<span style="color:#fbbf24">⚠ "${decoded.text}"</span>`)
    : `<span style="color:#f87171">✗ couldn't decode</span>`;

  // Error readout (we always know the truth here).
  const dCenter = Math.hypot(pred.center[0] - label.center[0], pred.center[1] - label.center[1]);
  let dRay = Math.abs(pred.ray_deg - label.ray_deg) % 360; if (dRay > 180) dRay = 360 - dRay;
  const d = label.distort;
  els.info.innerHTML = `
    <div><span class="k">payload</span> "${label.text}" <span class="muted">· K=${label.K}</span></div>
    <div><span class="k">scene</span> ${usePhoto ? "photo" : scene.bg} · rot ${d.rot_deg}° · scale ${d.scale}× · persp ${d.persp} · blur ${d.blur}px · noise ${Math.round(d.noise * 100)}% · ${d.scratches} scratch</div>
    <div><span class="k">detector</span> ${els.detector.value === "onnx" && state.ort ? "ONNX" : "oracle"} · ${ms} ms</div>
    <hr/>
    <div><span class="dot pred"></span><b>prediction</b> &nbsp; center [${pred.center.map((v) => v.toFixed(0))}] · ray ${pred.ray_deg.toFixed(1)}° · ellipse ${pred.ellipse.a.toFixed(0)}×${pred.ellipse.b.toFixed(0)}</div>
    <div><span class="dot truth"></span><b>truth</b> &nbsp;&nbsp;&nbsp;&nbsp; center [${label.center.map((v) => v.toFixed(0))}] · ray ${label.ray_deg.toFixed(1)}° · ellipse ${label.ellipse.a.toFixed(0)}×${label.ellipse.b.toFixed(0)}</div>
    <div class="err"><b>error</b> &nbsp; center ${dCenter.toFixed(1)} px · ray ${dRay.toFixed(1)}°</div>
    <div class="dec"><b>decode</b> &nbsp; ${decHtml} <span class="muted">· ${decMs.toFixed(0)} ms</span></div>`;
}

// ── Wiring ───────────────────────────────────────────────────────────────────

function syncControls() {
  els.jitterRow.style.display = els.detector.value === "oracle" ? "" : "none";
  els.onnxRow.style.display = els.detector.value === "onnx" ? "" : "none";
  els.jitterVal.textContent = `${els.jitter.value} px`;
}

async function loadModel(file) {
  els.onnxStatus.textContent = "loading…";
  try {
    const buf = await file.arrayBuffer();
    state.ort = await ort.InferenceSession.create(buf);
    els.onnxStatus.textContent = `✓ ${file.name} · in=${state.ort.inputNames.join(",")} out=${state.ort.outputNames.join(",")}`;
  } catch (e) {
    state.ort = null;
    els.onnxStatus.textContent = `✗ ${e.message}`;
  }
}

function addPhotos(files) {
  for (const f of files) {
    if (!f.type.startsWith("image/")) continue;
    const img = new Image();
    img.onload = () => { state.photos.push(photoToGrid(img, state.OUT)); els.photoCount.textContent = `${state.photos.length} photo(s)`; URL.revokeObjectURL(img.src); };
    img.src = URL.createObjectURL(f);
  }
}

els.next.addEventListener("click", nextSample);
els.detector.addEventListener("change", () => { syncControls(); newSample(); });
els.jitter.addEventListener("input", () => { syncControls(); newSample(); });
els.source.addEventListener("change", newSample);
els.envelope.addEventListener("change", newSample);
els.distort.addEventListener("input", () => { els.distortVal.textContent = `${els.distort.value}%`; newSample(); });
els.noColor.addEventListener("change", newSample);
els.showTruth.addEventListener("change", newSample);
if (els.markers) els.markers.addEventListener("change", newSample);
els.onnxFile.addEventListener("change", (e) => e.target.files[0] && loadModel(e.target.files[0]));
els.photoInput.addEventListener("change", (e) => addPhotos(e.target.files));
["dragover", "dragenter"].forEach((ev) => els.drop.addEventListener(ev, (e) => { e.preventDefault(); els.drop.classList.add("over"); }));
["dragleave", "drop"].forEach((ev) => els.drop.addEventListener(ev, (e) => { e.preventDefault(); els.drop.classList.remove("over"); }));
els.drop.addEventListener("drop", (e) => addPhotos(e.dataTransfer.files));

// Auto-load the bundled baseline model so ONNX mode works out of the box. If it's
// missing or onnxruntime-web can't fetch its wasm (e.g. offline), fall back to the
// oracle silently — the harness still works, just without a real model.
async function autoLoadDefault() {
  if (typeof ort === "undefined") { els.onnxStatus.textContent = "onnxruntime-web unavailable"; return; }
  try {
    state.ort = await ort.InferenceSession.create("./models/iris-detector.onnx");
    els.onnxStatus.textContent = `✓ bundled baseline · out=${state.ort.outputNames.join(",")}`;
    els.detector.value = "onnx";
    syncControls();
    newSample();
  } catch {
    els.onnxStatus.textContent = "no bundled model — using oracle";
  }
}

syncControls();
newSample();
autoLoadDefault();
