import * as THREE from 'three';
import { RENDER_ORDER } from './order';
import { CLOUD_PERIOD, createCloudTexture } from './cloudTexture';

/** 水平面への投影が急になる地平付近は、雲を朝もやへ溶かし切る。 */
export const CLOUD_HORIZON_FADE_START = 0.075;
export const CLOUD_HORIZON_FADE_END = 0.22;

const vert = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const frag = /* glsl */ `
  uniform vec3 uZenith;
  uniform vec3 uHorizon;
  uniform vec3 uGround;
  uniform vec3 uSunColor;
  uniform vec3 uSunDir;
  uniform vec2 uCloudSeed;
  uniform sampler2D uCloudNoise;
  uniform float uCloudTime;
  uniform float uCloudAmount;
  uniform float uCloudLow;
  uniform float uCloudHigh;
  uniform float uCloudScale;
  uniform float uCloudPeak;
  uniform float uCloudShade;
  varying vec3 vDir;

  void main() {
    vec3 d = normalize(vDir);

    // 天頂へ向かうほど濃い青に。指数を寝かせて地平付近を広く取る。
    // 指数を上げるほど地平の淡い色が狭まり、青が広がる。
    float t = pow(clamp(d.y, 0.0, 1.0), 0.45);
    vec3 col = mix(uHorizon, uZenith, t);

    // 地平線より下は霞んだ地面色へ落として、遠景と繋げる。
    col = mix(col, uGround, smoothstep(0.0, -0.12, d.y));

    // 雲。視線を「一定の高さの水平な板」に投影して模様を引く。
    // 板までの距離が d.y で決まるので、地平に近いほど模様が伸びて遠近が出る。
    //
    // d.y を途中で固定すると、その円周から下で同じ模様が縦に伸び、
    // 自分を中心にした雲の端として見える。投影が急になる前に朝もやへ
    // 滑らかに溶かし、描く範囲では本来の d.y をそのまま使う。
    float horizonFade = smoothstep(
      ${CLOUD_HORIZON_FADE_START.toFixed(3)},
      ${CLOUD_HORIZON_FADE_END.toFixed(3)},
      d.y
    );
    if (horizonFade > 0.001) {
      vec2 cp = (d.xz / d.y) * uCloudScale
              + vec2(uCloudTime, uCloudTime * 0.35);
      // 5 段のノイズは起動時にテクスチャへ焼いてある。全画素で計算し直さない。
      float n = texture2D(uCloudNoise, cp / ${CLOUD_PERIOD.toFixed(1)} + uCloudSeed).r;
      float thick = smoothstep(uCloudLow, uCloudHigh, n);
      // **縁は白（1.0）より明るく振る。** トーンマッピングは 0.8 付近を潰すので、
      // 白止まりだと明るい空に埋もれて雲が見えない（一度これで見えなかった）。
      // 逆に厚い芯は光が通らないので暗い。この明暗が雲の形を作る。
      float bright = mix(uCloudPeak, uCloudShade, thick);
      vec3 cloudCol = mix(vec3(bright), uHorizon * uCloudShade, thick * 0.55);
      // 太陽の側だけ縁が暖かく光る。
      cloudCol += uSunColor * pow(max(dot(d, uSunDir), 0.0), 5.0) * 0.32;
      col = mix(col, cloudCol, thick * horizonFade * uCloudAmount);
    }

    // 太陽の方向だけ地平が暖かくなる。
    float sd = max(dot(d, uSunDir), 0.0);
    col += uSunColor * pow(sd, 4.0) * 0.18 * (1.0 - t);
    col += uSunColor * pow(sd, 64.0) * 0.35;
    col += uSunColor * pow(sd, 2200.0) * 3.0;

    gl_FragColor = vec4(col, 1.0);

    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/** sRGB の 16 進を three の作業色空間へ。 */
function col(hex: number): THREE.Color {
  return new THREE.Color().setHex(hex, THREE.SRGBColorSpace);
}

export interface SkyPreset {
  zenith: number;
  horizon: number;
  ground: number;
  sun: number;
  /** 太陽の仰角（度）。低いほど面の向きによる明暗の差が開く。 */
  elevation: number;
  /** 太陽の方位（度）。 */
  azimuth: number;
  sunIntensity: number;
  ambientSky: number;
  ambientGround: number;
  ambientIntensity: number;
  fogDensity: number;
  /** 雲の濃さ 0..1。0 で快晴。 */
  cloudAmount: number;
  /** 雲が出始める / 濃くなる ノイズの値。差を詰めると輪郭が硬くなる。 */
  cloudLow: number;
  cloudHigh: number;
  /** 雲の細かさ。大きいほど小さい雲が沢山出る。 */
  cloudScale: number;
  /** 雲の縁の明るさ。1.0（白）を超えて振ること。下の解説を参照。 */
  cloudPeak: number;
  /** 雲の芯の暗さ。1.0 で暗くならない。 */
  cloudShade: number;
  /** 雲が流れる速さ。 */
  cloudDrift: number;
  /** この高さより上は霧が普通の濃さに戻る（m）。 */
  fogHeightTop: number;
  /** 海抜 0m での霧の増し方。1.0 なら濃さが 2 倍。 */
  fogHeightBoost: number;
}

/**
 * 朝もや。太陽を低くして面ごとの明暗を開き、低い土地に靄を溜める。
 *
 * 仰角を 34° から 13° に下げたぶん、平らな地面が受ける光は 1/2.5 になる。
 * sunIntensity を上げているのはそれを戻すため。結果として「平らな面は控えめ、
 * 太陽を向いた斜面は強く」となり、同じ地形でも起伏が読めるようになる。
 */
export const MORNING: SkyPreset = {
  // **空を白くしすぎないこと。** 以前は地平を 0xf2e4dc（ほぼ白）にしていて、
  // 実際に描かれる輝度が仰角 5〜64° で 0.87〜0.72 とほぼ白飛びの帯に入り、
  // ACES がその辺りを潰すので雲を足しても差が出なかった（差 0.007）。
  //
  // **地平の色は 3 か所で使い回されている** ── 空の地平・霧・水面の映り込み。
  // ここが白いと空も遠景も水も同時に濁る。逆にここを落とすと 3 つとも直る。
  //
  // 実際に描かれる色で測った値（輝度 / 青み。青みは 青−赤 で 0.15 以上なら青い空）:
  //   仰角  5°  0.67 / 0.26      35°  0.52 / 0.47
  //   仰角 17°  0.60 / 0.35      70°  0.41 / 0.63
  //   遠景（霧）0.73 / 0.16   ← 0.84 / 0.02 だったのを落とした
  zenith: 0x2a5fae,
  horizon: 0x86a3b8,
  ground: 0x8a9aa2,
  // 低い朝日。淡い金。
  sun: 0xffd9a8,
  elevation: 13,
  azimuth: 128,
  sunIntensity: 4.2,
  ambientSky: 0xa9c8e8,
  ambientGround: 0x6f6d58,
  // 環境光を下げて、太陽に仕事をさせる。下げすぎると朝の柔らかさが消える。
  ambientIntensity: 0.85,
  // 400m で約 14%、1200m で約 75% 霞む。以前は 400m で 5% しか霞まず、
  // 遠くの山が手前の丘と同じ濃さで描かれて奥行きが潰れていた。
  fogDensity: 0.00095,
  // 朝の薄い雲。空の半分ほどを覆うが、輪郭は柔らかく取る。
  // 濃くしすぎると光が沈んで、せっかくの低い朝日が効かなくなる。
  // 雲の有無を一点でも探す測り方では、ほぼ曇天でも「全面雲ではない」と誤判定する。
  // 200 世界 × 8 方向の画面占有率と最大連結領域を測り、scale / low を決めている。
  // 見える雲の占有率は平均 20%、p90 40%、p99 58%。連結領域の p99 は 56%。
  cloudAmount: 0.85,
  cloudLow: 0.54,
  cloudHigh: 0.82,
  cloudScale: 0.44,
  cloudDrift: 0.0022,
  cloudPeak: 2.3,
  cloudShade: 0.42,
  fogHeightTop: 32,
  fogHeightBoost: 1.1,
};

// ---------------------------------------------------------------------------
// 高さで濃くなる霧
//
// three の霧は距離だけで決まるので、低い土地に朝もやを溜められない。
// 霧の計算そのもの（ShaderChunk）を差し替えて、断片の「高さ」も見るようにする。
//
// 差し替えを 1 か所に集めているのは、地形・植生・水面がそれぞれ別のマテリアルで、
// 材質ごとに足すと 3 か所が独立に同じ判断をすることになるため。ここだけで決める。
//
// 触るときの注意:
//  - 濃さと高さは**シェーダに直接埋め込んでいる**。uniform にすると three が
//    霧の uniform を配る仕組み（scene.fog 由来の色と濃さだけ）に乗らず、
//    マテリアルによって値が届いたり届かなかったりする。
//  - 太陽の向きと朝日の色も埋め込む（霞が太陽の側で明るむ）。空の sunDirection と同じ式。
//  - 使えるのは `position` と `modelMatrix` だけ。水面は独自の頂点シェーダで
//    `transformed` を持たない。`instanceMatrix` は植生（InstancedMesh）にしか無い。
//  - FogExp2 前提で書いている（線形の Fog に変えると fogDensity が来ず落ちる）。
//    scene.fog をこのファイルで作っているので、対応関係はここで閉じている。
// ---------------------------------------------------------------------------
let heightFogInstalled = false;

/** 太陽の側の霞が、朝日の色へ寄る強さ（0..1）。 */
const SUN_HAZE_STRENGTH = 0.6;

function installHeightFog(preset: SkyPreset): void {
  if (heightFogInstalled) return;
  heightFogInstalled = true;
  // 霧の色は出力の色空間（sRGB）で混ぜるので、朝日の色も sRGB のまま埋め込む。
  const el = THREE.MathUtils.degToRad(preset.elevation);
  const az = THREE.MathUtils.degToRad(preset.azimuth);
  const f = (v: number) => v.toFixed(4);
  const sun = `vec3( ${f(Math.cos(el) * Math.sin(az))}, ${f(Math.sin(el))}, ${f(Math.cos(el) * Math.cos(az))} )`;
  const hex = preset.sun;
  const sunHaze = `vec3( ${f(((hex >> 16) & 255) / 255)}, ${f(((hex >> 8) & 255) / 255)}, ${f((hex & 255) / 255)} )`;

  THREE.ShaderChunk.fog_pars_vertex = /* glsl */ `
    #ifdef USE_FOG
      varying float vFogDepth;
      varying vec3 vFogWorld;
    #endif
  `;

  THREE.ShaderChunk.fog_vertex = /* glsl */ `
    #ifdef USE_FOG
      vFogDepth = - mvPosition.z;
      vec4 fogWorldPos = vec4( position, 1.0 );
      #ifdef USE_INSTANCING
        fogWorldPos = instanceMatrix * fogWorldPos;
      #endif
      vFogWorld = ( modelMatrix * fogWorldPos ).xyz;
    #endif
  `;

  THREE.ShaderChunk.fog_pars_fragment = /* glsl */ `
    #ifdef USE_FOG
      uniform vec3 fogColor;
      uniform float fogDensity;
      varying float vFogDepth;
      varying vec3 vFogWorld;
    #endif
  `;

  THREE.ShaderChunk.fog_fragment = /* glsl */ `
    #ifdef USE_FOG
      // 低い土地ほど霧が濃い。丘は靄の上に抜け、水際と低地に残る。
      float fogLow = 1.0 - smoothstep( 0.0, ${preset.fogHeightTop.toFixed(1)}, vFogWorld.y );
      float fogD = fogDensity * ( 1.0 + ${preset.fogHeightBoost.toFixed(2)} * fogLow );
      float fogFactor = 1.0 - exp( - fogD * fogD * vFogDepth * vFogDepth );
      // 太陽の方を向くほど、霞が朝日の色に明るむ（空気の粒が光を前へ散らすため）。
      // 背を向けた側は青い霞のまま。遠くの山が、太陽の側では金色に、反対側では青く溶ける。
      float fogSun = max( dot( normalize( vFogWorld - cameraPosition ), ${sun} ), 0.0 );
      vec3 fogTint = mix( fogColor, ${sunHaze}, pow( fogSun, 6.0 ) * ${SUN_HAZE_STRENGTH.toFixed(2)} );
      gl_FragColor.rgb = mix( gl_FragColor.rgb, fogTint, fogFactor );
    #endif
  `;
}

/**
 * 空・光・霧をまとめて管理する。
 * 空のドームはカメラに追従させるので、どこまで歩いても抜けない。
 */
export class Sky {
  readonly sunDirection = new THREE.Vector3();
  private mesh: THREE.Mesh;
  private material: THREE.ShaderMaterial;
  private sunLight: THREE.DirectionalLight;
  private ambient: THREE.HemisphereLight;
  private drift: number;

  constructor(scene: THREE.Scene, preset: SkyPreset = MORNING, cloudSeed = 0) {
    // マテリアルが 1 つも作られる前に済ませる。シェーダは最初の描画で組まれるので
    // ここで十分だが、霧を持つのはこのクラスなので置き場所もここに揃えている。
    installHeightFog(preset);

    this.drift = preset.cloudDrift;

    const el = THREE.MathUtils.degToRad(preset.elevation);
    const az = THREE.MathUtils.degToRad(preset.azimuth);
    this.sunDirection.set(
      Math.cos(el) * Math.sin(az),
      Math.sin(el),
      Math.cos(el) * Math.cos(az),
    );

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uZenith: { value: col(preset.zenith) },
        uHorizon: { value: col(preset.horizon) },
        uGround: { value: col(preset.ground) },
        uSunColor: { value: col(preset.sun) },
        uSunDir: { value: this.sunDirection.clone() },
        // 世界ごとにハッシュをずらす。大きな座標を足すと低精度 GPU で雲の動きが
        // 数秒おきの段階移動になるため、0..1 の小さい salt として渡す。
        uCloudSeed: { value: new THREE.Vector2(
          (cloudSeed & 0xffff) / 0xffff,
          ((cloudSeed >>> 16) & 0xffff) / 0xffff,
        ) },
        uCloudNoise: { value: createCloudTexture() },
        uCloudTime: { value: 0 },
        uCloudAmount: { value: preset.cloudAmount },
        uCloudLow: { value: preset.cloudLow },
        uCloudHigh: { value: preset.cloudHigh },
        uCloudScale: { value: preset.cloudScale },
        uCloudPeak: { value: preset.cloudPeak },
        uCloudShade: { value: preset.cloudShade },
      },
      vertexShader: vert,
      fragmentShader: frag,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });

    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), this.material);
    this.mesh.scale.setScalar(6000);
    this.mesh.frustumCulled = false;
    // 最初に描いて、あとから地形で上書きさせる。
    this.mesh.renderOrder = RENDER_ORDER.sky;
    scene.add(this.mesh);

    this.sunLight = new THREE.DirectionalLight(col(preset.sun), preset.sunIntensity);
    this.sunLight.position.copy(this.sunDirection).multiplyScalar(500);
    scene.add(this.sunLight);
    scene.add(this.sunLight.target);

    this.ambient = new THREE.HemisphereLight(
      col(preset.ambientSky),
      col(preset.ambientGround),
      preset.ambientIntensity,
    );
    scene.add(this.ambient);

    // 霧の色は地平線と揃える。遠景が空に溶けて奥行きが出る。
    scene.fog = new THREE.FogExp2(col(preset.horizon), preset.fogDensity);
  }

  /** 空ドームと日光をカメラに追従させ、雲を流す。 */
  update(camera: THREE.Camera, elapsed = 0): void {
    this.material.uniforms.uCloudTime.value = elapsed * this.drift;
    this.mesh.position.copy(camera.position);
    this.sunLight.target.position.copy(camera.position);
    this.sunLight.position.copy(camera.position).addScaledVector(this.sunDirection, 500);
  }

}
