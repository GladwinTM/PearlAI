// Pearl's body for three.js: the SDF in ./tooth-sdf meshed in a Web Worker (surface nets), plus helpers that place the
// face and arms exactly on the surface, so nothing floats or sinks in.

import * as THREE from "three";

import { buildToothMesh, sdfNormal, type ToothMesh, toothSdf } from "./tooth-sdf";

export { toothSdf } from "./tooth-sdf";

/** Outward surface normal at (or near) a point. */
export function toothNormal(x: number, y: number, z: number, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(...sdfNormal(x, y, z));
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

export function geometryFromMesh(mesh: ToothMesh): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(mesh.normals, 3));
  g.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
  g.computeBoundingSphere();
  return g;
}

let pending: Promise<THREE.BufferGeometry> | null = null;

/** Pearl's body mesh, built once per page in a Web Worker (on the main thread only if workers are unavailable). */
export function loadToothGeometry(): Promise<THREE.BufferGeometry> {
  if (!pending) {
    pending = new Promise<ToothMesh>((resolve) => {
      try {
        const worker = new Worker(new URL("./tooth-mesh.worker.ts", import.meta.url), { type: "module" });
        worker.onmessage = (e: MessageEvent<ToothMesh>) => {
          resolve(e.data);
          worker.terminate();
        };
        worker.onerror = () => {
          resolve(buildToothMesh());
          worker.terminate();
        };
        worker.postMessage({});
      } catch {
        resolve(buildToothMesh());
      }
    }).then(geometryFromMesh);
  }
  return pending;
}
