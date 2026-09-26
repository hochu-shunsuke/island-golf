import { hashSeed } from '../core/rng';
import { Noise2D, fbm, mix, ridged, smoothstep } from '../world/noise';
import { type CourseDesign, lineDistance } from '../golf/design';
import { ISLAND_SIZE, NEIGHBORS8, makeGrid } from './grid';
import type { IslandParams } from './params';

/**
 * 島の大きな形。**隆起させた山を、川が削って作る。**
 *
 * stroll の標高の式は、無限の世界に「歩ける平地」を広げるためのもので、島にすると
 * 平らな土台にたまに山が載る形になった。ここでは土台そのものを動かす。
 *   1. 隆起の設計図: 島の輪郭の内側を、中心ほど高い山の形に持ち上げる。
 *      尾根のノイズで峰の数と連なりを変える
 *   2. 侵食（FastScape 型、Braun & Willett 2013）: 川の侵食 dh/dt = U − K·√A·S を陰的に解く。
 *      流れの向き → 上流からの並び → 集水面積 → 下流から解く、を繰り返す。
 *      枝分かれした谷と尾根、川の網が同じ計算から出る
 *   3. 斜面の拡散: 尾根を少し丸める
 *
 * 決定性の決まり（grid.ts）: 四則演算と sqrt だけ。集水面積の指数を 0.5 にしてあるのは sqrt で済ませるため。
 */

/** 侵食の繰り返し回数。少ないと侵食が内陸に届かず、中央に平らな台が残る。 */
const ITERATIONS = 140;
/** 一番深い海（m）。 */
const SEA_DEPTH = 70;

/**
 * 島のまわりの浅い棚（ラグーン）。海岸から少しの間は数 m の浅瀬が続き、棚の縁で深く落ちる。
 * 水面の色は水深で変わるので（render/water.ts）、浅瀬が島を明るいエメラルドの輪で縁取る。
 * 暖かい島ほど棚の縁にサンゴ礁の高まりを作り、そこに白波を立てる。
 */
const SHELF_DEPTH = 5;
/** 棚の幅（輪郭の値。海岸で 0、外へ向かって負に増える）。 */
const SHELF_END = 0.16;
const REEF_TOP = 1.2;
/**
 * 斜面の拡散の強さ（1 回あたり、格子 1 本分の係数）。0.25 を越えると不安定。
 * 0.06 では尾根が丸まりすぎ、谷の枝分かれが消えて丸い凸凹になった。
 */
const DIFFUSION = 0.015;

export interface Landscape {
  n: number;
  /** 侵食した後の大きな地形（m）。海面が 0。 */
  height: Float32Array;
  /** 大きな地形の傾き（1m 進むあたりの上り）。色を塗るときに細部の揺れに左右されないよう、こちらを使う。 */
  slope: Float32Array;
  /** 曲がり（正 = 尾根・盛り上がり、負 = 谷筋・窪み）。m / 格子² を 1 格子あたりに直したもの。 */
  curvature: Float32Array;
  /** 水の集まり 0..1。侵食で求めた集水面積の平方根を、島の中で正規化したもの。谷筋ほど大きい。 */
  drainage: Float32Array;
}

export function buildLandscape(p: IslandParams, n: number): Landscape {
  const grid = makeGrid(n);
  const { cell } = grid;
  const [a, b, c, d] = hashSeed(p.seed);
  const nWarp = new Noise2D(a);
  const nCoast = new Noise2D(b);
  const nRidge = new Noise2D(c);
  const nPeaks = new Noise2D(d);

  const size = p.size / 100;
  const shape = p.shape / 100;
  const mountains = p.mountains / 100;
  const erosion = p.erosion / 100;

  const radius = mix(0.42, 0.86, size);
  const warm = p.warmth / 100;
  const coastNoise = mix(0.18, 0.75, shape);
  /** 山の高さ（m）。二乗で持ち上げ、つまみの上半分で急に険しくなる。 */
  const peak = mix(120, 900, mountains * mountains);
  /** 峰の散らばり。まとまった島は 1 つの山、多島海ほど峰が散らばる。 */
  const scatter = mix(0.25, 0.85, shape);

  const N = n * n;
  const h = new Float64Array(N);
  const uplift = new Float64Array(N);
  const base = new Uint8Array(N);

  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      const u = (i / (n - 1)) * 2 - 1;
      const v = (j / (n - 1)) * 2 - 1;
      const wu = u + fbm(nWarp, u, v, 3, 1.2) * 0.22;
      const wv = v + fbm(nWarp, u + 17.3, v - 9.1, 3, 1.2) * 0.22;
      const r = Math.sqrt(wu * wu + wv * wv);
      let land = 1 - r / radius + fbm(nCoast, u, v, 5, 2.0) * coastNoise;
      land -= smoothstep(0.86, 1.0, Math.sqrt(u * u + v * v)) * 3;

      if (land <= 0 || i === 0 || j === 0 || i === n - 1 || j === n - 1) {
        base[k] = 1;
        const out = -land;
        const shelf = -SHELF_DEPTH * smoothstep(0, SHELF_END * 0.6, out);
        const drop = -SEA_DEPTH * smoothstep(SHELF_END, SHELF_END + 0.3, out);
        // サンゴ礁: 棚の縁の少し内側に高まり。暖かいほど高く、海面すれすれまで来る。
        const reef = smoothstep(0.45, 0.85, warm) * (SHELF_DEPTH - REEF_TOP) *
          smoothstep(SHELF_END * 0.55, SHELF_END * 0.85, out) *
          (1 - smoothstep(SHELF_END * 0.85, SHELF_END * 1.05, out)) *
          (0.55 + 0.45 * (fbm(nCoast, u * 3.1, v * 3.1, 2, 2.0) * 0.5 + 0.5));
        h[k] = Math.min(shelf, 0) + drop + reef;
        continue;
      }
      // 山の形: 輪郭から内側へ上がる丸い山（dome）に、尾根の筋（ridge）と峰の散らばり（peaks）。
      const dome = smoothstep(0, 0.9, land);
      const ridge = ridged(nRidge, u, v, 4, 1.7);
      const peaks = smoothstep(0.35, 0.9, fbm(nPeaks, u, v, 3, 1.6) * 0.5 + 0.5);
      const profile = dome * mix(1, 0.35 + ridge * 0.9, scatter) * mix(1, 0.4 + peaks, scatter * 0.6);
      uplift[k] = profile;
      // 始めは設計図どおりの山。侵食がここから谷を刻む。
      h[k] = 2 + peak * profile;
    }
  }

  // 侵食の強さ（谷の刻みのつまみ）。隆起は山の高さに比例させ、侵食で山が消え切らないように保つ。
  // 0.0022 以下では谷が浅く、谷の刻みのつまみを動かしても見分けがつかなかった。
  const K = mix(0.004, 0.03, erosion);
  const U = peak * 0.0035;
  const area = erode(h, uplift, base, n, cell, K, U);

  const height = new Float32Array(N);
  for (let k = 0; k < N; k++) height[k] = h[k];
  return { n, height, ...surfaceFields(height, area, base, n, cell) };
}

/**
 * ゴルフコースの世界の大きな形。**コースが先にあり、地形はその周りに作る。**
 *
 * - コースの周り（打つ線から 90m まで）は谷底: ゆるくうねる低い土地で、侵食では動かさない
 *   （流れの行き着く先にする。山から下る谷はコースの縁で終わる）
 * - その外は山: 打つ線から離れるほど高くなる輪。尾根と峰のノイズで形を揺らし、侵食で谷を刻む
 * - さらに外は海: 世界の端を山の向こうの海岸にする（空から見ると、山に囲まれた谷のある島）
 *
 * 川と湖は作らない（谷底に流れが集まっても、コースを水浸しにしない。水はコースの池だけ）。
 */
export function buildCourseLandscape(p: IslandParams, n: number, design: CourseDesign): Landscape {
  const grid = makeGrid(n);
  const { cell } = grid;
  const [a, b, c, d] = hashSeed(p.seed);
  const nCoast = new Noise2D(b);
  const nRidge = new Noise2D(c);
  const nPeaks = new Noise2D(d);
  const nFloor = new Noise2D((a ^ 0x5bd1e995) >>> 0);
  const mountains = p.mountains / 100;
  const peak = mix(220, 650, mountains * mountains);

  // コースの中心と、島の輪郭の半径（m）。
  let cx = 0;
  let cz = 0;
  let count = 0;
  for (const h of design.holes) {
    for (const q of h.line) {
      cx += q.x;
      cz += q.z;
      count++;
    }
  }
  cx /= count || 1;
  cz /= count || 1;
  const radius = 1780;

  const N = n * n;
  const h = new Float64Array(N);
  const uplift = new Float64Array(N);
  const base = new Uint8Array(N);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      const u = (i / (n - 1)) * 2 - 1;
      const v = (j / (n - 1)) * 2 - 1;
      const x = u * (ISLAND_SIZE / 2);
      const z = v * (ISLAND_SIZE / 2);
      // 輪郭は円にしない（座標を揺らしてから距離を測り、さらに海岸を波打たせる）。
      const wx = x + fbm(nCoast, u + 7.1, v - 3.3, 3, 1.1) * 520;
      const wz = z + fbm(nCoast, u - 4.7, v + 9.2, 3, 1.1) * 520;
      let land = 1 - Math.hypot(wx - cx, wz - cz) / radius + fbm(nCoast, u, v, 5, 2.0) * 0.22;
      land -= smoothstep(0.86, 1.0, Math.sqrt(u * u + v * v)) * 3;
      if (land <= 0 || i === 0 || j === 0 || i === n - 1 || j === n - 1) {
        base[k] = 1;
        const out = -land;
        h[k] = Math.min(-SHELF_DEPTH * smoothstep(0, SHELF_END * 0.6, out), 0) -
          SEA_DEPTH * smoothstep(SHELF_END, SHELF_END + 0.3, out);
        continue;
      }
      // 谷底: 数百 m の波長で ±9m、百数十 m で ±2.5m うねる。海岸へ向かって浜の高さへ下りる。
      let floor = 16 + fbm(nFloor, u, v, 3, 1.4) * 9 + fbm(nFloor, u * 4 + 5.3, v * 4 - 2.9, 2, 1.0) * 2.5;
      floor = mix(2, floor, smoothstep(0, 0.15, land));
      let dc = Infinity;
      for (const hole of design.holes) dc = Math.min(dc, lineDistance(hole.line, x, z).d);
      if (dc < 90) {
        base[k] = 1;
        h[k] = floor;
        continue;
      }
      // 山の輪は、コースからの距離を揺らして、ゆっくり立ち上げる（そろった放射状の谷筋にしない）。
      const dw = dc + fbm(nRidge, u * 3.1 + 11.7, v * 3.1 - 5.3, 3, 1.0) * 180;
      const ring = smoothstep(150, 950, dw);
      const ridge = ridged(nRidge, u, v, 4, 1.7);
      const peaks = smoothstep(0.35, 0.9, fbm(nPeaks, u, v, 3, 1.6) * 0.5 + 0.5);
      const profile = ring * (0.45 + ridge * 0.75) * (0.6 + 0.6 * peaks) * smoothstep(0, 0.3, land);
      uplift[k] = profile;
      h[k] = floor + peak * profile;
    }
  }
  const K = mix(0.004, 0.03, p.erosion / 100);
  const U = peak * 0.0035;
  const area = erode(h, uplift, base, n, cell, K, U);
  const height = new Float32Array(N);
  for (let k = 0; k < N; k++) height[k] = h[k];
  return { n, height, ...surfaceFields(height, area, base, n, cell) };
}

/**
 * 色を塗るための地形の性質。大きな形（16m）から一度だけ求める。
 * 細部（2m）の傾きで色を切り替えると、雪と岩が四角いドットの模様になった。
 */
function surfaceFields(
  h: Float32Array,
  area: Float64Array,
  base: Uint8Array,
  n: number,
  cell: number,
): { slope: Float32Array; curvature: Float32Array; drainage: Float32Array } {
  const N = n * n;
  const slope = new Float32Array(N);
  const curvature = new Float32Array(N);
  const drainage = new Float32Array(N);
  let maxRoot = 1;
  for (let k = 0; k < N; k++) if (!base[k]) maxRoot = Math.max(maxRoot, Math.sqrt(area[k]));
  // 集水面積の平方根を、島で一番大きい川で 1 になるように。細い沢でも色に効くよう、さらに平方根を取る。
  for (let k = 0; k < N; k++) drainage[k] = base[k] ? 0 : Math.sqrt(Math.sqrt(area[k]) / maxRoot);
  for (let j = 1; j < n - 1; j++) {
    for (let i = 1; i < n - 1; i++) {
      const k = j * n + i;
      const dx = (h[k + 1] - h[k - 1]) / (2 * cell);
      const dz = (h[k + n] - h[k - n]) / (2 * cell);
      slope[k] = Math.sqrt(dx * dx + dz * dz);
      // 周りより高ければ正（尾根）、低ければ負（谷筋）。
      curvature[k] = (4 * h[k] - h[k + 1] - h[k - 1] - h[k + n] - h[k - n]) / (4 * cell);
    }
  }
  return { slope, curvature, drainage };
}

/** FastScape 型の侵食と斜面の拡散。h を書き換え、最後の集水面積（m²）を返す。 */
function erode(
  h: Float64Array,
  uplift: Float64Array,
  base: Uint8Array,
  n: number,
  cell: number,
  K: number,
  U: number,
): Float64Array {
  const N = n * n;
  const rec = new Int32Array(N);
  const dist = new Float64Array(N);
  const area = new Float64Array(N);
  const stack = new Int32Array(N);
  const donorCount = new Int32Array(N);
  const donors = new Int32Array(N * 8);
  const next = new Float64Array(N);
  const todo = new Int32Array(N);
  // 格子の細かさが変わっても谷の深さが揃うよう、面積は m² で数え、K は 1m あたりにする。
  const cellArea = cell * cell;

  const nOff = Int32Array.from(NEIGHBORS8, ([di, dj]) => dj * n + di);
  const nDist = Float64Array.from(NEIGHBORS8, ([, , dd]) => dd);
  for (let it = 0; it < ITERATIONS; it++) {
    // 1. 流れていく先（一番下る隣）。同じ下り具合なら先に見た方（NEIGHBORS8 の順）。
    // **隣は番号の差（nOff）で引く。** `for (const [di, dj, dd] of NEIGHBORS8)` と書くと、
    // 66,000 マス × 8 × 140 回の分解だけで侵食全体の 8 割（1.3 秒）を使っていた。
    // 計算の順番も値も同じなので、島の形は変わらない。
    for (let k = 0; k < N; k++) {
      rec[k] = k;
      dist[k] = 1;
      donorCount[k] = 0;
      if (base[k]) continue;
      const hk = h[k];
      let best = 0;
      for (let q = 0; q < 8; q++) {
        const m = k + nOff[q];
        const s = (hk - h[m]) / nDist[q];
        if (s > best) {
          best = s;
          rec[k] = m;
          dist[k] = nDist[q] * cell;
        }
      }
    }
    for (let k = 0; k < N; k++) {
      const r = rec[k];
      if (r !== k) donors[r * 8 + donorCount[r]++] = k;
    }

    // 2. 下流から上流への並び（海と、窪みの底から）。
    let top = 0;
    for (let s = 0; s < N; s++) {
      if (rec[s] !== s) continue;
      let sp = 0;
      todo[sp++] = s;
      while (sp > 0) {
        const c = todo[--sp];
        stack[top++] = c;
        for (let q = 0; q < donorCount[c]; q++) todo[sp++] = donors[c * 8 + q];
      }
    }

    // 3. 集水面積（上流から足す）。
    for (let k = 0; k < N; k++) area[k] = cellArea;
    for (let s = N - 1; s >= 0; s--) {
      const k = stack[s];
      if (rec[k] !== k) area[rec[k]] += area[k];
    }

    // 4. 隆起と、陰的な川の侵食（下流から）。窪みの底は隆起だけで埋まっていく。
    for (let s = 0; s < N; s++) {
      const k = stack[s];
      if (base[k]) continue;
      h[k] += U * uplift[k];
      const r = rec[k];
      if (r === k) continue;
      const f = (K * Math.sqrt(area[k])) / dist[k];
      h[k] = (h[k] + f * h[r]) / (1 + f);
    }

    // 5. 斜面の拡散（尾根を丸める）。海は動かさない。
    for (let j = 1; j < n - 1; j++) {
      for (let i = 1; i < n - 1; i++) {
        const k = j * n + i;
        next[k] = base[k]
          ? h[k]
          : h[k] + DIFFUSION * (h[k + 1] + h[k - 1] + h[k + n] + h[k - n] - 4 * h[k]);
      }
    }
    for (let j = 1; j < n - 1; j++) {
      for (let i = 1; i < n - 1; i++) h[j * n + i] = next[j * n + i];
    }
  }
  return area;
}
