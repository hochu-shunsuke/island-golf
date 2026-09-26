/**
 * クラブ。打ち出し角・最大の初速・スピン（揚力の強さ）・止まる強さ。
 *
 * 平らなフェアウェイで、実際のプロの弾道より少し高い「ゲームらしい弧」になるよう数値で合わせた
 * （最高点はどのクラブも 26〜33m、落ちる角度は 43〜56°、転がりはドライバー 25m からサンド 2m まで）。
 * 以前は 5 本で、最高点がドライバー 22m と低く、アイアンが 20m 以上転がっていた（「上に飛ばず、まっすぐ
 * 飛びがちで違和感がある」と言われた）。test/ball.test.mjs がキャリーと最高点を守る。
 */
export interface Club {
  name: string;
  /** 短い呼び名（画面の隅やボタン）。 */
  short: string;
  /** 打ち出し角（度）。0 はパター（転がす）。 */
  loft: number;
  /** 力いっぱい打ったときの初速（m/s）。 */
  speed: number;
  /** バックスピン（揚力の強さ）。 */
  spin: number;
  /** 落ちたときに止まる強さ（0..1）。 */
  bite: number;
  /** 平らなフェアウェイから力いっぱい打ったときのキャリー（m）。狙いの距離からクラブを選ぶのに使う。 */
  carry: number;
}

export const CLUBS: readonly Club[] = [
  { name: 'ドライバー', short: '1W', loft: 11, speed: 73.7, spin: 1.0, bite: 0.31, carry: 228 },
  { name: '3 番ウッド', short: '3W', loft: 16, speed: 66.4, spin: 0.9, bite: 0.47, carry: 205 },
  { name: '5 番アイアン', short: '5I', loft: 19, speed: 57.1, spin: 1.1, bite: 0.63, carry: 180 },
  { name: '7 番アイアン', short: '7I', loft: 27, speed: 51.1, spin: 0.8, bite: 0.72, carry: 155 },
  { name: '9 番アイアン', short: '9I', loft: 29, speed: 42.9, spin: 1.4, bite: 0.76, carry: 130 },
  { name: 'ピッチング', short: 'PW', loft: 34, speed: 36.8, spin: 1.7, bite: 0.81, carry: 105 },
  { name: 'サンド', short: 'SW', loft: 46, speed: 32, spin: 0.8, bite: 0.87, carry: 78 },
  { name: 'パター', short: 'PT', loft: 0, speed: 6, spin: 0, bite: 0, carry: 30 },
];

export const PUTTER = CLUBS.length - 1;
export const DRIVER = 0;
