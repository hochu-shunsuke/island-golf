import { hash2 } from '../core/rng';
import { clamp } from '../world/noise';
import { writeInstance, variantOf } from '../world/scatter';
import type { SpecialHit } from '../world/special';
import type { Terrain } from '../world/terrain';
import { VEGETATION_SPECS, type PlaceContext } from '../world/vegetationSpecs';
import { KIND_BUSH, KIND_ROCK } from '../world/vegetationKinds';
import type { Island } from './generate';
import { ISLAND_SIZE } from './grid';

/**
 * 島全体の木。見渡す島と、飛んでいる間の遠景に軽い形で描く（render/farForest.ts）。
 *
 * **近くのチャンクの木（world/scatter.ts）と同じ候補・同じ規則・同じ乱数で置く。**
 * 近づいて本物の木に切り替わっても、位置も形も飛ばない。違うのは入力の引き方だけで、
 * 標高・湿り気・傾きは島全体の細かい格子（約 5m）から補間する。1 本ずつ 2m の地形を
 * 引くと、島全体で数十万の候補に数秒かかるため。
 *
 * 低木と岩は遠くからは見えないので置かない。
 */

export interface ForestBatch {
  kind: number;
  /** 4×4 行列を並べた列（世界座標）。 */
  matrices: Float32Array;
  colors: Float32Array;
}

const NO_TALUS = 0;

export function plantForest(terrain: Terrain, island: Island): ForestBatch[] {
  const { n, cell, height, moisture } = island;
  const half = ISLAND_SIZE / 2;
  const toGrid = (v: number) => (v + half) / cell;

  const bilinear = (field: Float32Array, x: number, z: number): number => {
    const u = toGrid(x);
    const v = toGrid(z);
    const i = Math.min(n - 2, Math.max(0, u | 0));
    const j = Math.min(n - 2, Math.max(0, v | 0));
    const fu = u - i;
    const fv = v - j;
    const a = field[j * n + i];
    const b = field[j * n + i + 1];
    const c = field[(j + 1) * n + i];
    const d = field[(j + 1) * n + i + 1];
    return (a + (b - a) * fu) * (1 - fv) + (c + (d - c) * fu) * fv;
  };
  /** scatter.ts の slopeAndTalus と同じ尺度（1.6 で 1）。 */
  const slopeAt = (x: number, z: number): number => {
    const dx = (bilinear(height, x + cell, z) - bilinear(height, x - cell, z)) / (2 * cell);
    const dz = (bilinear(height, x, z + cell) - bilinear(height, x, z - cell)) / (2 * cell);
    return clamp(Math.sqrt(dx * dx + dz * dz) / 1.6, 0, 1);
  };

  const ctx = {
    h: 0,
    temp: 0,
    moisture: 0,
    special: null as unknown as SpecialHit,
    grove: 0,
    r: 0,
    talus: NO_TALUS,
    _x: 0,
    _z: 0,
    get slope(): number {
      return slopeAt(this._x, this._z);
    },
  };

  const batches: ForestBatch[] = [];
  for (const spec of VEGETATION_SPECS) {
    if (spec.maxLod < 1) continue;
    if (spec.kinds.includes(KIND_ROCK) || spec.kinds.includes(KIND_BUSH)) continue;

    const g0 = Math.floor(-half / spec.spacing);
    const g1 = Math.floor(half / spec.spacing);
    const nv = spec.kinds.length;
    const cap = (g1 - g0 + 1) * (g1 - g0 + 1);
    // 先に数えてから確保すると 2 回回ることになるので、多めに取って最後に切り詰める。
    const mats: Float32Array[] = [];
    const cols: Float32Array[] = [];
    const counts: number[] = [];
    for (let v = 0; v < nv; v++) {
      mats.push(new Float32Array(Math.min(cap, 200_000) * 16));
      cols.push(new Float32Array(Math.min(cap, 200_000) * 3));
      counts.push(0);
    }

    for (let gx = g0; gx <= g1; gx++) {
      for (let gz = g0; gz <= g1; gz++) {
        const r = hash2(gx, gz, spec.salt);
        const x = (gx + hash2(gx, gz, spec.salt + 1)) * spec.spacing;
        const z = (gz + hash2(gx, gz, spec.salt + 2)) * spec.spacing;
        if (x < -half + cell || x > half - cell || z < -half + cell || z > half - cell) continue;

        let special: SpecialHit | null = null;
        if (spec.specialIndex !== undefined) {
          special = terrain.specialAt(x, z);
          if (special.index !== spec.specialIndex) continue;
        }
        const h = bilinear(height, x, z);
        if (h < 0.8) continue;
        if (h < terrain.waterLevelAt(x, z) + 0.6) continue;
        // ゴルフで刈り込んだ所（グリーン・ティー・フェアウェイ）には生やさない。
        if (terrain.mownAt(x, z) > 0.05) continue;

        ctx.h = h;
        ctx.r = r;
        if (spec.specialIndex === undefined) {
          ctx.moisture = bilinear(moisture, x, z);
          ctx.temp = terrain.temperatureAt(x, z, h);
        } else {
          ctx.moisture = 0;
          ctx.temp = 0;
        }
        ctx.special = special ?? terrain.specialAt(x, z);
        ctx.grove = terrain.groveAt(x, z);
        ctx._x = x;
        ctx._z = z;
        const scale = spec.place(ctx as PlaceContext);
        if (scale <= 0) continue;

        const v = variantOf(spec, gx, gz);
        if (counts[v] * 16 >= mats[v].length) continue;
        writeInstance(spec, gx, gz, scale, x, h - 0.25, z, mats[v], counts[v], cols[v]);
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
