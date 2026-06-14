// IRIS — public API. A radial, self-clocking 2D optical code (AGENTS.md).
//
//   import { encode, decode } from "iris-code";
//   const { svg, symbol } = encode("hello iris");
//   const text = decode(grid).text;

export { DEFAULT_PROFILE, SCHEDULES, segCounts, capacityBits, imageSizePx } from "./params.js";
export { encodeToSymbol } from "./encode.js";
export { renderSVG } from "./render-svg.js";
export { renderRaster, gridToPGM, pgmToGrid, gridToPPM, ppmToGrid } from "./raster.js";
export { decodeRaster } from "./decode.js";
export {
  COLOR_PROFILE,
  SCHEDULES_COLOR,
  PALETTE,
  encodeColor,
  renderColorSVG,
  renderColorRaster,
  decodeColor,
} from "./color.js";

import { encodeToSymbol } from "./encode.js";
import { renderSVG } from "./render-svg.js";
import { renderRaster } from "./raster.js";
import { decodeRaster } from "./decode.js";
import { encodeColor, renderColorSVG, renderColorRaster, decodeColor } from "./color.js";

/**
 * Encode text. Defaults to the high-capacity color profile (v2, 3 bits/cell);
 * pass { mono: true } for the v1 black-and-white self-clocking profile.
 */
export function encode(text, opts = {}) {
  if (opts.mono) {
    const symbol = encodeToSymbol(text, opts);
    return { symbol, svg: renderSVG(symbol), grid: renderRaster(symbol) };
  }
  const symbol = encodeColor(text, opts);
  return { symbol, svg: renderColorSVG(symbol), grid: renderColorRaster(symbol) };
}

/** Decode a grid back to text. RGB grid -> color; grayscale grid -> mono. */
export function decode(grid, opts = {}) {
  const isColor = grid.data.length >= grid.width * grid.height * 3;
  return isColor ? decodeColor(grid, opts) : decodeRaster(grid, opts);
}
