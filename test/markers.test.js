// RGB calibration markers: 3 coloured dots in the outer quiet zone (opt-in
// `{ markers: true }`). They cost ZERO capacity (the quiet zone carries no data) and a
// standard decoder still reads the payload — the markers only ADD a robust homography
// path + colour references. These tests pin: zero capacity cost, backward-compat, the
// geometry-driven homography decoder, and end-to-end decode via real RGB detection.
import test from "node:test";
import assert from "node:assert/strict";
import { encodeColor, renderColorRaster, decodeColor } from "../src/color.js";
import { MARKERS, markerFrontal } from "../src/params.js";
import { decodeViaHomography, decodeColorMarkers, fitHomography } from "../src/markers.js";

const identityH = (D) => [D / 2, 0, D / 2, 0, D / 2, D / 2, 0, 0, 1];

test("markers cost ZERO capacity and don't change the payload packing", () => {
  const text = "a longer payload that fills more of the symbol area here";
  const plain = encodeColor(text);
  const marked = encodeColor(text, { markers: true });
  assert.equal(plain.params.K, marked.params.K, "same schedule");
  assert.equal(plain.meta.dataCells, marked.meta.dataCells, "no cells reserved");
  assert.equal(plain.meta.capacityBytes, marked.meta.capacityBytes, "same capacity");
});

test("a standard decoder still reads a marker code (markers are outside the data)", () => {
  const text = "hello iris";
  const sym = encodeColor(text, { markers: true });
  assert.equal(decodeColor(renderColorRaster(sym)).text, text);
});

test("markers round-trip via the homography decoder across K", () => {
  for (const text of ["iris", "payload radial code v2 color",
    "https://iris.dev scan me reed-solomon the quick brown fox"]) {
    const sym = encodeColor(text, { markers: true });
    const grid = renderColorRaster(sym);
    const r = decodeViaHomography(grid, identityH(grid.width));
    assert.equal(r && r.text, text, `K=${sym.params.K}`);
  }
});

test("markers sit in the quiet zone, outside the data disc", () => {
  // rho is the fraction of the FULL disc radius; the data edge is Rp+K*dr < radiusU,
  // so a marker rho beyond the data-edge fraction means it's in the quiet zone.
  const { Rp, dr, quiet } = encodeColor("x", { markers: true }).params;
  for (const K of [4, 8, 12]) {
    const dataFrac = (Rp + K * dr) / (Rp + K * dr + quiet);
    for (const m of MARKERS) assert.ok(m.rho > dataFrac, `marker rho ${m.rho} inside data at K=${K}`);
  }
});

test("clean render decodes through the real RGB marker detector across K", () => {
  for (const text of ["iris", "payload radial code v2 color",
    "https://iris.dev scan me reed-solomon the quick brown fox"]) {
    const grid = renderColorRaster(encodeColor(text, { markers: true }));
    assert.equal(decodeColorMarkers(grid)?.text, text, `K decode`);
  }
});

test("supplied marker geometry decodes via the homography (the production path)", () => {
  const text = "payload radial code v2 color";
  const grid = renderColorRaster(encodeColor(text, { markers: true }));
  const D = grid.width, maskR = D / 2, cx = D / 2, cy = D / 2;
  const pupil = [cx, cy];
  const markerPts = MARKERS.map((m) => { const [u, v] = markerFrontal(m); return [cx + u * maskR, cy + v * maskR]; });
  assert.equal(decodeColorMarkers(grid, { pupil, markerPts })?.text, text);
  const H = fitHomography([{ f: [0, 0], i: pupil }, ...MARKERS.map((m, j) => ({ f: markerFrontal(m), i: markerPts[j] }))]);
  assert.equal(H.length, 9);
});
