import * as THREE from 'three';
import { vegetation } from './vegetation';
import { CHUNK_SIZE, LOD_RINGS } from '../world/chunk';
import { RENDER_ORDER } from './order';
import { createTerrainMaterial } from './terrainMaterial';
import { ISLAND_SIZE } from '../island/grid';
import type { BuiltChunk, InitRequest, WorkerRequest } from '../world/worker';
import type { Hole } from '../golf/course';

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

interface Chunk {
  mesh: THREE.Mesh;
  scatter: THREE.Group | null;
  /** 内陸の水面（湖）。無ければ null。 */
  lake: THREE.Mesh | null;
  lod: number;
  cx: number;
  cz: number;
  /** どの旗の並び（setHoles の回数）で作ったか。 */
  version: number;
}

/** 旗を差し替えて地面が変わった範囲。これより古い版で作ったチャンクは作り直す。 */
interface Change {
  x: number;
  z: number;
  r: number;
  version: number;
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
  /** 作成中のチャンク（依頼番号 → 場所と、頼んだときの旗の並びの版）。 */
  private inFlight = new Map<number, { key: string; version: number }>();
  private version = 0;
  private changes: Change[] = [];
  private queue: Pending[] = [];
  private workers: Worker[] = [];
  private freeWorkers: Worker[] = [];
  private nextId = 1;
  private lastChunkX = Number.NaN;
  private lastChunkZ = Number.NaN;

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

  /**
   * 旗を差し替える（自分の旗を立てた・抜いた）。Worker の地形を差し替え、areas に掛かる
   * チャンクを今の粗さのまま作り直す。Worker は届いた順に処理するので、この後に頼んだ
   * チャンクは新しい地面で作られる。先に頼んであった分は、届いたときに古いと分かって作り直す。
   */
  setHoles(holes: readonly Hole[], areas: readonly { x: number; z: number; r: number }[]): void {
    this.version++;
    for (const w of this.workers) w.postMessage({ type: 'course', holes } satisfies WorkerRequest);
    for (const a of areas) this.changes.push({ ...a, version: this.version });
    for (const [key, chunk] of this.chunks) {
      if (!this.isStale(chunk.cx, chunk.cz, chunk.version)) continue;
      const dist = Math.max(Math.abs(chunk.cx - this.lastChunkX), Math.abs(chunk.cz - this.lastChunkZ));
      this.queue.push({ key, cx: chunk.cx, cz: chunk.cz, lod: chunk.lod, dist });
    }
    this.queue.sort((a, b) => a.dist - b.dist);
  }

  /** 版 version で作ったチャンクが、その後に変わった地面に掛かっているか。 */
  private isStale(cx: number, cz: number, version: number): boolean {
    for (const c of this.changes) {
      if (c.version <= version) continue;
      // チャンクの四角の中で円の中心に一番近い点までの距離。
      const nx = Math.max(cx * CHUNK_SIZE, Math.min(c.x, (cx + 1) * CHUNK_SIZE));
      const nz = Math.max(cz * CHUNK_SIZE, Math.min(c.z, (cz + 1) * CHUNK_SIZE));
      if (Math.hypot(nx - c.x, nz - c.z) <= c.r) return true;
    }
    return false;
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
        if (existing && existing.lod === lod && !this.isStale(cx, cz, existing.version)) continue;
        this.queue.push({ key, cx, cz, lod, dist });
      }
    }
    // 近いものから作る。
    this.queue.sort((a, b) => a.dist - b.dist);
  }

  private dispatch(): void {
    while (this.freeWorkers.length > 0 && this.queue.length > 0) {
      const job = this.queue.shift()!;

      // 既に同じ粗さで作り終えている（地面も新しい）／作成中なら飛ばす。
      // 作成中のものが古い地面なら、届いたときに作り直す（onBuilt）。
      const existing = this.chunks.get(job.key);
      if (existing && existing.lod === job.lod && !this.isStale(job.cx, job.cz, existing.version)) continue;
      let already = false;
      for (const f of this.inFlight.values()) {
        if (f.key === job.key) { already = true; break; }
      }
      if (already) continue;

      const w = this.freeWorkers.pop()!;
      const id = this.nextId++;
      this.inFlight.set(id, { key: job.key, version: this.version });
      w.postMessage({ type: 'build', id, cx: job.cx, cz: job.cz, lod: job.lod } satisfies WorkerRequest);
    }
  }

  private onBuilt(w: Worker, data: BuiltChunk): void {
    this.freeWorkers.push(w);
    const version = this.inFlight.get(data.id)?.version ?? 0;
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

    this.chunks.set(key, { mesh, scatter, lake, lod: data.lod, cx: data.cx, cz: data.cz, version });
    // 本物の木を置く粗さ（TREE_LOD 以下）なら、遠目の木をここで消す。
    this.setCoverage(data.cx, data.cz, data.lod <= TREE_LOD ? 255 : 128);

    // 生成中にプレイヤーが動いて、必要な粗さが変わっていることがある。
    // ここで積み直さないと、次にチャンク境界を跨ぐまで粗いまま残る。
    // 作っている間に旗が差し替わった場合も同じ。
    if (desired !== data.lod || this.isStale(data.cx, data.cz, version)) {
      this.queue.push({ key, cx: data.cx, cz: data.cz, lod: desired, dist });
      this.queue.sort((a, b) => a.dist - b.dist);
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
