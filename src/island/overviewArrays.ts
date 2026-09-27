import { SURFACE_STRIDE } from '../world/islandSurface';
import { type Terrain, splitsAlongMainDiagonal } from '../world/terrain';
import type { Island } from './generate';
import { gridToWorld } from './ground';

/**
 * 見渡す島の 1 枚（render/overviewMesh.ts）の中身を、生の配列として作る。
 * **Worker で作る**（island/worker.ts）。最大 59 万頂点の色付けは 1 秒近くかかり、画面側で作ると
 * その間 画面が止まっていた。three.js に頼らない形にしてあるのは Worker で動かすため。
 * スマホは元の格子を間引いて作り、物理・コースの精度はそのままに遠景の頂点と GPU メモリだけを減らす。
 */

export interface OverviewArrays {
  position: Float32Array;
  normal: Float32Array;
  /** 地面の層（world/islandSurface.ts）。color = 土台、rock = 岩の色、surf = 岩の量・雪の量・凹みの明暗。 */
  color: Float32Array;
  rock: Float32Array;
  surf: Float32Array;
  index: Uint32Array;
}

export function buildOverviewArrays(island: Island, terrain: Terrain, sampleStep = 1): OverviewArrays {
  const { n, cell, height, temperature, moisture } = island;
  const step = Math.max(1, Math.floor(sampleStep));
  const samples: number[] = [];
  for (let i = 0; i < n - 1; i += step) samples.push(i);
  samples.push(n - 1);
  const sn = samples.length;
  const position = new Float32Array(sn * sn * 3);
  const normal = new Float32Array(sn * sn * 3);
  const color = new Float32Array(sn * sn * 3);
  const rock = new Float32Array(sn * sn * 3);
  const surf = new Float32Array(sn * sn * 3);
  const layers = new Float32Array(SURFACE_STRIDE);
  const at = (i: number, j: number) =>
    height[Math.max(0, Math.min(n - 1, j)) * n + Math.max(0, Math.min(n - 1, i))];
  for (let sj = 0; sj < sn; sj++) {
    const j = samples[sj];
    const z = gridToWorld(j, n);
    for (let si = 0; si < sn; si++) {
      const i = samples[si];
      const source = j * n + i;
      const k = sj * sn + si;
      const x = gridToWorld(i, n);
      const h = height[source];
      position[k * 3] = x;
      position[k * 3 + 1] = h;
      position[k * 3 + 2] = z;
      // 法線と傾きは chunk.ts と同じ中心差分で取る。
      const dx = (at(i + 1, j) - at(i - 1, j)) / (2 * cell);
      const dz = (at(i, j + 1) - at(i, j - 1)) / (2 * cell);
      const len = Math.sqrt(dx * dx + 1 + dz * dz);
      normal[k * 3] = -dx / len;
      normal[k * 3 + 1] = 1 / len;
      normal[k * 3 + 2] = -dz / len;
      const slope = Math.min(1, Math.sqrt(dx * dx + dz * dz));
      terrain.surface(
        x,
        z,
        h,
        slope,
        temperature[source],
        moisture[source],
        terrain.specialAt(x, z),
        terrain.patchAt(x, z),
        layers,
        0,
      );
      for (let c = 0; c < 3; c++) {
        color[k * 3 + c] = layers[c];
        rock[k * 3 + c] = layers[3 + c];
        surf[k * 3 + c] = layers[6 + c];
      }
    }
  }

  const index = new Uint32Array((sn - 1) * (sn - 1) * 6);
  let o = 0;
  for (let j = 0; j < sn - 1; j++) {
    for (let i = 0; i < sn - 1; i++) {
      const a = j * sn + i;
      const b = a + 1;
      const d = a + sn;
      const e = d + 1;
      // チャンクと同じ割り方（高低差の小さい対角線）。
      const h00 = height[samples[j] * n + samples[i]];
      const h10 = height[samples[j] * n + samples[i + 1]];
      const h01 = height[samples[j + 1] * n + samples[i]];
      const h11 = height[samples[j + 1] * n + samples[i + 1]];
      if (splitsAlongMainDiagonal(h00, h10, h01, h11)) {
        index[o++] = a;
        index[o++] = d;
        index[o++] = e;
        index[o++] = a;
        index[o++] = e;
        index[o++] = b;
      } else {
        index[o++] = a;
        index[o++] = d;
        index[o++] = b;
        index[o++] = d;
        index[o++] = e;
        index[o++] = b;
      }
    }
  }
  return { position, normal, color, rock, surf, index };
}

/**
 * 湖と川の水面。水のある格子に角が 1 つでも触れる四角形に張る。
 * 水の無い角は、同じ四角形の水のある角の高さの平均に置く。水面は岸の下まで伸びて
 * 地形に隠れ、水際の線は地形との交わりで決まる。川は下流へ下る斜めの水面になる。
 */
export function buildOverviewWaterArray(island: Island): Float32Array | null {
  const { n, waterLevel } = island;
  const pos: number[] = [];
  const lv = new Float32Array(4);
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const ks = [j * n + i, j * n + i + 1, (j + 1) * n + i, (j + 1) * n + i + 1];
      let sum = 0;
      let wet = 0;
      for (let q = 0; q < 4; q++) {
        const v = waterLevel[ks[q]];
        if (Number.isFinite(v)) {
          sum += v;
          wet++;
        }
      }
      if (wet === 0) continue;
      const fill = sum / wet;
      for (let q = 0; q < 4; q++) {
        const v = waterLevel[ks[q]];
        lv[q] = Number.isFinite(v) ? v : fill;
      }
      const x0 = gridToWorld(i, n);
      const x1 = gridToWorld(i + 1, n);
      const z0 = gridToWorld(j, n);
      const z1 = gridToWorld(j + 1, n);
      pos.push(x0, lv[0], z0, x0, lv[2], z1, x1, lv[3], z1);
      pos.push(x0, lv[0], z0, x1, lv[3], z1, x1, lv[1], z0);
    }
  }
  return pos.length === 0 ? null : new Float32Array(pos);
}
