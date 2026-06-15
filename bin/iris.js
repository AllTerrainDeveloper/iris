#!/usr/bin/env node
// IRIS CLI (AGENTS.md §5). Zero dependencies — hand-rolled arg parsing.
//
//   iris encode "<text>" -o out.svg      # color vector output (default, v2)
//   iris encode "<text>" -o out.ppm      # color raster (decodable)
//   iris encode "<text>" -o out.pgm --mono   # b/w self-clocking profile (v1)
//   iris decode in.ppm                    # prints the payload

import { readFileSync, writeFileSync } from "node:fs";
import { extname } from "node:path";
import { encodeToSymbol } from "../src/encode.js";
import { renderSVG } from "../src/render-svg.js";
import { renderRaster, gridToPGM, pgmToGrid, gridToPPM, ppmToGrid } from "../src/raster.js";
import { decodeRaster } from "../src/decode.js";
import { encodeColor, renderColorSVG, renderColorRaster, decodeColor } from "../src/color.js";

const USAGE = `IRIS — radial high-capacity optical code

Usage:
  iris encode "<text>" [-o out.svg|out.ppm] [--mono -o out.pgm|out.svg]
  iris decode <in.ppm|in.pgm>

Profiles:
  default   color, 3 bits/cell (v2) — high capacity, beats QR. .svg / .ppm
  --mono    black & white, self-clocking (v1) — robust. .svg / .pgm

Notes:
  .svg is the vector source of truth; .ppm (color) / .pgm (mono) are
  zero-dependency rasters you can decode directly. (PNG is a planned add.)`;

function fail(msg) {
  process.stderr.write(`iris: ${msg}\n`);
  process.exit(1);
}

function cmdEncode(args) {
  let out = "iris.svg";
  let mono = false;
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-o" || args[i] === "--out") out = args[++i];
    else if (args[i] === "--mono") mono = true;
    else rest.push(args[i]);
  }
  const text = rest.join(" ");
  if (!text) fail('encode needs text, e.g. iris encode "hello iris" -o out.svg');
  const ext = extname(out).toLowerCase();

  if (mono) {
    const symbol = encodeToSymbol(text);
    if (ext === ".svg") writeFileSync(out, renderSVG(symbol));
    else if (ext === ".pgm") writeFileSync(out, gridToPGM(renderRaster(symbol)));
    else fail(`mono output must be .svg or .pgm (got "${ext}")`);
    report(out, symbol, text, "mono");
  } else {
    const symbol = encodeColor(text);
    if (ext === ".svg") writeFileSync(out, renderColorSVG(symbol));
    else if (ext === ".ppm") writeFileSync(out, gridToPPM(renderColorRaster(symbol)));
    else fail(`color output must be .svg or .ppm (got "${ext}")`);
    report(out, symbol, text, "color");
  }
}

function report(out, symbol, text, profile) {
  const { K, N } = symbol.params;
  const segs = N.reduce((a, b) => a + b, 0);
  const cap = symbol.meta.capacityBytes;
  process.stderr.write(
    `wrote ${out} (${profile}, K=${K} rings, ${segs} cells, ${text.length} chars, ~${cap}B capacity)\n`
  );
}

function cmdDecode(args) {
  const file = args[0];
  if (!file) fail("decode needs an input file, e.g. iris decode in.ppm");
  const ext = extname(file).toLowerCase();
  const buf = readFileSync(file);
  let text;
  if (ext === ".ppm") text = decodeColor(ppmToGrid(buf)).text;
  else if (ext === ".pgm") text = decodeRaster(pgmToGrid(buf)).text;
  else fail(`can only decode .ppm (color) or .pgm (mono) rasters (got "${ext}")`);
  process.stdout.write(text + "\n");
}

const [cmd, ...args] = process.argv.slice(2);
try {
  if (cmd === "encode") cmdEncode(args);
  else if (cmd === "decode") cmdDecode(args);
  else if (cmd === "-h" || cmd === "--help" || !cmd) process.stdout.write(USAGE + "\n");
  else fail(`unknown command "${cmd}"\n\n${USAGE}`);
} catch (err) {
  fail(err.message);
}
