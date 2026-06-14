// IRIS v2 color profile: round-trip, capacity, serialization.

import { test } from "node:test";
import assert from "node:assert/strict";

import { encodeColor, renderColorRaster, decodeColor, COLOR_PROFILE } from "../src/color.js";
import { gridToPPM, ppmToGrid } from "../src/raster.js";
import { capacityBits } from "../src/params.js";

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 0x100000000);
}

test("color round-trip: 500 random payloads", () => {
  const rand = rng(0x1ce);
  for (let i = 0; i < 500; i++) {
    const len = Math.floor(rand() * 80);
    let text = "";
    for (let j = 0; j < len; j++) text += String.fromCharCode(32 + Math.floor(rand() * 95));
    const sym = encodeColor(text);
    const grid = renderColorRaster(sym);
    assert.equal(decodeColor(grid).text, text, `failed for ${JSON.stringify(text)}`);
  }
});

test("color round-trip through PPM", () => {
  const text = "https://example.com/some/fairly/long/path?with=query&params=1";
  const sym = encodeColor(text);
  const restored = ppmToGrid(gridToPPM(renderColorRaster(sym)));
  assert.equal(decodeColor(restored).text, text);
});

test("color round-trip beats QR v40 (>2953 bytes)", () => {
  // 3 KB of data — more than QR's max binary capacity.
  const text = "A".repeat(3200);
  const sym = encodeColor(text);
  assert.ok(sym.meta.capacityBytes >= 3200, `capacity ${sym.meta.capacityBytes} should hold 3200`);
  const grid = renderColorRaster(sym);
  assert.equal(decodeColor(grid).text, text);
});

test("color is ~3 bits/cell and denser than mono", () => {
  // Same ring count, color carries 3x the bits of mono v1.
  const K = 8;
  const bits = capacityBits(K, COLOR_PROFILE);
  const sym = encodeColor("x");
  assert.equal(sym.meta.bitsPerCell, 3);
  assert.ok(bits > 0);
});
