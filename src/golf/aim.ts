import { BALL_RADIUS, Ball, type BallState, type GolfGround, SURFACE_FEEL, type Surface } from './ball';
import { CLUBS, DRIVER, PUTTER } from './clubs';

/**
 * 狙いの計算。プレイヤー（game.ts）と COM（rivals.ts）で同じものを使う。
 * - どのクラブを使えるか・どこまで届くか、距離に合うクラブ
 * - 狙った距離に落ちる力（平らな地面の表で見当をつけ、試し打ちで打ち上げ・打ち下ろしの分を直す）
 * - 正確さの針のずれが、向き・強さ・曲がりにどう効くか
 * three と画面には触らない（COM の読みとテストからも動かせるように）。
 */

export interface Point3 {
  x: number;
  y: number;
  z: number;
}

/** ライごとの飛びやすさ（初速に掛ける）。 */
export const LIE_POWER: Record<Surface, number> = {
  green: 1,
  fairway: 1,
  rough: 0.84,
  sand: 0.62,
  rock: 0.9,
  snow: 0.72,
};

/** 試し打ちの刻み（s）。粗くして軽く（落ちる所は 1m ほどしか違わない）。 */
export const PREVIEW_STEP = 1 / 60;

/** 針の真ん中とみなす幅（ナイスショット。ずれなしで打てる）。 */
export const PERFECT = 0.12;

/**
 * 散らばりを乱数ではなく腕で決める針（Golf Clash の正確さの針と同じ考え）。2026-09-29 に入れた。
 * 針は元の 1.45 倍速く（game.ts の NEEDLE_FACTOR。距離では変えない）、真ん中は狭く（±8%）、外すと大きく曲がる。
 * 元の針（±2°）では、自動で打たせるとパーオン率 92%・バンカー 0% で、ハザードが飾りになっていた（プロの実際は約 67%）。
 */
export const HARD_NEEDLE = { perfect: 0.08, yawDeg: 9, curve: 0.6, power: 0.1 };

/** 2 回押し: 距離の針を端で止めたときの強さのずれ（±30%）。プレイヤー（game.ts）と COM（rivals.ts）で同じ。 */
export const POWER_RANGE = 0.3;

/**
 * 距離の針の目盛り。左端は −30%、右端は +30% かそのクラブの全力（最大飛距離）の手前の方。
 * power は輪に届く強さ（全力を 1 として）。center は狙いどおり（倍率 1）になる針の位置（-1..1）で、
 * 最大の近くを狙うほど右へ寄る（右端で止めたときだけ全力。真ん中より右なら全部全力、にはしない）。
 */
export function distanceScale(power: number): { lo: number; hi: number; center: number } {
  const lo = 1 - POWER_RANGE;
  const hi = Math.max(1, Math.min(1 + POWER_RANGE, 1 / Math.max(0.05, power)));
  return { lo, hi, center: (2 * (1 - lo)) / (hi - lo) - 1 };
}

/** 距離の針を n（-1..1）で止めたときの強さの倍率。真ん中の帯（center から ±width）なら狙いどおり。 */
export function distanceGauge(n: number, power: number, width: number): { gauge: number; perfect: boolean } {
  const { lo, hi, center } = distanceScale(power);
  const perfect = Math.abs(n - center) < width;
  return { gauge: perfect ? 1 : lo + ((n + 1) / 2) * (hi - lo), perfect };
}


/** ライ lie から、クラブ c が届く一番遠いキャリー（m）。パターは転がる距離。 */
export function reachOf(c: number, lie: Surface): number {
  if (c === PUTTER) return 40;
  return CLUBS[c].carry * LIE_POWER[lie];
}

/** ドライバーはティー（strokes = 0）からだけ。パターはグリーンとその周り（フェアウェイ）だけ。 */
export function clubAllowed(c: number, strokes: number, lie: Surface): boolean {
  if (c === DRIVER) return strokes === 0;
  if (c === PUTTER) return lie === 'green' || lie === 'fairway';
  return true;
}

/** 距離 d に合うクラブ: 届くクラブのうち一番短いもの（力いっぱいに近い、きれいな弧で打てる）。 */
export function clubFor(d: number, strokes: number, lie: Surface): number {
  let pick = -1;
  for (let c = 0; c < PUTTER; c++) {
    if (!clubAllowed(c, strokes, lie)) continue;
    if (reachOf(c, lie) >= d) pick = c;
  }
  if (pick >= 0) return pick;
  // どれも届かなければ、使える一番長いクラブ。
  for (let c = 0; c < PUTTER; c++) if (clubAllowed(c, strokes, lie)) return c;
  return PUTTER - 1;
}

/** 平らな地面での力とキャリーの表（クラブごとに 1 度だけ作る）。 */
const carryTables = new Map<number, { p: number; carry: number }[]>();

function carryTable(c: number): { p: number; carry: number }[] {
  let table = carryTables.get(c);
  if (table) return table;
  table = [];
  const flat: GolfGround = { height: () => 0, water: () => -Infinity, surface: () => 'fairway' };
  const club = CLUBS[c];
  for (let p = 0.15; p <= 1.001; p += 0.05) {
    const sim = new Ball(flat, PREVIEW_STEP);
    sim.place(0, 0);
    sim.hit(0, club.loft, club.speed * p, club.spin, club.bite);
    for (let t = 0; t < 12 && sim.state === 'flight'; t += PREVIEW_STEP) sim.update(PREVIEW_STEP);
    table.push({ p, carry: -sim.pos.z });
  }
  carryTables.set(c, table);
  return table;
}

/** 表から、平らな地面でキャリー d になる力。 */
function powerFor(c: number, d: number): number {
  const table = carryTable(c);
  if (d <= table[0].carry) return table[0].p * Math.max(0.3, d / Math.max(1, table[0].carry));
  for (let k = 0; k < table.length - 1; k++) {
    const a = table[k];
    const b = table[k + 1];
    if (d <= b.carry) return a.p + ((b.p - a.p) * (d - a.carry)) / (b.carry - a.carry || 1);
  }
  return 1;
}

/** 試し打ちの結果: 落ちる所（最初に地面に触れた所）、飛ぶ間と落ちた後の点、止まった所。 */
export interface Trial {
  land: Point3 | null;
  /** 飛んでいる間の球の軌道（球の実際の高さ）。 */
  arc: Point3[];
  /** 落ちてから転がる点。 */
  roll: Point3[];
  end: Point3;
  state: BallState;
}

/**
 * from（ライ lie）から、クラブ c・向き yaw・力 power で試し打ちする。
 * wind を渡せば風の中で（COM の読み）、渡さなければ無風で（プレイヤーの狙いの線。Golf Clash と同じ）。
 */
export function trial(
  ground: GolfGround,
  from: { x: number; z: number },
  lie: Surface,
  c: number,
  yaw: number,
  power: number,
  wind: { x: number; z: number } | null = null,
): Trial {
  const club = CLUBS[c];
  const sim = new Ball(ground, PREVIEW_STEP);
  sim.place(from.x, from.z);
  sim.lie = lie;
  if (wind) sim.wind = wind;
  const lieLoss = c === PUTTER ? 1 : LIE_POWER[lie];
  sim.hit(yaw, club.loft, club.speed * power * lieLoss, club.spin, club.bite);
  const arc: Point3[] = [{ x: sim.pos.x, y: sim.pos.y + 0.05, z: sim.pos.z }];
  const roll: Point3[] = [];
  let land: Point3 | null = null;
  for (let t = 0; t < 14; t += PREVIEW_STEP) {
    sim.update(PREVIEW_STEP);
    const p = { x: sim.pos.x, y: sim.pos.y + 0.05, z: sim.pos.z };
    const h = ground.height(sim.pos.x, sim.pos.z);
    if (!land && club.loft > 0 && sim.pos.y - h < BALL_RADIUS + 0.05) {
      land = { ...p };
      // 空中の線を着地点まで繋ぐ。ここから先の跳ねと転がりは別の色で見せる。
      arc.push(p);
      roll.push(p);
    } else if (land || club.loft === 0) {
      roll.push(p);
    } else {
      // 物理計算どおりの高さを使う。地面へ投影すると、クラブごとの弾道差が消えて直線に見える。
      arc.push(p);
    }
    if (sim.state === 'rest' || sim.state === 'water') break;
  }
  if (!land) land = club.loft === 0 ? null : arc[arc.length - 1];
  return { land, arc, roll, end: { x: sim.pos.x, y: sim.pos.y, z: sim.pos.z }, state: sim.state };
}

/**
 * 距離 d に落ちる力を求める（パットは「d で止まる」強さ、平らなら）。
 * 平らな地面の表で見当をつけ、試し打ちで打ち上げ・打ち下ろしの分を、落ちる所が 0.8m 以内になるまで直す。
 */
export function solvePower(
  ground: GolfGround,
  from: { x: number; z: number },
  lie: Surface,
  c: number,
  yaw: number,
  d: number,
  wind: { x: number; z: number } | null = null,
  /** 試し打ちで直す回数の上限（0 なら表の見当だけ。COM が候補をざっと比べるとき）。 */
  refine = 5,
): { power: number; trial: Trial } {
  const club = CLUBS[c];
  if (c === PUTTER) {
    const a = SURFACE_FEEL[lie].roll * 9.81;
    const power = Math.min(1, Math.sqrt(2 * a * d) / club.speed);
    return { power, trial: trial(ground, from, lie, c, yaw, power, wind) };
  }
  let power = Math.min(1, powerFor(c, d / LIE_POWER[lie]));
  let result = trial(ground, from, lie, c, yaw, power, wind);
  for (let k = 0; k < refine && result.land; k++) {
    const got = Math.hypot(result.land.x - from.x, result.land.z - from.z);
    if (Math.abs(got - d) < 0.8 || got < 1) break;
    const next = Math.max(0.1, Math.min(1, power * Math.pow(d / got, 0.7)));
    if (Math.abs(next - power) < 1e-3) break;
    power = next;
    result = trial(ground, from, lie, c, yaw, power, wind);
  }
  return { power, trial: result };
}

/**
 * 針のずれ e（-1..1）が打球に効く分。真ん中（PERFECT の内）ならずれなし。
 * ずれるほど左右へ向きがずれて曲がり、少し短くなる。パットは曲がらず、ずれも小さい。
 */
export function needleEffect(
  e: number,
  putt: boolean,
  hard = false,
  /** 真ん中（ずれ無し）の幅。速い針では距離で狭くなる（game.ts の perfectWidth）。 */
  width = HARD_NEEDLE.perfect,
): { perfect: boolean; yaw: number; power: number; curve: number } {
  if (hard && !putt) {
    const perfect = Math.abs(e) < width;
    const x = perfect ? 0 : e;
    return {
      perfect,
      yaw: -((x * HARD_NEEDLE.yawDeg * Math.PI) / 180),
      power: 1 - Math.abs(x) * HARD_NEEDLE.power,
      curve: x * HARD_NEEDLE.curve,
    };
  }
  const perfect = Math.abs(e) < PERFECT;
  const x = perfect ? 0 : e;
  return {
    perfect,
    yaw: -((x * (putt ? 0.8 : 2) * Math.PI) / 180),
    power: 1 - Math.abs(x) * (putt ? 0.05 : 0.07),
    curve: putt ? 0 : x * 0.55,
  };
}
