/**
 * 「今日」の決まり。ピンと風・今日のコース・COM の乱数は、すべてこの日を使う（同じ日なら誰でも同じ）。
 * 日の区切りは日本時間の 0 時（主に遊ぶ人が日本にいるので、「今日」が夜中の 0 時に替わるように）。
 * 世界標準時の 0 時で区切っていた頃は、日本では朝 9 時にピンと風が替わっていた。
 */
const DAY_MS = 86_400_000;
const DAY_OFFSET_MS = 9 * 3_600_000;

/** 今日の番号（1970/1/1 からの日数、日本時間）。 */
export function dayIndex(now = Date.now()): number {
  return Math.floor((now + DAY_OFFSET_MS) / DAY_MS);
}

/** 「9/27」の形の日付。 */
export function dayLabel(day = dayIndex()): string {
  const d = new Date(day * DAY_MS);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}
