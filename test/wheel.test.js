// The "colour wheel" render blends cell colours at their seams but keeps cell
// centres pure, so it must still decode — clean and robust.

import { test } from "node:test";
import assert from "node:assert/strict";

import { encodeColor, decodeColor } from "../src/color.js";
import { decodeColorRobust } from "../src/robust.js";
import { renderWheelGrid } from "../src/wheel-render.js";
import { decodeColorMarkers } from "../src/markers.js";

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

test("wheel render honors { markers: true } and stays marker-decodable", () => {
  const text = "wheel + markers";
  const sym = encodeColor(text, { markers: true });
  const grid = renderWheelGrid(sym, { scale: 1 });

  // The three pure-RGB dots must be present OUTSIDE the black frame ring
  // (rho 0.9 of the full radius — in the quiet zone, like every other style).
  const { width: W, data } = grid;
  const c = W / 2;
  const found = [0, 0, 0]; // pure red / green / blue pixel counts in the quiet zone
  const p = sym.params;
  const frameR = ((p.Rp + p.K * p.dr) / (p.Rp + p.K * p.dr + p.quiet)) * (W / 2);
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      if (Math.hypot(x - c, y - c) <= frameR) continue;
      const o = (y * W + x) * 3;
      const [r, g, b] = [data[o], data[o + 1], data[o + 2]];
      if (r > 200 && g < 60 && b < 60) found[0]++;
      if (g > 200 && r < 60 && b < 60) found[1]++;
      if (b > 200 && r < 60 && g < 60) found[2]++;
    }
  }
  for (let i = 0; i < 3; i++) assert.ok(found[i] > 20, `marker ${i} missing from wheel quiet zone`);

  // And the marker decoder reads the wheel render like any other raster.
  const viaMarkers = decodeColorMarkers(grid);
  assert.ok(viaMarkers, "decodeColorMarkers returned null on a wheel render");
  assert.equal(viaMarkers.text, text);
  // Plain decoders are unaffected by the dots (quiet zone carries no data).
  assert.equal(decodeColor(grid).text, text);
});
