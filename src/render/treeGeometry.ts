import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mulberry32 } from '../core/rng';

/**
 * 枝構造から広葉樹を作る。形は起動時に一度作り、全チャンクで使い回す。
 */

export const TREE_UP = new THREE.Vector3(0, 1, 0);

/** ジオメトリ全体を単色の頂点カラーで塗る（フラットシェーディング用）。 */
export function paint(
  geo: THREE.BufferGeometry,
  hex: number,
): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const c = new THREE.Color(hex);
  const count = g.getAttribute('position').count;
  const col = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.deleteAttribute('uv');
  g.deleteAttribute('normal');
  return g;
}

export interface TreeParams {
  trunkLength: number;
  trunkRadius: number;
  /** 枝分かれの深さ。2 で 幹→枝→小枝。 */
  levels: number;
  /** 1 段あたりの脇枝の数。主軸はこれとは別に 1 本続く。 */
  splitMin: number;
  splitMax: number;
  lengthRatio: number;
  radiusRatio: number;
  /** 主軸を続けるか。false だと Y 字だけの木になる。 */
  keepLeader: boolean;
  spreadMin: number;
  spreadMax: number;
  growthForce: number;
  gnarliness: number;
  branchFromMin: number;
  branchFromMax: number;
  leafSize: number;
  leafFlatten: number;
  bark: number;
  leaves: readonly number[];
}

/**
 * 遠くの木のための軽い形を作っている間か（withLite）。枝ぶりと葉の位置は同じ乱数で同じに作り、
 * 面の数だけ減らす（葉の塊は二十面体 → 八面体、枝は五角柱 3 段 → 三角柱 1 段、針葉樹の円錐は 7 → 4 分割）。
 */
let lite = false;
export function isLite(): boolean {
  return lite;
}
export function withLite<T>(build: () => T): T {
  lite = true;
  try {
    return build();
  } finally {
    lite = false;
  }
}

/** 1 本の枝を、先細りの角柱として +Y 方向に作る。 */
export function branchGeometry(
  length: number,
  r0: number,
  r1: number,
  curve: number,
): THREE.BufferGeometry {
  const SIDES = lite ? 3 : 5;
  const SEG = curve === 0 || lite ? 1 : 3;
  const pos: number[] = [];
  const ring = (t: number) => {
    const r = r0 + (r1 - r0) * t;
    const off = curve * length * t * t;
    const out: number[][] = [];
    for (let s = 0; s < SIDES; s++) {
      const a = (s / SIDES) * Math.PI * 2;
      out.push([Math.cos(a) * r + off, length * t, Math.sin(a) * r]);
    }
    return out;
  };
  const rings = [];
  for (let i = 0; i <= SEG; i++) rings.push(ring(i / SEG));
  for (let i = 0; i < SEG; i++) {
    const a = rings[i];
    const b = rings[i + 1];
    for (let s = 0; s < SIDES; s++) {
      const t = (s + 1) % SIDES;
      pos.push(...a[s], ...b[s], ...b[t]);
      pos.push(...a[s], ...b[t], ...a[t]);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return g;
}

/** 葉の塊。正二十面体を潰して、角をずらす。 */
function leafGeometry(
  size: number,
  flatten: number,
  salt: number,
): THREE.BufferGeometry {
  // detail=0 の IcosahedronGeometry は最初から非インデックス。
  // 再度 toNonIndexed() を呼ぶと形は変わらないが、木の葉ごとに警告が出る。
  const g = lite ? new THREE.OctahedronGeometry(size, 0) : new THREE.IcosahedronGeometry(size, 0);
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    // 座標から乱数を引く。非インデックスの頂点番号を使うと同じ角が裂ける。
    const key =
      ((Math.round((x / size) * 64) * 73856093) ^
        (Math.round((y / size) * 64) * 19349663) ^
        (Math.round((z / size) * 64) * 83492791) ^
        salt) >>>
      0;
    const s = 0.74 + mulberry32(key)() * 0.5;
    p.setXYZ(i, x * s, y * s * flatten, z * s);
  }
  return g;
}

/** dir に垂直な単位ベクトル。 */
function perpendicular(
  dir: THREE.Vector3,
  out: THREE.Vector3,
): THREE.Vector3 {
  const a =
    Math.abs(dir.y) < 0.9 ? TREE_UP : new THREE.Vector3(1, 0, 0);
  return out.crossVectors(dir, a).normalize();
}

export function buildTree(
  params: TreeParams,
  seed: number,
): THREE.BufferGeometry {
  const rand = mulberry32(seed >>> 0);
  const rr = (lo: number, hi: number) => lo + rand() * (hi - lo);
  const parts: THREE.BufferGeometry[] = [];

  interface Node {
    pos: THREE.Vector3;
    dir: THREE.Vector3;
    length: number;
    radius: number;
    level: number;
  }
  const queue: Node[] = [
    {
      pos: new THREE.Vector3(),
      dir: TREE_UP.clone(),
      length: params.trunkLength,
      radius: params.trunkRadius,
      level: 0,
    },
  ];

  const q = new THREE.Quaternion();
  const axis = new THREE.Vector3();
  const one = new THREE.Vector3(1, 1, 1);

  let guard = 0;
  while (queue.length > 0 && guard++ < 500) {
    const n = queue.shift()!;
    const tip = n.radius * params.radiusRatio;

    const curve =
      (params.gnarliness / (1 + n.radius * 8)) * rr(-1, 1);
    const g = branchGeometry(n.length, n.radius, tip, curve);
    q.setFromUnitVectors(TREE_UP, n.dir);
    const toWorld = new THREE.Matrix4().compose(n.pos, q, one);
    parts.push(paint(g.applyMatrix4(toWorld), params.bark));

    // 曲げた中心線と接線を、子の位置・向きの両方に使う。
    const centerAt = (t: number, out: THREE.Vector3) =>
      out
        .set(curve * n.length * t * t, n.length * t, 0)
        .applyMatrix4(toWorld);
    const tangentAt = (t: number, out: THREE.Vector3) =>
      out
        .set(2 * curve * n.length * t, n.length, 0)
        .normalize()
        .transformDirection(toWorld);

    const tipPos = centerAt(1, new THREE.Vector3());

    const putLeaf = (at: THREE.Vector3, size: number) => {
      const leaf = leafGeometry(
        size,
        params.leafFlatten,
        (rand() * 0xffffff) | 0,
      );
      const shade =
        params.leaves[Math.floor(rand() * params.leaves.length)];
      parts.push(paint(leaf.translate(at.x, at.y, at.z), shade));
    };

    if (n.level >= params.levels) {
      if (params.leafSize > 0) {
        putLeaf(tipPos, params.leafSize * rr(0.78, 1.3));
      }
      continue;
    }

    if (params.leafSize > 0 && n.level > 0) {
      putLeaf(tipPos, params.leafSize * rr(0.7, 1.0));
    }

    const force =
      params.growthForce * (1 - n.level / (params.levels + 1));
    const child = (pitchDeg: number, yawRad: number, from: number) => {
      const base = tangentAt(from, new THREE.Vector3());
      perpendicular(base, axis);
      const dir = base.clone();
      dir.applyAxisAngle(axis, THREE.MathUtils.degToRad(pitchDeg));
      dir.applyAxisAngle(base, yawRad);
      dir.lerp(TREE_UP, force).normalize();
      const pos = centerAt(from, new THREE.Vector3());
      const bury = n.radius * 0.9;
      pos.addScaledVector(dir, -bury);
      queue.push({
        pos,
        dir,
        length:
          n.length * params.lengthRatio * rr(0.82, 1.15) + bury,
        radius: tip * rr(0.82, 1.02),
        level: n.level + 1,
      });
    };

    if (params.keepLeader) {
      child(rr(2, 12), rand() * Math.PI * 2, 1.0);
    }

    const count = Math.round(rr(params.splitMin, params.splitMax));
    const base = rand() * Math.PI * 2;
    for (let i = 0; i < count; i++) {
      child(
        rr(params.spreadMin, params.spreadMax),
        base + (i / count) * Math.PI * 2 + rr(-0.5, 0.5),
        rr(params.branchFromMin, params.branchFromMax),
      );
    }
  }

  return mergeGeometries(parts)!;
}
