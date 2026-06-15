// Symbol -> SVG (AGENTS.md §2.7). Pure black on white, deterministic output.

import { imageSizePx } from "./params.js";

/** Format a pixel coordinate for SVG: 3 decimals, trailing zeros trimmed. */
export const svgNum = (n) => n.toFixed(3).replace(/\.?0+$/, "");
const f = svgNum; // terse alias for the dense path-building strings below

// Annular sector path. Radii in px; angles in rad (0 at top, clockwise).
export function sector(c, r0, r1, a0, a1) {
  const P = (r, a) => [c + r * Math.sin(a), c - r * Math.cos(a)];
  const [x0, y0] = P(r1, a0);
  const [x1, y1] = P(r1, a1);
  const [x2, y2] = P(r0, a1);
  const [x3, y3] = P(r0, a0);
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return (
    `<path d="M${f(x0)} ${f(y0)}` +
    `A${f(r1)} ${f(r1)} 0 ${large} 1 ${f(x1)} ${f(y1)}` +
    `L${f(x2)} ${f(y2)}` +
    `A${f(r0)} ${f(r0)} 0 ${large} 0 ${f(x3)} ${f(y3)}Z"/>`
  );
}

/** Render a Symbol to an SVG string. */
export function renderSVG(sym) {
  const p = sym.params;
  const { Rp, dr, K, N, u } = p;
  const D = imageSizePx(K, p);
  const c = D / 2;

  const out = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${D}" height="${D}" viewBox="0 0 ${D} ${D}">`,
    `<rect width="${D}" height="${D}" fill="#fff"/>`,
    `<g fill="#000" stroke="none">`,
  ];

  // Pupil: invariant outer ring + center dot, white gap between (AGENTS.md §2.2).
  out.push(`<circle cx="${c}" cy="${c}" r="${f(Rp * u)}"/>`);
  out.push(`<circle cx="${c}" cy="${c}" r="${f((Rp - 2) * u)}" fill="#fff"/>`);
  out.push(`<circle cx="${c}" cy="${c}" r="${f(2 * u)}"/>`);
  // North spur into the pupil gap, under ring 0 segment 0's tick (AGENTS.md §2.4).
  out.push(sector(c, 2 * u, (Rp - 2) * u, 0, 0.3 * ((2 * Math.PI) / N[0])));

  // Data rings: always-inked ticks + inked data cells (AGENTS.md §2.3, §2.4).
  for (let k = 0; k < K; k++) {
    const r0 = (Rp + k * dr) * u;
    const r1 = (Rp + (k + 1) * dr) * u;
    const dk = (2 * Math.PI) / N[k];
    for (let i = 0; i < N[k]; i++) {
      const a0 = i * dk;
      const aTick = a0 + 0.3 * dk;
      const a1 = (i + 1) * dk;
      out.push(sector(c, r0, r1, a0, aTick)); // start tick
      if (sym.ringBits[k][i] === 1) out.push(sector(c, r0, r1, aTick, a1)); // data cell
    }
  }

  out.push(`</g></svg>`);
  return out.join("\n");
}
