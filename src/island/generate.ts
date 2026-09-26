import type { LandscapeArrays } from '../world/islandShape';
import { type IslandWaterArrays, IslandWater } from '../world/islandWater';
import { Terrain } from '../world/terrain';
import { gridToWorld } from './ground';
import { makeGrid } from './grid';
import { WATER_LAKE, WATER_RIVER, routeWater } from './hydrology';
import { buildCourseLandscape, buildLandscape } from './landscape';
import type { CourseDesign } from '../golf/design';
import type { IslandParams } from './params';

/**
 * 島 1 つ分の計算。
 *   1. 大きな形: 隆起させた山を川が削る（landscape.ts、侵食の格子）
 *   2. 水: 同じ格子で水を満たして湖を決め、流れを集めて川にする（hydrology.ts）
 *   3. 見渡す島: 細かい格子で、細部と水を重ねた標高・気候を引く（見渡す島と遠景の 1 枚に使う）
 *
 * 近くのチャンクは 1 と 2 の結果（landscape・water）を受け取り、1 点ずつ同じ式で引く。
 */
export interface Island {
  /** 見渡す島の格子（1 辺の点数）と間隔（m）。 */
  n: number;
  cell: number;
  /** 地面の高さ（m）。海面が 0。 */
  height: Float32Array;
  /** 水面の高さ（m）。水が無ければ NaN。 */
  waterLevel: Float32Array;
  /** 1 = 川、2 = 湖。 */
  waterKind: Uint8Array;
  temperature: Float32Array;
  moisture: Float32Array;
  /** 大きな形と水（侵食の格子）。近くのチャンクへそのまま渡す。 */
  landscape: LandscapeArrays;
  water: IslandWaterArrays;
  /** 工程ごとの時間（ms）。 */
  timings: Record<string, number>;
}

/** 湿り気は雨陰の計算で重い。この間隔ごとに引いて補間する。 */
const MOISTURE_EVERY = 4;

/**
 * course を渡すと、ゴルフコースの世界を作る（コースの周りを谷底にし、外を山で囲む。川と湖は作らない）。
 */
export function generateIsland(p: IslandParams, n: number, erosionN: number, course?: CourseDesign): Island {
  const timings: Record<string, number> = {};
  let t = performance.now();
  const lap = (name: string) => {
    const now = performance.now();
    timings[name] = now - t;
    t = now;
  };

  // 1. 大きな形。
  const landscape = course ? buildCourseLandscape(p, erosionN, course) : buildLandscape(p, erosionN);
  lap('隆起と侵食');

  // 2. 水。雨は湿った所ほど多く降る（川の水量の重み）。
  const eGrid = makeGrid(erosionN);
  const dry = new Terrain(p, landscape);
  const rain = new Float32Array(erosionN * erosionN);
  for (let j = 0; j < erosionN; j++) {
    const z = gridToWorld(j, erosionN);
    for (let i = 0; i < erosionN; i++) rain[j * erosionN + i] = 0.3 + dry.moistureAt(gridToWorld(i, erosionN), z);
  }
  const carved = landscape.height.slice();
  const water = course
    ? { level: new Float32Array(carved.length).fill(Number.NaN), kind: new Uint8Array(carved.length) }
    : routeWater(carved, rain, p, eGrid);
  const carve = new Float32Array(carved.length);
  for (let k = 0; k < carved.length; k++) carve[k] = carved[k] - landscape.height[k];
  const waterArrays: IslandWaterArrays = { n: erosionN, carve, level: water.level, kind: water.kind };
  lap('水');

  // 3. 見渡す島。
  const grid = makeGrid(n);
  const islandWater = new IslandWater(waterArrays);
  const terrain = new Terrain(p, landscape, islandWater);
  const height = new Float32Array(n * n);
  const waterLevel = new Float32Array(n * n).fill(Number.NaN);
  const waterKind = new Uint8Array(n * n);
  for (let j = 0; j < n; j++) {
    const z = gridToWorld(j, n);
    for (let i = 0; i < n; i++) {
      const x = gridToWorld(i, n);
      const k = j * n + i;
      height[k] = terrain.heightAt(x, z);
      const level = islandWater.levelAt(x, z);
      if (level > -Infinity) {
        waterLevel[k] = level;
        waterKind[k] = islandWater.kindAt(x, z) === WATER_LAKE ? WATER_LAKE : WATER_RIVER;
      }
    }
  }
  lap('標高');

  const m = Math.ceil((n - 1) / MOISTURE_EVERY) + 1;
  const coarse = new Float32Array(m * m);
  for (let j = 0; j < m; j++) {
    for (let i = 0; i < m; i++) {
      const gi = Math.min(n - 1, i * MOISTURE_EVERY);
      const gj = Math.min(n - 1, j * MOISTURE_EVERY);
      coarse[j * m + i] = terrain.moistureAt(gridToWorld(gi, n), gridToWorld(gj, n));
    }
  }
  const moisture = new Float32Array(n * n);
  const temperature = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    const z = gridToWorld(j, n);
    for (let i = 0; i < n; i++) {
      const u = Math.min(m - 1.0001, i / MOISTURE_EVERY);
      const v = Math.min(m - 1.0001, j / MOISTURE_EVERY);
      const ci = u | 0;
      const cj = v | 0;
      const fu = u - ci;
      const fv = v - cj;
      const a = coarse[cj * m + ci];
      const b = coarse[cj * m + ci + 1];
      const c = coarse[(cj + 1) * m + ci];
      const d = coarse[(cj + 1) * m + ci + 1];
      const k = j * n + i;
      moisture[k] = (a + (b - a) * fu) * (1 - fv) + (c + (d - c) * fu) * fv;
      temperature[k] = terrain.temperatureAt(gridToWorld(i, n), z, height[k]);
    }
  }
  lap('気候');

  return {
    n,
    cell: grid.cell,
    height,
    waterLevel,
    waterKind,
    temperature,
    moisture,
    landscape,
    water: waterArrays,
    timings,
  };
}
