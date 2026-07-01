// Decode pipeline (AGENTS.md §3), Track-1: recover the payload from a clean
// render produced by iris-render. The decoder doesn't know the ring schedule up
// front, so it tries each candidate K and accepts the one whose RS + CRC verify.

import { DEFAULT_PROFILE, SCHEDULES, segCounts, ringMidU, monoLayout } from "./params.js";
import { rsCorrect } from "./rs.js";
import { bitsToBytes } from "./bits.js";
import { readFrame } from "./frame.js";

// Otsu's threshold (AGENTS.md §3 step 1): the gray level that best separates
// the ink and paper populations. On a crisp render this lands mid-gap (same
// behaviour as a fixed 128); on a low-contrast or brightness-shifted scan it
// follows the histogram instead of silently misreading everything.
function otsuThreshold(data) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < data.length; i++) hist[data[i]]++;
  let sum = 0;
  for (let v = 0; v < 256; v++) sum += v * hist[v];
  let sumB = 0;
  let wB = 0;
  let best = 128;
  let bestVar = -1;
  for (let v = 0; v < 256; v++) {
    wB += hist[v];
    if (wB === 0) continue;
    const wF = data.length - wB;
    if (wF === 0) break;
    sumB += v * hist[v];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > bestVar) {
      bestVar = between;
      best = v + 1; // gray < threshold counts as ink
    }
  }
  return best;
}

// Sample one data cell: 3x3 majority vote at the cell center (AGENTS.md §3 step 6).
function sampleBit(grid, cx, cy, ru, theta, u, ink) {
  const px = cx + ru * u * Math.sin(theta);
  const py = cy - ru * u * Math.cos(theta);
  let inked = 0;
  let tot = 0;
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      const x = Math.round(px) + ox;
      const y = Math.round(py) + oy;
      if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) continue;
      tot++;
      if (grid.data[y * grid.width + x] < ink) inked++;
    }
  }
  return inked * 2 > tot ? 1 : 0;
}

/**
 * Decode a grayscale grid to text. Returns { text, params } or throws if no
 * IRIS symbol verifies.
 */
export function decodeRaster(grid, opts = {}) {
  const p = { ...DEFAULT_PROFILE, ...(opts.profile || {}) };
  // Clean renders are centered; real-world localization is Track-2 (AGENTS.md §3).
  const cx = grid.width / 2;
  const cy = grid.height / 2;
  const ink = otsuThreshold(grid.data); // gray < ink counts as ink

  for (const K of SCHEDULES) {
    const radiusU = p.Rp + K * p.dr + p.quiet;
    const u = grid.width / (2 * radiusU); // pixel scale implied by this schedule
    const N = segCounts(K, p);

    // Walk rings, sample data cells in reading order (AGENTS.md §2.5).
    const bits = [];
    for (let k = 0; k < K; k++) {
      const rmid = ringMidU(k, p);
      const dk = (2 * Math.PI) / N[k];
      for (let i = 0; i < N[k]; i++) {
        const theta = (i + 0.65) * dk; // center of the trailing 70% data cell
        bits.push(sampleBit(grid, cx, cy, rmid, theta, u, ink));
      }
    }

    const { totalBytes, parity, dataBytes } = monoLayout(N, p);
    if (parity >= totalBytes) continue;

    const code = bitsToBytes(bits.slice(0, totalBytes * 8));
    const corrected = rsCorrect(code, parity);
    if (!corrected) continue;

    const text = readFrame(corrected, dataBytes);
    if (text === null) continue;
    return { text, params: { K, N } };
  }

  throw new Error("no decodable IRIS symbol found");
}
