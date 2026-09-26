import { ISLAND_SIZE } from '../island/grid';
import { Noise2D, fbmEroded, mix, smoothstep } from './noise';

/**
 * 島の標高を 1 点ずつ引く。島の大きな形（隆起と侵食、island/landscape.ts）を
 * 3 次補間で滑らかに引き、細かい起伏を足す。
 *
 * 大きな形は 16m 格子なので、そのまま双一次で補間すると 2m のチャンクで格子の折れ目が
 * 筋になって見える。Catmull-Rom の 3 次補間で折れ目を消す。
 *
 * 細部は山ほど強く、浜と谷底（川・湖）では弱くする。細部が水面から顔を出すと、
 * 湖に小島の粒が並び、川の中に土手が立つ。
 */

export interface LandscapeArrays {
  /** 1 辺の点数。 */
  n: number;
  /** 侵食した後の大きな地形（m）。 */
  height: Float32Array;
  /** 大きな地形の傾き・曲がり（正 = 尾根、負 = 谷筋）・水の集まり 0..1。色を塗るのに使う。 */
  slope: Float32Array;
  curvature: Float32Array;
  drainage: Float32Array;
  /** ゴルフの世界だけ: 山の輪の内側の谷底 0..1（ここを森で埋める）。 */
  valley?: Float32Array;
}

/** 色を塗るための地形の性質（fieldsAt が書き込む）。 */
export interface SurfaceFields {
  slope: number;
  curvature: number;
  drainage: number;
}

/** 島の格子の外（外洋）の深さ（m）。landscape.ts の一番深い海と揃える。 */
const OPEN_SEA = -70;
/** 細部の起伏の強さ（m）。平地と山。 */
const DETAIL_LOW = 0.6;
const DETAIL_HIGH = 7;
/** 細部の波長のもと（1/m）。約 50m から 4 段で約 6m まで。 */
const DETAIL_FREQ = 0.02;

function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  return (
    p1 +
    0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)))
  );
}

export class IslandShape {
  private readonly nDetail: Noise2D;

  constructor(
    private readonly land: LandscapeArrays,
    seed: number,
  ) {
    this.nDetail = new Noise2D((seed ^ 0x9e3779b9) >>> 0);
  }

  private toGrid(v: number): number {
    return (v / ISLAND_SIZE + 0.5) * (this.land.n - 1);
  }

  private at(i: number, j: number): number {
    const { n, height } = this.land;
    const ci = i < 0 ? 0 : i >= n ? n - 1 : i;
    const cj = j < 0 ? 0 : j >= n ? n - 1 : j;
    return height[cj * n + ci];
  }

  /** 大きな形だけ（双一次）。雨陰の計算など、細部の要らない所で使う。 */
  readonly massAt = (x: number, z: number): number => {
    const { n } = this.land;
    const u = this.toGrid(x);
    const v = this.toGrid(z);
    if (u < 0 || v < 0 || u > n - 1 || v > n - 1) return OPEN_SEA;
    const i = Math.min(n - 2, u | 0);
    const j = Math.min(n - 2, v | 0);
    const fu = u - i;
    const fv = v - j;
    const a = this.at(i, j);
    const b = this.at(i + 1, j);
    const c = this.at(i, j + 1);
    const d = this.at(i + 1, j + 1);
    return (a + (b - a) * fu) * (1 - fv) + (c + (d - c) * fu) * fv;
  };

  /** 色を塗るための地形の性質を、大きな形の格子から双一次で引く。 */
  fieldsAt(x: number, z: number, out: SurfaceFields): SurfaceFields {
    const { n, slope, curvature, drainage } = this.land;
    const u = this.toGrid(x);
    const v = this.toGrid(z);
    if (u < 0 || v < 0 || u >= n - 1 || v >= n - 1) {
      out.slope = 0;
      out.curvature = 0;
      out.drainage = 0;
      return out;
    }
    const i = u | 0;
    const j = v | 0;
    const fu = u - i;
    const fv = v - j;
    const k = j * n + i;
    const lerp = (f: Float32Array) =>
      (f[k] + (f[k + 1] - f[k]) * fu) * (1 - fv) + (f[k + n] + (f[k + n + 1] - f[k + n]) * fu) * fv;
    out.slope = lerp(slope);
    out.curvature = lerp(curvature);
    out.drainage = lerp(drainage);
    return out;
  }

  /** 大きな形（3 次補間）。 */
  macroAt(x: number, z: number): number {
    const { n } = this.land;
    const u = this.toGrid(x);
    const v = this.toGrid(z);
    if (u < 0 || v < 0 || u > n - 1 || v > n - 1) return OPEN_SEA;
    const i = Math.min(n - 2, u | 0);
    const j = Math.min(n - 2, v | 0);
    const fu = u - i;
    const fv = v - j;
    const row = (jj: number) =>
      catmullRom(this.at(i - 1, jj), this.at(i, jj), this.at(i + 1, jj), this.at(i + 2, jj), fu);
    return catmullRom(row(j - 1), row(j), row(j + 1), row(j + 2), fv);
  }

  /**
   * 標高。detail は細部の効き（0..1）。水の中では呼び側が弱める。
   */
  heightAt(x: number, z: number, detail = 1): number {
    const macro = this.macroAt(x, z);
    if (detail <= 0 || macro < -6) return macro;
    // 浜（海抜数 m）は細部を消して、なだらかな砂浜にする。
    const amp =
      mix(DETAIL_LOW, DETAIL_HIGH, smoothstep(20, 300, macro)) * smoothstep(-2, 8, macro) * detail;
    return macro + fbmEroded(this.nDetail, x, z, 4, DETAIL_FREQ) * amp;
  }
}
