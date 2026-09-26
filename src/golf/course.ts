import type { CourseDesign, HoleDesign, HoleKind } from './design';

/**
 * 遊ぶ側（golf/game.ts・画面）から見たホール。形の詳しいことは設計図（golf/design.ts）と
 * 造成（golf/field.ts）が持ち、ここには打つのに要る所だけを抜き出す。
 */
export interface Hole {
  number: number;
  kind: HoleKind;
  par: number;
  /** 打つ線に沿ったティーからピンまでの長さ（m）。 */
  length: number;
  tee: { x: number; z: number; h: number };
  pin: { x: number; z: number };
  /** ティーショットで狙う所（曲がったホールでは角の手前）。 */
  aim: { x: number; z: number };
}

/** 型の呼び名（画面に出す）。 */
export const KIND_NAMES: Record<HoleKind, string> = {
  cape: 'ケープ',
  redan: 'レダン',
  sahara: 'サハラ',
};

export function holesOf(design: CourseDesign): Hole[] {
  return design.holes.map((h: HoleDesign) => ({
    number: h.number,
    kind: h.kind,
    par: h.par,
    length: h.length,
    tee: { x: h.tee.x, z: h.tee.z, h: h.tee.h },
    pin: { x: h.pin.x, z: h.pin.z },
    aim: { x: h.aim.x, z: h.aim.z },
  }));
}
