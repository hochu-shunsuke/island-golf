import * as THREE from 'three';
import { SEA_LEVEL } from '../world/terrain';
import type { Terrain } from '../world/terrain';
import { BALL_RADIUS, Ball, type GolfGround, type Surface } from './ball';
import { CLUBS } from './clubs';
import type { Hole } from './course';

/**
 * 1 ホールを回る。狙う → 力をためる → 飛ぶ・転がる → 止まる、を繰り返し、カップに入れば終わり。
 *
 * 入力は main.ts から呼ぶ（キー・マウス・タッチを同じ関数に集める）。画面の表示（打数・距離・力）は
 * onStatus で main へ渡す。球の物理は golf/ball.ts、ホールの形は golf/course.ts。
 */

export type GolfPhase = 'aim' | 'charge' | 'moving' | 'holed';

export interface GolfStatus {
  hole: Hole;
  strokes: number;
  club: string;
  /** ピンまでの水平距離（m）。 */
  toPin: number;
  lie: Surface;
  phase: GolfPhase;
  /** ためている力 0..1（charge のときだけ）。 */
  power: number;
}

/** 地面の種類の呼び名。 */
export const LIE_NAMES: Record<Surface, string> = {
  green: 'グリーン',
  fairway: 'フェアウェイ',
  rough: 'ラフ',
  sand: 'バンカー',
  rock: '岩',
  snow: '雪',
};

/** パーとの差の呼び名。 */
export function scoreName(strokes: number, par: number): string {
  if (strokes === 1) return 'ホールインワン';
  const d = strokes - par;
  if (d <= -3) return 'アルバトロス';
  if (d === -2) return 'イーグル';
  if (d === -1) return 'バーディ';
  if (d === 0) return 'パー';
  if (d === 1) return 'ボギー';
  if (d === 2) return 'ダブルボギー';
  return `+${d}`;
}

/** カップの半径（m）。本物は 54mm。遊びやすいよう大きめ。 */
const CUP_RADIUS = 0.22;
/** 力をためる周期（s）。0 → 1 → 0 と往復する。 */
const CHARGE_PERIOD = 2.2;
/** 狙いを回す速さ（rad/s、キー）。 */
const AIM_KEY_SPEED = 0.9;

export class GolfGame {
  readonly group = new THREE.Group();
  readonly ball: Ball;
  /** 旗の上の位置（画面にピンの目印を出すため）。 */
  readonly pinTop: THREE.Vector3;
  phase: GolfPhase = 'aim';
  strokes = 0;
  clubIndex = 0;
  /** 狙いの向き（ラジアン、-z が 0）。 */
  aimYaw = 0;
  power = 0;
  /** 左右キーを押している向き（-1..1）。 */
  aimInput = 0;

  private readonly ballMesh: THREE.Mesh;
  private readonly aimLine: THREE.Line;
  private readonly landing: THREE.Mesh;
  private readonly trail: THREE.Line;
  private readonly trailPoints: THREE.Vector3[] = [];
  private chargeTime = 0;
  /** 打つ前の球の位置（池に入ったらここへ戻す）。 */
  private readonly lastSpot = { x: 0, z: 0 };
  private restTimer = 0;
  private readonly camPos = new THREE.Vector3();
  private readonly camLook = new THREE.Vector3();
  private cameraReady = false;
  private previewDirty = true;
  private landingSize = 1;
  private readonly golfGround: GolfGround;

  constructor(
    terrain: Terrain,
    readonly hole: Hole,
    private readonly onStatus: (s: GolfStatus) => void,
    private readonly onMessage: (text: string) => void,
  ) {
    this.golfGround = {
      height: (x, z) => terrain.heightOnGrid(x, z, 2),
      water: (x, z) => Math.max(SEA_LEVEL, terrain.waterLevelAt(x, z)),
      surface: (x, z) => terrain.surfaceKind(x, z),
    };
    this.ball = new Ball(this.golfGround);
    this.pinTop = new THREE.Vector3(hole.pin.x, this.golfGround.height(hole.pin.x, hole.pin.z) + 3.2, hole.pin.z);

    this.ballMesh = new THREE.Mesh(
      new THREE.SphereGeometry(BALL_RADIUS, 16, 12),
      new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x333333 }),
    );
    this.group.add(this.ballMesh);
    this.group.add(buildPin(hole, this.golfGround), buildTee(hole, this.golfGround));

    this.aimLine = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 3, gapSize: 2, transparent: true, opacity: 0.9 }),
    );
    this.landing = new THREE.Mesh(
      new THREE.RingGeometry(1.6, 2.2, 32).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -4,
      }),
    );
    this.trail = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55 }),
    );
    this.group.add(this.aimLine, this.landing, this.trail);
    this.restart();
  }

  get club() {
    return CLUBS[this.clubIndex];
  }

  /** ティーからやり直す。 */
  restart(): void {
    this.strokes = 0;
    this.ball.place(this.hole.tee.x, this.hole.tee.z);
    this.ball.lie = 'fairway';
    this.readyToAim();
  }

  /** 次の一打の準備。ピンの方を向き、距離でクラブを選ぶ。 */
  private readyToAim(): void {
    this.phase = 'aim';
    this.power = 0;
    const dx = this.hole.pin.x - this.ball.pos.x;
    const dz = this.hole.pin.z - this.ball.pos.z;
    this.aimYaw = Math.atan2(-dx, -dz);
    this.clubIndex = pickClub(Math.hypot(dx, dz), this.ball.lie);
    this.trailPoints.length = 0;
    setLine(this.trail, []);
    this.previewDirty = true;
    this.emit();
  }

  rotateAim(delta: number): void {
    if (this.phase !== 'aim' && this.phase !== 'charge') return;
    this.aimYaw += delta;
    this.previewDirty = true;
  }

  changeClub(step: number): void {
    if (this.phase !== 'aim') return;
    this.clubIndex = (this.clubIndex + step + CLUBS.length) % CLUBS.length;
    this.previewDirty = true;
    this.emit();
  }

  startCharge(): void {
    if (this.phase !== 'aim') return;
    this.phase = 'charge';
    this.chargeTime = 0;
    this.power = 0;
  }

  release(): void {
    if (this.phase !== 'charge') return;
    const club = this.club;
    const power = Math.max(0.03, this.power);
    this.lastSpot.x = this.ball.pos.x;
    this.lastSpot.z = this.ball.pos.z;
    // ライ（ラフ・バンカー・雪）では球が飛ばない。パターはどこでもそのまま。
    const lieLoss = club.loft === 0 ? 1 : LIE_POWER[this.ball.lie];
    this.ball.hit(this.aimYaw, club.loft, club.speed * power * lieLoss, club.spin);
    this.strokes++;
    this.phase = 'moving';
    this.restTimer = 0;
    this.trailPoints.length = 0;
    this.aimLine.visible = false;
    this.landing.visible = false;
    this.emit();
  }

  update(dt: number): void {
    if (this.aimInput !== 0) this.rotateAim(this.aimInput * AIM_KEY_SPEED * dt);
    if (this.phase === 'charge') {
      this.chargeTime += dt;
      const t = (this.chargeTime / CHARGE_PERIOD) % 1;
      // 0 → 1 → 0。上の方ほどゆっくり動く（最大の近くで止めやすい）。
      this.power = Math.sin(t * Math.PI);
      this.emit();
    }
    if (this.phase === 'moving') this.updateMoving(dt);
    if ((this.phase === 'aim' || this.phase === 'charge') && this.previewDirty) this.updatePreview();
    // カップに入った球は穴の中へ沈める。
    const sink = this.phase === 'holed' ? BALL_RADIUS * 1.6 : 0;
    this.ballMesh.position.set(this.ball.pos.x, this.ball.pos.y - sink, this.ball.pos.z);
  }

  private updateMoving(dt: number): void {
    this.ball.update(dt);
    const p = this.ball.pos;
    if (this.trailPoints.length === 0 || this.trailPoints[this.trailPoints.length - 1].distanceToSquared(new THREE.Vector3(p.x, p.y, p.z)) > 4) {
      this.trailPoints.push(new THREE.Vector3(p.x, p.y, p.z));
      if (this.trailPoints.length > 400) this.trailPoints.shift();
      setLine(this.trail, this.trailPoints);
    }
    if (this.ball.checkCup(this.hole.pin.x, this.hole.pin.z, CUP_RADIUS)) {
      this.phase = 'holed';
      const name = scoreName(this.strokes, this.hole.par);
      this.onMessage(`カップイン！ ${this.strokes} 打（${name}）`);
      this.emit();
      return;
    }
    if (this.ball.state === 'water') {
      this.strokes++;
      this.onMessage('水に入りました。1 打罰で打ち直し。');
      this.ball.place(this.lastSpot.x, this.lastSpot.z);
      this.readyToAim();
      return;
    }
    if (this.ball.state === 'rest') {
      // 止まってから少し見せてから、次の一打へ。
      this.restTimer += dt;
      if (this.restTimer > 0.7) this.readyToAim();
    }
    this.emit();
  }

  /**
   * 狙いの線と、落ちる所の輪。今のクラブを最大の力で飛ばして確かめる。
   * 線は弧ではなく地面に沿わせる（後ろから見ると弧は縦の 1 本になり、向きが読めない）。
   */
  private updatePreview(): void {
    this.previewDirty = false;
    const club = this.club;
    const sim = new Ball(this.golfGround);
    sim.place(this.ball.pos.x, this.ball.pos.z);
    sim.lie = this.ball.lie;
    const lieLoss = club.loft === 0 ? 1 : LIE_POWER[this.ball.lie];
    sim.hit(this.aimYaw, club.loft, club.speed * lieLoss, club.spin);
    // 飛ぶクラブは最初に地面へ落ちる所まで、パターは止まる所まで。
    for (let t = 0; t < 12; t += 1 / 30) {
      const before = sim.state;
      sim.update(1 / 30);
      if (sim.state === 'rest' || sim.state === 'water') break;
      if (club.loft > 0 && before === 'flight' && sim.state !== 'flight') break;
    }
    const start = this.ball.pos;
    const end = sim.pos;
    const length = Math.hypot(end.x - start.x, end.z - start.z);
    const steps = Math.max(2, Math.ceil(length / 2));
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= steps; i++) {
      const x = start.x + ((end.x - start.x) * i) / steps;
      const z = start.z + ((end.z - start.z) * i) / steps;
      pts.push(new THREE.Vector3(x, this.golfGround.height(x, z) + 0.12, z));
    }
    setLine(this.aimLine, pts);
    this.aimLine.computeLineDistances();
    this.aimLine.visible = true;
    this.landing.position.set(end.x, this.golfGround.height(end.x, end.z) + 0.1, end.z);
    this.landingSize = club.loft === 0 ? 0.25 : 1;
    this.landing.visible = true;
  }

  /** カメラ。狙う間は球の後ろから打つ向きへ、動いている間は球を追う。 */
  updateCamera(camera: THREE.PerspectiveCamera, dt: number): void {
    const p = this.ball.pos;
    const pos = new THREE.Vector3();
    const look = new THREE.Vector3();
    if (this.phase === 'moving' || this.phase === 'holed') {
      const v = this.ball.vel;
      const hs = Math.hypot(v.x, v.z);
      const dx = hs > 0.5 ? v.x / hs : -Math.sin(this.aimYaw);
      const dz = hs > 0.5 ? v.z / hs : -Math.cos(this.aimYaw);
      const back = this.club.loft === 0 ? 4 : 16;
      pos.set(p.x - dx * back, p.y + (this.club.loft === 0 ? 2 : 7), p.z - dz * back);
      look.set(p.x, p.y, p.z);
    } else {
      const dx = -Math.sin(this.aimYaw);
      const dz = -Math.cos(this.aimYaw);
      const putt = this.club.loft === 0;
      const back = putt ? 3.2 : 6.5;
      pos.set(p.x - dx * back, p.y + (putt ? 1.3 : 2.4), p.z - dz * back);
      look.set(p.x + dx * (putt ? 6 : 30), p.y + (putt ? 0 : 2), p.z + dz * (putt ? 6 : 30));
    }
    // カメラが地面に埋まらないように。
    pos.y = Math.max(pos.y, this.golfGround.height(pos.x, pos.z) + 1.2);
    if (!this.cameraReady) {
      this.camPos.copy(pos);
      this.camLook.copy(look);
      this.cameraReady = true;
    }
    const k = 1 - Math.exp(-(this.phase === 'moving' ? 3.5 : 6) * dt);
    this.camPos.lerp(pos, k);
    this.camLook.lerp(look, k);
    camera.position.copy(this.camPos);
    camera.lookAt(this.camLook);
    // 落ちる所の輪は、遠くても見える大きさに（カメラからの距離に比例させる）。
    if (this.landing.visible) {
      const d = camera.position.distanceTo(this.landing.position);
      this.landing.scale.setScalar(this.landingSize * Math.max(0.5, d / 60));
    }
  }

  /** 空から戻ってきたとき、カメラを飛ばさずに置き直す。 */
  resetCamera(): void {
    this.cameraReady = false;
  }

  /** 画面の表示（打数・距離・力）を送り直す。 */
  emit(): void {
    this.onStatus({
      hole: this.hole,
      strokes: this.strokes,
      club: this.club.name,
      toPin: Math.hypot(this.hole.pin.x - this.ball.pos.x, this.hole.pin.z - this.ball.pos.z),
      lie: this.ball.lie,
      phase: this.phase,
      power: this.power,
    });
  }
}

/**
 * 線の点を差し替える。three の setFromPoints は既にある頂点の入れ物を大きさを変えずに使い回すので、
 * 点が減ると前の線の残りが描かれ、増えると入りきらない（最初に空で作った軌跡が描かれなかった）。
 */
function setLine(line: THREE.Line, points: THREE.Vector3[]): void {
  line.geometry.dispose();
  line.geometry = new THREE.BufferGeometry().setFromPoints(points);
}

/** ライごとの飛びやすさ（初速に掛ける）。 */
const LIE_POWER: Record<Surface, number> = {
  green: 1,
  fairway: 1,
  rough: 0.82,
  sand: 0.6,
  rock: 0.9,
  snow: 0.7,
};

/** 距離とライからクラブを選ぶ（平らな地面での合計の飛距離で）。 */
function pickClub(distance: number, lie: Surface): number {
  if (lie === 'green' || distance < 25) return CLUBS.length - 1;
  if (distance < 95) return 3;
  if (distance < 150) return 2;
  if (distance < 200 || lie !== 'fairway') return 1;
  return 0;
}

/** ピン: 白い旗竿と赤い旗、カップの黒い穴。 */
function buildPin(hole: Hole, ground: GolfGround): THREE.Group {
  const g = new THREE.Group();
  const y = ground.height(hole.pin.x, hole.pin.z);
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.035, 0.035, 2.6, 8).translate(0, 1.3, 0),
    new THREE.MeshLambertMaterial({ color: 0xf4f4f0 }),
  );
  const flag = new THREE.Mesh(
    new THREE.PlaneGeometry(0.9, 0.55).translate(0.45, 2.3, 0),
    new THREE.MeshLambertMaterial({ color: 0xd8323a, side: THREE.DoubleSide }),
  );
  const cup = new THREE.Mesh(
    new THREE.CircleGeometry(CUP_RADIUS, 24).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x0d0f0c, polygonOffset: true, polygonOffsetFactor: -2 }),
  );
  cup.position.y = 0.02;
  g.add(pole, flag, cup);
  g.position.set(hole.pin.x, y, hole.pin.z);
  return g;
}

/** ティーの目印: 打つ向きの左右に青い玉。 */
function buildTee(hole: Hole, ground: GolfGround): THREE.Group {
  const g = new THREE.Group();
  const dx = hole.pin.x - hole.tee.x;
  const dz = hole.pin.z - hole.tee.z;
  const d = Math.hypot(dx, dz) || 1;
  const sx = -dz / d;
  const sz = dx / d;
  for (const side of [-1, 1]) {
    const x = hole.tee.x + sx * 2.5 * side;
    const z = hole.tee.z + sz * 2.5 * side;
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(0.18, 12, 8),
      new THREE.MeshLambertMaterial({ color: 0x2f6fd8 }),
    );
    m.position.set(x, ground.height(x, z) + 0.18, z);
    g.add(m);
  }
  return g;
}
