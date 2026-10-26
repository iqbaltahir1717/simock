// Pure geometry helpers. No DOM access so they can be unit tested in Node.

export interface Point { x: number; y: number }
/** Quad corners in order: top-left, top-right, bottom-right, bottom-left. */
export type Quad = [Point, Point, Point, Point];
/** Row-major 3x3 matrix. */
export type Mat3 = [number, number, number, number, number, number, number, number, number];
/** 2D affine matrix in canvas order: [a, b, c, d, e, f] (x' = a*x + c*y + e, y' = b*x + d*y + f). */
export type Affine = [number, number, number, number, number, number];

/** Solves A x = b with Gaussian elimination and partial pivoting. */
function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    if (Math.abs(M[pivot][col]) < 1e-12) throw new Error('Degenerate quad: corners are collinear');
    [M[col], M[pivot]] = [M[pivot], M[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/** Homography H such that H * src[i] ~ dst[i]. */
export function homography(src: Quad, dst: Quad): Mat3 {
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: u, y: v } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  const h = solve(A, b);
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

export function rectQuad(w: number, h: number): Quad {
  return [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
}

export function applyH(H: Mat3, p: Point): Point {
  const w = H[6] * p.x + H[7] * p.y + H[8];
  return { x: (H[0] * p.x + H[1] * p.y + H[2]) / w, y: (H[3] * p.x + H[4] * p.y + H[5]) / w };
}

export function invert3(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-15) throw new Error('Matrix is not invertible');
  const inv: Mat3 = [
    A, -(b * i - c * h), b * f - c * e,
    B, a * i - c * g, -(a * f - c * d),
    C, -(a * h - b * g), a * e - b * d,
  ];
  return inv.map((v) => v / det) as Mat3;
}

/** True when the quad is a parallelogram, i.e. the transform is affine (no perspective). */
export function isAffineQuad(q: Quad, eps = 0.5): boolean {
  return Math.abs(q[0].x + q[2].x - q[1].x - q[3].x) < eps && Math.abs(q[0].y + q[2].y - q[1].y - q[3].y) < eps;
}

/** ag-psd stores Smart Object corners as [x0,y0,x1,y1,x2,y2,x3,y3] in TL, TR, BR, BL order. */
export function quadFromTransform(t: number[]): Quad {
  if (!t || t.length < 8) throw new Error('Smart Object transform is missing');
  return [{ x: t[0], y: t[1] }, { x: t[2], y: t[3] }, { x: t[4], y: t[5] }, { x: t[6], y: t[7] }];
}

export function scaleQuad(q: Quad, s: number): Quad {
  return q.map((p) => ({ x: p.x * s, y: p.y * s })) as Quad;
}

export function quadBounds(q: Quad) {
  const xs = q.map((p) => p.x), ys = q.map((p) => p.y);
  return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
}

/** Longest edge of the quad divided by the longest edge of a w x h rect: how much the mockup scales the content. */
export function quadScaleFactor(q: Quad, w: number, h: number): number {
  const len = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
  const top = len(q[0], q[1]), bottom = len(q[3], q[2]), left = len(q[0], q[3]), right = len(q[1], q[2]);
  return Math.max(Math.max(top, bottom) / w, Math.max(left, right) / h);
}

export function multiplyAffine(m: Affine, n: Affine): Affine {
  // returns m * n (apply n first, then m)
  return [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export function applyAffine(m: Affine, p: Point): Point {
  return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
}
