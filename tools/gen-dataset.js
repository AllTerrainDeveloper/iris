// Synthetic dataset generator for an IRIS *localizer* (stage 1 of the two-stage
// pipeline: model finds + seeds geometry/color, then src/robust.js decodes).
//
// The scene synthesis + exact labelling live in scene.js (shared, browser-safe);
// this file is the Node CLI around it: random payloads, write PPM + labels.jsonl,
// and an optional --verify that re-decodes each capture.
//
// Usage:
//   node tools/gen-dataset.js --count 200 --out data/iris --size 512 --seed 1
//   node tools/gen-dataset.js --count 50 --verify        # re-decode each sample
//
// Output (in --out): images/000000.ppm …, labels.jsonl, dataset.json.
// Label schema is documented in tools/README.md.

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { gridToPPM } from "../src/raster.js";
import { makePRNG } from "./distort.js";
import { renderScene, randomScene, realisticScene, randomText } from "./scene.js";

function parseArgs(argv) {
  const a = { count: 100, out: "data/iris", size: 512, seed: 1, verify: false, realistic: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--count") a.count = +argv[++i];
    else if (k === "--out") a.out = argv[++i];
    else if (k === "--size") a.size = +argv[++i];
    else if (k === "--seed") a.seed = +argv[++i];
    else if (k === "--verify") a.verify = true;
    // Realistic CAPTURE envelope (no scratches) — the right distribution for training
    // a LOCALIZER. Omit for the decoder's full torture envelope (randomScene).
    else if (k === "--realistic") a.realistic = true;
    else if (k === "--help" || k === "-h") a.help = true;
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("Usage: node tools/gen-dataset.js [--count N] [--out DIR] [--size PX] [--seed S] [--verify]");
    return;
  }
  const rng = makePRNG(args.seed);
  const imgDir = join(args.out, "images");
  mkdirSync(imgDir, { recursive: true });

  // --verify re-decodes each capture with the real robust decoder, proving the
  // labels belong to a still-readable symbol (and reporting the survival rate).
  let decodeColorRobust = null;
  if (args.verify) ({ decodeColorRobust } = await import("../src/robust.js"));

  const lines = [];
  let decoded = 0;
  for (let i = 0; i < args.count; i++) {
    const text = randomText(rng);
    const scene = (args.realistic ? realisticScene : randomScene)(rng, args.size);
    const { grid, label } = renderScene(text, scene, rng);
    const id = String(i).padStart(6, "0");
    const file = join("images", `${id}.ppm`);
    writeFileSync(join(args.out, file), gridToPPM(grid));
    label.id = id;
    label.file = file;
    if (decodeColorRobust) {
      // robust.js localizes by "non-white = symbol", so it expects a centered code
      // on white — that clutter-localization step is precisely what the stage-1
      // model adds. So we verify the DISTORTION ENVELOPE in the decoder's own
      // framing: same geometry/blur/noise/scratches, centered on white, minus the
      // illuminant shift (color calibration is the part robust.js doesn't do yet).
      // A high survival rate means our captures stay within what it can read.
      const vScene = { ...scene, bg: "white", cxFrac: 0.5, cyFrac: 0.5, size: args.size * 0.92, color: null };
      const { grid: vGrid } = renderScene(text, vScene, rng);
      let ok = false;
      try { ok = decodeColorRobust(vGrid, { budgetMs: 800 })?.text === text; } catch { /* unreadable */ }
      label.decoded = ok;
      if (ok) decoded++;
    }
    lines.push(JSON.stringify(label));
    if ((i + 1) % 25 === 0 || i + 1 === args.count) {
      process.stdout.write(`\r  ${i + 1}/${args.count} rendered`);
    }
  }
  process.stdout.write("\n");

  writeFileSync(join(args.out, "labels.jsonl"), lines.join("\n") + "\n");
  writeFileSync(join(args.out, "dataset.json"), JSON.stringify({
    count: args.count, size: args.size, seed: args.seed, format: "ppm (P6 RGB)",
    note: "Stage-1 localizer data. Labels are exact (computed from the known warp).",
    label_fields: ["bbox", "center", "radius", "ray_deg", "ellipse", "quad", "color", "palette_observed", "distort"],
  }, null, 2));

  console.log(`✓ ${args.count} samples → ${args.out}`);
  if (decodeColorRobust) {
    const pct = ((decoded / args.count) * 100).toFixed(1);
    console.log(`  verify: ${decoded}/${args.count} (${pct}%) still decode with src/robust.js`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
