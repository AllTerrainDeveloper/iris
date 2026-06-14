// Reed–Solomon: errors, erasures, and mixed (foundation for scratch recovery).
import { test } from "node:test";
import assert from "node:assert/strict";
import { rsEncode, rsCorrect } from "../src/rs.js";

const MSG = Uint8Array.from(Array.from({ length: 20 }, (_, i) => (i * 37 + 11) & 0xff));

test("errors only: corrects up to nsym/2", () => {
  const nsym = 10; // corrects 5 errors
  const code = rsEncode(MSG, nsym);
  [1, 5, 9, 20, 28].forEach((p) => (code[p] ^= 0xa5));
  const fixed = rsCorrect(code, nsym);
  assert.ok(fixed);
  assert.deepEqual([...fixed.slice(0, MSG.length)], [...MSG]);
});

test("erasures only: corrects up to nsym", () => {
  const nsym = 10; // corrects 10 erasures
  const code = rsEncode(MSG, nsym);
  const erase = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18];
  erase.forEach((p) => (code[p] = 0x00)); // wiped
  const fixed = rsCorrect(code, nsym, erase);
  assert.ok(fixed, "should recover 10 erasures");
  assert.deepEqual([...fixed.slice(0, MSG.length)], [...MSG]);
});

test("mixed: 2*errors + erasures <= nsym", () => {
  const nsym = 12; // e.g. 6 erasures + 3 errors = 12
  const code = rsEncode(MSG, nsym);
  const erase = [3, 7, 11, 15, 19, 23];
  erase.forEach((p) => (code[p] = 0x00));
  [1, 13, 25].forEach((p) => (code[p] ^= 0x5c)); // unknown errors
  const fixed = rsCorrect(code, nsym, erase);
  assert.ok(fixed, "should recover 6 erasures + 3 errors");
  assert.deepEqual([...fixed.slice(0, MSG.length)], [...MSG]);
});

test("erasures double the reach vs errors", () => {
  const nsym = 8; // errors: max 4; erasures: max 8
  const code = rsEncode(MSG, nsym);
  const pos = [0, 3, 6, 9, 12, 15]; // 6 damaged
  pos.forEach((p) => (code[p] ^= 0xff));
  assert.equal(rsCorrect(code, nsym), null, "6 unknown errors exceed nsym/2");
  assert.ok(rsCorrect(code, nsym, pos), "6 erasures are within nsym");
});
