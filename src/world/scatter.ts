import { hash2 } from '../core/rng';
import { CLIMATE_STEP } from './climate';
import { clamp, mix } from './noise';
import { CHUNK_SIZE } from './chunk';
import { NO_SPECIAL, type SpecialHit } from './special';
import type { Terrain } from './terrain';
import {
  DEFAULT_TINT,
  GIANT_MAX,
  GIANT_MIN,
  type KindSpec,
  VEGETATION_SPECS,
} from './vegetationSpecs';

export { KIND_BROADLEAF, KIND_BUSH, KIND_PINE, KIND_ROCK } from './vegetationKinds';

export interface ScatterBatch {
  kind: number;
  /** 4x4 行列を並べた列（16 要素 × インスタンス数）。 */
  matrices: Float32Array;
  /** インスタンスごとの色ムラ（3 要素 × インスタンス数）。 */
  colors: Float32Array;
}

/**
 * 開始地点のまわりに、視界を塞ぐ木が生えるか。
 *
 * 候補格子・乱数・各 biome の place() を本番配置と共有する。別の簡易判定を
 * 書くと「空き地を選んだつもりなのに木の中」という食い違いが再発するため。
 * 湿り気だけはチャンク補間前の値だが、波長 1,100m 以上なので半径数mでは同じ。
 */
export function hasTallVegetationNear(
  terrain: Terrain,
  centerX: number,
  centerZ: number,
  radius: number,
): boolean {
  const r2 = radius * radius;
  for (const spec of VEGETATION_SPECS) {
    if (!spec.blocksSpawn) continue;
    const g0 = Math.floor((centerX - radius) / spec.spacing);
    const g1 = Math.floor((centerX + radius) / spec.spacing);
    const k0 = Math.floor((centerZ - radius) / spec.spacing);
    const k1 = Math.floor((centerZ + radius) / spec.spacing);
    for (let gx = g0; gx <= g1; gx++) {
      for (let gz = k0; gz <= k1; gz++) {
        const x = (gx + hash2(gx, gz, spec.salt + 1)) * spec.spacing;
        const z = (gz + hash2(gx, gz, spec.salt + 2)) * spec.spacing;
        if ((x - centerX) ** 2 + (z - centerZ) ** 2 >= r2) continue;

        // 宝物専用の木は、区画外ならここで終える。以前は桜・秋それぞれで
        // 地形・雨陰・気温まで計算してから place() の先頭で捨てていた。
        let special: SpecialHit | null = null;
        if (spec.specialIndex !== undefined) {
          special = terrain.specialAt(x, z);
          if (special.index !== spec.specialIndex) continue;
        }

        const h = terrain.heightAt(x, z);
        if (h < 0.8 || h < terrain.waterLevelAt(x, z) + 0.6) continue;
        CTX.h = h;
        CTX.r = hash2(gx, gz, spec.salt);
        if (spec.specialIndex === undefined) {
          CTX.moisture = terrain.moistureAt(x, z);
          CTX.temp = terrain.temperatureAt(x, z, h);
        } else {
          // 宝物の木は気候を無視する。使い回す CTX に前候補の値を残さない。
          CTX.moisture = 0;
          CTX.temp = 0;
        }
        CTX.special = special ?? terrain.specialAt(x, z);
        CTX.grove = terrain.groveAt(x, z);
        CTX._t = terrain;
        CTX._x = x;
        CTX._z = z;
        CTX._ready = false;
        if (spec.place(CTX) > 0) return true;
      }
    }
  }
  return false;
}

/** 3 点差分で地面の傾きを測り、あわせて「上の崖の急さ」も出す。 */
function slopeAndTalus(t: Terrain, x: number, z: number, h: number, out: Float32Array): void {
  const d = 2.5;
  const dx = (t.heightAt(x + d, z) - h) / d;
  const dz = (t.heightAt(x, z + d) - h) / d;
  const g = Math.hypot(dx, dz);
  out[0] = clamp(g / 1.6, 0, 1);
  if (g < 1e-4) {
    out[1] = 0;
    return;
  }
  // 上り方向へ 14m 進んだ先がどれだけ高いか ＝ 頭上の崖の急さ。
  // 転石はここから落ちてくる。
  const up = t.heightAt(x + (dx / g) * TALUS_LOOK, z + (dz / g) * TALUS_LOOK);
  out[1] = clamp((up - h) / TALUS_LOOK, 0, 2);
}

/** 頭上の崖を探す距離（m）。 */
const TALUS_LOOK = 14;

// slopeAndTalus の受け皿。候補ごとに配列を作らないため。
const ST = new Float32Array(2);

/**
 * place() に渡す文脈。使い回して割り当てを避ける。
 *
 * slope と talus は heightAt を 3 回呼ぶので、**参照されたときだけ**計算する。
 * ほとんどの候補は密度の抽選で先に落ちるので、そこまで到達しない。
 */
const CTX = {
  h: 0,
  temp: 0,
  moisture: 0,
  special: NO_SPECIAL as SpecialHit,
  grove: 0,
  r: 0,
  // 以下は遅延評価のための内部状態。
  _t: null as Terrain | null,
  _x: 0,
  _z: 0,
  _ready: false,
  _calc(): void {
    if (this._ready) return;
    this._ready = true;
    slopeAndTalus(this._t!, this._x, this._z, this.h, ST);
  },
  get slope(): number {
    this._calc();
    return ST[0];
  },
  get talus(): number {
    this._calc();
    return ST[1];
  },
};

/**
 * Y 軸回転 → X 軸の微傾き → スケール、を合成した 4x4 行列を列優先で書き出す。
 * （Worker 側に three を持ち込まないため手計算する）
 */
export function composeInto(
  out: Float32Array,
  o: number,
  px: number, py: number, pz: number,
  yaw: number, tilt: number,
  sx: number, sy: number, sz: number,
): void {
  const cb = Math.cos(yaw), sb = Math.sin(yaw);
  const ca = Math.cos(tilt), sa = Math.sin(tilt);
  out[o + 0] = cb * sx;        out[o + 1] = 0 * sx;   out[o + 2] = -sb * sx;      out[o + 3] = 0;
  out[o + 4] = sb * sa * sy;   out[o + 5] = ca * sy;  out[o + 6] = cb * sa * sy;  out[o + 7] = 0;
  out[o + 8] = sb * ca * sz;   out[o + 9] = -sa * sz; out[o + 10] = cb * ca * sz; out[o + 11] = 0;
  out[o + 12] = px;            out[o + 13] = py;      out[o + 14] = pz;           out[o + 15] = 1;
}

/**
 * どの形にするか（spec.kinds の添字）。同じ形ばかりだと壁紙に見える。
 * チャンク（buildScatterData）と島全体の遠景の木（island/forest.ts）が同じ関数を使い、
 * 同じ場所に同じ形の木を置く。
 */
export function variantOf(spec: KindSpec, gx: number, gz: number): number {
  const nv = spec.kinds.length;
  return nv === 1 ? 0 : Math.min(nv - 1, (hash2(gx, gz, spec.salt + 9) * nv) | 0);
}

/**
 * 1 本分の行列と色を書き込む。巨木・向き・傾き・縦の伸び・色むらは候補の格子番号だけで決まる。
 * チャンクと島全体の遠景の木が同じ関数を使うので、近づいて本物の木に切り替わっても位置も形も飛ばない。
 */
export function writeInstance(
  spec: KindSpec,
  gx: number,
  gz: number,
  scale: number,
  px: number,
  py: number,
  pz: number,
  matrices: Float32Array,
  index: number,
  colors: Float32Array,
): void {
  // たまに巨木。大きさが揃っていると並木に見えるので、対比を作る。
  if (spec.giantChance) {
    const g = hash2(gx, gz, spec.salt + 8);
    if (g < spec.giantChance) scale *= mix(GIANT_MIN, GIANT_MAX, g / spec.giantChance);
  }
  const yaw = hash2(gx, gz, spec.salt + 3) * Math.PI * 2;
  // わずかに傾いている方が並木らしくならず自然に見える。
  const tilt = (hash2(gx, gz, spec.salt + 4) - 0.5) * 0.14;
  const sy = scale * (0.85 + hash2(gx, gz, spec.salt + 5) * 0.4);
  composeInto(matrices, index * 16, px, py, pz, yaw, tilt, scale, sy, scale);

  // 明るさに加えて色相も振る。以前は明度だけだったので、同じ緑が
  // 並んで壁紙に見えていた。黄緑〜青緑に散らすと森らしくなる。
  const bright = 0.82 + hash2(gx, gz, spec.salt + 6) * 0.36;
  const hue = hash2(gx, gz, spec.salt + 7) - 0.5;
  const tint = spec.tint ?? DEFAULT_TINT;
  colors[index * 3] = bright * tint[0] * (1 + hue * 0.16);
  colors[index * 3 + 1] = bright * tint[1];
  colors[index * 3 + 2] = bright * tint[2] * (1 - hue * 0.18);
}

/**
 * チャンク内の木・岩の配置を計算する。
 * 位置はワールド座標のハッシュだけで決まるので、チャンク境界で不自然に途切れず、
 * 読み込み直しても同じ場所に生える。
 * 座標はチャンク原点からの相対値。
 */
export function buildScatterData(
  terrain: Terrain,
  cx: number,
  cz: number,
  lod: number,
): ScatterBatch[] {
  const ox = cx * CHUNK_SIZE;
  const oz = cz * CHUNK_SIZE;
  const batches: ScatterBatch[] = [];

  // 湿り気は粗い格子で引いて補間する（CLIMATE_STEP 参照）。
  // 格子は CHUNK_SIZE を割り切るので、隣のチャンクと世界座標で一致する。
  const cg = CHUNK_SIZE / CLIMATE_STEP;
  const cw = cg + 1;
  const mgrid = new Float32Array(cw * cw);
  for (let j = 0; j < cw; j++) {
    for (let i = 0; i < cw; i++) {
      mgrid[j * cw + i] = terrain.moistureAt(ox + i * CLIMATE_STEP, oz + j * CLIMATE_STEP);
    }
  }
  const moistureAt = (x: number, z: number) => {
    const u = (x - ox) / CLIMATE_STEP;
    const v = (z - oz) / CLIMATE_STEP;
    const i = Math.min(cg - 1, Math.max(0, u | 0));
    const j = Math.min(cg - 1, Math.max(0, v | 0));
    const fu = u - i;
    const fv = v - j;
    const a = mgrid[j * cw + i];
    const b = mgrid[j * cw + i + 1];
    const c = mgrid[(j + 1) * cw + i];
    const d = mgrid[(j + 1) * cw + i + 1];
    return (a + (b - a) * fu) * (1 - fv) + (c + (d - c) * fu) * fv;
  };

  for (const spec of VEGETATION_SPECS) {
    if (lod > spec.maxLod) continue;

    const g0 = Math.floor(ox / spec.spacing);
    const g1 = Math.floor((ox + CHUNK_SIZE - 0.001) / spec.spacing);
    const k0 = Math.floor(oz / spec.spacing);
    const k1 = Math.floor((oz + CHUNK_SIZE - 0.001) / spec.spacing);

    // 形ごとに別の InstancedMesh になるので、配列も形ごとに持つ。
    // 上限いっぱいで確保し、最後に実数へ切り詰める。
    const cap = (g1 - g0 + 1) * (k1 - k0 + 1);
    const nv = spec.kinds.length;
    const mats: Float32Array[] = [];
    const cols: Float32Array[] = [];
    const counts: number[] = [];
    for (let v = 0; v < nv; v++) {
      mats.push(new Float32Array(cap * 16));
      cols.push(new Float32Array(cap * 3));
      counts.push(0);
    }

    for (let gx = g0; gx <= g1; gx++) {
      for (let gz = k0; gz <= k1; gz++) {
        const r = hash2(gx, gz, spec.salt);
        const x = (gx + hash2(gx, gz, spec.salt + 1)) * spec.spacing;
        const z = (gz + hash2(gx, gz, spec.salt + 2)) * spec.spacing;
        if (x < ox || x >= ox + CHUNK_SIZE || z < oz || z >= oz + CHUNK_SIZE) continue;

        // 宝物専用の木は大半のチャンクに存在しない。地形・気候より先に
        // 区画だけ調べ、桜と秋の全候補を通常地域で評価しないようにする。
        let special: SpecialHit | null = null;
        if (spec.specialIndex !== undefined) {
          special = terrain.specialAt(x, z);
          if (special.index !== spec.specialIndex) continue;
        }

        const h = terrain.heightAt(x, z);
        // 水面下と、明らかに条件外の場所は重い判定に入る前に落とす。
        if (h < 0.8) continue;
        // **内陸の湖も水面下。** ここは海面（0m）しか見ていなかったので、
        // 湖の中に木がびっしり生えていた。湖の水面は場所ごとに高さが違うので、
        // 海と同じ判定では拾えない。heightAt が既に区画を引いているため、
        // ここでの引き直しは覚えてある値の読み出しで済む。
        if (h < terrain.waterLevelAt(x, z) + 0.6) continue;
        // ゴルフで刈り込んだ所（グリーン・ティー・フェアウェイ）には生やさない。
        if (terrain.mownAt(x, z) > 0.05) continue;
        CTX.h = h;
        CTX.r = r;
        if (spec.specialIndex === undefined) {
          CTX.moisture = moistureAt(x, z);
          CTX.temp = terrain.temperatureAt(x, z, h);
        } else {
          CTX.moisture = 0;
          CTX.temp = 0;
        }
        CTX.special = special ?? terrain.specialAt(x, z);
        CTX.grove = terrain.groveAt(x, z);
        // 傾きと転石はここでは計算しない。place() が触ったときだけ求める。
        CTX._t = terrain;
        CTX._x = x;
        CTX._z = z;
        CTX._ready = false;
        let scale = spec.place(CTX);
        if (scale <= 0) continue;

        const v = variantOf(spec, gx, gz);
        writeInstance(spec, gx, gz, scale, x - ox, h - 0.25, z - oz, mats[v], counts[v], cols[v]);
        counts[v]++;
      }
    }

    for (let v = 0; v < nv; v++) {
      if (counts[v] === 0) continue;
      batches.push({
        kind: spec.kinds[v],
        matrices: mats[v].slice(0, counts[v] * 16),
        colors: cols[v].slice(0, counts[v] * 3),
      });
    }
  }

  return batches;
}
