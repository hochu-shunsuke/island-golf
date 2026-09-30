import * as THREE from 'three';
import { SEA_LEVEL } from '../world/terrain';
import type { Terrain } from '../world/terrain';
import { LIE_POWER, PERFECT, type Strike, needleRole, strikeOf, type Point3, type Trial, clubFor, needleEffect, reachOf, solvePower } from './aim';
import { BALL_RADIUS, Ball, type GolfGround, type Surface, rollSpeed } from './ball';
import { CLUBS, type Club, PUTTER } from './clubs';
import { type Hole, holeIntro } from './course';
import type { OpponentState, Opponents } from './opponents';
import { TrailFade } from './trail';
import { WindStreaks } from './windStreaks';
import type { RestInfo, ShotInfo } from '../../shared/room';

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
  /** 一緒に回る相手（COM か友達）の様子（ひとりで回るときは空）。 */
  rivals: readonly OpponentState[];
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
  if (strokes === 1) return 'Hole in One!';
  const d = strokes - par;
  if (d <= -3) return 'Albatross';
  if (d === -2) return 'Eagle';
  if (d === -1) return 'Birdie';
  if (d === 0) return 'Par';
  if (d === 1) return 'Bogey';
  if (d === 2) return 'Double Bogey';
  if (d === 3) return 'Triple Bogey';
  return `+${d}`;
}

/** パーとの差（+2・-1・±0）。 */
export function toPar(strokes: number, par: number): string {
  const d = strokes - par;
  return d === 0 ? '±0' : d > 0 ? `+${d}` : `${d}`;
}

/** ホールの紹介（上空からの眺め）の長さと、そこから打つ構えへ降りてくる時間（s）。 */
/** 狙う間のカメラの、球からの後ろと上（m）。遠くを狙うほど少し引く（228m で 15m 後ろ・10m 上）。 */
const AIM_BACK = 10;
const AIM_UP = 6.5;
/** 狙う間に自分の球を大きく描く上限（倍）。 */
const AIM_BALL_SCALE = 2;
/** 狙う間のカメラで、落とし所を置く高さと、球の一番下の位置（画面の真ん中が 0、上端 1、下端 -1）。 */
const AIM_LANDING_AT = 0.12;
/** 下の打つ情報の札に隠れない高さまで。 */
const AIM_BALL_LOWEST = -0.66;
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
/** 狙いを動かしている間に、試し打ちをやり直す間隔（s）。 */
const SOLVE_EVERY = 0.09;

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * 2 回押しの針の速さ（1 秒に片道いくつ。フェアウェイで端から端まで 0.73 秒）。距離では変えない（みんゴルと同じ）。
 * 距離で変えていた頃（近いほど遅く広い）は、遠いと外れても結局寄り、近いとゆっくりでほぼ入って、針の意味が薄かった。
 * ライが悪いほど少しだけ速い。元の針のライの倍率（ラフ 1.35・砂 1.7）を掛け合わせると、ラフや砂に入った次の一打で
 * 急に倍近く速くなった（利用者に「途中でバカ早くなった」と言われた）ので、上乗せは 1〜2 割にとどめる。
 */
const FAST_NEEDLE_SPEED: Record<Surface, number> = {
  green: 1.16,
  fairway: 1.38,
  rough: 1.52,
  sand: 1.65,
  rock: 1.58,
  snow: 1.58,
};

/** 打つバーの中身（画面の下の 1 本のバー。方向と芯で帯の幅と見た目を替える）。stage は今決めている方。 */
export interface SwingGauge {
  stage: 'dir' | 'dist';
  dirWidth: number;
  distWidth: number;
}

/** 打った一打のでき（画面の真ん中に大きく）。mishit は芯を大きく外して飛ばなかった。 */
export type ShotFeedback = 'nice' | 'hook' | 'slice' | 'mishit';

export class GolfGame {
  readonly group = new THREE.Group();
  /** 打つための目印（軌道の予告・落とし所の輪・軌跡・傾きの矢印）。開始画面の空撮では隠す。旗と球は残す。 */
  readonly aids = new THREE.Group();
  readonly ball: Ball;
  /** 一緒に回る相手（COM か友達。ひとりで回るときは null）。 */
  private rivals: Opponents | null = null;
  /** 自分が打った一打と、止まった所（友達と対戦するとき、部屋へ送る）。 */
  onPlayerShot: ((hole: number, shot: ShotInfo) => void) | null = null;
  onPlayerRest: ((hole: number, rest: RestInfo) => void) | null = null;
  phase: GolfPhase = 'aim';
  strokes = 0;
  clubIndex = 0;
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
  onShotFeedback: ((kind: ShotFeedback) => void) | null = null;
  /** カップに入ったとき（お祝い・スコアカード・自己ベストのため）。last は最後のホールか。 */
  onHoled: ((hole: Hole, strokes: number, total: number, totalPar: number, last: boolean) => void) | null = null;

  private readonly ballMesh: THREE.Mesh;
  private readonly arc: THREE.Line;
  private readonly roll: THREE.Line;
  private readonly landing: THREE.Mesh;
  private readonly trail: THREE.Line;
  private readonly trailFade: TrailFade;
  /** カップインの紙吹雪。 */
  private confetti: { points: THREE.Points; vel: Float32Array; age: number } | null = null;
  /** パットのときの傾斜の矢印（下る向き・長さと色が急さ）。 */
  private readonly slopes: THREE.Mesh;
  private slopesFor = '';
  private readonly trailPoints: THREE.Vector3[] = [];
  private needleTime = 0;
  /** 打つ前の球の位置（池に入ったらここへ戻す）。 */
  private readonly lastSpot = { x: 0, z: 0 };
  private restTimer = 0;
  /** 打った球が地面に着いてからの時間（s）。まだ着いていなければ null。パットは打った時から数える。 */
  private groundTime: number | null = null;
  private readonly camPos = new THREE.Vector3();
  private readonly camLook = new THREE.Vector3();
  private cameraReady = false;
  /** カップイン後に、球を中心として見回す向きと高さ。 */
  private holedViewYaw = 0;
  private holedViewPitch = 0.42;
  private solveDirty = true;
  private solveWait = 0;
  /** ホールに立った直後、上空からホール全体を見せる残り時間（s）。 */
  private intro = 0;
  /** ホールの番号を真ん中に出している間は、操作を受け付けない残り秒数（lockInput）。 */
  private inputLock = 0;
  private readonly golfGround: GolfGround;
  /**
   * 狙う間のカメラで、球を置く一番下の高さ（画面の真ん中が 0、下端 -1）。タッチは下の段（打つボタン）と
   * その上のバーがあるので、main.ts がもう少し上にする。
   */
  aimBallLowest = AIM_BALL_LOWEST;
  /** 風の筋（カメラの前を風の向きへ流れる白い線。golf/windStreaks.ts）。 */
  private readonly windStreaks = new WindStreaks();
  /** 散らばりを腕で決める速い針（aim.ts の HARD_NEEDLE）。 */
  hardNeedle = true;
  /**
   * 2 回押し。狙い（輪）で大枠を決め、1 本目の針で方向の ±、2 本目の針で距離の ± を決める
   * （近くで大事な距離を最後に。パットの「ライン → 強さ」と同じ順）。どちらも真ん中で止めれば狙いどおり。
   * ミニゲームの間は弧を描き直さない（結果は打つまで分からない）。
   */
  twoClick = true;
  /** 今振れている針（impact ＝ 方向、power ＝ 距離）。 */
  swingStage: 'power' | 'impact' = 'impact';
  /** 1 本目（方向）の針を止めた位置。 */
  private dirNeedle = 0;

  /** 打つゲージの中身（画面の 1 本のバー。ui/overlay.ts の SwingGauge）。 */
  get gauge(): SwingGauge {
    const dist = this.swingStage === 'power';
    return {
      stage: dist ? 'dist' : 'dir',
      dirWidth: this.putting ? PERFECT : this.role.dirWidth,
      distWidth: this.strikeWidth,
    };
  }

  /**
   * 力みに使う、輪に届く強さ。輪がそのクラブの届く限界にあれば全力（1）とみなす
   * （試し打ちで求めた強さは全力のわずか下になる）。
   */
  private get scalePower(): number {
    return this.aimDistance >= this.reachOf(this.clubIndex) - 1 ? 1 : this.power;
  }

  /** 今の針の真ん中（ずれ無し）の幅。距離では変えない。パットの方向だけは元の広さ。 */
  get perfectWidth(): number {
    if (!this.hardNeedle || (this.putting && this.swingStage === 'impact')) return PERFECT;
    return this.swingStage === 'power' ? this.strikeWidth : this.role.dirWidth;
  }

  /**
   * 芯の針の真ん中の幅。場面の役割（近いほど狭い）に、力みを重ねる: 全力の近く（85% より上）を狙うほど狭い
   * （最大いっぱいを狙うとミスが出やすく、8〜9 割で狙えば安全。実際の「番手を上げて軽く振る」と同じ判断）。
   */
  private get strikeWidth(): number {
    const w = this.role.distWidth;
    if (this.putting) return w;
    const p = Math.min(1, this.scalePower);
    return p <= 0.85 ? w : w * (1 - 0.45 * ((p - 0.85) / 0.15));
  }

  /** 今の狙いでの 2 本の針の難しさ（遠いほど方向、近いほど距離が難しい。aim.ts の needleRole）。 */
  private get role(): ReturnType<typeof needleRole> {
    return needleRole(this.aimDistance);
  }


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
      if (e.type === 'land' && this.groundTime === null) this.groundTime = 0;
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
    // 打った球の軌跡。止まってから少し見せて消す（golf/trail.ts）。
    const trailMaterial = new THREE.LineBasicMaterial({ color: 0xffe98a, transparent: true, opacity: 0.85 });
    this.trail = new THREE.Line(new THREE.BufferGeometry(), trailMaterial);
    this.trailFade = new TrailFade(this.trail, trailMaterial, 0.85);
    // 傾斜の矢印は地面に貼った塗りの矢印（1 ピクセルの線では細すぎて読めなかった）。
    this.slopes = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.4,
        depthWrite: false,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -2,
      }),
    );
    this.slopes.visible = false;
    this.aids.add(this.arc, this.roll, this.landing, this.trail, this.slopes);
    this.group.add(this.aids, this.windStreaks.mesh);
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

  /** 落とし所の輪の真ん中（地面。距離の札を輪の下に出すため）。 */
  aimBase(out: THREE.Vector3): THREE.Vector3 {
    return out.set(this.aimPoint.x, this.golfGround.height(this.aimPoint.x, this.aimPoint.z), this.aimPoint.z);
  }

  /** 球の地面（COM と友達の球も同じ地面を転がる）。 */
  get ground(): GolfGround {
    return this.golfGround;
  }

  /** 一緒に回る相手を替える（null ならひとりで）。1 番のティーから回り直す。 */
  setOpponents(opponents: Opponents | null): void {
    if (this.rivals) this.aids.remove(this.rivals.group);
    this.rivals = opponents;
    if (this.rivals) {
      this.rivals.onChange = () => this.emit();
      // 打つための目印と同じく、開始画面の空撮では隠す。
      this.aids.add(this.rivals.group);
    }
    this.teeOff(this.course[0]);
  }

  /** 一緒に回る相手の今の様子（球の位置は毎フレーム変わる。ひとりなら空）。 */
  get rivalStates(): OpponentState[] {
    return this.rivals?.states() ?? [];
  }

  /** COM の相手が、今のホールを全員終えたか（ひとりなら常に true）。スコアカードと結果はこれを待って出す。 */
  get rivalsSettled(): boolean {
    return !this.rivals || this.rivals.settled;
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
    this.rivals?.teeOff(hole);
    this.readyToAim();
    this.holedViewYaw = this.aimYaw;
    this.holedViewPitch = 0.42;
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

  /** 止まった所を友達へ（本人の画面の結果に、友達の画面を合わせる）。 */
  private reportRest(holed: boolean): void {
    const p = this.ball.pos;
    this.onPlayerRest?.(this.target.number, { x: p.x, y: p.y, z: p.z, lie: this.ball.lie, strokes: this.strokes, holed });
  }

  /**
   * このホールを打ち切る（友達と対戦で、待ち時間が過ぎて部屋が次のホールへ進めたとき。打数はダブルパー）。
   * 球が転がっていても止め、カップインの後と同じく次のティーへ進める状態にする。
   */
  concede(strokes: number): void {
    if (this.phase === 'holed') return;
    this.ball.place(this.ball.pos.x, this.ball.pos.z);
    this.strokes = strokes;
    this.scores[this.target.number - 1] = strokes;
    this.phase = 'holed';
    this.holedViewYaw = this.aimYaw;
    this.holedViewPitch = 0.42;
    this.arc.visible = false;
    this.roll.visible = false;
    this.landing.visible = false;
    this.slopes.visible = false;
    this.emit();
  }

  /**
   * 回っている途中から戻る（友達と対戦の途中で読み直したとき）。scores は部屋が覚えていた自分の打数。
   * hole のティーから、次の一打を打てる状態にする。
   */
  resumeRound(scores: readonly (number | null)[], hole: Hole): void {
    this.teeOff(hole);
    this.scores.length = 0;
    scores.forEach((s, k) => {
      if (s !== null) this.scores[k] = s;
    });
    this.emit();
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
    return reachOf(c, this.ball.lie);
  }

  /** 距離 d に合うクラブ（aim.ts の clubFor）。 */
  private clubFor(d: number): number {
    return clubFor(d, this.strokes, this.ball.lie);
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
    this.trailFade.settle();
    this.needle = -1;
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

  /** しばらく操作を受け付けない（ホールの始まりに番号を出している間。main.ts）。 */
  lockInput(seconds: number): void {
    this.inputLock = Math.max(this.inputLock, seconds);
  }

  /** 操作を受け付けない間か。 */
  get inputLocked(): boolean {
    return this.inputLock > 0;
  }

  /** 狙いを回す（球を中心に）。 */
  rotateAim(delta: number): void {
    if (this.phase !== 'aim' || this.inputLock > 0) return;
    this.intro = Math.min(this.intro, INTRO_OUT);
    this.setAim(this.aimYaw + delta, this.aimDistance);
  }

  /** カップイン後の待ち時間に、カップを中心として景色を見回す。 */
  lookAround(deltaYaw: number, deltaPitch: number): void {
    if (this.phase !== 'holed') return;
    this.holedViewYaw += deltaYaw;
    this.holedViewPitch = THREE.MathUtils.clamp(this.holedViewPitch + deltaPitch, 0.12, 1.05);
  }

  /** 輪を前後に動かす（m）。クラブを自分で選んでいなければ、距離に合うクラブへ替える。 */
  pushAim(delta: number): void {
    if (this.phase !== 'aim' || this.inputLock > 0) return;
    this.intro = Math.min(this.intro, INTRO_OUT);
    const d = Math.max(0, this.aimDistance + delta);
    if (!this.putting) this.clubIndex = this.clubFor(d);
    this.setAim(this.aimYaw, d);
    this.emit();
  }

  // ── 打つ ─────────────────────────────────────────────

  /** 打つ操作を押した: 狙っていれば針を振り始め、振れていれば止めて打つ。 */
  press(): void {
    if (this.inputLock > 0) return;
    if (this.phase === 'aim') {
      if (this.solveDirty) this.solve();
      this.intro = 0;
      this.phase = 'swing';
      this.needleTime = 0;
      this.needle = -1;
      this.swingStage = 'impact';
      this.onSound({ type: 'ready' });
      this.emit();
    } else if (this.phase === 'swing') {
      if (this.twoClick && this.swingStage === 'impact') {
        // 方向の針を止めた: 次は芯の針。
        this.dirNeedle = this.needle;
        this.swingStage = 'power';
        this.needleTime = 0;
        this.needle = -1;
        this.emit();
        return;
      }
      this.hit();
    }
  }

  /** 構えをやめて、狙いに戻る（針が振れている間に Esc など）。 */
  cancelSwing(): void {
    if (this.phase !== 'swing') return;
    // 2 回押しで方向を決めた後は、やめられない（距離まで打ち切る）。
    if (this.twoClick && this.swingStage === 'power') return;
    this.phase = 'aim';
    this.needle = -1;
    this.swingStage = 'impact';
    // 2 回押しで描き替えた弧を、輪に届く弧へ戻す。
    this.solveDirty = true;
    this.emit();
  }

  /** 針を止めた所で打つ。真ん中ならナイスショット。ずれるほど曲がり、少し短くなる。 */
  private hit(): void {
    const club = this.club;
    const putt = this.putting;
    // 2 回押しでは、方向は 1 本目の針、距離は今止めた 2 本目の針で決まる。
    const e = this.twoClick ? this.dirNeedle : this.needle;
    const effect = needleEffect(e, putt, this.hardNeedle, putt ? PERFECT : this.role.dirWidth);
    // 2 本目の針は芯。外すとどちらへでも短くなるだけ（aim.ts の strikeOf）。
    const strike: Strike = this.twoClick
      ? strikeOf(this.needle, this.strikeWidth, this.aimDistance, putt)
      : { power: 1, kind: 'good' };
    const perfect = effect.perfect;
    this.lastSpot.x = this.ball.pos.x;
    this.lastSpot.z = this.ball.pos.z;
    const yaw = this.aimYaw + effect.yaw;
    // 2 回押しでは、距離は 2 本目（芯）の針だけで決まる（1 本目は方向だけ）。全力より強くはならない。
    const power = Math.min(1, this.twoClick ? this.power * strike.power : this.power * effect.power);
    const lieLoss = putt ? 1 : LIE_POWER[this.ball.lie];
    const loft = club.loft;
    const spin = club.spin;
    const bite = club.bite;
    this.ball.hit(yaw, loft, club.speed * power * lieLoss, spin, bite, effect.curve);
    // 友達には、同じ物理でもう一度飛ばせるよう、打った一打をそのまま送る。
    this.onPlayerShot?.(this.target.number, {
      x: this.lastSpot.x,
      z: this.lastSpot.z,
      lie: this.ball.lie,
      yaw,
      loft,
      speed: club.speed * power * lieLoss,
      spin,
      bite,
      curve: effect.curve,
    });
    // COM の相手も同時に 1 打ずつ打つ。
    this.rivals?.shoot(this.target);
    const c = this.clubIndex;
    this.onSound({
      type: 'hit',
      kind: putt ? 'putter' : c <= 1 ? 'wood' : c <= 4 ? 'iron' : 'wedge',
      strength: power * lieLoss,
      perfect: perfect && !putt,
    });
    setLine(this.trail, []);
    this.trailFade.show();
    this.strokes++;
    if (putt) {
      const st = this.stats[this.target.number - 1];
      if (st) st.putts++;
    }
    this.phase = 'moving';
    this.restTimer = 0;
    this.groundTime = putt ? 0 : null;
    this.trailPoints.length = 0;
    this.arc.visible = false;
    this.roll.visible = false;
    this.landing.visible = false;
    this.slopes.visible = false;
    if (!putt) {
      // 大きなミス（芯を外して飛ばない）を先に。芯も向きも真ん中ならナイスショット。
      if (strike.kind === 'miss') this.onShotFeedback?.('mishit');
      else if (perfect && strike.power === 1) this.onShotFeedback?.('nice');
      else if (e > 0.45) this.onShotFeedback?.('slice');
      else if (e < -0.45) this.onShotFeedback?.('hook');
    }
    this.emit();
  }

  update(dt: number): void {
    this.intro = Math.max(0, this.intro - dt);
    this.inputLock = Math.max(0, this.inputLock - dt);
    this.updateConfetti(dt);
    this.trailFade.update(dt);
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
      // パットの方向だけは元のゆっくりした針。ほかはライごとの速さに、場面の役割（遠いほど方向、近いほど距離が速い）を掛ける。
      const lie = this.putting ? 'green' : this.ball.lie;
      const role = this.role;
      const f =
        this.putting && this.swingStage === 'impact'
          ? PUTT_NEEDLE_SPEED
          : this.hardNeedle
            ? FAST_NEEDLE_SPEED[lie] * (this.swingStage === 'power' ? role.distSpeed : role.dirSpeed)
            : NEEDLE_SPEED[lie];
      // 左端から右へ、右端から左へ、を繰り返す（三角波）。
      const t = (this.needleTime * f) % 2;
      this.needle = -1 + 2 * (t < 1 ? t : 2 - t);
      this.emit();
    }
    if (this.phase === 'moving') this.updateMoving(dt);
    this.rivals?.update(dt, this.target);
    // カップに入った球は穴の中へ沈める。狙う間に大きく描いた球（updateCamera）は、地面に埋まらないよう持ち上げる。
    const sink = this.phase === 'holed' ? BALL_RADIUS * 1.6 : 0;
    const lift = (this.ballMesh.scale.x - 1) * BALL_RADIUS;
    this.ballMesh.position.set(this.ball.pos.x, this.ball.pos.y - sink + lift, this.ball.pos.z);
  }

  private updateMoving(dt: number): void {
    // 地面に着いてから 6 秒たっても転がっていれば、その先は速く進める（ball.ts の rollSpeed）。
    if (this.groundTime !== null) this.groundTime += dt;
    this.ball.update(dt * rollSpeed(this.groundTime));
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
      this.trailFade.settle();
      this.holedViewYaw = this.aimYaw;
      this.holedViewPitch = 0.42;
      this.scores[h.number - 1] = this.strokes;
      this.noteRest(true);
      const under = this.strokes < h.par || this.strokes === 1;
      this.celebrate(this.strokes === 1 || this.strokes <= h.par - 2 ? 260 : under ? 140 : 50);
      if (under) this.onSound({ type: 'cheer', big: this.strokes === 1 || this.strokes <= h.par - 2 });
      this.reportRest(true);
      // COM の相手の残りは打ち切る（スコアカードと結果は rivalsSettled を待って出す）。
      this.rivals?.finish();
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
      this.reportRest(false);
      this.readyToAim();
      return;
    }
    if (this.ball.state === 'rest') {
      // 止まってから少し見せてから、次の一打へ。
      this.restTimer += dt;
      if (this.restTimer > 0.7) {
        this.noteRest(false);
        this.reportRest(false);
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

  /**
   * 輪に落ちる力を求め（aim.ts の solvePower）、狙いの線（弧と、落ちた後の転がり）を引き直す。
   * 狙いの線と輪は「風が無ければ落ちる所」（Golf Clash と同じ）。風の分は風のメーターを見て、輪をずらして読む。
   * 以前は線だけ風で曲げていて、輪と線の落ちる所が食い違って見えた。
   */
  private solve(): void {
    this.solveDirty = false;
    const { power, trial } = solvePower(this.golfGround, this.ball.pos, this.ball.lie, this.clubIndex, this.aimYaw, this.aimDistance);
    const result: Trial = trial;
    // 狙う間に見せるのは、落ちる所までの弧だけ。落ちた後の跳ねと転がりは見せない（利用者の判断。狙いを決めるのに
    // 要らず、線が増えて見づらかった）。パットは転がる線が狙いそのものなので、最初だけ見せる（全部見せると読む楽しさが無くなる）。
    const roll = this.putting ? result.roll.slice(0, Math.max(2, Math.floor(result.roll.length * 0.35))) : [];
    this.power = power;
    setLine(this.arc, result.arc);
    this.arc.computeLineDistances();
    setLine(this.roll, roll);
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
    const step = 1.6;
    const e = 0.4;
    const pos: number[] = [];
    const col: number[] = [];
    const color = new THREE.Color();
    const h = (x: number, z: number) => this.golfGround.height(x, z) + 0.03;
    for (let z = cz - reach; z <= cz + reach; z += step) {
      for (let x = cx - reach; x <= cx + reach; x += step) {
        if (Math.hypot(x - cx, z - cz) > reach) continue;
        const gx = (h(x + e, z) - h(x - e, z)) / (2 * e);
        const gz = (h(x, z + e) - h(x, z - e)) / (2 * e);
        const slope = Math.hypot(gx, gz);
        if (slope < 0.004) continue;
        // 下る向き（d）と横（n）。長さは急さ（1% で 0.5m、5% 以上で 1.1m）。矢印の真ん中を格子の点に置く。
        const dx = -gx / slope;
        const dz = -gz / slope;
        const nx = -dz;
        const nz = dx;
        const len = Math.min(1.1, 0.36 + slope * 14);
        const head = Math.min(0.32, len * 0.45);
        const shaft = 0.045;
        const wing = 0.17;
        const ox = x - dx * len * 0.5;
        const oz = z - dz * len * 0.5;
        // 白（ほぼ平ら）→ 水色 → 黄 → 赤（5% 以上）。
        const t = Math.min(1, slope / 0.05);
        color.setHSL(0.55 - t * 0.55, t < 0.15 ? 0.25 : 0.85, t < 0.15 ? 0.92 : 0.62);
        const at = (along: number, side: number): [number, number, number] => {
          const px = ox + dx * along + nx * side;
          const pz = oz + dz * along + nz * side;
          return [px, h(px, pz), pz];
        };
        const tri = (a: number[], b2: number[], c: number[]) => {
          pos.push(...a, ...b2, ...c);
          for (let k = 0; k < 3; k++) col.push(color.r, color.g, color.b);
        };
        // 軸（細長い四角 = 三角 2 つ）と頭（三角）。
        const s0 = at(0, -shaft);
        const s1 = at(0, shaft);
        const s2 = at(len - head, shaft);
        const s3 = at(len - head, -shaft);
        tri(s0, s1, s2);
        tri(s0, s2, s3);
        tri(at(len - head, -wing), at(len - head, wing), at(len, 0));
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
   * カメラ。狙う間は、球の後ろ・人が立って見下ろすくらいの高さから打つ方を見る（自分の球と、その先の
   * フェアウェイとグリーンが一緒に映る）。傾きは、落とし所を画面の真ん中の少し上に置き、球が画面の下の方に
   * 収まるように決める。以前は球の後ろの高い所（200m 狙いで 30m 後ろ・33m 上）から見下ろしていて、球が画面の
   * 外だった。目の高さ（2m）まで下げると、今度は先が潰れてグリーンが読めなかった（利用者の判断）。
   * パットは低く。動いている間は球を追う。
   */
  updateCamera(camera: THREE.PerspectiveCamera, dt: number): void {
    const p = this.ball.pos;
    const pos = new THREE.Vector3();
    const look = new THREE.Vector3();
    if (this.phase === 'moving') {
      const v = this.ball.vel;
      const hs = Math.hypot(v.x, v.z);
      const dx = hs > 0.5 ? v.x / hs : -Math.sin(this.aimYaw);
      const dz = hs > 0.5 ? v.z / hs : -Math.cos(this.aimYaw);
      const putt = this.putting;
      const back = putt ? 4 : 18;
      pos.set(p.x - dx * back, p.y + (putt ? 2 : 8), p.z - dz * back);
      look.set(p.x, p.y, p.z);
    } else if (this.phase === 'holed') {
      const radius = 19;
      const flat = Math.cos(this.holedViewPitch) * radius;
      const dx = -Math.sin(this.holedViewYaw);
      const dz = -Math.cos(this.holedViewYaw);
      pos.set(p.x - dx * flat, p.y + Math.sin(this.holedViewPitch) * radius, p.z - dz * flat);
      look.set(p.x, p.y + 0.45, p.z);
    } else {
      const dx = -Math.sin(this.aimYaw);
      const dz = -Math.cos(this.aimYaw);
      const d = this.aimDistance;
      if (this.putting) {
        pos.set(p.x - dx * 4.2, p.y + 2.3, p.z - dz * 4.2);
        const ahead = Math.min(d, 8);
        look.set(p.x + dx * ahead, p.y - 0.3, p.z + dz * ahead);
      } else {
        this.aimView(camera, dx, dz, d, pos, look);
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
    // 狙う間は、自分の球を少し大きく描く（カメラが 15m ほど後ろにあると、本当の大きさでは点になる）。
    const aiming = (this.phase === 'aim' || this.phase === 'swing') && !this.putting;
    const far = Math.hypot(camera.position.x - p.x, camera.position.y - p.y, camera.position.z - p.z);
    this.ballMesh.scale.setScalar(aiming ? THREE.MathUtils.clamp(far / 9, 1, AIM_BALL_SCALE) : 1);
    // 風の筋は常に出す（狙う間だけにしたら、風がその時だけ吹いているように見えた。利用者の判断）。
    this.windStreaks.update(dt, camera, this.ball.wind, (x, z) => this.golfGround.height(x, z), true);
  }

  /** 空から見ている間は、風の筋を隠す（カメラが球から離れ、止まった筋が残って見える）。 */
  hideWind(): void {
    this.windStreaks.mesh.visible = false;
  }

  /**
   * 狙う間のカメラ（パット以外）。球の後ろ AIM_BACK・上 AIM_UP に置き、木の中に入るなら球へ寄せる。
   * 落とし所が画面の真ん中の少し上（AIM_LANDING_AT）に来る傾きにし、球が下にはみ出すなら（上りの打ち上げ）
   * 球が AIM_BALL_LOWEST に収まるまで下を向く。
   */
  private aimView(
    camera: THREE.PerspectiveCamera,
    dx: number,
    dz: number,
    d: number,
    pos: THREE.Vector3,
    look: THREE.Vector3,
  ): void {
    const p = this.ball.pos;
    const g = this.golfGround;
    let back = AIM_BACK + d * 0.02;
    const up = AIM_UP + d * 0.016;
    for (const k of [1, 0.6, 0.35]) {
      const x = p.x - dx * back * k;
      const z = p.z - dz * back * k;
      pos.set(x, Math.max(p.y + up, g.height(x, z) + 1.2), z);
      if (!this.inTree(pos)) {
        back *= k;
        break;
      }
    }
    const half = THREE.MathUtils.degToRad(camera.fov / 2);
    const lx = p.x + dx * d;
    const lz = p.z + dz * d;
    const landing = Math.atan2(g.height(lx, lz) - pos.y, back + d);
    const ball = Math.atan2(p.y - pos.y, back);
    let pitch = landing - AIM_LANDING_AT * half;
    if ((ball - pitch) / half < this.aimBallLowest) pitch = ball - this.aimBallLowest * half;
    look.set(pos.x + dx * Math.cos(pitch) * 10, pos.y + Math.sin(pitch) * 10, pos.z + dz * Math.cos(pitch) * 10);
  }

  /** その場所が木の幹か葉の中か（カメラを置けないか）。 */
  private inTree(at: THREE.Vector3): boolean {
    let hit = false;
    this.golfGround.trees?.(at.x, at.z, 8, (t) => {
      const ddx = at.x - t.x;
      const ddz = at.z - t.z;
      const dy = (at.y - t.canopyY) / 0.8;
      const r = t.canopyR + 0.6;
      if (ddx * ddx + ddz * ddz + dy * dy < r * r) hit = true;
      if (at.y < t.trunkTop && Math.hypot(ddx, ddz) < t.trunkR + 0.6) hit = true;
    });
    return hit;
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
      rivals: this.rivals?.states() ?? [],
    });
  }
}

/**
 * 線の点を差し替える。three の setFromPoints は既にある頂点の入れ物を大きさを変えずに使い回すので、
 * 点が減ると前の線の残りが描かれ、増えると入りきらない（最初に空で作った軌跡が描かれなかった）。
 */
function setLine(line: THREE.Line, points: readonly Point3[]): void {
  line.geometry.dispose();
  line.geometry = new THREE.BufferGeometry().setFromPoints(points.map((p) => new THREE.Vector3(p.x, p.y, p.z)));
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
