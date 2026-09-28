import * as THREE from 'three';

/**
 * 木のように数の多い InstancedMesh から、画面に入るものだけを GPU に渡す。
 *
 * three の画面外の判定は InstancedMesh 全体の球で行うので、広い範囲に散らばった木（遠くの林は島全体、
 * 近くの木はチャンク 1 つ 192m）では、カメラの後ろや横の木まで毎回全部描いていた（画面に入るのは 1〜2 割）。
 * 全部の姿勢と色を手元に持ち、カメラが少し動くか向きを変えたときだけ、画面より少し広い範囲に入るものを選び直して
 * その本数だけを描く。見た目は変わらない（選び直すまでの動きの分だけ広く選ぶ）。
 */

/** 選び直す目安: カメラの移動（m）と向きの変化（度）、最短の間隔（秒）。 */
const REPICK_MOVE = 40;
const REPICK_TURN = 12;
const REPICK_MIN_S = 0.2;
/** これより大きく動いた・向きを変えたら、間を待たずに選び直す（空撮のカットの切り替えで欠けないように）。 */
const REPICK_JUMP = 300;
const REPICK_JUMP_TURN = 40;
/** 選ぶときの画面の広げ方（度）。選び直すまでに向きが変わっても、画面の端で欠けないように。 */
const PICK_MARGIN = 14;
/**
 * これより遠い木は、軽い形（同じ枝ぶりで面を減らしたもの。treeGeometry.ts の withLite）で描く。
 * 空から見下ろすとコースの周りの木が 2,000 本近く画面に入り、描く重さの半分を占めていた。250m 先の木は数画素。
 */
const LITE_DISTANCE = 250;

export interface PickEntry {
  mesh: THREE.InstancedMesh;
  /** 全部の姿勢（4×4 行列の列）と色。mesh の中身はここから選んで写す。 */
  matrices: Float32Array;
  colors: Float32Array | null;
  total: number;
  /** 行列の位置に足すずれ（チャンクの木は、チャンクの原点からの位置で持っている）。 */
  ox: number;
  oy: number;
  oz: number;
  /** 1 つの大きさ: 根元から球の中心までの高さと、球の半径（m）。 */
  lift: number;
  radius: number;
  /** 遠いものを描く軽い形（無ければ全部 mesh で描く）。 */
  lite: THREE.InstancedMesh | null;
}

export class InstancePicker {
  private readonly entries = new Set<PickEntry>();
  /** 足したばかりで、まだ選んでいないもの（前回と同じ範囲で選ぶ）。 */
  private readonly fresh = new Set<PickEntry>();
  private readonly pickCamera = new THREE.PerspectiveCamera();
  private readonly frustum = new THREE.Frustum();
  private readonly viewProj = new THREE.Matrix4();
  private readonly sphere = new THREE.Sphere();
  private readonly lastPos = new THREE.Vector3(Infinity, 0, 0);
  private readonly lastDir = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();
  /** 最後に選んだときのカメラの位置（軽い形にする距離を測る）。 */
  private readonly eye = new THREE.Vector3();
  private lastFov = 0;
  private lastAspect = 0;
  private lastPick = -Infinity;
  private hasFrustum = false;

  /**
   * InstancedMesh を預かる。mesh の instanceMatrix・instanceColor は写し先として新しく作り直す
   * （matrices と colors は手元に全部として残す）。画面外の判定はここで行うので、three の判定は切る。
   */
  add(
    mesh: THREE.InstancedMesh,
    matrices: Float32Array,
    colors: Float32Array | null,
    offset: { x: number; y: number; z: number },
    lite: THREE.InstancedMesh | null = null,
  ): PickEntry {
    const total = matrices.length / 16;
    for (const m of lite ? [mesh, lite] : [mesh]) {
      m.instanceMatrix = new THREE.InstancedBufferAttribute(new Float32Array(matrices), 16);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      if (colors) {
        m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(colors), 3);
        m.instanceColor.setUsage(THREE.DynamicDrawUsage);
      }
      m.frustumCulled = false;
      m.count = 0;
    }
    const geo = mesh.geometry;
    if (!geo.boundingSphere) geo.computeBoundingSphere();
    const bs = geo.boundingSphere!;
    // 木ごとの大きさの違い（行列の拡大）を見込んで、球を 1.5 倍に取る。
    const entry: PickEntry = {
      mesh,
      matrices,
      colors,
      total,
      ox: offset.x,
      oy: offset.y,
      oz: offset.z,
      lift: bs.center.y * 1.5,
      radius: (bs.radius + Math.abs(bs.center.y) * 0.5) * 1.5,
      lite,
    };
    this.entries.add(entry);
    this.fresh.add(entry);
    return entry;
  }

  remove(entry: PickEntry): void {
    this.entries.delete(entry);
    this.fresh.delete(entry);
  }

  clear(): void {
    this.entries.clear();
    this.fresh.clear();
  }

  /**
   * 描く前に毎コマ呼ぶ。カメラが少し動くか向きを変えたとき（force でも）全部を選び直す。
   * それ以外は、足したばかりのものだけを前回と同じ範囲で選ぶ。skip は、描かない場所（本物の木の下の遠目の木など）。
   */
  update(camera: THREE.PerspectiveCamera, now: number, force = false, skip?: (x: number, z: number) => boolean): void {
    if (this.entries.size === 0) return;
    camera.getWorldDirection(this.dir);
    const dist = camera.position.distanceTo(this.lastPos);
    const dot = this.dir.dot(this.lastDir);
    const lens = camera.fov !== this.lastFov || camera.aspect !== this.lastAspect;
    const moved = dist > REPICK_MOVE || dot < Math.cos(THREE.MathUtils.degToRad(REPICK_TURN));
    const jumped = dist > REPICK_JUMP || dot < Math.cos(THREE.MathUtils.degToRad(REPICK_JUMP_TURN));
    const due = force || lens || jumped || !this.hasFrustum || (moved && now - this.lastPick >= REPICK_MIN_S);
    if (due) {
      this.lastPick = now;
      this.lastPos.copy(camera.position);
      this.lastDir.copy(this.dir);
      this.lastFov = camera.fov;
      this.lastAspect = camera.aspect;
      this.setFrustum(camera);
      for (const e of this.entries) this.pick(e, skip);
      this.fresh.clear();
      return;
    }
    if (this.fresh.size > 0) {
      for (const e of this.fresh) this.pick(e, skip);
      this.fresh.clear();
    }
  }

  /** 画面より上下左右に PICK_MARGIN 度ずつ広いカメラの視錐台。 */
  private setFrustum(camera: THREE.PerspectiveCamera): void {
    const halfV = THREE.MathUtils.degToRad(camera.fov / 2);
    const halfH = Math.atan(Math.tan(halfV) * camera.aspect);
    const m = THREE.MathUtils.degToRad(PICK_MARGIN);
    const wideV = Math.min(halfV + m, THREE.MathUtils.degToRad(85));
    const wideH = Math.min(halfH + m, THREE.MathUtils.degToRad(85));
    const pc = this.pickCamera;
    pc.fov = THREE.MathUtils.radToDeg(wideV * 2);
    pc.aspect = Math.tan(wideH) / Math.tan(wideV);
    pc.near = camera.near;
    pc.far = camera.far;
    pc.position.copy(camera.position);
    this.eye.copy(camera.position);
    pc.quaternion.copy(camera.quaternion);
    pc.updateProjectionMatrix();
    pc.updateMatrixWorld();
    this.viewProj.multiplyMatrices(pc.projectionMatrix, pc.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.viewProj);
    this.hasFrustum = true;
  }

  private pick(e: PickEntry, skip?: (x: number, z: number) => boolean): void {
    const s = this.sphere;
    s.radius = e.radius;
    const far2 = LITE_DISTANCE * LITE_DISTANCE;
    const targets = e.lite ? [e.mesh, e.lite] : [e.mesh];
    const counts = [0, 0];
    for (let k = 0; k < e.total; k++) {
      const o = k * 16;
      const x = e.matrices[o + 12] + e.ox;
      const y = e.matrices[o + 13] + e.oy;
      const z = e.matrices[o + 14] + e.oz;
      s.center.set(x, y + e.lift, z);
      if (!this.frustum.intersectsSphere(s) || (skip && skip(x, z))) continue;
      const dx = x - this.eye.x;
      const dy = y - this.eye.y;
      const dz = z - this.eye.z;
      const t = e.lite && dx * dx + dy * dy + dz * dz > far2 ? 1 : 0;
      const m = targets[t];
      const n = counts[t]++;
      // 写し先の同じ位置には前回の別の木が残っていることがあるので、いつも写す。
      (m.instanceMatrix.array as Float32Array).set(e.matrices.subarray(o, o + 16), n * 16);
      if (e.colors) (m.instanceColor!.array as Float32Array).set(e.colors.subarray(k * 3, k * 3 + 3), n * 3);
    }
    targets.forEach((m, t) => {
      const n = counts[t];
      m.count = n;
      m.visible = n > 0;
      m.instanceMatrix.clearUpdateRanges();
      m.instanceMatrix.addUpdateRange(0, n * 16);
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) {
        m.instanceColor.clearUpdateRanges();
        m.instanceColor.addUpdateRange(0, n * 3);
        m.instanceColor.needsUpdate = true;
      }
    });
  }
}
