// Interleaved RS block structure (AGENTS.md §2.6). RS over GF(256) is only
// valid for codewords ≤ 255 bytes, so large symbols (K ≥ 16) MUST split into
// blocks — before blocks.js, a K=16 symbol couldn't correct even 3 byte errors.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_BLOCK,
  PARITY_LEVELS,
  parityFor,
  blockLayout,
  encodeBlocks,
  correctBlocks,
  decodeStream,
} from "../src/blocks.js";
import { rsEncode } from "../src/rs.js";
import { writeFrame } from "../src/frame.js";
import { encodeColor, decodeColor, renderColorRaster, SCHEDULES_COLOR, COLOR_PROFILE, PALETTE } from "../src/color.js";
import { decodeColorRobust } from "../src/robust.js";
import { segCounts } from "../src/params.js";

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 0x100000000);
}

test("blockLayout: valid RS blocks at every schedule and parity level", () => {
  for (const K of SCHEDULES_COLOR) {
    const N = segCounts(K, COLOR_PROFILE);
    const cells = N.reduce((a, b) => a + b, 0) - K;
    const totalBytes = Math.floor((cells * 3) / 8);
    for (const level of PARITY_LEVELS) {
      const parity = parityFor(totalBytes, level);
      const blocks = blockLayout(totalBytes, parity);
      assert.equal(blocks.reduce((a, b) => a + b.total, 0), totalBytes);
      assert.equal(blocks.reduce((a, b) => a + b.parity, 0), parity);
      for (const b of blocks) {
        assert.ok(b.total <= MAX_BLOCK, `block of ${b.total} bytes exceeds GF(256) limit (K=${K})`);
        assert.ok(b.data >= 1 && b.parity >= 1);
      }
    }
  }
});

test("single block keeps the original wire format (small symbols unchanged)", () => {
  const msg = Uint8Array.from({ length: 100 }, (_, i) => (i * 31 + 7) & 0xff);
  const parity = 45;
  assert.deepEqual(encodeBlocks(msg, msg.length + parity, parity), rsEncode(msg, parity));
});

test("large stream corrects scattered byte errors (the pre-blocks failure case)", () => {
  const totalBytes = 408; // K=16-sized stream — a single RS codeword can't do this
  const parity = parityFor(totalBytes, 0.3);
  const dataBytes = totalBytes - parity;
  const msg = Uint8Array.from({ length: dataBytes }, (_, i) => (i * 37 + 11) & 0xff);
  const code = encodeBlocks(msg, totalBytes, parity);

  const rand = rng(42);
  const bad = Uint8Array.from(code);
  const hit = new Set();
  while (hit.size < 20) hit.add(Math.floor(rand() * totalBytes)); // way beyond 3
  for (const i of hit) bad[i] ^= 1 + Math.floor(rand() * 255);

  const fixed = correctBlocks(bad, totalBytes, parity);
  assert.ok(fixed, "block-corrected stream should recover 20 scattered errors");
  assert.deepEqual(fixed, msg);
});

test("interleaving spreads a burst so blocks share the damage", () => {
  const totalBytes = 1420; // K=32-sized stream -> 6 blocks
  const parity = parityFor(totalBytes, 0.3);
  const dataBytes = totalBytes - parity;
  const msg = Uint8Array.from({ length: dataBytes }, (_, i) => (i * 101 + 3) & 0xff);
  const code = encodeBlocks(msg, totalBytes, parity);

  // A contiguous burst of ~1/8 of the stream (a wedge scratch in byte order).
  const bad = Uint8Array.from(code);
  for (let i = 200; i < 200 + Math.floor(totalBytes / 8); i++) bad[i] ^= 0x5a;

  const fixed = correctBlocks(bad, totalBytes, parity);
  assert.ok(fixed, "interleaved blocks should absorb a 12.5% contiguous burst");
  assert.deepEqual(fixed, msg);
});

test("erasures in transmitted order route to the right blocks", () => {
  const totalBytes = 839; // K=24-sized stream -> 4 blocks
  const parity = parityFor(totalBytes, 0.3);
  const dataBytes = totalBytes - parity;
  const msg = Uint8Array.from({ length: dataBytes }, (_, i) => (i * 13 + 5) & 0xff);
  const code = encodeBlocks(msg, totalBytes, parity);

  // Zero out a burst larger than the unknown-error capacity but within
  // erasure capacity (erasures cost half the parity of unknown errors).
  const rand = rng(7);
  const bad = Uint8Array.from(code);
  const erasures = [];
  const burst = Math.floor(parity * 0.8); // > parity/2, so errors-only would fail
  for (let i = 100; i < 100 + burst; i++) {
    bad[i] = Math.floor(rand() * 256);
    erasures.push(i);
  }
  assert.equal(correctBlocks(bad, totalBytes, parity), null, "without erasure info this burst is fatal");
  const fixed = correctBlocks(bad, totalBytes, parity, erasures);
  assert.ok(fixed, "flagged as erasures the same burst should be recoverable");
  assert.deepEqual(fixed, msg);
});

test("decodeStream finds the encoder's adaptive parity level", () => {
  const totalBytes = 500;
  for (const level of PARITY_LEVELS) {
    const parity = parityFor(totalBytes, level);
    const dataBytes = totalBytes - parity;
    const text = `parity level ${level}`;
    const payload = new TextEncoder().encode(text);
    const msg = writeFrame(payload, dataBytes);
    const code = encodeBlocks(msg, totalBytes, parity);
    assert.equal(decodeStream(code, totalBytes), text);
  }
});

// ── End-to-end: a big symbol (K ≥ 16) must actually be error-tolerant ────────

test("K=16 color symbol survives heavy cell corruption end-to-end", () => {
  // ~300-byte payload forces K=16 (K=12 tops out around 170 data bytes).
  const text = "IRIS blocks e2e ".repeat(19); // 304 chars
  const sym = encodeColor(text);
  assert.ok(sym.params.K >= 16, `expected K>=16, got K=${sym.params.K}`);

  const grid = renderColorRaster(sym);
  const rand = rng(1234);
  // Paint 60 random wrong-colored squares (~cell-sized) over the data rings.
  const { width: W } = grid;
  const cx = W / 2;
  for (let s = 0; s < 60; s++) {
    const ang = rand() * 2 * Math.PI;
    const rad = (0.35 + 0.55 * rand()) * (W / 2 - COLOR_PROFILE.quiet * COLOR_PROFILE.u);
    const px = Math.round(cx + rad * Math.sin(ang));
    const py = Math.round(cx - rad * Math.cos(ang));
    const col = PALETTE[Math.floor(rand() * 8)];
    for (let oy = -4; oy <= 4; oy++)
      for (let ox = -4; ox <= 4; ox++) {
        const x = px + ox;
        const y = py + oy;
        if (x < 0 || y < 0 || x >= W || y >= W) continue;
        const o = (y * W + x) * 3;
        grid.data[o] = col[0];
        grid.data[o + 1] = col[1];
        grid.data[o + 2] = col[2];
      }
  }
  assert.equal(decodeColor(grid).text, text);
});

test("K=16 color symbol survives a scratch through the robust decoder", () => {
  const text = "IRIS robust big symbol ".repeat(14); // ~322 chars -> K>=16
  const sym = encodeColor(text);
  assert.ok(sym.params.K >= 16, `expected K>=16, got K=${sym.params.K}`);

  const grid = renderColorRaster(sym);
  const { width: W } = grid;
  // White scratch band across the disc, off-center so it misses the pupil.
  const y0 = Math.floor(W * 0.32);
  for (let y = y0; y < y0 + 6; y++)
    for (let x = Math.floor(W * 0.1); x < Math.floor(W * 0.9); x++) {
      const o = (y * W + x) * 3;
      grid.data[o] = grid.data[o + 1] = grid.data[o + 2] = 255;
    }
  assert.equal(decodeColorRobust(grid, { budgetMs: 20000 }).text, text);
});
