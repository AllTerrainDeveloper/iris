// Decode pipeline (AGENTS.md §3), Track-1: recover the payload from a clean
// render produced by iris-render. The decoder doesn't know the ring schedule up
// front, so it tries each candidate K and accepts the one whose RS + CRC verify.

import { DEFAULT_PROFILE, SCHEDULES, segCounts, ringMidU } from "./params.js";
import { rsCorrect } from "./rs.js";
import { bitsToBytes, crc16 } from "./bits.js";

const INK = 128; // gray < INK counts as ink

// Sample one data cell: 3x3 majority vote at the cell center (AGENTS.md §3 step 6).
function sampleBit(grid, cx, cy, ru, theta, u) {
  const px = cx + ru * u * Math.sin(theta);
  const py = cy - ru * u * Math.cos(theta);
  let ink = 0;
  let tot = 0;
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      const x = Math.round(px) + ox;
      const y = Math.round(py) + oy;
      if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) continue;
      tot++;
      if (grid.data[y * grid.width + x] < INK) ink++;
    }
  }
  return ink * 2 > tot ? 1 : 0;
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
        bits.push(sampleBit(grid, cx, cy, rmid, theta, u));
      }
    }

    const cap = N.reduce((a, b) => a + b, 0);
    const totalBytes = Math.floor(cap / 8);
    const parity = Math.max(2, Math.round(totalBytes * p.parity));
    if (parity >= totalBytes) continue;
    const dataBytes = totalBytes - parity;

    const code = bitsToBytes(bits.slice(0, totalBytes * 8));
    const corrected = rsCorrect(code, parity);
    if (!corrected) continue;

    const len = (corrected[0] << 8) | corrected[1];
    if (4 + len > dataBytes) continue;
    const stored = (corrected[2] << 8) | corrected[3];
    const payload = corrected.slice(4, 4 + len);
    if (crc16(payload) !== stored) continue;

    return { text: new TextDecoder().decode(payload), params: { K, N } };
  }

  throw new Error("no decodable IRIS symbol found");
}
