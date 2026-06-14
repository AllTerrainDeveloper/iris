# AGENTS.md — IRIS

> A radial, self-clocking, multiscale optical code. The successor experiment to QR.
> This file is the single source of truth for any LLM agent building this project.
> If something here is ambiguous, **pick the documented default and keep going** — do not stop to ask.

**IRIS is open source** (MIT). Everything in this repo is meant to be public: keep the
spec, code, and tests free of secrets and proprietary assumptions, write documentation for
outside contributors, and ship a `LICENSE` file (MIT) plus an open-source-friendly `README`.

-----

## 0. Mission

Build a working reference implementation of **IRIS**, a new 2D optical code that is **not** a square matrix.
Deliverables, in priority order:

1. `iris-core` — encoder, geometry, error correction (pure, deterministic, no I/O).
1. `iris-render` — turn an encoded symbol into an SVG and a raster bitmap.
1. `iris-decode` — recover the payload from a bitmap (start with clean renders, then add robustness).
1. `iris-cli` — `iris encode "<text>" -o out.svg` / `iris decode in.png`.
1. Tests — round-trip property tests + robustness tests (scratch, blur, perspective).

A successful run: random payload → encode → render → decode returns the **identical** payload, and survives a radial scratch and mild perspective warp.

-----

## 1. What IRIS is (domain background)

Every optical code must solve four problems. Keep these named in code and comments:

|Pillar                                      |QR’s answer                |IRIS’s answer                                                                  |
|--------------------------------------------|---------------------------|-------------------------------------------------------------------------------|
|**Localization** (find it)                  |3 corner eyes              |central **pupil** (bullseye)                                                   |
|**Registration** (orientation + perspective)|3 eyes + alignment patterns|fit an **ellipse** to the pupil’s outer ring; a **north** marker fixes rotation|
|**Sampling** (where is each bit)            |regular square grid        |concentric **rings** of angular **segments**, each segment **self-marked**     |
|**Error correction**                        |Reed–Solomon, linear       |Reed–Solomon **interleaved along rings**, **per-layer** independent blocks     |

IRIS’s three defining ideas — implement all three, they are not optional:

- **Self-clocking segments.** Every segment carries its own start marker. The decoder re-syncs at *every cell*, not once per ring. This is what makes IRIS strong against radial scratches. Because each segment self-marks, rings do **not** need their sectors aligned to each other.
- **Capacity grows outward.** Segments-per-ring scales with the ring’s radius (bigger diameter ⇒ more circumference ⇒ more bits). Outer rings dominate total capacity. You extend capacity by adding rings, never by changing the center.
- **The pupil is the header.** The pupil’s outer contour is invariant (it localizes & registers). Its interior is chosen from a small **codebook** and encodes the bootstrap config. The decoder **classifies** the pupil against templates; it does not bit-sample it.

-----

## 2. IRIS specification — profile `iris-m` (v1)

All sizes are in **module units `u`**; the renderer maps `u → pixels` (default `8 px`). Geometry is polar around center `C`.

### 2.1 Layout (outward from center)

```
 ┌ quiet zone (4u, blank) ┐
 │  pupil  (header)        │  radius 0 … Rp
 │  ring 0 (data, layer 0) │
 │  ring 1 (data, layer 0) │
 │  ring 2 (data, layer 1) │
 │  ring 3 (data, layer 1) │
 │  ring 4 (data, layer 2) │
 │  ring 5 (data, layer 2) │
 └ quiet zone (4u, blank) ┘
```

- Pupil radius `Rp = 6u`.
- Ring radial width `dr = 3u`. Ring `k` spans radius `[Rp + k*dr, Rp + (k+1)*dr]`.
- Default ring count `K = 6` (configurable; more rings = more capacity).
- `r_mid(k) = Rp + dr*(k + 0.5)`.

### 2.2 Pupil (header) — codebook, not bits

- **Invariant outer contour:** two concentric circles (outer stroke `2u`). This is the *only* thing localization/registration touch. Never changes.
- **Interior glyph:** one entry from a fixed codebook of ≤16 maximally-distinct templates. The selected template encodes the bootstrap word:
  - symbology **version** (4 bits),
  - **ECC level** of layer 0 (2 bits),
  - **ring schedule** id → tells the decoder `K` and segments-per-ring (3 bits),
  - **flags**: annulus/hole, charset, reserved (remaining bits).
- The decoder **classifies** the interior (template match), it does not sample cells. Keep the codebook in `iris-core/pupil-codebook.js` with a render fn + a classifier fn per entry.
- If the header needs more than the codebook can hold, spill the rest into a dedicated **header ring** (ring 0 with fixed segment count and max ECC) — flagged by the pupil.

### 2.3 Rings & segments — capacity grows outward

- Target **arc-length per segment** `s_seg = 4u` (constant). Then:
  `N_k = round( 2π * r_mid(k) / s_seg )`, snapped to the nearest even number, and clamped so `N_k >= N_{k-1}`.
- Because segments are self-clocked, **`N_k` is independent per ring** — no cross-ring alignment required. Store the actual `N_k` array in the symbol params; the ring-schedule id in the pupil selects which precomputed array to use.
- Raw data bits in ring `k` = `N_k` (1 bit/segment in v1). Total raw bits `= Σ N_k`. Note this grows ~linearly per ring and ~quadratically in total with radius — document this in code.

### 2.4 Segment anatomy (self-clocking)

Each segment occupies an angular slice of its ring, split radially-agnostic but along the arc:

```
|■■ start tick ■■|   data cell   |
|<--- 30% --->|<------ 70% ------>|
   always ink      black OR white  = 1 bit
```

- **Start tick:** leading 30% of the segment’s arc is always inked. These ticks are a regular train of marks the decoder locks onto to delineate segments locally.
- **Data cell:** trailing 70% is black (`1`) or white (`0`).
- **North marker:** the segment at angle 0 (top) of ring 0 has a tick extended inward by `+1u` — unique shape ⇒ absolute rotation origin. The pupil gives coarse orientation; north gives exact.
- (Stretch) multi-level/halftone data cells for higher density — out of scope for v1.

### 2.5 Angular convention

- Angle 0 at top (12 o’clock), increasing clockwise. Segment 0 of each ring starts at angle 0. Reading order: ring 0 → outward; within a ring, segment 0 → clockwise.

### 2.6 Error correction

- Reed–Solomon over **GF(256)** (primitive poly `0x11d`). Implement in `iris-core/rs.js`; validate against published test vectors.
- **Layers:** group rings into independently-decodable layers (default: L0 = rings 0–1, L1 = rings 2–3, L2 = rings 4–5). Each layer is its own RS block with its own parity. Inner layers carry the short/low-res payload and use **higher** parity. This gives graceful degradation: L0 still decodes when outer layers are destroyed.
- **Interleaving:** within a layer, place consecutive RS symbols in segments **spread around the ring and across the layer’s rings**, so a localized scratch damages at most one symbol per codeword.
- ECC parity ratio default 30% (selectable via pupil ECC level).

### 2.7 Rendering rules

- Pure black `#000` on pure white `#fff`. Quiet zone blank. No anti-alias assumptions in the spec (decoder must tolerate it).
- SVG is the source of truth; raster is rasterized from it at a given `u`.
- Deterministic: same input + params ⇒ byte-identical SVG.

-----

## 3. Decode pipeline (`iris-decode`)

Implement as discrete, individually testable stages:

1. **Binarize** the input (adaptive threshold; Otsu fallback).
1. **Find pupil:** detect the concentric-circle bullseye (connected components + circularity, or template match). Reject false positives by the double-ring signature.
1. **Fit ellipse** to the pupil’s outer contour ⇒ recover the perspective transform `H`. Rectify the image with `H` so the code becomes a true circle.
1. **Classify pupil** interior against the codebook ⇒ bootstrap word ⇒ version, ECC level, ring schedule (`K`, `N_k[]`), flags.
1. **Find north** tick ⇒ absolute angular origin.
1. **Walk rings** outward. For each ring: sweep the annulus at `r_mid(k)`, detect the **tick train** to delineate segments locally (this is the resync step — do NOT assume even spacing if ticks are missing; locate them). Read each data cell’s bit.
1. **De-interleave** per layer, run **RS decode** per layer. Decode inner layers first; return their payload even if outer layers fail.
1. **Assemble** payload, verify, return.

Track-1 (must work): decode clean renders produced by `iris-render`.
Track-2 (stretch): decode photographs (add denoise, illumination correction; OpenCV via a separate optional Python tool `tools/decode_cv.py` is acceptable here).

-----

## 4. Encode pipeline (`iris-core`)

1. Parse payload + options → choose version, ECC, ring schedule.
1. Build the bootstrap word → select pupil codebook entry.
1. Byte-encode payload (charset per flags); split into layers.
1. RS-encode each layer; interleave into segment bit positions per §2.6.
1. Emit a `Symbol` object: `{ params, pupilEntryId, ringBits: number[][] }`. Rendering is a separate step.

-----

## 5. Engineering plan

### Stack

- **JavaScript first.** Ship the reference implementation in plain **JavaScript** (ESM,
  Node ≥ 18) before anything else. It is the canonical, must-work target — get the full
  encode → render → decode round-trip green in JS, then (optionally) port or add typings.
  - Use JSDoc type annotations for the public API so editors and `tsc --checkJs` can
    type-check without requiring a build step. A later **TypeScript** layer (or `.d.ts`
    files) is welcome but is a follow-on, never a blocker for any milestone.
- Monorepo with **pnpm** workspaces. Test runner: **vitest**. Lint: eslint + prettier (config can be minimal).
- No network at runtime. Keep dependencies near-zero; implement RS and geometry in-repo. Rasterization may use `sharp` or `@resvg/resvg-js`; decoder image ops may use `sharp` for pixel access.

### Repo layout

```
/packages
  /iris-core      # encode, geometry, rs, params, pupil-codebook
  /iris-render    # symbol -> svg, svg -> png
  /iris-decode    # png -> symbol -> payload
  /iris-cli       # commander-based CLI
/tools
  decode_cv.py    # optional: photo-grade decode (OpenCV), Track-2 only
/test
  vectors/        # known RS vectors, golden SVGs
README.md
AGENTS.md
```

### Milestones (do them in order; each ends green)

- **M0** Scaffold monorepo, CI script `pnpm test`, empty packages compile.
- **M1** `iris-core` geometry + params: compute `N_k[]`, segment angles, pupil codebook (render + classify stubs). Unit tests on geometry math.
- **M2** `iris-core` RS + layering + interleaving. Test against known vectors; test encode is deterministic.
- **M3** `iris-render`: Symbol → SVG (matches §2 exactly) + SVG → PNG. Golden-file tests.
- **M4** `iris-decode` Track-1: decode our own clean PNGs. **Round-trip property test must pass at 100%** over 1000 random payloads.
- **M5** Robustness: synthetic scratch (occlude a radial wedge up to 30°), gaussian blur, ±20° perspective warp. Decode success-rate targets in tests (document them; aim ≥95% for 15° wedge, ≥99% for blur σ≤1.5px).
- **M6** `iris-cli` + README with examples + a generated sample gallery.
- **M7** (stretch) Track-2 photo decode; multi-level data cells.

-----

## 6. Conventions

- Geometry functions are **pure** and unit-tested in isolation. No globals; pass `params` explicitly.
- Use a typed `IrisParams` object everywhere; never hardcode `8u`, `6u` etc. outside the default-profile constant.
- Determinism is a hard requirement: no `Date.now()`, no unseeded RNG in encode/render. Tests may use a seeded RNG.
- Name things by the spec vocabulary: `pupil`, `ring`, `segment`, `tick`, `dataCell`, `north`, `layer`, `bootstrapWord`. Keep them consistent across packages.
- Every public function gets a one-line doc comment stating which spec section it implements.

-----

## 7. Open decisions → use these defaults (don’t stall)

- Charset: UTF-8 bytes. Numeric/alpha compaction modes are a stretch.
- Pupil codebook size: 16 entries. If you need fewer for v1, define 8 and reserve the rest.
- Ring schedule ids: ship 3 (small/medium/large = K of 4/6/8). Precompute their `N_k[]`.
- Quiet zone: 4u. Module unit: 8px. Parity: 30%. These live in `DEFAULT_PROFILE`.
- If a stage is too hard for Track-1 (e.g., real CV), implement the clean-render path first and leave a `// TODO Track-2` with a passing clean-path test.

-----

## 8. Definition of done

- `pnpm test` green, including the M4 round-trip property test at 100% and the M5 robustness thresholds.
- `iris-cli encode "hello iris" -o hello.svg` produces a valid symbol; `iris-cli decode hello.png` prints `hello iris`.
- README shows an encoded sample and documents the IRIS profile.

-----

## 9. Glossary

- **Pupil** — central bullseye; invariant outer contour (localize/register) + codebook interior (header).
- **Ring** — one annular band of data, width `dr`.
- **Segment** — one angular cell within a ring; carries a start **tick** + a 1-bit **data cell**.
- **Tick** — the always-inked leading mark of a segment; the self-clocking sync feature.
- **North** — the unique tick that fixes absolute rotation.
- **Layer** — a group of rings forming one independently-decodable RS block.
- **Bootstrap word** — the few bits the pupil encodes; read first, governs all parsing.
- **Ring schedule** — the chosen `K` and `N_k[]` for a symbol.
