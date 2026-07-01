// Deterministic rotation finder — the second half of the hybrid detector.
//
// The CNN gives the geometry (pupil center, disc-ellipse centroid + axes); this finds
// the registration spoke's angle by a polar scan, the Fourier–Mellin idea src/robust.js
// uses. The whole accuracy of this step lives in TWO geometric subtleties that took a
// while to get right (without them it tops out ~80%, with them ~95%):
//
//   1. ORIGIN = the PUPIL center, not the ellipse centroid. Radial lines through the
//      symbol's center map to radial lines through the IMAGED center (the pupil) even
//      under perspective — the ellipse centroid is a different point (offset by
//      foreshortening), and shooting rays from it misses the spoke on small/tilted codes.
//   2. EXTENT = the true ray↔ellipse intersection from that origin, so each radial line
//      is bounded by the actual disc edge in that direction (not an ellipse pretended to
//      be centered at the pupil).
//
// With the geometry right, the spoke is simply the image-angle whose radius is most fully
// BLACK — max(R,G,B) low (luminance would be fooled by the saturated red/blue cells) — and
// a plain argmax nails it; no coarse-ray disambiguation needed. The residual tail is a
// scratch or heavy blur sitting directly on the ~1-cell spoke, which genuinely destroys it.
//
// Pure (operates on an RGB grid {width,height,data}); unit-tested in Node.

const THR = 100;                       // max(R,G,B) < THR ⇒ "black"
const T0 = 0.30, T1 = 0.92, NT = 26;   // sample this fraction of the radius (origin → disc edge)
const BAND = 0.8;                      // average over ±BAND° so the ~1-cell spoke isn't missed

function bilinearMaxChan(data, W, H, x, y) {
  if (x < 0 || y < 0 || x >= W - 1 || y >= H - 1) return 255;
  const xi = x | 0, yi = y | 0, fx = x - xi, fy = y - yi;
  const o = (yi * W + xi) * 3;
  const mc = (off) => Math.max(data[off], data[off + 1], data[off + 2]);
  const top = mc(o) * (1 - fx) + mc(o + 3) * fx;
  const bot = mc(o + W * 3) * (1 - fx) + mc(o + W * 3 + 3) * fx;
  return top * (1 - fy) + bot * fy;
}

// Distance from origin (ox,oy) to the ellipse boundary along image-angle `th`
// (0=up, clockwise). Ellipse: centroid (ex,ey), semi-axes a,b, tilt phiRad.
function ellipseHitRadius(ox, oy, ex, ey, a, b, phiRad, th) {
  const dx = Math.sin(th), dy = -Math.cos(th);
  const c = Math.cos(phiRad), s = Math.sin(phiRad);
  const px = (ox - ex) * c + (oy - ey) * s;        // origin in the ellipse frame
  const py = -(ox - ex) * s + (oy - ey) * c;
  const ddx = dx * c + dy * s, ddy = -dx * s + dy * c;
  const A = (ddx * ddx) / (a * a) + (ddy * ddy) / (b * b);
  const B = 2 * (px * ddx / (a * a) + py * ddy / (b * b));
  const C = (px * px) / (a * a) + (py * py) / (b * b) - 1;
  const disc = B * B - 4 * A * C;
  if (disc < 0) return Math.max(a, b);
  const t = (-B + Math.sqrt(disc)) / (2 * A);       // forward intersection
  return t > 0 ? t : Math.max(a, b);
}

/**
 * Recover the registration-ray angle. (ox,oy) = pupil center (radial origin);
 * (ex,ey,a,b,phiRad) = disc ellipse (centroid + axes + tilt). Returns
 * { ray_deg (0°=up, clockwise), confidence }.
 */
export function refineRayPolar(grid, ox, oy, ex, ey, a, b, phiRad) {
  const { width: W, height: H, data } = grid;
  const cover = (deg) => {
    const th = (deg * Math.PI) / 180;
    const R = ellipseHitRadius(ox, oy, ex, ey, a, b, phiRad, th);
    const st = Math.sin(th), ct = Math.cos(th);
    let bl = 0;
    for (let k = 0; k < NT; k++) {
      const t = T0 + ((T1 - T0) * k) / (NT - 1);
      if (bilinearMaxChan(data, W, H, ox + t * R * st, oy - t * R * ct) < THR) bl++;
    }
    return bl / NT;
  };
  const score = (deg) => (cover(deg - BAND) + cover(deg) + cover(deg + BAND)) / 3;
  let best = -1, bd = 0;
  for (let deg = 0; deg < 360; deg++) {
    const s = score(deg);
    if (s > best) { best = s; bd = deg; }
  }
  for (let deg = bd - 1; deg <= bd + 1; deg += 0.2) {
    const s = score(deg);
    if (s > best) { best = s; bd = deg; }
  }
  return { ray_deg: ((bd % 360) + 360) % 360, confidence: best };
}
