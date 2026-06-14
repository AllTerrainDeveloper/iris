# IRIS
<img width="390" height="168" alt="image" src="https://github.com/user-attachments/assets/79e380c6-9289-40ef-9b4c-f282e7b60154" />


> A radial, self-clocking, multiscale optical code — the successor experiment to QR.

> 🧪 **Beta.** IRIS is an active experiment under heavy development. The symbol format and
> the library API may still change between versions — don't depend on it for anything
> permanent yet. **More language implementations and further decoder improvements are on
> the way** — see the [Roadmap](#roadmap). Feedback and issues are very welcome.

**IRIS** is **not** a square matrix. It localizes on a central **pupil** (bullseye),
samples data on concentric **rings** of self-clocked **segments**, and protects the
payload with **Reed–Solomon** error correction. Capacity grows outward: add rings, never
change the center. See [`AGENTS.md`](./AGENTS.md) for the full specification.

This is an **open-source (MIT)**, **zero-dependency**, plain-JavaScript reference
implementation. No framework, no build step — just the utility to **write** and **read**
IRIS codes.

Two profiles:

- **v2 color (default)** — dense cells, **8-color palette = 3 bits/cell** (JAB-Code-style),
  no per-cell clock tax. Capacity grows outward and **beats QR v40** (>2,953 bytes).
- **v1 mono (`--mono`)** — black & white, **self-clocking** ticks per cell. Lower capacity
  but maximally robust to radial scratches; printer/fax-safe.

## Robustness Lab

The decoder doesn't just read clean renders — it recovers the payload through brutal,
**combined** distortion: arbitrary rotation, scale, perspective tilt, blur, salt-and-pepper
noise and scratches, all at once. These are real screenshots from the in-browser
[Robustness Lab](#website) (`web/`), each fully decoded in well under
a fifth of a second:

| Perspective + odd rotation | Perspective + blur + 11% noise |
| :---: | :---: |
| ![Perspective 0.30 + −44° rotation, decoded](docs/img/perspective-rotation.png) | ![Perspective 0.20 + 2.2px blur + 11% noise, decoded](docs/img/blur-noise-perspective.png) |
| `persp 0.30 · rot −44°` → ✓ ~90 ms | `scale 0.98× · persp 0.20 · blur 2.2px · noise 11%` → ✓ ~65 ms |

| Rotation + 4 scratches | Everything at once |
| :---: | :---: |
| ![130° rotation + 4 scratches, decoded](docs/img/scratches-rotation.png) | ![Rotation, scale, perspective, blur, noise and scratches combined, decoded](docs/img/everything.png) |
| `rot 130° · 4 scratches` → ✓ ~40 ms | `rot −84° · scale 0.85× · persp 0.25 · blur 1.4px · noise 8% · 2 scratches` → ✓ ~34 ms |

> Drag the sliders yourself — open `web/index.html` (see [below](#website)).

## Install / run

Requires Node ≥ 18. No `npm install` needed (no dependencies).

```sh
# Color (default): vector + decodable raster
node bin/iris.js encode "hello iris" -o hello.svg
node bin/iris.js encode "hello iris" -o hello.ppm
node bin/iris.js decode hello.ppm        # -> hello iris

# Mono (black & white, self-clocking)
node bin/iris.js encode "hello iris" -o hello.pgm --mono
node bin/iris.js decode hello.pgm        # -> hello iris
```

### Capacity

Capacity grows outward — the encoder adds rings (`K`) until the payload fits, so small
inputs stay small. ECC is **adaptive**: a small payload leaves spare room in the symbol,
which is spent on extra Reed–Solomon parity (up to ~70%), so short codes are far more
scratch-resilient; large payloads fall back to 30% parity to preserve capacity.

| Payload      | Rings (K) | Cells  | Parity | ~Capacity |
| ------------ | --------- | ------ | ------ | --------- |
| short text   | 4         | ~124   | ~70%   | small, max ECC |
| paragraph    | 12        | ~678   | 30–50% | ~120–170 B |
| 3 KB blob    | 64        | ~14076 | 30%    | ~3,690 B  |

The 3 KB case clears **QR v40's 2,953-byte** ceiling. See the
[capacity research notes](#capacity--research) below for how this was derived.

## Website

A simple generator lives in [`web/`](./web) — type text, get a code, download SVG/PNG.
It imports the **same** `src/` modules directly (browser-native ES modules, Tailwind via
CDN), so there is **no build step**.

It also includes a **Robustness Lab**: distort the generated code (rotation, scale,
perspective, blur, noise, scratches — or hit **🎲 Randomize**) and watch the robust
decoder recover the center, scale and rotation, then rebuild the payload via Reed–Solomon.
A live ✓/✗ badge shows whether reconstruction succeeded and how long it took.

```sh
# serve the repository ROOT (so /web can reach /src), then open /web/
python3 -m http.server 8765
# -> http://localhost:8765/web/
```

To host it, deploy the **repository root** as the site and point users at `/web/`
(GitHub Pages, Netlify, Vercel, Cloudflare Pages all work — set the publish directory to
the repo root, not `web/`, because the page imports `../src`).

## Library API

```js
import { encode, decode } from "./src/index.js";

const { svg, grid, symbol } = encode("hello iris");
// svg    -> SVG string
// grid   -> { width, height, data: Uint8Array }  (0 = ink, 255 = blank)
// symbol -> { params, ringBits, meta }

console.log(decode(grid).text); // "hello iris"
```

`encode()` defaults to the **color** profile; pass `{ mono: true }` for v1. `decode()`
auto-detects (RGB grid → color, grayscale grid → mono).

Lower-level pieces are exported too: color (`encodeColor`, `renderColorSVG`,
`renderColorRaster`, `decodeColor`, `PALETTE`), mono (`encodeToSymbol`, `renderSVG`,
`renderRaster`, `decodeRaster`), raster I/O (`gridToPGM`/`pgmToGrid`,
`gridToPPM`/`ppmToGrid`), and geometry helpers (`segCounts`, `capacityBits`,
`imageSizePx`).

## How it works (short version)

| Pillar          | IRIS's answer                                                        |
| --------------- | ------------------------------------------------------------------- |
| Localization    | central **pupil** (bullseye)                                         |
| Registration    | **north** spur fixes rotation (ellipse-fit perspective is Track-2)   |
| Sampling        | concentric **rings** of angular **segments**, each **self-marked**   |
| Error correction| **Reed–Solomon** over GF(256), 30% parity                           |

Each segment carries its own start **tick** (leading 30%, always inked) so the decoder
re-syncs at every cell — this is what makes IRIS strong against radial scratches. The
trailing 70% is the 1-bit **data cell**.

## Layout

```
src/
  params.js      geometry + ring schedules (N_k, image size)
  rs.js          Reed–Solomon over GF(256)
  bits.js        bit packing + CRC-16
  encode.js      mono: text -> Symbol
  render-svg.js  mono: Symbol -> SVG
  decode.js      mono: grid -> text
  color.js       v2 color: 3-bit cells, palette, encode/render/decode
  robust.js      robust decode: find center/scale/rotation, then sample + RS
  raster.js      Symbol -> grid; PGM (mono) + PPM (color) I/O
  index.js       public API
bin/iris.js      CLI
web/             zero-build Tailwind generator + Robustness Lab
test/            node:test round-trip, color, capacity, robustness
```

## Tests & linting

```sh
node --test        # no install needed — the library itself has zero deps
npm run lint       # ESLint (dev-only tool; npm install first)
npm run lint:fix
```

Tests cover RS error correction (incl. erasures), round-trip property tests, PGM/PPM
serialization, unicode, capacity (beats QR v40), and the full robustness suite (rotation,
scale, perspective, noise, scratches). The library keeps **zero runtime dependencies**;
ESLint and friends are `devDependencies` only.

## Capacity & research

The original mono profile stored ~16–35 bytes because each cell was large (4u arc × 3u
radial = **12 u²**) and 30% of every cell was an always-inked clock tick — at the same
print resolution that's ~12× less dense than a QR module (1 u²) before the clock tax.

v2 closes the gap with three compounding levers drawn from the literature:

- **Smaller cells** (2u arc × 2u radial) → more cells per unit area.
- **No per-cell clock** → recovers the 30% tax (trades some scratch-robustness; use
  `--mono` when you need it back).
- **8-color cells = 3 bits/cell** — the JAB-Code / High-Capacity-Color-Barcode idea
  (ISO/IEC 23634): ~3× the bits of black/white.

Selected references that informed this:

- **QR baseline** — ISO/IEC 18004:2024; v40 = 2,953 bytes binary.
  ([denso](https://www.qrcode.com/en/about/version.html))
- **JAB Code** — Fraunhofer SIT, ISO/IEC 23634:2022; 8 colors, ~3× density.
  ([wikipedia](https://en.wikipedia.org/wiki/JAB_Code) ·
  [github](https://github.com/jabcode/jabcode))
- **Secure & Recoverable RGB-Colored 2D Barcodes** — MDPI Electronics, 2026 (color +
  learned decoder). ([mdpi](https://www.mdpi.com/2079-9292/15/9/1855))
- **DL barcode localization/decoding** — Nature Sci. Reports, 2025.
  ([nature](https://www.nature.com/articles/s41598-025-29720-w))
- **U-Net restoration of damaged QR** — CMES, 2025.
  ([techscience](https://www.techscience.com/CMES/v143n3/62816/html))
- **HiQ high-capacity color QR** — arXiv 1704.06447 (color layering).
- **Multilevel 2D bar codes** — grayscale gives log₂(a²+1) bits/cell.
  ([researchgate](https://www.researchgate.net/publication/221011168))
- **Compression before encoding** — gzip ~+52%; shared-dictionary zstd/brotli ~88–90% on
  small payloads (Chrome 130, Oct 2024).
  ([ieee](https://ieeexplore.ieee.org/document/8710429) ·
  [debugbear](https://www.debugbear.com/blog/shared-compression-dictionaries))

Still on the roadmap: a **compression layer** (mode detection + shared dictionary) so the
stored bytes go further, and **grayscale** as a no-color middle ground.

## Status & scope

Focused on the **clean-render round trip** (AGENTS.md Track-1):

- ✅ color (v2, 3 bits/cell) and mono (v1, self-clocking) encode → SVG / raster → decode,
  with RS error correction; capacity grows outward and beats QR v40.
- ✅ **robust color decode** (`src/robust.js`): recovers center, scale, **any rotation**,
  and **perspective**, and rebuilds **scratched** regions. Tested across all rotations
  0–355° (incl. −84°) with anti-aliasing, rotation+scale+translation, noise, perspective
  up to a steep tilt, perspective+rotation, and multiple thick scratches.
  - **Rotation** — log-polar / Fourier–Mellin principle (Reddy & Chatterji): a rotation is
    a shift along the angle axis. A full-radius **registration ray** (segment 0 of every
    ring) is the fiducial; chance black-cell alignments can mimic it, so the decoder tries
    each candidate angle and lets **RS + CRC be the arbiter**.
    [Reddy–Chatterji](http://www.liralab.it/teaching/SINA_10/slides-current/fourier-mellin-paper.pdf) ·
    [1D POC rotation](https://link.springer.com/chapter/10.1007/978-3-540-74260-9_19)
  - **Perspective** — the image of a circle is an **ellipse** (AGENTS.md §3 step 3). We fit
    the outer boundary for the affine part and add a **Klein (projective) disk offset** for
    the non-linear foreshortening — together a full homography of the disk. A *conformal*
    Blaschke map can't model a real camera (foreshortening keeps straight chords straight,
    which conformal maps don't); the projective offset is **seeded directly from the bullseye
    core** (its image, displaced from the ellipse centre, *is* the foreshortening), then
    rotation is recovered per offset by a fine snap sweep ranked on **ray darkness**, with
    RS + CRC the arbiter. Decodes **every rotation** to ~0.35 keystone, and composes with
    blur, scale and noise; only extreme grazing angles still fail (single-conic limit).
  - **Scratches** — damaged cells (long near-white streaks, distinct from isolated white
    data cells) are detected and decoded as **Reed–Solomon erasures**, which cost half the
    parity of unknown errors — so the decoder reconstructs what's hidden behind the
    scratch, like a human reading around it. Even a scratch **over the registration ray**
    decodes: when the ray is destroyed, rotation falls back to a brute-force sweep
    arbitrated by RS+CRC.
  - **Adaptive ECC** — short payloads spend their spare symbol space on parity (up to
    ~70%), so even **two scratches at an odd angle** recover (and fast, because high parity
    means decode succeeds in the early phase instead of falling through to slow fallbacks).
  - **Noise** — the palette-index map is **mode-filtered** (3×3 majority), so salt-and-pepper
    noise — never the local majority — is overwritten by the surrounding cell colour. Heavy
    noise survives even combined with blur and perspective.
  - **Speed** — per-pixel palette/clean/white masks are precomputed once; the offset is
    **seeded from the projected pupil centre** (not blind grid search) and a clean-cell
    fail-fast skips Reed–Solomon on wrong geometries. Typical cases — including
    perspective + rotation + blur + noise — decode in **~10–200 ms**.
- ✅ zero-build Tailwind web generator **+ Robustness Lab**.

## Roadmap

IRIS is beta and moving fast. On the near-term list:

- 🚧 **More language implementations / ports** beyond this JavaScript reference.
- 🚧 **Real-photo capture** — color calibration and lens-distortion handling for camera
  pipelines (the geometric rectification — rotation, scale, perspective, scratches, noise —
  already works on rendered/distorted rasters).
- 🚧 **PNG I/O** (PGM/PPM supported today) and the full **pupil codebook** classifier.
- 🚧 Continued **decoder robustness & speed** improvements.

Have a use case or a distortion that breaks it? Open an issue.

## License

MIT — see [`LICENSE`](./LICENSE).
