// Pearl's shape as a signed distance field (SDF), plus a mesher. Pure TypeScript with no three.js, so the mesh can
// be built in a Web Worker (tooth-mesh.worker.ts) without blocking the page.

type V3 = [number, number, number];

/** Polynomial smooth minimum: blends two shapes with a soft fillet of size k. */
function smin(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

function sdEllipsoid(x: number, y: number, z: number, rx: number, ry: number, rz: number): number {
  const k0 = Math.hypot(x / rx, y / ry, z / rz);
  const k1 = Math.hypot(x / (rx * rx), y / (ry * ry), z / (rz * rz));
  return (k0 * (k0 - 1)) / k1;
}

/** A capsule whose radius tapers from r1 (at a) to r2 (at b). */
function sdRoundCone(p: V3, a: V3, b: V3, r1: number, r2: number): number {
  const ba: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const l2 = ba[0] ** 2 + ba[1] ** 2 + ba[2] ** 2;
  const rr = r1 - r2;
  const a2 = l2 - rr * rr;
  const il2 = 1 / l2;
  const pa: V3 = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const y = pa[0] * ba[0] + pa[1] * ba[1] + pa[2] * ba[2];
  const z = y - l2;
  const q: V3 = [pa[0] * l2 - ba[0] * y, pa[1] * l2 - ba[1] * y, pa[2] * l2 - ba[2] * y];
  const x2 = q[0] ** 2 + q[1] ** 2 + q[2] ** 2;
  const y2 = y * y * l2;
  const z2 = z * z * l2;
  const k = Math.sign(rr) * rr * rr * x2;
  if (Math.sign(z) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - r2;
  if (Math.sign(y) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - r1;
  return (Math.sqrt(x2 * a2 * il2) + y * rr) * il2 - r1;
}

const ROOT_L: [V3, V3] = [
  [-0.42, -0.35, 0],
  [-0.4, -1.12, 0],
];
const ROOT_R: [V3, V3] = [
  [0.42, -0.35, 0],
  [0.4, -1.12, 0],
];

/** Distance to Pearl's surface (negative inside). Units: the tooth is ~2.5 tall, centred near the origin. */
export function toothSdf(x: number, y: number, z: number): number {
  const body = sdEllipsoid(x, y - 0.1, z, 0.95, 0.84, 0.74);
  const cusps = Math.min(sdEllipsoid(x + 0.44, y - 0.6, z, 0.52, 0.46, 0.6), sdEllipsoid(x - 0.44, y - 0.6, z, 0.52, 0.46, 0.6));
  const crown = smin(body, cusps, 0.35);
  const p: V3 = [x, y, z];
  const roots = Math.min(sdRoundCone(p, ROOT_L[0], ROOT_L[1], 0.42, 0.26), sdRoundCone(p, ROOT_R[0], ROOT_R[1], 0.42, 0.26));
  return smin(crown, roots, 0.3);
}

/** Outward unit normal (the SDF gradient). */
export function sdfNormal(x: number, y: number, z: number): V3 {
  const e = 1e-3;
  const nx = toothSdf(x + e, y, z) - toothSdf(x - e, y, z);
  const ny = toothSdf(x, y + e, z) - toothSdf(x, y - e, z);
  const nz = toothSdf(x, y, z + e) - toothSdf(x, y, z - e);
  const l = Math.hypot(nx, ny, nz) || 1;
  return [nx / l, ny / l, nz / l];
}

export interface ToothMesh {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
}

/** Half the size of the cube the mesh is sampled in. */
const EXTENT = 1.6;

/**
 * Naive surface nets: one vertex per grid cell the surface passes through (at the average of its edge crossings,
 * then pulled onto the surface), and a quad for every grid edge the surface crosses. Smooth, watertight, indexed.
 */
export function buildToothMesh(resolution = 72): ToothMesh {
  const n = resolution + 1; // grid points per axis
  const h = (2 * EXTENT) / resolution;
  const at = (i: number) => -EXTENT + i * h;
  const field = new Float32Array(n * n * n);
  const idx = (i: number, j: number, k: number) => i + n * (j + n * k);
  for (let k = 0; k < n; k++) for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) field[idx(i, j, k)] = toothSdf(at(i), at(j), at(k));

  // Cube corners and edges.
  const CORNERS: V3[] = [
    [0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0],
    [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1],
  ];
  const EDGES: [number, number][] = [
    [0, 1], [2, 3], [4, 5], [6, 7],
    [0, 2], [1, 3], [4, 6], [5, 7],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];

  const cellVertex = new Int32Array(resolution * resolution * resolution).fill(-1);
  const cidx = (i: number, j: number, k: number) => i + resolution * (j + resolution * k);
  const pos: number[] = [];
  const nor: number[] = [];
  const v = new Float64Array(8);
  for (let k = 0; k < resolution; k++) {
    for (let j = 0; j < resolution; j++) {
      for (let i = 0; i < resolution; i++) {
        let inside = 0;
        for (let c = 0; c < 8; c++) {
          v[c] = field[idx(i + CORNERS[c][0], j + CORNERS[c][1], k + CORNERS[c][2])];
          if (v[c] < 0) inside++;
        }
        if (inside === 0 || inside === 8) continue;
        let sx = 0, sy = 0, sz = 0, count = 0;
        for (const [a, b] of EDGES) {
          if (v[a] < 0 === v[b] < 0) continue;
          const t = v[a] / (v[a] - v[b]);
          sx += CORNERS[a][0] + t * (CORNERS[b][0] - CORNERS[a][0]);
          sy += CORNERS[a][1] + t * (CORNERS[b][1] - CORNERS[a][1]);
          sz += CORNERS[a][2] + t * (CORNERS[b][2] - CORNERS[a][2]);
          count++;
        }
        let x = at(i) + (sx / count) * h;
        let y = at(j) + (sy / count) * h;
        let z = at(k) + (sz / count) * h;
        // Pull onto the true surface (one Newton step along the gradient).
        const d = toothSdf(x, y, z);
        const g = sdfNormal(x, y, z);
        x -= g[0] * d;
        y -= g[1] * d;
        z -= g[2] * d;
        const nn = sdfNormal(x, y, z);
        cellVertex[cidx(i, j, k)] = pos.length / 3;
        pos.push(x, y, z);
        nor.push(nn[0], nn[1], nn[2]);
      }
    }
  }

  // One quad per sign-changing grid edge, joining the four cells around it, wound so it faces outwards.
  const tris: number[] = [];
  const quad = (a: number, b: number, c: number, d: number, flip: boolean) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) tris.push(a, c, b, a, d, c);
    else tris.push(a, b, c, a, c, d);
  };
  for (let k = 1; k < resolution; k++) {
    for (let j = 1; j < resolution; j++) {
      for (let i = 1; i < resolution; i++) {
        const f0 = field[idx(i, j, k)];
        const fx = field[idx(i + 1, j, k)];
        const fy = field[idx(i, j + 1, k)];
        const fz = field[idx(i, j, k + 1)];
        if (i < resolution && f0 < 0 !== fx < 0)
          quad(cellVertex[cidx(i, j - 1, k - 1)], cellVertex[cidx(i, j, k - 1)], cellVertex[cidx(i, j, k)], cellVertex[cidx(i, j - 1, k)], f0 >= 0);
        if (j < resolution && f0 < 0 !== fy < 0)
          quad(cellVertex[cidx(i - 1, j, k - 1)], cellVertex[cidx(i - 1, j, k)], cellVertex[cidx(i, j, k)], cellVertex[cidx(i, j, k - 1)], f0 >= 0);
        if (k < resolution && f0 < 0 !== fz < 0)
          quad(cellVertex[cidx(i - 1, j - 1, k)], cellVertex[cidx(i, j - 1, k)], cellVertex[cidx(i, j, k)], cellVertex[cidx(i - 1, j, k)], f0 >= 0);
      }
    }
  }
  return { positions: new Float32Array(pos), normals: new Float32Array(nor), indices: new Uint32Array(tris) };
}
