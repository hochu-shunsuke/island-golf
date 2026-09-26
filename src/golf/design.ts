import { hashSeed, mulberry32 } from '../core/rng';
import type { Island } from '../island/generate';
import { ISLAND_SIZE } from '../island/grid';

/**
 * コースの設計図。**遊ぶ場所を先に決め、地形は後で合わせる**（golf/field.ts が造成する）。
 *
 * 1. 会場を選ぶ: 島の中で、ゴルフに向く土地（海岸に近く、低く、ゆるくうねる所。リンクス）を探す
 * 2. ホールを並べる: 型（テンプレート）ごとに、向き・長さ・曲がる側を振って、土地に一番合う置き方を探す。
 *    前のホールのグリーンのそばに次のティーを置き、打つ線どうしは離す
 * 3. 型がホールの形を決める: 打つ線、フェアウェイの幅、バンカー、池、グリーンの形
 *
 * 型は C.B. Macdonald と Seth Raynor が名ホールから抜き出したもの。
 * - Cape（パー 4）: 曲がり角の内側を池が包む。大胆に角を越えるほど次が短い
 * - Redan（パー 3）: 斜めに奥へ傾いた台地のグリーン。手前の角に深いバンカー
 * - Sahara（パー 5）: 2 打目の落とし所を砂の荒れ地が横切る。越えるか、手前に刻むか
 *
 * 合言葉と島の格子だけで決まる（決定性の決まり: 四則演算・sqrt・floor だけ。三角関数は角度の表から引く）。
 */

export interface Vec2 {
  x: number;
  z: number;
}

/** 楕円（中心・半径 2 つ・向き）。向きは (cos, sin) で持つ（三角関数を生成の中で使わないため）。 */
export interface Ellipse {
  x: number;
  z: number;
  rx: number;
  rz: number;
  /** 長軸（rx の向き）の単位ベクトル。 */
  ax: number;
  az: number;
}

export interface Bunker extends Ellipse {
  depth: number;
}

export interface Pond extends Ellipse {
  /** 水面の高さ（m）。池の中で一定。 */
  level: number;
}

export type GreenKind = 'redan' | 'cape' | 'punchbowl';

export interface GreenDesign extends Ellipse {
  kind: GreenKind;
  /** グリーンの中心の高さ（m）と、x・z 方向の傾き（m/m）。 */
  h: number;
  sx: number;
  sz: number;
  /** 周りより高くした量（台地）。 */
  raise: number;
  /** すり鉢の深さ（Punchbowl）。 */
  bowl: number;
  /** 手前（ティーの側）の向き。すり鉢の縁を開ける側。 */
  fx: number;
  fz: number;
}

export type HoleKind = 'cape' | 'redan' | 'sahara';

export interface HoleDesign {
  number: number;
  kind: HoleKind;
  par: number;
  /** 打つ線（ティー → 曲がり角 → グリーンの中心）。 */
  line: Vec2[];
  tee: { x: number; z: number; h: number; ax: number; az: number };
  pin: Vec2;
  /** ティーショットで狙う所（曲がったホールでは角の手前）。 */
  aim: Vec2;
  green: GreenDesign;
  /** フェアウェイ: 打つ線に沿った距離ごとの半分の幅（m）。区間の外は無し。 */
  fairway: { s: number; half: number }[];
  bunkers: Bunker[];
  ponds: Pond[];
  /** 打つ線に沿ったティーからピンまでの長さ（m）。 */
  length: number;
}

export interface CourseDesign {
  holes: HoleDesign[];
}

/** 向き（16 方向と、曲がりの角度）の表。三角関数を生成の中で呼ばないために、あらかじめ値で持つ。 */
const DIRS: Vec2[] = [
  [1, 0], [0.9238795, 0.3826834], [0.7071068, 0.7071068], [0.3826834, 0.9238795],
  [0, 1], [-0.3826834, 0.9238795], [-0.7071068, 0.7071068], [-0.9238795, 0.3826834],
  [-1, 0], [-0.9238795, -0.3826834], [-0.7071068, -0.7071068], [-0.3826834, -0.9238795],
  [0, -1], [0.3826834, -0.9238795], [0.7071068, -0.7071068], [0.9238795, -0.3826834],
].map(([x, z]) => ({ x, z }));
/** 曲がりの角度: cos と sin（15°・35°・45°）。 */
const TURN = {
  slight: { c: 0.9659258, s: 0.2588190 },
  cape35: { c: 0.8191520, s: 0.5735764 },
  cape45: { c: 0.7071068, s: 0.7071068 },
  redan: { c: 0.8191520, s: 0.5735764 },
};

/** d を side 側（+1 = 右、-1 = 左）へ回す。右は (-dz, dx)。 */
function turn(d: Vec2, side: number, t: { c: number; s: number }): Vec2 {
  const rx = -d.z;
  const rz = d.x;
  return { x: d.x * t.c + rx * side * t.s, z: d.z * t.c + rz * side * t.s };
}

function right(d: Vec2): Vec2 {
  return { x: -d.z, z: d.x };
}

function add(p: Vec2, d: Vec2, k: number): Vec2 {
  return { x: p.x + d.x * k, z: p.z + d.z * k };
}

/** (x, z) から折れ線までの距離と、線に沿った位置（m）。 */
export function lineDistance(line: readonly Vec2[], x: number, z: number): { d: number; s: number } {
  let best = Infinity;
  let bestS = 0;
  let acc = 0;
  for (let k = 0; k < line.length - 1; k++) {
    const a = line[k];
    const b = line[k + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len2 = dx * dx + dz * dz;
    const len = Math.sqrt(len2);
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / (len2 || 1)));
    const px = a.x + dx * t - x;
    const pz = a.z + dz * t - z;
    const d = Math.sqrt(px * px + pz * pz);
    if (d < best) {
      best = d;
      bestS = acc + t * len;
    }
    acc += len;
  }
  return { d: best, s: bestS };
}

/** 折れ線の上で、始まりから s（m）の点。 */
function pointAt(line: readonly Vec2[], s: number): Vec2 {
  let acc = 0;
  for (let k = 0; k < line.length - 1; k++) {
    const a = line[k];
    const b = line[k + 1];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (s <= acc + len || k === line.length - 2) {
      const t = Math.max(0, Math.min(1, (s - acc) / (len || 1)));
      return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
    }
    acc += len;
  }
  return line[line.length - 1];
}

function lineLength(line: readonly Vec2[]): number {
  let acc = 0;
  for (let k = 0; k < line.length - 1; k++) acc += Math.hypot(line[k + 1].x - line[k].x, line[k + 1].z - line[k].z);
  return acc;
}

// ── 会場の土地 ────────────────────────────────────────

/**
 * 島の格子を 16m ごとに見た、ゴルフへの向き不向き（小さいほど良い）と、なめらかにした高さ。
 * 水の中・浜より低い所は使えない（Infinity）。
 */
export class SiteMap {
  readonly n: number;
  readonly step: number;
  readonly cost: Float32Array;
  readonly height: Float32Array;

  constructor(island: Island) {
    const { n: gn, cell, height, waterKind, temperature } = island;
    const stride = Math.max(1, Math.round(16 / cell));
    const n = Math.floor((gn - 1) / stride) + 1;
    this.n = n;
    this.step = (stride * ISLAND_SIZE) / (gn - 1);
    this.cost = new Float32Array(n * n);
    this.height = new Float32Array(n * n);
    const sea = new Uint8Array(n * n);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = j * stride * gn + i * stride;
        this.height[j * n + i] = height[k];
        sea[j * n + i] = height[k] < 0.5 ? 1 : 0;
      }
    }
    // 海からの距離（16m の升目で数える）。リンクスは海岸の近くにある。
    const coast = new Int32Array(n * n).fill(-1);
    const queue: number[] = [];
    for (let k = 0; k < n * n; k++) {
      if (sea[k]) {
        coast[k] = 0;
        queue.push(k);
      }
    }
    for (let q = 0; q < queue.length; q++) {
      const k = queue[q];
      const i = k % n;
      const j = (k - i) / n;
      const next = [i > 0 ? k - 1 : -1, i < n - 1 ? k + 1 : -1, j > 0 ? k - n : -1, j < n - 1 ? k + n : -1];
      for (const m of next) {
        if (m >= 0 && coast[m] < 0) {
          coast[m] = coast[k] + 1;
          queue.push(m);
        }
      }
    }
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        const gi = i * stride;
        const gj = j * stride;
        const gk = gj * gn + gi;
        const h = this.height[k];
        if (h < 2 || waterKind[gk] !== 0 || i === 0 || j === 0 || i === n - 1 || j === n - 1) {
          this.cost[k] = Infinity;
          continue;
        }
        // 周り（±16m）の高低差: 土を動かす量の目安。
        let lo = Infinity;
        let hi = -Infinity;
        for (let dj = -stride; dj <= stride; dj += stride) {
          for (let di = -stride; di <= stride; di += stride) {
            const v = height[(gj + dj) * gn + gi + di];
            if (v < lo) lo = v;
            if (v > hi) hi = v;
          }
        }
        const coastM = coast[k] * this.step;
        this.cost[k] =
          (hi - lo) * 0.8 +
          (temperature[gk] < 0.2 ? 8 : 0) +
          Math.max(0, h - 45) * 0.15 +
          Math.max(0, coastM - 450) / 60;
      }
    }
  }

  private index(x: number, z: number): number {
    const i = Math.round((x / ISLAND_SIZE + 0.5) * (this.n - 1));
    const j = Math.round((z / ISLAND_SIZE + 0.5) * (this.n - 1));
    if (i < 0 || j < 0 || i >= this.n || j >= this.n) return -1;
    return j * this.n + i;
  }

  costAt(x: number, z: number): number {
    const k = this.index(x, z);
    return k < 0 ? Infinity : this.cost[k];
  }

  heightAt(x: number, z: number): number {
    const k = this.index(x, z);
    return k < 0 ? -10 : this.height[k];
  }

  worldOf(k: number): Vec2 {
    const i = k % this.n;
    const j = (k - i) / this.n;
    return { x: (i / (this.n - 1) - 0.5) * ISLAND_SIZE, z: (j / (this.n - 1) - 0.5) * ISLAND_SIZE };
  }
}

// ── 型 ──────────────────────────────────────────────

interface Build {
  tee: Vec2;
  dir: Vec2;
  side: number;
  length: number;
  variant: number;
}

/** 楕円を、長軸の向き a で作る。 */
function ellipse(c: Vec2, rx: number, rz: number, a: Vec2): Ellipse {
  return { x: c.x, z: c.z, rx, rz, ax: a.x, az: a.z };
}

/** 型ごとの長さの候補（m）と、変種（曲がりの角度など）の数。 */
const TEMPLATE: Record<HoleKind, { par: number; lengths: number[]; variants: number }> = {
  cape: { par: 4, lengths: [340, 365, 390], variants: 2 },
  redan: { par: 3, lengths: [150, 165, 180], variants: 1 },
  sahara: { par: 5, lengths: [465, 490, 510], variants: 2 },
};

/**
 * 型からホールの形（高さはまだ無い）を作る。高さは土地が決まってから `settle` で入れる。
 */
function shape(kind: HoleKind, b: Build): Omit<HoleDesign, 'number'> {
  const { tee, dir: d, side, length: L } = b;
  const r = right(d);
  const par = TEMPLATE[kind].par;
  const teeOut = { x: tee.x, z: tee.z, h: 0, ax: d.x, az: d.z };
  if (kind === 'cape') {
    // 曲がり角まで 220m 前後、そこから side 側へ 35° か 45° 曲がる。
    const cornerS = 225;
    const corner = add(tee, d, cornerS);
    const d2 = turn(d, side, b.variant === 0 ? TURN.cape35 : TURN.cape45);
    const g = add(corner, d2, L - cornerS);
    const inside = { x: r.x * side, z: r.z * side };
    // 池は角の内側。ティーから見て角を越える線の上に、角を包むように置く。
    const pondC = add(add(tee, d, cornerS - 30), inside, 38);
    const green = greenEllipse('cape', g, 15, 12, d2);
    return {
      kind,
      par,
      line: [tee, corner, g],
      tee: teeOut,
      pin: add(g, d2, 3),
      aim: add(tee, d, cornerS - 10),
      green,
      fairway: [
        { s: 150, half: 17 },
        { s: 215, half: 25 },
        { s: 260, half: 23 },
        { s: L - 60, half: 16 },
        { s: L - green.rx + 2, half: 13 },
      ],
      bunkers: [
        // 角の外側（安全な側）を狭めるバンカーと、グリーンの奥と内側。
        { ...ellipse(add(add(tee, d, cornerS + 30), inside, -27), 13, 5.5, d), depth: 1.1 },
        { ...ellipse(add(add(g, d2, 16), right(d2), -side * 6), 9, 4, right(d2)), depth: 1.2 },
        { ...ellipse(add(add(g, d2, -6), right(d2), side * 16), 8, 4, d2), depth: 1.3 },
      ],
      ponds: [{ ...ellipse(pondC, 52, 24, d), level: 0 }],
      length: L,
    };
  }
  if (kind === 'redan') {
    // まっすぐ。グリーンは side 側へ斜めに奥へ延び、奥へ下る。手前の side 側に深いバンカー。
    const g = add(tee, d, L);
    const axis = turn(d, side, TURN.redan);
    const green = greenEllipse('redan', g, 21, 10, axis);
    return {
      kind,
      par,
      line: [tee, g],
      tee: teeOut,
      pin: add(g, axis, 7),
      aim: add(g, axis, 4),
      green,
      // 手前の反対側に、転がして乗せる花道（Redan の「蹴り」の斜面）。
      fairway: [
        { s: L - 50, half: 12 },
        { s: L - green.rz - 4, half: 15 },
      ],
      bunkers: [
        { ...ellipse(add(add(g, d, -13), r, side * 9), 13, 4.5, axis), depth: 1.8 },
        { ...ellipse(add(add(g, d, 6), r, -side * 16), 6, 3.5, d), depth: 1.1 },
      ],
      ponds: [],
      length: L,
    };
  }
  // sahara: 280m 付近で少し曲がる（または曲がらない）。ピンの 75〜115m 手前を砂の荒れ地が横切る。
  const bendS = 280;
  const bend = add(tee, d, bendS);
  const d2 = b.variant === 0 ? d : turn(d, side, TURN.slight);
  const g = add(bend, d2, L - bendS);
  const green = greenEllipse('punchbowl', g, 15, 14, d2);
  const r2 = right(d2);
  const wasteS = L - bendS - 95;
  const wasteC = add(bend, d2, wasteS);
  return {
    kind,
    par,
    line: [tee, bend, g],
    tee: teeOut,
    pin: { x: g.x, z: g.z },
    aim: add(tee, d, 235),
    green,
    fairway: [
      { s: 170, half: 18 },
      { s: 240, half: 25 },
      { s: L - 125, half: 22 },
      { s: L - 70, half: 20 },
      { s: L - green.rx + 1, half: 14 },
    ],
    bunkers: [
      // 砂の荒れ地（3 つの楕円を重ねて、横切る帯にする）。
      { ...ellipse(wasteC, 30, 16, r2), depth: 0.9 },
      { ...ellipse(add(add(wasteC, r2, 22), d2, 6), 18, 12, r2), depth: 0.8 },
      { ...ellipse(add(add(wasteC, r2, -24), d2, -5), 17, 11, r2), depth: 0.8 },
      // ティーショットの落とし所を片側から狭めるバンカー。
      { ...ellipse(add(add(tee, d, 235), r, side * 22), 11, 5, d), depth: 1.0 },
    ],
    ponds: [],
    length: L,
  };
}

function greenEllipse(kind: GreenKind, c: Vec2, rx: number, rz: number, axis: Vec2): GreenDesign {
  return { ...ellipse(c, rx, rz, axis), kind, h: 0, sx: 0, sz: 0, raise: 0, bowl: 0, fx: -axis.x, fz: -axis.z };
}

/** 形の上で、土地を見る点（打つ線に沿って 16m ごと、左右に振る）。 */
function samplePoints(h: Omit<HoleDesign, 'number'>): { p: Vec2; w: number }[] {
  const pts: { p: Vec2; w: number }[] = [];
  const L = lineLength(h.line);
  for (let s = 0; s <= L; s += 16) {
    // s の位置と、その向き。
    let acc = 0;
    for (let k = 0; k < h.line.length - 1; k++) {
      const a = h.line[k];
      const b = h.line[k + 1];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      if (s <= acc + len || k === h.line.length - 2) {
        const t = Math.min(1, (s - acc) / len);
        const d = { x: (b.x - a.x) / len, z: (b.z - a.z) / len };
        const c = { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
        const r = right(d);
        for (const off of [-24, -12, 0, 12, 24]) pts.push({ p: add(c, r, off), w: 1 });
        break;
      }
      acc += len;
    }
  }
  // グリーンの周りは重く見る（グリーンは平らな所に置きたい）。
  for (const d of DIRS.filter((_, k) => k % 4 === 0)) pts.push({ p: add(h.green, d, 12), w: 3 });
  pts.push({ p: h.green, w: 3 });
  for (const p of h.ponds) pts.push({ p, w: 2 });
  return pts;
}

// ── 並べる ───────────────────────────────────────────

/** 型の順番（1 番から）。 */
const ORDER: HoleKind[] = ['cape', 'redan', 'sahara'];

interface Placed {
  hole: Omit<HoleDesign, 'number'>;
  cost: number;
}

/**
 * 島にコースを設計する。**陸がある限り必ず全ホールを置く**（土地が悪くても一番ましな所に置き、
 * 足りない所は造成で合わせる）。
 */
export function designCourse(island: Island, seed: string): CourseDesign {
  const rand = mulberry32(hashSeed(`${seed}:links`)[0]);
  const site = new SiteMap(island);
  const limit = ISLAND_SIZE / 2 - 80;

  const holeCost = (h: Omit<HoleDesign, 'number'>, before: readonly Placed[]): number => {
    let cost = 0;
    let count = 0;
    for (const { p, w } of samplePoints(h)) {
      if (Math.abs(p.x) > limit || Math.abs(p.z) > limit) return Infinity;
      const c = site.costAt(p.x, p.z);
      cost += (Number.isFinite(c) ? c : 60) * w;
      count += w;
      // 他のホールの打つ線に近い所は使えない（打ち込み合わないように）。
      for (const o of before) {
        if (lineDistance(o.hole.line, p.x, p.z).d < 52) cost += 40 * w;
      }
    }
    // 坂登りは無し（MacKenzie）。打つ線の上の高低差（途中の丘も含む）を減点。
    let lo = Infinity;
    let hi = -Infinity;
    const L = lineLength(h.line);
    for (let s = 0; s <= L; s += 20) {
      const p = pointAt(h.line, s);
      const v = site.heightAt(p.x, p.z);
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    return cost / count + Math.max(0, hi - lo - 10) * 0.9;
  };

  /** ティーの候補 tees から、型 kind を一番よく置ける形。 */
  const bestHole = (kind: HoleKind, tees: Vec2[], before: readonly Placed[]): Placed | null => {
    const t = TEMPLATE[kind];
    let best: Placed | null = null;
    for (const tee of tees) {
      for (const dir of DIRS) {
        for (const side of [-1, 1]) {
          for (const length of t.lengths) {
            for (let variant = 0; variant < t.variants; variant++) {
              const hole = shape(kind, { tee, dir, side, length, variant });
              // 合言葉の乱数で少し揺らし、ほぼ同じ良さの置き方の中から選ぶ。
              const cost = holeCost(hole, before) + rand() * 0.6;
              if (!best || cost < best.cost) best = { hole, cost };
            }
          }
        }
      }
    }
    return best;
  };

  // 1 番のティーの候補: 周り 150m の土地がゴルフに向いている所（互いに 120m 以上離す）。
  const n = site.n;
  const reach = Math.max(1, Math.round(150 / site.step));
  const heart: { k: number; c: number }[] = [];
  for (let j = reach; j < n - reach; j += 2) {
    for (let i = reach; i < n - reach; i += 2) {
      if (!Number.isFinite(site.cost[j * n + i])) continue;
      let sum = 0;
      let cnt = 0;
      for (let dj = -reach; dj <= reach; dj += 3) {
        for (let di = -reach; di <= reach; di += 3) {
          const c = site.cost[(j + dj) * n + i + di];
          sum += Number.isFinite(c) ? c : 40;
          cnt++;
        }
      }
      heart.push({ k: j * n + i, c: sum / cnt });
    }
  }
  heart.sort((a, b) => a.c - b.c || a.k - b.k);
  const starts: Vec2[] = [];
  for (const h of heart) {
    const p = site.worldOf(h.k);
    if (starts.every((q) => Math.hypot(q.x - p.x, q.z - p.z) >= 120)) starts.push(p);
    if (starts.length >= 12) break;
  }
  if (starts.length === 0) {
    // 陸がほとんど無い島: 一番ましな 1 点から。
    let bestK = 0;
    for (let k = 1; k < site.cost.length; k++) if (site.cost[k] < site.cost[bestK]) bestK = k;
    starts.push(site.worldOf(bestK));
  }

  /** 前のグリーンの周り（30〜55m）から、次のティーの候補。前の打つ線からは離す。 */
  const nextTees = (prev: Placed): Vec2[] => {
    const out: Vec2[] = [];
    for (const d of DIRS) {
      for (const r of [32, 50]) {
        const p = add(prev.hole.green, d, r);
        if (lineDistance(prev.hole.line, p.x, p.z).d < 28) continue;
        out.push(p);
      }
    }
    return out;
  };

  // 1 番の良い置き方を数本残し、それぞれに 2 番・3 番を続けて、合計の一番良いものを採る。
  let bestRoute: Placed[] | null = null;
  let bestTotal = Infinity;
  const firsts: Placed[] = [];
  for (const tee of starts) {
    const p = bestHole(ORDER[0], [tee], []);
    if (p) firsts.push(p);
  }
  firsts.sort((a, b) => a.cost - b.cost);
  for (const first of firsts.slice(0, 4)) {
    const route: Placed[] = [first];
    let total = first.cost;
    for (let k = 1; k < ORDER.length; k++) {
      const next = bestHole(ORDER[k], nextTees(route[k - 1]), route);
      if (!next) break;
      route.push(next);
      total += next.cost;
    }
    if (route.length === ORDER.length && total < bestTotal) {
      bestTotal = total;
      bestRoute = route;
    }
  }
  const route = bestRoute ?? firsts.slice(0, 1);
  return {
    holes: route.map((p, k) => settle({ ...p.hole, number: k + 1 }, site)),
  };
}

/** 土地に合わせて高さを入れる: ティーの台、グリーンの面、池の水面。 */
function settle(h: HoleDesign, site: SiteMap): HoleDesign {
  const ground = (p: Vec2) => site.heightAt(p.x, p.z);
  const teeH = ground(h.tee) + 1.2;
  const g = h.green;
  const gh = ground(g);
  // グリーンの型: Redan は台地で奥へ下る（3%）、Cape は手前へ少し下る（受ける）、Punchbowl はすり鉢。
  let green: GreenDesign;
  if (g.kind === 'redan') {
    green = { ...g, h: gh + 1.1, sx: -g.ax * 0.03, sz: -g.az * 0.03, raise: 1.1 };
  } else if (g.kind === 'cape') {
    green = { ...g, h: gh + 0.5, sx: g.ax * 0.02, sz: g.az * 0.02, raise: 0.5 };
  } else {
    green = { ...g, h: gh - 0.2, bowl: 0.7 };
  }
  // 池の水面: 池の周りの一番低い地面より少し下。海面より十分上でなければ池をやめて砂にする。
  const ponds: Pond[] = [];
  const bunkers = [...h.bunkers];
  for (const p of h.ponds) {
    // 池の中と岸（楕円の 0.6 倍と 1.3 倍の輪）で一番低い地面。
    const a = { x: p.ax, z: p.az };
    const ra = right(a);
    let lo = ground(p);
    for (const d of DIRS) {
      for (const k of [0.6, 1.3]) lo = Math.min(lo, ground(add(add(p, a, d.x * p.rx * k), ra, d.z * p.rz * k)));
    }
    const level = lo - 0.4;
    if (level >= 1.5) ponds.push({ ...p, level });
    else bunkers.push({ ...p, rx: p.rx * 0.8, rz: p.rz * 0.8, depth: 1.0 });
  }
  return { ...h, tee: { ...h.tee, h: teeH }, green, ponds, bunkers };
}
