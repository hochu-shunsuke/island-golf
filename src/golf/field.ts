import { hashSeed } from '../core/rng';
import type { Island } from '../island/generate';
import { ISLAND_SIZE } from '../island/grid';
import { Noise2D } from '../world/noise';
import { type CourseDesign, type Ellipse, type HoleDesign, lineDistance } from './design';

/**
 * コースの造成。設計図（golf/design.ts）に合わせて、地面の高さと芝の種類を 2m の格子に焼く。
 *
 * 描く地面は「自然の地形」を「設計した面」へ weight の割合で寄せたもの（world/terrain.ts の heightAt）。
 * 設計した面は、自然の地形を 20m ほどでならした上に、1m 前後のゆるいうねりを足したもの
 * （リンクスの起伏）。そこへティーの台、グリーンの形、バンカーの穴、池の底を刻む。
 *
 * 島は有限なので、島を作るときに 1 度だけ格子に焼いておける（ならす・掘るといった「周りを見る
 * 計算」も普通に書ける）。heightAt は 2m の格子を引くだけなので、チャンクを作る重さはほぼ変わらない。
 * 格子の刻みはチャンクの一番細かい刻み（2m）に揃えてあり、球の地面（heightOnGrid の 2m）とも合う。
 */

/** 格子の中身。Worker 間でそのまま送れる配列だけで持つ。 */
export interface FieldArrays {
  x0: number;
  z0: number;
  step: number;
  nx: number;
  nz: number;
  /** 設計した面の高さ（m）。 */
  height: Float32Array;
  /** 自然の地形を設計した面へ寄せる割合（0..255）。 */
  weight: Uint8Array;
  /** 芝の種類ごとの強さ（0..255）。 */
  fairway: Uint8Array;
  green: Uint8Array;
  tee: Uint8Array;
  sand: Uint8Array;
  /** 回廊のラフ。 */
  rough: Uint8Array;
  /** 林の濃さ（ホールとホールの間を森で埋める）。 */
  forest: Uint8Array;
  /** 木を生やさない強さ（打つ回廊）。 */
  clear: Uint8Array;
  /** 池の水面（m）。池でなければ NaN。 */
  water: Float32Array;
}

/** 格子の刻み（m）。チャンクの一番細かい刻みと同じ。 */
const STEP = 2;
/** ホールの回廊の外に取る余白（m）。回廊の外側で自然の地形へ戻る幅と、ホールの間の林を含む。 */
const MARGIN = 150;
/** ホールの打つ線からこの距離までを林で埋める（外の自然の植生へ溶かす幅も）。 */
const FOREST_NEAR = 70;
const FOREST_FAR = 140;
/** フェアウェイの外のラフの帯（m）と、そこから自然の地形（林）へ戻る幅（m）。 */
const ROUGH = 10;
const BLEND = 16;

function smooth(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** 楕円の中での位置: e < 1 が内側。out は外側へのおおよその距離（m）。 */
function ellipseAt(el: Ellipse, x: number, z: number): { e: number; out: number } {
  const dx = x - el.x;
  const dz = z - el.z;
  const u = dx * el.ax + dz * el.az;
  const v = -dx * el.az + dz * el.ax;
  const e = Math.sqrt((u / el.rx) * (u / el.rx) + (v / el.rz) * (v / el.rz));
  return { e, out: (e - 1) * Math.min(el.rx, el.rz) };
}

/** フェアウェイの半分の幅（打つ線に沿った位置 s で）。区間の外は 0。 */
function fairwayHalf(h: HoleDesign, s: number): number {
  const f = h.fairway;
  if (f.length === 0 || s < f[0].s || s > f[f.length - 1].s) return 0;
  for (let k = 0; k < f.length - 1; k++) {
    if (s <= f[k + 1].s) {
      const t = (s - f[k].s) / (f[k + 1].s - f[k].s || 1);
      return f[k].half + (f[k + 1].half - f[k].half) * t;
    }
  }
  return f[f.length - 1].half;
}

/** 島の格子の高さを、半径 r セルの箱で 2 回ならす（ほぼガウスぼかし）。範囲 [i0, i1) × [j0, j1) だけ。 */
function smoothedHeights(island: Island, i0: number, j0: number, w: number, h: number, r: number): Float32Array {
  const { n, height } = island;
  let a = new Float32Array(w * h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const gi = Math.max(0, Math.min(n - 1, i0 + i));
      const gj = Math.max(0, Math.min(n - 1, j0 + j));
      a[j * w + i] = Math.max(0, height[gj * n + gi]);
    }
  }
  const blur = (src: Float32Array, horizontal: boolean) => {
    const dst = new Float32Array(w * h);
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        let sum = 0;
        let cnt = 0;
        for (let k = -r; k <= r; k++) {
          const ii = horizontal ? i + k : i;
          const jj = horizontal ? j : j + k;
          if (ii < 0 || jj < 0 || ii >= w || jj >= h) continue;
          sum += src[jj * w + ii];
          cnt++;
        }
        dst[j * w + i] = sum / cnt;
      }
    }
    return dst;
  };
  for (let pass = 0; pass < 2; pass++) a = blur(blur(a, true), false);
  return a;
}

/** 設計図から造成の格子を作る（島の Worker で 1 度だけ）。 */
export function buildCourseField(island: Island, design: CourseDesign, seed: string): FieldArrays | null {
  if (design.holes.length === 0) return null;
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const h of design.holes) {
    for (const p of [...h.line, h.green, ...h.ponds, ...h.bunkers]) {
      minX = Math.min(minX, p.x);
      minZ = Math.min(minZ, p.z);
      maxX = Math.max(maxX, p.x);
      maxZ = Math.max(maxZ, p.z);
    }
  }
  const x0 = Math.floor((minX - MARGIN) / STEP) * STEP;
  const z0 = Math.floor((minZ - MARGIN) / STEP) * STEP;
  const nx = Math.ceil((maxX + MARGIN - x0) / STEP) + 1;
  const nz = Math.ceil((maxZ + MARGIN - z0) / STEP) + 1;

  // 自然の地形をならした面（島の格子の上で）。
  const { n, cell } = island;
  const toGrid = (w: number) => (w / ISLAND_SIZE + 0.5) * (n - 1);
  const gi0 = Math.floor(toGrid(x0)) - 6;
  const gj0 = Math.floor(toGrid(z0)) - 6;
  const gw = Math.ceil(toGrid(x0 + nx * STEP)) + 6 - gi0;
  const gh = Math.ceil(toGrid(z0 + nz * STEP)) + 6 - gj0;
  const sm = smoothedHeights(island, gi0, gj0, gw, gh, Math.max(1, Math.round(10 / cell)));
  const smoothAt = (x: number, z: number) => {
    const fx = Math.max(0, Math.min(gw - 1.001, toGrid(x) - gi0));
    const fz = Math.max(0, Math.min(gh - 1.001, toGrid(z) - gj0));
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const u = fx - i;
    const v = fz - j;
    const a = sm[j * gw + i];
    const b = sm[j * gw + i + 1];
    const c = sm[(j + 1) * gw + i];
    const d = sm[(j + 1) * gw + i + 1];
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
  };
  const noise = new Noise2D(hashSeed(`${seed}:rolls`)[0]);
  /** リンクスのうねり（m）。 */
  const rolls = (x: number, z: number) =>
    noise.noise(x / 38, z / 38) * 0.65 + noise.noise(x / 15 + 17.3, z / 15 - 8.1) * 0.22;

  const size = nx * nz;
  const f: FieldArrays = {
    x0,
    z0,
    step: STEP,
    nx,
    nz,
    height: new Float32Array(size),
    weight: new Uint8Array(size),
    fairway: new Uint8Array(size),
    green: new Uint8Array(size),
    tee: new Uint8Array(size),
    sand: new Uint8Array(size),
    rough: new Uint8Array(size),
    forest: new Uint8Array(size),
    clear: new Uint8Array(size),
    water: new Float32Array(size).fill(NaN),
  };
  const byte = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);

  for (let j = 0; j < nz; j++) {
    const z = z0 + j * STEP;
    for (let i = 0; i < nx; i++) {
      const x = x0 + i * STEP;
      const k = j * nx + i;
      // 一番近いホールの回廊（ホールどうしは離して置いてあるので、1 つのホールだけを見る）。
      let hole: HoleDesign | null = null;
      let corridor = 0;
      let at = { d: 0, s: 0 };
      let nearest = Infinity;
      for (const h of design.holes) {
        const l = lineDistance(h.line, x, z);
        nearest = Math.min(nearest, l.d);
        const half = Math.max(fairwayHalf(h, l.s), 14) + ROUGH;
        const c = 1 - smooth(half, half + BLEND, l.d);
        if (c > corridor) {
          corridor = c;
          hole = h;
          at = l;
        }
      }
      const base = smoothAt(x, z) + rolls(x, z);
      // 格子の縁へ向かって林を薄め、外の自然の森へつなぐ（縁で森の濃さが段にならないように）。
      const edge = Math.min(i, j, nx - 1 - i, nz - 1 - j) * STEP;
      const edgeFade = smooth(0, 40, edge);
      // 刈り込みの縁は定規で引いた線にしない（数十 m の波長で 3m ほど揺らす）。
      const wobble = noise.noise(x / 26 + 51.7, z / 26 - 23.9) * 3 + noise.noise(x / 9 - 7.1, z / 9 + 3.3) * 0.7;
      f.height[k] = base;
      f.forest[k] = byte((1 - corridor) * (1 - smooth(FOREST_NEAR, FOREST_FAR, nearest)) * edgeFade);
      if (!hole) continue;

      let h = base;
      let weight = corridor;
      // フェアウェイ。
      const half = fairwayHalf(hole, at.s);
      let fair = half > 0 ? 1 - smooth(half - 1.5 + wobble, half + 1.5 + wobble, at.d) : 0;

      // ティーの台（打つ向きに長い四角、周りへ 4m でつなぐ）。
      const t = hole.tee;
      const tu = (x - t.x) * t.ax + (z - t.z) * t.az;
      const tv = -(x - t.x) * t.az + (z - t.z) * t.ax;
      const tOut = Math.hypot(Math.max(0, Math.abs(tu) - 6), Math.max(0, Math.abs(tv) - 4.5));
      const teeBlend = 1 - smooth(0, 3, tOut);
      h += (t.h - h) * teeBlend;
      const tee = 1 - smooth(0, 0.6, tOut);
      weight = Math.max(weight, teeBlend);

      // グリーン: 傾いた面、台地、すり鉢。周りへ 8m でつなぐ。
      const g = hole.green;
      const ge = ellipseAt(g, x, z);
      const e2 = Math.min(1, ge.e * ge.e);
      const surf = g.h + g.sx * (x - g.x) + g.sz * (z - g.z) - g.bowl * (1 - e2);
      const gBlend = 1 - smooth(0, 8, ge.out);
      h += (surf - h) * gBlend;
      if (g.kind === 'punchbowl') {
        // すり鉢の縁の小山。手前（ティーの側）は開けて、転がして乗せられるようにする。
        const dx = x - g.x;
        const dz = z - g.z;
        const len = Math.hypot(dx, dz) || 1;
        const front = (dx * g.fx + dz * g.fz) / len;
        const open = 1 - smooth(0.2, 0.75, front);
        const ring = smooth(0, 3.5, ge.out) * (1 - smooth(4, 11, ge.out));
        h += 1.2 * ring * open;
      }
      const green = 1 - smooth(-0.4, 0.4, ge.out);
      // グリーンの周りの刈り込み（カラー）はフェアウェイの色。
      fair = Math.max(fair, (1 - smooth(1.5, 3, ge.out)) * (1 - green));
      weight = Math.max(weight, 1 - smooth(8, 12, ge.out));

      // バンカー: 平らな底と斜めの壁。縁は少し盛る。
      let sand = 0;
      for (const b of hole.bunkers) {
        const be = ellipseAt(b, x, z);
        if (be.e > 1.4) continue;
        h -= b.depth * (1 - smooth(0.5, 1, be.e));
        h += 0.25 * smooth(1, 1.1, be.e) * (1 - smooth(1.15, 1.4, be.e));
        sand = Math.max(sand, 1 - smooth(0.9, 1, be.e));
        weight = Math.max(weight, 1 - smooth(1.2, 1.4, be.e));
      }

      // 池: 水面の下に底を掘り、岸は周りへつなぐ。水面は岸の下まで伸ばして地形に隠す。
      for (const p of hole.ponds) {
        const pe = ellipseAt(p, x, z);
        if (pe.e > 1.5) continue;
        const bottom = p.level - 0.45 - 1.3 * (1 - Math.min(1, pe.e * pe.e));
        const bank = smooth(1, 1.4, pe.e);
        h = bottom + (Math.max(h, p.level + 0.35) - bottom) * bank;
        if (pe.e < 1.25) f.water[k] = p.level;
        weight = Math.max(weight, 1 - smooth(1.35, 1.5, pe.e));
        fair *= smooth(0.95, 1.1, pe.e);
      }
      fair *= 1 - sand;

      f.height[k] = h;
      f.weight[k] = byte(weight);
      f.fairway[k] = byte(fair * (1 - green));
      f.green[k] = byte(green);
      f.tee[k] = byte(tee);
      f.sand[k] = byte(sand);
      // 回廊の芝でない所は金色のラフ。縁は揺らして、外の自然の草へ溶かす。
      const cut = Math.max(fair, green, tee, sand);
      f.rough[k] = byte(smooth(0.25, 0.75, corridor + wobble * 0.04) * (1 - cut));
      f.clear[k] = byte(smooth(0.3, 0.6, corridor) + teeBlend);
    }
  }
  return f;
}

/**
 * 造成の格子を引く。heightAt から毎回呼ばれるので、範囲の外は 1 回の比較で抜ける。
 * 値は 4 隅から双一次で補間する（芝の境目もなめらかになる）。
 */
export class CourseField {
  /** sample が最後に引いた値。 */
  fairway = 0;
  green = 0;
  tee = 0;
  sand = 0;
  rough = 0;
  clear = 0;
  forest = 0;

  constructor(readonly a: FieldArrays) {}

  private cellOf(x: number, z: number): { k: number; u: number; v: number } | null {
    const fx = (x - this.a.x0) / this.a.step;
    const fz = (z - this.a.z0) / this.a.step;
    if (fx < 0 || fz < 0 || fx >= this.a.nx - 1 || fz >= this.a.nz - 1) return null;
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    return { k: j * this.a.nx + i, u: fx - i, v: fz - j };
  }

  private lerp(arr: Float32Array | Uint8Array, k: number, u: number, v: number): number {
    const nx = this.a.nx;
    const p = arr[k] * (1 - u) + arr[k + 1] * u;
    const q = arr[k + nx] * (1 - u) + arr[k + nx + 1] * u;
    return p * (1 - v) + q * v;
  }

  /** 自然の地形の高さ h を、設計した面へ寄せた高さ。 */
  blend(x: number, z: number, h: number): number {
    const c = this.cellOf(x, z);
    if (!c) return h;
    const w = this.lerp(this.a.weight, c.k, c.u, c.v) / 255;
    if (w <= 0) return h;
    return h + (this.lerp(this.a.height, c.k, c.u, c.v) - h) * w;
  }

  /** 芝の種類の強さを引いて、fairway・green・tee・sand・clear に入れる。範囲の外なら false。 */
  sample(x: number, z: number): boolean {
    const c = this.cellOf(x, z);
    if (!c) {
      this.fairway = this.green = this.tee = this.sand = this.rough = this.clear = this.forest = 0;
      return false;
    }
    const { k, u, v } = c;
    this.fairway = this.lerp(this.a.fairway, k, u, v) / 255;
    this.green = this.lerp(this.a.green, k, u, v) / 255;
    this.tee = this.lerp(this.a.tee, k, u, v) / 255;
    this.sand = this.lerp(this.a.sand, k, u, v) / 255;
    this.rough = this.lerp(this.a.rough, k, u, v) / 255;
    this.clear = this.lerp(this.a.clear, k, u, v) / 255;
    this.forest = this.lerp(this.a.forest, k, u, v) / 255;
    return true;
  }

  /** 池の水面。池でなければ -Infinity。池の中では一定（4 隅のどれかが池ならその水面）。 */
  waterAt(x: number, z: number): number {
    const c = this.cellOf(x, z);
    if (!c) return -Infinity;
    const w = this.a.water;
    const nx = this.a.nx;
    for (const q of [c.k, c.k + 1, c.k + nx, c.k + nx + 1]) {
      if (!Number.isNaN(w[q])) return w[q];
    }
    return -Infinity;
  }
}
