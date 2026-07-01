# `tools/` — synthetic data for an IRIS **localizer**

A model whose *only* job is to **find the code** — the black bullseye "O" + the
registration ray "I" — and hand the decoder a warm start. This is **stage 1** of a
two-stage pipeline; the existing `src/robust.js` is stage 2.

```
                  ┌─ Stage 1: MODEL (learned) ───────────┐   ┌─ Stage 2: DECODER (src/robust.js) ────┐
  photo  ──────▶  │ • locate the symbol in clutter       │   │ • refine perspective from core-offset │ ──▶ bytes
                  │ • seed geometry (pupil ellipse + ray) │──▶│ • calibrate color from known palette  │
                  │ • seed color transform (coarse WB)    │   │ • sample cells → Reed–Solomon + CRC   │
                  └──────────────────────────────────────┘   └───────────────────────────────────────┘
                       perception (fuzzy, robust)                  measurement + math (exact)
```

Why this split: `src/robust.js` localizes by *"everything non‑white is the symbol"*
(see `locate()`), so today it needs a roughly‑centered code on a white field. The
model adds the missing step — **find a code anywhere, on any background, under tilt
and bad light** — then the proven decoder does the exact part. Keeping the bytes in
Reed–Solomon (not a learned decoder) preserves the hard correct/incorrect verdict.

## The point: free, *exact* labels

We reuse the real encoder and distort with a **known** warp, so every label is
**computed, never hand‑annotated** — perfect supervision, infinite quantity:

- the pupil center/ray come from pushing known base points through the warp;
- the **pupil ellipse** (the perspective seed) is the base circle's conic transformed
  *exactly* (`warpConic` → `conicToEllipse`), not a point fit;
- the **color transform** and the resulting **observed palette** are exactly what the
  illuminant did — directly the white‑balance/calibration target.

## Generate

```sh
node tools/gen-dataset.js --count 2000 --out data/iris --size 512 --seed 1
node tools/gen-dataset.js --count 100  --verify           # re-decode each (envelope check)
npm run gen -- --count 500 --out data/train               # via package.json script
```

Flags: `--count N`, `--out DIR`, `--size PX` (square frame), `--seed S` (reproducible),
`--verify` (re-decode each capture in the decoder's own centered/white framing and
report the survival rate — proves the captures stay inside `robust.js`'s envelope;
the illuminant shift is excluded because color calibration is the part `robust.js`
doesn't handle yet).

Output in `--out/`:

| file | contents |
| --- | --- |
| `images/000000.ppm …` | P6 RGB captures (read directly by Pillow / OpenCV / ImageMagick) |
| `labels.jsonl` | one JSON object per image (schema below) |
| `dataset.json` | manifest: count, size, seed, label fields |

> PPM (P6) keeps the library zero‑dependency. Convert if your trainer prefers PNG:
> `magick images/000000.ppm out.png`, or `Image.open(p)` in Pillow reads PPM as‑is.

## Label schema (per image)

```jsonc
{
  "id": "000000", "file": "images/000000.ppm", "width": 512, "height": 512,
  "text": "iris payload beta", "K": 4,            // payload + ring count (size class)
  "bbox":    [x, y, w, h],                          // TIGHT box of the visible disc — detection
  "center":  [x, y],                               // pupil/disc center — localization target
  "radius":  102.3,                                // disc radius (px) — scale seed
  "pupil_radius": 33.1,                            // inner pupil radius (px) — robust.js core seed
  "ray_deg": 335.8,                                // registration-ray angle — rotation seed
  "ray_tip": [x, y],                               // outer end of the spoke — keypoint for rotation
  "ellipse": { "cx","cy","a","b","phi_deg" },      // imaged DISC ellipse — perspective + scale
  "quad":    [[x,y],[x,y],[x,y],[x,y]],            // 4 disc-boundary points — homography seed
  "color":   { "gain":[3], "offset":[3], "gamma":[3] },  // illuminant applied
  "palette_observed": [[r,g,b] × 8],               // the 8 palette colors AS CAPTURED — calibration target
  "distort": { "rot_deg","scale","persp","blur","noise","scratches" },
  "decoded": true                                  // only with --verify
}
```

Pick the targets your model needs: a **bbox/center** for a YOLO‑nano MVP; add
**ellipse + ray** to recover scale/rotation/tilt; use **quad** if you'd rather regress
a homography and rectify to a frontal crop; use **color/palette_observed** to train a
coarse white‑balance head. All of them feed `decodeColorRobust` as a warm start.

## Test harness (browser) — see the detector run

`web/detect.html` is a live harness that runs the **full two-stage pipeline**: it shows
random captures (procedural scenes **or your own photos**) with the code pasted at any
size/rotation/perspective/blur/noise, **localizes** it with the detector, then uses that
geometry to crop the disc and **actually decode the payload** with `src/robust.js`. A
**Distortion** slider scales every nuisance factor (0 % = clean → 100 % = full envelope)
on the same code, so you can watch decoding hold up and degrade. It **paints the
prediction** (center, disc ellipse, ray, bbox, quad) over the image against the exact
ground truth, with a px/deg error
readout.

```sh
# serve the repo ROOT so the page can import /src and /tools (no build step)
python3 -m http.server 8765
# → http://localhost:8765/web/detect.html
```

Two detectors, switchable live:

- **Oracle** — returns the known label, optionally jittered (slider), so the whole
  harness works **before any model exists**. Use it to sanity-check the overlay and
  preview how a noisy model would look.
- **ONNX** — a **bundled baseline** (`web/models/iris-detector.onnx`) **auto-loads**
  on startup, so ONNX mode works out of the box; or drop in your own. The pre/post
  **contract** (input tensor + output head) is documented at the top of `web/detect.js`.

It uses the *same* `tools/scene.js` the trainer uses, so what you see is exactly the
model's input distribution. The **Capture envelope** selector defaults to **Realistic**
(the detector's actual job) — switch to **Torture** to stress it on the decoder's
scratch/heavy-blur envelope (where a thin scratched-out spoke is the irreducible hard
case). Drag photos onto the drop zone to paste the code into real backgrounds.

## Predefined model — `tools/train_detector.py`

The bundled `web/models/iris-detector.onnx` is a small **CNN** produced by a
**torch-free** trainer (numpy + [autograd](https://github.com/HIPS/autograd) + onnx),
so it builds anywhere. Reproduce it:

```sh
python3 -m venv .venv && . .venv/bin/activate && pip install numpy autograd onnx onnxruntime
node tools/gen-dataset.js --count 5000 --out /tmp/iris-train --size 192 --seed 21 --realistic   # multiple of 96
python tools/train_detector.py --data /tmp/iris-train --out web/models/iris-detector.onnx --epochs 45
```

> **`--realistic` matters a lot.** `randomScene` (no flag) is the *decoder's torture
> envelope* — scratches slash through ~75 % of codes, heavy blur. Train a *localizer* on
> that and it learns noisy geometry from half-destroyed fiducials. The detector's job is to
> find INTACT codes under real capture conditions (perspective, rotation, lighting, mild
> blur), so it trains on `--realistic`. This single change cut the keypoint error from
> ~6 px to ~2.3 px and lifted rotation from ~83 % to ~94 % within 15°.

**Architecture — a soft-argmax keypoint + a SEGMENTATION head** (96×96 input, conv backbone
→ 24×24):

- **pupil center** — a soft-argmax keypoint (the bullseye is a distinctive point) → the
  radial origin for rotation.
- **disc extent** — *semantic segmentation*: a per-pixel "is this the disc" mask. The disc
  ellipse is recovered from the mask by weighted moments.

> **Why segmentation, not regression.** An earlier version REGRESSED the ellipse (a, b, φ)
> through a global-pool FC head — and a regression head provably collapses toward the dataset
> mean: it over-sized small codes ~1.2× and under-sized large ones ~0.95×, so the decode crop
> was framed wrong and decoding failed at the size extremes. Segmentation is the right
> *formulation*: a conv net learns the disc by its radial-ring structure (vs a colourful
> background) and a mask captures exact size + eccentricity with no regress-to-mean. This cut
> the **disc major-axis error from ~25 % to ~0.5 %** and lifted end-to-end decode from ~50 %
> to **~87 %** on realistic captures (within ~4 pts of the perfect-geometry ceiling, ~91 %).

Output head (`2 + HF*HF`): `[cx/W, cy/W, disc_mask(24×24, sigmoid)]`, exported as
`Conv·Relu·MaxPool ×2 → {1×1 Conv→Softmax→MatMul coord grids}  +  {1×1 Conv→Sigmoid}`, with
input standardization folded into the first conv (the graph takes raw `[0,1]` pixels).

**Rotation isn't predicted by the net** — a deterministic polar scan finds it
([`web/ray-refine.js`](../web/ray-refine.js)): shoot radial lines **from the pupil center**
(radial lines through the symbol's center stay radial through the *imaged* center even under
perspective), bounded by the disc ellipse, and the spoke is *the image-angle whose data-ring
radius is most fully BLACK* (max(R,G,B) low; luminance would be fooled by the saturated
red/blue cells). A plain **argmax** nails it — the Fourier–Mellin idea `src/robust.js` uses.

Held-out accuracy on realistic captures (onnxruntime): **pupil center ≈ 2 px**, **disc
major-axis ≈ 0.5 %**, **rotation ≈ 94 % within 15°**, and **end-to-end decode ≈ 87 %** (the
two-stage pipeline: detect → crop → real RS decoder). The residual tail is the *decoder's*
own limit (steep perspective, heavy blur, long low-ECC payloads), not the detector.

**Upgrade path:** same `labels.jsonl` schema and ONNX I/O contract — scale the net up (more
channels/epochs/data, or a PyTorch backbone) and the harness picks it up unchanged. Mix in
real photos to close the sim-to-real gap. Run the *same* `.onnx` via `onnxruntime-web`
(browser/Node) or `onnxruntime` (Python).

## Files

| file | role |
| --- | --- |
| `distort.js` | zero‑dep primitives: homography, conic→ellipse, warp/composite, blur, scratches, noise, color transform, backgrounds, seeded PRNG |
| `scene.js` | **browser‑safe** scene synthesis + exact labelling (`renderScene`/`randomScene`); shared by the Node generator and the web harness |
| `gen-dataset.js` | Node CLI around `scene.js`: random payloads → PPM + `labels.jsonl`, plus `--verify` |
| `train_detector.py` | torch-free CNN trainer (numpy + autograd + onnx) → `web/models/iris-detector.onnx` |
| `../web/detect.html` · `detect.js` | the browser test harness (oracle / ONNX), painting predictions vs. ground truth |
| `../web/ray-refine.js` | deterministic polar rotation finder (hybrid detector's sharp ray) |
| `../web/models/iris-detector.onnx` | the bundled CNN the harness auto-loads |
| `../test/gen-dataset.test.js` | pins the geometry labels and a distorted round‑trip through `src/robust.js` |
