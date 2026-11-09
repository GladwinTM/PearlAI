"use client";
/* eslint-disable react-hooks/immutability -- three.js objects are mutated every frame by design (react-three-fiber). */

// Pearl in 3D: a clay/vinyl toy tooth with a face and noodle arms in cartoon gloves. Loaded lazily by ./tooth.tsx
// (three.js stays out of the main bundle). Every part is built in code; colours come from CSS tokens.

import { ContactShadows } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { type RefObject, useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

import { frontPoint, sidePoint, toothGeometry } from "./tooth-geometry";
import type { ToothExpression, ToothMode } from "./types";

export interface ToothSceneProps {
  mode: ToothMode;
  expression: ToothExpression | null;
  level?: RefObject<number>;
  /** On screen and the tab is visible: animate. Otherwise render nothing new. */
  active: boolean;
  /** Reduced motion: a still pose per state, rendered only when something changes. */
  still: boolean;
  onReady?: () => void;
}

// ---------------------------------------------------------------------------------------------------------------------
// Colours (CSS tokens → three.js). oklch() isn't parsed by three, so the browser converts it via a 1px canvas.

const TOKENS = {
  body: ["--tooth", "#fbfaf7"],
  ink: ["--tooth-ink", "#14121f"],
  blush: ["--tooth-blush", "#f4a3d6"],
  glove: ["--tooth-glove", "#ffffff"],
  sparkle: ["--sparkle", "#ffc93c"],
  heart: ["--heart", "#ff7aa8"],
  mouth: ["--tooth-mouth", "#3a1530"],
  tongue: ["--tooth-tongue", "#ff8a9a"],
  shadow: ["--tooth-shadow", "#030e50"],
} as const;
type ColorKey = keyof typeof TOKENS;

function readColors(): Record<ColorKey, THREE.Color> {
  const cs = getComputedStyle(document.documentElement);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const out = {} as Record<ColorKey, THREE.Color>;
  for (const [key, [name, fallback]] of Object.entries(TOKENS) as [ColorKey, readonly [string, string]][]) {
    let rgb: [number, number, number] = [1, 1, 1];
    if (ctx) {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = fallback;
      ctx.fillStyle = cs.getPropertyValue(name).trim() || fallback;
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      rgb = [d[0] / 255, d[1] / 255, d[2] / 255];
    }
    out[key] = new THREE.Color().setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Shapes

function centred(geometry: THREE.BufferGeometry, height: number): THREE.BufferGeometry {
  geometry.computeBoundingBox();
  const b = geometry.boundingBox!;
  const c = b.getCenter(new THREE.Vector3());
  geometry.translate(-c.x, -c.y, -c.z);
  const s = height / (b.max.y - b.min.y);
  geometry.scale(s, s, s);
  return geometry;
}

/** The four-point sparkle with curved, pinched sides. */
function starGeometry(): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  const tip = (i: number) => [Math.cos(Math.PI / 2 + (i * Math.PI) / 2), Math.sin(Math.PI / 2 + (i * Math.PI) / 2)] as const;
  const [x0, y0] = tip(0);
  shape.moveTo(x0, y0);
  for (let i = 0; i < 4; i++) {
    const mid = Math.PI / 2 + (i * Math.PI) / 2 + Math.PI / 4;
    const [x, y] = tip(i + 1);
    shape.quadraticCurveTo(Math.cos(mid) * 0.14, Math.sin(mid) * 0.14, x, y);
  }
  const g = new THREE.ExtrudeGeometry(shape, { depth: 0.18, bevelEnabled: true, bevelThickness: 0.12, bevelSize: 0.08, bevelSegments: 4, curveSegments: 10 });
  return centred(g, 1);
}

function heartGeometry(): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(0, -0.9);
  s.bezierCurveTo(-0.15, -0.75, -1, -0.25, -1, 0.25);
  s.bezierCurveTo(-1, 0.75, -0.45, 0.95, 0, 0.5);
  s.bezierCurveTo(0.45, 0.95, 1, 0.75, 1, 0.25);
  s.bezierCurveTo(1, -0.25, 0.15, -0.75, 0, -0.9);
  const g = new THREE.ExtrudeGeometry(s, { depth: 0.3, bevelEnabled: true, bevelThickness: 0.28, bevelSize: 0.22, bevelSegments: 6, curveSegments: 16 });
  return centred(g, 1);
}

/** The open mouth: a "D" with a flat top. Scaled in y by how open it is. */
function openMouthGeometry(): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(-1, 0);
  s.bezierCurveTo(-1, -1.35, 1, -1.35, 1, 0);
  s.quadraticCurveTo(0, 0.12, -1, 0);
  return new THREE.ShapeGeometry(s, 24);
}

/** A tube through points on the front of the tooth (smile, wavy mouth, closed and squinting eyes). */
function faceLine(points: [number, number][], radius = 0.017): THREE.TubeGeometry {
  const curve = new THREE.CatmullRomCurve3(
    points.map(([x, y]) => frontPoint(x, y, 0.004).position),
    false,
    "catmullrom",
    0.2,
  );
  return new THREE.TubeGeometry(curve, 48, radius, 8, false);
}

const range = (n: number, f: (t: number) => [number, number]) => Array.from({ length: n }, (_, i) => f(i / (n - 1)));

// ---------------------------------------------------------------------------------------------------------------------
// Poses

type Gesture = "rest" | "open" | "peace" | "cup" | "hold";
type V3 = [number, number, number];
interface ArmPose {
  hand: V3;
  elbow: V3; // the curve's second control point: where the noodle bends
  gesture: Gesture;
  twist: number; // turn of the glove around the arm (palm direction)
}
interface Pose {
  lean: number; // forward tilt (listening)
  eyes: "open" | "wink" | "squint";
  eyeScale: number;
  look: [number, number] | null; // fixed gaze (thinking: up); null = follow the cursor
  mouth: "smile" | "wavy" | "talk";
  left: ArmPose;
  right: ArmPose;
  orbit: boolean; // sparkles circling the head
  stars: boolean; // the wink's sparkles
  heart: boolean;
}

const mirror = (a: ArmPose): ArmPose => ({ ...a, hand: [-a.hand[0], a.hand[1], a.hand[2]], elbow: [-a.elbow[0], a.elbow[1], a.elbow[2]], twist: -a.twist });

// Written for the RIGHT arm (viewer's right, +x); mirrored for the left.
const ARM: Record<string, ArmPose> = {
  rest: { hand: [1.12, -0.52, 0.22], elbow: [1.5, -0.02, 0.08], gesture: "rest", twist: 1.4 },
  cup: { hand: [1.14, 0.62, 0.32], elbow: [1.7, -0.35, 0.1], gesture: "cup", twist: -1.3 },
  speak: { hand: [1.48, 0.12, 0.4], elbow: [1.55, -0.6, 0.2], gesture: "open", twist: 0.2 },
  peace: { hand: [1.42, 0.58, 0.25], elbow: [1.5, -0.5, 0.1], gesture: "peace", twist: 0 },
  worried: { hand: [1.02, 0.98, 0.25], elbow: [1.65, -0.05, 0.05], gesture: "open", twist: -1.5 },
  think: { hand: [0.8, -0.1, 0.78], elbow: [1.55, -0.65, 0.45], gesture: "rest", twist: -0.6 },
  heart: { hand: [0.42, -0.5, 1.0], elbow: [1.4, -0.75, 0.55], gesture: "hold", twist: -1.2 },
};

function poseFor(mode: ToothMode, expression: ToothExpression | null): Pose {
  const base: Pose = {
    lean: 0,
    eyes: "open",
    eyeScale: 1,
    look: null,
    mouth: "smile",
    left: mirror(ARM.rest),
    right: ARM.rest,
    orbit: false,
    stars: false,
    heart: false,
  };
  if (expression === "wink") return { ...base, eyes: "wink", left: mirror(ARM.peace), stars: true };
  if (expression === "worried") return { ...base, eyes: "squint", mouth: "wavy", left: mirror(ARM.worried), right: ARM.worried };
  if (expression === "heart") return { ...base, left: mirror(ARM.heart), right: ARM.heart, heart: true };
  if (mode === "listening") return { ...base, lean: 0.16, eyeScale: 1.18, right: ARM.cup };
  if (mode === "thinking") return { ...base, look: [0.45, 1], left: mirror(ARM.think), orbit: true };
  if (mode === "speaking") return { ...base, mouth: "talk", right: ARM.speak };
  return base;
}

// Finger lengths / curls / spreads (index nearest the thumb) and thumb curl, per gesture.
const HAND: Record<Gesture, { len: V3; curl: V3; spread: V3; thumb: number }> = {
  rest: { len: [0.62, 0.62, 0.6], curl: [1.0, 1.0, 1.0], spread: [0.14, 0, -0.14], thumb: 0.55 },
  open: { len: [1, 1.08, 0.95], curl: [0.05, 0.05, 0.08], spread: [0.32, 0.02, -0.3], thumb: 0 },
  peace: { len: [1.15, 1.15, 0.4], curl: [0, 0, 1.35], spread: [0.5, -0.32, -0.1], thumb: 1 },
  cup: { len: [0.95, 0.95, 0.9], curl: [0.75, 0.75, 0.75], spread: [0.12, 0, -0.12], thumb: 0.55 },
  hold: { len: [0.75, 0.75, 0.72], curl: [1.1, 1.1, 1.1], spread: [0.1, 0, -0.1], thumb: 0.85 },
};

// ---------------------------------------------------------------------------------------------------------------------
// Arms: a noodle tube rebuilt in place every frame (same vertex layout as TubeGeometry), ending in a glove.

const ARM_SEGMENTS = 40;
const ARM_RADIAL = 8;
const ARM_RADIUS = 0.034;

function writeTube(geometry: THREE.TubeGeometry, curve: THREE.Curve<THREE.Vector3>) {
  const frames = curve.computeFrenetFrames(ARM_SEGMENTS, false);
  const pos = geometry.getAttribute("position") as THREE.BufferAttribute;
  const nor = geometry.getAttribute("normal") as THREE.BufferAttribute;
  const p = new THREE.Vector3();
  let k = 0;
  for (let i = 0; i <= ARM_SEGMENTS; i++) {
    curve.getPointAt(i / ARM_SEGMENTS, p);
    const N = frames.normals[i];
    const B = frames.binormals[i];
    for (let j = 0; j <= ARM_RADIAL; j++) {
      const v = (j / ARM_RADIAL) * Math.PI * 2;
      const sin = Math.sin(v);
      const cos = -Math.cos(v);
      const nx = cos * N.x + sin * B.x;
      const ny = cos * N.y + sin * B.y;
      const nz = cos * N.z + sin * B.z;
      nor.setXYZ(k, nx, ny, nz);
      pos.setXYZ(k, p.x + ARM_RADIUS * nx, p.y + ARM_RADIUS * ny, p.z + ARM_RADIUS * nz);
      k++;
    }
  }
  pos.needsUpdate = true;
  nor.needsUpdate = true;
}

interface Glove {
  root: THREE.Group; // placed at the wrist, +y along the arm
  fingers: THREE.Group[];
  thumb: THREE.Group;
  current: { len: V3; curl: V3; spread: V3; thumb: number };
}

function makeGlove(material: THREE.Material, mirrorX: boolean): Glove {
  const root = new THREE.Group();
  const hand = new THREE.Group();
  if (mirrorX) hand.scale.x = -1;
  root.add(hand);

  const cuff = new THREE.Mesh(new THREE.TorusGeometry(0.078, 0.034, 10, 24), material);
  cuff.rotation.x = Math.PI / 2;
  cuff.position.y = 0.0;
  const palm = new THREE.Mesh(new THREE.SphereGeometry(0.12, 24, 18), material);
  palm.scale.set(1.05, 0.95, 0.72);
  palm.position.y = 0.11;
  hand.add(cuff, palm);

  const fingerGeo = new THREE.CapsuleGeometry(0.036, 0.09, 6, 12).translate(0, 0.081, 0);
  const fingers = [0.068, 0, -0.068].map((x) => {
    const pivot = new THREE.Group();
    pivot.position.set(x, 0.17, 0);
    pivot.add(new THREE.Mesh(fingerGeo, material));
    hand.add(pivot);
    return pivot;
  });
  const thumb = new THREE.Group();
  thumb.position.set(0.1, 0.08, 0.03);
  thumb.add(new THREE.Mesh(fingerGeo, material));
  hand.add(thumb);
  const h = HAND.rest;
  return { root, fingers, thumb, current: { len: [...h.len], curl: [...h.curl], spread: [...h.spread], thumb: h.thumb } };
}

function poseGlove(g: Glove, gesture: Gesture, k: number) {
  const t = HAND[gesture];
  for (let i = 0; i < 3; i++) {
    g.current.len[i] += (t.len[i] - g.current.len[i]) * k;
    g.current.curl[i] += (t.curl[i] - g.current.curl[i]) * k;
    g.current.spread[i] += (t.spread[i] - g.current.spread[i]) * k;
    const f = g.fingers[i];
    f.scale.set(1, g.current.len[i], 1);
    f.rotation.set(g.current.curl[i], 0, -g.current.spread[i]); // positive spread splays away from the middle finger
  }
  g.current.thumb += (t.thumb - g.current.thumb) * k;
  g.thumb.rotation.set(g.current.thumb * 0.9, 0, -1.15 + g.current.thumb * 0.45);
  g.thumb.scale.set(1, 0.8, 1);
}

// ---------------------------------------------------------------------------------------------------------------------
// The character

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);
const EYE_Y = 0.42;
const EYE_X = 0.34;
const MOUTH_Y = 0.2;

function onSurface(obj: THREE.Object3D, x: number, y: number, lift: number) {
  const { position, normal } = frontPoint(x, y, lift);
  obj.position.copy(position);
  obj.quaternion.setFromUnitVectors(Z_AXIS, normal);
}

function Pearl({ mode, expression, level, still, onReady }: Omit<ToothSceneProps, "active">) {
  const invalidate = useThree((s) => s.invalidate);
  const root = useRef<THREE.Group>(null);

  // Everything built once.
  const built = useMemo(() => {
    const colors = readColors();
    const mats = {
      body: new THREE.MeshPhysicalMaterial({ color: colors.body, roughness: 0.52, sheen: 0.6, sheenRoughness: 0.45, sheenColor: new THREE.Color("#ffffff"), clearcoat: 0.12, clearcoatRoughness: 0.5 }),
      ink: new THREE.MeshPhysicalMaterial({ color: colors.ink, roughness: 0.14, clearcoat: 1, clearcoatRoughness: 0.08 }),
      line: new THREE.MeshStandardMaterial({ color: colors.ink, roughness: 0.4 }),
      blush: new THREE.MeshStandardMaterial({ color: colors.blush, roughness: 1, transparent: true, opacity: 0.85, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }),
      glove: new THREE.MeshPhysicalMaterial({ color: colors.glove, roughness: 0.55, sheen: 0.5, sheenRoughness: 0.5, sheenColor: new THREE.Color("#ffffff") }),
      sparkle: new THREE.MeshPhysicalMaterial({ color: colors.sparkle, roughness: 0.3, clearcoat: 0.6, emissive: colors.sparkle, emissiveIntensity: 0.12 }),
      heart: new THREE.MeshPhysicalMaterial({ color: colors.heart, roughness: 0.35, clearcoat: 0.7, clearcoatRoughness: 0.2 }),
      mouth: new THREE.MeshStandardMaterial({ color: colors.mouth, roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -2 }),
      tongue: new THREE.MeshStandardMaterial({ color: colors.tongue, roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -3 }),
      highlight: new THREE.MeshBasicMaterial({ color: "#ffffff" }),
    };

    const body = new THREE.Mesh(toothGeometry(), mats.body);

    // Eyes: an anchor on the surface → a gaze group that shifts → the glossy bead + its highlight.
    const eyes = ([-1, 1] as const).map((side) => {
      const anchor = new THREE.Group();
      onSurface(anchor, side * EYE_X, EYE_Y, -0.025);
      const gaze = new THREE.Group();
      const bead = new THREE.Mesh(new THREE.SphereGeometry(0.095, 32, 24), mats.ink);
      bead.scale.set(1, 1.18, 0.55);
      const shine = new THREE.Mesh(new THREE.SphereGeometry(0.024, 12, 10), mats.highlight);
      shine.position.set(0.032, 0.05, 0.05);
      gaze.add(bead, shine);
      anchor.add(gaze);
      return { anchor, gaze, bead, shine };
    });
    // The wink (viewer's left eye): a happy arc. Squint: ">" and "<".
    const winkArc = new THREE.Mesh(faceLine(range(12, (t) => [-EYE_X - 0.1 + t * 0.2, EYE_Y - 0.02 + 0.07 * (1 - (2 * t - 1) ** 2)])), mats.line);
    const squintL = new THREE.Mesh(faceLine([[-EYE_X - 0.08, EYE_Y + 0.07], [-EYE_X + 0.06, EYE_Y], [-EYE_X - 0.08, EYE_Y - 0.07]]), mats.line);
    const squintR = new THREE.Mesh(faceLine([[EYE_X + 0.08, EYE_Y + 0.07], [EYE_X - 0.06, EYE_Y], [EYE_X + 0.08, EYE_Y - 0.07]]), mats.line);

    const blush = ([-1, 1] as const).map((side) => {
      const m = new THREE.Mesh(new THREE.CircleGeometry(0.1, 32), mats.blush);
      onSurface(m, side * 0.57, 0.22, 0.006);
      m.scale.set(1.3, 0.95, 1);
      return m;
    });

    const smile = new THREE.Mesh(faceLine(range(14, (t) => [-0.16 + t * 0.32, MOUTH_Y + 0.02 - 0.085 * (1 - (2 * t - 1) ** 2)])), mats.line);
    const wavy = new THREE.Mesh(faceLine(range(24, (t) => [-0.17 + t * 0.34, MOUTH_Y - 0.01 + 0.03 * Math.sin(t * Math.PI * 4.5)])), mats.line);
    const talk = new THREE.Group();
    onSurface(talk, 0, MOUTH_Y + 0.02, 0.008);
    const talkInner = new THREE.Group();
    const hole = new THREE.Mesh(openMouthGeometry(), mats.mouth);
    hole.scale.set(0.15, 0.15, 1);
    const tongue = new THREE.Mesh(new THREE.CircleGeometry(0.06, 24), mats.tongue);
    tongue.scale.set(1.3, 0.7, 1);
    tongue.position.set(0, -0.11, 0.002);
    talkInner.add(hole, tongue);
    talk.add(talkInner);

    // Arms
    const shoulders = ([-1, 1] as const).map((side) => sidePoint(side, -0.05, 0.1).add(new THREE.Vector3(-side * 0.05, 0, 0)));
    const arms = ([-1, 1] as const).map((side, i) => {
      const s = shoulders[i];
      const curve = new THREE.CubicBezierCurve3(s.clone(), s.clone(), s.clone(), s.clone());
      const geometry = new THREE.TubeGeometry(
        new THREE.CubicBezierCurve3(s, s.clone().add(new THREE.Vector3(side * 0.3, 0, 0)), s.clone().add(new THREE.Vector3(side * 0.6, -0.2, 0)), s.clone().add(new THREE.Vector3(side * 0.3, -0.5, 0))),
        ARM_SEGMENTS,
        ARM_RADIUS,
        ARM_RADIAL,
        false,
      );
      const mesh = new THREE.Mesh(geometry, mats.line);
      mesh.frustumCulled = false;
      const glove = makeGlove(mats.glove, side === -1);
      const pose = side === -1 ? mirror(ARM.rest) : ARM.rest;
      return { side, shoulder: s, curve, geometry, mesh, glove, hand: new THREE.Vector3(...pose.hand), elbow: new THREE.Vector3(...pose.elbow), twist: pose.twist };
    });

    // Sparkles: 3 orbiting (thinking), 3 beside the wink, 8 for the booking burst.
    const starGeo = starGeometry();
    const stars = Array.from({ length: 14 }, () => {
      const m = new THREE.Mesh(starGeo, mats.sparkle);
      m.scale.setScalar(0);
      return m;
    });
    const heart = new THREE.Mesh(heartGeometry(), mats.heart);
    heart.scale.setScalar(0);
    heart.position.set(0, -0.48, 1.08);

    return { colors, mats, body, eyes, winkArc, squintL, squintR, blush, smile, wavy, talk, talkInner, arms, stars, heart, starGeo };
  }, []);

  // Theme switches may change the tokens.
  useEffect(() => {
    const apply = () => {
      const c = readColors();
      const m = built.mats;
      m.body.color.copy(c.body);
      m.ink.color.copy(c.ink);
      m.line.color.copy(c.ink);
      m.blush.color.copy(c.blush);
      m.glove.color.copy(c.glove);
      m.sparkle.color.copy(c.sparkle);
      m.sparkle.emissive.copy(c.sparkle);
      m.heart.color.copy(c.heart);
      m.mouth.color.copy(c.mouth);
      m.tongue.color.copy(c.tongue);
      invalidate();
    };
    const mo = new MutationObserver(apply);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
    return () => mo.disconnect();
  }, [built, invalidate]);

  useEffect(
    () => () => {
      Object.values(built.mats).forEach((m) => m.dispose());
      built.starGeo.dispose();
      built.arms.forEach((a) => a.geometry.dispose());
    },
    [built],
  );

  // The cursor, relative to the tooth (−1..1).
  const pointer = useRef({ x: 0, y: 0 });
  const gl = useThree((s) => s.gl);
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const r = gl.domElement.getBoundingClientRect();
      pointer.current.x = Math.max(-1, Math.min(1, (e.clientX - (r.left + r.width / 2)) / (window.innerWidth / 2)));
      pointer.current.y = Math.max(-1, Math.min(1, -(e.clientY - (r.top + r.height / 2)) / (window.innerHeight / 2)));
    };
    window.addEventListener("pointermove", move, { passive: true });
    return () => window.removeEventListener("pointermove", move);
  }, [gl]);

  // Redraw on change when only rendering on demand (reduced motion).
  useEffect(() => invalidate(), [mode, expression, still, invalidate]);

  // Animated values.
  const anim = useRef({
    level: 0,
    lean: 0,
    eyeScale: 1,
    lookX: 0,
    lookY: 0,
    open: 0,
    nextBlink: 1.5,
    blinkAt: -1,
    orbit: 0,
    stars: 0,
    heart: 0,
    wobble: 0,
    burstAt: -10,
    lastExpression: null as ToothExpression | null,
    readied: false,
  });

  const tmp = useMemo(() => ({ q: new THREE.Quaternion(), q2: new THREE.Quaternion(), v: new THREE.Vector3(), c1: new THREE.Vector3() }), []);

  useFrame((state, dt) => {
    const a = anim.current;
    const t = still ? 0 : state.clock.elapsedTime;
    const k = still ? 1 : 1 - Math.exp(-Math.min(dt, 0.05) * 9);
    const pose = poseFor(mode, expression);

    // Audio level (mic while listening, Pearl's voice while speaking).
    const raw = still ? (mode === "speaking" ? 0.5 : 0) : mode === "listening" || mode === "speaking" ? Math.min(1, (level?.current ?? 0) * 2.2) : 0;
    a.level += (raw - a.level) * (still ? 1 : Math.min(1, dt * (raw > a.level ? 18 : 7)));
    const l = a.level;

    // Whole body: float, breathe, lean, squash with the mic, bounce when talking, wobble when thinking.
    const g = root.current!;
    const follow = still || pose.look ? { x: 0, y: 0 } : pointer.current;
    a.lean += (pose.lean - a.lean) * k;
    a.wobble += ((mode === "thinking" && !expression ? 1 : 0) - a.wobble) * k;
    const shiver = expression === "worried" && !still ? Math.sin(t * 38) * 0.012 : 0;
    g.position.set(shiver, Math.sin(t * 1.3) * 0.06 + (mode === "speaking" ? l * 0.06 : 0) - 0.1, 0);
    g.rotation.set(a.lean - follow.y * 0.12, follow.x * 0.32, Math.sin(t * 2.6) * 0.06 * a.wobble);
    const breathe = Math.sin(t * 1.1) * 0.012;
    const squash = mode === "listening" ? l * 0.08 : 0;
    g.scale.set(1 - squash * 0.5 - breathe * 0.5, 1 + squash + breathe, 1 - squash * 0.5 - breathe * 0.5);

    // Eyes: gaze, size, blinks; wink and squint swap in their own shapes.
    const look = pose.look ?? [follow.x, follow.y];
    a.lookX += (look[0] - a.lookX) * k;
    a.lookY += (look[1] - a.lookY) * k;
    a.eyeScale += (pose.eyeScale - a.eyeScale) * k;
    if (!still && t > a.nextBlink) {
      a.blinkAt = t;
      a.nextBlink = t + 2.2 + Math.random() * 3.2;
    }
    const bt = (t - a.blinkAt) / 0.16;
    const blink = bt >= 0 && bt <= 1 ? Math.sin(bt * Math.PI) : 0;
    built.eyes.forEach((e, i) => {
      const hidden = pose.eyes === "squint" || (pose.eyes === "wink" && i === 0);
      e.anchor.visible = !hidden;
      e.gaze.position.set(a.lookX * 0.035, a.lookY * 0.03, 0);
      e.bead.scale.set(a.eyeScale, 1.18 * a.eyeScale * (1 - blink * 0.9), 0.55);
      e.shine.visible = blink < 0.5;
    });
    built.winkArc.visible = pose.eyes === "wink";
    built.squintL.visible = built.squintR.visible = pose.eyes === "squint";

    // Mouth: smile / wavy / open with the voice.
    const targetOpen = pose.mouth === "talk" ? (still ? 0.55 : Math.min(1, 0.12 + l * 1.25)) : 0;
    a.open += (targetOpen - a.open) * (still ? 1 : Math.min(1, dt * 22));
    const talking = pose.mouth === "talk" && a.open > 0.14;
    built.smile.visible = pose.mouth === "smile" || (pose.mouth === "talk" && !talking);
    built.wavy.visible = pose.mouth === "wavy";
    built.talk.visible = talking;
    built.talkInner.scale.set(0.85 + a.open * 0.25, a.open, 1);

    // Arms and gloves.
    for (const arm of built.arms) {
      const target = arm.side === -1 ? pose.left : pose.right;
      const sway = still ? 0 : Math.sin(t * 1.7 + arm.side) * 0.03;
      const speakBob = mode === "speaking" && arm.side === 1 && !expression ? l * 0.18 : 0;
      arm.hand.lerp(tmp.v.set(target.hand[0], target.hand[1] + sway + speakBob, target.hand[2]), k);
      arm.elbow.lerp(tmp.v.set(...target.elbow), k);
      arm.twist += (target.twist - arm.twist) * k;
      const s = arm.shoulder;
      arm.curve.v0.copy(s);
      arm.curve.v1.copy(s).add(tmp.c1.set(arm.side * 0.32, 0.06, 0.02));
      arm.curve.v2.copy(arm.elbow);
      arm.curve.v3.copy(arm.hand);
      arm.curve.updateArcLengths(); // the cached lengths are stale after moving the points
      writeTube(arm.geometry, arm.curve);
      const tangent = arm.curve.getTangentAt(1, tmp.v);
      tmp.q.setFromUnitVectors(Y_AXIS, tangent);
      tmp.q2.setFromAxisAngle(Y_AXIS, arm.twist);
      arm.glove.root.position.copy(arm.hand);
      arm.glove.root.quaternion.copy(tmp.q).multiply(tmp.q2);
      poseGlove(arm.glove, target.gesture, k);
    }

    // Sparkles.
    a.orbit += ((pose.orbit ? 1 : 0) - a.orbit) * k;
    a.stars += ((pose.stars ? 1 : 0) - a.stars) * k;
    if (expression === "wink" && a.lastExpression !== "wink") a.burstAt = state.clock.elapsedTime;
    a.lastExpression = expression;
    const orbiters = built.stars.slice(0, 3);
    orbiters.forEach((m, i) => {
      const ang = t * 1.5 + (i * Math.PI * 2) / 3;
      m.position.set(Math.cos(ang) * 1.1, 1.22 + Math.sin(ang * 2) * 0.07, Math.sin(ang) * 0.55);
      m.rotation.set(0, 0, t * 2 + i);
      m.scale.setScalar(a.orbit * (0.15 + 0.03 * Math.sin(t * 5 + i)));
    });
    const winkStars: [V3, number][] = [
      [[-1.22, 1.22, 0.2], 0.26],
      [[-0.78, 1.42, 0.12], 0.15],
      [[-1.5, 0.92, 0.3], 0.13],
    ];
    built.stars.slice(3, 6).forEach((m, i) => {
      const [p, size] = winkStars[i];
      m.position.set(...p);
      m.rotation.set(0, 0, Math.sin(t * 2 + i) * 0.2);
      m.scale.setScalar(a.stars * size * (1 + 0.08 * Math.sin(t * 6 + i * 2)));
    });
    const age = still ? 1 : state.clock.elapsedTime - a.burstAt;
    const hand = built.arms[0].hand;
    built.stars.slice(6).forEach((m, i) => {
      const live = age < 1;
      m.visible = live;
      if (!live) return;
      const ang = (i / 8) * Math.PI * 2 + 0.3;
      const r = 0.15 + age * 1.1;
      m.position.set(hand.x + Math.cos(ang) * r, hand.y + 0.2 + Math.sin(ang) * r, hand.z + 0.2);
      m.rotation.set(0, 0, age * 6 + i);
      m.scale.setScalar(0.12 * Math.sin(Math.min(1, age) * Math.PI));
    });

    // The heart (thank you / goodbye).
    a.heart += ((pose.heart ? 1 : 0) - a.heart) * k;
    built.heart.scale.setScalar(a.heart * (0.6 + (still ? 0 : 0.03 * Math.sin(t * 4))));
    built.heart.rotation.set(0.15, Math.sin(t * 1.5) * 0.15, 0);

    if (!a.readied) {
      a.readied = true;
      onReady?.();
    }
  });

  return (
    <group ref={root}>
      <primitive object={built.body} />
      {built.eyes.map((e, i) => (
        <primitive key={`eye${i}`} object={e.anchor} />
      ))}
      <primitive object={built.winkArc} />
      <primitive object={built.squintL} />
      <primitive object={built.squintR} />
      {built.blush.map((b, i) => (
        <primitive key={`blush${i}`} object={b} />
      ))}
      <primitive object={built.smile} />
      <primitive object={built.wavy} />
      <primitive object={built.talk} />
      {built.arms.map((arm) => (
        <group key={arm.side}>
          <primitive object={arm.mesh} />
          <primitive object={arm.glove.root} />
        </group>
      ))}
      {built.stars.map((s, i) => (
        <primitive key={`star${i}`} object={s} />
      ))}
      <primitive object={built.heart} />
    </group>
  );
}

/** Soft studio reflections, generated in code (no HDR download). */
function Studio() {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  useEffect(() => {
    const pmrem = new THREE.PMREMGenerator(gl);
    const room = new RoomEnvironment();
    const env = pmrem.fromScene(room, 0.04).texture;
    scene.environment = env;
    scene.environmentIntensity = 0.55;
    return () => {
      scene.environment = null;
      env.dispose();
      room.dispose();
      pmrem.dispose();
    };
  }, [gl, scene]);
  return null;
}

export default function ToothScene({ active, still, ...rest }: ToothSceneProps) {
  const shadow = useMemo(() => (typeof window === "undefined" ? "#030e50" : `#${readColors().shadow.getHexString(THREE.SRGBColorSpace)}`), []);
  return (
    <Canvas
      aria-hidden
      dpr={[1, 2]}
      frameloop={active ? (still ? "demand" : "always") : "never"}
      camera={{ position: [0, 0.15, 7.4], fov: 30 }}
      gl={{ antialias: true, alpha: true, powerPreference: "low-power" }}
      onCreated={({ camera }) => camera.lookAt(0, -0.12, 0)}
      style={{ position: "absolute", inset: 0 }}
    >
      <hemisphereLight args={["#eef4ff", "#c9b8a6", 0.9]} />
      <directionalLight position={[-3, 4, 5]} intensity={1.5} />
      <directionalLight position={[3.5, 2, -4]} intensity={0.9} color="#cfe0ff" />
      <Studio />
      <Pearl {...rest} still={still} />
      <ContactShadows position={[0, -1.62, 0]} scale={4.5} blur={2.6} opacity={0.32} far={2.6} resolution={256} color={shadow} />
    </Canvas>
  );
}
