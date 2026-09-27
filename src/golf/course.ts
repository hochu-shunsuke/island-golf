import { hashSeed, mulberry32 } from '../core/rng';
import type { CourseDesign, Elevation, HoleDesign, HoleKind } from './design';
import { GREEN_NAMES, type GreenKind } from './greens';

/**
 * 遊ぶ側（golf/game.ts・画面）から見たホール。形の詳しいことは設計図（golf/design.ts）と
 * 造成（golf/field.ts）が持ち、ここには打つのに要る所だけを抜き出す。
 */
export interface Hole {
  number: number;
  kind: HoleKind;
  par: number;
  elevation: Elevation;
  green: GreenKind;
  /** 打つ線に沿ったティーからグリーンの中心までの長さ（m）。 */
  length: number;
  tee: { x: number; z: number; h: number };
  /** 今日のピン。 */
  pin: { x: number; z: number };
  /** ティーショットで狙う所（曲がったホールでは角の手前、1 オン狙いのパー 4 では刻む所）。 */
  aim: { x: number; z: number };
  /** 今日の風（m/s、水平）。 */
  wind: { x: number; z: number };
  /** 打つ線（ティー → 曲がり角 → グリーン）。ホールの小さな地図の向きと範囲に使う。 */
  line: { x: number; z: number }[];
}

/** 型の呼び名（画面に出す）。 */
export const KIND_NAMES: Record<HoleKind, string> = {
  straight: 'ストレート',
  dogleg: 'ドッグレッグ',
  cape: 'ケープ',
  split: '2 本のフェアウェイ',
  angle: '角度のホール',
  drivable: '1 オン狙い',
  short: 'ショート',
  redan: 'レダン',
  biarritz: 'ビアリッツ',
  sahara: 'サハラ',
  lake: '池越え',
};

export const ELEVATION_NAMES: Record<Elevation, string> = {
  flat: '',
  downhill: '打ち下ろし',
  uphill: '打ち上げ',
  valley: '谷越え',
};

/** ホールの紹介（ホールに立ったときに出す）。 */
export function holeIntro(h: Hole): string {
  const parts = [`${h.number} 番 ${KIND_NAMES[h.kind]}`, `パー ${h.par} · ${Math.round(h.length)} m`];
  if (ELEVATION_NAMES[h.elevation]) parts.push(ELEVATION_NAMES[h.elevation]);
  parts.push(GREEN_NAMES[h.green]);
  return parts.join(' · ');
}

/**
 * ホールの風。日ごとに変わる（同じ URL なら同じ日は誰でも同じ風）。多くは 1〜5m/s、たまに無風や強風。
 * 風は Golf Clash やみんゴルでも、どこへ落とすかを考える一番の材料。
 */
function windFor(seed: string, day: number, number: number): { x: number; z: number } {
  const rand = mulberry32(hashSeed(`${seed}:wind:${day}:${number}`)[0]);
  const a = rand() * Math.PI * 2;
  const r = rand();
  const speed = r < 0.1 ? 0 : r < 0.85 ? 1 + ((r - 0.1) / 0.75) * 4 : 5 + ((r - 0.85) / 0.15) * 3;
  return { x: Math.cos(a) * speed, z: Math.sin(a) * speed };
}

/**
 * ホールの一覧。ピン位置と風は日ごとに替える（同じ URL なら同じ日は誰でも同じ）。
 * day は 1970 年からの日数。
 */
export function holesOf(design: CourseDesign, day: number, seed: string): Hole[] {
  return design.holes.map((h: HoleDesign) => {
    const pin = h.pins.length > 0 ? h.pins[(day + h.number) % h.pins.length] : { x: h.green.x, z: h.green.z };
    return {
      number: h.number,
      kind: h.kind,
      par: h.par,
      elevation: h.elevation,
      green: h.green.kind,
      length: h.length,
      tee: { x: h.tee.x, z: h.tee.z, h: h.tee.h },
      pin: { x: pin.x, z: pin.z },
      aim: { x: h.aim.x, z: h.aim.z },
      wind: windFor(seed, day, h.number),
      line: h.line.map((p) => ({ x: p.x, z: p.z })),
    };
  });
}

/** ホールの外側の余白（m）。フェアウェイの脇の林も、ホールと同じ細かさで読み込む。 */
const HOLE_MARGIN = 50;

/**
 * ホールを遊ぶのに読み込む範囲（打つ線・ティー・ピン・狙う所を囲む矩形に余白を足したもの、m）。
 * 遊んでいる間と、空撮でそのホールを映す間はこの範囲を読み込んだままにするので、カメラが動いても地形の粗さや木が
 * 差し替わらない。
 */
export function holeArea(h: Hole): { x0: number; z0: number; x1: number; z1: number } {
  let x0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let z1 = -Infinity;
  for (const p of [...h.line, h.tee, h.pin, h.aim]) {
    x0 = Math.min(x0, p.x);
    z0 = Math.min(z0, p.z);
    x1 = Math.max(x1, p.x);
    z1 = Math.max(z1, p.z);
  }
  return { x0: x0 - HOLE_MARGIN, z0: z0 - HOLE_MARGIN, x1: x1 + HOLE_MARGIN, z1: z1 + HOLE_MARGIN };
}
