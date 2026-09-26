/// <reference lib="webworker" />
import { type IslandMap, renderIslandMap } from '../view/mapView';
import { IslandWater } from '../world/islandWater';
import { Terrain } from '../world/terrain';
import { type ForestBatch, plantForest } from './forest';
import { type Island, generateIsland } from './generate';
import { FULL_RES, ISLAND_SIZE } from './grid';
import { type Hole, holesOf } from '../golf/course';
import { routeCourse, settleCourse } from '../golf/design';
import { CourseField, type FieldArrays, buildCourseField } from '../golf/field';
import { gridToWorld } from './ground';
import { type IslandLighting, bakeLighting } from './lighting';
import { type OverviewArrays, buildOverviewArrays, buildOverviewWaterArray } from './overviewArrays';
import type { IslandParams } from './params';

/**
 * 島の計算は数百 ms かかるので Worker で行う。つまみを動かしても画面が固まらない。
 *
 * 見せるのに要る物から順に送る。
 *   1. 島（標高・水・気候）と、見渡す島の 1 枚・小さな地図の中身 → 画面に島が出る
 *   2. 島全体の木（本番の格子だけ）
 *   3. 焼き込んだ光（太陽の影と空の見え方）
 * 以前は木を植え終えてから島を送り、見渡す島の 1 枚は画面側で組み立てていた（約 1 秒、
 * その間 画面が止まる）。木と光は島が見えた後から届けば足りる。
 */

export interface GenerateRequest {
  id: number;
  params: IslandParams;
  /** 見渡す島の格子と、侵食の格子（1 辺の点数）。 */
  n: number;
  erosionN: number;
  /** 太陽へ向かう単位ベクトル（光を焼き込むのに使う）。 */
  sun: [number, number, number];
  /** 今日（1970 年からの日数）。ピン位置を日ごとに替える。 */
  day: number;
}

export interface GenerateResult {
  type: 'island';
  id: number;
  island: Island;
  /** この島を作ったときのつまみ。計算中につまみが動いても、島と地形の式を食い違わせない。 */
  params: IslandParams;
  /** 見渡す島の 1 枚（render/overviewMesh.ts がそのまま貼る）と、その水面。 */
  overview: OverviewArrays;
  overviewWater: Float32Array | null;
  map: IslandMap;
  /** この島のコース（ホールと造成の格子）。下見の島では入れない。 */
  course: { holes: Hole[]; field: FieldArrays | null };
  /** 島が見えるまでにかかった時間（ms）。 */
  ms: number;
}

/** 島全体の木。島を送った後に植えて、追いかけて送る（本番の格子だけ）。 */
export interface ForestResult {
  type: 'forest';
  id: number;
  forest: ForestBatch[];
}

/**
 * 島の光（太陽の影と空の見え方）。木の後に計算して、追いかけて送る。
 * 光の計算（本番の格子で約 0.3s）を待たずに島を見せるため。
 */
export interface LightResult {
  type: 'light';
  id: number;
  lighting: IslandLighting;
  ms: number;
}

export type WorkerResult = GenerateResult | ForestResult | LightResult;

const post = (msg: WorkerResult, transfer: Transferable[]) =>
  (self as unknown as Worker).postMessage(msg, transfer);

self.onmessage = (ev: MessageEvent<GenerateRequest>) => {
  const { id, params, n, erosionN, sun, day } = ev.data;
  const started = performance.now();
  // コースを先に並べ（route）、その周りに世界を作り（谷底と山）、地面に合わせて高さを入れ（settle）、
  // 造成する（field）。
  const route = routeCourse(params.seed);
  const island = generateIsland(params, n, erosionN, route);
  const design = settleCourse(route, (x, z) => sampleGrid(island, x, z));
  const field = buildCourseField(island, design, params.seed);
  const terrain = new Terrain(
    params,
    island.landscape,
    new IslandWater(island.water),
    field ? new CourseField(field) : null,
  );
  if (field) shapeGrid(island, terrain, field);
  const course = { holes: holesOf(design, day), field };
  const overview = buildOverviewArrays(island, terrain);
  const overviewWater = buildOverviewWaterArray(island);
  const map = renderIslandMap(island, terrain);

  // 木と光は送った後にも島の細かい格子を読むので、手放す前に写しておく。
  // 大きな形と水（landscape・water）は地形（terrain）が読み続けるので、転送せず写しで送る。
  const height = island.height.slice();
  const moisture = island.moisture.slice();
  post({ type: 'island', id, island, params, overview, overviewWater, map, course, ms: performance.now() - started }, [
    island.height.buffer,
    island.waterLevel.buffer,
    island.waterKind.buffer,
    island.temperature.buffer,
    island.moisture.buffer,
    overview.position.buffer,
    overview.normal.buffer,
    overview.color.buffer,
    overview.rock.buffer,
    overview.surf.buffer,
    overview.index.buffer,
    ...(overviewWater ? [overviewWater.buffer] : []),
    map.pixels.buffer,
  ]);

  // 木は指を離して本番の格子で作ったときだけ。下見の間は地形の形だけを見せる。
  if (n === FULL_RES) {
    const forest = plantForest(terrain, { ...island, height, moisture });
    post({ type: 'forest', id, forest }, forest.flatMap((b) => [b.matrices.buffer, b.colors.buffer]));
  }

  const lit = performance.now();
  const lighting = bakeLighting(height, n, island.cell, sun);
  post({ type: 'light', id, lighting, ms: performance.now() - lit }, [lighting.data.buffer]);
};

/** 島の格子の高さ（双一次）。 */
function sampleGrid(island: Island, x: number, z: number): number {
  const { n, height } = island;
  const fx = Math.max(0, Math.min(n - 1.001, (x / ISLAND_SIZE + 0.5) * (n - 1)));
  const fz = Math.max(0, Math.min(n - 1.001, (z / ISLAND_SIZE + 0.5) * (n - 1)));
  const i = Math.floor(fx);
  const j = Math.floor(fz);
  const u = fx - i;
  const v = fz - j;
  const k = j * n + i;
  return (height[k] * (1 - u) + height[k + 1] * u) * (1 - v) + (height[k + n] * (1 - u) + height[k + n + 1] * u) * v;
}

/**
 * 島の細かい格子を、造成したコースに合わせる（見渡す島・地図・光・木が同じ地面を見るように）。
 * 島の格子はコースを設計する前に作るので、造成の範囲だけ地形（terrain.heightAt）から引き直し、
 * 池を湖として書き足す。
 */
function shapeGrid(island: Island, terrain: Terrain, field: FieldArrays): void {
  const { n, height, waterLevel, waterKind } = island;
  const x1 = field.x0 + (field.nx - 1) * field.step;
  const z1 = field.z0 + (field.nz - 1) * field.step;
  for (let j = 0; j < n; j++) {
    const z = gridToWorld(j, n);
    if (z < field.z0 || z > z1) continue;
    for (let i = 0; i < n; i++) {
      const x = gridToWorld(i, n);
      if (x < field.x0 || x > x1) continue;
      const k = j * n + i;
      height[k] = terrain.heightAt(x, z);
      const pond = terrain.waterLevelAt(x, z);
      if (Number.isFinite(pond) && !Number.isFinite(waterLevel[k])) {
        waterLevel[k] = pond;
        waterKind[k] = 2;
      }
    }
  }
}
