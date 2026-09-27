import * as THREE from 'three';

/**
 * ラウンドの終わりのカメラ。最後のグリーンの周りを、ゆっくり回りながら高く引いていく（テレビ中継の締めの絵）。
 * 始めは今のカメラの位置から、6 秒かけて半径 60m・高さ 34m の輪へ移る。後は同じ高さで回り続ける。
 *
 * 地面に潜らないよう、真下の地面から 18m は離す。起伏で上下に揺れないよう、高さはなめらかに追う。
 * 読み込む範囲は最後のホールのまま替えない（回っても木や地形は差し替わらない）。
 */

/** 輪へ移るのにかける秒数。 */
const SETTLE = 6;
const RADIUS = 60;
const HEIGHT = 34;
/** 回る速さ（rad/s）。 */
const SPIN = 0.07;

export class FinaleCamera {
  private t = 0;
  private angle: number;
  private readonly r0: number;
  private readonly h0: number;
  private y: number;
  private readonly pos = new THREE.Vector3();

  constructor(
    private readonly pin: THREE.Vector3,
    /** 今のカメラの位置。null なら初めから輪の上にいる（休憩から戻ったとき）。 */
    from: THREE.Vector3 | null,
    private readonly ground: (x: number, z: number) => number,
    /** 動きを減らす設定の人には回さない（引くだけ）。 */
    private readonly still = false,
  ) {
    if (from) {
      this.angle = Math.atan2(from.z - pin.z, from.x - pin.x);
      this.r0 = Math.max(4, Math.hypot(from.x - pin.x, from.z - pin.z));
      this.h0 = from.y - pin.y;
      this.y = from.y;
    } else {
      this.angle = 0;
      this.r0 = RADIUS;
      this.h0 = HEIGHT;
      this.t = SETTLE;
      this.y = Math.max(pin.y + HEIGHT, ground(pin.x + RADIUS, pin.z) + 18);
    }
  }

  update(dt: number, camera: THREE.PerspectiveCamera): void {
    this.t += dt;
    const e = smooth(Math.min(1, this.t / SETTLE));
    if (!this.still) this.angle += SPIN * dt * Math.min(1, this.t / 2);
    const r = THREE.MathUtils.lerp(this.r0, RADIUS, e);
    const x = this.pin.x + Math.cos(this.angle) * r;
    const z = this.pin.z + Math.sin(this.angle) * r;
    const want = Math.max(this.pin.y + THREE.MathUtils.lerp(this.h0, HEIGHT, e), this.ground(x, z) + 18 * e);
    this.y += (want - this.y) * (1 - Math.exp(-2 * dt));
    this.pos.set(x, this.y, z);
    camera.position.copy(this.pos);
    camera.lookAt(this.pin.x, this.pin.y + 1.5, this.pin.z);
  }
}

function smooth(u: number): number {
  return u * u * (3 - 2 * u);
}
