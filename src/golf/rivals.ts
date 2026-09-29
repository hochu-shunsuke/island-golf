import * as THREE from 'three';
import { hashSeed, mulberry32 } from '../core/rng';
import { LIE_POWER, POWER_RANGE, type Point3, clubFor, hardPerfect, needleEffect, reachOf, solvePower, trial } from './aim';
import { BALL_RADIUS, BALL_STEP, Ball, type GolfGround, rollSpeed } from './ball';
import { CLUBS, PUTTER } from './clubs';
import type { Hole } from './course';
import type { OpponentState, Opponents } from './opponents';
import { TrailFade } from './trail';

/**
 * COM の相手。プレイヤーが打つたびに、全員が同時に 1 打ずつ打つ（Golf Clash と同じ。順番を待たない）。
 *
 * - 読み: プレイヤーと同じ試し打ち（aim.ts）で、風と傾きを読んで向きと強さを決める
 * - 腕前: 正確さの針のずれを乱数で足す（プレイヤーの針と同じ効き方）。ずれの大きさが強さの差
 * - 球: プレイヤーの球と同じ物理で、実際の時間で飛ぶ。刻みは固定（BALL_STEP）なので、画面の速さに関係なく、
 *   同じコース・同じ日なら毎回同じ結果になる（乱数も合言葉・日・ホール・打数から作る）
 * - 次の一打の読みは、プレイヤーが狙っている間に、1 コマ 6ms まで少しずつ済ませておく
 *   （1 打の読みは試し打ち数十回で 10〜60ms。まとめて読むと、打った瞬間や狙っている間に画面が止まる）
 * - プレイヤーが先にカップに入れたら、残りを同じく少しずつ読んで打ち切る（画面には出さない）。ダブルパーで打ち切り
 */

export interface RivalSpec {
  id: string;
  name: string;
  /** 強さの呼び名。 */
  level: string;
  color: number;
  /** 方向の針を止めるずれ（標準偏差、-1..1 の針に対して。プレイヤーの 2 回押しの 2 本目と同じ効き方）。 */
  spread: number;
  /** 距離の針を止めるずれ（標準偏差。プレイヤーの 2 回押しの 1 本目と同じ効き方）。 */
  distance: number;
  /** 風をどれだけ読めるか（0 = 無視、1 = 完全に）。 */
  windRead: number;
  /** パットの強さの狂い（割合の標準偏差）と、向きの狂い（度）。 */
  puttPower: number;
  puttYaw: number;
  /** パットの傾きを読む回数（向きと強さを試し打ちで直す回数。多いほど上りも下りも合う）。 */
  puttRead: number;
}

/** 3 人の相手。COM1 はやさしい、COM2 はふつう、COM3 はつよい。 */
export const RIVALS: readonly RivalSpec[] = [
  {
    id: 'com1',
    name: 'COM1',
    level: 'やさしい',
    color: 0xffcf3f,
    spread: 0.2,
    distance: 0.2,
    windRead: 0.25,
    puttPower: 0.25,
    puttYaw: 5,
    puttRead: 1,
  },
  {
    id: 'com2',
    name: 'COM2',
    level: 'ふつう',
    color: 0xe8eef2,
    spread: 0.13,
    distance: 0.13,
    windRead: 0.5,
    puttPower: 0.2,
    puttYaw: 3.8,
    puttRead: 2,
  },
  {
    id: 'com3',
    name: 'COM3',
    level: 'つよい',
    color: 0x3f63b8,
    spread: 0.08,
    distance: 0.08,
    windRead: 0.75,
    puttPower: 0.15,
    puttYaw: 2.8,
    puttRead: 2,
  },
];

/** 止まった所の、ライの悪さ（残りの距離に足す m。刻む所を選ぶのに使う）。 */
const LIE_PENALTY: Record<Ball['lie'], number> = {
  green: -5,
  fairway: 0,
  rough: 15,
  sand: 25,
  rock: 20,
  snow: 20,
};

/** カップの半径（game.ts と同じ）。 */
const CUP_RADIUS = 0.22;
/** 1 コマで読みに使ってよい時間（ms）。 */
const PLAN_BUDGET = 6;
/** 1 人の 1 打の計画。 */
interface Plan {
  club: number;
  yaw: number;
  power: number;
  curve: number;
}

class Rival {
  readonly ball: Ball;
  strokes = 0;
  holed = false;
  readonly scores: (number | undefined)[] = [];
  plan: Plan | null = null;
  /** 読みかけの計画（1 コマに少しずつ進める）。 */
  planning: Generator<void, Plan> | null = null;
  /** 飛んでいる間の、固定刻みの余り（s）。 */
  private acc = 0;
  /** 地面に着いてからの秒数（プレイヤーの球と同じく、長く転がると速く進める）。 */
  private groundTime: number | null = null;
  private readonly lastSpot = { x: 0, z: 0 };
  readonly mesh: THREE.Mesh;
  readonly trail: THREE.Line;
  readonly trailFade: TrailFade;
  private readonly trailPoints: Point3[] = [];

  constructor(
    readonly spec: RivalSpec,
    ground: GolfGround,
  ) {
    this.ball = new Ball(ground);
    this.ball.onEvent = (e) => {
      if (e.type === 'land' && this.groundTime === null) this.groundTime = 0;
    };
    this.mesh = new THREE.Mesh(
      new THREE.SphereGeometry(BALL_RADIUS, 14, 10),
      new THREE.MeshLambertMaterial({ color: spec.color, emissive: spec.color, emissiveIntensity: 0.25 }),
    );
    const trailMaterial = new THREE.LineBasicMaterial({ color: spec.color, transparent: true, opacity: 0.6 });
    this.trail = new THREE.Line(new THREE.BufferGeometry(), trailMaterial);
    this.trailFade = new TrailFade(this.trail, trailMaterial, 0.6);
  }

  get moving(): boolean {
    return this.ball.state === 'flight' || this.ball.state === 'roll';
  }

  teeOff(hole: Hole, x: number, z: number): void {
    if (hole.number === 1) this.scores.length = 0;
    this.strokes = 0;
    this.holed = false;
    this.plan = null;
    this.planning = null;
    this.acc = 0;
    this.ball.cup = { x: hole.pin.x, z: hole.pin.z, r: CUP_RADIUS };
    this.ball.wind = hole.wind;
    this.ball.place(x, z);
    this.ball.lie = 'fairway';
    this.trailPoints.length = 0;
    this.setTrail();
    this.mesh.visible = true;
  }

  /** 計画どおりに打つ。 */
  hit(plan: Plan): void {
    const club = CLUBS[plan.club];
    this.lastSpot.x = this.ball.pos.x;
    this.lastSpot.z = this.ball.pos.z;
    const lieLoss = plan.club === PUTTER ? 1 : LIE_POWER[this.ball.lie];
    this.ball.hit(plan.yaw, club.loft, club.speed * plan.power * lieLoss, club.spin, club.bite, plan.curve);
    this.strokes++;
    this.plan = null;
    this.planning = null;
    this.acc = 0;
    this.groundTime = club.loft > 0.5 ? null : 0;
    this.trailPoints.length = 0;
    this.trailPoints.push({ ...this.ball.pos });
    this.trailFade.show();
  }

  /**
   * 固定刻みで dt 秒ぶん進める。止まった・入った・水に入ったら true。
   * instant なら止まるまで一気に進める（プレイヤーが先に入れた後の打ち切り）。
   */
  advance(dt: number, hole: Hole, instant = false): boolean {
    if (!this.moving) return false;
    if (instant) {
      for (let t = 0; t < 40 && this.moving; t += BALL_STEP) this.ball.update(BALL_STEP);
    } else {
      if (this.groundTime !== null) this.groundTime += dt;
      this.acc += dt * rollSpeed(this.groundTime);
      while (this.acc >= BALL_STEP && this.moving) {
        this.ball.update(BALL_STEP);
        this.acc -= BALL_STEP;
      }
      const p = this.ball.pos;
      const last = this.trailPoints[this.trailPoints.length - 1];
      if (!last || Math.hypot(last.x - p.x, last.y - p.y, last.z - p.z) > 2) {
        this.trailPoints.push({ ...p });
        this.setTrail();
      }
    }
    if (this.moving) return false;
    this.trailFade.settle();
    if (this.ball.state === 'holed') {
      this.holed = true;
      this.scores[hole.number - 1] = this.strokes;
      this.mesh.visible = false;
    } else if (this.ball.state === 'water') {
      // 1 打罰で、打った所から打ち直し（プレイヤーと同じ）。
      this.strokes++;
      this.ball.place(this.lastSpot.x, this.lastSpot.z);
    }
    this.giveUpIfTooMany(hole);
    return true;
  }

  /** ダブルパーで打ち切る（止まらない球や、出せない所で延々と打ち続けないように）。 */
  giveUpIfTooMany(hole: Hole): void {
    if (this.holed || this.strokes < hole.par * 2) return;
    this.holed = true;
    this.strokes = hole.par * 2;
    this.scores[hole.number - 1] = this.strokes;
    this.mesh.visible = false;
  }

  syncMesh(): void {
    const p = this.ball.pos;
    this.mesh.position.set(p.x, p.y, p.z);
  }

  private setTrail(): void {
    this.trail.geometry.dispose();
    this.trail.geometry = new THREE.BufferGeometry().setFromPoints(
      this.trailPoints.map((q) => new THREE.Vector3(q.x, q.y, q.z)),
    );
  }
}

/** 標準正規分布の乱数（Box-Muller）。 */
function gauss(rand: () => number): number {
  const u = Math.max(1e-9, rand());
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export class Rivals implements Opponents {
  readonly group = new THREE.Group();
  private readonly list: Rival[];
  /** プレイヤーが先に入れた後、残りを打ち切っている間。 */
  private finishing = false;
  /** 様子が変わったとき（止まった・入った）に呼ぶ（画面の順位を描き直す）。 */
  onChange: (() => void) | null = null;

  constructor(
    specs: readonly RivalSpec[],
    private readonly ground: GolfGround,
    /** 乱数の元（合言葉と日付）。同じコース・同じ日なら同じ結果になる。 */
    private readonly seedKey: string,
  ) {
    this.list = specs.map((s) => new Rival(s, ground));
    for (const r of this.list) this.group.add(r.mesh, r.trail);
  }

  get count(): number {
    return this.list.length;
  }

  /** 全員がこのホールを終えたか（打ち切りも含めて）。 */
  get settled(): boolean {
    return this.list.every((r) => r.holed);
  }

  /** ティーに並べる（プレイヤーの左右に少しずつずらす）。 */
  teeOff(hole: Hole): void {
    this.finishing = false;
    const dx = hole.aim.x - hole.tee.x;
    const dz = hole.aim.z - hole.tee.z;
    const len = Math.hypot(dx, dz) || 1;
    const rx = -dz / len;
    const rz = dx / len;
    this.list.forEach((r, k) => {
      const side = (k % 2 === 0 ? 1 : -1) * (1.6 + Math.floor(k / 2) * 1.6);
      r.teeOff(hole, hole.tee.x + rx * side, hole.tee.z + rz * side);
      r.syncMesh();
    });
    this.onChange?.();
  }

  /** プレイヤーが打った: まだ入れていない全員が、同時に 1 打ずつ打つ（読みかけなら、ここで読み終える）。 */
  shoot(hole: Hole): void {
    for (const r of this.list) {
      if (r.holed) continue;
      // 前の球がまだ転がっていれば、止まるまで進めてから打つ。
      if (r.moving) r.advance(0, hole, true);
      if (r.holed) continue;
      r.hit(this.planNow(r, hole));
    }
  }

  /** プレイヤーが先に入れた: 残りの全員を打ち切る（update で少しずつ）。 */
  finish(): void {
    this.finishing = true;
  }

  update(dt: number, hole: Hole): void {
    let changed = false;
    for (const r of this.list) {
      r.trailFade.update(dt);
      if (r.advance(dt, hole)) changed = true;
      r.syncMesh();
    }
    // 読みを進める（狙っている間は次の一打を、打ち切りの間は残りの一打を）。1 コマ PLAN_BUDGET まで。
    const r = this.list.find((q) => !q.holed && !q.moving && !q.plan);
    if (r) {
      r.planning ??= this.planSteps(r, hole);
      const start = performance.now();
      for (;;) {
        const step = r.planning.next();
        if (step.done) {
          r.plan = step.value;
          r.planning = null;
          break;
        }
        if (performance.now() - start > PLAN_BUDGET) break;
      }
    }
    if (this.finishing) {
      // 読み終えた 1 人だけ打って、止まるまで一気に進める（1 コマに 1 打）。
      const q = this.list.find((x) => !x.holed && x.plan);
      if (q) {
        q.hit(q.plan!);
        q.advance(0, hole, true);
        changed = true;
      }
    }
    if (changed) this.onChange?.();
  }

  /** 画面に出す様子。 */
  states(): OpponentState[] {
    return this.list.map((r) => ({
      id: r.spec.id,
      name: r.spec.name,
      color: r.spec.color,
      scores: r.scores,
      strokes: r.strokes,
      holed: r.holed,
      ball: r.holed ? null : { ...r.ball.pos },
    }));
  }

  /** 読みかけなら読み終え、読んでいなければ今読む（打つ瞬間に間に合わなかったとき）。 */
  private planNow(r: Rival, hole: Hole): Plan {
    if (r.plan) return r.plan;
    const gen = r.planning ?? this.planSteps(r, hole);
    for (;;) {
      const step = gen.next();
      if (step.done) return step.value;
    }
  }

  /** 次の一打を一度に決める（調整やテストから使う）。 */
  plan(r: Rival, hole: Hole): Plan {
    const gen = this.planSteps(r, hole);
    for (;;) {
      const step = gen.next();
      if (step.done) return step.value;
    }
  }

  /**
   * 次の一打を決める（試し打ちのたびに止まれるよう、区切りで yield する）。プレイヤーの「狙いの初めの置き方」と同じ（グリーンはカップへ、ティーからは設計した落とし所へ、
   * それ以外はピンへ届く所まで）。池や海に入る・ライが悪いなら手前へ刻む。風の中の試し打ちで向きと強さを直し、
   * 最後に腕前の分だけ狂わせる。
   */
  private *planSteps(r: Rival, hole: Hole): Generator<void, Plan> {
    const spec = r.spec;
    const rand = mulberry32(hashSeed(`${this.seedKey}:${hole.number}:${spec.id}:${r.strokes}`)[0]);
    const b = r.ball.pos;
    const pin = hole.pin;
    const toPin = Math.hypot(pin.x - b.x, pin.z - b.z);
    const yawTo = (x: number, z: number) => Math.atan2(-(x - b.x), -(z - b.z));
    const lie = r.ball.lie;
    if (lie === 'green' || (lie === 'fairway' && toPin < 6)) {
      // パット: カップを 0.5m 越える強さで。傾きで逸れる向きと、上り・下りで足りない・行き過ぎる強さを、
      // 腕前の回数だけ試し打ちで直す。強さは距離の比の平方根で直すが、1 回に 0.75〜1.35 倍まで
      // （2 段グリーンの段を上りきれずに戻った試し打ちから一気に強めて、22m 先のラフまで転がした）。
      let yaw = yawTo(pin.x, pin.z);
      const d = toPin + 0.5;
      let power = solvePower(this.ground, b, lie, PUTTER, yaw, d).power;
      for (let k = 0; k < spec.puttRead; k++) {
        yield;
        const end = trial(this.ground, b, lie, PUTTER, yaw, power).end;
        yaw += angleBetween(b, end, pin);
        const got = Math.max(0.2, Math.hypot(end.x - b.x, end.z - b.z));
        power = Math.max(0.02, Math.min(1, power * Math.max(0.75, Math.min(1.35, Math.sqrt(d / got)))));
      }
      const missYaw = (gauss(rand) * spec.puttYaw * Math.PI) / 180;
      const missPower = 1 + gauss(rand) * spec.puttPower;
      return { club: PUTTER, yaw: yaw + missYaw, power: Math.max(0.02, Math.min(1, power * missPower)), curve: 0 };
    }
    // 読んだ風（腕前の分だけ）。
    const w = r.ball.wind;
    const wind = { x: w.x * spec.windRead, z: w.z * spec.windRead };
    const target = r.strokes === 0 ? hole.aim : pin;
    const want = Math.hypot(target.x - b.x, target.z - b.z);
    const full = Math.min(want, reachOf(clubFor(want, r.strokes, lie), lie));
    const pointAt = (d: number) => ({
      x: b.x + ((target.x - b.x) * d) / (want || 1),
      z: b.z + ((target.z - b.z) * d) / (want || 1),
    });
    // 刻む所を選ぶ: 届く所から少しずつ手前へ、その距離に合うクラブで試し打ちして比べる。
    // - 水に入る所は選ばない。同じクラブで力だけ弱めると低く出て転がり、池越えのパー 5 で池に打ち続けた
    // - 試し打ちは距離を合わせてから見る（表の見当だけだと手前に落ちて乾いて見え、本番では池に届いた）
    // - 6% 飛びすぎたら水に入る所は減点する（腕前の狂いで池の縁から転がり込まないように）
    // ふつうの一打（届く所がフェアウェイかグリーンで、水にも届かない）は 1 つ目で決まる。
    let pick = full;
    let club = clubFor(full, r.strokes, lie);
    let best = Infinity;
    // 候補は多くて 6 つ（1 打を読むのに時間をかけすぎない。狙っている間に 1 コマで読む）。
    const step = Math.max(15, (full * 0.75) / 5);
    for (let d = full; d >= Math.max(15, full * 0.25); d -= step) {
      yield;
      const c = clubFor(d, r.strokes, lie);
      const p = pointAt(d);
      const yaw = yawTo(p.x, p.z);
      const s = solvePower(this.ground, b, lie, c, yaw, d, wind, 2);
      if (s.trial.state === 'water') continue;
      const end = s.trial.end;
      const surface = this.ground.surface(end.x, end.z);
      const long = trial(this.ground, b, lie, c, yaw, Math.min(1, s.power * 1.06), wind);
      const safe = long.state !== 'water';
      const score = Math.hypot(pin.x - end.x, pin.z - end.z) + LIE_PENALTY[surface] + (safe ? 0 : 40);
      if (score < best) {
        best = score;
        pick = d;
        club = c;
      }
      if (safe && (surface === 'fairway' || surface === 'green')) break;
    }
    // 選んだ所へ、風の中の試し打ちで向きと距離を 2 回直す。
    const aim = pointAt(pick);
    let yaw = yawTo(aim.x, aim.z);
    let dist = pick;
    let power = 1;
    for (let k = 0; k < 2; k++) {
      yield;
      const s = solvePower(this.ground, b, lie, club, yaw, dist, wind);
      power = s.power;
      const land = s.trial.land;
      if (!land) break;
      // 風で流される分だけ向きを戻し、届かない・越える分だけ距離を足し引きする。
      yaw += angleBetween(b, land, aim);
      const got = Math.hypot(land.x - b.x, land.z - b.z);
      dist = Math.max(1, dist + (pick - got));
    }
    // プレイヤーと同じ 2 回押し: 1 本目の針で距離の ±、2 本目の針で方向の ±（真ん中の幅は距離で狭くなる）。
    const clamp1 = (v: number) => Math.max(-1, Math.min(1, v));
    const eDist = clamp1(gauss(rand) * spec.distance);
    const gauge = 1 + (Math.abs(eDist) < hardPerfect(pick) ? 0 : eDist) * POWER_RANGE;
    const eDir = clamp1(gauss(rand) * spec.spread);
    const effect = needleEffect(eDir, false, true, hardPerfect(pick * gauge));
    return { club, yaw: yaw + effect.yaw, power: Math.max(0.1, Math.min(1, power * gauge)), curve: effect.curve };
  }
}

/** from から見て、got の向きを want の向きへ合わせるのに足す角度（ラジアン、yaw と同じ回り）。 */
function angleBetween(from: { x: number; z: number }, got: { x: number; z: number }, want: { x: number; z: number }): number {
  const a = Math.atan2(-(got.x - from.x), -(got.z - from.z));
  const w = Math.atan2(-(want.x - from.x), -(want.z - from.z));
  let d = w - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}
