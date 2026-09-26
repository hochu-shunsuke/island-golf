import { hashSeed, mulberry32 } from '../core/rng';
import type { Island } from '../island/generate';
import { ISLAND_SIZE } from '../island/grid';

/**
 * 島に立てる旗（ホール）。2 種類ある。
 *
 * - **おすすめの旗**（コースのホール）: 島を作るときに `pickCourse` が決める。ティーとグリーンを
 *   均し、その間を刈ってフェアウェイにする。合言葉とつまみだけで決まるので、同じ URL なら
 *   誰が開いても同じ場所に立つ（決定性の決まり: 四則演算・sqrt・floor だけ）
 * - **自分の旗**: 遊んでいる人が見ている所に立てる（`makeFlag`）。グリーンだけを均す
 *
 * 地形を均す形と刈り込む形は `CourseShape` 1 つが持つ。描く面（world/terrain.ts）、島の格子
 * （island/worker.ts）、木を生やさない判定、球が転がる地面の種類が、みなここを見る。
 */

export interface Hole {
  /** コースの番号（1 から）。自分の旗は 0。 */
  number: number;
  /** ティー。自分の旗には無い（球を置いた所から打つ）。 */
  tee: { x: number; z: number; h: number } | null;
  pin: { x: number; z: number };
  /** 均したグリーン: 中心の高さ、x・z 方向の傾き（m/m）、半径と周りへつなぐ幅（m）。 */
  green: { h: number; sx: number; sz: number; radius: number; blend: number };
  /** パー。自分の旗は 0。 */
  par: number;
  /** ティーからピンまでの水平距離（m）。自分の旗は 0。 */
  length: number;
}

/** コースのグリーンの半径と、周りの地形へつなぐ幅（m）。 */
export const GREEN_RADIUS = 14;
export const GREEN_BLEND = 9;
/** 自分の旗のグリーン（小さめ）。 */
export const FLAG_RADIUS = 9;
export const FLAG_BLEND = 7;
/** ティーの半径と、つなぐ幅（m）。 */
export const TEE_RADIUS = 5;
export const TEE_BLEND = 4;
/** フェアウェイの半分の幅（m）。ティーからグリーンまでの帯。 */
export const FAIRWAY_HALF = 20;
/** グリーンの傾きの上限（m/m）。本物のカップの周りは 2〜3%。 */
const GREEN_SLOPE_MAX = 0.025;
/** コースのホールの数の上限。 */
const MAX_HOLES = 9;

function smooth(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** (x, z) から線分 a-b までの距離。 */
function segmentDistance(x: number, z: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / len2));
  const px = ax + dx * t - x;
  const pz = az + dz * t - z;
  return Math.sqrt(px * px + pz * pz);
}

/** 線分 a-b と c-d が交わるか。 */
function segmentsCross(
  ax: number, az: number, bx: number, bz: number,
  cx: number, cz: number, dx: number, dz: number,
): boolean {
  const d1 = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
  const d2 = (bx - ax) * (dz - az) - (bz - az) * (dx - ax);
  const d3 = (dx - cx) * (az - cz) - (dz - cz) * (ax - cx);
  const d4 = (dx - cx) * (bz - cz) - (dz - cz) * (bx - cx);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/** 刈り込みの強さ。グリーン・ティー・フェアウェイそれぞれ 0..1。 */
export interface Mown {
  green: number;
  tee: number;
  fairway: number;
}

/**
 * 旗の並びから、地形を均す形と刈り込む形を引く。heightAt から毎回呼ばれるので、
 * 旗ごとの外接の四角で先に振り落とす（旗は 10 本前後）。
 */
export class CourseShape {
  private holes: readonly Hole[] = [];
  /** 旗ごとの外接の四角（x の最小・最大、z の最小・最大）。均す円と刈り込む帯を含む。 */
  private boxes = new Float64Array(0);
  /** flattenWeight が最後に返した重みの、寄せる先の高さ。 */
  flatHeight = 0;

  constructor(holes: readonly Hole[] = []) {
    this.set(holes);
  }

  get list(): readonly Hole[] {
    return this.holes;
  }

  get empty(): boolean {
    return this.holes.length === 0;
  }

  set(holes: readonly Hole[]): void {
    this.holes = holes;
    this.boxes = new Float64Array(holes.length * 4);
    holes.forEach((h, k) => {
      const ax = h.tee ? h.tee.x : h.pin.x;
      const az = h.tee ? h.tee.z : h.pin.z;
      const r = Math.max(FAIRWAY_HALF + 3, h.green.radius + h.green.blend, TEE_RADIUS + TEE_BLEND);
      this.boxes[k * 4] = Math.min(ax, h.pin.x) - r;
      this.boxes[k * 4 + 1] = Math.max(ax, h.pin.x) + r;
      this.boxes[k * 4 + 2] = Math.min(az, h.pin.z) - r;
      this.boxes[k * 4 + 3] = Math.max(az, h.pin.z) + r;
    });
  }

  private outside(k: number, x: number, z: number): boolean {
    const b = this.boxes;
    return x < b[k * 4] || x > b[k * 4 + 1] || z < b[k * 4 + 2] || z > b[k * 4 + 3];
  }

  /**
   * 均した面へ寄せる割合（0..1）。寄せる先の高さは flatHeight に入る。
   * グリーンは傾いた面、ティーは水平。旗どうしは重ならないように置いてある。
   */
  flattenWeight(x: number, z: number): number {
    for (let k = 0; k < this.holes.length; k++) {
      if (this.outside(k, x, z)) continue;
      const h = this.holes[k];
      const g = h.green;
      const dg = Math.hypot(x - h.pin.x, z - h.pin.z);
      if (dg < g.radius + g.blend) {
        this.flatHeight = g.h + g.sx * (x - h.pin.x) + g.sz * (z - h.pin.z);
        return 1 - smooth(g.radius, g.radius + g.blend, dg);
      }
      if (h.tee) {
        const dt = Math.hypot(x - h.tee.x, z - h.tee.z);
        if (dt < TEE_RADIUS + TEE_BLEND) {
          this.flatHeight = h.tee.h;
          return 1 - smooth(TEE_RADIUS, TEE_RADIUS + TEE_BLEND, dt);
        }
      }
    }
    return 0;
  }

  /** 刈り込みの強さ（旗ごとの最大）。 */
  mownAt(x: number, z: number, out: Mown): Mown {
    out.green = 0;
    out.tee = 0;
    out.fairway = 0;
    for (let k = 0; k < this.holes.length; k++) {
      if (this.outside(k, x, z)) continue;
      const h = this.holes[k];
      const dg = Math.hypot(x - h.pin.x, z - h.pin.z);
      const green = 1 - smooth(h.green.radius - 1.5, h.green.radius + 1.5, dg);
      if (green > out.green) out.green = green;
      if (!h.tee) continue;
      const dt = Math.hypot(x - h.tee.x, z - h.tee.z);
      const tee = 1 - smooth(TEE_RADIUS - 1, TEE_RADIUS + 1, dt);
      if (tee > out.tee) out.tee = tee;
      const d = segmentDistance(x, z, h.tee.x, h.tee.z, h.pin.x, h.pin.z);
      const fairway = (1 - smooth(FAIRWAY_HALF - 3, FAIRWAY_HALF + 3, d)) * (1 - green);
      if (fairway > out.fairway) out.fairway = fairway;
    }
    return out;
  }
}

// ── おすすめの旗（コース） ───────────────────────────────

/** パーごとの長さ（m）。長いホールが置けなければ短い方へ下げる。最後の段は短いパー 3。 */
const LENGTHS: Record<number, [number, number]> = { 3: [110, 200], 4: [250, 400], 5: [420, 520] };
const SHORT: [number, number] = [55, 110];
/** 置きたいパーの並び（9 ホールで 36）。 */
const PARS = [4, 3, 4, 5, 4, 3, 4, 5, 4];
/** 旗どうしの間隔（m）: ピン・ティーどうし、ホールの打つ線どうし。 */
const SPOT_GAP = 80;
const LINE_GAP = 45;

interface Site {
  i: number;
  j: number;
  x: number;
  z: number;
  h: number;
  /** 周り（±16m）の高低差。均す量の目安。 */
  range: number;
  /** 周り（±24m）に水（川・湖・海）があるか。グリーンを均すと水際が崩れる。 */
  wetNear: boolean;
  /** すぐ周り（±8m）に水があるか。ティーには使えない。 */
  wetClose: boolean;
  cold: boolean;
}

/**
 * 島のコース。**陸がある限り必ず 1 ホール以上**、多ければ 9 ホール。
 *
 * 候補地は点数（小さいほど良い）で比べる。捨てるのは水と、他のホールとの重なりだけ
 * （以前は平らさも合格・不合格で決めていて、4 島に 1 つでホールを置けなかった）。
 * 長いホールが置けなければパーを下げ、最後は短いパー 3 にする。
 */
export function pickCourse(island: Island, seed: string): Hole[] {
  const { n, cell, height, waterKind, temperature } = island;
  const rand = mulberry32(hashSeed(`${seed}:course`)[0]);
  const toWorld = (i: number) => (i / (n - 1) - 0.5) * ISLAND_SIZE;
  const r16 = Math.max(1, Math.round(16 / cell));
  const r24 = Math.max(1, Math.round(24 / cell));
  const r8 = Math.max(1, Math.round(8 / cell));
  const isWet = (k: number) => waterKind[k] !== 0 || height[k] < 1;

  const sites: Site[] = [];
  const margin = r24 + 1;
  for (let j = margin; j < n - margin; j += r16) {
    for (let i = margin; i < n - margin; i += r16) {
      const k = j * n + i;
      const h = height[k];
      // 浜（砂）と水の中には置かない。
      if (h < 2.5 || isWet(k)) continue;
      let lo = Infinity;
      let hi = -Infinity;
      let wetNear = false;
      let wetClose = false;
      for (let dj = -r24; dj <= r24; dj++) {
        for (let di = -r24; di <= r24; di++) {
          const q = (j + dj) * n + (i + di);
          if (isWet(q)) {
            wetNear = true;
            if (Math.abs(di) <= r8 && Math.abs(dj) <= r8) wetClose = true;
          }
          if (Math.abs(di) <= r16 && Math.abs(dj) <= r16) {
            const v = height[q];
            if (v < lo) lo = v;
            if (v > hi) hi = v;
          }
        }
      }
      sites.push({ i, j, x: toWorld(i), z: toWorld(j), h, range: hi - lo, wetNear, wetClose, cold: temperature[k] < 0.2 });
    }
  }

  /** 均す手間・寒さ・高さの減点。 */
  const siteCost = (s: Site) => s.range + (s.cold ? 6 : 0) + (s.h > 260 ? (s.h - 260) * 0.05 : 0);

  /** ティーからピンまでの線の上の水の割合。 */
  const waterAlong = (a: Site, b: Site) => {
    const steps = Math.max(4, Math.floor(Math.hypot(b.x - a.x, b.z - a.z) / 8));
    let wet = 0;
    for (let s = 0; s <= steps; s++) {
      const i = Math.round(a.i + ((b.i - a.i) * s) / steps);
      const j = Math.round(a.j + ((b.j - a.j) * s) / steps);
      if (isWet(j * n + i)) wet++;
    }
    return wet / (steps + 1);
  };

  const holes: Hole[] = [];
  const spots: { x: number; z: number }[] = [];
  const lines: [number, number, number, number][] = [];
  const freeSpot = (s: Site) => spots.every((p) => Math.hypot(p.x - s.x, p.z - s.z) >= SPOT_GAP);
  const clearOfLines = (s: Site) =>
    lines.every(([ax, az, bx, bz]) => segmentDistance(s.x, s.z, ax, az, bx, bz) >= LINE_GAP);
  /** 新しい打つ線が、今までのホールのピン・ティー・打つ線に近すぎないか（交わるのも不可）。 */
  const lineIsClear = (t: Site, g: Site) => {
    for (const p of spots) if (segmentDistance(p.x, p.z, t.x, t.z, g.x, g.z) < LINE_GAP) return false;
    for (const [ax, az, bx, bz] of lines) {
      if (segmentDistance(t.x, t.z, ax, az, bx, bz) < LINE_GAP) return false;
      if (segmentDistance(g.x, g.z, ax, az, bx, bz) < LINE_GAP) return false;
      if (segmentsCross(ax, az, bx, bz, t.x, t.z, g.x, g.z)) return false;
    }
    return true;
  };

  for (let number = 1; number <= MAX_HOLES; number++) {
    const want = PARS[number - 1];
    // グリーンの候補: 水際と他のホールを避け、手間の少ない順（合言葉の乱数で少し揺らす）。
    let greens = sites
      .filter((s) => !s.wetNear && freeSpot(s) && clearOfLines(s))
      .map((s) => ({ s, cost: siteCost(s) + rand() * 2 }));
    // 最初のホールは、グリーンを水際にしか置けない島でも必ず置く。
    if (greens.length === 0 && number === 1) {
      greens = sites.map((s) => ({ s, cost: siteCost(s) + (s.wetNear ? 20 : 0) }));
    }
    greens.sort((a, b) => a.cost - b.cost || a.s.j - b.s.j || a.s.i - b.s.i);
    greens = greens.slice(0, 24);
    const prev = holes.length > 0 ? holes[holes.length - 1].pin : null;
    const tiers = [LENGTHS[want], ...[5, 4, 3].filter((p) => p < want).map((p) => LENGTHS[p]), SHORT];

    let made: Hole | null = null;
    for (const [minLen, maxLen] of tiers) {
      let best: { t: Site; g: Site; cost: number } | null = null;
      for (const { s: g, cost: gCost } of greens) {
        const tees: { t: Site; cost: number }[] = [];
        for (const t of sites) {
          if (t.wetClose || t === g) continue;
          const d = Math.hypot(t.x - g.x, t.z - g.z);
          if (d < minLen || d > maxLen || !freeSpot(t)) continue;
          // 打ち上げ・打ち下ろしは 40m までは気にしない。前のホールのグリーンに近いティーを好む。
          const climb = Math.max(0, Math.abs(t.h - g.h) - 40) * 0.2;
          const walk = prev ? Math.hypot(t.x - prev.x, t.z - prev.z) / 250 : 0;
          tees.push({ t, cost: t.range * 1.5 + (t.cold ? 6 : 0) + climb + walk + gCost });
        }
        tees.sort((a, b) => a.cost - b.cost || a.t.j - b.t.j || a.t.i - b.t.i);
        // 水を渡る量と他のホールとの重なりは、安い方から数本だけ確かめる（線をたどるのは重い）。
        for (const { t, cost } of tees.slice(0, 16)) {
          const wet = waterAlong(t, g);
          if (wet > 0.35 || !lineIsClear(t, g)) continue;
          const total = cost + wet * 30;
          if (!best || total < best.cost) best = { t, g, cost: total };
          break;
        }
        // 良いグリーンから順に見ているので、十分安い組が見つかればそれでよい。
        if (best && best.cost < gCost + 12) break;
      }
      if (best) {
        made = makeHole(island, number, best.t, best.g);
        break;
      }
    }
    if (!made) break;
    holes.push(made);
    spots.push(made.pin, made.tee!);
    lines.push([made.tee!.x, made.tee!.z, made.pin.x, made.pin.z]);
  }
  return holes;
}

/**
 * グリーンの面を、元の地形に最小二乗で合わせた傾いた面にする（傾きは上限まで）。
 * 円の上で対称に引くので、x と z の傾きは独立に求まる（平均の位置は中心）。
 */
function fitGreen(
  sample: (x: number, z: number) => number,
  cx: number,
  cz: number,
  radius: number,
  step: number,
): { h: number; sx: number; sz: number } {
  const r = Math.max(1, Math.round(radius / step));
  let sh = 0;
  let sxx = 0;
  let szz = 0;
  let sxh = 0;
  let szh = 0;
  let count = 0;
  for (let dj = -r; dj <= r; dj++) {
    for (let di = -r; di <= r; di++) {
      if (di * di + dj * dj > r * r) continue;
      const x = di * step;
      const z = dj * step;
      const h = sample(cx + x, cz + z);
      sh += h;
      sxx += x * x;
      szz += z * z;
      sxh += x * h;
      szh += z * h;
      count++;
    }
  }
  let gx = sxx > 0 ? sxh / sxx : 0;
  let gz = szz > 0 ? szh / szz : 0;
  const slope = Math.sqrt(gx * gx + gz * gz);
  if (slope > GREEN_SLOPE_MAX) {
    gx *= GREEN_SLOPE_MAX / slope;
    gz *= GREEN_SLOPE_MAX / slope;
  }
  return { h: sh / count, sx: gx, sz: gz };
}

function makeHole(island: Island, number: number, t: Site, g: Site): Hole {
  const { n, cell, height } = island;
  const sample = (x: number, z: number) => {
    const i = Math.round((x / ISLAND_SIZE + 0.5) * (n - 1));
    const j = Math.round((z / ISLAND_SIZE + 0.5) * (n - 1));
    return height[j * n + i];
  };
  const green = fitGreen(sample, g.x, g.z, GREEN_RADIUS, cell);
  const length = Math.hypot(g.x - t.x, g.z - t.z);
  return {
    number,
    tee: { x: t.x, z: t.z, h: t.h },
    pin: { x: g.x, z: g.z },
    green: { ...green, radius: GREEN_RADIUS, blend: GREEN_BLEND },
    par: length < 230 ? 3 : length < 440 ? 4 : 5,
    length,
  };
}

// ── 自分の旗 ──────────────────────────────────────────

/** 自分の旗を立てられない理由。 */
export type FlagProblem = 'water' | 'steep' | 'tee';

/**
 * 見ている所に旗を立てる。グリーンだけを均す（ティーもフェアウェイも無い）。
 * heightAt には、旗を立てる前の地形（前の自分の旗を外したもの）を渡すこと。
 */
export function makeFlag(
  heightAt: (x: number, z: number) => number,
  wetAt: (x: number, z: number) => boolean,
  course: readonly Hole[],
  x: number,
  z: number,
): Hole | FlagProblem {
  const reach = FLAG_RADIUS + FLAG_BLEND;
  for (const h of course) {
    if (h.tee && Math.hypot(x - h.tee.x, z - h.tee.z) < TEE_RADIUS + TEE_BLEND + reach) return 'tee';
  }
  // 均す範囲の中に水があれば立てない（水際を均すと、水の中にグリーンが出る）。
  let lo = Infinity;
  let hi = -Infinity;
  for (let a = 0; a < 16; a++) {
    for (const r of [0, reach * 0.5, reach]) {
      const px = x + Math.cos((a * Math.PI) / 8) * r;
      const pz = z + Math.sin((a * Math.PI) / 8) * r;
      if (wetAt(px, pz)) return 'water';
      if (r <= FLAG_RADIUS) {
        const v = heightAt(px, pz);
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
  }
  // 急な斜面を均すと、崖に棚を刻んだようになる。
  if (hi - lo > 9) return 'steep';
  const green = fitGreen(heightAt, x, z, FLAG_RADIUS, 2);
  return {
    number: 0,
    tee: null,
    pin: { x, z },
    green: { ...green, radius: FLAG_RADIUS, blend: FLAG_BLEND },
    par: 0,
    length: 0,
  };
}

/** 旗 h が地形を均す範囲（地面を作り直す範囲）。 */
export function flagArea(h: Hole): { x: number; z: number; r: number } {
  return { x: h.pin.x, z: h.pin.z, r: h.green.radius + h.green.blend + 2 };
}
