import { hashSeed } from '../core/rng';
import { ISLAND_SIZE } from '../island/grid';
import type { IslandParams } from '../island/params';
import { Climate } from './climate';
import type { IslandWater } from './islandWater';
import { Noise2D, clamp, mix, smoothstep } from './noise';
import { type SpecialHit, specialAt } from './special';
import type { CourseField } from '../golf/field';
import type { Surface } from '../golf/ball';
import { SURFACE_STRIDE, composeSurface, surfaceIsland } from './islandSurface';
import { srgb } from './special';
import { IslandShape, type LandscapeArrays, type SurfaceFields } from './islandShape';

export const SEA_LEVEL = 0;

/** 刈り込んだ芝とバンカーの砂の色（リニア RGB）。 */
const C_FAIRWAY = srgb(0x74a64c);
const C_TEE = srgb(0x86b85a);
const C_GREEN = srgb(0x72c95a);
const C_SAND = srgb(0xe4d3a2);
/** 谷底の森の地面（木の下の暗い緑）。 */
const C_FOREST_FLOOR = srgb(0x2f5a26);
/** 林間コースのラフ（フェアウェイより深い緑）。自然の草の色に 7 割だけ寄せて、むらを残す。 */
const C_ROUGH = srgb(0x5d8a3c);

/**
 * 四角形をどちらの対角線で 2 つの三角形に割るか。true なら h00-h11。
 *
 * chunk.ts と heightOnGrid は必ずこの同じ関数を使う。高低差が小さい方を
 * 選ぶことで遠景の山肌に同じ向きの斜め縞が出るのを防ぐ。
 */
export function splitsAlongMainDiagonal(
  h00: number,
  h10: number,
  h01: number,
  h11: number,
): boolean {
  return Math.abs(h00 - h11) <= Math.abs(h01 - h10);
}

/**
 * 島の地形の公開窓口。stroll の Terrain と同じ API（描画・植生・プレイヤーはこれだけを見る）。
 *
 * 標高は、隆起させた山を川が削った島の大きな形（island/landscape.ts）に細部を足したもの
 * （islandShape.ts）。湖と川は島全体の格子で求めた水（islandWater.ts）を重ねる。
 * 水を渡さなければ、水を計算する前の地形になる（島全体の水を求めるときに使う）。
 */
export class Terrain {
  readonly params: IslandParams;
  private readonly shape: IslandShape;
  private readonly climate: Climate;
  private readonly nSpecialEdge: Noise2D;
  private readonly specialSalt: number;
  private readonly nPatch: Noise2D;
  private readonly nRock: Noise2D;
  private readonly fields: SurfaceFields = { slope: 0, curvature: 0, drainage: 0 };
  private readonly layers = new Float32Array(SURFACE_STRIDE);
  private readonly moistureBias: number;
  /** ゴルフの世界の谷底 0..1（landscape の格子。無ければ null）。 */
  private readonly valley: Float32Array | null;
  private readonly valleyN: number;
  private readonly warmthBias: number;

  constructor(
    params: IslandParams,
    landscape: LandscapeArrays,
    private readonly water: IslandWater | null = null,
    /** ゴルフコースの造成（golf/field.ts）。地面を設計した面へ寄せ、芝と砂と池を入れる。 */
    private readonly course: CourseField | null = null,
  ) {
    this.params = params;
    this.valley = landscape.valley ?? null;
    this.valleyN = landscape.n;
    const [a, b, c, d] = hashSeed(params.seed);
    this.shape = new IslandShape(landscape, d);
    this.climate = new Climate(a, b, c, d, this.shape.massAt);
    // 区画抽選にもシードを混ぜる。忘れると全部の島で宝物の位置が同じになる。
    this.nSpecialEdge = new Noise2D((a ^ 0x165667b1) >>> 0);
    this.specialSalt = (b ^ 0x9e3779b1) >>> 0;
    this.nPatch = new Noise2D((d ^ 0x61c88647) >>> 0);
    this.nRock = new Noise2D((c ^ 0x2545f491) >>> 0);
    this.moistureBias = mix(-0.3, 0.3, params.wetness / 100);
    this.warmthBias = mix(-0.35, 0.35, params.warmth / 100);
  }

  /**
   * 地面のむら -1..1。数十 m の波長で、草の色味と雪線・岩線の位置を揺らす。
   * 色にしか使わないので標高・植生の配置には影響しない。
   */
  patchAt(x: number, z: number): number {
    return (
      this.nPatch.noise(x * 0.011, z * 0.011) * 0.65 +
      this.nPatch.noise(x * 0.037 + 31.7, z * 0.037 - 17.3) * 0.35
    );
  }

  /** 宝物区画の判定。詳しくは special.ts。 */
  specialAt(x: number, z: number): SpecialHit {
    return specialAt(x, z, this.nSpecialEdge, this.specialSalt);
  }

  /** 谷底の強さ 0..1（ゴルフの世界で、山の輪の内側）。 */
  private valleyAt(x: number, z: number): number {
    const v = this.valley;
    if (!v) return 0;
    const n = this.valleyN;
    const fx = Math.max(0, Math.min(n - 1.001, (x / ISLAND_SIZE + 0.5) * (n - 1)));
    const fz = Math.max(0, Math.min(n - 1.001, (z / ISLAND_SIZE + 0.5) * (n - 1)));
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const u = fx - i;
    const w = fz - j;
    const k = j * n + i;
    return (v[k] * (1 - u) + v[k + 1] * u) * (1 - w) + (v[k + n] * (1 - u) + v[k + n + 1] * u) * w;
  }

  /** コースとその林、谷底の強さ 0..1（青々とした温帯の林にする所）。 */
  private keptAt(x: number, z: number): number {
    const valley = this.valleyAt(x, z);
    if (!this.course?.sample(x, z)) return valley;
    return Math.max(valley, this.course.clear, this.course.forest);
  }

  /**
   * 森のかたまり 0..1.4。植生の密度に掛ける。コースのホールの間と、山の輪の内側の谷底は森で埋める
   * （打つ回廊には、mownAt が木を生やさない）。
   */
  groveAt(x: number, z: number): number {
    const g = this.climate.groveAt(x, z);
    // ホールの間の林は濃く（打つ回廊を縁取る）、谷底の森は程々に（地面の色で森に見せる。木を増やすと重い）。
    const course = this.course?.sample(x, z) ? this.course.forest : 0;
    const valley = this.valleyAt(x, z);
    const target = Math.max(g * (1 - valley * 0.5), 1.4 * course, 0.55 * valley);
    return target;
  }

  /** 湿り気 0..1。独立ノイズへ山塊による雨陰を重ね、湿り気のつまみでずらす。 */
  moistureAt(x: number, z: number): number {
    const m = clamp(this.climate.moistureAt(x, z) + this.moistureBias, 0, 1);
    // コースと谷底の森は青々としている（山に囲まれた谷は雨陰で乾きやすいため）。
    const kept = this.keptAt(x, z);
    return m + (Math.max(m, 0.78) - m) * kept;
  }

  /** 気温 0..1（0 が寒い、1 が暑い）。標高が上がるほど冷え、暖かさのつまみでずらす。 */
  temperatureAt(x: number, z: number, h: number): number {
    const t = clamp(this.climate.temperatureAt(x, z, h) + this.warmthBias, 0, 1);
    // コースと谷底の森は温帯の林間（寒い所に当たっても、ツンドラの色と針葉樹だけにしない）。
    // 周りの山はそのまま（高い所は雪）。
    const kept = this.keptAt(x, z);
    return t + (Math.max(t, 0.52) - t) * kept;
  }

  /** 内陸の水面（湖・川・コースの池）。無ければ -Infinity。海は render/water.ts の板が担当する。 */
  waterLevelAt(x: number, z: number): number {
    const lake = this.water ? this.water.levelAt(x, z) : -Infinity;
    return this.course ? Math.max(lake, this.course.waterAt(x, z)) : lake;
  }

  /**
   * 標高。海面は 0。川に合わせて彫った量を足す。
   * 川と湖の中では細部を弱める。細部が水面から顔を出すと、湖に粒の小島が並び、川に土手が立つ。
   */
  heightAt(x: number, z: number): number {
    if (!this.water) return this.shape.heightAt(x, z);
    const carve = this.water.carveAt(x, z);
    const calm = Math.max(this.water.wetAt(x, z), smoothstep(0, 1.5, -carve));
    const h = this.shape.heightAt(x, z, 1 - calm) + carve;
    // コースの中は設計した面へ寄せる（周りへはなめらかにつなぐ）。
    return this.course ? this.course.blend(x, z, h) : h;
  }

  /** 木を生やさない強さ 0..1（コースの打つ回廊・ティー・グリーン・バンカー・池）。 */
  mownAt(x: number, z: number): number {
    if (!this.course || !this.course.sample(x, z)) return 0;
    return this.course.clear;
  }

  /**
   * 球が転がる地面の種類（golf/ball.ts）。刈り込んだ所、浜の砂、岩、雪、それ以外はラフ。
   * 見た目の塗り分け（surface）と同じ層から決めるので、見えている通りに転がる。
   */
  surfaceKind(x: number, z: number): Surface {
    if (this.course?.sample(x, z)) {
      const c = this.course;
      if (c.green > 0.5) return 'green';
      if (c.sand > 0.5) return 'sand';
      if (c.tee > 0.5 || c.fairway > 0.5) return 'fairway';
      // 回廊の中は浜の高さでも砂にしない（造成した芝のラフ）。
      if (c.clear > 0.5) return 'rough';
    }
    const h = this.heightAt(x, z);
    if (h < 3.2) return 'sand';
    const e = 2;
    const dx = (this.heightAt(x + e, z) - this.heightAt(x - e, z)) / (2 * e);
    const dz = (this.heightAt(x, z + e) - this.heightAt(x, z - e)) / (2 * e);
    const temp = this.temperatureAt(x, z, h);
    this.surface(x, z, h, Math.sqrt(dx * dx + dz * dz), temp, this.moistureAt(x, z), this.specialAt(x, z), this.patchAt(x, z), this.layers, 0);
    if (this.layers[7] > 0.5) return 'snow';
    if (this.layers[6] > 0.5) return 'rock';
    return 'rough';
  }

  /**
   * チャンクメッシュと同じ三角形分割で標高を補間する。
   * プレイヤーの足元が見た目の地面とズレないようにするため。
   */
  heightOnGrid(x: number, z: number, step: number): number {
    const x0 = Math.floor(x / step) * step;
    const z0 = Math.floor(z / step) * step;
    const u = (x - x0) / step;
    const v = (z - z0) / step;

    const h00 = this.heightAt(x0, z0);
    const h10 = this.heightAt(x0 + step, z0);
    const h01 = this.heightAt(x0, z0 + step);
    const h11 = this.heightAt(x0 + step, z0 + step);

    if (splitsAlongMainDiagonal(h00, h10, h01, h11)) {
      if (v >= u) return h00 * (1 - v) + h01 * (v - u) + h11 * u;
      return h00 * (1 - u) + h10 * (u - v) + h11 * v;
    }
    if (u + v <= 1) return h00 * (1 - u - v) + h01 * v + h10 * u;
    return h01 * (1 - u) + h10 * (1 - v) + h11 * (u + v - 1);
  }

  /**
   * 地面の層（土台・岩・雪の色と量、凹みの明暗）。気温 × 湿り気の気候帯に、侵食が作った
   * 地形の性質（谷筋・尾根・水の集まり）で塗り分けを重ねる（islandSurface.ts）。
   * slopeLocal はその点の細部の傾き。out[o..o+SURFACE_STRIDE) に書き込む。色は 0..1 のリニア RGB。
   * 層は画素ごとに混ぜる（render/terrainMaterial.ts）。
   */
  surface(
    x: number,
    z: number,
    h: number,
    slopeLocal: number,
    temp: number,
    moisture: number,
    special: SpecialHit,
    patch: number,
    out: Float32Array,
    o: number,
  ): void {
    this.shape.fieldsAt(x, z, this.fields);
    // 岩の種類は地方ごと（波長 約 1.5km）。
    const rockTone = this.nRock.noise(x * 0.0007, z * 0.0007);
    surfaceIsland(h, slopeLocal, this.fields, temp, moisture, special, patch, rockTone, out, o);
    this.paintForestFloor(x, z, out, o);
    if (this.course) this.paintMown(x, z, out, o);
  }

  /**
   * 谷底の森の地面は濃い緑（木の下の暗い地面）。木を詰め込んで森に見せると木が 2.5 倍・三角形が 1.6 倍に
   * なって重くなったので、地面の色で森の濃さを出し、木は程々にする。
   */
  private paintForestFloor(x: number, z: number, out: Float32Array, o: number): void {
    let f = this.valleyAt(x, z);
    if (this.course?.sample(x, z)) f = Math.max(f, this.course.forest) * (1 - this.course.clear);
    if (f <= 0) return;
    const k = f * 0.8;
    for (let c = 0; c < 3; c++) out[o + c] += (C_FOREST_FLOOR[c] - out[o + c]) * k;
    out[o + 6] *= 1 - f;
    out[o + 7] *= 1 - f;
  }

  /** コースの芝と砂の色。岩と雪は消す（造成した所に岩肌や雪は出さない）。 */
  private paintMown(x: number, z: number, out: Float32Array, o: number): void {
    const m = this.course!;
    if (!m.sample(x, z)) return;
    const any = Math.max(m.green, m.tee, m.fairway, m.sand, m.clear);
    if (any <= 0) return;
    for (let c = 0; c < 3; c++) {
      let v = out[o + c];
      v += (C_ROUGH[c] - v) * m.rough * 0.7;
      v += (C_FAIRWAY[c] - v) * m.fairway;
      v += (C_TEE[c] - v) * m.tee;
      v += (C_GREEN[c] - v) * m.green;
      v += (C_SAND[c] - v) * m.sand;
      out[o + c] = v;
    }
    out[o + 6] *= 1 - any;
    out[o + 7] *= 1 - any;
  }

  /** 層を混ぜ切った 1 色（小さな地図用）。out[o..o+3) にリニア RGB を書く。 */
  shade(
    x: number,
    z: number,
    h: number,
    slopeLocal: number,
    temp: number,
    moisture: number,
    special: SpecialHit,
    patch: number,
    out: Float32Array,
    o: number,
  ): void {
    this.surface(x, z, h, slopeLocal, temp, moisture, special, patch, this.layers, 0);
    composeSurface(this.layers, 0, out, o);
  }
}
