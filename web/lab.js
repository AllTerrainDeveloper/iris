// Robustness Lab — distort a generated IRIS code (rotate, scale, perspective,
// blur, noise, scratches) and see whether the robust decoder reconstructs it.
import { encodeColor, renderColorSVG } from "../src/color.js";
import { decodeColorRobust } from "../src/robust.js";
import { renderBlobCanvas, pixiAvailable } from "./pixi-render.js";

const $ = (id) => document.getElementById(id);
const els = {
  text: $("text"),
  style: $("ctlStyle"),
  canvas: $("labCanvas"),
  run: $("labRun"),
  random: $("labRandom"),
  reset: $("labReset"),
  result: $("labResult"),
  applied: $("labApplied"),
  rot: $("ctlRot"),
  scale: $("ctlScale"),
  persp: $("ctlPersp"),
  blur: $("ctlBlur"),
  noise: $("ctlNoise"),
  scratch: $("ctlScratch"),
};
const out = {
  rot: $("valRot"),
  scale: $("valScale"),
  persp: $("valPersp"),
  blur: $("valBlur"),
  noise: $("valNoise"),
  scratch: $("valScratch"),
};

const DEFAULTS = { rot: 0, scale: 1, persp: 0, blur: 0, noise: 0, scratch: 0 };

function ctl() {
  return {
    rot: +els.rot.value,
    scale: +els.scale.value,
    persp: +els.persp.value,
    blur: +els.blur.value,
    noise: +els.noise.value,
    scratch: +els.scratch.value,
  };
}

function syncLabels() {
  const c = ctl();
  out.rot.textContent = `${c.rot}°`;
  out.scale.textContent = `${c.scale.toFixed(2)}×`;
  out.persp.textContent = c.persp.toFixed(2);
  out.blur.textContent = `${c.blur.toFixed(1)}px`;
  out.noise.textContent = `${Math.round(c.noise * 100)}%`;
  out.scratch.textContent = c.scratch;
}

// Render the current text to a base canvas via its SVG.
function renderBase(text) {
  return new Promise((resolve, reject) => {
    let symbol;
    try {
      symbol = encodeColor(text);
    } catch (e) {
      reject(e);
      return;
    }
    // Blobs are drawn by the PixiJS gradient-slice renderer; distortion + decode
    // then run on that canvas exactly like the SVG-based styles.
    if (els.style.value === "blobs" && pixiAvailable()) {
      const c = renderBlobCanvas(symbol, { supersample: 1 }); // native res → fast distort/decode
      if (c) { resolve({ canvas: c, D: c.width, symbol }); return; }
    }
    const svg = renderColorSVG(symbol, { style: els.style.value });
    const D = +svg.match(/width="(\d+)"/)[1];
    const img = new Image();
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    img.onload = () => {
      const cv = document.createElement("canvas");
      cv.width = cv.height = D;
      const ctx = cv.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, D, D);
      ctx.drawImage(img, 0, 0, D, D);
      URL.revokeObjectURL(url);
      resolve({ canvas: cv, D, symbol });
    };
    img.onerror = reject;
    img.src = url;
  });
}

// Solve 8x8 for a 4-point homography mapping `from` -> `to`.
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
  // Gaussian elimination
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

// Build the distorted canvas from the base canvas + control values.
function distort(base, D, c) {
  const work = document.createElement("canvas");
  work.width = work.height = D;
  const wctx = work.getContext("2d");
  wctx.fillStyle = "#fff";
  wctx.fillRect(0, 0, D, D);

  const baseData = base.getContext("2d").getImageData(0, 0, D, D).data;
  const cx = D / 2;
  const cy = D / 2;
  const hw = (D / 2) * c.scale;
  const hh = (D / 2) * c.scale;
  const top = 1 - c.persp; // keystone: shorten the top edge
  const ang = (c.rot * Math.PI) / 180;
  const cos = Math.cos(ang);
  const sin = Math.sin(ang);
  const place = (x, y) => [cx + (cos * x - sin * y), cy + (sin * x + cos * y)];
  const dst = [
    place(-hw * top, -hh),
    place(hw * top, -hh),
    place(hw, hh),
    place(-hw, hh),
  ];
  const src = [
    [0, 0],
    [D, 0],
    [D, D],
    [0, D],
  ];
  const H = homography(dst, src); // output -> base

  const o = wctx.createImageData(D, D);
  const od = o.data;
  for (let y = 0; y < D; y++) {
    for (let x = 0; x < D; x++) {
      const w = H[6] * x + H[7] * y + 1;
      const bx = (H[0] * x + H[1] * y + H[2]) / w;
      const by = (H[3] * x + H[4] * y + H[5]) / w;
      const di = (y * D + x) * 4;
      if (bx >= 0 && by >= 0 && bx < D - 1 && by < D - 1) {
        const xi = bx | 0;
        const yi = by | 0;
        const si = (yi * D + xi) * 4;
        od[di] = baseData[si];
        od[di + 1] = baseData[si + 1];
        od[di + 2] = baseData[si + 2];
        od[di + 3] = 255;
      } else {
        od[di] = od[di + 1] = od[di + 2] = od[di + 3] = 255;
      }
    }
  }
  wctx.putImageData(o, 0, 0);

  // Blur
  let cur = work;
  if (c.blur > 0) {
    const bcv = document.createElement("canvas");
    bcv.width = bcv.height = D;
    const bctx = bcv.getContext("2d");
    bctx.fillStyle = "#fff";
    bctx.fillRect(0, 0, D, D);
    bctx.filter = `blur(${c.blur}px)`;
    bctx.drawImage(work, 0, 0);
    cur = bcv;
  }

  // Scratches (white wedges across the symbol)
  const sctx = cur.getContext("2d");
  sctx.strokeStyle = "#fff";
  let seed = 1337;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0), seed / 0x100000000);
  for (let i = 0; i < c.scratch; i++) {
    const a = rnd() * Math.PI * 2;
    sctx.lineWidth = 4 + rnd() * 14;
    const ox = cx + (rnd() - 0.5) * D * 0.4;
    const oy = cy + (rnd() - 0.5) * D * 0.4;
    sctx.beginPath();
    sctx.moveTo(ox - Math.cos(a) * D, oy - Math.sin(a) * D);
    sctx.lineTo(ox + Math.cos(a) * D, oy + Math.sin(a) * D);
    sctx.stroke();
  }

  // Noise
  if (c.noise > 0) {
    const id = sctx.getImageData(0, 0, D, D);
    const d = id.data;
    for (let i = 0; i < d.length; i += 4) {
      if (rnd() < c.noise) {
        d[i] = rnd() * 256;
        d[i + 1] = rnd() * 256;
        d[i + 2] = rnd() * 256;
      }
    }
    sctx.putImageData(id, 0, 0);
  }
  return cur;
}

function imageDataToGrid(id) {
  const { width, height, data } = id;
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
    rgb[j] = data[i];
    rgb[j + 1] = data[i + 1];
    rgb[j + 2] = data[i + 2];
  }
  return { width, height, data: rgb };
}

async function run() {
  const text = els.text.value;
  const c = ctl();
  syncLabels();
  let base, D;
  try {
    ({ canvas: base, D } = await renderBase(text));
  } catch (e) {
    setResult("err", `Can't encode: ${e.message}`, "");
    return;
  }
  const distorted = distort(base, D, c);

  // Show it (fit into the display canvas).
  const cv = els.canvas;
  const ctx = cv.getContext("2d");
  cv.width = cv.height = D;
  ctx.clearRect(0, 0, D, D);
  ctx.drawImage(distorted, 0, 0);

  // Decode.
  const id = distorted.getContext("2d").getImageData(0, 0, D, D);
  const t0 = performance.now();
  let res = null;
  try {
    res = decodeColorRobust(imageDataToGrid(id));
  } catch {
    res = null;
  }
  const ms = Math.round(performance.now() - t0);

  const applied = [
    c.rot && `rot ${c.rot}°`,
    c.scale !== 1 && `scale ${c.scale.toFixed(2)}×`,
    c.persp && `persp ${c.persp.toFixed(2)}`,
    c.blur && `blur ${c.blur}px`,
    c.noise && `noise ${Math.round(c.noise * 100)}%`,
    c.scratch && `${c.scratch} scratch`,
  ].filter(Boolean).join(" · ") || "no distortion";

  if (res && res.text === text) {
    setResult("ok", `✓ Reconstructed in ${ms}ms — K=${res.params.K}`, applied);
  } else if (res) {
    setResult("warn", `⚠ Decoded but mismatched (corruption beyond ECC)`, applied);
  } else {
    setResult("err", `✗ Failed to decode (${ms}ms) — exceeded ECC / no rectify`, applied);
  }
}

function setResult(kind, msg, applied) {
  const colors = {
    ok: "bg-emerald-500/10 text-emerald-300 border-emerald-500/30",
    warn: "bg-amber-500/10 text-amber-300 border-amber-500/30",
    err: "bg-rose-500/10 text-rose-300 border-rose-500/30",
  };
  els.result.className = `rounded-xl border px-4 py-3 text-sm font-medium ${colors[kind]}`;
  els.result.textContent = msg;
  els.applied.textContent = applied;
}

function randomize() {
  els.rot.value = Math.round((Math.random() * 2 - 1) * 180);
  els.scale.value = (0.55 + Math.random() * 0.45).toFixed(2);
  els.persp.value = (Math.random() * 0.45).toFixed(2);
  els.blur.value = (Math.random() * 2.5).toFixed(1);
  els.noise.value = (Math.random() * 0.12).toFixed(2);
  els.scratch.value = Math.floor(Math.random() * 4);
  run();
}

function reset() {
  for (const [k, v] of Object.entries(DEFAULTS)) els[k].value = v;
  run();
}

for (const id of ["rot", "scale", "persp", "blur", "noise", "scratch"]) {
  els[id].addEventListener("input", () => {
    syncLabels();
    run();
  });
}
els.run.addEventListener("click", run);
els.random.addEventListener("click", randomize);
els.reset.addEventListener("click", reset);
els.style.addEventListener("change", run); // re-distort + re-decode on style change

syncLabels();
run();
