/**
 * クラブ。打ち出し角・最大の初速・スピン（揚力の強さ）。
 * 平らなフェアウェイでの飛距離（キャリー＋転がり）を test/ball.test.mjs で確かめて合わせてある。
 */
export interface Club {
  name: string;
  /** 打ち出し角（度）。0 はパター（転がす）。 */
  loft: number;
  /** 力いっぱい打ったときの初速（m/s）。 */
  speed: number;
  /** バックスピン（揚力の強さ 0..1）。 */
  spin: number;
}

export const CLUBS: readonly Club[] = [
  { name: 'ドライバー', loft: 11, speed: 72, spin: 0.75 },
  { name: '5番アイアン', loft: 20, speed: 54, spin: 0.85 },
  { name: '9番アイアン', loft: 36, speed: 41, spin: 1 },
  { name: 'ウェッジ', loft: 50, speed: 31, spin: 1.1 },
  { name: 'パター', loft: 0, speed: 6, spin: 0 },
];
