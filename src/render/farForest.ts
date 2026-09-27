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
import { InstancePicker } from './instancePicker';
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
 * **画面に入る木だけを GPU に渡す（render/instancePicker.ts）。** 種類ごとに島全体を 1 つにまとめているので、
 * three の画面外の判定が効かず、カメラの後ろの木まで毎回全部描いていた（画面に入るのは 1〜2 割）。
 * 本物の木のチャンクの下の木も、ここで除く。
 */

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
  private readonly picker = new InstancePicker();
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
      this.picker.add(mesh, b.matrices, b.colors, { x: 0, y: 0, z: 0 });
      this.group.add(mesh);
    }
  }

  /** 描く前に毎コマ呼ぶ。カメラが少し動くか向きを変えたときだけ、画面に入る木を選び直す。 */
  update(camera: THREE.PerspectiveCamera, now: number): void {
    const tex = this.uniforms.uCoverage.value as THREE.DataTexture | null;
    const on = this.uniforms.uCoverageOn.value > 0.5 && tex !== null;
    const version = on ? tex!.version : -2;
    const changed = version !== this.coverageVersion;
    this.coverageVersion = version;
    const data = on ? (tex!.image.data as Uint8Array) : null;
    this.picker.update(camera, now, changed, (x, z) => {
      if (!data) return false;
      const i = Math.floor(x / CHUNK_SIZE) + COVERAGE_OFFSET;
      const j = Math.floor(z / CHUNK_SIZE) + COVERAGE_OFFSET;
      if (i < 0 || j < 0 || i >= COVERAGE_SIZE || j >= COVERAGE_SIZE) return false;
      // シェーダーの閾値（0.75）と同じ。本物の木を置いたチャンクだけ。
      return data[j * COVERAGE_SIZE + i] > 191;
    });
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
    this.picker.clear();
  }
}
