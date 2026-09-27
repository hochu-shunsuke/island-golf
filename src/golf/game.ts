import * as THREE from 'three';
import { SEA_LEVEL } from '../world/terrain';
import type { Terrain } from '../world/terrain';
import { BALL_RADIUS, Ball, type GolfGround, SURFACE_FEEL, type Surface } from './ball';
import { CLUBS, type Club, DRIVER, PUTTER } from './clubs';
import { type Hole, holeIntro } from './course';

/**
 * コースを回る。**落とし所の輪を置いて狙い、正確さの針を 1 回止めて打つ**。
 *
 * 他のゴルフゲームを調べて決めた打ち方（2026-09-26）:
 * - 狙い: 落とし所（パットは止めたい所）の輪を地面の上で動かす（Golf Clash と同じ）。輪までの距離から、
 *   クラブを選び（自分で替えてもよい）、輪に落ちる力を試し打ちで求める。距離をゲージで合わせない
 * - 打つ: 押すと針が左右に振れ始め、もう一度押して止める。真ん中なら狙いどおり、ずれるほど左右に曲がり
 *   距離も少し狂う（みんゴルのインパクト、マリオゴルフの 2 本目のゲージ）。ラフ・バンカーでは針が速い
 * 以前は力のメーターが往復し、どこで止めると何 m 飛ぶか分からず、「操作性が悪い」と言われた。
 *
 * カップに入れば次のホールのティーへ。最後のホールの後は 1 番へ戻り、通算の打数を数え直す。
 * 入力は main.ts から呼ぶ（キー・マウス・タッチを同じ関数に集める）。表示は onStatus で main へ渡す。
 */

export type GolfPhase = 'aim' | 'swing' | 'moving' | 'holed';

/** 1 ホールの記録（ラウンドの終わりに出す。実際のゴルフのスコアカードと同じ 3 つ）。 */
export interface HoleStats {
  /** パットの数。 */
  putts: number;
  /** ティーショットがフェアウェイ（かグリーン）に残ったか。パー 3 は数えない（null）。 */
  fairway: boolean | null;
  /** パーオン: パー − 2 打以内でグリーンに乗せた（入れた）か。 */
  gir: boolean;
}

export interface GolfStatus {
  /** 回っているホール。 */
  target: Hole;
  holeCount: number;
  strokes: number;
  /** 回り終えたホールの打数の合計と、そのパーの合計。 */
  total: number;
  totalPar: number;
  club: Club;
  /** 狙い（輪）までの距離と、今のクラブ・ライで届く一番遠い距離（m）。 */
  aimDistance: number;
  reach: number;
  /** ピンまでの水平距離（m）。 */
  toPin: number;
  lie: Surface;
  phase: GolfPhase;
  /** 正確さの針 -1..1（swing のとき）。 */
  needle: number;
  /** 狙い（輪）の高さから球の高さを引いたもの（m。正なら打ち上げ）。 */
  elevation: number;
  /** 風の強さ（m/s）と、狙う向きから見た風の向き（ラジアン。0 = 追い風、π = 向かい風、正 = 右へ流れる）。 */
  windSpeed: number;
  windAngle: number;
  /** ホールごとの打数（回り終えた所だけ）。 */
  scores: readonly (number | undefined)[];
  /** カップに入った後に進む先（最後のホールの後は 1 番）。 */
  next: Hole;
}

/** 音を鳴らすための知らせ（audio/golfSounds.ts）。 */
export type GolfSoundEvent =
  | { type: 'ready' }
  | { type: 'hit'; kind: 'wood' | 'iron' | 'wedge' | 'putter'; strength: number; perfect: boolean }
  | { type: 'land'; surface: Surface; speed: number }
  | { type: 'splash' }
  | { type: 'cup' }
  | { type: 'cheer'; big: boolean };

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

/** パーとの差（+2・-1・±0）。 */
export function toPar(strokes: number, par: number): string {
  const d = strokes - par;
  return d === 0 ? '±0' : d > 0 ? `+${d}` : `${d}`;
}

/** ホールの紹介（上空からの眺め）の長さと、そこから打つ構えへ降りてくる時間（s）。 */
const INTRO_TIME = 3.4;
const INTRO_OUT = 1.4;
/** カップの半径（m）。本物は 54mm。遊びやすいよう大きめ。 */
const CUP_RADIUS = 0.22;
/** 狙いを回す速さ（rad/s）と、輪を前後に動かす速さ（距離に対する割合 /s、キー）。 */
const AIM_KEY_SPEED = 0.7;
const DIST_KEY_SPEED = 0.55;
/** 正確さの針: 1 秒に振れる回数（片道）。ライが悪いほど速い。パットはゆっくり。 */
const NEEDLE_SPEED: Record<Surface, number> = {
  green: 0.8,
  fairway: 0.95,
  rough: 1.35,
  sand: 1.7,
  rock: 1.4,
  snow: 1.5,
};
const PUTT_NEEDLE_SPEED = 0.7;
/** 真ん中とみなす幅（ナイスショット）。 */
const PERFECT = 0.12;
/** ライごとの飛びやすさ（初速に掛ける）。 */
const LIE_POWER: Record<Surface, number> = {
  green: 1,
  fairway: 1,
  rough: 0.84,
  sand: 0.62,
  rock: 0.9,
  snow: 0.72,
};
/** 狙いの試し打ちの刻み（s）。粗くして軽く。 */
const PREVIEW_STEP = 1 / 60;
/** 狙いを動かしている間に、試し打ちをやり直す間隔（s）。 */
const SOLVE_EVERY = 0.09;

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export class GolfGame {
  readonly group = new THREE.Group();
  /** 打つための目印（軌道の予告・落とし所の輪・軌跡・傾きの矢印）。開始画面の空撮では隠す。旗と球は残す。 */
  readonly aids = new THREE.Group();
  readonly ball: Ball;
  phase: GolfPhase = 'aim';
  strokes = 0;
  clubIndex = 0;
  /** クラブを自分で選んだか（選んだら、輪を動かしてもクラブを替えない）。 */
  private clubLocked = false;
  /** 落とし所（パットは止めたい所）。 */
  readonly aimPoint = { x: 0, z: 0 };
  /** 狙いの向き（ラジアン、-z が 0）。aimPoint から決まる。 */
  aimYaw = 0;
  /** 輪に落とすための力 0..1（試し打ちで求める）。 */
  power = 1;
  /** 左右・前後のキーを押している向き（-1..1）。 */
  aimInput = 0;
  distInput = 0;
  needle = -1;
  /** 回っているホール。 */
  target: Hole;
  /** 回り終えたホールの打数（番号 - 1 の位置）。1 番のティーに立つと数え直す。 */
  private readonly scores: number[] = [];
  /** ホールごとの記録（番号 - 1 の位置）。打数と同じく 1 番で数え直す。 */
  private readonly stats: HoleStats[] = [];
  /** 打った一打のでき（真ん中で捉えた・左へ曲がった・右へ曲がった）。画面の真ん中に大きく出す。 */
  onShotFeedback: ((kind: 'nice' | 'hook' | 'slice') => void) | null = null;
  /** カップに入ったとき（お祝い・スコアカード・自己ベストのため）。last は最後のホールか。 */
  onHoled: ((hole: Hole, strokes: number, total: number, totalPar: number, last: boolean) => void) | null = null;

  private readonly ballMesh: THREE.Mesh;
  private readonly arc: THREE.Line;
  private readonly roll: THREE.Line;
  private readonly landing: THREE.Mesh;
  private readonly trail: THREE.Line;
  /** カップインの紙吹雪。 */
  private confetti: { points: THREE.Points; vel: Float32Array; age: number } | null = null;
  /** パットのときの傾斜の矢印（下る向き・長さと色が急さ）。 */
  private readonly slopes: THREE.LineSegments;
  private slopesFor = '';
  private readonly trailPoints: THREE.Vector3[] = [];
  private needleTime = 0;
  /** 打つ前の球の位置（池に入ったらここへ戻す）。 */
  private readonly lastSpot = { x: 0, z: 0 };
  private restTimer = 0;
  private readonly camPos = new THREE.Vector3();
  private readonly camLook = new THREE.Vector3();
  private cameraReady = false;
  private solveDirty = true;
  private solveWait = 0;
  /** ホールに立った直後、上空からホール全体を見せる残り時間（s）。 */
  private intro = 0;
  private readonly golfGround: GolfGround;
  /** クラブごとの、平らな地面での力とキャリーの表（試し打ちの最初の見当に使う）。 */
  private readonly carryTables = new Map<number, { p: number; carry: number }[]>();

  constructor(
    terrain: Terrain,
    /** コースのホール（1 つ以上）。 */
    readonly course: readonly Hole[],
    private readonly onStatus: (s: GolfStatus) => void,
    private readonly onMessage: (text: string) => void,
    /** 球が当たる木（render/chunkManager.ts が知っている）。 */
    trees: GolfGround['trees'] = undefined,
    /** 音（audio/golfSounds.ts）。 */
    private readonly onSound: (e: GolfSoundEvent) => void = () => {},
  ) {
    this.golfGround = {
      height: (x, z) => terrain.heightOnGrid(x, z, 2),
      water: (x, z) => Math.max(SEA_LEVEL, terrain.waterLevelAt(x, z)),
      surface: (x, z) => terrain.surfaceKind(x, z),
      trees,
    };
    this.ball = new Ball(this.golfGround);
    this.ball.onEvent = (e) => {
      if (e.type === 'land') this.onSound({ type: 'land', surface: e.surface, speed: e.speed });
      else if (e.type === 'water') this.onSound({ type: 'splash' });
      else this.onSound({ type: 'cup' });
    };
    this.target = course[0];

    this.ballMesh = new THREE.Mesh(
      new THREE.SphereGeometry(BALL_RADIUS, 16, 12),
      new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x333333 }),
    );
    this.group.add(this.ballMesh);
    for (const h of course) this.group.add(buildPin(h, this.golfGround));

    // 狙いの線は地面に沿わせる（弧のままだと、後ろから見て空へ伸びる 1 本の縦線に見えた）。
    this.arc = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 2.2, gapSize: 1.4, transparent: true, opacity: 0.9 }),
    );
    this.roll = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineDashedMaterial({ color: 0xfff3b0, dashSize: 0.8, gapSize: 0.6, transparent: true, opacity: 0.9 }),
    );
    this.landing = new THREE.Mesh(
      new THREE.RingGeometry(1.5, 2.1, 40).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -4,
      }),
    );
    // 打った球の軌跡。次に打つまで残す（どう飛んだかを見返して、次の狙いに生かす）。
    this.trail = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0xffe98a, transparent: true, opacity: 0.85 }),
    );
    this.slopes = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9 }),
    );
    this.slopes.visible = false;
    this.aids.add(this.arc, this.roll, this.landing, this.trail, this.slopes);
    this.group.add(this.aids);
    this.teeOff(course[0]);
  }

  get club(): Club {
    return CLUBS[this.clubIndex];
  }

  get putting(): boolean {
    return this.clubIndex === PUTTER;
  }

  /** 旗の上の位置（画面に目印を出すため）。 */
  pinTop(h: Hole, out: THREE.Vector3): THREE.Vector3 {
    return out.set(h.pin.x, this.golfGround.height(h.pin.x, h.pin.z) + 3.2, h.pin.z);
  }

  /** 落とし所の輪の上（距離の目印を出すため）。 */
  aimTop(out: THREE.Vector3): THREE.Vector3 {
    return out.set(this.aimPoint.x, this.golfGround.height(this.aimPoint.x, this.aimPoint.z) + 1.2, this.aimPoint.z);
  }

  /** ホールのティーから打ち始める。1 番からなら通算を数え直す。 */
  teeOff(hole: Hole): void {
    if (hole.number === 1) {
      this.scores.length = 0;
      this.stats.length = 0;
    }
    this.stats[hole.number - 1] = { putts: 0, fairway: hole.par >= 4 ? false : null, gir: false };
    this.target = hole;
    this.ball.cup = { x: hole.pin.x, z: hole.pin.z, r: CUP_RADIUS };
    this.ball.wind = hole.wind;
    this.trailPoints.length = 0;
    setLine(this.trail, []);
    this.strokes = 0;
    this.ball.place(hole.tee.x, hole.tee.z);
    this.ball.lie = 'fairway';
    this.intro = INTRO_TIME;
    this.readyToAim();
  }

  /** このラウンドの打数（番号 - 1 の位置、回っていないホールは空き）。 */
  get roundScores(): readonly (number | undefined)[] {
    return this.scores;
  }

  /** このラウンドのホールごとの記録。 */
  get roundStats(): readonly (HoleStats | undefined)[] {
    return this.stats;
  }

  /** 球が止まった（入った）ときに、フェアウェイキープとパーオンを付ける。 */
  private noteRest(holed: boolean): void {
    const s = this.stats[this.target.number - 1];
    if (!s) return;
    const lie = this.ball.lie;
    if (this.strokes === 1 && s.fairway !== null) s.fairway = holed || lie === 'fairway' || lie === 'green';
    if ((holed || lie === 'green') && this.strokes <= this.target.par - 2) s.gir = true;
  }

  /** カップに入った後に、次のホールのティーへ。 */
  next(): void {
    this.teeOff(this.nextHole());
    this.onMessage(holeIntro(this.target));
  }

  private nextHole(): Hole {
    const k = this.course.indexOf(this.target);
    return this.course[(k + 1) % this.course.length];
  }

  // ── 狙う ─────────────────────────────────────────────

  /** 今のライで、クラブ c が届く一番遠いキャリー（m）。パターは転がる距離。 */
  private reachOf(c: number): number {
    if (c === PUTTER) return 40;
    return CLUBS[c].carry * LIE_POWER[this.ball.lie];
  }

  /** ドライバーはティーからだけ。パターはグリーンとその周り（フェアウェイ）だけ。 */
  private allowed(c: number): boolean {
    if (c === DRIVER) return this.strokes === 0;
    if (c === PUTTER) return this.ball.lie === 'green' || this.ball.lie === 'fairway';
    return true;
  }

  /** 距離 d に合うクラブ: 届くクラブのうち一番短いもの（力いっぱいに近い、きれいな弧で打てる）。 */
  private clubFor(d: number): number {
    let pick = -1;
    for (let c = 0; c < PUTTER; c++) {
      if (!this.allowed(c)) continue;
      if (this.reachOf(c) >= d) pick = c;
    }
    if (pick >= 0) return pick;
    // どれも届かなければ、使える一番長いクラブ。
    for (let c = 0; c < PUTTER; c++) if (this.allowed(c)) return c;
    return PUTTER - 1;
  }

  /** 狙い（輪）までの距離（m）。 */
  get aimDistance(): number {
    return Math.hypot(this.aimPoint.x - this.ball.pos.x, this.aimPoint.z - this.ball.pos.z);
  }

  /** 狙いを、向き yaw・距離 d に置く（クラブの届く所まで）。 */
  private setAim(yaw: number, d: number): void {
    const min = this.putting ? 0.5 : 5;
    const dist = Math.max(min, Math.min(d, this.reachOf(this.clubIndex)));
    this.aimYaw = yaw;
    this.aimPoint.x = this.ball.pos.x - Math.sin(yaw) * dist;
    this.aimPoint.z = this.ball.pos.z - Math.cos(yaw) * dist;
    this.solveDirty = true;
  }

  /**
   * 次の一打の準備。グリーンの上はパターでカップへ。ティーからは設計した落とし所へ、
   * それ以外はピンへ（届かなければピンの方へ届く所まで）。クラブは距離で選ぶ。
   */
  private readyToAim(): void {
    this.phase = 'aim';
    this.needle = -1;
    this.clubLocked = false;
    const b = this.ball.pos;
    const pin = this.target.pin;
    const toPin = Math.hypot(pin.x - b.x, pin.z - b.z);
    const yawTo = (p: { x: number; z: number }) => Math.atan2(-(p.x - b.x), -(p.z - b.z));
    if (this.ball.lie === 'green' || (this.ball.lie === 'fairway' && toPin < 6)) {
      this.clubIndex = PUTTER;
      this.setAim(yawTo(pin), toPin);
    } else {
      const aim = this.strokes === 0 ? this.target.aim : pin;
      const d = Math.hypot(aim.x - b.x, aim.z - b.z);
      this.clubIndex = this.clubFor(d);
      this.setAim(yawTo(aim), d);
    }
    this.arc.visible = true;
    this.roll.visible = true;
    this.landing.visible = true;
    this.emit();
  }

  /** 狙いを回す（球を中心に）。 */
  rotateAim(delta: number): void {
    if (this.phase !== 'aim') return;
    this.intro = Math.min(this.intro, INTRO_OUT);
    this.setAim(this.aimYaw + delta, this.aimDistance);
  }

  /** 輪を前後に動かす（m）。クラブを自分で選んでいなければ、距離に合うクラブへ替える。 */
  pushAim(delta: number): void {
    if (this.phase !== 'aim') return;
    this.intro = Math.min(this.intro, INTRO_OUT);
    const d = Math.max(0, this.aimDistance + delta);
    if (!this.clubLocked && !this.putting) this.clubIndex = this.clubFor(d);
    this.setAim(this.aimYaw, d);
    this.emit();
  }

  /** クラブを替える（自分で選んだら、輪を動かしても替えない）。 */
  changeClub(step: number): void {
    if (this.phase !== 'aim') return;
    let c = this.clubIndex;
    for (let k = 0; k < CLUBS.length; k++) {
      c = (c + step + CLUBS.length) % CLUBS.length;
      if (this.allowed(c)) break;
    }
    this.clubIndex = c;
    this.clubLocked = true;
    // 替えたクラブの届く所へ（パターはカップへ）。
    const pin = this.target.pin;
    if (c === PUTTER) {
      this.setAim(this.aimYaw, Math.hypot(pin.x - this.ball.pos.x, pin.z - this.ball.pos.z));
    } else {
      this.setAim(this.aimYaw, Math.min(this.aimDistance, this.reachOf(c)));
    }
    this.emit();
  }

  // ── 打つ ─────────────────────────────────────────────

  /** 打つ操作を押した: 狙っていれば針を振り始め、振れていれば止めて打つ。 */
  press(): void {
    if (this.phase === 'aim') {
      if (this.solveDirty) this.solve();
      this.intro = 0;
      this.phase = 'swing';
      this.needleTime = 0;
      this.needle = -1;
      this.onSound({ type: 'ready' });
      this.emit();
    } else if (this.phase === 'swing') {
      this.hit();
    }
  }

  /** 構えをやめて、狙いに戻る（針が振れている間に Esc など）。 */
  cancelSwing(): void {
    if (this.phase !== 'swing') return;
    this.phase = 'aim';
    this.needle = -1;
    this.emit();
  }

  /** 針を止めた所で打つ。真ん中ならナイスショット。ずれるほど曲がり、少し短くなる。 */
  private hit(): void {
    const club = this.club;
    let e = this.needle;
    const perfect = Math.abs(e) < PERFECT;
    if (perfect) e = 0;
    const putt = this.putting;
    this.lastSpot.x = this.ball.pos.x;
    this.lastSpot.z = this.ball.pos.z;
    const yaw = this.aimYaw + ((e * (putt ? 0.8 : 2) * Math.PI) / 180) * -1;
    const power = this.power * (1 - Math.abs(e) * (putt ? 0.05 : 0.07));
    const lieLoss = putt ? 1 : LIE_POWER[this.ball.lie];
    this.ball.hit(yaw, club.loft, club.speed * power * lieLoss, club.spin, club.bite, putt ? 0 : e * 0.55);
    const c = this.clubIndex;
    this.onSound({
      type: 'hit',
      kind: putt ? 'putter' : c <= 1 ? 'wood' : c <= 4 ? 'iron' : 'wedge',
      strength: power * lieLoss,
      perfect: perfect && !putt,
    });
    setLine(this.trail, []);
    this.strokes++;
    if (putt) {
      const st = this.stats[this.target.number - 1];
      if (st) st.putts++;
    }
    this.phase = 'moving';
    this.restTimer = 0;
    this.trailPoints.length = 0;
    this.arc.visible = false;
    this.roll.visible = false;
    this.landing.visible = false;
    this.slopes.visible = false;
    if (!putt) {
      if (perfect) this.onShotFeedback?.('nice');
      else if (e > 0.45) this.onShotFeedback?.('slice');
      else if (e < -0.45) this.onShotFeedback?.('hook');
    }
    this.emit();
  }

  update(dt: number): void {
    this.intro = Math.max(0, this.intro - dt);
    this.updateConfetti(dt);
    if (this.phase === 'aim') {
      if (this.aimInput !== 0) this.rotateAim(this.aimInput * AIM_KEY_SPEED * dt);
      if (this.distInput !== 0) this.pushAim(this.distInput * Math.max(3, this.aimDistance * DIST_KEY_SPEED) * dt);
      this.solveWait -= dt;
      if (this.solveDirty && this.solveWait <= 0) {
        this.solve();
        this.solveWait = SOLVE_EVERY;
      }
    }
    if (this.phase === 'swing') {
      this.needleTime += dt;
      const f = this.putting ? PUTT_NEEDLE_SPEED : NEEDLE_SPEED[this.ball.lie];
      // 左端から右へ、右端から左へ、を繰り返す（三角波）。
      const t = (this.needleTime * f) % 2;
      this.needle = -1 + 2 * (t < 1 ? t : 2 - t);
      this.emit();
    }
    if (this.phase === 'moving') this.updateMoving(dt);
    // カップに入った球は穴の中へ沈める。
    const sink = this.phase === 'holed' ? BALL_RADIUS * 1.6 : 0;
    this.ballMesh.position.set(this.ball.pos.x, this.ball.pos.y - sink, this.ball.pos.z);
  }

  private updateMoving(dt: number): void {
    this.ball.update(dt);
    const p = this.ball.pos;
    const last = this.trailPoints[this.trailPoints.length - 1];
    if (!last || Math.hypot(last.x - p.x, last.y - p.y, last.z - p.z) > 2) {
      this.trailPoints.push(new THREE.Vector3(p.x, p.y, p.z));
      if (this.trailPoints.length > 400) this.trailPoints.shift();
      setLine(this.trail, this.trailPoints);
    }
    const h = this.target;
    if (this.ball.state === 'holed') {
      this.phase = 'holed';
      this.scores[h.number - 1] = this.strokes;
      this.noteRest(true);
      const under = this.strokes < h.par || this.strokes === 1;
      this.celebrate(this.strokes === 1 || this.strokes <= h.par - 2 ? 260 : under ? 140 : 50);
      if (under) this.onSound({ type: 'cheer', big: this.strokes === 1 || this.strokes <= h.par - 2 });
      // 打数と通算は、画面の真ん中のスコアカード（ラウンドの終わりは結果の窓）が出す。
      const { total, totalPar } = this.totals();
      const last = h.number === this.course.length;
      this.onHoled?.(h, this.strokes, total, totalPar, last);
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
      if (this.restTimer > 0.7) {
        this.noteRest(false);
        this.readyToAim();
      }
    }
    this.emit();
  }

  /** カップの上に紙吹雪。いいスコアほど多く。 */
  private celebrate(count: number): void {
    if (this.confetti) {
      this.group.remove(this.confetti.points);
      this.confetti.points.geometry.dispose();
    }
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    const vel = new Float32Array(count * 3);
    const color = new THREE.Color();
    const base = this.golfGround.height(this.target.pin.x, this.target.pin.z);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = this.target.pin.x;
      pos[i * 3 + 1] = base + 0.2;
      pos[i * 3 + 2] = this.target.pin.z;
      const a = Math.random() * Math.PI * 2;
      const r = 1 + Math.random() * 3;
      vel[i * 3] = Math.cos(a) * r;
      vel[i * 3 + 1] = 4 + Math.random() * 5;
      vel[i * 3 + 2] = Math.sin(a) * r;
      color.setHSL(Math.random(), 0.85, 0.6);
      col[i * 3] = color.r;
      col[i * 3 + 1] = color.g;
      col[i * 3 + 2] = color.b;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const points = new THREE.Points(
      geo,
      new THREE.PointsMaterial({ size: 0.16, vertexColors: true, transparent: true, opacity: 1, depthWrite: false }),
    );
    this.group.add(points);
    this.confetti = { points, vel, age: 0 };
  }

  private updateConfetti(dt: number): void {
    const c = this.confetti;
    if (!c) return;
    c.age += dt;
    const pos = c.points.geometry.getAttribute('position') as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    for (let i = 0; i < arr.length; i += 3) {
      c.vel[i + 1] -= 6 * dt;
      // 空気の抵抗でふわっと落ちる。
      const k = Math.exp(-1.6 * dt);
      c.vel[i] *= k;
      c.vel[i + 2] *= k;
      c.vel[i + 1] = Math.max(c.vel[i + 1] * k, -1.8);
      arr[i] += c.vel[i] * dt;
      arr[i + 1] += c.vel[i + 1] * dt;
      arr[i + 2] += c.vel[i + 2] * dt;
    }
    pos.needsUpdate = true;
    (c.points.material as THREE.PointsMaterial).opacity = Math.max(0, 1 - Math.max(0, c.age - 2) / 1.2);
    if (c.age > 3.3) {
      this.group.remove(c.points);
      c.points.geometry.dispose();
      this.confetti = null;
    }
  }

  private totals(): { total: number; totalPar: number } {
    let total = 0;
    let totalPar = 0;
    this.course.forEach((h, k) => {
      if (this.scores[k] === undefined) return;
      total += this.scores[k];
      totalPar += h.par;
    });
    return { total, totalPar };
  }

  // ── 試し打ち（輪に落ちる力と、狙いの線） ───────────────────

  /** 平らな地面での力とキャリーの表（クラブごとに 1 度だけ作る）。 */
  private carryTable(c: number): { p: number; carry: number }[] {
    let table = this.carryTables.get(c);
    if (table) return table;
    table = [];
    const flat: GolfGround = { height: () => 0, water: () => -Infinity, surface: () => 'fairway' };
    const club = CLUBS[c];
    for (let p = 0.15; p <= 1.001; p += 0.05) {
      const sim = new Ball(flat, PREVIEW_STEP);
      sim.place(0, 0);
      sim.hit(0, club.loft, club.speed * p, club.spin, club.bite);
      for (let t = 0; t < 12 && sim.state === 'flight'; t += PREVIEW_STEP) sim.update(PREVIEW_STEP);
      table.push({ p, carry: -sim.pos.z });
    }
    this.carryTables.set(c, table);
    return table;
  }

  /** 表から、平らな地面でキャリー d になる力。 */
  private powerFor(c: number, d: number): number {
    const table = this.carryTable(c);
    if (d <= table[0].carry) return table[0].p * Math.max(0.3, d / Math.max(1, table[0].carry));
    for (let k = 0; k < table.length - 1; k++) {
      const a = table[k];
      const b = table[k + 1];
      if (d <= b.carry) return a.p + ((b.p - a.p) * (d - a.carry)) / (b.carry - a.carry || 1);
    }
    return 1;
  }

  /** 今の力で試し打ちする。落ちる所（最初に地面に触れた所）と、線の点。 */
  private simulate(power: number): { land: THREE.Vector3 | null; arc: THREE.Vector3[]; roll: THREE.Vector3[] } {
    const club = this.club;
    const sim = new Ball(this.golfGround, PREVIEW_STEP);
    sim.place(this.ball.pos.x, this.ball.pos.z);
    sim.lie = this.ball.lie;
    // 狙いの線と輪は「風が無ければ落ちる所」（Golf Clash と同じ）。風の分は風のメーターを見て、輪をずらして読む。
    // 以前は線だけ風で曲げていて、輪と線の落ちる所が食い違って見えた。
    const lieLoss = this.putting ? 1 : LIE_POWER[this.ball.lie];
    sim.hit(this.aimYaw, club.loft, club.speed * power * lieLoss, club.spin, club.bite);
    const arc: THREE.Vector3[] = [new THREE.Vector3(sim.pos.x, sim.pos.y + 0.05, sim.pos.z)];
    const roll: THREE.Vector3[] = [];
    let land: THREE.Vector3 | null = null;
    for (let t = 0; t < 14; t += PREVIEW_STEP) {
      sim.update(PREVIEW_STEP);
      const p = new THREE.Vector3(sim.pos.x, sim.pos.y + 0.05, sim.pos.z);
      const ground = this.golfGround.height(sim.pos.x, sim.pos.z);
      if (!land && club.loft > 0 && sim.pos.y - ground < BALL_RADIUS + 0.05) {
        land = p.clone();
        roll.push(p);
      } else if (land || club.loft === 0) {
        roll.push(p);
      } else {
        // 飛んでいる間は、真下の地面の上に点を置く。
        arc.push(new THREE.Vector3(p.x, ground + 0.15, p.z));
      }
      if (sim.state === 'rest' || sim.state === 'water') break;
    }
    if (!land) land = club.loft === 0 ? null : arc[arc.length - 1];
    return { land, arc, roll };
  }

  /**
   * 輪に落ちる力を求め、狙いの線（弧と、落ちた後の転がり）を引き直す。
   * 平らな地面の表で見当をつけ、試し打ちで打ち上げ・打ち下ろしの分を 2 回まで直す。
   * パットは「輪で止まる」強さ（平らなら）。傾きは矢印を読んで、輪をずらして合わせる。
   */
  private solve(): void {
    this.solveDirty = false;
    const d = this.aimDistance;
    const club = this.club;
    let power: number;
    let result: ReturnType<GolfGame['simulate']>;
    if (this.putting) {
      const a = SURFACE_FEEL[this.ball.lie].roll * 9.81;
      power = Math.min(1, Math.sqrt(2 * a * d) / club.speed);
      result = this.simulate(power);
      // パットは転がる線の最初だけ見せる（全部見せると読む楽しさが無くなる）。
      result.roll = result.roll.slice(0, Math.max(2, Math.floor(result.roll.length * 0.35)));
    } else {
      const lieLoss = LIE_POWER[this.ball.lie];
      power = Math.min(1, this.powerFor(this.clubIndex, d / lieLoss));
      result = this.simulate(power);
      // 打ち上げ・打ち下ろしの分を、輪に落ちるまで直す（落ちる所と輪を 1m 以内に）。
      for (let k = 0; k < 5 && result.land; k++) {
        const got = Math.hypot(result.land.x - this.ball.pos.x, result.land.z - this.ball.pos.z);
        if (Math.abs(got - d) < 0.8 || got < 1) break;
        const next = Math.max(0.1, Math.min(1, power * Math.pow(d / got, 0.7)));
        if (Math.abs(next - power) < 1e-3) break;
        power = next;
        result = this.simulate(power);
      }
    }
    this.power = power;
    setLine(this.arc, result.arc);
    this.arc.computeLineDistances();
    setLine(this.roll, result.roll);
    this.roll.computeLineDistances();
    // 輪は狙った所に置く（本当に落ちる所は弧の先で見える）。パットは止めたい所。
    this.landing.position.set(this.aimPoint.x, this.golfGround.height(this.aimPoint.x, this.aimPoint.z) + 0.1, this.aimPoint.z);
    this.updateSlopes();
  }

  /**
   * パットのときだけ、球とピンの周りの傾斜を矢印で見せる（下る向き、長さと色が急さ）。
   * 起伏のあるグリーンは、傾きが読めて初めて面白くなる（マリオゴルフの曲がりの表示、みんゴルの傾斜の格子）。
   * 球とピンの位置が変わったときだけ作り直す。
   */
  private updateSlopes(): void {
    const putting = this.putting;
    this.slopes.visible = putting;
    if (!putting) return;
    const b = this.ball.pos;
    const pin = this.target.pin;
    const key = `${b.x.toFixed(2)},${b.z.toFixed(2)},${pin.x},${pin.z}`;
    if (key === this.slopesFor) return;
    this.slopesFor = key;
    const cx = (b.x + pin.x) / 2;
    const cz = (b.z + pin.z) / 2;
    const reach = Math.min(22, Math.hypot(pin.x - b.x, pin.z - b.z) / 2 + 5);
    const step = 1.25;
    const e = 0.4;
    const pos: number[] = [];
    const col: number[] = [];
    const color = new THREE.Color();
    const h = (x: number, z: number) => this.golfGround.height(x, z);
    for (let z = cz - reach; z <= cz + reach; z += step) {
      for (let x = cx - reach; x <= cx + reach; x += step) {
        if (Math.hypot(x - cx, z - cz) > reach) continue;
        const gx = (h(x + e, z) - h(x - e, z)) / (2 * e);
        const gz = (h(x, z + e) - h(x, z - e)) / (2 * e);
        const slope = Math.hypot(gx, gz);
        if (slope < 0.004) continue;
        // 下る向き。長さは急さ（1% で 0.25m、5% 以上で 0.8m）。
        const dx = -gx / slope;
        const dz = -gz / slope;
        const len = Math.min(0.8, 0.12 + slope * 14);
        const y0 = h(x, z) + 0.05;
        const tx = x + dx * len;
        const tz = z + dz * len;
        const y1 = h(tx, tz) + 0.05;
        // 白（ほぼ平ら）→ 水色 → 黄 → 赤（5% 以上）。
        const t = Math.min(1, slope / 0.05);
        color.setHSL(0.55 - t * 0.55, t < 0.15 ? 0.1 : 0.85, t < 0.15 ? 0.95 : 0.6);
        const push = (ax: number, ay: number, az: number, bx: number, by: number, bz: number) => {
          pos.push(ax, ay, az, bx, by, bz);
          col.push(color.r, color.g, color.b, color.r, color.g, color.b);
        };
        push(x, y0, z, tx, y1, tz);
        const hx = -dz * 0.12;
        const hz = dx * 0.12;
        push(tx, y1, tz, tx - dx * 0.2 + hx, y1, tz - dz * 0.2 + hz);
        push(tx, y1, tz, tx - dx * 0.2 - hx, y1, tz - dz * 0.2 - hz);
      }
    }
    this.slopes.geometry.dispose();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    this.slopes.geometry = geo;
  }

  // ── カメラ ───────────────────────────────────────────

  /**
   * カメラ。狙う間は、球の後ろの高い所から輪の方を見る（遠くを狙うほど高く引く。落とし所とグリーンが
   * 見えるように）。パットは低く。動いている間は球を追う。
   */
  updateCamera(camera: THREE.PerspectiveCamera, dt: number): void {
    const p = this.ball.pos;
    const pos = new THREE.Vector3();
    const look = new THREE.Vector3();
    if (this.phase === 'moving' || this.phase === 'holed') {
      const v = this.ball.vel;
      const hs = Math.hypot(v.x, v.z);
      const dx = hs > 0.5 ? v.x / hs : -Math.sin(this.aimYaw);
      const dz = hs > 0.5 ? v.z / hs : -Math.cos(this.aimYaw);
      const putt = this.putting;
      const back = putt ? 4 : 18;
      pos.set(p.x - dx * back, p.y + (putt ? 2 : 8), p.z - dz * back);
      look.set(p.x, p.y, p.z);
    } else {
      const dx = -Math.sin(this.aimYaw);
      const dz = -Math.cos(this.aimYaw);
      const d = this.aimDistance;
      if (this.putting) {
        pos.set(p.x - dx * 4.2, p.y + 2.3, p.z - dz * 4.2);
        const ahead = Math.min(d, 8);
        look.set(p.x + dx * ahead, p.y - 0.3, p.z + dz * ahead);
      } else {
        const back = 7 + d * 0.1;
        const up = 3 + d * 0.13;
        pos.set(p.x - dx * back, p.y + up, p.z - dz * back);
        const lx = p.x + dx * d * 0.72;
        const lz = p.z + dz * d * 0.72;
        look.set(lx, this.golfGround.height(lx, lz), lz);
      }
    }
    // カメラが地面に埋まらないように。
    pos.y = Math.max(pos.y, this.golfGround.height(pos.x, pos.z) + 1.2);
    // ホールに立った直後は、上空の後ろからホール全体を見せ、打つ構えのカメラへ降りてくる。
    if (this.intro > 0) {
      const { tee, aim, pin } = this.target;
      const lx = (aim.x + pin.x) / 2;
      const lz = (aim.z + pin.z) / 2;
      const dx = lx - tee.x;
      const dz = lz - tee.z;
      const dd = Math.hypot(dx, dz) || 1;
      const high = this.target.par === 3 ? 38 : 60;
      const air = new THREE.Vector3(tee.x - (dx / dd) * high, tee.h + high, tee.z - (dz / dd) * high);
      const airLook = new THREE.Vector3(lx, this.golfGround.height(lx, lz), lz);
      const a = smoothstep(0, INTRO_OUT, this.intro);
      pos.lerp(air, a);
      look.lerp(airLook, a);
      this.camPos.copy(pos);
      this.camLook.copy(look);
      this.cameraReady = true;
    }
    if (!this.cameraReady) {
      this.camPos.copy(pos);
      this.camLook.copy(look);
      this.cameraReady = true;
    }
    const k = 1 - Math.exp(-(this.phase === 'moving' ? 3.5 : 5) * dt);
    this.camPos.lerp(pos, k);
    this.camLook.lerp(look, k);
    camera.position.copy(this.camPos);
    camera.lookAt(this.camLook);
    // 落とし所の輪は、遠くても見える大きさに（カメラからの距離に比例させる）。
    if (this.landing.visible) {
      const d = camera.position.distanceTo(this.landing.position);
      this.landing.scale.setScalar((this.putting ? 0.2 : 1) * Math.max(0.4, d / 60));
    }
  }

  /** 空から戻ってきたとき、カメラを飛ばさずに置き直す。 */
  resetCamera(): void {
    this.cameraReady = false;
  }

  /** 画面の表示を送り直す。 */
  emit(): void {
    const { total, totalPar } = this.totals();
    const w = this.ball.wind;
    const windSpeed = Math.hypot(w.x, w.z);
    // 狙う向き（-sin, -cos）から見た風の向き。
    const fx = -Math.sin(this.aimYaw);
    const fz = -Math.cos(this.aimYaw);
    const along = w.x * fx + w.z * fz;
    const across = w.x * -fz + w.z * fx;
    this.onStatus({
      target: this.target,
      holeCount: this.course.length,
      strokes: this.strokes,
      total,
      totalPar,
      club: this.club,
      aimDistance: this.aimDistance,
      reach: this.reachOf(this.clubIndex),
      toPin: Math.hypot(this.target.pin.x - this.ball.pos.x, this.target.pin.z - this.ball.pos.z),
      lie: this.ball.lie,
      phase: this.phase,
      needle: this.needle,
      elevation:
        this.golfGround.height(this.aimPoint.x, this.aimPoint.z) - this.golfGround.height(this.ball.pos.x, this.ball.pos.z),
      windSpeed,
      windAngle: Math.atan2(across, along),
      scores: this.scores,
      next: this.nextHole(),
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
  // 旗は風下へなびく（旗を見て風を読む）。
  if (Math.hypot(hole.wind.x, hole.wind.z) > 0.3) flag.rotation.y = Math.atan2(-hole.wind.z, hole.wind.x);
  const cup = new THREE.Mesh(
    new THREE.CircleGeometry(CUP_RADIUS, 24).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x0d0f0c, polygonOffset: true, polygonOffsetFactor: -2 }),
  );
  cup.position.y = 0.02;
  g.add(pole, flag, cup);
  g.position.set(hole.pin.x, y, hole.pin.z);
  return g;
}
