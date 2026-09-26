/// <reference lib="webworker" />
import { LOD_STEPS, buildChunkArrays } from './chunk';
import { buildScatterData } from './scatter';
import type { IslandParams } from '../island/params';
import type { LandscapeArrays } from './islandShape';
import { type IslandWaterArrays, IslandWater } from './islandWater';
import { Terrain } from './terrain';
import type { Hole } from '../golf/course';

export interface BuildRequest {
  type: 'build';
  id: number;
  cx: number;
  cz: number;
  lod: number;
}

export interface InitRequest {
  type: 'init';
  params: IslandParams;
  /** 島の大きな形（隆起と侵食）。 */
  landscape: LandscapeArrays;
  /** 島全体の格子で求めた水（湖・川・彫った量）。 */
  water: IslandWaterArrays;
  /** ゴルフの旗（グリーンとティーを均し、フェアウェイを刈り込む）。 */
  holes: readonly Hole[];
}

/** 旗を差し替える（自分の旗を立てた・抜いた）。この後に頼まれたチャンクから新しい地面で作る。 */
export interface CourseRequest {
  type: 'course';
  holes: readonly Hole[];
}

export type WorkerRequest = InitRequest | CourseRequest | BuildRequest;

export interface BuiltBatch {
  kind: number;
  matrices: Float32Array;
  colors: Float32Array;
}

export interface BuiltChunk {
  type: 'built';
  id: number;
  cx: number;
  cz: number;
  lod: number;
  position: Float32Array;
  normal: Float32Array;
  color: Float32Array;
  rock: Float32Array;
  surf: Float32Array;
  index: Uint16Array | Uint32Array;
  /** 内陸の水面（座標だけ）。無ければ長さ 0。 */
  water: Float32Array;
  batches: BuiltBatch[];
}

let terrain: Terrain | null = null;

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;

  if (msg.type === 'init') {
    terrain = new Terrain(msg.params, msg.landscape, new IslandWater(msg.water), msg.holes);
    return;
  }

  if (!terrain) return;
  if (msg.type === 'course') {
    terrain.setHoles(msg.holes);
    return;
  }

  const { id, cx, cz, lod } = msg;
  const geo = buildChunkArrays(terrain, cx, cz, LOD_STEPS[lod]);
  const batches = buildScatterData(terrain, cx, cz, lod);

  const payload: BuiltChunk = {
    type: 'built',
    id, cx, cz, lod,
    position: geo.position,
    normal: geo.normal,
    color: geo.color,
    rock: geo.rock,
    surf: geo.surf,
    index: geo.index,
    water: geo.water,
    batches,
  };

  // 転送してコピーを避ける（生成した配列はこの後 Worker 側では使わない）。
  const transfer: Transferable[] = [
    geo.position.buffer as ArrayBuffer,
    geo.normal.buffer as ArrayBuffer,
    geo.color.buffer as ArrayBuffer,
    geo.rock.buffer as ArrayBuffer,
    geo.surf.buffer as ArrayBuffer,
    geo.index.buffer as ArrayBuffer,
    geo.water.buffer as ArrayBuffer,
  ];
  for (const b of batches) {
    transfer.push(b.matrices.buffer as ArrayBuffer, b.colors.buffer as ArrayBuffer);
  }

  (self as unknown as Worker).postMessage(payload, transfer);
};
