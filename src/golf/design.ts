import { hashSeed, mulberry32 } from '../core/rng';
import { GREEN_BASE, type GreenKind, type GreenShape, pickPins } from './greens';

/**
 * コースの設計図。**コースを先に作り、地形は後から合わせる**。
 *
 * 1. 計画（planCourse）: 9 ホールの並べ方の型を決める。パー 3 が 2・パー 4 が 5・パー 5 が 2（パー 36）。
 *    1 番はやさしいストレート、途中に 1 オン狙いのパー 4、9 番は見せ場（池越え・ケープ・2 本のフェアウェイ）。
 *    パー 3 どうし・パー 5 どうしは続けない。ホールごとに高低の型とグリーンの型を割り当てる
 * 2. 並べる（routeCourse）: 何もない平らな土地に、計画どおりのホールを輪のように並べる。前のグリーンの
 *    そばに次のティー、9 番のグリーンは 1 番のティーのそばへ。ホールの間には林の帯を挟む。
 *    地形を見ないので、どの合言葉でも必ず 9 ホール並ぶ
 * 3. 地形は、この設計図から作る（island/landscape.ts）。谷底の高低は、ホールの高低の型（relief）から作る
 * 4. 高さを入れる（settleCourse）: できた地面に合わせて、ティーの台・グリーンの面・池の水面・ピン位置を決める
 * 5. 造成する（golf/field.ts）
 *
 * ホールの型は「どんな選択をさせるか」で分ける（実在の設計の言葉。C.B. Macdonald と Seth Raynor の型、
 * マリオゴルフの 2 本のフェアウェイ、Tom Weiskopf の 1 オン狙いのパー 4 など）。
 *
 * 合言葉だけで決まる（決定性の決まり: 四則演算・sqrt・floor だけ。角度は表から引く）。
 */

export interface Vec2 {
  x: number;
  z: number;
}

/** 楕円（中心・半径 2 つ・長軸の向き）。 */
export interface Ellipse {
  x: number;
  z: number;
  rx: number;
  rz: number;
  ax: number;
  az: number;
}

export interface Bunker extends Ellipse {
  depth: number;
}

export interface Pond extends Ellipse {
  /** 水面の高さ（m）。池の中で一定。settleCourse が入れる。 */
  level: number;
}

/** 小山（ホールの縁取りと、グリーンの周りのこぶ）。 */
export interface Mound extends Ellipse {
  height: number;
}

/** 谷底の高低（地形を作るときに足す。h が正なら丘、負ならくぼみ）。 */
export interface Relief {
  x: number;
  z: number;
  r: number;
  h: number;
}

/** フェアウェイの帯（自分の打つ線と、線に沿った位置ごとの半分の幅）。 */
export interface FairwayStrip {
  line: Vec2[];
  stations: { s: number; half: number }[];
}

export type GreenDesign = GreenShape;

export type HoleKind =
  | 'straight'
  | 'dogleg'
  | 'cape'
  | 'split'
  | 'angle'
  | 'drivable'
  | 'short'
  | 'redan'
  | 'biarritz'
  | 'sahara'
  | 'lake';

export type Elevation = 'flat' | 'downhill' | 'uphill' | 'valley';

export interface HoleDesign {
  number: number;
  kind: HoleKind;
  par: number;
  elevation: Elevation;
  /** 打つ線（ティー → 曲がり角 → グリーンの中心）。 */
  line: Vec2[];
  tee: { x: number; z: number; h: number; ax: number; az: number };
  /** ピン位置（4 つ。日ごとに切り替える）。settleCourse が選ぶ。 */
  pins: Vec2[];
  /** ティーショットで狙う所（曲がったホールでは角の手前、1 オン狙いのパー 4 では刻む所）。 */
  aim: Vec2;
  green: GreenDesign;
  fairways: FairwayStrip[];
  /** 打つ回廊の半分の幅（ラフを除く）。打つ線に沿った位置ごと。 */
  corridor: { s: number; half: number }[];
  bunkers: Bunker[];
  ponds: Pond[];
  mounds: Mound[];
  relief: Relief[];
  /** 打つ線に沿ったティーからグリーンの中心までの長さ（m）。 */
  length: number;
}

export interface CourseDesign {
  holes: HoleDesign[];
}

/** 16 方向の表。三角関数を生成の中で呼ばないために、あらかじめ値で持つ。 */
const DIRS: Vec2[] = [
  [1, 0], [0.9238795, 0.3826834], [0.7071068, 0.7071068], [0.3826834, 0.9238795],
  [0, 1], [-0.3826834, 0.9238795], [-0.7071068, 0.7071068], [-0.9238795, 0.3826834],
  [-1, 0], [-0.9238795, -0.3826834], [-0.7071068, -0.7071068], [-0.3826834, -0.9238795],
  [0, -1], [0.3826834, -0.9238795], [0.7071068, -0.7071068], [0.9238795, -0.3826834],
].map(([x, z]) => ({ x, z }));
/** 曲がりの角度（cos と sin）。 */
const TURN = {
  slight: { c: 0.9659258, s: 0.258819 },
  dogleg: { c: 0.8660254, s: 0.5 },
  cape35: { c: 0.819152, s: 0.5735764 },
  cape45: { c: 0.7071068, s: 0.7071068 },
  diagonal: { c: 0.819152, s: 0.5735764 },
  side: { c: 0.1736482, s: 0.9848078 },
};

/** d を side 側（+1 = 右、-1 = 左）へ回す。右は (-dz, dx)。 */
function turn(d: Vec2, side: number, t: { c: number; s: number }): Vec2 {
  return { x: d.x * t.c - d.z * side * t.s, z: d.z * t.c + d.x * side * t.s };
}

function right(d: Vec2): Vec2 {
  return { x: -d.z, z: d.x };
}

function add(p: Vec2, d: Vec2, k: number): Vec2 {
  return { x: p.x + d.x * k, z: p.z + d.z * k };
}

/** (x, z) から折れ線までの距離、線に沿った位置（m）、右を正とした横の位置。 */
export function lineDistance(line: readonly Vec2[], x: number, z: number): { d: number; s: number; lat: number } {
  let best = Infinity;
  let bestS = 0;
  let bestLat = 0;
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
      bestLat = (-dz * (x - a.x) + dx * (z - a.z)) / (len || 1);
    }
    acc += len;
  }
  return { d: best, s: bestS, lat: bestLat };
}

/** 位置 s の幅（区間の外は 0）。 */
export function stationHalf(stations: readonly { s: number; half: number }[], s: number): number {
  if (stations.length === 0 || s < stations[0].s || s > stations[stations.length - 1].s) return 0;
  for (let k = 0; k < stations.length - 1; k++) {
    if (s <= stations[k + 1].s) {
      const t = (s - stations[k].s) / (stations[k + 1].s - stations[k].s || 1);
      return stations[k].half + (stations[k + 1].half - stations[k].half) * t;
    }
  }
  return stations[stations.length - 1].half;
}

function lineLength(line: readonly Vec2[]): number {
  let acc = 0;
  for (let k = 0; k < line.length - 1; k++) acc += Math.hypot(line[k + 1].x - line[k].x, line[k + 1].z - line[k].z);
  return acc;
}

/** 折れ線の上で、始まりから s（m）の点と向き。 */
function frameAt(line: readonly Vec2[], s: number): { p: Vec2; d: Vec2 } {
  let acc = 0;
  for (let k = 0; k < line.length - 1; k++) {
    const a = line[k];
    const b = line[k + 1];
    const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    if (s <= acc + len || k === line.length - 2) {
      const t = Math.max(0, Math.min(1, (s - acc) / len));
      return { p: { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t }, d: { x: (b.x - a.x) / len, z: (b.z - a.z) / len } };
    }
    acc += len;
  }
  return { p: line[line.length - 1], d: { x: 1, z: 0 } };
}

// ── 型 ──────────────────────────────────────────────

interface Slot {
  kind: HoleKind;
  elevation: Elevation;
  green: GreenKind;
}

interface Build {
  tee: Vec2;
  dir: Vec2;
  side: number;
  length: number;
  variant: number;
}

function ellipse(c: Vec2, rx: number, rz: number, a: Vec2): Ellipse {
  return { x: c.x, z: c.z, rx, rz, ax: a.x, az: a.z };
}

function bunker(c: Vec2, rx: number, rz: number, a: Vec2, depth: number): Bunker {
  return { ...ellipse(c, rx, rz, a), depth };
}

function mound(c: Vec2, rx: number, rz: number, a: Vec2, height: number): Mound {
  return { ...ellipse(c, rx, rz, a), height };
}

function green(kind: GreenKind, c: Vec2, rx: number, rz: number, axis: Vec2, approach: Vec2, strength: number): GreenDesign {
  return { ...ellipse(c, rx, rz, axis), kind, fx: -approach.x, fz: -approach.z, h: 0, sx: 0, sz: 0, strength };
}

function strip(line: Vec2[], stations: { s: number; half: number }[]): FairwayStrip {
  return { line, stations };
}

/** 型ごとのパー、長さの候補（m）、変種の数。 */
const TEMPLATE: Record<HoleKind, { par: number; lengths: number[]; variants: number }> = {
  straight: { par: 4, lengths: [340, 360, 380], variants: 1 },
  dogleg: { par: 4, lengths: [345, 370, 395], variants: 1 },
  cape: { par: 4, lengths: [340, 365, 390], variants: 2 },
  split: { par: 4, lengths: [370, 390, 410], variants: 1 },
  angle: { par: 4, lengths: [355, 380, 400], variants: 1 },
  drivable: { par: 4, lengths: [245, 255, 265], variants: 1 },
  short: { par: 3, lengths: [115, 130, 145], variants: 1 },
  redan: { par: 3, lengths: [150, 165, 180], variants: 1 },
  biarritz: { par: 3, lengths: [175, 185, 195], variants: 1 },
  sahara: { par: 5, lengths: [465, 490, 510], variants: 2 },
  lake: { par: 5, lengths: [470, 495, 520], variants: 2 },
};

type Shape = Omit<HoleDesign, 'number'>;

/** 型からホールの形を作る（高さは settleCourse で入れる）。 */
function shape(slot: Slot, b: Build): Shape {
  const { tee, dir: d, side, length: L } = b;
  const { kind } = slot;
  const r = right(d);
  const inside = { x: r.x * side, z: r.z * side };
  const par = TEMPLATE[kind].par;
  const teeOut = { x: tee.x, z: tee.z, h: 0, ax: d.x, az: d.z };
  let line: Vec2[];
  let aim: Vec2;
  let g: GreenDesign;
  let fairways: FairwayStrip[];
  let bunkers: Bunker[];
  let ponds: Pond[] = [];

  if (kind === 'cape' || kind === 'dogleg') {
    // 角まで 220m 前後、そこから曲がる。ケープは角の内側に池、ドッグレッグは外側にバンカー。
    const cornerS = kind === 'cape' ? 225 : 235;
    const corner = add(tee, d, cornerS);
    const d2 = turn(d, side, kind === 'dogleg' ? TURN.dogleg : b.variant === 0 ? TURN.cape35 : TURN.cape45);
    const c = add(corner, d2, L - cornerS);
    const r2 = right(d2);
    line = [tee, corner, c];
    aim = add(tee, d, cornerS - 10);
    g = green(slot.green, c, 15, 12, d2, d2, 1);
    fairways = [
      strip(line, [
        { s: 150, half: 17 },
        { s: 215, half: 24 },
        { s: 260, half: 22 },
        { s: L - 60, half: 16 },
        { s: L - 13, half: 13 },
      ]),
    ];
    if (kind === 'cape') {
      bunkers = [
        bunker(add(add(tee, d, cornerS + 30), inside, -27), 13, 5.5, d, 1.1),
        bunker(add(add(c, d2, 16), r2, -side * 6), 9, 4, r2, 1.2),
        bunker(add(add(c, d2, -6), r2, side * 16), 8, 4, d2, 1.3),
      ];
      ponds = [{ ...ellipse(add(add(tee, d, cornerS - 30), inside, 38), 52, 24, d), level: 0 }];
    } else {
      bunkers = [
        bunker(add(add(tee, d, cornerS + 12), inside, -24), 12, 5, d, 1.1),
        bunker(add(add(tee, d, cornerS + 40), inside, -20), 9, 4.5, d, 1.0),
        bunker(add(add(c, d2, -8), r2, side * 15), 9, 4, d2, 1.2),
      ];
    }
  } else if (kind === 'straight') {
    // 1 番のやさしいストレート: 広いフェアウェイ、バンカーは落とし所の片側とグリーンの手前の片側だけ。
    const c = add(tee, d, L);
    line = [tee, c];
    aim = add(tee, d, 235);
    g = green(slot.green, c, 15, 13, d, d, 0.9);
    fairways = [
      strip(line, [
        { s: 160, half: 20 },
        { s: 230, half: 26 },
        { s: 290, half: 24 },
        { s: L - 40, half: 18 },
        { s: L - 13, half: 14 },
      ]),
    ];
    bunkers = [
      bunker(add(add(tee, d, 250), r, side * 22), 11, 5, d, 1.0),
      bunker(add(add(c, d, -12), r, -side * 14), 8, 4, d, 1.2),
    ];
  } else if (kind === 'split') {
    // 2 本のフェアウェイ: 反対側（-side）は広く安全だが遠回りで、グリーンの手前のバンカーを越える角度になる。
    // side 側は狭く、真ん中のバンカーの列と奥の林に挟まれるが、グリーンへまっすぐ開いている。
    const c = add(tee, d, L);
    line = [tee, c];
    aim = add(add(tee, d, 235), r, -side * 22);
    g = green(slot.green, c, 15, 12, d, d, 1);
    const safe = [add(add(tee, d, 160), r, -side * 24), add(add(tee, d, 290), r, -side * 22), add(tee, d, L - 55)];
    const bold = [add(add(tee, d, 205), r, side * 20), add(add(tee, d, 275), r, side * 16), add(tee, d, L - 55)];
    fairways = [
      strip(safe, [
        { s: 0, half: 15 },
        { s: 100, half: 17 },
        { s: 190, half: 14 },
      ]),
      strip(bold, [
        { s: 0, half: 10 },
        { s: 70, half: 11 },
        { s: 150, half: 13 },
      ]),
      strip(line, [
        { s: L - 65, half: 15 },
        { s: L - 13, half: 13 },
      ]),
    ];
    bunkers = [
      bunker(add(tee, d, 205), 5, 4, d, 1.2),
      bunker(add(tee, d, 235), 6, 4.5, d, 1.3),
      bunker(add(tee, d, 265), 5, 4, d, 1.2),
      bunker(add(add(c, d, -15), r, -side * 9), 10, 4, r, 1.3),
    ];
  } else if (kind === 'angle') {
    // 角度のホール: グリーンは side 側から開いていて、反対側の手前をバンカーが守る。
    // 開いている側（side）の落とし所にはフェアウェイバンカー。危ない側に置くほど次が楽になる。
    const c = add(tee, d, L);
    line = [tee, c];
    aim = add(add(tee, d, 235), r, side * 6);
    g = green(slot.green, c, 16, 11, turn(d, side, TURN.diagonal), d, 1);
    fairways = [
      strip(line, [
        { s: 165, half: 20 },
        { s: 235, half: 27 },
        { s: 290, half: 24 },
        { s: L - 40, half: 17 },
        { s: L - 12, half: 13 },
      ]),
    ];
    bunkers = [
      bunker(add(add(tee, d, 240), r, side * 20), 12, 5, d, 1.1),
      bunker(add(add(c, d, -13), r, -side * 10), 11, 4.5, turn(d, side, TURN.side), 1.4),
      bunker(add(add(c, d, 13), r, side * 8), 7, 3.5, r, 1.1),
    ];
  } else if (kind === 'drivable') {
    // 1 オン狙いのパー 4（打ち下ろし）: 刻めば安全、狙えばグリーンの手前の林とバンカーを越える。
    // グリーンは刻む側から奥へ傾いていて、刻んでも楽なバーディにはならない。
    const c = add(tee, d, L);
    line = [tee, c];
    aim = add(tee, d, 185);
    g = green(slot.green, c, 13, 11, d, d, 1.2);
    fairways = [
      strip(line, [
        { s: 135, half: 18 },
        { s: 180, half: 22 },
        { s: 205, half: 20 },
      ]),
      strip([add(add(c, d, -42), r, -side * 9), add(add(c, d, -12), r, -side * 3)], [
        { s: 0, half: 9 },
        { s: 31, half: 11 },
      ]),
    ];
    bunkers = [
      bunker(add(add(c, d, -16), r, side * 8), 10, 5, d, 1.4),
      bunker(add(add(c, d, -30), r, -side * 1), 3.5, 3.5, d, 1.6),
      bunker(add(c, d, 15), 8, 3.5, r, 1.1),
    ];
  } else if (kind === 'short') {
    // 小さなグリーンを 4 つのバンカーが囲む。
    const c = add(tee, d, L);
    line = [tee, c];
    aim = { x: c.x, z: c.z };
    g = green(slot.green, c, 12, 10, r, d, 1.3);
    fairways = [strip(line, [{ s: L - 38, half: 10 }, { s: L - 11, half: 12 }])];
    bunkers = [
      bunker(add(add(c, d, -13), r, -8), 6, 3.5, r, 1.4),
      bunker(add(add(c, d, -12), r, 9), 6, 3.5, r, 1.4),
      bunker(add(c, r, side * 16), 4, 7, d, 1.3),
      bunker(add(c, d, 15), 7, 3, r, 1.2),
    ];
  } else if (kind === 'redan') {
    // まっすぐ。グリーンは side 側へ斜めに奥へ延び、奥へ下る。手前の side 側に深いバンカー。
    const c = add(tee, d, L);
    const axis = turn(d, side, TURN.diagonal);
    line = [tee, c];
    aim = add(c, axis, 4);
    g = green('redan', c, 21, 10, axis, d, 1);
    fairways = [strip(line, [{ s: L - 50, half: 12 }, { s: L - 14, half: 15 }])];
    bunkers = [
      bunker(add(add(c, d, -13), r, side * 9), 13, 4.5, axis, 1.8),
      bunker(add(add(c, d, 6), r, -side * 16), 6, 3.5, d, 1.1),
    ];
  } else if (kind === 'biarritz') {
    // 長いパー 3。手前から奥へ長いグリーンの真ん中を谷が横切る。手前の花道から転がしても乗る。
    const c = add(tee, d, L);
    line = [tee, c];
    aim = { x: c.x, z: c.z };
    g = green('biarritz', c, 22, 12, d, d, 0.9);
    fairways = [strip(line, [{ s: L - 60, half: 13 }, { s: L - 22, half: 14 }])];
    bunkers = [
      bunker(add(add(c, d, -6), r, -16), 9, 4, d, 1.3),
      bunker(add(add(c, d, -4), r, 16), 9, 4, d, 1.3),
      bunker(add(add(c, d, 12), r, side * 15), 6, 3.5, d, 1.1),
    ];
  } else {
    // sahara と lake（残りはこの 2 つ）: 280m 付近で少し曲がる（または曲がらない）パー 5。
    const bendS = 280;
    const bend = add(tee, d, bendS);
    const d2 = b.variant === 0 ? d : turn(d, side, TURN.slight);
    const c = add(bend, d2, L - bendS);
    const r2 = right(d2);
    line = [tee, bend, c];
    if (kind === 'sahara') {
      aim = add(tee, d, 235);
      g = green(slot.green, c, 14, 13, d2, d2, 1.25);
      const waste = add(c, d2, -95);
      fairways = [
        strip(line, [
          { s: 170, half: 18 },
          { s: 240, half: 24 },
          { s: L - 125, half: 21 },
          { s: L - 70, half: 19 },
          { s: L - 12, half: 14 },
        ]),
      ];
      bunkers = [
        // 砂の荒れ地（3 つの楕円を重ねて、横切る帯にする）。
        bunker(waste, 30, 16, r2, 0.9),
        bunker(add(add(waste, r2, 22), d2, 6), 18, 12, r2, 0.8),
        bunker(add(add(waste, r2, -24), d2, -5), 17, 11, r2, 0.8),
        bunker(add(add(tee, d, 235), r, side * 21), 11, 5, d, 1.0),
      ];
    } else {
      // lake: グリーンの手前に池。刻むならフェアウェイは池の手前まで。
      aim = add(tee, d, 240);
      g = green(slot.green, c, 15, 13, r2, d2, 1.1);
      fairways = [
        strip(line, [
          { s: 170, half: 18 },
          { s: 245, half: 24 },
          { s: L - 110, half: 21 },
          { s: L - 70, half: 20 },
        ]),
      ];
      bunkers = [
        bunker(add(add(tee, d, 245), r, -side * 22), 11, 5, d, 1.0),
        bunker(add(add(c, d2, 14), r2, side * 10), 8, 4, r2, 1.2),
      ];
      ponds = [{ ...ellipse(add(c, d2, -36), 30, 15, r2), level: 0 }];
    }
  }

  const length = lineLength(line);
  // 回廊の幅は向きと位置と左右で変わらないので、型・長さ・変種ごとに 1 度だけ測る（並べる間に何万回も作るため）。
  const key = `${kind}:${L}:${b.variant}`;
  let corridor = CORRIDORS.get(key);
  if (!corridor) {
    corridor = corridorOf(line, fairways, g, length);
    CORRIDORS.set(key, corridor);
  }
  return {
    kind,
    par,
    elevation: slot.elevation,
    line,
    tee: teeOut,
    pins: [],
    aim,
    green: g,
    fairways,
    corridor,
    bunkers,
    ponds,
    mounds: moundsOf(line, corridor, g, bunkers, par, side),
    relief: reliefOf(slot.elevation, line, length, g),
    length,
  };
}

const CORRIDORS = new Map<string, { s: number; half: number }[]>();

/** 打つ回廊の幅: フェアウェイの帯が打つ線から一番遠くまで広がる所（最低 14m）。10m ごと。 */
function corridorOf(line: Vec2[], fairways: FairwayStrip[], g: GreenDesign, L: number): { s: number; half: number }[] {
  const out: { s: number; half: number }[] = [];
  for (let s = 0; s <= L + 0.01; s += 10) {
    const { p } = frameAt(line, s);
    let half = 14;
    for (const f of fairways) {
      // 帯の線の上の点で、この s に近いものを探し、打つ線からの横の広がりを測る。
      const fl = lineLength(f.line);
      for (let t = 0; t <= fl; t += 10) {
        const w = stationHalf(f.stations, t);
        if (w <= 0) continue;
        const q = frameAt(f.line, t).p;
        const on = lineDistance(line, q.x, q.z);
        if (Math.abs(on.s - s) > 6) continue;
        half = Math.max(half, on.d + w);
      }
    }
    if (Math.hypot(p.x - g.x, p.z - g.z) < Math.max(g.rx, g.rz) + 6) half = Math.max(half, Math.max(g.rx, g.rz) + 4);
    out.push({ s, half });
  }
  return out;
}

/** 小山: 落とし所の両脇の縁取りと、グリーンのバンカーの無い側のこぶ。 */
function moundsOf(
  line: Vec2[],
  corridor: { s: number; half: number }[],
  g: GreenDesign,
  bunkers: Bunker[],
  par: number,
  side: number,
): Mound[] {
  const out: Mound[] = [];
  const L = lineLength(line);
  if (par > 3) {
    for (const s of [205, 265]) {
      if (s > L - 60) continue;
      const { p, d } = frameAt(line, s);
      const r = right(d);
      const half = stationHalf(corridor, s);
      for (const lr of [-1, 1]) {
        const h = lr === side ? 1.5 : 1.1;
        out.push(mound(add(p, r, lr * (half + 5)), 12, 6, d, h));
      }
    }
  }
  // グリーンの横と奥: バンカーが近くに無い所に 0.8m のこぶ。
  const R = (g.rx + g.rz) / 2;
  const back = { x: -g.fx, z: -g.fz };
  for (const k of [
    turn(back, 1, TURN.side),
    turn(back, -1, TURN.side),
    turn(back, 1, TURN.diagonal),
    turn(back, -1, TURN.diagonal),
  ]) {
    const c = add(g, k, R + 7);
    if (bunkers.some((b) => Math.hypot(b.x - c.x, b.z - c.z) < Math.max(b.rx, b.rz) + 7)) continue;
    out.push(mound(c, 6, 4, right(k), 0.8));
  }
  return out;
}

/** 高低の型: 打ち下ろしはティーの丘、打ち上げはグリーンの台地、谷越えは手前のくぼみ。 */
function reliefOf(e: Elevation, line: Vec2[], L: number, g: GreenDesign): Relief[] {
  if (e === 'downhill') return [{ x: line[0].x, z: line[0].z, r: 140, h: 9 }];
  if (e === 'uphill') return [{ x: g.x, z: g.z, r: 110, h: 6 }];
  if (e === 'valley') {
    const { p } = frameAt(line, Math.min(115, L * 0.55));
    return [{ x: p.x, z: p.z, r: 60, h: -6 }];
  }
  return [];
}

// ── 計画 ─────────────────────────────────────────────

const PAR4_POOL: HoleKind[] = ['dogleg', 'cape', 'split', 'angle'];
const PAR3_POOL: HoleKind[] = ['short', 'redan', 'biarritz'];

function shuffle<T>(arr: T[], rand: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * 9 ホールの並べ方の型: パー 3 が 2・パー 4 が 5・パー 5 が 2。1 番はやさしいストレート、
 * 1 オン狙いのパー 4 は 3〜7 番、9 番は見せ場。パー 3 どうし・パー 5 どうしは続けない。
 * 高低の型とグリーンの型もここで割り当てる（同じ型を続けて使わない）。
 */
export function planCourse(seed: string): Slot[] {
  const rand = mulberry32(hashSeed(`${seed}:plan`)[0]);
  const par3 = shuffle(PAR3_POOL, rand).slice(0, 2);
  const par4 = [...shuffle(PAR4_POOL, rand).slice(0, 3), 'drivable' as HoleKind];
  const par5: HoleKind[] = ['sahara', 'lake'];
  // 9 番の見せ場。
  const finales = (['lake', 'cape', 'split'] as HoleKind[]).filter((k) => par4.includes(k) || k === 'lake');
  const finale = finales[Math.floor(rand() * finales.length)];
  const middle = [...par3, ...par4, ...par5].filter((k) => k !== finale);
  const parOf = (k: HoleKind) => TEMPLATE[k].par;
  let order: HoleKind[] = [];
  for (let attempt = 0; attempt < 200; attempt++) {
    const cand: HoleKind[] = ['straight', ...shuffle(middle, rand), finale];
    let ok = true;
    for (let k = 1; k < cand.length && ok; k++) {
      const a = parOf(cand[k - 1]);
      const b = parOf(cand[k]);
      if ((a === 3 && b === 3) || (a === 5 && b === 5)) ok = false;
    }
    const dr = cand.indexOf('drivable');
    if (dr < 2 || dr > 6) ok = false;
    order = cand;
    if (ok) break;
  }

  // 高低の型: 1 オン狙いは打ち下ろし。ほかに打ち下ろし 1（パー 3 か 1 番）、打ち上げ 1、谷越え 1。
  const elevation: Elevation[] = order.map(() => 'flat');
  elevation[order.indexOf('drivable')] = 'downhill';
  const pick = (cands: number[]) => {
    const flat = cands.filter((k) => elevation[k] === 'flat');
    return flat[Math.floor(rand() * flat.length)];
  };
  const par3At = order.map((k, i) => (parOf(k) === 3 ? i : -1)).filter((i) => i >= 0);
  const down = pick([0, ...par3At]);
  if (down !== undefined && elevation[down] === 'flat') elevation[down] = 'downhill';
  const upCands = order.map((k, i) => (i > 0 && parOf(k) >= 4 && k !== 'drivable' && elevation[i] === 'flat' ? i : -1)).filter((i) => i >= 0);
  const up = upCands[Math.floor(rand() * upCands.length)];
  if (up !== undefined) elevation[up] = 'uphill';
  const valCands = order
    .map((k, i) => (elevation[i] === 'flat' && (k === 'short' || k === 'straight' || k === 'angle' || k === 'split') ? i : -1))
    .filter((i) => i >= 0);
  const val = valCands[Math.floor(rand() * valCands.length)];
  if (val !== undefined) elevation[val] = 'valley';

  // グリーンの型: 型ごとに合うものから、同じものをなるべく使わずに。
  const used = new Set<GreenKind>();
  const choose = (opts: GreenKind[]) => {
    const fresh = opts.filter((o) => !used.has(o));
    const pool = fresh.length > 0 ? fresh : opts;
    const g = pool[Math.floor(rand() * pool.length)];
    if (g !== 'receptive') used.add(g);
    return g;
  };
  const greenFor = (k: HoleKind, e: Elevation): GreenKind => {
    if (k === 'straight') return 'receptive';
    if (k === 'redan') return 'redan';
    if (k === 'biarritz') return 'biarritz';
    if (k === 'sahara') return 'punchbowl';
    if (k === 'short') return choose(['crowned', 'falsefront', 'punchbowl']);
    if (k === 'drivable') return choose(['falsefront', 'crowned']);
    if (k === 'lake') return choose(['receptive', 'tiered']);
    // 打ち上げの台地には砲台か 2 段。
    if (e === 'uphill') return choose(['falsefront', 'tiered']);
    return choose(['tiered', 'spine', 'receptive', 'falsefront']);
  };
  return order.map((kind, i) => ({ kind, elevation: elevation[i], green: greenFor(kind, elevation[i]) }));
}

// ── 並べる ───────────────────────────────────────────

/** 回廊の外のラフの帯（m）と、隣のホールとの間に挟む林の帯（m）。 */
const ROUGH = 10;
const GAP = 18;
/** 並べる範囲（1 番のティーからの半径、m）。 */
const REACH = 800;
/** 同時に育てる並べ方の数。 */
const BEAM = 6;

interface Route {
  holes: Shape[];
  occ: Uint8Array;
  cost: number;
}

const OCC_STEP = 8;
const OCC_N = Math.ceil((REACH * 2 + 240) / OCC_STEP);

function occIndex(x: number, z: number, origin: Vec2): number {
  const i = Math.floor((x - origin.x) / OCC_STEP + OCC_N / 2);
  const j = Math.floor((z - origin.z) / OCC_STEP + OCC_N / 2);
  if (i < 0 || j < 0 || i >= OCC_N || j >= OCC_N) return -1;
  return j * OCC_N + i;
}

function widest(h: Shape): number {
  let w = 0;
  for (const c of h.corridor) w = Math.max(w, c.half);
  return w;
}

/** ホールの回廊と林の帯を、使った土地として塗る。 */
function markHole(occ: Uint8Array, h: Shape, origin: Vec2): void {
  let x0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let z1 = -Infinity;
  for (const p of h.line) {
    x0 = Math.min(x0, p.x);
    z0 = Math.min(z0, p.z);
    x1 = Math.max(x1, p.x);
    z1 = Math.max(z1, p.z);
  }
  const reach = widest(h) + ROUGH + GAP;
  for (let z = z0 - reach; z <= z1 + reach; z += OCC_STEP) {
    for (let x = x0 - reach; x <= x1 + reach; x += OCC_STEP) {
      const k = occIndex(x, z, origin);
      if (k < 0) continue;
      const l = lineDistance(h.line, x, z);
      if (l.d < stationHalf(h.corridor, Math.min(l.s, h.corridor[h.corridor.length - 1].s)) + ROUGH + GAP) occ[k] = 1;
    }
  }
}

/**
 * ホールを置けるか（使った土地に掛からないか）と、置き方の良し悪し（小さいほど良い）。
 * 置けなければ Infinity。
 */
function placeCost(h: Shape, route: Route, origin: Vec2, last: boolean): number {
  const L = h.length;
  for (let s = 24; s <= L; s += 12) {
    const { p, d } = frameAt(h.line, s);
    if (Math.hypot(p.x - origin.x, p.z - origin.z) > REACH) return Infinity;
    const r = right(d);
    const half = stationHalf(h.corridor, Math.min(s, h.corridor[h.corridor.length - 1].s)) + ROUGH;
    for (const off of [-half, -half / 2, 0, half / 2, half]) {
      const q = occIndex(p.x + r.x * off, p.z + r.z * off, origin);
      if (q < 0 || route.occ[q]) return Infinity;
    }
  }
  const g = h.green;
  // コースを少しまとめる（1 番のティーから遠くへ延びすぎない）。最後のホールは 1 番のティーへ戻る。
  // 強くまとめると、関係のないホールのグリーンどうしが寄って、上から見てどれがどのホールか読めなくなった。
  let cost = Math.hypot(g.x - origin.x, g.z - origin.z) / 450;
  // 関係のないホールとの間隔（実際のコースの目安: ティーとグリーンは他のホールの落とし所に入れず、
  // 並んだフェアウェイの中心線は 60〜70m 離す。グリーンどうしが近いと、どのホールのものか読めない）。
  const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.z - b.z);
  const landingOf = (x: Shape) => frameAt(x.line, Math.min(240, x.length * 0.62)).p;
  const tee = h.line[0];
  const land = landingOf(h);
  route.holes.forEach((o, k) => {
    const previous = k === route.holes.length - 1;
    const returning = last && k === 0;
    const oTee = o.line[0];
    const oLand = landingOf(o);
    if (dist(g, o.green) < 95) cost += 25;
    if (!previous && dist(tee, o.green) < 70) cost += 25;
    if (dist(tee, oTee) < 50) cost += 15;
    if (!returning && dist(g, oTee) < 70) cost += 25;
    if (o.par > 3 && dist(g, oLand) < 60) cost += 25;
    if (h.par > 3 && dist(land, o.green) < 60) cost += 25;
    if (h.par > 3 && !previous && dist(land, oTee) < 60) cost += 25;
  });
  if (last) cost += Math.hypot(g.x - origin.x, g.z - origin.z) / 40;
  // 前のホールと同じ向きに打たせない（変化をつける）。
  const prev = route.holes[route.holes.length - 1];
  if (prev) {
    const pa = prev.line[prev.line.length - 2];
    const pb = prev.line[prev.line.length - 1];
    const plen = Math.hypot(pb.x - pa.x, pb.z - pa.z) || 1;
    const na = h.line[0];
    const nb = h.line[1];
    const nlen = Math.hypot(nb.x - na.x, nb.z - na.z) || 1;
    const dot = ((pb.x - pa.x) * (nb.x - na.x) + (pb.z - pa.z) * (nb.z - na.z)) / (plen * nlen);
    if (dot > 0.9) cost += 1.5;
  }
  return cost;
}

/**
 * 計画どおりに 9 ホールを並べる。何もない土地に並べるので、どの合言葉でも必ず並ぶ
 * （行き詰まった並べ方は捨て、残った中で一番良いものを採る）。
 */
export function routeCourse(seed: string): CourseDesign {
  const plan = planCourse(seed);
  const rand = mulberry32(hashSeed(`${seed}:route`)[0]);
  const origin = { x: (rand() - 0.5) * 240, z: (rand() - 0.5) * 240 };
  let beam: Route[] = [{ holes: [], occ: new Uint8Array(OCC_N * OCC_N), cost: 0 }];

  for (let n = 0; n < plan.length; n++) {
    const slot = plan[n];
    const t = TEMPLATE[slot.kind];
    const last = n === plan.length - 1;
    const next: { route: Route; hole: Shape; cost: number }[] = [];
    for (const route of beam) {
      const prev = route.holes[route.holes.length - 1];
      // ティーの候補: 1 番は始まりの点、それ以外は前のグリーンの周り 40m。
      const tees = prev ? DIRS.filter((_, k) => k % 2 === 0).map((d) => add(prev.green, d, 40)) : [origin];
      for (const tee of tees) {
        for (const dir of DIRS) {
          for (const side of [-1, 1]) {
            for (const length of t.lengths) {
              for (let variant = 0; variant < t.variants; variant++) {
                const hole = shape(slot, { tee, dir, side, length, variant });
                const c = placeCost(hole, route, origin, last);
                if (!Number.isFinite(c)) continue;
                // 合言葉の乱数で揺らし、同じくらい良い置き方の中から選ぶ。
                next.push({ route, hole, cost: route.cost + c + rand() * 1.2 });
              }
            }
          }
        }
      }
    }
    if (next.length === 0) break;
    next.sort((a, b) => a.cost - b.cost);
    // 同じ並べ方ばかり残らないよう、元の並べ方ごとに 2 本まで。
    const kept: Route[] = [];
    const perParent = new Map<Route, number>();
    for (const c of next) {
      const used = perParent.get(c.route) ?? 0;
      if (used >= 2) continue;
      perParent.set(c.route, used + 1);
      const occ = c.route.occ.slice();
      markHole(occ, c.hole, origin);
      kept.push({ holes: [...c.route.holes, c.hole], occ, cost: c.cost });
      if (kept.length >= BEAM) break;
    }
    beam = kept;
  }
  const best = beam.reduce((a, b) =>
    b.holes.length > a.holes.length || (b.holes.length === a.holes.length && b.cost < a.cost) ? b : a,
  );
  return { holes: best.holes.map((h, k) => ({ ...h, number: k + 1 })) };
}

// ── 高さを入れる ─────────────────────────────────────

/** できた地面（ground）に合わせて、ティーの台・グリーンの面・池の水面・ピン位置を決める。 */
export function settleCourse(design: CourseDesign, ground: (x: number, z: number) => number): CourseDesign {
  return { holes: design.holes.map((h) => settleHole(h, ground)) };
}

function settleHole(h: HoleDesign, groundAt: (x: number, z: number) => number): HoleDesign {
  const ground = (p: Vec2) => groundAt(p.x, p.z);
  const g = h.green;
  const base = GREEN_BASE[g.kind];
  let green: GreenDesign;
  if (g.kind === 'redan') {
    // 長軸に沿って、手前の角から奥へ 3% 下る。
    green = { ...g, h: ground(g) + base.raise, sx: -g.ax * 0.03, sz: -g.az * 0.03 };
  } else {
    // 手前（fx, fz）から奥へ上る。
    green = { ...g, h: ground(g) + base.raise, sx: -g.fx * base.tilt, sz: -g.fz * base.tilt };
  }
  // 池の水面: 池の中と岸で一番低い地面より少し下（岸が水面より上に残るように）。
  const ponds = h.ponds.map((p) => {
    const a = { x: p.ax, z: p.az };
    const ra = right(a);
    let lo = ground(p);
    for (const d of DIRS) {
      for (const k of [0.6, 1.3]) lo = Math.min(lo, ground(add(add(p, a, d.x * p.rx * k), ra, d.z * p.rz * k)));
    }
    return { ...p, level: Math.max(1.5, lo - 0.4) };
  });
  return { ...h, tee: { ...h.tee, h: ground(h.tee) + 0.6 }, green, ponds, pins: pickPins(green) };
}
