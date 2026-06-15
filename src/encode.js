// Encode pipeline (AGENTS.md §4): text -> Symbol { params, ringBits }.

import { DEFAULT_PROFILE, SCHEDULES, segCounts } from "./params.js";
import { rsEncode } from "./rs.js";
import { bytesToBits } from "./bits.js";
import { FRAME_HEADER, writeFrame } from "./frame.js";

/** Parity byte count for a codeword of `totalBytes` (AGENTS.md §2.6, 30% default). */
function parityFor(totalBytes, p) {
  return Math.max(2, Math.round(totalBytes * p.parity));
}

/**
 * Encode `text` into an IRIS Symbol. Picks the smallest ring schedule that
 * fits the payload (capacity grows outward — AGENTS.md §2.3).
 */
export function encodeToSymbol(text, opts = {}) {
  const p = { ...DEFAULT_PROFILE, ...(opts.profile || {}) };
  const payload = new TextEncoder().encode(text);
  if (payload.length > 0xffff) throw new Error("payload too large (max 65535 bytes)");

  for (const K of SCHEDULES) {
    const N = segCounts(K, p);
    const cap = N.reduce((a, b) => a + b, 0);
    const totalBytes = Math.floor(cap / 8);
    const parity = parityFor(totalBytes, p);
    if (parity >= totalBytes) continue;
    const dataBytes = totalBytes - parity;
    if (dataBytes < FRAME_HEADER + payload.length) continue;

    const msg = writeFrame(payload, dataBytes);
    const code = rsEncode(msg, parity); // length === totalBytes
    const bits = bytesToBits(code);

    const ringBits = N.map((n) => new Uint8Array(n));
    let bi = 0;
    for (let k = 0; k < K; k++) {
      for (let i = 0; i < N[k]; i++) {
        ringBits[k][i] = bi < bits.length ? bits[bi] : 0;
        bi++;
      }
    }

    return {
      params: { ...p, K, N },
      ringBits,
      meta: { totalBytes, parity, dataBytes, capacityBits: cap },
    };
  }

  throw new Error("payload too large for available ring schedules");
}
