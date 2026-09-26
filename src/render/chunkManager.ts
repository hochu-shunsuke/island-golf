import * as THREE from 'three';
import { vegetation } from './vegetation';
import { CHUNK_SIZE, LOD_RINGS } from '../world/chunk';
import { RENDER_ORDER } from './order';
import { createTerrainMaterial } from './terrainMaterial';
import { ISLAND_SIZE } from '../island/grid';
import type { BuiltChunk, InitRequest, WorkerRequest } from '../world/worker';
import type { Tree } from '../golf/ball';
import { KIND_BUSH, KIND_ROCK } from '../world/vegetationKinds';

const MAX_RING = LOD_RINGS[LOD_RINGS.length - 1];

/**
 * 島を覆うチャンクの数（1 辺）。島の遠景（overviewMesh.ts）は、近くのチャンクが
 * できている所だけ描かない。どこができているかをこの大きさのテクスチャで渡す。
 */
export const COVERAGE_SIZE = Math.ceil(ISLAND_SIZE / CHUNK_SIZE) + 2;
/** 世界のチャンク番号 → テクスチャの番号。島の中心（0,0）が真ん中に来る。 */
export const COVERAGE_OFFSET = COVERAGE_SIZE / 2;

/** 本物の木を置くチャンクの粗さの上限（vegetationSpecs.ts の maxLod のうち木のもの）。 */
const TREE_LOD = 1;
/** 球が当たる木を探す升目（m）と、チャンクの 1 辺の升目の数。 */
const TREE_BUCKET = 16;
const TREE_BUCKETS = Math.ceil(CHUNK_SIZE / TREE_BUCKET);

interface Chunk {
  mesh: THREE.Mesh;
  scatter: THREE.Group | null;
  /** 内陸の水面（湖）。無ければ null。 */
  lake: THREE.Mesh | null;
  lod: number;
  cx: number;
  cz: number;
  /** 球が当たる木（16m の升目ごと）。木の無いチャンクは null。 */
  trees: Tree[][] | null;
}

interface Pending {
  key: string;
  cx: number;
  cz: number;
  lod: number;
  dist: number;
}

/**
 * プレイヤーの周りのチャンクを、距離に応じた粗さで出し入れする。
 * 生成は Worker に投げるので、歩いている間にカクつかない。
 */
export class ChunkManager {
  private scene: THREE.Scene;
  private material: THREE.Material;
  private waterMaterial: THREE.Material;
  private chunks = new Map<string, Chunk>();
  private inFlight = new Map<number, string>();
  private queue: Pending[] = [];
  private workers: Worker[] = [];
  private freeWorkers: Worker[] = [];
  private nextId = 1;
  private lastChunkX = Number.NaN;
  private lastChunkZ = Number.NaN;

  /** 木の形ごとの大きさ（形の外接箱から。高さと葉の広がり）。 */
  private treeDims = new Map<number, { top: number; radius: number }>();

  /** 足元付近のチャンクが揃ったか（開始画面を閉じる判定に使う）。 */
  ready = false;

  /**
   * どのチャンクができているか。0 = 無し、0.5 = 地形だけ、1 = 地形と本物の木。
   * 遠景の島は 0.25 を越える所、遠目の木は 0.75 を越える所を描かない。
   */
  readonly coverage: THREE.DataTexture;
  private readonly coverageData: Uint8Array;

  constructor(
    scene: THREE.Scene,
    init: Omit<InitRequest, 'type'>,
    waterMaterial: THREE.Material,
  ) {
    this.scene = scene;
    this.material = createTerrainMaterial();
    this.waterMaterial = waterMaterial;

    const count = Math.max(2, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
    for (let i = 0; i < count; i++) {
      const w = new Worker(new URL('../world/worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (ev: MessageEvent<BuiltChunk>) => this.onBuilt(w, ev.data);
      w.postMessage({ type: 'init', ...init } satisfies WorkerRequest);
      this.workers.push(w);
      this.freeWorkers.push(w);
    }

    this.coverageData = new Uint8Array(COVERAGE_SIZE * COVERAGE_SIZE);
    this.coverage = new THREE.DataTexture(
      this.coverageData,
      COVERAGE_SIZE,
      COVERAGE_SIZE,
      THREE.RedFormat,
      THREE.UnsignedByteType,
    );
    this.coverage.magFilter = THREE.NearestFilter;
    this.coverage.minFilter = THREE.NearestFilter;
    this.coverage.needsUpdate = true;
  }

  private setCoverage(cx: number, cz: number, value: number): void {
    const i = cx + COVERAGE_OFFSET;
    const j = cz + COVERAGE_OFFSET;
    if (i < 0 || j < 0 || i >= COVERAGE_SIZE || j >= COVERAGE_SIZE) return;
    this.coverageData[j * COVERAGE_SIZE + i] = value;
    this.coverage.needsUpdate = true;
  }

  /** 飛ぶのをやめたら全部片付ける。Worker も止める。 */
  dispose(): void {
    for (const w of this.workers) w.terminate();
    for (const chunk of this.chunks.values()) this.disposeChunk(chunk);
    this.chunks.clear();
    this.coverage.dispose();
  }

  private key(cx: number, cz: number): string {
    return `${cx},${cz}`;
  }

  /** チェビシェフ距離から、そのチャンクを作るべき粗さを決める。範囲外は -1。 */
  private lodFor(dist: number): number {
    for (let i = 0; i < LOD_RINGS.length; i++) {
      if (dist <= LOD_RINGS[i]) return i;
    }
    return -1;
  }

  update(x: number, z: number): void {
    const pcx = Math.floor(x / CHUNK_SIZE);
    const pcz = Math.floor(z / CHUNK_SIZE);

    // プレイヤーが別のチャンクへ移った時だけ、必要な差分を洗い直す。
    if (pcx !== this.lastChunkX || pcz !== this.lastChunkZ) {
      this.lastChunkX = pcx;
      this.lastChunkZ = pcz;
      this.rebuildQueue(pcx, pcz);
      this.evict(pcx, pcz);
    }

    this.dispatch();

    if (!this.ready) {
      // 中心の 3x3 が揃えば歩き始められる。
      let ok = true;
      for (let dx = -1; dx <= 1 && ok; dx++) {
        for (let dz = -1; dz <= 1 && ok; dz++) {
          if (!this.chunks.has(this.key(pcx + dx, pcz + dz))) ok = false;
        }
      }
      this.ready = ok;
    }
  }

  private rebuildQueue(pcx: number, pcz: number): void {
    this.queue.length = 0;
    for (let dz = -MAX_RING; dz <= MAX_RING; dz++) {
      for (let dx = -MAX_RING; dx <= MAX_RING; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dz));
        const lod = this.lodFor(dist);
        if (lod < 0) continue;

        const cx = pcx + dx;
        const cz = pcz + dz;
        const key = this.key(cx, cz);
        const existing = this.chunks.get(key);
        if (existing && existing.lod === lod) continue;
        this.queue.push({ key, cx, cz, lod, dist });
      }
    }
    // 近いものから作る。
    this.queue.sort((a, b) => a.dist - b.dist);
  }

  private dispatch(): void {
    while (this.freeWorkers.length > 0 && this.queue.length > 0) {
      const job = this.queue.shift()!;

      // 既に同じ粗さで作り終えている／作成中なら飛ばす。
      const existing = this.chunks.get(job.key);
      if (existing && existing.lod === job.lod) continue;
      let already = false;
      for (const k of this.inFlight.values()) {
        if (k === job.key) { already = true; break; }
      }
      if (already) continue;

      const w = this.freeWorkers.pop()!;
      const id = this.nextId++;
      this.inFlight.set(id, job.key);
      w.postMessage({ type: 'build', id, cx: job.cx, cz: job.cz, lod: job.lod } satisfies WorkerRequest);
    }
  }

  private onBuilt(w: Worker, data: BuiltChunk): void {
    this.freeWorkers.push(w);
    this.inFlight.delete(data.id);

    const key = this.key(data.cx, data.cz);

    // 届いた頃には遠ざかっていることがある。その場合は捨てる。
    const dist = Math.max(
      Math.abs(data.cx - this.lastChunkX),
      Math.abs(data.cz - this.lastChunkZ),
    );
    const desired = this.lodFor(dist);
    if (desired < 0) return;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(data.position, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(data.normal, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(data.color, 3));
    geo.setAttribute('rock', new THREE.BufferAttribute(data.rock, 3));
    geo.setAttribute('surf', new THREE.BufferAttribute(data.surf, 3));
    geo.setIndex(new THREE.BufferAttribute(data.index, 1));
    geo.computeBoundingSphere();

    const mesh = new THREE.Mesh(geo, this.material);
    mesh.position.set(data.cx * CHUNK_SIZE, 0, data.cz * CHUNK_SIZE);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();

    // 内陸の水面（湖）。海はカメラ追従の板が描くので、ここは湖だけ。
    // 材質は water.ts と共有する（別々に作ると設定がいつかずれる）。
    let lake: THREE.Mesh | null = null;
    if (data.water.length > 0) {
      const wgeo = new THREE.BufferGeometry();
      wgeo.setAttribute('position', new THREE.BufferAttribute(data.water, 3));
      wgeo.computeBoundingSphere();
      lake = new THREE.Mesh(wgeo, this.waterMaterial);
      lake.position.copy(mesh.position);
      lake.matrixAutoUpdate = false;
      lake.updateMatrix();
      lake.renderOrder = RENDER_ORDER.water;
      this.scene.add(lake);
    }

    let scatter: THREE.Group | null = null;
    if (data.batches.length > 0) {
      const veg = vegetation();
      scatter = new THREE.Group();
      scatter.position.copy(mesh.position);
      scatter.matrixAutoUpdate = false;
      scatter.updateMatrix();
      for (const b of data.batches) {
        const n = b.matrices.length / 16;
        const inst = new THREE.InstancedMesh(veg.geometries[b.kind], veg.material, n);
        inst.instanceMatrix = new THREE.InstancedBufferAttribute(b.matrices, 16);
        inst.instanceColor = new THREE.InstancedBufferAttribute(b.colors, 3);
        inst.instanceMatrix.needsUpdate = true;
        inst.computeBoundingSphere();
        scatter.add(inst);
      }
    }

    // 差し替えは新しいものを足してから古いものを外す（一瞬の穴を作らないため）。
    this.scene.add(mesh);
    if (scatter) this.scene.add(scatter);

    const old = this.chunks.get(key);
    if (old) this.disposeChunk(old);

    this.chunks.set(key, {
      mesh,
      scatter,
      lake,
      lod: data.lod,
      cx: data.cx,
      cz: data.cz,
      trees: this.indexTrees(data),
    });
    // 本物の木を置く粗さ（TREE_LOD 以下）なら、遠目の木をここで消す。
    this.setCoverage(data.cx, data.cz, data.lod <= TREE_LOD ? 255 : 128);

    // 生成中にプレイヤーが動いて、必要な粗さが変わっていることがある。
    // ここで積み直さないと、次にチャンク境界を跨ぐまで粗いまま残る。
    if (desired !== data.lod) {
      this.queue.push({ key, cx: data.cx, cz: data.cz, lod: desired, dist });
      this.queue.sort((a, b) => a.dist - b.dist);
    }
  }

  /** 届いたチャンクの木を、球が当たる形（幹の円柱と葉のかたまり）にして升目に分ける。岩と茂みは除く。 */
  private indexTrees(data: BuiltChunk): Tree[][] | null {
    let buckets: Tree[][] | null = null;
    for (const b of data.batches) {
      if (b.kind === KIND_ROCK || b.kind === KIND_BUSH) continue;
      const dims = this.dimsOf(b.kind);
      const m = b.matrices;
      for (let o = 0; o < m.length; o += 16) {
        const sxz = Math.hypot(m[o], m[o + 1], m[o + 2]);
        const sy = Math.hypot(m[o + 4], m[o + 5], m[o + 6]);
        const lx = m[o + 12];
        const ly = m[o + 13];
        const lz = m[o + 14];
        const height = dims.top * sy;
        const radius = dims.radius * sxz;
        const tree: Tree = {
          x: data.cx * CHUNK_SIZE + lx,
          z: data.cz * CHUNK_SIZE + lz,
          y: ly,
          trunkR: Math.max(0.15, height * 0.03),
          trunkTop: ly + height * 0.55,
          canopyY: ly + height - radius * 0.85,
          canopyR: radius * 0.9,
        };
        const bi = Math.max(0, Math.min(TREE_BUCKETS - 1, Math.floor(lx / TREE_BUCKET)));
        const bj = Math.max(0, Math.min(TREE_BUCKETS - 1, Math.floor(lz / TREE_BUCKET)));
        buckets ??= Array.from({ length: TREE_BUCKETS * TREE_BUCKETS }, () => []);
        buckets[bj * TREE_BUCKETS + bi].push(tree);
      }
    }
    return buckets;
  }

  private dimsOf(kind: number): { top: number; radius: number } {
    let d = this.treeDims.get(kind);
    if (!d) {
      const geo = vegetation().geometries[kind];
      geo.computeBoundingBox();
      const box = geo.boundingBox!;
      const spread = Math.max(-box.min.x, box.max.x, -box.min.z, box.max.z);
      d = { top: box.max.y, radius: spread * 0.85 };
      this.treeDims.set(kind, d);
    }
    return d;
  }

  /** (x, z) から半径 r の中の木を visit に渡す（球の物理が使う）。 */
  treesNear(x: number, z: number, r: number, visit: (t: Tree) => void): void {
    const cx0 = Math.floor((x - r) / CHUNK_SIZE);
    const cx1 = Math.floor((x + r) / CHUNK_SIZE);
    const cz0 = Math.floor((z - r) / CHUNK_SIZE);
    const cz1 = Math.floor((z + r) / CHUNK_SIZE);
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const trees = this.chunks.get(this.key(cx, cz))?.trees;
        if (!trees) continue;
        const ox = cx * CHUNK_SIZE;
        const oz = cz * CHUNK_SIZE;
        const bi0 = Math.max(0, Math.floor((x - r - ox) / TREE_BUCKET));
        const bi1 = Math.min(TREE_BUCKETS - 1, Math.floor((x + r - ox) / TREE_BUCKET));
        const bj0 = Math.max(0, Math.floor((z - r - oz) / TREE_BUCKET));
        const bj1 = Math.min(TREE_BUCKETS - 1, Math.floor((z + r - oz) / TREE_BUCKET));
        for (let bj = bj0; bj <= bj1; bj++) {
          for (let bi = bi0; bi <= bi1; bi++) {
            for (const t of trees[bj * TREE_BUCKETS + bi]) visit(t);
          }
        }
      }
    }
  }

  private evict(pcx: number, pcz: number): void {
    for (const [key, chunk] of this.chunks) {
      const dist = Math.max(Math.abs(chunk.cx - pcx), Math.abs(chunk.cz - pcz));
      if (dist > MAX_RING) {
        this.disposeChunk(chunk);
        this.chunks.delete(key);
      }
    }
  }

  private disposeChunk(chunk: Chunk): void {
    this.setCoverage(chunk.cx, chunk.cz, 0);
    this.scene.remove(chunk.mesh);
    chunk.mesh.geometry.dispose();
    if (chunk.lake) {
      this.scene.remove(chunk.lake);
      chunk.lake.geometry.dispose();
    }
    if (chunk.scatter) {
      this.scene.remove(chunk.scatter);
      for (const child of chunk.scatter.children) {
        // ジオメトリと材質は共有なので、インスタンス側だけ解放する。
        if (child instanceof THREE.InstancedMesh) child.dispose();
      }
    }
  }
}
