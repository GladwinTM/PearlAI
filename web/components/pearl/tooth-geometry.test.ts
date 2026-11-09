import * as THREE from "three";
import { describe, expect, it } from "vitest";

import { frontPoint, geometryFromMesh, sidePoint, toothSdf } from "./tooth-geometry";
import { buildToothMesh } from "./tooth-sdf";

describe("Pearl's tooth shape", () => {
  const mesh = buildToothMesh(48);

  it("is a symmetric solid of the expected size, with vertices on the surface", () => {
    const g = geometryFromMesh(mesh);
    expect(mesh.positions.length / 3).toBeGreaterThan(2000);
    g.computeBoundingBox();
    const b = g.boundingBox!;
    expect(b.max.y).toBeGreaterThan(0.9); // cusps on top
    expect(b.min.y).toBeLessThan(-1.2); // roots below
    expect(Math.abs(b.max.x + b.min.x)).toBeLessThan(0.05); // left/right symmetric
    let worst = 0;
    for (let i = 0; i < mesh.positions.length; i += 3) worst = Math.max(worst, Math.abs(toothSdf(mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2])));
    expect(worst).toBeLessThan(0.01);
  });

  it("is watertight and every triangle faces outwards", () => {
    // Watertight: every edge is shared by exactly two triangles.
    const edges = new Map<string, number>();
    const ix = mesh.indices;
    for (let t = 0; t < ix.length; t += 3) {
      for (const [a, b] of [[ix[t], ix[t + 1]], [ix[t + 1], ix[t + 2]], [ix[t + 2], ix[t]]]) {
        const key = a < b ? `${a}-${b}` : `${b}-${a}`;
        edges.set(key, (edges.get(key) ?? 0) + 1);
      }
    }
    expect([...edges.values()].every((c) => c === 2)).toBe(true);
    // Outward: the winding normal agrees with the surface normal.
    const p = (i: number) => new THREE.Vector3(mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2]);
    let agree = 0;
    for (let t = 0; t < ix.length; t += 3) {
      const [a, b, c] = [p(ix[t]), p(ix[t + 1]), p(ix[t + 2])];
      const face = new THREE.Vector3().crossVectors(b.clone().sub(a), c.clone().sub(a));
      const n = new THREE.Vector3(mesh.normals[ix[t] * 3], mesh.normals[ix[t] * 3 + 1], mesh.normals[ix[t] * 3 + 2]);
      if (face.dot(n) > 0) agree++;
    }
    expect(agree / (ix.length / 3)).toBeGreaterThan(0.99);
  });

  it("has a notch between the roots and a dip between the cusps", () => {
    expect(toothSdf(0, -1.15, 0)).toBeGreaterThan(0); // between the root tips: outside
    expect(toothSdf(0.4, -1.1, 0)).toBeLessThan(0); // a root tip: inside
    const top = (x: number) => {
      let y = 1.5;
      while (toothSdf(x, y, 0) > 0) y -= 0.005;
      return y;
    };
    expect(top(0)).toBeLessThan(top(0.44) - 0.03);
  });

  it("places face parts on the front surface and arms on the flanks", () => {
    const eye = frontPoint(0.34, 0.42);
    expect(Math.abs(toothSdf(eye.position.x, eye.position.y, eye.position.z))).toBeLessThan(1e-3);
    expect(eye.normal.z).toBeGreaterThan(0.5); // facing the camera
    expect(sidePoint(1, 0).x).toBeGreaterThan(0.8);
  });
});
