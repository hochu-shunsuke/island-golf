import * as THREE from 'three';
import type { Hole } from '../golf/course';
import { KIND_NAMES, holeArea } from '../golf/course';
import type { Area } from '../render/chunkManager';

/**
 * 開始画面の後ろで流すコース紹介の空撮。
 * 谷全体を遠くから見せてから、1 番から順に 1 ホール 1 カット: ティーの後ろの空から、ゆっくり前へ進みながらグリーンを見る。
 * カットの間は暗転でつなぐ（ホールからホールへ飛び回らない）。最後のホールの後は、また谷全体へ戻って繰り返す。
 *
 * どのカットも「位置と注視点をまっすぐ動かすだけ」。地面に潜らない高さは作るときに通り道を測って決め、
 * 毎フレームは地面を見ない（起伏でカメラが上下に揺れないように）。
 *
 * カットごとに読み込む範囲（area）を持つ。暗転しきった所で次のカットへ移り、その範囲のチャンクが揃うまで
 * 暗いまま待つ（loaded）。映している間は何も差し替わらないので、木や山が目の前で現れたり粗さが替わったりしない。
 */

interface Shot {
  from: THREE.Vector3;
  to: THREE.Vector3;
  lookFrom: THREE.Vector3;
  lookTo: THREE.Vector3;
  /** 秒。 */
  duration: number;
  /** 字幕に出すホール（谷全体のカットは null）。 */
  hole: Hole | null;
  /** 映している間に読み込んでおく範囲。谷全体は遠くから見るので読み込まない（島全体の 1 枚で足りる）。 */
  area: Area | 'none';
}

/** 暗転から明けるまで・暗転するまでの秒数。 */
const FADE = 1.1;
/** 通り道の下の地面から、最低これだけ離す（木の上を通る）。 */
const CLEARANCE = 30;
/** 読み込みを待つ上限（秒）。揃わなくてもこれを過ぎたら映す。 */
const MAX_WAIT = 5;

export class Flyover {
  private readonly shots: Shot[] = [];
  private index = 0;
  private t = 0;
  /** カットの頭で、読み込みを待っている間の秒数（-1 なら待っていない）。 */
  private waiting = 0;
  private readonly pos = new THREE.Vector3();
  private readonly look = new THREE.Vector3();

  constructor(
    holes: readonly Hole[],
    private readonly ground: (x: number, z: number) => number,
    /** 動きを減らす設定の人には、カメラを動かさず止め絵を順に見せる。 */
    private readonly still = false,
  ) {
    // 谷全体: コースの真ん中を、南の高い所から横へゆっくり流して見る。
    let cx = 0;
    let cz = 0;
    for (const h of holes) {
      cx += h.tee.x + h.pin.x;
      cz += h.tee.z + h.pin.z;
    }
    cx /= holes.length * 2;
    cz /= holes.length * 2;
    const center = new THREE.Vector3(cx, ground(cx, cz), cz);
    this.add({
      from: new THREE.Vector3(cx - 260, center.y + 480, cz + 900),
      to: new THREE.Vector3(cx + 180, center.y + 440, cz + 820),
      lookFrom: center.clone(),
      lookTo: center.clone(),
      duration: 12,
      hole: null,
      area: 'none',
    });

    holes.forEach((h, k) => {
      const dx = h.pin.x - h.tee.x;
      const dz = h.pin.z - h.tee.z;
      const len = Math.hypot(dx, dz) || 1;
      const fx = dx / len;
      const fz = dz / len;
      // 少しだけ横にずらす（ホールごとに左右を入れ替え、同じ絵が続かないように）。
      const side = (k % 2 === 0 ? 1 : -1) * 14;
      const rx = -fz * side;
      const rz = fx * side;
      // 長いホールほど高くから（パー 3 で 45m 前後、パー 5 で 65m 前後）。
      const up = 36 + Math.min(h.length, 520) * 0.055;
      const at = (back: number, lift: number) =>
        new THREE.Vector3(h.tee.x - fx * back + rx, h.tee.h + lift, h.tee.z - fz * back + rz);
      const pin = new THREE.Vector3(h.pin.x, ground(h.pin.x, h.pin.z), h.pin.z);
      const mid = new THREE.Vector3((h.aim.x + h.pin.x) / 2, 0, (h.aim.z + h.pin.z) / 2);
      mid.y = ground(mid.x, mid.z);
      this.add({
        from: at(70, up + 6),
        to: at(-25, up),
        lookFrom: mid,
        lookTo: pin,
        duration: h.par === 3 ? 8 : 9.5,
        hole: h,
        area: holeArea(h),
      });
    });
  }

  /** カットを足す。通り道を測って、どこでも地面から CLEARANCE 以上離れるよう全体を持ち上げる。 */
  private add(s: Shot): void {
    if (this.still) {
      s.from.copy(s.to);
      s.lookFrom.copy(s.lookTo);
    }
    let lift = 0;
    const p = new THREE.Vector3();
    for (let i = 0; i <= 24; i++) {
      p.lerpVectors(s.from, s.to, i / 24);
      lift = Math.max(lift, this.ground(p.x, p.z) + CLEARANCE - p.y);
    }
    s.from.y += lift;
    s.to.y += lift;
    this.shots.push(s);
  }

  private get shot(): Shot {
    return this.shots[this.index];
  }

  /** 字幕（今のホール）。谷全体のカットの間は null。 */
  get caption(): string | null {
    const h = this.shot.hole;
    return h ? `${h.number} 番 ${KIND_NAMES[h.kind]} · パー ${h.par} · ${Math.round(h.length)} m` : null;
  }

  /** 今のカットで読み込んでおく範囲。 */
  get area(): Area | 'none' {
    return this.shot.area;
  }

  /** 暗転の濃さ（0 = 明るい、1 = 真っ暗）。カットの始めと終わりだけ暗い。読み込みを待つ間は真っ暗。 */
  get fade(): number {
    if (this.waiting >= 0) return 1;
    const d = this.shot.duration;
    const a = Math.min(this.t, d - this.t) / FADE;
    return 1 - smooth(Math.max(0, Math.min(1, a)));
  }

  /** 最初（谷全体・暗転から）に戻す。休憩から開始画面へ戻ったとき用。 */
  restart(): void {
    this.index = 0;
    this.t = 0;
    this.waiting = 0;
  }

  /**
   * loaded は今のカットの範囲（area）のチャンクが揃ったか。呼ぶ側は、この前に area を読み込み側へ渡しておく。
   * カットの頭では、揃うまで（最長 MAX_WAIT 秒）暗いまま止まる。
   */
  update(dt: number, camera: THREE.PerspectiveCamera, loaded: boolean): void {
    if (this.waiting >= 0) {
      this.waiting += dt;
      if (loaded || this.waiting > MAX_WAIT) this.waiting = -1;
    } else {
      this.t += dt;
      if (this.t >= this.shot.duration) {
        // 暗転しきった。次のカットへ移り、その範囲が揃うのを待つ。
        this.t = 0;
        this.index = (this.index + 1) % this.shots.length;
        this.waiting = 0;
      }
    }
    const s = this.shot;
    // ほぼ一定の速さで、始めと終わりだけ少しなめらかに（暗転の中で加減速する）。
    const u = this.t / s.duration;
    const e = u * 0.8 + smooth(u) * 0.2;
    this.pos.lerpVectors(s.from, s.to, e);
    this.look.lerpVectors(s.lookFrom, s.lookTo, e);
    camera.position.copy(this.pos);
    camera.lookAt(this.look);
  }
}

function smooth(u: number): number {
  return u * u * (3 - 2 * u);
}
