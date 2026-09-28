import * as THREE from 'three';
import { C_SNOW } from '../world/islandSurface';
import { injectIslandLight } from './islandLight';
import { NOISE_CELLS, createNoiseTexture } from './noiseTexture';

/**
 * 地面の材質。近くのチャンクと、見渡す島の 1 枚（overviewMesh.ts）が同じものを使う。
 *
 * 頂点は 3 つの層を持つ（world/islandSurface.ts）── 土台の色、岩の色、岩と雪の量。
 * ここで画素ごとに次をする。
 *   - 岩と雪の境目を、世界座標のノイズで揺らしてから切る。頂点や面の単位で切ると、
 *     境目が格子の四角に揃って市松模様になった（遠くの粗いチャンクほど四角が大きい）
 *   - 細かい質感: 草のまだら、岩の地層と凹凸、雪のわずかなうねり。明るさと法線の両方を揺らす
 *   - 凹みの明暗（大きな地形の曲がりから、頂点ごとに求めてある）
 *
 * ノイズは起動時に作ったテクスチャから引く（render/noiseTexture.ts）。画素ごとに計算するより軽く、
 * 細かすぎる模様はミップマップが均すので、遠くでちらつかない。
 * 表示専用なので決定性の決まりの外。
 */

const SNOW = new THREE.Vector3(C_SNOW[0], C_SNOW[1], C_SNOW[2]);

let noise: THREE.DataTexture | null = null;

const PARS_VERTEX = /* glsl */ `
  attribute vec3 rock;
  attribute vec3 surf;
  varying vec3 vRock;
  varying vec3 vSurf;
  varying vec3 vTerrainPos;
  varying vec3 vTerrainNormal;
`;

const VERTEX = /* glsl */ `
  vRock = rock;
  vSurf = surf;
  vTerrainPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
  vTerrainNormal = normalize(mat3(modelMatrix) * objectNormal);
`;

const PARS_FRAGMENT = /* glsl */ `
  uniform vec3 uSnow;
  varying vec3 vRock;
  varying vec3 vSurf;
  varying vec3 vTerrainPos;
  varying vec3 vTerrainNormal;

  uniform sampler2D uNoise;
  // 1 マス cell（m）の大きさで、4 つの独立なノイズ（中心 0）を引く。
  // 真上からだけ貼ると、崖では模様が斜面に沿って縦に引き伸ばされ、毛皮のような筋になった。
  // 面の向きに合わせて 3 方向から貼って混ぜる（triplanar）。w は 3 方向の重み。
  // 細かすぎて見分けられない所はミップマップが均して 0 に寄る。
  vec4 terrainNoise(vec3 pos, vec3 w, float cell, mat2 turn) {
    float s = 1.0 / (cell * NOISE_CELLS);
    vec4 top = texture2D(uNoise, turn * pos.xz * s);
    vec4 front = texture2D(uNoise, turn * pos.xy * s + 0.37);
    vec4 side = texture2D(uNoise, turn * pos.zy * s + 0.71);
    return top * w.y + front * w.z + side * w.x - 0.5;
  }
  // 境目を揺らしてから切る。量が 0 や 1 の所は揺らさない。
  float terrainCut(float amount, float wobble) {
    return smoothstep(0.4, 0.6, amount + wobble * 4.0 * amount * (1.0 - amount));
  }
  // 画素ごとの高さの揺らぎから法線を曲げる（Mikkelsen の手法。三次元の座標の微分だけで済む）。
  vec3 terrainBump(vec3 pos, vec3 n, float height) {
    vec3 sx = dFdx(pos);
    vec3 sy = dFdy(pos);
    vec3 r1 = cross(sy, n);
    vec3 r2 = cross(n, sx);
    float det = dot(sx, r1);
    vec2 dh = vec2(dFdx(height), dFdy(height));
    vec3 grad = sign(det) * (dh.x * r1 + dh.y * r2);
    return normalize(abs(det) * n - grad);
  }
`;

const COLOR_FRAGMENT = /* glsl */ `
  float up = normalize(vTerrainNormal).y;

  // ノイズは 3 つの大きさで 4 つずつ。大きさの比を整数にせず、向きも回して繰り返しを揃えない。
  vec3 tw = pow(abs(normalize(vTerrainNormal)), vec3(4.0));
  tw /= tw.x + tw.y + tw.z;
  vec4 nA = terrainNoise(vTerrainPos, tw, 21.0, mat2(1.0, 0.0, 0.0, 1.0));
  vec4 nB = terrainNoise(vTerrainPos, tw, 5.3, mat2(0.8, -0.6, 0.6, 0.8));
  vec4 nC = terrainNoise(vTerrainPos, tw, 1.45, mat2(0.28, 0.96, -0.96, 0.28));

  // 境目の揺らぎ: 数十 m のまとまりと、数 m の細かいぎざぎざ。
  float wobble = nA.r * 0.55 + nB.r * 0.35 + nC.r * 0.18;

  // 岩: 頂点の量に、画素の急さを少し足す（細部の崖が岩として見える）。
  // 足すのはかなり急な面だけ（45° を越えてから）。緩めると、川が彫った岸がどこも
  // 白っぽい岩の帯になり、雪の土手のように見えた。
  float rockAmt = clamp(vSurf.x + smoothstep(0.7, 0.45, up) * 0.35, 0.0, 1.0);
  float rockMask = terrainCut(rockAmt, wobble);
  // 雪: 急な面には積もらない。
  float snowAmt = vSurf.y * smoothstep(0.5, 0.72, up);
  float snowMask = terrainCut(snowAmt, wobble * 0.8 - 0.05);

  // 土台（草・土・砂）: 1〜30m のまだら。明るい所は少し黄みへ。
  float g1 = nA.g;
  float g2 = nB.g;
  float g3 = nC.g;
  float grain = g1 * 0.5 + g2 * 0.35 + g3 * 0.3;
  vec3 ground = vColor.rgb * (1.0 + grain * 0.45);
  ground *= vec3(1.0 + g1 * 0.12, 1.0 + g1 * 0.05, 1.0 - g1 * 0.1);

  // 岩: ゆるいまだらだけ。高さの sin で地層の縞を入れていたが、等間隔の横縞が
  // 斜面に並んで模様に見えた（利用者の指摘）。規則的な縞は入れない。
  float r1 = nA.a;
  float r3 = nC.b;
  vec3 rockCol = vRock * (1.0 + r1 * 0.2 + nB.b * 0.12 + r3 * 0.08);

  // 雪: ほぼ白。風に削られた細かいうねり。
  float s1 = nA.a;
  float s2 = nB.a;
  vec3 snowCol = uSnow * (1.0 + s1 * 0.07 + s2 * 0.04);

  // 雪の切れ目から覗くのは、雪の深い所ほど岩（高い所の地面は草ではない）。
  // 土台の色のままだと、雪原の中に黄緑の染みが浮いた。
  vec3 bare = mix(ground, rockCol * 0.85, smoothstep(0.35, 0.75, snowAmt));
  vec3 albedo = mix(ground, rockCol, rockMask);
  albedo = mix(albedo, bare, (1.0 - rockMask) * smoothstep(0.2, 0.5, snowAmt));
  albedo = mix(albedo, snowCol, snowMask);
  // 凹みの明暗。雪の凹みは少し青く沈む。
  float ao = vSurf.z;
  albedo *= mix(vec3(ao), vec3(ao, ao * 1.02, ao * 1.08), snowMask);
  diffuseColor.rgb *= albedo;

  // 法線を曲げる高さの揺らぎ（m）。岩は凹凸を強く、雪はなめらか。
  float terrainHeight = mix(
    mix(g2 * 0.25 + g3 * 0.08, r1 * 0.7 + nB.b * 0.3 + r3 * 0.1, rockMask),
    s1 * 0.5 + s2 * 0.12,
    snowMask
  );
`;

/**
 * 遠景の島を粗い形で描くとき（overviewMesh.ts）: 色・岩の色・量・法線を、頂点ではなく画像から画素ごとに引く。
 * 形を粗くしても、色の境目（フェアウェイの縁・雪と岩の境）は元の細かさのまま。
 * 色と岩の色は平方根で詰めてある（暗い所の段差を減らす）。法線は 0..1 へ写してある。
 */
const TEXTURED_PARS = /* glsl */ `
  uniform sampler2D uOvColor;
  uniform sampler2D uOvRock;
  uniform sampler2D uOvSurf;
  uniform sampler2D uOvNormal;
  // xy: 画像の 0 番の画素の中心の世界座標、zw: 世界座標 1m あたりの画像の座標。
  uniform vec4 uOvMap;
  vec3 tColor;
  vec3 tRock;
  vec3 tSurf;
  vec3 tNormal;
`;

const TEXTURED_START = /* glsl */ `
  {
    vec2 ovUv = (vTerrainPos.xz - uOvMap.xy) * uOvMap.zw;
    vec3 c = texture2D(uOvColor, ovUv).rgb;
    tColor = c * c;
    vec3 r = texture2D(uOvRock, ovUv).rgb;
    tRock = r * r;
    tSurf = texture2D(uOvSurf, ovUv).rgb;
    tNormal = normalize(texture2D(uOvNormal, ovUv).rgb * 2.0 - 1.0);
  }
`;

export interface TerrainMaterialOptions {
  /** 色などを頂点ではなく画像から引く（遠景の島の粗い形。uniforms に uOv* を渡す）。 */
  textured?: boolean;
  /** 断片シェーダーに足す宣言（uniform や関数）。 */
  fragmentPars?: string;
  /** main の先頭に足す文（discard の判定など）。変数 vTerrainPos を使える。 */
  fragmentStart?: string;
  uniforms?: Record<string, THREE.IUniform>;
  /** シェーダーの作り分けの鍵。fragmentPars / fragmentStart を変えたら別の値にする。 */
  cacheKey?: string;
}

export function createTerrainMaterial(options: TerrainMaterialOptions = {}): THREE.MeshLambertMaterial {
  const material = new THREE.MeshLambertMaterial({ vertexColors: true });
  material.onBeforeCompile = (shader) => {
    noise ??= createNoiseTexture();
    shader.uniforms.uSnow = { value: SNOW };
    shader.uniforms.uNoise = { value: noise };
    if (options.uniforms) Object.assign(shader.uniforms, options.uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${PARS_VERTEX}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERTEX}`);
    const textured = options.textured === true;
    // 画像から引くときは、頂点の値（vColor・vRock・vSurf・vTerrainNormal）の代わりに画素ごとの値を使う。
    const color = textured
      ? COLOR_FRAGMENT.replaceAll('vColor.rgb', 'tColor')
          .replaceAll('vRock', 'tRock')
          .replaceAll('vSurf', 'tSurf')
          .replaceAll('vTerrainNormal', 'tNormal')
      : COLOR_FRAGMENT;
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>\n#define NOISE_CELLS ${NOISE_CELLS.toFixed(1)}\n${PARS_FRAGMENT}\n${textured ? TEXTURED_PARS : ''}\n${options.fragmentPars ?? ''}`,
      )
      .replace('void main() {', `void main() {\n${options.fragmentStart ?? ''}\n${textured ? TEXTURED_START : ''}`)
      .replace('#include <color_fragment>', color)
      .replace(
        '#include <normal_fragment_maps>',
        textured
          ? // 光も画像の法線で（粗い形の頂点の法線では、細かい尾根の陰影が消える）。
            '#include <normal_fragment_maps>\n  normal = normalize(mat3(viewMatrix) * tNormal);\n  normal = terrainBump(-vViewPosition, normal, terrainHeight);'
          : '#include <normal_fragment_maps>\n  normal = terrainBump(-vViewPosition, normal, terrainHeight);',
      );
    injectIslandLight(shader, 'vTerrainPos.xz');
  };
  material.customProgramCacheKey = () => `terrain:${options.cacheKey ?? ''}:${options.textured ? 'tex' : 'vtx'}`;
  return material;
}
