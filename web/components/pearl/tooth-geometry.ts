// Pearl's body, made in code (no model file): a signed distance field (SDF) of a soft molar (a crown, two cusps and two
// short roots blended like clay) meshed once with marching cubes. The same SDF places the face and arms exactly on the
// surface, so nothing floats or sinks in.

import * as THREE from "three";
import { MarchingCubes } from "three/examples/jsm/objects/MarchingCubes.js";

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

/** Outward surface normal at (or near) a point. */
export function toothNormal(x: number, y: number, z: number, out = new THREE.Vector3()): THREE.Vector3 {
  const e = 1e-3;
  return out
    .set(
      toothSdf(x + e, y, z) - toothSdf(x - e, y, z),
      toothSdf(x, y + e, z) - toothSdf(x, y - e, z),
      toothSdf(x, y, z + e) - toothSdf(x, y, z - e),
    )
    .normalize();
}

/** First surface hit marching from `from` along `dir` (unit). Null if the ray misses. */
function march(from: THREE.Vector3, dir: THREE.Vector3, maxDist = 4): THREE.Vector3 | null {
  let t = 0;
  for (let i = 0; i < 128 && t < maxDist; i++) {
    const p = from.clone().addScaledVector(dir, t);
    const d = toothSdf(p.x, p.y, p.z);
    if (d < 1e-4) return p;
    t += Math.max(d, 1e-3);
  }
  return null;
}

/** The point on the FRONT of the tooth at (x, y), lifted `lift` along the normal. */
export function frontPoint(x: number, y: number, lift = 0): { position: THREE.Vector3; normal: THREE.Vector3 } {
  const hit = march(new THREE.Vector3(x, y, 2), new THREE.Vector3(0, 0, -1)) ?? new THREE.Vector3(x, y, 0.7);
  const normal = toothNormal(hit.x, hit.y, hit.z);
  return { position: hit.addScaledVector(normal, lift), normal };
}

/** The point on the left (side = -1) or right (+1) flank at height y, depth z. */
export function sidePoint(side: -1 | 1, y: number, z = 0): THREE.Vector3 {
  return march(new THREE.Vector3(side * 2, y, z), new THREE.Vector3(-side, 0, 0)) ?? new THREE.Vector3(side * 0.9, y, z);
}

/** Half the size of the cube the mesh is sampled in. */
const EXTENT = 1.6;
let cached: THREE.BufferGeometry | null = null;

/** Pearl's body mesh (built once, ~20k triangles, then cached). Normals come from the SDF, so shading is smooth. */
export function toothGeometry(resolution = 84): THREE.BufferGeometry {
  if (cached) return cached;
  const mc = new MarchingCubes(resolution, new THREE.MeshBasicMaterial(), false, false, 60000);
  const half = resolution / 2;
  for (let z = 0; z < resolution; z++) {
    const wz = ((z - half) / half) * EXTENT;
    for (let y = 0; y < resolution; y++) {
      const wy = ((y - half) / half) * EXTENT;
      for (let x = 0; x < resolution; x++) {
        const wx = ((x - half) / half) * EXTENT;
        // Inside where field > isolation; linear in distance so vertices land on the true surface.
        mc.field[x + y * resolution + z * resolution * resolution] = mc.isolation - toothSdf(wx, wy, wz) * 100;
      }
    }
  }
  mc.update();

  const count = mc.count;
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const n = new THREE.Vector3();
  for (let i = 0; i < count * 3; i += 3) {
    const x = mc.positionArray[i] * EXTENT;
    const y = mc.positionArray[i + 1] * EXTENT;
    const z = mc.positionArray[i + 2] * EXTENT;
    positions.set([x, y, z], i);
    toothNormal(x, y, z, n);
    normals.set([n.x, n.y, n.z], i);
  }
  mc.geometry.dispose();
  (mc.material as THREE.Material).dispose();

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geometry.computeBoundingSphere();
  cached = geometry;
  return geometry;
}
