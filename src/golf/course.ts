import { hashSeed, mulberry32 } from '../core/rng';
import type { Island } from '../island/generate';
import { ISLAND_SIZE } from '../island/grid';

/**
 * 島からホールを決める。ティーとグリーンを、平らで乾いた場所に 230〜430m 離して置く。
 *
 * **合言葉とつまみだけで決まる**（島の格子と、合言葉から作った乱数だけを使う）。同じ URL なら
 * 誰が開いても同じホールになる。決定性の決まり（四則演算・sqrt・floor だけ）の内側に置く。
 *
 * グリーンとティーは地形を均し（world/terrain.ts が heightAt で面に寄せる）、フェアウェイと
 * グリーンは刈り込む（色・転がり・木を生やさない）。形はここの関数が 1 つだけ持つ。
 */

export interface Hole {
  tee: { x: number; z: number; h: number };
  pin: { x: number; z: number };
  /** 均したグリーンの面: 中心の高さと、x・z 方向の傾き（m/m）。 */
  green: { h: number; sx: number; sz: number };
  par: number;
  /** ティーからピンまでの水平距離（m）。 */
  length: number;
}

/** グリーンの半径と、周りの地形へつなぐ幅（m）。 */
export const GREEN_RADIUS = 14;
export const GREEN_BLEND = 9;
/** ティーの半径と、つなぐ幅（m）。 */
export const TEE_RADIUS = 5;
export const TEE_BLEND = 4;
/** フェアウェイの半分の幅（m）。ティーからグリーンまでの帯。 */
export const FAIRWAY_HALF = 20;
/** グリーンの傾きの上限（m/m）。本物のグリーンは 1〜3%。 */
const GREEN_SLOPE_MAX = 0.025;

function smooth(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** (x, z) から線分 a-b までの距離と、線分上の位置（0..1）。 */
function toSegment(x: number, z: number, ax: number, az: number, bx: number, bz: number): [number, number] {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / len2));
  const px = ax + dx * t - x;
  const pz = az + dz * t - z;
  return [Math.sqrt(px * px + pz * pz), t];
}

/** 刈り込みの強さ。グリーン・ティー・フェアウェイそれぞれ 0..1。 */
export interface Mown {
  green: number;
  tee: number;
  fairway: number;
}

export function mownAt(hole: Hole, x: number, z: number, out: Mown): Mown {
  const dg = Math.hypot(x - hole.pin.x, z - hole.pin.z);
  out.green = 1 - smooth(GREEN_RADIUS - 1.5, GREEN_RADIUS + 1.5, dg);
  const dt = Math.hypot(x - hole.tee.x, z - hole.tee.z);
  out.tee = 1 - smooth(TEE_RADIUS - 1, TEE_RADIUS + 1, dt);
  const [d] = toSegment(x, z, hole.tee.x, hole.tee.z, hole.pin.x, hole.pin.z);
  out.fairway = (1 - smooth(FAIRWAY_HALF - 3, FAIRWAY_HALF + 3, d)) * (1 - out.green);
  return out;
}

/**
 * 均した高さへ寄せる割合（0..1）と、寄せる先の高さ。グリーンは傾いた面、ティーは水平。
 * 返り値 [重み, 高さ]。重み 0 なら元の地形のまま。
 */
export function flattenAt(hole: Hole, x: number, z: number): [number, number] {
  const dg = Math.hypot(x - hole.pin.x, z - hole.pin.z);
  if (dg < GREEN_RADIUS + GREEN_BLEND) {
    const w = 1 - smooth(GREEN_RADIUS, GREEN_RADIUS + GREEN_BLEND, dg);
    return [w, hole.green.h + hole.green.sx * (x - hole.pin.x) + hole.green.sz * (z - hole.pin.z)];
  }
  const dt = Math.hypot(x - hole.tee.x, z - hole.tee.z);
  if (dt < TEE_RADIUS + TEE_BLEND) {
    return [1 - smooth(TEE_RADIUS, TEE_RADIUS + TEE_BLEND, dt), hole.tee.h];
  }
  return [0, 0];
}

/**
 * ホールを決める。見つからなければ null（島が小さすぎる・全部が山や水など）。
 * 島の細かい格子（高さ・水・気温）だけを見る。
 */
export function pickHole(island: Island, seed: string): Hole | null {
  const { n, cell, height, waterKind, temperature } = island;
  const rand = mulberry32(hashSeed(`${seed}:hole`)[0]);
  const toWorld = (i: number) => (i / (n - 1) - 0.5) * ISLAND_SIZE;
  const at = (i: number, j: number) => height[j * n + i];

  /** 半径 r（格子の点数）の中の高さの幅と、水と寒さ（雪）の有無。 */
  const reach = Math.max(1, Math.round(16 / cell));
  const spotInfo = (i: number, j: number) => {
    let lo = Infinity;
    let hi = -Infinity;
    let wet = false;
    for (let dj = -reach; dj <= reach; dj++) {
      for (let di = -reach; di <= reach; di++) {
        const k = (j + dj) * n + (i + di);
        const h = height[k];
        if (h < lo) lo = h;
        if (h > hi) hi = h;
        if (waterKind[k] !== 0) wet = true;
      }
    }
    return { range: hi - lo, wet };
  };

  interface Spot {
    i: number;
    j: number;
    x: number;
    z: number;
    h: number;
    range: number;
  }
  const spots: Spot[] = [];
  const stride = Math.max(1, Math.round(16 / cell));
  const margin = reach + 2;
  for (let j = margin; j < n - margin; j += stride) {
    for (let i = margin; i < n - margin; i += stride) {
      const k = j * n + i;
      const h = height[k];
      // 浜（砂）より上、高すぎる山の上は避ける。寒い所（雪）も避ける。
      if (h < 4 || h > 260 || temperature[k] < 0.2) continue;
      const info = spotInfo(i, j);
      if (info.wet || info.range > 3.5) continue;
      spots.push({ i, j, x: toWorld(i), z: toWorld(j), h, range: info.range });
    }
  }
  if (spots.length < 2) return null;

  // グリーン: 平らな方から 3 割の中から引く。
  const flat = [...spots].sort((a, b) => a.range - b.range || a.j - b.j || a.i - b.i);
  const greens = flat.slice(0, Math.max(1, Math.floor(flat.length * 0.3)));

  /** ティーからピンまでの線の上の水の割合（川・湖・海）。 */
  const waterAlong = (a: Spot, b: Spot) => {
    const steps = Math.max(4, Math.floor(Math.hypot(b.x - a.x, b.z - a.z) / 8));
    let wet = 0;
    for (let s = 0; s <= steps; s++) {
      const i = Math.round(a.i + ((b.i - a.i) * s) / steps);
      const j = Math.round(a.j + ((b.j - a.j) * s) / steps);
      const k = j * n + i;
      if (waterKind[k] !== 0 || at(i, j) < 0.5) wet++;
    }
    return wet / (steps + 1);
  };

  for (let attempt = 0; attempt < 40; attempt++) {
    const g = greens[Math.floor(rand() * greens.length)];
    const tees = spots.filter((t) => {
      const d = Math.hypot(t.x - g.x, t.z - g.z);
      return d > 230 && d < 430 && t.range < 2.5;
    });
    if (tees.length === 0) continue;
    // ティーは候補を順に試し、水を渡る所が 3 割以下の最初のもの。
    const start = Math.floor(rand() * tees.length);
    for (let q = 0; q < tees.length; q++) {
      const t = tees[(start + q) % tees.length];
      if (waterAlong(t, g) > 0.3) continue;
      return makeHole(island, t, g);
    }
  }
  return null;
}

/** グリーンの面を、元の地形に最小二乗で合わせた傾いた面にする（傾きは上限まで）。 */
function makeHole(
  island: Island,
  t: { x: number; z: number; h: number },
  g: { i: number; j: number; x: number; z: number; h: number },
): Hole {
  const { n, cell, height } = island;
  const r = Math.max(1, Math.round(GREEN_RADIUS / cell));
  let sh = 0;
  let sx = 0;
  let sz = 0;
  let sxx = 0;
  let szz = 0;
  let sxh = 0;
  let szh = 0;
  let count = 0;
  for (let dj = -r; dj <= r; dj++) {
    for (let di = -r; di <= r; di++) {
      if (di * di + dj * dj > r * r) continue;
      const h = height[(g.j + dj) * n + (g.i + di)];
      const x = di * cell;
      const z = dj * cell;
      sh += h;
      sx += x;
      sz += z;
      sxx += x * x;
      szz += z * z;
      sxh += x * h;
      szh += z * h;
      count++;
    }
  }
  const mean = sh / count;
  // 格子が対称なので x と z の傾きは独立に求まる。
  let gx = sxx > 0 ? (sxh - (sx * sh) / count) / sxx : 0;
  let gz = szz > 0 ? (szh - (sz * sh) / count) / szz : 0;
  const slope = Math.sqrt(gx * gx + gz * gz);
  if (slope > GREEN_SLOPE_MAX) {
    gx *= GREEN_SLOPE_MAX / slope;
    gz *= GREEN_SLOPE_MAX / slope;
  }
  const length = Math.hypot(g.x - t.x, g.z - t.z);
  return {
    tee: { x: t.x, z: t.z, h: t.h },
    pin: { x: g.x, z: g.z },
    green: { h: mean, sx: gx, sz: gz },
    par: length < 230 ? 3 : length < 440 ? 4 : 5,
    length,
  };
}
