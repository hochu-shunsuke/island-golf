import * as THREE from 'three';
import { RENDER_ORDER } from '../render/order';

/**
 * 風の筋。カメラの前に白く透ける細い線が、風の向きへふわっと流れて消える（ゼルダ BotW の風の表現と同じ考え）。
 * 右上の風の札（数字と矢印）だけでは、狙う景色の中で風が感じられなかった。
 * 強い風ほど本数が多く、速く、長い。無風では出ない。全部で 1 枚のメッシュ（1 回の描画）。
 */
const MAX = 10;
/** 1 本の線の点の数。 */
const POINTS = 18;
/** これ以上カメラが地面から離れていたら出さない（空から見ているとき）。 */
const MAX_CAMERA_HEIGHT = 40;

interface Streak {
  /** 生まれてからの秒数。負なら、まだ生まれていない（待ち）。 */
  age: number;
  life: number;
  x: number;
  y: number;
  z: number;
  /** 線の長さ（m）と流れる速さ（m/s）。 */
  length: number;
  speed: number;
  /** ゆらぎの位相と大きさ。 */
  phase: number;
  sway: number;
}

export class WindStreaks {
  readonly mesh: THREE.Mesh;
  private readonly streaks: Streak[] = [];
  private readonly position: Float32Array;
  private readonly color: Float32Array;
  private readonly geometry = new THREE.BufferGeometry();
  private readonly tmp = { a: new THREE.Vector3(), b: new THREE.Vector3(), t: new THREE.Vector3(), s: new THREE.Vector3() };

  constructor() {
    this.position = new Float32Array(MAX * POINTS * 2 * 3);
    this.color = new Float32Array(MAX * POINTS * 2 * 4);
    const index: number[] = [];
    for (let k = 0; k < MAX; k++) {
      for (let i = 0; i < POINTS - 1; i++) {
        const v = (k * POINTS + i) * 2;
        index.push(v, v + 1, v + 2, v + 1, v + 3, v + 2);
      }
    }
    this.geometry.setIndex(index);
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.position, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(this.color, 4).setUsage(THREE.DynamicDrawUsage));
    this.mesh = new THREE.Mesh(
      this.geometry,
      new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide }),
    );
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = RENDER_ORDER.wind;
    for (let k = 0; k < MAX; k++) this.streaks.push({ age: -Math.random() * 3, life: 2, x: 0, y: 0, z: 0, length: 4, speed: 5, phase: 0, sway: 0.3 });
  }

  /**
   * 1 コマ進める。wind は風（m/s、球の物理と同じ向き）。height は地面の高さ。show が false なら新しい筋を出さない
   * （出ている筋は流れきるまで残す）。
   */
  update(
    dt: number,
    camera: THREE.Camera,
    wind: { x: number; z: number },
    height: (x: number, z: number) => number,
    show: boolean,
  ): void {
    const speed = Math.hypot(wind.x, wind.z);
    const cam = camera.position;
    const high = cam.y - height(cam.x, cam.z) > MAX_CAMERA_HEIGHT;
    // 風が強いほど本数が多い（1m/s で 2 本、6m/s 以上で全部）。
    const active = show && !high && speed > 0.3 ? Math.round(Math.min(MAX, 1 + (speed / 6) * (MAX - 1))) : 0;
    const dx = speed > 0 ? wind.x / speed : 0;
    const dz = speed > 0 ? wind.z / speed : 0;
    const fwd = camera.getWorldDirection(this.tmp.t);
    const fx = fwd.x;
    const fz = fwd.z;
    const fl = Math.hypot(fx, fz) || 1;
    let drawn = 0;
    for (let k = 0; k < MAX; k++) {
      const s = this.streaks[k];
      s.age += dt;
      if (s.age >= s.life) {
        // 流れきった: 待ってから、カメラの前のどこかに生まれ直す。
        if (k >= active) {
          s.age = -0.5;
        } else {
          this.spawn(s, cam, fx / fl, fz / fl, height, speed);
        }
      }
      if (s.age < 0) {
        this.hide(k);
        continue;
      }
      this.write(k, s, dx, dz, cam);
      drawn++;
    }
    this.mesh.visible = drawn > 0;
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.color.needsUpdate = true;
  }

  private spawn(
    s: Streak,
    cam: THREE.Vector3,
    fx: number,
    fz: number,
    height: (x: number, z: number) => number,
    speed: number,
  ): void {
    // カメラの前 8〜34m、左右は見えている幅の中、地面から 1.5〜6m。
    const d = 8 + Math.random() * 26;
    const side = (Math.random() * 2 - 1) * d * 0.6;
    const x = cam.x + fx * d - fz * side;
    const z = cam.z + fz * d + fx * side;
    s.x = x;
    s.z = z;
    s.y = height(x, z) + 1.5 + Math.random() * 4.5;
    s.age = 0;
    s.life = 2.2 + Math.random() * 1;
    s.speed = 3 + speed * 1.1;
    s.length = 5 + speed * 0.8;
    s.phase = Math.random() * Math.PI * 2;
    s.sway = 0.15 + Math.random() * 0.2;
  }

  /** 流れた道のり u（m）での、筋の上の点。風の向きに進み、横と上下にふわっと揺れる。 */
  private at(s: Streak, u: number, dx: number, dz: number, out: THREE.Vector3): THREE.Vector3 {
    // 波長を長くして、1 本の中では緩い弧 1 つほどに（短い波長ではうねうねしすぎた）。
    const w = u * 0.18 + s.phase;
    const lateral = Math.sin(w) * s.sway;
    const lift = Math.sin(w * 0.7 + 1.3) * s.sway * 0.6 + u * 0.03;
    return out.set(s.x + dx * u - dz * lateral, s.y + lift, s.z + dz * u + dx * lateral);
  }

  private write(k: number, s: Streak, dx: number, dz: number, cam: THREE.Vector3): void {
    const { a, b, t, s: side } = this.tmp;
    // 頭は流れ続け、尾は少し遅れてついてくる。終わりに近づくと尾が追いつき、細く短くなって消える。
    const head = s.speed * s.age;
    const end = s.age / s.life;
    const tail = Math.max(0, head - s.length * (1 - smooth(Math.max(0, (end - 0.55) / 0.45))));
    // 全体の濃さ: ふわっと出て、ふわっと消える。
    const fade = Math.min(1, s.age / 0.35) * Math.min(1, (s.life - s.age) / 0.6);
    for (let i = 0; i < POINTS; i++) {
      const f = i / (POINTS - 1);
      const u = tail + (head - tail) * f;
      this.at(s, u, dx, dz, a);
      this.at(s, u + 0.05, dx, dz, b);
      t.subVectors(b, a).normalize();
      side.subVectors(cam, a).cross(t).normalize();
      // 両端を細く（真ん中が一番太い）、遠いほど少し太く（遠くでも見えるように）。
      const taper = Math.sin(Math.PI * f);
      const dist = a.distanceTo(cam);
      const width = (0.045 + dist * 0.0022) * Math.pow(taper, 0.6);
      const v = (k * POINTS + i) * 2;
      this.position[v * 3] = a.x + side.x * width;
      this.position[v * 3 + 1] = a.y + side.y * width;
      this.position[v * 3 + 2] = a.z + side.z * width;
      this.position[v * 3 + 3] = a.x - side.x * width;
      this.position[v * 3 + 4] = a.y - side.y * width;
      this.position[v * 3 + 5] = a.z - side.z * width;
      // 尾は透け、頭のほうが濃い。向かい風でカメラのすぐ前まで来た所は消す（画面の下に太く横切らないように）。
      const alpha = 0.5 * fade * taper * (0.35 + 0.65 * f) * smooth((dist - 4) / 5);
      for (const j of [v, v + 1]) {
        this.color[j * 4] = 1;
        this.color[j * 4 + 1] = 1;
        this.color[j * 4 + 2] = 1;
        this.color[j * 4 + 3] = alpha;
      }
    }
  }

  private hide(k: number): void {
    for (let i = 0; i < POINTS * 2; i++) this.color[((k * POINTS) * 2 + i) * 4 + 3] = 0;
  }
}

function smooth(x: number): number {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
}
