import * as THREE from 'three';
import type { OverviewArrays } from '../island/overviewArrays';
import { CHUNK_SIZE } from '../world/chunk';
import { COVERAGE_OFFSET, COVERAGE_SIZE } from './chunkManager';
import { RENDER_ORDER } from './order';
import { createTerrainMaterial } from './terrainMaterial';

/**
 * 島全体を 1 枚で描く。「つくる」で見渡す島であり、飛んでいる間の遠景でもある。
 * PC は元の約 5.3m 格子、スマホは 1 点おきの約 10.7m 格子を使う。
 *
 * 中身の配列は Worker が作る（island/overviewArrays.ts）。地面の色は近くのチャンクと同じ。
 * 飛んでいる間は、近くのチャンクができている所を描かない（coverage）。
 * 重ねて描くと 2 枚の地面が深度を奪い合ってチラつき、消すと読み込み中に穴が開くため。
 */

const SEABED_DEEP = new THREE.Color().setHex(0x1f3d52, THREE.SRGBColorSpace);
/** 格子の外に敷く海底の深さ（m）。島の縁の海の深さより少し下げて重ならないようにする。 */
const OUTER_SEABED = -80.5;

interface CoverageUniforms {
  uCoverage: { value: THREE.Texture | null };
  uCoverageOn: { value: number };
}

const COVERAGE_GLSL = /* glsl */ `
  uniform sampler2D uCoverage;
  uniform float uCoverageOn;
  bool coveredByChunk(vec2 xz) {
    if (uCoverageOn < 0.5) return false;
    vec2 c = floor(xz / ${CHUNK_SIZE.toFixed(1)}) + ${COVERAGE_OFFSET.toFixed(1)};
    if (c.x < 0.0 || c.y < 0.0 || c.x >= ${COVERAGE_SIZE.toFixed(1)} || c.y >= ${COVERAGE_SIZE.toFixed(1)}) return false;
    return texture2D(uCoverage, (c + 0.5) / ${COVERAGE_SIZE.toFixed(1)}).r > 0.25;
  }
`;

/** 島全体の 1 枚と、その水面。飛んでいる間は近くのチャンクの所を描かない。 */
export class OverviewMesh {
  readonly group = new THREE.Group();
  private terrain: THREE.Mesh | null = null;
  private water: THREE.Mesh | null = null;
  private readonly uniforms: CoverageUniforms = {
    uCoverage: { value: null },
    uCoverageOn: { value: 0 },
  };
  private readonly terrainMaterial: THREE.MeshLambertMaterial;
  private readonly waterMaterial: THREE.ShaderMaterial;

  constructor(sharedWater: THREE.ShaderMaterial) {
    this.terrainMaterial = createTerrainMaterial({
      uniforms: this.uniforms as unknown as Record<string, THREE.IUniform>,
      fragmentPars: COVERAGE_GLSL,
      fragmentStart: '  if (coveredByChunk(vTerrainPos.xz)) discard;',
      cacheKey: 'overview',
    });

    // 水の材質は海・近くの川と共有しているので、遠景の水面だけ複製して「描かない所」を足す。
    this.waterMaterial = sharedWater.clone();
    this.waterMaterial.uniforms = { ...sharedWater.uniforms, ...this.uniforms };
    this.waterMaterial.fragmentShader = sharedWater.fragmentShader
      .replace('varying vec3 vWorld;', `varying vec3 vWorld;\n${COVERAGE_GLSL}`)
      .replace('void main() {', 'void main() {\n    if (coveredByChunk(vWorld.xz)) discard;');

    // 格子の外にも海底が無いと、島のまわりに格子の四角い境目が透けて見える。
    const seabed = new THREE.Mesh(
      // 巨大な三角形 2 枚にすると深度の補間誤差が大きいので、400m 四方に分ける（water.ts と同じ理由）。
      new THREE.PlaneGeometry(80000, 80000, 200, 200).rotateX(-Math.PI / 2),
      new THREE.MeshLambertMaterial({ color: SEABED_DEEP }),
    );
    seabed.position.y = OUTER_SEABED;
    this.group.add(seabed);
  }

  /** 飛んでいる間は、近くのチャンクができている所を描かない。null で全部描く。 */
  setCoverage(texture: THREE.Texture | null): void {
    this.uniforms.uCoverage.value = texture;
    this.uniforms.uCoverageOn.value = texture ? 1 : 0;
  }

  /** Worker が作った配列（island/overviewArrays.ts）を貼る。 */
  set(arrays: OverviewArrays, water: Float32Array | null): void {
    this.clear();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(arrays.position, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(arrays.normal, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(arrays.color, 3));
    geo.setAttribute('rock', new THREE.BufferAttribute(arrays.rock, 3));
    geo.setAttribute('surf', new THREE.BufferAttribute(arrays.surf, 3));
    geo.setIndex(new THREE.BufferAttribute(arrays.index, 1));
    geo.computeBoundingSphere();
    this.terrain = new THREE.Mesh(geo, this.terrainMaterial);
    this.group.add(this.terrain);
    if (water) {
      const waterGeo = new THREE.BufferGeometry();
      waterGeo.setAttribute('position', new THREE.BufferAttribute(water, 3));
      waterGeo.computeBoundingSphere();
      this.water = new THREE.Mesh(waterGeo, this.waterMaterial);
      this.water.renderOrder = RENDER_ORDER.water;
      this.group.add(this.water);
    }
  }

  private clear(): void {
    for (const mesh of [this.terrain, this.water]) {
      if (!mesh) continue;
      this.group.remove(mesh);
      mesh.geometry.dispose();
    }
    this.terrain = null;
    this.water = null;
  }
}
