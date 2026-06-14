// Round-trip + robustness tests (AGENTS.md §5 M4/M5). Uses the built-in
// node:test runner — no framework, no dependencies.

import { test } from "node:test";
import assert from "node:assert/strict";

import { encode, decode } from "../src/index.js";
import { rsEncode, rsCorrect } from "../src/rs.js";
import { gridToPGM, pgmToGrid } from "../src/raster.js";

// Deterministic LCG so the property test is reproducible (AGENTS.md §6).
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function randomString(rand) {
  const len = Math.floor(rand() * 16); // fits the smallest schedules
  let out = "";
  for (let i = 0; i < len; i++) out += String.fromCharCode(32 + Math.floor(rand() * 95));
  return out;
}

test("RS encode/decode corrects errors", () => {
  const msg = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const code = rsEncode(msg, 6); // can fix up to 3 byte errors
  code[2] ^= 0xff;
  code[9] ^= 0x42;
  code[13] ^= 0x01;
  const fixed = rsCorrect(code, 6);
  assert.ok(fixed, "should correct 3 errors");
  assert.deepEqual(fixed.slice(0, msg.length), msg);
});

test("round-trip: 1000 random payloads (AGENTS.md M4)", () => {
  const rand = rng(0xc0ffee);
  for (let i = 0; i < 1000; i++) {
    const text = randomString(rand);
    const { grid } = encode(text);
    assert.equal(decode(grid).text, text, `failed for ${JSON.stringify(text)}`);
  }
});

test("mono round-trip through PGM serialization", () => {
  const text = "hello iris";
  const { grid } = encode(text, { mono: true });
  const restored = pgmToGrid(gridToPGM(grid));
  assert.equal(decode(restored).text, text);
});

test("unicode payloads survive", () => {
  for (const text of ["café", "ñandú", "日本語", "🌀 iris"]) {
    const { grid } = encode(text);
    assert.equal(decode(grid).text, text);
  }
});

test("robustness: a radial scratch is corrected by ECC (AGENTS.md M5)", () => {
  const text = "scratch me";
  const { grid } = encode(text);
  // Occlude a thin radial wedge (paint a white spoke through the symbol).
  const c = grid.width / 2;
  for (let r = 0; r < grid.width / 2; r++) {
    for (let w = -2; w <= 2; w++) {
      const x = Math.round(c + w);
      const y = Math.round(c - r);
      if (x >= 0 && y >= 0 && x < grid.width && y < grid.height) {
        grid.data[y * grid.width + x] = 255;
      }
    }
  }
  assert.equal(decode(grid).text, text);
});
