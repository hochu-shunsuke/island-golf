import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { ForestBatch } from '../island/forest';
import { CHUNK_SIZE } from '../world/chunk';
import {
  KIND_AUTUMN,
  KIND_BROADLEAF,
  KIND_BROADLEAF_TALL,
  KIND_BROADLEAF_WIDE,
  KIND_DEAD,
  KIND_PALM,
  KIND_PINE,
  KIND_PINE_OLD,
  KIND_PINE_YOUNG,
  KIND_SAKURA,
} from '../world/vegetationKinds';
import { COVERAGE_OFFSET, COVERAGE_SIZE } from './chunkManager';
import { injectIslandLight } from './islandLight';
import { paint } from './treeGeometry';

/**
 * 遠目の木。島全体の木（island/forest.ts）を 1 本 20〜40 三角形の軽い形で描く。
 *
 * 本物の木（render/treeCatalog.ts、1 本 数千頂点）を島全体に並べると重すぎる。
 * 遠くからは樹冠の色と塊が見えれば足りる。形の大きさは本物の木にそろえ、
 * 近づいて本物に切り替わっても大きさが変わらないようにする。
 *
 * 飛んでいる間は、本物の木を描いているチャンクの所では描かない（coverage が 0.75 を越える所）。
 *
 * **画面に入る木だけを GPU に渡す。** 種類ごとに島全体を 1 つにまとめているので、three の画面外の判定が効かず、
 * カメラの後ろの木まで毎回全部描いていた（画面に入るのは 1〜2 割）。カメラが少し動くか向きを変えたときだけ、
 * 画面より少し広い範囲に入る木（本物の木のチャンクの下は除く）を選び直し、その本数だけを描く。
 */

/** 選び直す目安: カメラの移動（m）と向きの変化（度）、最短の間隔（秒）。 */
const REPICK_MOVE = 40;
const REPICK_TURN = 12;
const REPICK_MIN_S = 0.2;
/** これより大きく動いた・向きを変えたら、間を待たずに選び直す（空撮のカットの切り替えで、木が欠けないように）。 */
const REPICK_JUMP = 300;
const REPICK_JUMP_TURN = 40;
/** 選ぶときの画面の広げ方（度）。選び直すまでに向きが変わっても、画面の端に木が欠けないように。 */
const PICK_MARGIN = 14;
/** 木 1 本の大きさ（m）。幹の根元の点ではなく、この半径の球で画面に入るかを見る。 */
const TREE_RADIUS = 12;

interface FarBatch {
  mesh: THREE.InstancedMesh;
  /** 全部の木の姿勢と色（ここから画面に入る木を選んで mesh へ写す）。 */
  matrices: Float32Array;
  colors: Float32Array;
  total: number;
}

const BARK = 0x6b5744;

function broadleaf(leaf: number, crownY: number, radius: number, flatten: number): THREE.BufferGeometry {
  const trunk = new THREE.CylinderGeometry(0.22, 0.32, crownY, 5).translate(0, crownY / 2, 0);
  const crown = new THREE.IcosahedronGeometry(radius, 0);
  crown.scale(1, flatten, 1).translate(0, crownY + radius * flatten * 0.55, 0);
  return mergeGeometries([paint(trunk, BARK), paint(crown, leaf)])!;
}

function conifer(green: number, height: number, radius: number): THREE.BufferGeometry {
  const trunk = new THREE.CylinderGeometry(0.1, 0.25, height * 0.3, 5).translate(0, height * 0.15, 0);
  const low = new THREE.ConeGeometry(radius, height * 0.55, 7).translate(0, height * 0.42, 0);
  const high = new THREE.ConeGeometry(radius * 0.62, height * 0.45, 7).translate(0, height * 0.75, 0);
  return mergeGeometries([paint(trunk, BARK), paint(low, green), paint(high, green)])!;
}

function palm(): THREE.BufferGeometry {
  const trunk = new THREE.CylinderGeometry(0.13, 0.3, 7, 5).translate(0, 3.5, 0);
  const crown = new THREE.IcosahedronGeometry(2.4, 0).scale(1, 0.35, 1).translate(0, 7, 0);
  return mergeGeometries([paint(trunk, 0x806b4b), paint(crown, 0x4d7d3e)])!;
}

function dead(): THREE.BufferGeometry {
  const trunk = new THREE.CylinderGeometry(0.08, 0.26, 4.2, 5).translate(0, 2.1, 0);
  const crown = new THREE.IcosahedronGeometry(1.2, 0).scale(1, 0.7, 1).translate(0, 4.3, 0);
  return mergeGeometries([paint(trunk, 0x7d6d58), paint(crown, 0x7d6d58)])!;
}

/** 種類ごとの軽い形。大きさは treeCatalog.ts の本物の木に合わせる。 */
function farGeometry(kind: number): THREE.BufferGeometry | null {
  switch (kind) {
    case KIND_BROADLEAF:
      return broadleaf(0x5c7d4d, 3.2, 2.6, 0.85);
    case KIND_BROADLEAF_TALL:
      return broadleaf(0x5c7d4d, 4.8, 2.1, 1.0);
    case KIND_BROADLEAF_WIDE:
      return broadleaf(0x5c7d4d, 3.8, 3.2, 0.62);
    case KIND_AUTUMN:
      return broadleaf(0xcf8a2e, 3.2, 2.6, 0.85);
    case KIND_SAKURA:
      return broadleaf(0xe6a9c4, 3.2, 2.9, 0.8);
    case KIND_PINE:
      return conifer(0x456349, 8.5, 1.4);
    case KIND_PINE_YOUNG:
      return conifer(0x4c6b50, 4.5, 0.9);
    case KIND_PINE_OLD:
      return conifer(0x3f5c43, 11, 1.8);
    case KIND_PALM:
      return palm();
    case KIND_DEAD:
      return dead();
    default:
      return null;
  }
}

export class FarForest {
  readonly group = new THREE.Group();
  private readonly uniforms = {
    uCoverage: { value: null as THREE.Texture | null },
    uCoverageOn: { value: 0 },
  };
  private readonly material: THREE.MeshLambertMaterial;
  private readonly geometries = new Map<number, THREE.BufferGeometry | null>();
  private batches: FarBatch[] = [];
  private readonly pickCamera = new THREE.PerspectiveCamera();
  private readonly frustum = new THREE.Frustum();
  private readonly viewProj = new THREE.Matrix4();
  private readonly sphere = new THREE.Sphere(new THREE.Vector3(), TREE_RADIUS);
  private readonly lastPos = new THREE.Vector3(Infinity, 0, 0);
  private readonly lastDir = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();
  private lastFov = 0;
  private lastAspect = 0;
  private lastPick = -Infinity;
  private coverageVersion = -1;

  constructor() {
    this.material = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    this.material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vTreeXZ;')
        .replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\nvTreeXZ = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xz;',
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
          varying vec2 vTreeXZ;
          uniform sampler2D uCoverage;
          uniform float uCoverageOn;`,
        )
        .replace(
          'void main() {',
          `void main() {
            if (uCoverageOn > 0.5) {
              vec2 c = floor(vTreeXZ / ${CHUNK_SIZE.toFixed(1)}) + ${COVERAGE_OFFSET.toFixed(1)};
              if (c.x >= 0.0 && c.y >= 0.0 && c.x < ${COVERAGE_SIZE.toFixed(1)} && c.y < ${COVERAGE_SIZE.toFixed(1)}
                && texture2D(uCoverage, (c + 0.5) / ${COVERAGE_SIZE.toFixed(1)}).r > 0.75) discard;
            }`,
        );
      injectIslandLight(shader, 'vTreeXZ');
    };
  }

  private geometry(kind: number): THREE.BufferGeometry | null {
    if (!this.geometries.has(kind)) {
      const g = farGeometry(kind);
      g?.computeVertexNormals();
      this.geometries.set(kind, g);
    }
    return this.geometries.get(kind)!;
  }

  set(batches: readonly ForestBatch[]): void {
    this.clear();
    for (const b of batches) {
      const geo = this.geometry(b.kind);
      if (!geo) continue;
      const count = b.matrices.length / 16;
      const mesh = new THREE.InstancedMesh(geo, this.material, count);
      // 中身は update で画面に入る木だけを写す。three の画面外の判定は島全体の球になるので使わない。
      mesh.instanceMatrix = new THREE.InstancedBufferAttribute(new Float32Array(b.matrices), 16);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(b.colors), 3);
      mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this.batches.push({ mesh, matrices: b.matrices, colors: b.colors, total: count });
    }
    this.lastPos.set(Infinity, 0, 0);
  }

  /** 描く前に毎コマ呼ぶ。カメラが少し動くか向きを変えたときだけ、画面に入る木を選び直す。 */
  update(camera: THREE.PerspectiveCamera, now: number): void {
    if (this.batches.length === 0) return;
    const tex = this.uniforms.uCoverage.value as THREE.DataTexture | null;
    const covOn = this.uniforms.uCoverageOn.value > 0.5 && tex !== null;
    const version = covOn ? tex!.version : -2;
    camera.getWorldDirection(this.dir);
    const dist = camera.position.distanceTo(this.lastPos);
    const dot = this.dir.dot(this.lastDir);
    const moved = dist > REPICK_MOVE;
    const turned = dot < Math.cos(THREE.MathUtils.degToRad(REPICK_TURN));
    const lens = camera.fov !== this.lastFov || camera.aspect !== this.lastAspect;
    const covChanged = version !== this.coverageVersion;
    if (!moved && !turned && !lens && !covChanged) return;
    // 初め・覆いが変わった・カメラが飛んだ（空撮のカットの切り替え）ときはすぐ。少し動いただけなら間を空ける。
    const jumped = dist > REPICK_JUMP || dot < Math.cos(THREE.MathUtils.degToRad(REPICK_JUMP_TURN));
    if (!covChanged && !lens && !jumped && now - this.lastPick < REPICK_MIN_S) return;
    this.lastPick = now;
    this.lastPos.copy(camera.position);
    this.lastDir.copy(this.dir);
    this.lastFov = camera.fov;
    this.lastAspect = camera.aspect;
    this.coverageVersion = version;

    // 画面より上下左右に PICK_MARGIN 度ずつ広いカメラで選ぶ。
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
    pc.quaternion.copy(camera.quaternion);
    pc.updateProjectionMatrix();
    pc.updateMatrixWorld();
    this.viewProj.multiplyMatrices(pc.projectionMatrix, pc.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.viewProj);

    const data = covOn ? (tex!.image.data as Uint8Array) : null;
    const covered = (x: number, z: number) => {
      if (!data) return false;
      const i = Math.floor(x / CHUNK_SIZE) + COVERAGE_OFFSET;
      const j = Math.floor(z / CHUNK_SIZE) + COVERAGE_OFFSET;
      if (i < 0 || j < 0 || i >= COVERAGE_SIZE || j >= COVERAGE_SIZE) return false;
      // シェーダーの閾値（0.75）と同じ。本物の木を置いたチャンクだけ。
      return data[j * COVERAGE_SIZE + i] > 191;
    };
    const c = this.sphere.center;
    for (const b of this.batches) {
      const outM = b.mesh.instanceMatrix.array as Float32Array;
      const outC = b.mesh.instanceColor!.array as Float32Array;
      let n = 0;
      for (let k = 0; k < b.total; k++) {
        const o = k * 16;
        const x = b.matrices[o + 12];
        const z = b.matrices[o + 14];
        c.set(x, b.matrices[o + 13] + TREE_RADIUS * 0.5, z);
        if (!this.frustum.intersectsSphere(this.sphere) || covered(x, z)) continue;
        outM.set(b.matrices.subarray(o, o + 16), n * 16);
        outC.set(b.colors.subarray(k * 3, k * 3 + 3), n * 3);
        n++;
      }
      b.mesh.count = n;
      b.mesh.visible = n > 0;
      b.mesh.instanceMatrix.clearUpdateRanges();
      b.mesh.instanceMatrix.addUpdateRange(0, n * 16);
      b.mesh.instanceMatrix.needsUpdate = true;
      b.mesh.instanceColor!.clearUpdateRanges();
      b.mesh.instanceColor!.addUpdateRange(0, n * 3);
      b.mesh.instanceColor!.needsUpdate = true;
    }
  }

  /** 飛んでいる間は、本物の木を描いているチャンクの所を描かない。null で全部描く。 */
  setCoverage(texture: THREE.Texture | null): void {
    this.uniforms.uCoverage.value = texture;
    this.uniforms.uCoverageOn.value = texture ? 1 : 0;
  }

  clear(): void {
    for (const child of [...this.group.children]) {
      this.group.remove(child);
      if (child instanceof THREE.InstancedMesh) child.dispose();
    }
    this.batches = [];
  }
}
