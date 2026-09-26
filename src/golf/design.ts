import { hashSeed, mulberry32 } from '../core/rng';

/**
 * コースの設計図。**コースを先に作り、地形は後から合わせる**。
 *
 * 1. 並べる（routeCourse）: 何もない平らな土地に、9 ホールを輪のように並べる。1 番のティーから始め、
 *    前のグリーンのそばに次のティーを置き、9 番のグリーンは 1 番のティーのそばへ戻る。
 *    ホールどうしは林の帯を挟める間隔を空ける。地形に合わせないので、どの合言葉でも必ず並ぶ
 * 2. 地形は、この設計図から作る（island/landscape.ts がコースの周りを谷底にし、外を山で囲む）
 * 3. 高さを入れる（settleCourse）: できた地面に合わせて、ティーの台・グリーンの面・池の水面を決める
 * 4. 造成する（golf/field.ts）: フェアウェイのうねり、バンカー、池、グリーンの形を地面に刻む
 *
 * ホールの形は型（テンプレート）から作る。型は C.B. Macdonald と Seth Raynor が名ホールから
 * 抜き出したものと、林間コースのよくある形。
 * - Cape（パー 4）: 曲がり角の内側を池が包む。大胆に角を越えるほど次が短い
 * - Redan（パー 3）: 斜めに奥へ傾いた台地のグリーン。手前の角に深いバンカー
 * - Sahara（パー 5）: 2 打目の落とし所を砂の荒れ地が横切る。越えるか、手前に刻むか
 * - Short（パー 3）: 小さなグリーンをバンカーが囲む
 * - まっすぐ（パー 4）: 落とし所の両側からバンカーが狭める
 * - ドッグレッグ（パー 4）: 角の外側にバンカー、内側は林
 * - 池越え（パー 5）: グリーンの手前に池。2 打目で越えるか、刻むか（英雄型）
 *
 * 合言葉だけで決まる（決定性の決まり: 四則演算・sqrt・floor だけ。角度は表から引く）。
 */

export interface Vec2 {
  x: number;
  z: number;
}

/** 楕円（中心・半径 2 つ・向き）。向きは長軸の単位ベクトルで持つ（三角関数を生成の中で使わないため）。 */
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

export type GreenKind = 'redan' | 'plain' | 'punchbowl';

export interface GreenDesign extends Ellipse {
  kind: GreenKind;
  /** グリーンの中心の高さ（m）と、x・z 方向の傾き（m/m）。settleCourse が入れる。 */
  h: number;
  sx: number;
  sz: number;
  /** すり鉢の深さ（Punchbowl）。 */
  bowl: number;
  /** 手前（ティーの側）の向き。すり鉢の縁を開ける側。 */
  fx: number;
  fz: number;
}

export type HoleKind = 'cape' | 'redan' | 'sahara' | 'short' | 'straight' | 'dogleg' | 'lake';

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
  redan: { c: 0.819152, s: 0.5735764 },
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

// ── 型 ──────────────────────────────────────────────

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

function greenEllipse(kind: GreenKind, c: Vec2, rx: number, rz: number, axis: Vec2, front: Vec2): GreenDesign {
  return { ...ellipse(c, rx, rz, axis), kind, h: 0, sx: 0, sz: 0, bowl: 0, fx: -front.x, fz: -front.z };
}

/** 型ごとのパー、長さの候補（m）、変種（曲がりの角度など）の数。 */
const TEMPLATE: Record<HoleKind, { par: number; lengths: number[]; variants: number }> = {
  cape: { par: 4, lengths: [340, 365, 390], variants: 2 },
  redan: { par: 3, lengths: [150, 165, 180], variants: 1 },
  sahara: { par: 5, lengths: [465, 490, 510], variants: 2 },
  short: { par: 3, lengths: [115, 130, 145], variants: 1 },
  straight: { par: 4, lengths: [350, 380, 410], variants: 1 },
  dogleg: { par: 4, lengths: [345, 370, 395], variants: 1 },
  lake: { par: 5, lengths: [470, 495, 520], variants: 2 },
};

type Shape = Omit<HoleDesign, 'number'>;

/** 型からホールの形を作る（高さは settleCourse で入れる）。 */
function shape(kind: HoleKind, b: Build): Shape {
  const { tee, dir: d, side, length: L } = b;
  const r = right(d);
  const inside = { x: r.x * side, z: r.z * side };
  const par = TEMPLATE[kind].par;
  const teeOut = { x: tee.x, z: tee.z, h: 0, ax: d.x, az: d.z };
  const base = { kind, par, tee: teeOut, length: L, ponds: [] as Pond[] };

  if (kind === 'cape' || kind === 'dogleg') {
    // 角まで 220m 前後、そこから曲がる。Cape は角の内側に池、ドッグレッグは外側にバンカー。
    const cornerS = kind === 'cape' ? 225 : 235;
    const corner = add(tee, d, cornerS);
    const d2 = turn(d, side, kind === 'dogleg' ? TURN.dogleg : b.variant === 0 ? TURN.cape35 : TURN.cape45);
    const g = add(corner, d2, L - cornerS);
    const green = greenEllipse('plain', g, 15, 12, d2, d2);
    const r2 = right(d2);
    const common = {
      ...base,
      line: [tee, corner, g],
      pin: add(g, d2, 3),
      aim: add(tee, d, cornerS - 10),
      green,
      fairway: [
        { s: 150, half: 17 },
        { s: 215, half: 24 },
        { s: 260, half: 22 },
        { s: L - 60, half: 16 },
        { s: L - green.rx + 2, half: 13 },
      ],
    };
    if (kind === 'cape') {
      return {
        ...common,
        bunkers: [
          bunker(add(add(tee, d, cornerS + 30), inside, -27), 13, 5.5, d, 1.1),
          bunker(add(add(g, d2, 16), r2, -side * 6), 9, 4, r2, 1.2),
          bunker(add(add(g, d2, -6), r2, side * 16), 8, 4, d2, 1.3),
        ],
        ponds: [{ ...ellipse(add(add(tee, d, cornerS - 30), inside, 38), 52, 24, d), level: 0 }],
      };
    }
    return {
      ...common,
      bunkers: [
        // 角の外側に 2 つ（まっすぐ打ちすぎた球を捕まえる）。
        bunker(add(add(tee, d, cornerS + 12), inside, -24), 12, 5, d, 1.1),
        bunker(add(add(tee, d, cornerS + 40), inside, -20), 9, 4.5, d, 1.0),
        bunker(add(add(g, d2, -8), r2, side * 15), 9, 4, d2, 1.2),
      ],
    };
  }

  if (kind === 'redan') {
    // まっすぐ。グリーンは side 側へ斜めに奥へ延び、奥へ下る。手前の side 側に深いバンカー。
    const g = add(tee, d, L);
    const axis = turn(d, side, TURN.redan);
    const green = greenEllipse('redan', g, 21, 10, axis, d);
    return {
      ...base,
      line: [tee, g],
      pin: add(g, axis, 7),
      aim: add(g, axis, 4),
      green,
      // 手前の反対側に、転がして乗せる花道（Redan の「蹴り」の斜面）。
      fairway: [
        { s: L - 50, half: 12 },
        { s: L - green.rz - 4, half: 15 },
      ],
      bunkers: [
        bunker(add(add(g, d, -13), r, side * 9), 13, 4.5, axis, 1.8),
        bunker(add(add(g, d, 6), r, -side * 16), 6, 3.5, d, 1.1),
      ],
    };
  }

  if (kind === 'short') {
    // 小さなグリーンを 4 つのバンカーが囲む。
    const g = add(tee, d, L);
    const green = greenEllipse('plain', g, 12, 10, r, d);
    return {
      ...base,
      line: [tee, g],
      pin: add(g, r, side * 3),
      aim: { x: g.x, z: g.z },
      green,
      fairway: [
        { s: L - 38, half: 10 },
        { s: L - 12, half: 12 },
      ],
      bunkers: [
        bunker(add(add(g, d, -13), r, -8), 6, 3.5, r, 1.4),
        bunker(add(add(g, d, -12), r, 9), 6, 3.5, r, 1.4),
        bunker(add(g, r, side * 16), 4, 7, d, 1.3),
        bunker(add(g, d, 15), 7, 3, r, 1.2),
      ],
    };
  }

  if (kind === 'straight') {
    // まっすぐ。落とし所を両側から狭め、グリーンの手前の両脇にバンカー。
    const g = add(tee, d, L);
    const green = greenEllipse('plain', g, 15, 12, d, d);
    return {
      ...base,
      line: [tee, g],
      pin: add(g, r, side * 4),
      aim: add(tee, d, 235),
      green,
      fairway: [
        { s: 160, half: 18 },
        { s: 230, half: 22 },
        { s: 280, half: 20 },
        { s: L - 40, half: 16 },
        { s: L - green.rx + 1, half: 13 },
      ],
      bunkers: [
        bunker(add(add(tee, d, 240), r, side * 21), 11, 5, d, 1.0),
        bunker(add(add(tee, d, 270), r, -side * 23), 10, 5, d, 1.0),
        bunker(add(add(g, d, -12), r, -14), 7, 4, d, 1.2),
        bunker(add(add(g, d, -10), r, 15), 7, 4, d, 1.2),
      ],
    };
  }

  // sahara と lake: 280m 付近で少し曲がる（または曲がらない）パー 5。
  const bendS = 280;
  const bend = add(tee, d, bendS);
  const d2 = b.variant === 0 ? d : turn(d, side, TURN.slight);
  const g = add(bend, d2, L - bendS);
  const r2 = right(d2);
  if (kind === 'sahara') {
    const green = greenEllipse('punchbowl', g, 15, 14, d2, d2);
    const wasteC = add(g, d2, -95);
    return {
      ...base,
      line: [tee, bend, g],
      pin: { x: g.x, z: g.z },
      aim: add(tee, d, 235),
      green,
      fairway: [
        { s: 170, half: 18 },
        { s: 240, half: 24 },
        { s: L - 125, half: 21 },
        { s: L - 70, half: 19 },
        { s: L - green.rx + 1, half: 14 },
      ],
      bunkers: [
        // 砂の荒れ地（3 つの楕円を重ねて、横切る帯にする）。
        bunker(wasteC, 30, 16, r2, 0.9),
        bunker(add(add(wasteC, r2, 22), d2, 6), 18, 12, r2, 0.8),
        bunker(add(add(wasteC, r2, -24), d2, -5), 17, 11, r2, 0.8),
        // ティーショットの落とし所を片側から狭めるバンカー。
        bunker(add(add(tee, d, 235), r, side * 21), 11, 5, d, 1.0),
      ],
    };
  }
  // lake: グリーンの手前に池。刻むならフェアウェイは池の 30m 手前まで。
  const green = greenEllipse('plain', g, 15, 13, r2, d2);
  return {
    ...base,
    line: [tee, bend, g],
    pin: add(g, d2, 3),
    aim: add(tee, d, 240),
    green,
    fairway: [
      { s: 170, half: 18 },
      { s: 245, half: 24 },
      { s: L - 110, half: 21 },
      { s: L - 70, half: 20 },
    ],
    bunkers: [
      bunker(add(add(tee, d, 245), r, -side * 22), 11, 5, d, 1.0),
      bunker(add(add(g, d2, 14), r2, side * 10), 8, 4, r2, 1.2),
    ],
    ponds: [{ ...ellipse(add(g, d2, -36), 30, 15, r2), level: 0 }],
  };
}

// ── 並べる ───────────────────────────────────────────

/** 9 ホールの型の並び（パー 36）。 */
const ORDER: HoleKind[] = ['straight', 'dogleg', 'short', 'sahara', 'cape', 'redan', 'dogleg', 'lake', 'straight'];
/** ホールの回廊（フェアウェイとラフ）の半分の幅（m）と、隣のホールとの間に挟む林の帯（m）。 */
const CORRIDOR = 34;
const GAP = 18;
/** 並べる範囲（1 番のティーからの半径、m）。 */
const REACH = 780;
/** 同時に育てる並べ方の数。 */
const BEAM = 6;

/** 並べる途中の状態。occ は使った土地（8m の升目）。 */
interface Route {
  holes: Shape[];
  occ: Uint8Array;
  cost: number;
}

const OCC_STEP = 8;
const OCC_N = Math.ceil((REACH * 2 + 200) / OCC_STEP);

function occIndex(x: number, z: number, origin: Vec2): number {
  const i = Math.floor((x - origin.x) / OCC_STEP + OCC_N / 2);
  const j = Math.floor((z - origin.z) / OCC_STEP + OCC_N / 2);
  if (i < 0 || j < 0 || i >= OCC_N || j >= OCC_N) return -1;
  return j * OCC_N + i;
}

/** ホールの回廊と林の帯を、使った土地として塗る。 */
function markHole(occ: Uint8Array, h: Shape, origin: Vec2): void {
  const reach = CORRIDOR + GAP;
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
  for (let z = z0 - reach; z <= z1 + reach; z += OCC_STEP) {
    for (let x = x0 - reach; x <= x1 + reach; x += OCC_STEP) {
      const k = occIndex(x, z, origin);
      if (k >= 0 && lineDistance(h.line, x, z).d < reach) occ[k] = 1;
    }
  }
}

/**
 * ホールを置けるか（使った土地に掛からないか）と、置き方の良し悪し（小さいほど良い）。
 * 置けなければ Infinity。
 */
function placeCost(h: Shape, route: Route, origin: Vec2, last: boolean): number {
  // 回廊の中を 12m ごとに、左右に振って見る。
  for (let k = 0; k < h.line.length - 1; k++) {
    const a = h.line[k];
    const b = h.line[k + 1];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const d = { x: (b.x - a.x) / len, z: (b.z - a.z) / len };
    const r = right(d);
    // ティーのすぐ後ろ（前のグリーンのそば）は、前のホールの林の帯に掛かってよい。
    for (let s = k === 0 ? 24 : 0; s <= len; s += 12) {
      const c = add(a, d, s);
      if (Math.hypot(c.x - origin.x, c.z - origin.z) > REACH) return Infinity;
      for (const off of [-CORRIDOR, -CORRIDOR / 2, 0, CORRIDOR / 2, CORRIDOR]) {
        const q = occIndex(c.x + r.x * off, c.z + r.z * off, origin);
        if (q < 0 || route.occ[q]) return Infinity;
      }
    }
  }
  const g = h.green;
  // コースをまとめる（1 番のティーから遠くへ延びすぎない）。最後のホールは 1 番のティーへ戻る。
  let cost = Math.hypot(g.x - origin.x, g.z - origin.z) / 250;
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
 * 9 ホールを並べる。何もない土地に並べるので、どの合言葉でも必ず並ぶ
 * （行き詰まった並べ方は捨て、残った中で一番良いものを採る。全部が行き詰まることは、
 * 範囲の広さとホールの数から起こらない。起きても置けた所までのコースを返す）。
 */
export function routeCourse(seed: string): CourseDesign {
  const rand = mulberry32(hashSeed(`${seed}:route`)[0]);
  const origin = { x: (rand() - 0.5) * 240, z: (rand() - 0.5) * 240 };
  let beam: Route[] = [{ holes: [], occ: new Uint8Array(OCC_N * OCC_N), cost: 0 }];

  for (let n = 0; n < ORDER.length; n++) {
    const kind = ORDER[n];
    const t = TEMPLATE[kind];
    const last = n === ORDER.length - 1;
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
                const hole = shape(kind, { tee, dir, side, length, variant });
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
  const best = beam.reduce((a, b) => (b.holes.length > a.holes.length || (b.holes.length === a.holes.length && b.cost < a.cost) ? b : a));
  return { holes: best.holes.map((h, k) => ({ ...h, number: k + 1 })) };
}

// ── 高さを入れる ─────────────────────────────────────

/** できた地面（ground）に合わせて、ティーの台・グリーンの面・池の水面を決める。 */
export function settleCourse(design: CourseDesign, ground: (x: number, z: number) => number): CourseDesign {
  return { holes: design.holes.map((h) => settleHole(h, ground)) };
}

function settleHole(h: HoleDesign, groundAt: (x: number, z: number) => number): HoleDesign {
  const ground = (p: Vec2) => groundAt(p.x, p.z);
  const g = h.green;
  const gh = ground(g);
  // グリーンの型: Redan は台地で奥へ下る（3%）、ふつうは手前へ少し下る（受ける）、Punchbowl はすり鉢。
  let green: GreenDesign;
  if (g.kind === 'redan') {
    green = { ...g, h: gh + 1.1, sx: -g.ax * 0.03, sz: -g.az * 0.03 };
  } else if (g.kind === 'plain') {
    // 手前（fx, fz の逆）へ 2% 下る。
    green = { ...g, h: gh + 0.5, sx: -g.fx * 0.02, sz: -g.fz * 0.02 };
  } else {
    green = { ...g, h: gh - 0.2, bowl: 0.7 };
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
  return { ...h, tee: { ...h.tee, h: ground(h.tee) + 0.6 }, green, ponds };
}
