import * as THREE from 'three';
import type { RestInfo, RoomView, ShotInfo } from '../../shared/room';
import type { Point3 } from './aim';
import { BALL_RADIUS, BALL_STEP, Ball, type GolfGround, type Surface, rollSpeed } from './ball';
import type { Hole } from './course';
import type { OpponentState, Opponents } from './opponents';
import { TrailFade, addTrailPoint, setTrailLine } from './trail';

/**
 * 友達（同じ部屋の人）。それぞれ自分の画面で自分の球を打ち、打った一打（ShotInfo）と止まった所（RestInfo）が
 * 部屋から届く（net/room.ts）。ここでは、届いた一打を同じ物理でもう一度飛ばして見せ、止まった所の知らせで
 * 本人の画面の結果に合わせる（画面の速さで少しずれても、止まった所は本人と同じになる）。
 *
 * 全員が同じホールを同時に回る（部屋が、全員が入れたら次のホールへ進める）。自分がまだ前のホールの
 * スコアカードを見ている間に届いた、次のホールの一打と止まった所は覚えておき、そのホールのティーに立ったら出す。
 */

/** 友達の球の色（入った順。自分の白い球と見分けやすい色）。 */
const PEER_COLORS = [0xffcf3f, 0x5aa0ff, 0xff8a5c, 0x8fe3a0];

/** 部屋に入った順（slot）の色。部屋の窓の名前の前の点も同じ色。 */
export function peerColor(slot: number): number {
  return PEER_COLORS[slot % PEER_COLORS.length];
}
/** カップの半径（game.ts と同じ）。 */
const CUP_RADIUS = 0.22;

class Peer {
  readonly ball: Ball;
  readonly mesh: THREE.Mesh;
  readonly trail: THREE.Line;
  readonly trailFade: TrailFade;
  private readonly trailPoints: Point3[] = [];
  name = '';
  color: number;
  scores: (number | null)[] = [];
  /** 今のホールを終えたか（部屋の知らせ）。 */
  done = false;
  online = true;
  /** 今の回りに加わっているか（まだなら球を出さない）。 */
  playing = false;
  /** 今のホールの打数と、入れたか（止まった所の知らせ）。 */
  strokes = 0;
  holed = false;
  /** 飛ばしている間の固定刻みの余りと、飛び終わったら合わせる所。 */
  private acc = 0;
  private flying = false;
  /** 地面に着いてからの秒数（自分の球と同じく、長く転がると速く進める）。 */
  private groundTime: number | null = null;
  private pending: RestInfo | null = null;
  /** ホールごとの最後の止まった所（まだ自分がそのホールにいないときの分も覚えておく）。 */
  readonly lastRest = new Map<number, RestInfo>();

  constructor(
    readonly id: string,
    slot: number,
    ground: GolfGround,
  ) {
    this.color = peerColor(slot);
    this.ball = new Ball(ground);
    this.ball.onEvent = (e) => {
      if (e.type === 'land' && this.groundTime === null) this.groundTime = 0;
    };
    this.mesh = new THREE.Mesh(
      new THREE.SphereGeometry(BALL_RADIUS, 14, 10),
      new THREE.MeshLambertMaterial({ color: this.color, emissive: this.color, emissiveIntensity: 0.25 }),
    );
    const trailMaterial = new THREE.LineBasicMaterial({ color: this.color, transparent: true, opacity: 0.6 });
    this.trail = new THREE.Line(new THREE.BufferGeometry(), trailMaterial);
    this.trailFade = new TrailFade(this.trail, trailMaterial, 0.6);
  }

  /** ホールのティーに立たせる（もう打っていれば、最後に止まった所へ）。 */
  teeOff(hole: Hole, x: number, z: number): void {
    this.ball.cup = { x: hole.pin.x, z: hole.pin.z, r: CUP_RADIUS };
    this.ball.wind = hole.wind;
    this.flying = false;
    this.pending = null;
    this.trailPoints.length = 0;
    this.setTrail();
    const rest = this.lastRest.get(hole.number);
    if (rest) this.applyRest(rest);
    else {
      this.strokes = 0;
      this.holed = false;
      this.ball.place(x, z);
      this.ball.lie = 'fairway';
      this.mesh.visible = this.playing;
    }
    this.sync();
  }

  /** 届いた一打を飛ばす。 */
  shoot(shot: ShotInfo): void {
    this.ball.place(shot.x, shot.z);
    this.ball.lie = shot.lie as Surface;
    this.ball.hit(shot.yaw, shot.loft, shot.speed, shot.spin, shot.bite, shot.curve);
    this.flying = true;
    this.pending = null;
    this.acc = 0;
    this.groundTime = shot.loft > 0.5 ? null : 0;
    this.holed = false;
    this.mesh.visible = true;
    this.trailPoints.length = 0;
    this.trailPoints.push({ ...this.ball.pos });
    this.setTrail();
    this.trailFade.show();
  }

  /** 止まった所の知らせ。飛ばしている途中なら、飛び終わってから合わせる。 */
  rest(rest: RestInfo): void {
    if (this.flying) this.pending = rest;
    else this.applyRest(rest);
  }

  private applyRest(rest: RestInfo): void {
    this.flying = false;
    this.pending = null;
    this.ball.place(rest.x, rest.z);
    this.ball.pos.y = rest.y;
    this.ball.lie = rest.lie as Surface;
    this.strokes = rest.strokes;
    this.holed = rest.holed;
    this.mesh.visible = !rest.holed;
    this.sync();
  }

  /** 固定刻みで飛ばす（画面の速さに関係なく同じに飛ぶ）。飛び終わったら、本人の画面の結果に合わせる。 */
  advance(dt: number): boolean {
    if (!this.flying) return false;
    if (this.groundTime !== null) this.groundTime += dt;
    this.acc += Math.min(dt, 0.25) * rollSpeed(this.groundTime);
    while (this.acc >= BALL_STEP && (this.ball.state === 'flight' || this.ball.state === 'roll')) {
      this.ball.update(BALL_STEP);
      this.acc -= BALL_STEP;
    }
    if (addTrailPoint(this.trailPoints, this.ball.pos)) this.setTrail();
    this.sync();
    if (this.ball.state === 'flight' || this.ball.state === 'roll') return false;
    this.flying = false;
    this.trailFade.settle();
    if (this.pending) this.applyRest(this.pending);
    return true;
  }

  sync(): void {
    const p = this.ball.pos;
    this.mesh.position.set(p.x, p.y, p.z);
  }

  private setTrail(): void {
    setTrailLine(this.trail, this.trailPoints);
  }
}

export class Peers implements Opponents {
  readonly group = new THREE.Group();
  onChange: (() => void) | null = null;
  private readonly list = new Map<string, Peer>();
  private view: RoomView | null = null;
  /** 今自分がいるホール。 */
  private hole: Hole | null = null;

  constructor(private readonly ground: GolfGround) {}

  /** 部屋の様子が届いた（入った・抜けた・名前・打数・ホールが進んだ）。me は自分の番号。 */
  setRoom(view: RoomView, me: string): void {
    this.view = view;
    const seen = new Set<string>();
    for (const p of view.players) {
      if (p.id === me) continue;
      seen.add(p.id);
      let peer = this.list.get(p.id);
      if (!peer) {
        peer = new Peer(p.id, p.slot, this.ground);
        this.list.set(p.id, peer);
        this.group.add(peer.mesh, peer.trail);
        if (this.hole) peer.teeOff(this.hole, ...this.teeSpot(this.hole, p.slot));
      }
      peer.name = p.name;
      peer.scores = p.scores;
      peer.done = p.done;
      peer.online = p.online;
      // 途中から加わった: 今のホールのティーに立たせる。
      const joined = p.playing && !peer.playing;
      peer.playing = p.playing;
      if (joined && this.hole) peer.teeOff(this.hole, ...this.teeSpot(this.hole, p.slot));
    }
    for (const [id, peer] of this.list) {
      if (seen.has(id)) continue;
      this.group.remove(peer.mesh, peer.trail);
      this.list.delete(id);
    }
    this.onChange?.();
  }

  /** 友達が打った。自分がそのホールにいれば飛ばす。 */
  onShot(id: string, hole: number, shot: ShotInfo): void {
    const peer = this.list.get(id);
    if (!peer || !this.hole || hole !== this.hole.number) return;
    peer.shoot(shot);
  }

  /** 友達の球が止まった。どのホールの分も覚えておき、自分がそのホールにいれば合わせる。 */
  onRest(id: string, hole: number, rest: RestInfo): void {
    const peer = this.list.get(id);
    if (!peer) return;
    peer.lastRest.set(hole, rest);
    if (this.hole && hole === this.hole.number) peer.rest(rest);
    this.onChange?.();
  }

  /** ティーでの立ち位置（自分の左右に少しずつずらす。COM と同じ並べ方）。 */
  private teeSpot(hole: Hole, slot: number): [number, number] {
    const dx = hole.aim.x - hole.tee.x;
    const dz = hole.aim.z - hole.tee.z;
    const len = Math.hypot(dx, dz) || 1;
    const side = (slot % 2 === 0 ? 1 : -1) * (1.6 + Math.floor(slot / 2) * 1.6);
    return [hole.tee.x + (-dz / len) * side, hole.tee.z + (dx / len) * side];
  }

  teeOff(hole: Hole): void {
    this.hole = hole;
    for (const [id, peer] of this.list) {
      const slot = this.view?.players.find((p) => p.id === id)?.slot ?? 0;
      peer.teeOff(hole, ...this.teeSpot(hole, slot));
    }
    this.onChange?.();
  }

  /** 友達はそれぞれ自分で打つ。 */
  shoot(): void {}

  /** 部屋が進めるのを待つ（打ち切りは部屋がする）。 */
  finish(): void {}

  update(dt: number): void {
    let changed = false;
    for (const peer of this.list.values()) {
      peer.trailFade.update(dt);
      if (peer.advance(dt)) changed = true;
    }
    if (changed) this.onChange?.();
  }

  /** 部屋が次のホールへ進めたら（全員が入れた・待ち時間が過ぎた）、このホールは終わり。 */
  get settled(): boolean {
    const v = this.view;
    if (!v || !this.hole) return true;
    return v.phase === 'done' || v.hole > this.hole.number;
  }

  states(): OpponentState[] {
    return [...this.list.values()].map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      scores: p.scores,
      strokes: p.strokes,
      holed: p.holed || p.done,
      ball: p.holed || p.done || !p.online || !p.playing ? null : { ...p.ball.pos },
      away: !p.online,
      idle: !p.playing,
    }));
  }
}
