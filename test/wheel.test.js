// The "colour wheel" render blends cell colours at their seams but keeps cell
// centres pure, so it must still decode — clean and robust.

import { test } from "node:test";
import assert from "node:assert/strict";

import { encodeColor, decodeColor } from "../src/color.js";
import { decodeColorRobust } from "../src/robust.js";
import { renderWheelGrid } from "../src/wheel-render.js";

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 0x100000000);
}

test("wheel render round-trips (clean + robust) across blend widths", () => {
  const rand = rng(0x1e15);
  for (let i = 0; i < 60; i++) {
    const len = 1 + Math.floor(rand() * 60);
    let text = "";
    for (let j = 0; j < len; j++) text += String.fromCharCode(32 + Math.floor(rand() * 95));
    const blend = rand(); // 0..1
    const grid = renderWheelGrid(encodeColor(text), { blend, scale: 1 });
    assert.equal(decodeColor(grid).text, text, `clean failed: blend=${blend} ${JSON.stringify(text)}`);
    assert.equal(decodeColorRobust(grid).text, text, `robust failed: blend=${blend} ${JSON.stringify(text)}`);
  }
});

test("wheel grid is the expected shape and white-padded", () => {
  const grid = renderWheelGrid(encodeColor("iris"), { scale: 1 });
  assert.equal(grid.data.length, grid.width * grid.height * 3);
  // corners are quiet zone -> pure white
  assert.deepEqual([grid.data[0], grid.data[1], grid.data[2]], [255, 255, 255]);
});
