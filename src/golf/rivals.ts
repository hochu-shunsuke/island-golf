import * as THREE from 'three';
import { hashSeed, mulberry32 } from '../core/rng';
import { LIE_POWER, clubAllowed, clubFor, needleEffect, needleRole, strikeOf, reachOf, solvePower, trial } from './aim';
import { TrailFade, addTrailPoint, setTrailLine } from './trail';
import { BALL_RADIUS, BALL_STEP, Ball, type GolfGround, rollSpeed } from './ball';
import { CLUBS, PUTTER } from './clubs';
import type { Hole } from './course';
import type { OpponentState, Opponents } from './opponents';

/**
 * COM の相手。プレイヤーを待たず、それぞれ自分のタイミングで打つ（友達と回るときと同じ。順番を待たない）。
 * 球が止まってから pace の秒数だけ考えて打ち、自分やプレイヤーの一打にスタンプで反応する（性格は RivalSpec）。
 *
 * - 読み: プレイヤーと同じ試し打ち（aim.ts）で、風と傾きを読んで向きと強さを決める
 * - 腕前: 正確さの針のずれを乱数で足す（プレイヤーの針と同じ効き方）。ずれの大きさが強さの差
 * - 球: プレイヤーの球と同じ物理で、実際の時間で飛ぶ。刻みは固定（BALL_STEP）なので、画面の速さに関係なく、
 *   同じコース・同じ日なら毎回同じ結果になる（乱数も合言葉・日・ホール・打数から作る）
 * - 次の一打の読みは、考えている間に、1 コマ 6ms まで少しずつ済ませておく
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
  /** 芯の針を止めるずれ（標準偏差。プレイヤーの 2 回押しの 2 本目と同じ効き方）。 */
  distance: number;
  /** 風をどれだけ読めるか（0 = 無視、1 = 完全に）。 */
  windRead: number;
  /** パットの強さの狂い（割合の標準偏差）と、向きの狂い（度）。 */
  puttPower: number;
  puttYaw: number;
  /** パットの傾きを読む回数（向きと強さを試し打ちで直す回数。多いほど上りも下りも合う）。 */
  puttRead: number;
  /** 球が止まってから次を打つまでの秒数（この間で毎回ばらつく）。プレイヤーを待たず、自分のタイミングで打つ。 */
  pace: readonly [number, number];
  /** スタンプを送る気の多さ（出来事ごとに送る確率）。 */
  chatty: number;
  /**
   * 出来事ごとに選ぶスタンプ（shared/room.ts の STAMPS の番号。空なら送らない）。good・bad は自分の一打、
   * cheer・tease はプレイヤーのいい一打・ミス、reply はプレイヤーのスタンプへの返事。
   */
  stamps: Readonly<Record<StampMood, readonly number[]>>;
}

/** COM がスタンプを送るきっかけ。 */
type StampMood = 'good' | 'bad' | 'cheer' | 'tease' | 'reply';

/** 3 人の相手。COM1 はやさしい、COM2 はふつう、COM3 はつよい（風を読み切り、プロより正確）。 */
export const RIVALS: readonly RivalSpec[] = [
  {
    id: 'com1',
    name: 'COM1',
    level: 'やさしい',
    color: 0xffcf3f,
    spread: 0.24,
    distance: 0.24,
    windRead: 0.5,
    puttPower: 0.25,
    puttYaw: 5,
    puttRead: 1,
    // せっかちでおしゃべり。人のミスは笑わない。
    pace: [2.5, 7],
    chatty: 0.7,
    stamps: { good: [0], bad: [3], cheer: [0], tease: [], reply: [0] },
  },
  {
    id: 'com2',
    name: 'COM2',
    level: 'ふつう',
    color: 0xe8eef2,
    spread: 0.16,
    distance: 0.16,
    windRead: 0.7,
    puttPower: 0.2,
    puttYaw: 3.8,
    puttRead: 2,
    pace: [3.5, 8],
    chatty: 0.45,
    stamps: { good: [0, 1], bad: [3, 4], cheer: [0], tease: [2], reply: [0, 2] },
  },
  {
    id: 'com3',
    name: 'COM3',
    level: 'つよい',
    color: 0x3f63b8,
    // 押しずれ 30ms ほど（ドライバーで向きの標準偏差 約 3°）。風は読み切る。
    // 本物のコース 9 ラウンドで 9 ホール平均 やさしい +6.4・ふつう +0.6・つよい -7.8（利用者の判断で、-8.9 から 1 打弱めた）。
    // 自分の散らばりごと試し打ちして狙いをずらす読みも試したが、強さが変わらず、1 打の読みが 10 倍重くなったのでやめた。
    spread: 0.08,
    distance: 0.08,
    windRead: 1,
    puttPower: 0.1,
    puttYaw: 2,
    puttRead: 3,
    // じっくり読んで、口数は少ない。決めたときだけ得意げ。
    pace: [5, 9],
    chatty: 0.3,
    stamps: { good: [1], bad: [4], cheer: [], tease: [2], reply: [1] },
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
/** ティーに立ってから打ち始めるまでの秒数（ホールの入りの空撮 game.ts の INTRO_TIME の間は打たない）。 */
const TEE_WAIT = 3.4;
/** 1 人の COM がスタンプを送る間隔の下限（秒）と、COM どうしで空ける間（秒）。 */
const STAMP_GAP = 8;
const STAMP_ANY_GAP = 2.5;
/** 1 人の 1 打の計画。 */
interface Plan {
  club: number;
  yaw: number;
  power: number;
  curve: number;
  /** 芯を大きく外した（Mishit）。止まったらスタンプのきっかけにする。 */
  miss?: boolean;
}

class Rival {
  readonly ball: Ball;
  strokes = 0;
  /** このホールで水に入れた回数。1 度入れたら風を読み切り、池の手前に余裕を持つ（同じミスを繰り返さない）。 */
  wet = 0;
  holed = false;
  readonly scores: (number | undefined)[] = [];
  /** 次を打てるまでの秒数（球が止まってから考える間）。 */
  wait = 0;
  /** 最後に打った一打が Mishit だったか。 */
  lastMiss = false;
  /** 最後にスタンプを送った時刻（Rivals の clock）。 */
  lastStampAt = -Infinity;
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
  private readonly trailPoints: { x: number; y: number; z: number }[] = [];

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
    this.wet = 0;
    this.holed = false;
    this.plan = null;
    this.planning = null;
    this.acc = 0;
    this.ball.cup = { x: hole.pin.x, z: hole.pin.z, r: CUP_RADIUS };
    this.ball.wind = hole.wind;
    this.ball.place(x, z);
    this.ball.lie = 'fairway';
    this.trailPoints.length = 0;
    setTrailLine(this.trail, this.trailPoints);
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
    addTrailPoint(this.trailPoints, this.ball.pos);
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
      if (addTrailPoint(this.trailPoints, this.ball.pos)) setTrailLine(this.trail, this.trailPoints);
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
      this.wet++;
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
  /** COM がスタンプを送った（main.ts が球の上に吹き出しを出す）。s は STAMPS の番号。 */
  onStamp: ((id: string, s: number) => void) | null = null;
  /** COM が打った（main.ts が、カメラからの遠さに合わせた音を鳴らす）。 */
  onHit: ((club: number, at: { x: number; y: number; z: number }) => void) | null = null;
  /** update で進む時計（秒）。休憩中は進まない。 */
  private clock = 0;
  /** 誰かが最後にスタンプを送った時刻（COM どうしで立て続けに送らない）。 */
  private lastAnyStamp = -Infinity;
  /** 少し間を置いて送るスタンプ（人が反応するまでの間）。 */
  private readonly stampQueue: { r: Rival; s: number; at: number }[] = [];

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
    this.stampQueue.length = 0;
    this.list.forEach((r, k) => {
      const side = (k % 2 === 0 ? 1 : -1) * (1.6 + Math.floor(k / 2) * 1.6);
      r.teeOff(hole, hole.tee.x + rx * side, hole.tee.z + rz * side);
      // ホールの入り（上から見せる間）が終わってから、それぞれの間で打ち始める。
      r.wait = TEE_WAIT + this.think(r);
      r.syncMesh();
    });
    this.onChange?.();
  }

  /**
   * プレイヤーが打った。COM はプレイヤーを待たずに自分のタイミングで打つので、ここでは何もしない
   * （前はプレイヤーが打つたびに全員が同時に 1 打ずつ打っていて、友達と回るときの自由さが無かった）。
   */
  shoot(_hole: Hole): void {}

  /**
   * プレイヤーの出来事（いい一打・ミス・スタンプ）に、COM のだれか 1 人が反応するかもしれない
   * （全員が一斉に返すと、画面がスタンプで埋まる）。
   */
  react(kind: 'good' | 'bad' | 'stamp'): void {
    const mood: StampMood = kind === 'good' ? 'cheer' : kind === 'bad' ? 'tease' : 'reply';
    const order = [...this.list].sort(() => Math.random() - 0.5);
    for (const r of order) if (this.say(r, mood)) return;
  }

  /** 次を打つまでに考える秒数（パットは短め）。 */
  private think(r: Rival): number {
    const [a, b] = r.spec.pace;
    const t = a + (b - a) * Math.random();
    return r.ball.lie === 'green' ? t * 0.7 : t;
  }

  /** スタンプを送る（気の多さで決め、少し間を置く）。送ることにしたら true。 */
  private say(r: Rival, mood: StampMood): boolean {
    const list = r.spec.stamps[mood];
    if (list.length === 0 || Math.random() > r.spec.chatty) return false;
    if (this.clock - r.lastStampAt < STAMP_GAP || this.stampQueue.some((q) => q.r === r)) return false;
    const s = list[Math.floor(Math.random() * list.length)];
    this.stampQueue.push({ r, s, at: this.clock + 0.6 + Math.random() * 1.4 });
    return true;
  }

  /** 球が止まった: 自分の一打の出来でスタンプを送るかもしれない。次を打つまでの間を決め直す。 */
  private afterStop(r: Rival, hole: Hole, wetBefore: number): void {
    r.wait = this.think(r);
    if (r.holed) {
      const d = (r.scores[hole.number - 1] ?? r.strokes) - hole.par;
      if (r.strokes === 1 || d <= -1) this.say(r, 'good');
      else if (d >= 2) this.say(r, 'bad');
    } else if (r.wet > wetBefore || r.lastMiss) {
      this.say(r, 'bad');
    }
  }

  /** プレイヤーが先に入れた: 残りの全員を打ち切る（update で少しずつ）。 */
  finish(): void {
    this.finishing = true;
  }

  update(dt: number, hole: Hole): void {
    let changed = false;
    this.clock += dt;
    for (const r of this.list) {
      r.trailFade.update(dt);
      const wetBefore = r.wet;
      if (r.advance(dt, hole)) {
        changed = true;
        if (!this.finishing) this.afterStop(r, hole, wetBefore);
      }
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
      const q = this.list.find((x) => !x.holed && !x.moving && x.plan);
      if (q) {
        q.hit(q.plan!);
        q.advance(0, hole, true);
        changed = true;
      }
    } else {
      // それぞれの間がたって、読み終えていれば打つ。
      for (const r of this.list) {
        if (r.holed || r.moving) continue;
        r.wait -= dt;
        if (r.wait > 0 || !r.plan) continue;
        const plan = r.plan;
        r.hit(plan);
        r.lastMiss = !!plan.miss;
        this.onHit?.(plan.club, r.ball.pos);
        changed = true;
      }
    }
    // 間を置いたスタンプを送る（COM どうしは少なくとも STAMP_ANY_GAP あける）。
    const q = this.stampQueue[0];
    if (q && q.at <= this.clock && this.clock - this.lastAnyStamp >= STAMP_ANY_GAP) {
      this.stampQueue.shift();
      this.lastAnyStamp = this.clock;
      q.r.lastStampAt = this.clock;
      this.onStamp?.(q.r.spec.id, q.s);
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
    // 読んだ風（腕前の分だけ。このホールで 1 度水に入れたら読み切る）。
    const w = r.ball.wind;
    const read = r.wet > 0 ? 1 : spec.windRead;
    const wind = { x: w.x * read, z: w.z * read };
    // 距離 d に届くクラブで試し打ちする。風で届かない（全力でも手前に落ちる）なら番手を上げる
    // （無風の表だけでクラブを選ぶと、向かい風の池越えで全力でも池に落ち続けた）。
    const solveFor = (yaw: number, d: number, refine: number) => {
      let c = clubFor(d, r.strokes, lie);
      let s = solvePower(this.ground, b, lie, c, yaw, d, wind, refine);
      for (;;) {
        const land = s.trial.land;
        const got = land ? Math.hypot(land.x - b.x, land.z - b.z) : 0;
        if (s.power < 0.999 || got >= d - 2 || c === 0 || !clubAllowed(c - 1, r.strokes, lie)) break;
        c--;
        s = solvePower(this.ground, b, lie, c, yaw, d, wind, refine);
      }
      return { c, s };
    };
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
    // - 芯を外すと短くなるだけなので、手前の池は 8% 短くても越える所だけを安全とする。越えられない候補しか無ければ、
    //   狙いより少し奥（プレイヤーが「少し遠めに輪を置く」のと同じ）も試す
    // ふつうの一打（届く所がフェアウェイかグリーンで、水にも届かない）は 1 つ目で決まる。
    let pick = full;
    let club = clubFor(full, r.strokes, lie);
    let best = Infinity;
    // 候補は多くて 8 つ（1 打を読むのに時間をかけすぎない。狙っている間に 1 コマで読む）。
    const step = Math.max(15, (full * 0.75) / 5);
    const candidates: number[] = [];
    for (let d = full; d >= Math.max(15, full * 0.25); d -= step) candidates.push(d);
    candidates.splice(1, 0, full * 1.08, full * 1.16);
    for (const d of candidates) {
      yield;
      const p = pointAt(d);
      const yaw = yawTo(p.x, p.z);
      const { c, s } = solveFor(yaw, d, 2);
      if (s.trial.state === 'water') continue;
      const end = s.trial.end;
      const surface = this.ground.surface(end.x, end.z);
      const long = trial(this.ground, b, lie, c, yaw, Math.min(1, s.power * 1.06), wind);
      const short = trial(this.ground, b, lie, c, yaw, s.power * 0.92, wind);
      const safe = long.state !== 'water' && short.state !== 'water';
      // 水に入れた後は、危ない所をもっと嫌う（刻んででも池を避ける）。
      const score = Math.hypot(pin.x - end.x, pin.z - end.z) + LIE_PENALTY[surface] + (safe ? 0 : r.wet > 0 ? 120 : 40);
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
      const { c, s } = solveFor(yaw, dist, 5);
      club = c;
      power = s.power;
      const land = s.trial.land;
      if (!land) break;
      // 風で流される分だけ向きを戻し、届かない・越える分だけ距離を足し引きする。
      yaw += angleBetween(b, land, aim);
      const got = Math.hypot(land.x - b.x, land.z - b.z);
      dist = Math.max(1, dist + (pick - got));
    }
    // プレイヤーと同じ 2 回押し: 方向の針と芯の針（外すと短いだけ。aim.ts の strikeOf）。
    const role = needleRole(pick);
    const width = role.distWidth * strainOf(power);
    const strike = strikeOf(clamp1(gauss(rand) * spec.distance), width, pick, false);
    const eDir = clamp1(gauss(rand) * spec.spread);
    const effect = needleEffect(eDir, false, true, role.dirWidth);
    return {
      club,
      yaw: yaw + effect.yaw,
      power: Math.max(0.1, Math.min(1, power * strike.power)),
      curve: effect.curve,
      miss: strike.kind === 'miss',
    };
  }
}

function clamp1(v: number): number {
  return Math.max(-1, Math.min(1, v));
}

/** 力み: 全力の近く（85% より上）を狙うほど芯の帯が狭い（プレイヤーの game.ts の strikeWidth と同じ）。 */
function strainOf(power: number): number {
  return power <= 0.85 ? 1 : 1 - 0.45 * ((Math.min(1, power) - 0.85) / 0.15);
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
