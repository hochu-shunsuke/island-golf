import * as THREE from 'three';
import type { OverviewArrays } from '../island/overviewArrays';
import { CHUNK_SIZE } from '../world/chunk';
import { COVERAGE_OFFSET, COVERAGE_SIZE } from './chunkManager';
import { RENDER_ORDER } from './order';
import { createTerrainMaterial } from './terrainMaterial';
import { splitsAlongMainDiagonal } from '../world/terrain';

/**
 * 島全体を 1 枚で描く。「つくる」で見渡す島であり、飛んでいる間の遠景でもある。
 * PC は元の約 5.3m 格子、スマホは 1 点おきの約 10.7m 格子を使う。
 *
 * 中身の配列は Worker が作る（island/overviewArrays.ts）。地面の色は近くのチャンクと同じ。
 * 飛んでいる間は、近くのチャンクができている所を描かない（coverage）。
 * 重ねて描くと 2 枚の地面が深度を奪い合ってチラつき、消すと読み込み中に穴が開くため。
 *
 * **升目に分けて、見えない升目は描かない。** 1 枚のままだと、チャンクに覆われた所やカメラの後ろの三角形まで毎回
 * 全部処理していた（PC の約 118 万三角形。遊んでいる間の GPU の 3 割強）。チャンク 4×4 個分（768m）の升目ごとに
 * 三角形の番号だけを分け（頂点は共有）、チャンクで全部覆われた升目と画面の外の升目を描かない。升目の境目を
 * またぐ三角形は「継ぎ目」にまとめて常に描く（片方の升目に入れると、その升目を描かないときに隙間が開く）。
 * 見える升目が多いとき（島全体を見渡す開始画面など）は、描く回数を増やさないよう 1 枚のまま描く。
 *
 * **遠くから見るときは、形を 1 つおきの粗さにし、色は画像から引く。** 島全体を沖の高い所から見ると、
 * 5.3m 格子の三角形が 1〜2 画素まで小さくなり、同じ画素を何度も塗って重かった（開始画面の島全体のカットで GPU の
 * 8 割、PC で 30fps ほど）。形だけ粗くすると色の境目（フェアウェイの縁・雪と岩の境）がぼやけるので、色・岩の色・
 * 量・法線は元の細かさの画像に写して画素ごとに引く（terrainMaterial.ts の textured）。粗い形は同じ頂点を 1 つおきに
 * つないだ三角形の番号だけ。切り替えは島全体でまとめて（升目ごとに混ぜると境目に隙間ができる）。
 */

/** これより高い（海面から m）か、島の中心から遠い（m）カメラでは、遠くから見る粗い形で描く。 */
const FAR_ALTITUDE = 600;
const FAR_DISTANCE = 2600;

/** 升目の 1 辺（チャンクの数、768m）。2（384m）より描く回数が少なく、減らせる三角形はほぼ同じだった。 */
const TILE_CHUNKS = 4;
/** 見える升目がこれより多ければ、升目に分けずに 1 枚で描く。 */
const MAX_TILE_DRAWS = 20;

interface OverviewTile {
  mesh: THREE.Mesh;
  /** 升目のチャンク番号の範囲（世界のチャンク番号、両端を含む）。 */
  cx0: number;
  cz0: number;
  cx1: number;
  cz1: number;
  sphere: THREE.Sphere;
}

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
  /** 升目（見えない所を描かないため）と、升目の境目をまたぐ三角形。 */
  private tiles: OverviewTile[] = [];
  private seam: THREE.Mesh | null = null;
  private coverageVersion = -1;
  private readonly covered = new Set<OverviewTile>();
  private readonly frustum = new THREE.Frustum();
  private readonly viewProj = new THREE.Matrix4();
  private water: THREE.Mesh | null = null;
  /** 遠くから見るときの粗い形（色は画像から引く）と、その画像。 */
  private far: THREE.Mesh | null = null;
  private farTextures: THREE.DataTexture[] = [];
  private readonly farUniforms = {
    uOvColor: { value: null as THREE.Texture | null },
    uOvRock: { value: null as THREE.Texture | null },
    uOvSurf: { value: null as THREE.Texture | null },
    uOvNormal: { value: null as THREE.Texture | null },
    uOvMap: { value: new THREE.Vector4() },
  };
  private readonly farMaterial: THREE.MeshLambertMaterial;
  private readonly center = new THREE.Vector3();
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

    this.farMaterial = createTerrainMaterial({
      uniforms: { ...this.uniforms, ...this.farUniforms } as unknown as Record<string, THREE.IUniform>,
      fragmentPars: COVERAGE_GLSL,
      fragmentStart: '  if (coveredByChunk(vTerrainPos.xz)) discard;',
      cacheKey: 'overview',
      textured: true,
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
    this.coverageVersion = -1;
  }

  /**
   * 描く前に毎コマ呼ぶ: チャンクで全部覆われた升目と画面の外の升目を描かない。見える升目が多ければ 1 枚で描く。
   */
  update(camera: THREE.Camera): void {
    if (!this.terrain) return;
    // 遠くから見るときは、粗い形と画像の色で島全体を 1 枚で描く。
    const p = camera.position;
    const farView = this.far !== null && (p.y > FAR_ALTITUDE || Math.hypot(p.x - this.center.x, p.z - this.center.z) > FAR_DISTANCE);
    if (this.far) this.far.visible = farView;
    if (farView) {
      this.terrain.visible = false;
      if (this.seam) this.seam.visible = false;
      for (const t of this.tiles) t.mesh.visible = false;
      return;
    }
    if (this.tiles.length === 0) {
      this.terrain.visible = true;
      return;
    }
    this.refreshCovered();
    camera.updateMatrixWorld();
    this.viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.viewProj);
    let shown = 0;
    for (const t of this.tiles) {
      const on = !this.covered.has(t) && this.frustum.intersectsSphere(t.sphere);
      t.mesh.userData.want = on;
      if (on) shown++;
    }
    const useTiles = shown <= MAX_TILE_DRAWS;
    this.terrain.visible = !useTiles;
    if (this.seam) this.seam.visible = useTiles;
    for (const t of this.tiles) t.mesh.visible = useTiles && t.mesh.userData.want === true;
  }

  /** チャンクの覆い（coverage のテクスチャの中身）が変わったら、全部覆われた升目を数え直す。 */
  private refreshCovered(): void {
    const tex = this.uniforms.uCoverage.value as THREE.DataTexture | null;
    const on = this.uniforms.uCoverageOn.value > 0.5 && tex !== null;
    const version = on ? tex!.version : -2;
    if (version === this.coverageVersion) return;
    this.coverageVersion = version;
    this.covered.clear();
    if (!on) return;
    const data = tex!.image.data as Uint8Array;
    const cell = (cx: number, cz: number) => {
      const i = cx + COVERAGE_OFFSET;
      const j = cz + COVERAGE_OFFSET;
      if (i < 0 || j < 0 || i >= COVERAGE_SIZE || j >= COVERAGE_SIZE) return false;
      // シェーダーの coveredByChunk と同じ閾値（0.25）。
      return data[j * COVERAGE_SIZE + i] > 63;
    };
    for (const t of this.tiles) {
      let all = true;
      for (let cz = t.cz0; cz <= t.cz1 && all; cz++) for (let cx = t.cx0; cx <= t.cx1 && all; cx++) all = cell(cx, cz);
      if (all) this.covered.add(t);
    }
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
    this.center.copy(geo.boundingSphere!.center);
    this.buildTiles(geo, arrays);
    this.buildFar(geo, arrays);
    if (water) {
      const waterGeo = new THREE.BufferGeometry();
      waterGeo.setAttribute('position', new THREE.BufferAttribute(water, 3));
      waterGeo.computeBoundingSphere();
      this.water = new THREE.Mesh(waterGeo, this.waterMaterial);
      this.water.renderOrder = RENDER_ORDER.water;
      this.group.add(this.water);
    }
  }

  /**
   * 三角形を升目ごとに分ける（頂点は full と共有し、升目ごとに持つのは三角形の番号だけ）。
   * 升目の境目をまたぐ三角形は継ぎ目へ。升目の球は、升目の四角と中の高さの幅から作る（画面の外かの判定用）。
   */
  private buildTiles(full: THREE.BufferGeometry, arrays: OverviewArrays): void {
    const pos = arrays.position;
    const index = arrays.index;
    const span = CHUNK_SIZE * TILE_CHUNKS;
    const tileOf = (x: number) => Math.floor(x / span);
    const lists = new Map<string, number[]>();
    const bounds = new Map<string, { y0: number; y1: number }>();
    const seam: number[] = [];
    for (let t = 0; t < index.length; t += 3) {
      const a = index[t] * 3;
      const b = index[t + 1] * 3;
      const c = index[t + 2] * 3;
      const tx = tileOf(pos[a]);
      const tz = tileOf(pos[a + 2]);
      if (tileOf(pos[b]) !== tx || tileOf(pos[c]) !== tx || tileOf(pos[b + 2]) !== tz || tileOf(pos[c + 2]) !== tz) {
        seam.push(index[t], index[t + 1], index[t + 2]);
        continue;
      }
      const key = `${tx},${tz}`;
      let list = lists.get(key);
      if (!list) {
        list = [];
        lists.set(key, list);
        bounds.set(key, { y0: Infinity, y1: -Infinity });
      }
      list.push(index[t], index[t + 1], index[t + 2]);
      const bb = bounds.get(key)!;
      for (const v of [a, b, c]) {
        bb.y0 = Math.min(bb.y0, pos[v + 1]);
        bb.y1 = Math.max(bb.y1, pos[v + 1]);
      }
    }
    const shared = (g: THREE.BufferGeometry, list: number[]) => {
      for (const name of ['position', 'normal', 'color', 'rock', 'surf']) g.setAttribute(name, full.getAttribute(name));
      g.setIndex(new THREE.BufferAttribute(new Uint32Array(list), 1));
      return g;
    };
    for (const [key, list] of lists) {
      const [tx, tz] = key.split(',').map(Number);
      const { y0, y1 } = bounds.get(key)!;
      const box = new THREE.Box3(new THREE.Vector3(tx * span, y0, tz * span), new THREE.Vector3((tx + 1) * span, y1, (tz + 1) * span));
      const geo = shared(new THREE.BufferGeometry(), list);
      const sphere = box.getBoundingSphere(new THREE.Sphere());
      geo.boundingSphere = sphere.clone();
      geo.boundingBox = box;
      const mesh = new THREE.Mesh(geo, this.terrainMaterial);
      // 画面の外かは update で自分で見る（three に任せると、見える升目の数を数えられない）。
      mesh.frustumCulled = false;
      mesh.visible = false;
      this.group.add(mesh);
      this.tiles.push({
        mesh,
        cx0: tx * TILE_CHUNKS,
        cz0: tz * TILE_CHUNKS,
        cx1: tx * TILE_CHUNKS + TILE_CHUNKS - 1,
        cz1: tz * TILE_CHUNKS + TILE_CHUNKS - 1,
        sphere,
      });
    }
    const seamGeo = shared(new THREE.BufferGeometry(), seam);
    seamGeo.boundingSphere = full.boundingSphere!.clone();
    this.seam = new THREE.Mesh(seamGeo, this.terrainMaterial);
    this.seam.visible = false;
    this.group.add(this.seam);
    this.coverageVersion = -1;
  }

  /**
   * 遠くから見る粗い形（同じ頂点を 1 つおきにつなぐ）と、色・岩の色・量・法線の画像（元の格子の細かさ）を作る。
   * 画像の 1 画素は格子の 1 点。色と岩の色は平方根で詰め（暗い所の段差を減らす）、法線は 0..1 へ写す。
   */
  private buildFar(full: THREE.BufferGeometry, arrays: OverviewArrays): void {
    const pos = arrays.position;
    const sn = Math.round(Math.sqrt(pos.length / 3));
    if (sn < 5 || sn * sn * 3 !== pos.length) return;
    const texture = (src: Float32Array, encode: (v: number) => number) => {
      const out = new Uint8Array(sn * sn * 4);
      for (let k = 0; k < sn * sn; k++) {
        for (let c = 0; c < 3; c++) out[k * 4 + c] = Math.round(Math.min(1, Math.max(0, encode(src[k * 3 + c]))) * 255);
        out[k * 4 + 3] = 255;
      }
      const tex = new THREE.DataTexture(out, sn, sn, THREE.RGBAFormat, THREE.UnsignedByteType);
      // 縮小版（ミップマップ）は使わない。遠くでは 1 段粗い版が混ざり、頂点の色より境目がぼやけた。
      tex.magFilter = THREE.LinearFilter;
      tex.minFilter = THREE.LinearFilter;
      tex.generateMipmaps = false;
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.needsUpdate = true;
      this.farTextures.push(tex);
      return tex;
    };
    const u = this.farUniforms;
    u.uOvColor.value = texture(arrays.color, Math.sqrt);
    u.uOvRock.value = texture(arrays.rock, Math.sqrt);
    u.uOvSurf.value = texture(arrays.surf, (v) => v);
    u.uOvNormal.value = texture(arrays.normal, (v) => v * 0.5 + 0.5);
    // 格子の点 (i, j) の世界座標は x0 + i dx, z0 + j dz。画素の中心を合わせる。
    const x0 = pos[0];
    const z0 = pos[2];
    const dx = pos[3] - pos[0];
    const dz = pos[sn * 3 + 2] - pos[2];
    u.uOvMap.value.set(x0 - dx / 2, z0 - dz / 2, 1 / (dx * sn), 1 / (dz * sn));

    // 1 つおきの点をつなぐ（端の点は必ず入れる。点の数が偶数なら最後の 1 列は 1 つ幅で）。
    const at: number[] = [];
    for (let i = 0; i < sn - 1; i += 2) at.push(i);
    at.push(sn - 1);
    const h = (i: number, j: number) => pos[(j * sn + i) * 3 + 1];
    const list: number[] = [];
    for (let jj = 0; jj < at.length - 1; jj++) {
      for (let ii = 0; ii < at.length - 1; ii++) {
        const i0 = at[ii];
        const i1 = at[ii + 1];
        const j0 = at[jj];
        const j1 = at[jj + 1];
        const a = j0 * sn + i0;
        const b = j0 * sn + i1;
        const d = j1 * sn + i0;
        const e = j1 * sn + i1;
        if (splitsAlongMainDiagonal(h(i0, j0), h(i1, j0), h(i0, j1), h(i1, j1))) list.push(a, d, e, a, e, b);
        else list.push(a, d, b, d, e, b);
      }
    }
    const geo = new THREE.BufferGeometry();
    for (const name of ['position', 'normal', 'color', 'rock', 'surf']) geo.setAttribute(name, full.getAttribute(name));
    geo.setIndex(new THREE.BufferAttribute(new Uint32Array(list), 1));
    geo.boundingSphere = full.boundingSphere!.clone();
    this.far = new THREE.Mesh(geo, this.farMaterial);
    this.far.visible = false;
    this.group.add(this.far);
  }

  private clear(): void {
    for (const mesh of [this.terrain, this.water]) {
      if (!mesh) continue;
      this.group.remove(mesh);
      mesh.geometry.dispose();
    }
    // 升目と継ぎ目は頂点を full と共有している。三角形の番号の分だけ捨てる（dispose は full の頂点も GPU から消す
    // ことになるが、full も同時に捨てるので構わない）。
    for (const mesh of [...this.tiles.map((t) => t.mesh), this.seam]) {
      if (!mesh) continue;
      this.group.remove(mesh);
      mesh.geometry.dispose();
    }
    if (this.far) {
      this.group.remove(this.far);
      this.far.geometry.dispose();
      this.far = null;
    }
    for (const t of this.farTextures) t.dispose();
    this.farTextures = [];
    this.tiles = [];
    this.seam = null;
    this.covered.clear();
    this.terrain = null;
    this.water = null;
  }
}
