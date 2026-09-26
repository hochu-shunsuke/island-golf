/**
 * 島のつまみ。URL の `#` 以降に載るので、同じ URL なら誰が開いても同じ島になる。
 * サーバに島を保存しない（送るのは URL だけ）。
 *
 * つまみは 0..100 の整数に揃える。URL が短く読め、端末ごとの小数の揺れも入らない。
 */

export interface IslandParams {
  /** 島の種。同じつまみでも種が違えば別の島になる。英数字。 */
  seed: string;
  /** 島の大きさ（陸の広さ）。 */
  size: number;
  /** 形。0 でまとまった 1 つの島、100 で入り組んだ多島海。 */
  shape: number;
  /** 山の高さ。 */
  mountains: number;
  /** 侵食。大きいほど谷が深く刻まれ、尾根が細くなる。 */
  erosion: number;
  /** 湿り気。大きいほど川・湖・森が増える。 */
  wetness: number;
  /** 暖かさ。0 で雪の島、100 で南の島。 */
  warmth: number;
}

export type ParamKey = Exclude<keyof IslandParams, 'seed'>;

export interface ParamSpec {
  key: ParamKey;
  /** URL での短い名前。 */
  short: string;
  label: string;
  low: string;
  high: string;
}

export const PARAM_SPECS: readonly ParamSpec[] = [
  { key: 'size', short: 'z', label: '島の大きさ', low: '小さい', high: '大きい' },
  { key: 'shape', short: 'h', label: '形', low: 'まとまった島', high: '多島海' },
  { key: 'mountains', short: 'm', label: '山', low: 'なだらか', high: '険しい' },
  { key: 'erosion', short: 'e', label: '谷の刻み', low: '浅い', high: '深い' },
  { key: 'wetness', short: 'w', label: '湿り気', low: '乾いた', high: '水と森' },
  { key: 'warmth', short: 't', label: '暖かさ', low: '雪', high: '南国' },
];

/** ゴルフの世界で効くつまみ（島の大きさと形はコースから決まるので出さない）。 */
export const COURSE_PARAM_SPECS: readonly ParamSpec[] = PARAM_SPECS.filter((s) => s.key !== 'size' && s.key !== 'shape');

export const DEFAULT_PARAMS: IslandParams = {
  seed: 'hakoniwa',
  size: 55,
  shape: 35,
  mountains: 55,
  erosion: 50,
  wetness: 55,
  warmth: 55,
};

const SEED_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';

/** 紛らわしい文字を避けた 6 文字の種。 */
export function randomSeed(): string {
  let s = '';
  const buf = new Uint32Array(6);
  crypto.getRandomValues(buf);
  for (const v of buf) s += SEED_CHARS[v % SEED_CHARS.length];
  return s;
}

/** 種は英数字だけにする（URL にそのまま載せるため）。 */
export function cleanSeed(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16);
}

const clamp100 = (v: number) => Math.max(0, Math.min(100, Math.round(v)));

/** `#seed.z55.h35...` の形。区切りに `.` を使い、URL の中で読める形にする。 */
export function encodeParams(p: IslandParams): string {
  const parts = [p.seed];
  for (const spec of PARAM_SPECS) parts.push(`${spec.short}${clamp100(p[spec.key])}`);
  return parts.join('.');
}

/** 読めない部分は既定値で埋める。壊れた URL でも必ず島を出す。 */
export function decodeParams(hash: string): IslandParams {
  const p: IslandParams = { ...DEFAULT_PARAMS };
  const parts = hash.replace(/^#/, '').split('.');
  const seed = cleanSeed(parts[0] ?? '');
  if (seed) p.seed = seed;
  for (const part of parts.slice(1)) {
    const spec = PARAM_SPECS.find((s) => part.startsWith(s.short));
    if (!spec) continue;
    const v = Number(part.slice(spec.short.length));
    if (Number.isFinite(v)) p[spec.key] = clamp100(v);
  }
  return p;
}
