// ─── Planar-motion test (server only) ────────────────────────────────────────
//
// The landmark metrics (metrics.ts) are ratios a flat picture can't change in
// theory, but face-api's landmark net leans toward an average face shape and
// partly reads a strongly squeezed photo as a turned head. This test looks at
// pixels instead, and rests on plain geometry rather than on a network:
//
//   Every view of a flat object — a printed photo, a phone or laptop screen,
//   however it is moved, rotated or tilted — is related to every other view of
//   it by one homography. A real head turning is not: the nose tip, the eye
//   corners and the cheeks sit at different depths, so they shift by different
//   amounts (parallax: ~10 px between nose and cheeks for a 30° turn at our
//   frame size). No single homography maps the neutral face onto the turned one.
//
// So: pick well-textured points inside the face in the neutral frame, find
// each one in the turn frame by normalised cross-correlation (search seeded by
// an affine fit of the landmarks, comparing patches through that affine so a
// foreshortened photo still matches), fit a homography with RANSAC, and see
// how much of the motion it explains. It only ever vetoes: with too few good
// matches (blur, low light, featureless skin) it says "inconclusive" and the
// landmark checks decide alone, so a genuine user is not failed by it for
// lack of texture.

import type { Pt } from './metrics';

export interface GreyImage { data: Float32Array; width: number; height: number }

export interface PlanarityResult {
  /** 'planar' = one homography explains the face's motion (a flat picture). */
  verdict: 'planar' | 'non_planar' | 'inconclusive';
  matches: number;
  inlierRatio: number;
  /** Median residual (px) of all matches under the best homography. */
  medianResidual: number;
}

export const PLANARITY = {
  patchRadius: 4,       // 9×9 patches
  searchRadius: 9,      // ±9 px around the affine prediction
  minNcc: 0.82,
  maxPoints: 90,
  minMatches: 24,
  inlierPx: 1.6,
  /** ≥ this share of matches on one homography = planar. */
  planarInlierRatio: 0.8,
  ransacIterations: 400,
};

function sample(img: GreyImage, x: number, y: number): number {
  const { width: w, height: h, data } = img;
  if (x < 0 || y < 0 || x > w - 1.001 || y > h - 1.001) return NaN;
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const i = y0 * w + x0;
  return data[i] * (1 - fx) * (1 - fy) + data[i + 1] * fx * (1 - fy) + data[i + w] * (1 - fx) * fy + data[i + w + 1] * fx * fy;
}

function insidePolygon(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Least-squares affine map src→dst: [a b c; d e f]. */
export function fitAffine(src: Pt[], dst: Pt[]): number[] {
  // Normal equations for x' = a x + b y + c (and the same for y').
  let sxx = 0, sxy = 0, syy = 0, sx = 0, sy = 0, n = src.length;
  let bx = [0, 0, 0], by = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const { x, y } = src[i], X = dst[i].x, Y = dst[i].y;
    sxx += x * x; sxy += x * y; syy += y * y; sx += x; sy += y;
    bx = [bx[0] + x * X, bx[1] + y * X, bx[2] + X];
    by = [by[0] + x * Y, by[1] + y * Y, by[2] + Y];
  }
  const M = [[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, n]];
  const r1 = solve3(M, bx), r2 = solve3(M, by);
  return [...r1, ...r2];
}

function solve3(M: number[][], b: number[]): number[] {
  const a = M.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < 3; c++) {
    let p = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    [a[c], a[p]] = [a[p], a[c]];
    const d = a[c][c] || 1e-12;
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const f = a[r][c] / d;
      for (let k = c; k < 4; k++) a[r][k] -= f * a[c][k];
    }
  }
  return [a[0][3] / (a[0][0] || 1e-12), a[1][3] / (a[1][1] || 1e-12), a[2][3] / (a[2][2] || 1e-12)];
}

/** Homography from ≥4 correspondences (normalised DLT, h33 = 1), via Gaussian elimination on the 8×8 normal equations. */
export function fitHomography(src: Pt[], dst: Pt[]): number[] | null {
  const norm = (pts: Pt[]) => {
    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length, cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    const d = pts.reduce((s, p) => s + Math.hypot(p.x - cx, p.y - cy), 0) / pts.length || 1;
    const k = Math.SQRT2 / d;
    return { k, cx, cy, pts: pts.map(p => ({ x: (p.x - cx) * k, y: (p.y - cy) * k })) };
  };
  const S = norm(src), D = norm(dst);
  const A: number[][] = Array.from({ length: 8 }, () => new Array(9).fill(0));
  for (let i = 0; i < src.length; i++) {
    const { x, y } = S.pts[i], X = D.pts[i].x, Y = D.pts[i].y;
    const rows = [[x, y, 1, 0, 0, 0, -X * x, -X * y, X], [0, 0, 0, x, y, 1, -Y * x, -Y * y, Y]];
    for (const r of rows) for (let p = 0; p < 8; p++) for (let q = 0; q < 9; q++) A[p][q] += r[p] * r[q];
  }
  // Solve A[:, :8] h = A[:, 8]
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-10) return null;
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 9; k++) A[r][k] -= f * A[c][k];
    }
  }
  const hn = [...Array.from({ length: 8 }, (_, i) => A[i][8] / A[i][i]), 1];
  // Denormalise: H = Td^-1 · Hn · Ts
  const Ts = [S.k, 0, -S.k * S.cx, 0, S.k, -S.k * S.cy, 0, 0, 1];
  const TdInv = [1 / D.k, 0, D.cx, 0, 1 / D.k, D.cy, 0, 0, 1];
  const H = mul3(TdInv, mul3(hn, Ts));
  return H.map(v => v / (H[8] || 1e-12));
}

function mul3(a: number[], b: number[]): number[] {
  const r = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
  return r;
}

export function applyHomography(H: number[], p: Pt): Pt {
  const w = H[6] * p.x + H[7] * p.y + H[8];
  return { x: (H[0] * p.x + H[1] * p.y + H[2]) / w, y: (H[3] * p.x + H[4] * p.y + H[5]) / w };
}

/** Deterministic PRNG so a verdict is reproducible for the same frames. */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

/** Well-textured points inside the face polygon (Shi–Tomasi score), spread out. */
function pickPoints(img: GreyImage, poly: Pt[], spacing: number, max: number): Pt[] {
  const xs = poly.map(p => p.x), ys = poly.map(p => p.y);
  const x0 = Math.max(6, Math.floor(Math.min(...xs))), x1 = Math.min(img.width - 7, Math.ceil(Math.max(...xs)));
  const y0 = Math.max(6, Math.floor(Math.min(...ys))), y1 = Math.min(img.height - 7, Math.ceil(Math.max(...ys)));
  const cand: { p: Pt; s: number }[] = [];
  const g = (x: number, y: number) => img.data[y * img.width + x];
  for (let y = y0; y <= y1; y += spacing) {
    for (let x = x0; x <= x1; x += spacing) {
      if (!insidePolygon({ x, y }, poly)) continue;
      let a = 0, b = 0, c = 0;
      for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
        const gx = g(x + dx + 1, y + dy) - g(x + dx - 1, y + dy), gy = g(x + dx, y + dy + 1) - g(x + dx, y + dy - 1);
        a += gx * gx; b += gx * gy; c += gy * gy;
      }
      const minEig = (a + c) / 2 - Math.sqrt(((a - c) / 2) ** 2 + b * b);
      cand.push({ p: { x, y }, s: minEig });
    }
  }
  cand.sort((u, v) => v.s - u.s);
  const floor = (cand[0]?.s ?? 0) * 0.04;
  return cand.filter(c => c.s > floor && c.s > 1e-4).slice(0, max).map(c => c.p);
}

/**
 * Is the face motion between `a` (neutral) and `b` (turn) explained by a
 * single homography? Landmarks (68 each) seed the search and bound the face.
 */
export function planarMotion(a: GreyImage, b: GreyImage, lmA: Pt[], lmB: Pt[]): PlanarityResult {
  const P = PLANARITY;
  // Face polygon: jaw line + eyebrows, slightly shrunk toward its centre so
  // patches stay on the face, not the background behind a real head.
  const ring = [...lmA.slice(0, 17), ...lmA.slice(17, 27).reverse()];
  const c = { x: ring.reduce((s, p) => s + p.x, 0) / ring.length, y: ring.reduce((s, p) => s + p.y, 0) / ring.length };
  const poly = ring.map(p => ({ x: c.x + (p.x - c.x) * 0.92, y: c.y + (p.y - c.y) * 0.92 }));
  const iod = Math.hypot(lmA[45].x - lmA[36].x, lmA[45].y - lmA[36].y);
  const pts = pickPoints(a, poly, Math.max(3, Math.round(iod / 10)), P.maxPoints);

  const A = fitAffine(lmA, lmB);
  const lin = (o: Pt) => ({ x: A[0] * o.x + A[1] * o.y, y: A[3] * o.x + A[4] * o.y });
  const R = P.patchRadius, offs: Pt[] = [];
  for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) offs.push({ x: dx, y: dy });
  const warpedOffs = offs.map(lin);

  const src: Pt[] = [], dst: Pt[] = [];
  for (const p of pts) {
    const tpl = offs.map(o => sample(a, p.x + o.x, p.y + o.y));
    if (tpl.some(Number.isNaN)) continue;
    const tm = tpl.reduce((s, v) => s + v, 0) / tpl.length;
    const tz = tpl.map(v => v - tm), tn = Math.sqrt(tz.reduce((s, v) => s + v * v, 0));
    if (tn < 1e-3) continue;
    const q0 = { x: A[0] * p.x + A[1] * p.y + A[2], y: A[3] * p.x + A[4] * p.y + A[5] };
    let best = -2, bx = 0, by = 0;
    for (let sy = -P.searchRadius; sy <= P.searchRadius; sy++) {
      for (let sx = -P.searchRadius; sx <= P.searchRadius; sx++) {
        const qx = q0.x + sx, qy = q0.y + sy;
        let m = 0, ok = true;
        const vals = new Array(offs.length);
        for (let k = 0; k < offs.length; k++) {
          const v = sample(b, qx + warpedOffs[k].x, qy + warpedOffs[k].y);
          if (Number.isNaN(v)) { ok = false; break; }
          vals[k] = v; m += v;
        }
        if (!ok) continue;
        m /= offs.length;
        let num = 0, den = 0;
        for (let k = 0; k < offs.length; k++) { const z = vals[k] - m; num += z * tz[k]; den += z * z; }
        const ncc = den > 0 ? num / (Math.sqrt(den) * tn) : -1;
        if (ncc > best) { best = ncc; bx = qx; by = qy; }
      }
    }
    if (best >= P.minNcc) { src.push(p); dst.push({ x: bx, y: by }); }
  }

  const n = src.length;
  if (n < P.minMatches) return { verdict: 'inconclusive', matches: n, inlierRatio: 0, medianResidual: 0 };

  const rand = lcg(n * 7919 + Math.round(src[0].x * 31 + dst[0].y * 17));
  const residuals = (H: number[]) => src.map((p, i) => { const q = applyHomography(H, p); return Math.hypot(q.x - dst[i].x, q.y - dst[i].y); });
  let bestH: number[] | null = null, bestIn = -1;
  for (let it = 0; it < P.ransacIterations; it++) {
    const idx = new Set<number>();
    while (idx.size < 4) idx.add(Math.floor(rand() * n));
    const ii = [...idx];
    const H = fitHomography(ii.map(i => src[i]), ii.map(i => dst[i]));
    if (!H) continue;
    const inl = residuals(H).filter(r => r < P.inlierPx).length;
    if (inl > bestIn) { bestIn = inl; bestH = H; }
  }
  if (!bestH) return { verdict: 'inconclusive', matches: n, inlierRatio: 0, medianResidual: 0 };
  // Refit on the inliers for a fair final score.
  const res0 = residuals(bestH);
  const inIdx = res0.map((r, i) => (r < P.inlierPx ? i : -1)).filter(i => i >= 0);
  const refit = inIdx.length >= 4 ? fitHomography(inIdx.map(i => src[i]), inIdx.map(i => dst[i])) : null;
  const res = residuals(refit ?? bestH);
  const inlierRatio = res.filter(r => r < P.inlierPx).length / n;
  const sorted = [...res].sort((x, y) => x - y);
  const medianResidual = sorted[Math.floor(n / 2)];
  return {
    verdict: inlierRatio >= P.planarInlierRatio ? 'planar' : 'non_planar',
    matches: n, inlierRatio: +inlierRatio.toFixed(3), medianResidual: +medianResidual.toFixed(2),
  };
}

/** Luma of an RGB buffer, 0–1. */
export function toGrey(rgb: Uint8Array, width: number, height: number): GreyImage {
  const data = new Float32Array(width * height);
  for (let i = 0, j = 0; i < data.length; i++, j += 3) data[i] = (rgb[j] * 0.299 + rgb[j + 1] * 0.587 + rgb[j + 2] * 0.114) / 255;
  return { data, width, height };
}
