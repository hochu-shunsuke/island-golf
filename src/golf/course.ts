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
 * ホールの一覧。ピン位置は日ごとに替える（同じ URL なら同じ日は誰でも同じピン）。
 * day は 1970 年からの日数。
 */
export function holesOf(design: CourseDesign, day: number): Hole[] {
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
    };
  });
}
