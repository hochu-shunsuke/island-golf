/// <reference lib="webworker" />
import { type IslandMap, renderIslandMap } from '../view/mapView';
import { IslandWater } from '../world/islandWater';
import { Terrain } from '../world/terrain';
import { type ForestBatch, plantForest } from './forest';
import { type Island, generateIsland } from './generate';
import { FULL_RES } from './grid';
import { type Hole, TEE_BLEND, TEE_RADIUS, flagArea, pickCourse } from '../golf/course';
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
  /** この島のコース（おすすめの旗）。下見の島では空。 */
  course: Hole[];
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
  const { id, params, n, erosionN, sun } = ev.data;
  const started = performance.now();
  const island = generateIsland(params, n, erosionN);
  // コースは本番の格子の島だけ（下見の島では入れないので、作る手間も省く）。
  const course = n === FULL_RES ? pickCourse(island, params.seed) : [];
  const terrain = new Terrain(params, island.landscape, new IslandWater(island.water), course);
  for (const hole of course) flattenGrid(island, terrain, hole);
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

/**
 * 島の細かい格子の高さを、均したグリーンとティーに合わせる（見渡す島・光・木が同じ地面を見るように）。
 * 島の格子はホールを決める前に作るので、ホールの周りだけ地形（terrain.heightAt）から引き直す。
 */
function flattenGrid(island: Island, terrain: Terrain, hole: Hole): void {
  const { n, height } = island;
  const patch = (cx: number, cz: number, radius: number) => {
    for (let j = 0; j < n; j++) {
      const z = gridToWorld(j, n);
      if (Math.abs(z - cz) > radius) continue;
      for (let i = 0; i < n; i++) {
        const x = gridToWorld(i, n);
        if (Math.hypot(x - cx, z - cz) > radius) continue;
        height[j * n + i] = terrain.heightAt(x, z);
      }
    }
  };
  const green = flagArea(hole);
  patch(green.x, green.z, green.r);
  if (hole.tee) patch(hole.tee.x, hole.tee.z, TEE_RADIUS + TEE_BLEND + 2);
}
