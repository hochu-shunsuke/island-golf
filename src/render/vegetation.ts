import * as THREE from 'three';
import { injectIslandLight } from './islandLight';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { hash2 } from '../core/rng';
import { TREE_CATALOG, buildCatalogGeometry } from './treeCatalog';
import { paint, withLite } from './treeGeometry';
import { KIND_BUSH, KIND_ROCK } from '../world/vegetationKinds';

/**
 * 木・岩の形と材質。全チャンクで共有する。
 *
 * **木の一覧は treeCatalog.ts の TREE_CATALOG にしかない。** 開発用の見本帳
 * （/trees.html）が同じ配列を読むので、ここに形を直接書くと見本帳と食い違う。
 */

function at(geo: THREE.BufferGeometry, y: number, x = 0, z = 0): THREE.BufferGeometry {
  geo.translate(x, y, z);
  return geo;
}

function makeRock(): THREE.BufferGeometry {
  // 正二十面体の角をずらして岩らしくする。
  // この形は非インデックスで、同じ角が複数の頂点として重複している。
  // 頂点番号で乱数を引くと同じ角が別々に動いて面が裂けるので、
  // 座標から乱数を引く。同じ角は座標が一致するので、必ず一緒に動く。
  const geo = new THREE.IcosahedronGeometry(1, 0);
  const p = geo.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const key = (Math.round(x * 64) * 73856093) ^ (Math.round(y * 64) * 19349663) ^ (Math.round(z * 64) * 83492791);
    const s = 0.72 + hash2(key, 0, 991) * 0.55;
    p.setXYZ(i, x * s, y * s * 0.75, z * s);
  }
  return paint(geo, 0x8a857a);
}

function makeBush(): THREE.BufferGeometry {
  return mergeGeometries([
    paint(at(new THREE.IcosahedronGeometry(0.6, 0), 0.4), 0x6f8a56),
    paint(at(new THREE.IcosahedronGeometry(0.42, 0), 0.6, 0.5, 0.3), 0x7d9660),
  ])!;
}

let cache: { geometries: THREE.BufferGeometry[]; lite: THREE.BufferGeometry[]; material: THREE.Material } | null = null;

export function vegetation() {
  if (!cache) {
    const geometries: THREE.BufferGeometry[] = [];
    // 遠くの木の軽い形（同じ種で、面の数だけ減らす。treeGeometry.ts の withLite）。
    const lite: THREE.BufferGeometry[] = [];
    for (const entry of TREE_CATALOG) {
      geometries[entry.kind] = buildCatalogGeometry(entry, 0x9e3779b9 ^ entry.kind);
      lite[entry.kind] = withLite(() => buildCatalogGeometry(entry, 0x9e3779b9 ^ entry.kind));
    }
    geometries[KIND_ROCK] = makeRock();
    geometries[KIND_BUSH] = makeBush();
    // paint() が normal を落とすので、ここでまとめて作り直す。
    for (const g of geometries) {
      if (!g) continue;
      g.computeVertexNormals();
      g.computeBoundingSphere();
    }
    const material = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    // 山の影の中の木は暗く（焼き込んだ島の光を、木の根元の位置で引く）。
    material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vTreeXZ;')
        .replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\nvTreeXZ = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xz;',
        );
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec2 vTreeXZ;');
      injectIslandLight(shader, 'vTreeXZ');
    };
    for (const g of lite) {
      if (!g) continue;
      g.computeVertexNormals();
      g.computeBoundingSphere();
    }
    cache = { geometries, lite, material };
  }
  return cache;
}
