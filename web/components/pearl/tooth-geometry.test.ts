import { describe, expect, it } from "vitest";

import { frontPoint, sidePoint, toothGeometry, toothSdf } from "./tooth-geometry";

describe("Pearl's tooth shape", () => {
  it("is a closed, symmetric solid of the expected size", () => {
    const g = toothGeometry(48);
    const pos = g.getAttribute("position");
    expect(pos.count).toBeGreaterThan(3000);
    g.computeBoundingBox();
    const b = g.boundingBox!;
    expect(b.max.y).toBeGreaterThan(0.9); // cusps on top
    expect(b.min.y).toBeLessThan(-1.2); // roots below
    expect(Math.abs(b.max.x + b.min.x)).toBeLessThan(0.05); // left/right symmetric
    expect(toothSdf(0, 0, 0)).toBeLessThan(0); // the centre is inside
  });

  it("has a notch between the roots and a dip between the cusps", () => {
    expect(toothSdf(0, -1.15, 0)).toBeGreaterThan(0); // between the root tips: outside
    expect(toothSdf(0.4, -1.1, 0)).toBeLessThan(0); // a root tip: inside
    // The top centre is lower than the cusps.
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
    const shoulder = sidePoint(1, 0);
    expect(shoulder.x).toBeGreaterThan(0.8);
  });
});
