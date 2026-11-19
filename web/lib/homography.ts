// Perspective correction for photographed floor plans.
// The user marks four points that form a rectangle in reality (sheet frame, building corners);
// we solve the 3×3 homography and resample the photo so that rectangle becomes a rectangle.

export type P = [number, number];

/** Homography H (row-major, h33 = 1) mapping src[i] → dst[i]. */
export function solveHomography(src: P[], dst: P[]): number[] {
  const A: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  // Gaussian elimination with partial pivoting on the 8×9 augmented matrix
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    if (Math.abs(A[c][c]) < 1e-12) throw new Error('The four points must not be in a line');
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 9; k++) A[r][k] -= f * A[c][k];
    }
  }
  const h = A.map((row, i) => row[8] / row[i]);
  return [...h, 1];
}

export function apply(H: number[], [x, y]: P): P {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

/**
 * Straighten an image. quad: TL, TR, BR, BL in image pixels, marking a real-world rectangle.
 * The whole photo is kept (mapped through the same correction), cropped to at most maxSide pixels.
 */
export function straighten(img: HTMLImageElement | HTMLCanvasElement, quad: P[], maxSide = 2000): HTMLCanvasElement {
  const d = (a: P, b: P) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const w = (d(quad[0], quad[1]) + d(quad[3], quad[2])) / 2, h = (d(quad[0], quad[3]) + d(quad[1], quad[2])) / 2;
  const rect: P[] = [[0, 0], [w, 0], [w, h], [0, h]];
  const H = solveHomography(quad, rect);
  const W0 = img.width, H0 = img.height;
  // Output bounds: where the photo's own corners land, limited to 2× the marked rectangle around it.
  const pts = ([[0, 0], [W0, 0], [W0, H0], [0, H0]] as P[]).map(p => apply(H, p));
  let x0 = Math.max(Math.min(...pts.map(p => p[0])), -w), x1 = Math.min(Math.max(...pts.map(p => p[0])), 2 * w);
  let y0 = Math.max(Math.min(...pts.map(p => p[1])), -h), y1 = Math.min(Math.max(...pts.map(p => p[1])), 2 * h);
  const s = Math.min(1, maxSide / Math.max(x1 - x0, y1 - y0));
  const OW = Math.round((x1 - x0) * s), OH = Math.round((y1 - y0) * s);
  const Hinv = solveHomography(rect, quad);
  const srcC = document.createElement('canvas'); srcC.width = W0; srcC.height = H0;
  const sg = srcC.getContext('2d')!; sg.drawImage(img, 0, 0);
  const sd = sg.getImageData(0, 0, W0, H0).data;
  const out = document.createElement('canvas'); out.width = OW; out.height = OH;
  const og = out.getContext('2d')!; const od = og.createImageData(OW, OH);
  for (let j = 0; j < OH; j++) {
    for (let i = 0; i < OW; i++) {
      const [sx, sy] = apply(Hinv, [x0 + i / s, y0 + j / s]);
      const o = (j * OW + i) * 4;
      if (sx < 0 || sy < 0 || sx >= W0 - 1 || sy >= H0 - 1) { od.data[o] = od.data[o + 1] = od.data[o + 2] = 255; od.data[o + 3] = 255; continue; }
      const ix = sx | 0, iy = sy | 0, fx = sx - ix, fy = sy - iy;
      for (let c = 0; c < 3; c++) {
        const a = sd[(iy * W0 + ix) * 4 + c], b = sd[(iy * W0 + ix + 1) * 4 + c];
        const cc = sd[((iy + 1) * W0 + ix) * 4 + c], dd = sd[((iy + 1) * W0 + ix + 1) * 4 + c];
        od.data[o + c] = (a * (1 - fx) + b * fx) * (1 - fy) + (cc * (1 - fx) + dd * fx) * fy;
      }
      od.data[o + 3] = 255;
    }
  }
  og.putImageData(od, 0, 0);
  return out;
}
