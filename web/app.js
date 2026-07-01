// IRIS web generator — imports the same zero-dependency core as the CLI.
// Browser-safe modules only (no Node APIs). Uses the v2 color profile by
// default for high capacity (3 bits/cell).
import { encodeColor, renderColorSVG } from "../src/color.js";
import { renderWheelGrid } from "../src/wheel-render.js";
import { renderBlobCanvas, pixiAvailable } from "../src/pixi-render.js";

const $ = (id) => document.getElementById(id);
const els = {
  text: $("text"),
  style: $("ctlStyle"),
  markers: $("ctlMarkers"),
  charCount: $("charCount"),
  capacity: $("capacity"),
  preview: $("preview"),
  error: $("error"),
  statRings: $("statRings"),
  statSegments: $("statSegments"),
  statData: $("statData"),
  statParity: $("statParity"),
  downloadSvg: $("downloadSvg"),
  downloadPng: $("downloadPng"),
  copySvg: $("copySvg"),
};

let current = null; // { svg, symbol, canvas }
let renderToken = 0; // guards async blob renders against fast re-renders

// Paint an RGB grid ({width,height,data}) onto a fresh canvas via ImageData.
function gridToCanvas(grid) {
  const canvas = document.createElement("canvas");
  canvas.width = grid.width;
  canvas.height = grid.height;
  const img = canvas.getContext("2d").createImageData(grid.width, grid.height);
  const d = img.data;
  for (let i = 0, j = 0; i < grid.data.length; i += 3, j += 4) {
    d[j] = grid.data[i];
    d[j + 1] = grid.data[i + 1];
    d[j + 2] = grid.data[i + 2];
    d[j + 3] = 255;
  }
  canvas.getContext("2d").putImageData(img, 0, 0);
  return canvas;
}

function safeFilename(text) {
  const base = text.trim().slice(0, 24).replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "");
  return (base || "iris").toLowerCase();
}

function setButtons(enabled) {
  for (const b of [els.downloadSvg, els.downloadPng, els.copySvg]) b.disabled = !enabled;
}

function showError(msg) {
  els.error.textContent = msg;
  els.error.classList.remove("hidden");
  els.preview.innerHTML = "";
  els.statRings.textContent = "—";
  els.statSegments.textContent = "—";
  els.statData.textContent = "—";
  els.statParity.textContent = "—";
  setButtons(false);
  current = null;
}

function render() {
  const text = els.text.value;
  els.charCount.textContent = `${[...text].length} chars`;

  if (!text) {
    showError("Type something to generate a code.");
    return;
  }

  let symbol;
  try {
    symbol = encodeColor(text, { markers: !!(els.markers && els.markers.checked) });
  } catch (err) {
    showError(err.message);
    return;
  }

  els.error.classList.add("hidden");
  const style = els.style.value;
  // SVG is the vector source of truth; the "wheel" is a per-pixel raster, so its
  // vector/SVG export falls back to the crisp slices arcs.
  const svg = renderColorSVG(symbol, { style: style === "wheel" ? "slices" : style });
  current = { svg, symbol, canvas: null };

  if (style === "wheel") {
    const canvas = gridToCanvas(renderWheelGrid(symbol, { blend: 0.6 }));
    canvas.classList.add("h-full", "w-full");
    canvas.style.objectFit = "contain";
    els.preview.replaceChildren(canvas);
    current.canvas = canvas;
  } else {
    els.preview.innerHTML = svg;
    const svgEl = els.preview.querySelector("svg");
    if (svgEl) {
      svgEl.removeAttribute("width");
      svgEl.removeAttribute("height");
      svgEl.classList.add("h-full", "w-full");
    }
    // "blobs" is the PixiJS WebGL metaball renderer (async in v8); swap the canvas
    // in when it's ready, guarding against races from fast typing.
    if (style === "blobs" && pixiAvailable()) {
      const token = ++renderToken;
      renderBlobCanvas(symbol).then((canvas) => {
        if (!canvas || token !== renderToken || els.style.value !== "blobs") return;
        canvas.classList.add("h-full", "w-full");
        canvas.style.objectFit = "contain";
        els.preview.replaceChildren(canvas);
        current.canvas = canvas;
      }).catch(() => {});
    }
  }

  const { K, N } = symbol.params;
  const segments = N.reduce((a, b) => a + b, 0);
  const used = new TextEncoder().encode(text).length;
  els.statRings.textContent = K;
  els.statSegments.textContent = segments;
  els.statData.textContent = symbol.meta.capacityBytes + " B";
  els.statParity.textContent = symbol.meta.parity + " B";
  els.capacity.textContent = `${used} / ${symbol.meta.capacityBytes} bytes used`;
  setButtons(true);
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

els.downloadSvg.addEventListener("click", () => {
  if (!current) return;
  download(new Blob([current.svg], { type: "image/svg+xml" }), `${safeFilename(els.text.value)}.svg`);
});

els.downloadPng.addEventListener("click", () => {
  if (!current) return;
  // Blobs are GPU-rendered to a canvas — export it directly.
  if (current.canvas) {
    current.canvas.toBlob((blob) => download(blob, `${safeFilename(els.text.value)}.png`), "image/png");
    return;
  }
  const scale = 2; // crisp export
  const svgBlob = new Blob([current.svg], { type: "image/svg+xml" });
  const url = URL.createObjectURL(svgBlob);
  const img = new Image();
  img.onload = () => {
    const canvas = document.createElement("canvas");
    canvas.width = img.width * scale;
    canvas.height = img.height * scale;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    URL.revokeObjectURL(url);
    canvas.toBlob((blob) => download(blob, `${safeFilename(els.text.value)}.png`), "image/png");
  };
  img.src = url;
});

els.copySvg.addEventListener("click", async () => {
  if (!current) return;
  try {
    await navigator.clipboard.writeText(current.svg);
    const original = els.copySvg.textContent;
    els.copySvg.textContent = "Copied!";
    setTimeout(() => (els.copySvg.textContent = original), 1200);
  } catch {
    showError("Clipboard not available in this browser.");
  }
});

els.text.addEventListener("input", render);
els.style.addEventListener("change", render);
if (els.markers) els.markers.addEventListener("change", render);
render();
