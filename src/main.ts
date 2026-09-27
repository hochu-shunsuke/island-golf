import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import './style.css';
import './touch.css';
import type { Island } from './island/generate';
import { EROSION_RES, FULL_RES, ISLAND_SIZE } from './island/grid';
import { LOAD_STEPS } from './island/loadSteps';
import { IslandGround } from './island/ground';
import { type IslandParams, cleanSeed, courseParams, dailySeed, randomSeed } from './island/params';
import { dayIndex, dayLabel } from './core/day';
import type { GenerateRequest, GenerateResult, WorkerResult } from './island/worker';
import { Player } from './player/controller';
import { ChunkManager } from './render/chunkManager';
import { FarForest } from './render/farForest';
import { setIslandLight, updateIslandLight } from './render/islandLight';
import { OverviewMesh } from './render/overviewMesh';
import { MORNING, Sky } from './render/sky';
import { Water } from './render/water';
import { type PlayMode, type RoundResult, type ScoreRow, type StandingRow, Overlay } from './ui/overlay';
import { RIVALS, Rivals } from './golf/rivals';
import { Peers, peerColor } from './golf/peers';
import type { Opponents } from './golf/opponents';
import { RoomClient, type RoomStatus } from './net/room';
import { type RoomView, cleanName, isRoomId, newRoomId } from '../shared/room';
import type { OpponentState } from './golf/opponents';
import { type TouchControls, createTouchControls, hasTouchInput, isTouchDevice } from './ui/touch';
import { Flyover } from './view/flyover';
import { FinaleCamera } from './view/finale';
import { IslandWater } from './world/islandWater';
import { Terrain } from './world/terrain';
import { type Hole, holeArea } from './golf/course';
import { CourseField, type FieldArrays } from './golf/field';
import { GolfGame, type GolfStatus, scoreName, toPar } from './golf/game';
import { AudioEngine } from './audio/engine';
import { HoleMap } from './ui/holeMap';
import { GolfSounds } from './audio/golfSounds';
import { Music } from './audio/music';

/**
 * Hole in Isle（コード名 island-golf）。コース ID から、山に囲まれた島と 9 ホールのコースを生成する。
 * 合言葉は URL の `#` に載るので、URL を送れば同じ島・同じコースを渡せる。ピンと風は日ごとに替わる。
 *
 * 開くと、暗い読み込み画面から島の空撮（開始画面）へ。「プレイ」で 1 番のティーから回り、F で空から見る。
 * 入口と操作は stroll と同じ（Pointer Lock とタッチの切り替え、iOS Safari の入力の誤報への備え、Esc で休憩、
 * 最初の 15 秒の操作ガイド）。
 */

const LOOK_SENSITIVITY = 0.0022;
/** 霧。見渡すときは島全体が見えるよう薄く、飛ぶときは奥行きが出るよう少し濃く。 */
const FOG_MAKE = 0.00007;
const FOG_FLY = 0.0002;
/** コース紹介の空撮の霧（空から見るときと同じ薄さ）。 */
const FOG_ATTRACT = FOG_FLY * 0.5;
/** 画素数の上限。端末名で分けず、画面の大きさと入力方式で決める（stroll と同じ）。 */
const MOBILE_PIXEL_BUDGET = 1_400_000;
const DESKTOP_PIXEL_BUDGET = 8_000_000;
/** スマホはまず高精細で描き、フレームが続けて遅い端末だけ 0.1 ずつ下げる。CSS 1px 未満にはしない。 */
const MOBILE_DPR_MAX = 1.5;
const MOBILE_DPR_MIN = 1;
let mobileDprCap = MOBILE_DPR_MAX;
/** 見渡すときの視野（度）。飛ぶときは stroll と同じく 68°〜82°＋速さ。 */
const MAKE_FOV = 55;
/** 球を打つときの視野（度）。 */
const GOLF_FOV = 58;
/**
 * 回っている間の画角（縦, 度）。縦長の画面では横がとても狭くなる（390×844 で横 29°）ので、横が 40° ほど
 * 映るまで縦の画角を広げる（76° まで）。球の後ろから狙うカメラで、左右の林と先のグリーンが一緒に見えるように。
 */
function golfFov(): number {
  const aspect = Math.max(0.3, innerWidth / Math.max(1, innerHeight));
  const wide = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(20)) / aspect));
  return Math.min(76, Math.max(GOLF_FOV, wide));
}
/** 狙いを回す速さ（マウスは画素あたり、タッチは画素あたりのラジアン）。 */
const AIM_MOUSE = 0.0022;
const AIM_TOUCH = 0.004;

interface WakeLockSentinelLike {
  release(): Promise<void>;
}
interface WakeLockNavigator {
  wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> };
}

const canvas = document.getElementById('view') as HTMLCanvasElement;

const preferredTouch = isTouchDevice();
const touchCapable = hasTouchInput();
let inputMode: 'touch' | 'keys' = preferredTouch ? 'touch' : 'keys';
// 判定はここ 1 か所だけ。CSS もこの結果を見る。
document.documentElement.dataset.input = inputMode;

/** アドレスの # は「合言葉」か、友達を部屋に呼ぶ「合言葉@部屋の番号」。 */
const [hashCourse = '', hashRoom = ''] = location.hash.replace(/^#/, '').split('@');
let params: IslandParams = courseParams(`#${hashCourse}`);
// `#` 無しで開いたら今日のコース（同じ日なら誰でも同じコース。スコアを見せ合える）。
if (!cleanSeed(hashCourse.split('.')[0] ?? '')) params = { ...params, seed: dailySeed(dayIndex()) };
/** ピンと風の日。ふだんは今日、友達の部屋では部屋を作った人の日に合わせる（夜中の 0 時をまたいでも同じピン）。 */
let courseDay = dayIndex();

/** 今日のコースを回っているか。 */
function isDaily(): boolean {
  return params.seed === dailySeed(dayIndex());
}

// ── 描画 ───────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: 'high-performance',
  // reversedDepthBuffer は使わない。three r185 で有効にすると、遠くの陸の上に海の板が
  // かぶって島の奥半分が白く覆われた（polygonOffset の向きを直しても消えず、原因は未特定）。
});
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(MAKE_FOV, 1, 0.5, 60000);
camera.rotation.order = 'YXZ';

const sky = new Sky(scene, MORNING);
const fog = scene.fog as THREE.FogExp2;
fog.density = FOG_MAKE;
const water = new Water(scene, sky.sunDirection, MORNING.horizon, MORNING.sun);
const overview = new OverviewMesh(water.material);
scene.add(overview.group);
const farForest = new FarForest();
scene.add(farForest.group);

const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 40, 0);
camera.position.set(0, ISLAND_SIZE * 0.55, ISLAND_SIZE * 0.85);
controls.enableDamping = true;
controls.maxPolarAngle = 1.45;
controls.minDistance = 250;
controls.maxDistance = ISLAND_SIZE * 2;
controls.update();

/** スマホは画素密度が高い割に描画性能が低い。上限を下げて滑らかさを優先する。 */
function resizeRenderer(): void {
  const width = Math.max(1, innerWidth);
  const height = Math.max(1, innerHeight);
  const budget = inputMode === 'touch' ? MOBILE_PIXEL_BUDGET : DESKTOP_PIXEL_BUDGET;
  const budgetRatio = Math.sqrt(budget / (width * height));
  const deviceCap = inputMode === 'touch' ? mobileDprCap : 2;
  renderer.setPixelRatio(Math.max(0.75, Math.min(devicePixelRatio, deviceCap, budgetRatio)));
  renderer.setSize(width, height);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}
resizeRenderer();

// ── 画面 ───────────────────────────────────────────────
const overlay = new Overlay(document.getElementById('ui')!, params, inputMode === 'touch', touchCapable, {
  // 友達と: 回っている途中でなければ、部屋の窓を開く（無ければ部屋を作る）。
  onStart: (pointerType) => {
    if (playMode === 'friends' && !party?.inRound) {
      openRoom();
      return;
    }
    handleStart(pointerType);
  },
  // 「IDで入る」: 友達から聞いたコースの合言葉へ。
  onSeed: (seed) => {
    const clean = cleanSeed(seed);
    if (!clean || clean === params.seed) return;
    leaveRoom();
    params = { ...params, seed: clean };
    overlay.setParams(params);
    commit();
  },
  // サイコロ: 合言葉を振り直して、別のコースを引く。
  onRandom: () => newCourse(),
  // ラウンドの終わり: 1 番のティーへ（暗転して読み込み直す）。PC はこの押下でマウスを取り直す。
  onAgain: () => {
    if (!golf) return;
    // 友達と: 部屋の窓へ戻る（「もう一度はじめる」は誰が押してもよい）。
    if (playMode === 'friends') {
      leaveFinale();
      stopPlaying();
      overlay.show();
      openRoom();
      return;
    }
    leaveFinale();
    goNextHole();
    if (inputMode === 'keys' && document.pointerLockElement !== canvas) void requestMouseLock();
  },
  // 今日のコースへ戻る。
  onToday: () => {
    if (isDaily()) return;
    leaveRoom();
    courseDay = dayIndex();
    params = { ...params, seed: dailySeed(dayIndex()) };
    overlay.setParams(params);
    commit();
  },
  // 遊び方を替えた: 覚えておき、COM の相手を置き直して 1 番のティーから回り直す。
  onMode: (mode) => {
    playMode = mode;
    try {
      localStorage.setItem(MODE_KEY, mode);
    } catch {
      // 覚えられない環境では、この画面の間だけ。
    }
    // 友達と以外にしたら、部屋から出る。
    if (mode !== 'friends' && party) {
      leaveRoom();
      overlay.flash('部屋を出ました。');
    }
    applyRivals();
    updatePartyLabel();
  },
  onJoinRoom: (id) => joinRoom(id),
  // 友達との 2 つ目のボタン: 部屋に入っていなければ「部屋に入る」（番号を入れる）、入っていれば「友達を呼ぶ」。
  onFriendsSecondary: () => (party ? openRoom() : overlay.openJoinRoom()),
  onRoomAction: (pointerType) => roomAction(pointerType),
  onRoomLeave: () => leaveRoom(),
  onRoomName: (name) => {
    playerName = cleanName(name) || 'ゲスト';
    try {
      localStorage.setItem(NAME_KEY, playerName);
    } catch {
      // 覚えられない環境では、この画面の間だけ。
    }
    party?.client.send({ t: 'name', name: playerName });
    overlay.setRoomName(playerName);
  },
  // ラウンドの終わり: 開始画面へ戻って、別のコースを引く。
  onNewCourse: () => {
    leaveFinale();
    stopPlaying();
    overlay.show();
    newCourse();
  },
});

// ── 遊び方（ひとりで・COM と対戦・友達と） ────────────────────────
/** 遊び方はこの端末に覚えておく。初めてはひとりで（利用者が決めた）。 */
const MODE_KEY = 'hole-in-isle:mode';
let playMode: PlayMode = (() => {
  try {
    const saved = localStorage.getItem(MODE_KEY);
    return saved === 'com' || saved === 'friends' ? saved : 'solo';
  } catch {
    return 'solo';
  }
})();
// 部屋に呼ぶリンクで開いたら、友達と。
if (isRoomId(hashRoom)) playMode = 'friends';
overlay.setMode(playMode);

/**
 * 遊び方に合わせた相手。COM の乱数の元は合言葉と日付（同じコース・同じ日なら COM も同じ打ち方をする）。
 * 友達とは、入っている部屋の人（部屋に入っていなければ、まだひとり）。
 */
function makeOpponents(game: GolfGame): Opponents | null {
  if (playMode === 'friends') {
    if (!party) return null;
    party.peers = new Peers(game.ground);
    if (party.view) party.peers.setRoom(party.view, party.me);
    return party.peers;
  }
  return playMode === 'com' ? new Rivals(RIVALS, game.ground, `${params.seed}:${dayIndex()}`) : null;
}

// ── 友達と（部屋） ────────────────────────────────────
/** 入っている部屋。 */
interface Party {
  id: string;
  client: RoomClient;
  /** 部屋での自分の番号（入れるまで空）。 */
  me: string;
  view: RoomView | null;
  peers: Peers | null;
  status: RoomStatus;
  /** 今の回りに自分も加わっているか（「はじめる」「n 番から入る」を押した）。回りが終わると外れる。 */
  inRound: boolean;
  /** 「はじめる」を送って、部屋が始まったと返すのを待っている（その間に届いた前の様子で inRound を外さない）。 */
  starting: boolean;
}
/** 入っている部屋（入っていなければ null）。 */
let party: Party | null = null;

/** 部屋で見せる名前（この端末に覚えておく）。 */
const NAME_KEY = 'hole-in-isle:name';
let playerName = (() => {
  try {
    return cleanName(localStorage.getItem(NAME_KEY)) || 'ゲスト';
  } catch {
    return 'ゲスト';
  }
})();

/** 部屋の窓を開く（入っていなければ、新しい部屋を作る）。 */
function openRoom(): void {
  if (party) {
    renderRoom();
    overlay.showRoom(true);
    return;
  }
  joinRoom(newRoomId());
}

/**
 * 部屋に入る（無ければ、この番号で作られる。作る人のコースと日が部屋のコースになる）。
 * 部屋の窓を開き、アドレスを「合言葉@部屋の番号」にする（読み直しても同じ部屋へ戻る）。
 */
function joinRoom(id: string): void {
  if (party?.id === id) {
    openRoom();
    return;
  }
  leaveRoom();
  const client = new RoomClient(
    id,
    () => ({ name: playerName, seed: params.seed, day: courseDay, pars: course.map((h) => h.par) }),
    {
      onWelcome: (me, view) => {
        if (!party) return;
        party.me = me;
        onRoomView(view);
      },
      onRoom: (view) => onRoomView(view),
      onShot: (who, hole, shot) => party?.peers?.onShot(who, hole, shot),
      onRest: (who, hole, rest) => party?.peers?.onRest(who, hole, rest),
      onStatus: (status) => {
        if (!party) return;
        party.status = status;
        if (status === 'full') {
          overlay.flash('この部屋は満員です（4 人まで）。');
          leaveRoom();
          return;
        }
        renderRoom();
      },
    },
  );
  party = { id, client, me: '', view: null, peers: null, status: 'connecting', inRound: false, starting: false };
  if (playMode !== 'friends') {
    playMode = 'friends';
    overlay.setMode('friends');
  }
  applyRivals();
  history.replaceState(null, '', addressHash());
  renderRoom();
  overlay.showRoom(true);
  updatePartyLabel();
}

/** 部屋を出る。 */
function leaveRoom(): void {
  if (!party) return;
  party.client.close();
  party = null;
  overlay.showRoom(false);
  history.replaceState(null, '', addressHash());
  if (golf) golf.setOpponents(makeOpponents(golf));
  updatePartyLabel();
}

/** 部屋の様子が届いた。 */
function onRoomView(view: RoomView): void {
  if (!party) return;
  // 入った・出た人を知らせる（先に始めて待っている人が、友達が来たのに気づけるように）。
  const before = party.view;
  if (before && party.me) {
    const others = (v: RoomView) => v.players.filter((p) => p.id !== party!.me);
    for (const p of others(view)) if (!before.players.some((q) => q.id === p.id)) overlay.flash(`${p.name} が入りました`);
    for (const p of others(before)) if (!view.players.some((q) => q.id === p.id)) overlay.flash(`${p.name} が部屋を出ました`);
  }
  party.view = view;
  if (view.phase === 'play') party.starting = false;
  else if (!party.starting) party.inRound = false;
  // 回っている途中で長く切れていて、部屋が回りから外していたら（待ち時間を過ぎた）、加わり直す。
  const mine = view.players.find((p) => p.id === party!.me);
  if (party.inRound && view.phase === 'play' && mine && !mine.playing) party.client.send({ t: 'start' });
  // 部屋のコースに合わせる（リンクの合言葉や日と違えば作り直す）。
  if (view.seed !== params.seed || view.day !== courseDay) {
    params = { ...params, seed: view.seed };
    courseDay = view.day;
    overlay.setParams(params);
    commit();
  }
  party.peers?.setRoom(view, party.me);
  // 部屋が次のホールへ進めた（待ち時間が過ぎた）のに、まだ入れていなければ、部屋が付けた打数（ダブルパー）で打ち切る。
  if (golf && party.inRound && view.phase !== 'lobby' && golf.phase !== 'holed') {
    const behind = view.phase === 'done' || view.hole > golf.target.number;
    const given = view.players.find((p) => p.id === party!.me)?.scores[golf.target.number - 1];
    if (behind && given != null) {
      golf.concede(given);
      overlay.flash('時間切れ。このホールはダブルパーで次へ。');
      holedCardAt = performance.now();
      if (golf.target.number === golf.course.length) {
        const t = sumScores(golf.roundScores, golf.course.map((h) => h.par));
        finalePending = { total: t.total, totalPar: t.par };
      }
    }
  }
  renderRoom();
  updatePartyLabel();
}

/** 部屋の窓の中身を描き直す。 */
function renderRoom(): void {
  if (!party) return;
  const v = party.view;
  const me = party.me;
  const status =
    party.status !== 'open' || !v
      ? 'つないでいます…'
      : v.phase === 'play'
        ? party.inRound
          ? `${v.hole} 番を回っています。友達は途中からでも入れます。`
          : `みんなが ${v.hole} 番を回っています。途中から入れます。`
        : v.phase === 'done'
          ? '1 ラウンド終わりました。もう一度回れます。'
          : '番号を伝えるかリンクを送ると、友達が入れます。先に始めても、友達はあとから入れます。';
  let action: { label: string; enabled: boolean } | null = null;
  if (v && party.status === 'open') {
    if (v.phase !== 'play') action = { label: v.phase === 'done' ? 'もう一度はじめる' : 'はじめる', enabled: sceneReady };
    else action = { label: party.inRound ? '続きへ' : `${v.hole} 番から入る`, enabled: sceneReady };
  }
  overlay.setRoom({
    id: party.id,
    link: `${location.origin}${location.pathname}#${params.seed}@${party.id}`,
    status,
    players: (v?.players ?? []).map((p) => ({
      name: p.name,
      color: p.id === me ? null : peerColor(p.slot),
      you: p.id === me,
      online: p.online,
      note: !p.online ? '離席中' : v?.phase === 'play' ? (p.playing ? 'プレイ中' : '準備中') : null,
    })),
    action,
  });
  // 部屋での名前（同じ名前の人がいれば、部屋が番号を付けている）。
  overlay.setRoomName(v?.players.find((p) => p.id === me)?.name ?? playerName);
}

/**
 * 部屋の窓の大きなボタン。始まっていなければ「はじめる」（誰が押してもよい）、始まっていれば途中から加わる
 * （もう加わっていれば続きへ）。押した本人はそのまま回り始める。
 */
function roomAction(pointerType: string): void {
  const v = party?.view;
  if (!party || !v || !ground) return;
  if (v.phase !== 'play') {
    party.client.send({ t: 'start' });
    party.starting = true;
    beginPartyRound(1, null, pointerType);
    return;
  }
  if (party.inRound) {
    overlay.showRoom(false);
    handleStart(pointerType);
    return;
  }
  // 途中から: 部屋が覚えている自分の打数（読み直した人）を戻して、今のホールから。
  party.client.send({ t: 'start' });
  const mine = v.players.find((p) => p.id === party!.me);
  beginPartyRound(v.hole, mine?.scores ?? null, pointerType);
}

/** 友達とのラウンドを始める（Pointer Lock は押した操作の中でしか取れないので、ボタンから直接呼ぶ）。 */
function beginPartyRound(hole: number, scores: readonly (number | null)[] | null, pointerType: string): void {
  if (!ensureGolf() || !golf || !party) return;
  party.inRound = true;
  overlay.showRoom(false);
  leaveFinale();
  holedCardAt = 0;
  golf.setOpponents(makeOpponents(golf));
  if (hole > 1) golf.resumeRound(scores ?? [], golf.course[hole - 1]);
  handleStart(pointerType);
  updatePartyLabel();
}

/**
 * 友達とのときのボタン（その時にできることを 1 つずつ）:
 * 部屋に入っていない → 「部屋を作る」「部屋に入る」。部屋にいてまだ回っていない → 「部屋を開く」だけ。
 * 回っている途中（休憩中） → 「続きから」「友達を呼ぶ」。
 */
function updatePartyLabel(): void {
  overlay.setCourseLocked(playMode === 'friends' && party ? party.id : null);
  if (playMode !== 'friends') {
    overlay.setStartLabel(null);
    return;
  }
  if (!party) {
    overlay.setStartLabel('部屋を作る');
    overlay.setFriendsSecondary('部屋に入る');
  } else if (party.inRound) {
    overlay.setStartLabel(null);
    overlay.setFriendsSecondary('友達を呼ぶ');
  } else {
    overlay.setStartLabel('部屋を開く');
    overlay.setFriendsSecondary(null);
  }
}

/**
 * 友達と: 次のティーへ進んだとき、部屋がもっと先のホールへ進んでいれば（スコアカードを見たまま休んでいる間に、
 * 待ち時間が過ぎた）、部屋のホールへ飛ぶ。飛ばしたホールの打数は部屋が付けたもの（ダブルパー）。
 */
function catchUpToRoom(): void {
  const v = party?.view;
  if (!golf || !party?.inRound || v?.phase !== 'play' || v.hole <= golf.target.number) return;
  const mine = v.players.find((p) => p.id === party!.me);
  golf.resumeRound(mine?.scores ?? [], golf.course[v.hole - 1]);
}

/** 今のアドレスの #（部屋に入っていれば「合言葉@部屋の番号」、今日のコースなら無し）。 */
function addressHash(): string {
  if (party) return `#${params.seed}@${party.id}`;
  return isDaily() ? location.pathname : `#${params.seed}`;
}

/** 遊び方に合わせて相手を置き直し、1 番のティーから回り直す（回っている途中なら、続きは捨てる）。 */
function applyRivals(): void {
  if (!golf) return;
  leaveFinale();
  holedCardAt = 0;
  finalePending = null;
  golf.setOpponents(makeOpponents(golf));
  if (entered) {
    entered = false;
    overlay.resetEntered();
  }
}

/** スコアカードの行（自分と COM）。 */
function scoreRows(status: GolfStatus): ScoreRow[] {
  return [
    { label: 'あなた', scores: status.scores, you: true },
    ...status.rivals.map((r) => ({ label: r.name, scores: r.scores, color: r.color })),
  ];
}

/** 回り終えたホールの打数の合計と、そのパーの合計。 */
function sumScores(scores: readonly (number | null | undefined)[], pars: readonly number[]): { total: number; par: number } {
  let total = 0;
  let par = 0;
  pars.forEach((p, k) => {
    const s = scores[k];
    if (s == null) return;
    total += s;
    par += p;
  });
  return { total, par };
}

/** 順位（回り終えたホールのパーとの差で。同じなら同じ順位）。COM も部屋もなければ null。 */
function standingsOf(status: GolfStatus, pars: readonly number[]): StandingRow[] | null {
  if (status.rivals.length === 0 && !party) return null;
  const me = sumScores(status.scores, pars);
  const rows = [
    {
      name: 'あなた',
      color: null,
      you: true,
      diff: me.total - me.par,
      total: me.total,
      par: me.par,
      now: status.phase === 'holed' ? '✓' : status.strokes === 0 ? 'ティー' : `${status.strokes} 打`,
    },
    ...status.rivals.map((r) => {
      const t = sumScores(r.scores, pars);
      return {
        name: r.name,
        color: r.color,
        you: false,
        diff: t.total - t.par,
        total: t.total,
        par: t.par,
        now: r.away ? '離席中' : r.idle ? '準備中' : r.holed ? '✓' : r.strokes === 0 ? 'ティー' : `${r.strokes} 打`,
      };
    }),
  ].sort((a, b) => a.diff - b.diff);
  return rows.map((r) => ({
    rank: 1 + rows.filter((x) => x.diff < r.diff).length,
    name: r.name,
    color: r.color,
    total: toPar(r.total, r.par),
    now: r.now,
    you: r.you,
  }));
}

/** 合言葉を振り直して、別のコースを引く（部屋にいれば出る。部屋のコースは部屋を作った人のもの）。 */
function newCourse(): void {
  leaveRoom();
  courseDay = dayIndex();
  params = { ...params, seed: randomSeed() };
  overlay.setParams(params);
  commit();
}

// ── 島の計算 ───────────────────────────────────────────
// Worker は 1 つ。計算中に新しい依頼が来たら最新の 1 件だけを取っておき、終わったら流す。
const worker = new Worker(new URL('./island/worker.ts', import.meta.url), { type: 'module' });
let nextId = 1;
/** 最後に頼んだ島。これが描かれるまで「プレイ」を押せない。 */
let lastRequested = 0;
/**
 * 最後に頼んだ島が、木と光まで全部揃ったか。揃うまでは画面を暗くしたまま、「プレイ」のボタンに作っている段階を出す
 * （途中の島を見せると、空撮の途中で木が生え、光が変わるのが見えてしまう）。
 */
let sceneReady = false;
/** 読み込み中の暗転の濃さ（別のコースへ替えるときは、今の絵からゆっくり暗くする）。 */
let loadingCurtain = 1;
/** 暗転中も、形やテクスチャを差し替えた直後だけ 1 枚描いて GPU の準備を済ませる。 */
let renderWarmupNeeded = true;
let busy = false;
let pending: GenerateRequest | null = null;
let drawnId = 0;
let ground: IslandGround | null = null;
let player: Player | null = null;
/** 今の島（島全体の格子）と、それを 1 点ずつ引く地形。飛ぶときにチャンクへ渡す。 */
let island: Island | null = null;
let terrain: Terrain | null = null;
let chunks: ChunkManager | null = null;
let madeParams: IslandParams | null = null;
/** 造成の格子を引くもの（ホールの小さな地図に使う）。 */
let courseSampler: CourseField | null = null;
/** 今見せているコースの合言葉（変わったら、遊んでいた続きを捨てる）。 */
let shownSeed = '';
/** この島のコース（遊ぶために設計したホール）と、地形の造成の格子（golf/field.ts）。 */
let course: Hole[] = [];
let courseField: FieldArrays | null = null;

function request(): void {
  const sun = sky.sunDirection;
  const req: GenerateRequest = {
    id: nextId++,
    params: { ...params },
    n: FULL_RES,
    erosionN: EROSION_RES,
    // 遠景だけを 1 点おきにする。島の生成・ゴルフ物理・近景チャンクは FULL_RES のまま。
    overviewStep: preferredTouch ? 2 : 1,
    sun: [sun.x, sun.y, sun.z],
    // ピン位置は日ごとに替わる（同じ URL なら、同じ日は誰でも同じピン）。
    day: courseDay,
  };
  lastRequested = req.id;
  sceneReady = false;
  overlay.setReady(false);
  overlay.setLoading(LOAD_STEPS[0], 0, LOAD_STEPS.length);
  if (busy) {
    pending = req;
    return;
  }
  busy = true;
  worker.postMessage(req);
}

function show(msg: GenerateResult): void {
  const { island: next, params: made } = msg;
  island = next;
  madeParams = made;
  course = msg.course.holes;
  courseField = msg.course.field;
  // 島（とホール）が変わったら、回っていたゲームは作り直す。
  if (golf) {
    scene.remove(golf.group);
    golf = null;
  }
  // 別のコースになったら、空から見ていた状態と「続きから」も捨て、1 番のティーから始める。
  // 残すと、休憩中に合言葉を変えても前の島の空の位置から続いた（利用者が踏んだ）。
  if (shownSeed !== made.seed) {
    shownSeed = made.seed;
    scout = false;
    entered = false;
    overlay.resetEntered();
    updatePartyLabel();
  }
  const field = courseField ? new CourseField(courseField) : null;
  courseSampler = field;
  terrain = new Terrain(made, next.landscape, new IslandWater(next.water), field);
  // 見渡す島の 1 枚と地図は Worker が作ってある。ここでは貼るだけ（画面を止めない）。
  overview.set(msg.overview, msg.overviewWater);
  renderWarmupNeeded = true;
  // 水深は川に合わせて彫った後の高さで測る。彫る前の高さだと川の中が浅瀬扱いになり、
  // 川幅いっぱいに岸の泡が立って雪の土手のように見えた。
  const carved = next.landscape.height.map((h, k) => h + next.water.carve[k]);
  // コースの池の底も水深に入れる（入れないと、池が岸の浅瀬の色と泡になる）。
  if (field) {
    const ln = next.landscape.n;
    for (let j = 0; j < ln; j++) {
      for (let i = 0; i < ln; i++) {
        const x = (i / (ln - 1) - 0.5) * ISLAND_SIZE;
        const z = (j / (ln - 1) - 0.5) * ISLAND_SIZE;
        const pond = field.waterAt(x, z);
        if (Number.isFinite(pond)) carved[j * ln + i] = Math.min(carved[j * ln + i], pond - 1.4);
      }
    }
  }
  water.setHeightMap(carved, next.landscape.n);
  if (ground) ground.terrain = terrain;
  else ground = new IslandGround(terrain);
  // 木は島の後から届く。古い島の木を残すと地形と食い違う。
  farForest.clear();
}

worker.onmessage = (ev: MessageEvent<WorkerResult>) => {
  const msg = ev.data;
  if (msg.type === 'progress') {
    if (msg.id === lastRequested) overlay.setLoading(LOAD_STEPS[msg.step], msg.step, LOAD_STEPS.length);
    return;
  }
  if (msg.type === 'forest') {
    if (msg.id === drawnId) {
      farForest.set(msg.forest);
      renderWarmupNeeded = true;
    }
    // 光はこのあと約 0.7 秒で届き、もともと 0.6 秒かけて浮かび上がる作り。
    // 林が揃った時点で空撮の暗転を明け始めれば、光の計算を黒い 1.1 秒の中へ隠せる。
    if (msg.id === drawnId && msg.id === lastRequested) {
      sceneReady = true;
      overlay.setReady(true);
      renderRoom();
    }
    return;
  }
  if (msg.type === 'light') {
    // 光は島の後から届く。今見せている島の光だけを使う。
    if (msg.id === drawnId) {
      setIslandLight(msg.lighting);
      renderWarmupNeeded = true;
    }
    // Worker は光まで計算し終えたので、次の島を頼める。
    busy = false;
    if (pending) {
      const req = pending;
      pending = null;
      busy = true;
      worker.postMessage(req);
    }
    return;
  }
  if (msg.id > drawnId) {
    drawnId = msg.id;
    show(msg);
    prepareCourseView();
    const par = course.reduce((a, h) => a + h.par, 0);
    const len = Math.round(course.reduce((a, h) => a + h.length, 0));
    const best = readBest(msg.params.seed);
    const bestText = best ? ` · 自己ベスト ${best.total}（${toPar(best.total, best.par)}）` : '';
    overlay.setStatus(`${course.length} ホール · パー ${par} · ${len.toLocaleString('ja-JP')} m${bestText}`);
  }
};

function commit(): void {
  // 今日のコースは `#` を付けない（読み直しても、次の日に開いても、その日の今日のコースになる）。
  history.replaceState(null, '', addressHash());
  overlay.setDaily(isDaily() ? dayLabel() : null);
  request();
}

// ── 回る（入口と操作は stroll と同じ） ─────────────────
/** 遊んでいる最中か。PC はポインタロックの有無と一致するが、タッチにはロックが無いので状態で持つ。 */
let playing = false;
let entered = false;
let touchControls: TouchControls | null = null;
let wakeLock: WakeLockSentinelLike | null = null;
let lastAutoFlight = false;
/** 今のホールを回っているゲーム。島を作り直すと作り直す。 */
let golf: GolfGame | null = null;
/** 空から見ている（stroll と同じ飛ぶ操作）。F で行き来する。 */
let scout = false;

function setInputMode(next: 'touch' | 'keys'): void {
  if (inputMode === next) return;
  inputMode = next;
  if (next === 'touch' && document.pointerLockElement) document.exitPointerLock();
  document.documentElement.dataset.input = next;
  overlay.setInputMode(next === 'touch');
  applyTouchUi();
  resizeRenderer();
}

/** タッチの操作ボタンを、今の遊び方（ゴルフ／空から）に合わせて出し分ける。 */
function applyTouchUi(): void {
  const touchNow = playing && inputMode === 'touch';
  touchControls?.setActive(touchNow && scout);
  overlay.setGolfTouch(touchNow && golf !== null, scout);
}

/** ホールを回るゲームを用意する。ホールが無い島（小さすぎる・全部が山や水）なら null。 */
function ensureGolf(): GolfGame | null {
  if (golf || !terrain || course.length === 0) return golf;
  golf = new GolfGame(
    terrain,
    course,
    (status) => {
      overlay.setGolf(playing && !scout ? status : null);
      lastStatus = status;
    },
    (text) => overlay.flash(text),
    (x, z, r, visit) => chunks?.treesNear(x, z, r, visit),
    (e) => {
      if (!sounds) return;
      if (e.type === 'hit') sounds.hit(e.kind, e.strength, e.perfect);
      else if (e.type === 'land') sounds.land(e.surface, e.speed);
      else if (e.type === 'splash') sounds.splash();
      else if (e.type === 'cup') sounds.cup();
      else if (e.type === 'cheer') sounds.cheer(e.big);
      else sounds.ready();
    },
  );
  golf.onShotFeedback = (kind) => overlay.shotFeedback(kind);
  golf.onHoled = (hole, strokes, total, totalPar, last) => {
    overlay.celebrate(scoreName(strokes, hole.par), strokes === 1 || strokes <= hole.par - 2);
    // COM の相手が残りを打ち切るのを待ってから、結果（最後のホール）かスコアカードを出す。
    if (last) finalePending = { total, totalPar };
    else holedCardAt = performance.now() + HOLED_CARD_DELAY;
  };
  // 遊び方に合わせて相手を置く（初めは 1 番のティーから）。
  golf.setOpponents(makeOpponents(golf));
  // 友達と: 自分の一打と止まった所を部屋へ（友達の画面で同じように飛ぶ）。
  golf.onPlayerShot = (hole, shot) => {
    if (playMode === 'friends') party?.client.send({ t: 'shot', hole, shot });
  };
  golf.onPlayerRest = (hole, rest) => {
    if (playMode === 'friends') party?.client.send({ t: 'rest', hole, rest });
  };
  // 開始画面の空撮の間は、打つための目印を出さない（遊び始めたら出す）。
  golf.aids.visible = playing;
  scene.add(golf.group);
  return golf;
}

/** ホールの小さな地図。 */
const holeMap = new HoleMap(overlay.holeMapCanvas);

// ── 音・スコアカード・自己ベスト ─────────────────────────
/** 音（最初に入るとき＝利用者の操作の中で作る。ブラウザの決まり）。 */
let audio: AudioEngine | null = null;
let sounds: GolfSounds | null = null;
let music: Music | null = null;
function ensureAudio(): void {
  try {
    if (!audio) {
      audio = new AudioEngine();
      sounds = new GolfSounds(audio);
      music = new Music(audio);
    }
    audio.resume();
  } catch {
    // 音が出せない環境でも遊べるようにする。
  }
}
/** 最後に届いたゴルフの表示（スコアカードに使う）。 */
let lastStatus: import('./golf/game').GolfStatus | null = null;
/** Tab を押している間はスコアカードを出す。 */
let scorecardHeld = false;
/**
 * カップインの後のスコアカードを出す時刻（0 なら出さない）。お祝いの文字を見せてから出し、
 * 押すまで出したままにする（見終わったら押して次のティーへ）。
 */
let holedCardAt = 0;
const HOLED_CARD_DELAY = 1300;
/** 最後のホールを入れた後、COM の相手が打ち終えるのを待っている間の、自分の合計（揃ったら結果を出す）。 */
let finalePending: { total: number; totalPar: number } | null = null;

/** 自己ベスト（合言葉ごと、この端末だけ）。読めない・書けない環境では何もしない。 */
function bestKey(seed: string): string {
  return `island-golf:best:${seed}`;
}
function readBest(seed: string): { total: number; par: number } | null {
  try {
    const raw = localStorage.getItem(bestKey(seed));
    return raw ? (JSON.parse(raw) as { total: number; par: number }) : null;
  } catch {
    return null;
  }
}
function writeBest(seed: string, total: number, par: number): void {
  try {
    localStorage.setItem(bestKey(seed), JSON.stringify({ total, par }));
  } catch {
    // 書けない環境では覚えない。
  }
}

// ── ラウンドの終わり ────────────────────────────────────
/** ラウンドの結果（最後のホールを入れてから、次のラウンドを始めるまで）。休憩から戻ったときもまた出す。 */
let roundResult: RoundResult | null = null;
/** 最後のグリーンの周りを回るカメラ。 */
let finaleCam: FinaleCamera | null = null;
/** 結果の窓を出す時刻（0 なら出している・出さない）。お祝いと紙吹雪を見せてから出す。 */
let roundResultAt = 0;

/** 1 ホールの打数を、共有する文の印に（入れた 1 打・イーグル以上・バーディ・パー・ボギー・それ以上）。 */
function scoreEmoji(s: number | undefined, par: number): string {
  if (s === undefined) return '▫️';
  if (s === 1) return '⭐';
  const d = s - par;
  return d <= -2 ? '🟡' : d === -1 ? '🔵' : d === 0 ? '⚪' : d === 1 ? '🟧' : '🟥';
}

/** 最後のホールを入れた: 結果をまとめ、自己ベストを付け、締めの絵に切り替える。 */
function startFinale(total: number, totalPar: number): void {
  if (!golf) return;
  const seed = params.seed;
  const best = readBest(seed);
  const newBest = !best || total < best.total;
  if (newBest) writeBest(seed, total, totalPar);
  const pars = golf.course.map((h) => h.par);
  const scores = [...golf.roundScores];
  const stats = golf.roundStats;
  const dateLabel = dayLabel();
  const daily = isDaily();
  const marks = pars.map((p, k) => scoreEmoji(scores[k], p)).join('');
  // COM や友達と回ったときの順位（同じなら同じ順位）。
  const rivals = golf.rivalStates;
  const entries = [
    { name: 'あなた', total, par: totalPar, you: true, color: null as number | null },
    ...rivals.map((r) => {
      const t = sumScores(r.scores, pars);
      return { name: r.name, total: t.total, par: t.par, you: false, color: r.color as number | null };
    }),
  ].sort((a, b) => a.total - a.par - (b.total - b.par));
  // 回ったホールのパーとの差で比べる（友達と: 途中から入った人は回ったホールが少ない）。
  const ranking =
    rivals.length === 0
      ? []
      : entries.map((e) => ({
          rank: 1 + entries.filter((x) => x.total - x.par < e.total - e.par).length,
          name: e.name,
          total: e.total,
          toPar: toPar(e.total, e.par),
          you: e.you,
          color: e.color,
        }));
  const myRank = ranking.find((x) => x.you)?.rank;
  if (myRank === 1) sounds?.cheer(true);
  roundResult = {
    seed,
    dateLabel,
    pars,
    scores,
    total,
    totalPar,
    best,
    newBest,
    gir: stats.filter((st) => st?.gir).length,
    fairway: stats.filter((st) => st?.fairway === true).length,
    fairwayOf: stats.filter((st) => st && st.fairway !== null).length,
    putts: stats.reduce((a, st) => a + (st?.putts ?? 0), 0),
    birdies: pars.filter((p, k) => scores[k] != null && scores[k]! < p).length,
    ranking,
    rivalRows: rivals.map((r) => ({ label: r.name, scores: [...r.scores], color: r.color })),
    shareText: [
      daily ? `Hole in Isle 今日のコース（${dateLabel}）` : `Hole in Isle ${seed}（${dateLabel} のピン）`,
      `${total} 打（${toPar(total, totalPar)}）${myRank ? ` · ${playMode === 'friends' ? '友達' : 'COM'} と ${ranking.length} 人で ${myRank} 位` : ''}`,
      marks,
      // 今日のコースは、`#` 無しのアドレスを送る（開いた人がその日の今日のコースを回れる。Wordle と同じ）。
      daily ? `${location.origin}${location.pathname}` : `${location.origin}${location.pathname}#${seed}`,
    ].join('\n'),
  };
  roundResultAt = performance.now() + 2200;
  enterFinaleView(true);
}

/** 締めの絵: 打つための表示をしまい、最後のグリーンの周りを回る。fromNow なら今のカメラから引いていく。 */
function enterFinaleView(fromNow: boolean): void {
  if (!golf || !terrain) return;
  const t = terrain;
  const ground = (x: number, z: number) => Math.max(0, t.heightAt(x, z));
  const pin = golf.target.pin;
  finaleCam = new FinaleCamera(
    new THREE.Vector3(pin.x, ground(pin.x, pin.z), pin.z),
    fromNow ? camera.position.clone() : null,
    ground,
    reducedMotion,
  );
  golf.aids.visible = false;
  overlay.setFinale(true);
  overlay.setAimLabel(null);
  overlay.setFlagMarkers([]);
}

/** 締めの絵をやめる（次のラウンド・別のコースへ）。 */
function leaveFinale(): void {
  roundResult = null;
  finalePending = null;
  roundResultAt = 0;
  finaleCam = null;
  overlay.hideRoundResult();
  overlay.setFinale(false);
  if (golf) golf.aids.visible = playing;
}

/** カップインの後のスコアカードの見出し（今のホールの打数と名前・通算）と、次へ進む案内。 */
function holedCard(game: GolfGame): { head: string; foot: string } {
  const h = game.target;
  const strokes = game.roundScores[h.number - 1] ?? game.strokes;
  let total = 0;
  let par = 0;
  game.course.forEach((c, k) => {
    const s = game.roundScores[k];
    if (s === undefined) return;
    total += s;
    par += c.par;
  });
  const next = game.course[(game.course.indexOf(h) + 1) % game.course.length];
  const how = inputMode === 'touch' ? 'タップ' : 'クリックかどれかのキー';
  const ranks = lastStatus ? standingsOf(lastStatus, game.course.map((c) => c.par)) : null;
  const rank = ranks?.find((r) => r.you)?.rank;
  // 友達と: みんなが終えるまでは待つ（部屋が次のホールへ進めたら進める）。
  const v = party?.view;
  const waiting = playMode === 'friends' && !game.rivalsSettled && v;
  // 切れている人も数に入れる（部屋は待ち時間まで待つ）。
  const doneCount = v ? v.players.filter((p) => p.playing && p.scores[h.number - 1] != null).length : 0;
  const playingCount = v ? v.players.filter((p) => p.playing).length : 0;
  return {
    head: `<b>${h.number} 番</b> ${strokes} 打 · ${scoreName(strokes, h.par)}<span>通算 ${toPar(total, par)}${rank ? ` · ${rank} 位` : ''}</span>`,
    foot: waiting
      ? `みんなを待っています（${doneCount}/${playingCount}）`
      : h.number === game.course.length
        ? `${how}で結果へ ▸`
        : `${how}で ${next.number} 番のティーへ ▸`,
  };
}

/** カップインの後に押した: スコアカードがまだならすぐ出し、出ていれば次のティーへ。 */
function holedPress(): void {
  // 結果を出している間と、COM の相手がまだ打ち終えていない間（スコアカードがまだ）は進まない。
  if (!golf || roundResult || !golf.rivalsSettled) return;
  if (holedCardAt > performance.now()) {
    holedCardAt = performance.now();
    return;
  }
  holedCardAt = 0;
  goNextHole();
}

/** 空から見るための鳥。球の上空から、打つ向きを見下ろして飛び始める。 */
function preparePlayer(): Player | null {
  if (!ground) return null;
  const from = golf?.ball.pos ?? { x: controls.target.x, z: controls.target.z };
  const yaw = golf?.aimYaw ?? 0;
  const y = Math.max(0, ground.heightAt(from.x, from.z)) + 70;
  if (!player) player = new Player(ground, from.x, from.z);
  player.restore({ x: from.x, y, z: from.z, yaw, pitch: -0.45, flying: true });
  if (touchCapable && !touchControls) {
    touchControls = createTouchControls({
      root: document.getElementById('ui')!,
      surface: canvas,
      player,
      lookSensitivity: LOOK_SENSITIVITY,
      isPlaying: () => playing && scout,
      onPause: stopPlaying,
      onTouchInput: () => setInputMode('touch'),
    });
  }
  return player;
}

/** 空から見る ⇄ 球へ戻る。 */
function toggleScout(): void {
  if (!playing) return;
  if (!scout) {
    if (!preparePlayer()) return;
    scout = true;
    overlay.setRivalMarkers([]);
    overlay.setStandings(null);
    overlay.setTiming(null, 0);
    overlay.hideScorecard();
    overlay.setHoleWait(null);
    scorecardHeld = false;
    // 空から見る間はコースの外へも飛ぶので、カメラの周りを読み込む。
    chunks?.setFocus(null);
    holeFade = null;
    overlay.setFade(0);
    overlay.setGolf(null);
    overlay.setAimLabel(null);
    overlay.flash(
      inputMode === 'touch' ? '空から見ています。右上の戻るボタンで打つ所へ。' : '空から見ています。F で球へ戻ります。',
    );
  } else {
    scout = false;
    loadHole();
    player?.clearKeys();
    golf?.resetCamera();
    camera.fov = golfFov();
    camera.updateProjectionMatrix();
    overlay.setFlightInfo(false, 0, 0, false);
    golf?.emit();
  }
  applyTouchUi();
}

function handleStart(pointerType: string): void {
  if (!ground) return;
  ensureAudio();
  // この利用者操作の中で play() を呼び、自動再生制限を解除する。取得するのは選ばれた 1 曲だけ。
  music?.play();
  if (!ensureGolf()) {
    // ホールを置けない島は、空から眺めるだけにする。
    scout = true;
    if (!preparePlayer()) return;
    overlay.flash('この島にはホールを置けませんでした。空から眺めます。');
  }
  const startedWithTouch =
    pointerType === 'touch' || pointerType === 'pen' || (pointerType === 'keyboard' && preferredTouch);
  setInputMode(startedWithTouch ? 'touch' : 'keys');
  if (inputMode === 'touch') {
    void enterFullscreen();
    startPlaying();
    return;
  }
  // Esc を押した直後はブラウザがしばらくロックを受け付けない。
  // 拒否されても例外にせず、押し直すよう促すだけにする。
  void requestMouseLock();
}

// ── 開始画面のコース紹介（マリオカートのコース紹介のような空撮） ───────
/** 開始画面・休憩中に流すコース紹介の空撮。本番の島が届いたら作る。 */
let flyover: Flyover | null = null;
/**
 * ホールの切り替え: 暗転 → 次のホールを読み込む → 明ける。
 * 読み込む範囲（chunks.setFocus）を替えるのは暗転している間だけ。明るい間は何も差し替わらない。
 * out は暗くなる途中（終わったら次のホールへ）、load は揃うのを待つ間（真っ暗、ホールの紹介も止める）、in は明ける途中。
 */
let holeFade: { phase: 'out' | 'load' | 'in'; t: number } | null = null;
const HOLE_FADE_OUT = 0.35;
const HOLE_FADE_IN = 0.6;
/** 読み込みを待つ上限（秒）。揃わなくても過ぎたら明ける。 */
const HOLE_LOAD_MAX = 5;

/** カップに入った後: 暗転して次のホールへ。 */
function goNextHole(): void {
  if (!golf || holeFade?.phase === 'out' || holeFade?.phase === 'load') return;
  holeFade = { phase: 'out', t: 0 };
}

/** 今のホールを読み込み、揃うまで暗いまま待つ（遊び始め・空から戻ったとき）。 */
function loadHole(): void {
  if (!golf || !chunks) return;
  chunks.setFocus(holeArea(golf.target));
  holeFade = { phase: 'load', t: 0 };
  overlay.setFade(1);
}

/** 毎フレームの暗転の進み。load の間は true を返す（ホールの紹介を進めない）。 */
function updateHoleFade(dt: number): boolean {
  if (!holeFade || !golf) return false;
  holeFade.t += dt;
  if (holeFade.phase === 'out') {
    overlay.setFade(Math.min(1, holeFade.t / HOLE_FADE_OUT));
    if (holeFade.t >= HOLE_FADE_OUT) {
      holedCardAt = 0;
      golf.next();
      catchUpToRoom();
      loadHole();
    }
    return false;
  }
  if (holeFade.phase === 'load') {
    if ((chunks?.settled ?? true) || holeFade.t > HOLE_LOAD_MAX) holeFade = { phase: 'in', t: 0 };
    return true;
  }
  overlay.setFade(1 - Math.min(1, holeFade.t / HOLE_FADE_IN));
  if (holeFade.t >= HOLE_FADE_IN) holeFade = null;
  return false;
}

/**
 * 本番の島が届いたら: 近くのチャンク（細かい地面と木）とピンを用意し、コース紹介の空撮を始める。
 * チャンクは開始画面から遊ぶ間まで使い続ける（島が替わったら作り直す）。
 */
function prepareCourseView(): void {
  if (!island || !madeParams || !terrain) return;
  chunks?.dispose();
  chunks = new ChunkManager(
    scene,
    { params: madeParams, landscape: island.landscape, water: island.water, field: courseField },
    water.material,
    preferredTouch ? 2 : 4,
  );
  overview.setCoverage(chunks.coverage);
  farForest.setCoverage(chunks.coverage);
  ensureGolf();
  const t = terrain;
  flyover = course.length > 0 ? new Flyover(course, (x, z) => Math.max(0, t.heightAt(x, z)), reducedMotion) : null;
  if (playing && golf && !scout) loadHole();
  if (flyover && !playing) {
    controls.enabled = false;
    camera.fov = MAKE_FOV;
    camera.updateProjectionMatrix();
  }
}

function startPlaying(): void {
  if (playing) return;
  playing = true;
  music?.play();
  if (!entered) {
    entered = true;
    overlay.setEntered();
    updatePartyLabel();
  }
  // 近くのチャンク（足元 2m 格子・木）は、本番の島が届いたときに作ってある（prepareCourseView）。
  controls.enabled = false;
  overlay.setAttractCaption(null, true);
  overlay.setFade(0);
  if (golf) golf.aids.visible = true;
  golf?.resetCamera();
  if (!scout) {
    // 空撮が映していた範囲から、今のホールへ読み込み直す（揃うまで暗いまま）。
    loadHole();
    // ラウンドの終わりに休憩していたら、締めの絵と結果に戻る。
    if (roundResult) {
      enterFinaleView(false);
      roundResultAt = performance.now() + 600;
    }
    camera.fov = golfFov();
    camera.updateProjectionMatrix();
    golf?.emit();
  }
  // 空から眺めるだけの島では、カメラの周りを読み込む（空撮が決めた範囲のままにしない）。
  if (scout) chunks?.setFocus(null);
  fog.density = FOG_FLY;
  overlay.hide();
  overlay.showKeyboardGuide();
  applyTouchUi();
  if (scout && player?.autoFlight) void requestWakeLock();
}

function stopPlaying(): void {
  if (!playing) return;
  playing = false;
  music?.pause();
  sounds?.stopAmbient();
  // ホールの切り替えの途中なら打ち切る（休憩中の暗転は空撮が受け持つ）。
  holeFade = null;
  if (golf) golf.aids.visible = false;
  // 押しっぱなし・倒しっぱなしの判定が残らないように全部戻す。
  player?.clearKeys();
  if (golf) {
    golf.aimInput = 0;
    golf.distInput = 0;
  }
  applyTouchUi();
  overlay.setGolf(null);
  overlay.setAimLabel(null);
  overlay.setFlagMarkers([]);
  overlay.setRivalMarkers([]);
  overlay.setStandings(null);
  overlay.setTiming(null, 0);
  overlay.hideScorecard();
  overlay.setHoleWait(null);
  scorecardHeld = false;
  // 締めの絵はしまう（結果は覚えておき、戻ったらまた出す）。
  finaleCam = null;
  overlay.hideRoundResult();
  overlay.setFinale(false);
  overlay.setFlightInfo(false, 0, 0, false);
  void releaseWakeLock();
  // 休憩中は、開始画面と同じくコース紹介の空撮を流す（チャンクはそのまま使う）。谷全体から、暗転で入る。
  flyover?.restart();
  camera.fov = MAKE_FOV;
  camera.updateProjectionMatrix();
  if (document.pointerLockElement) document.exitPointerLock();
  overlay.show(
    inputMode === 'touch'
      ? '休憩中。タップすると続きから打てます。'
      : '休憩中。クリックすると続きから打てます。',
  );
}

async function enterFullscreen(): Promise<void> {
  if (document.fullscreenElement) return;
  const root = document.documentElement as HTMLElement & {
    requestFullscreen?: (options?: FullscreenOptions) => Promise<void>;
  };
  if (!root.requestFullscreen) return;
  try {
    await root.requestFullscreen({ navigationUI: 'hide' });
  } catch {
    // 内ブラウザはメソッドがあっても拒否する。通常表示のまま遊べればよい。
    overlay.flash('全画面にできないため、この表示領域のまま遊びます。');
  }
}

async function requestMouseLock(): Promise<void> {
  try {
    await canvas.requestPointerLock({ unadjustedMovement: true } as PointerLockOptions);
  } catch {
    try {
      await canvas.requestPointerLock();
    } catch {
      // iPhone の全ブラウザで入力種別が誤報されても、入口を塞がない。
      // Pointer Lock はタッチ操作に不要なので、タッチ可能ならそのまま開始できる。
      if (touchCapable) {
        setInputMode('touch');
        startPlaying();
        overlay.flash('タッチ操作で開始します。');
        return;
      }
      music?.pause();
      overlay.flash('少し待ってから、もう一度クリックしてください');
    }
  }
}

async function requestWakeLock(): Promise<void> {
  if (!playing || !player?.autoFlight || document.hidden || wakeLock) return;
  try {
    const nav = navigator as unknown as WakeLockNavigator;
    wakeLock = (await nav.wakeLock?.request('screen')) ?? null;
  } catch {
    // 省電力設定や内ブラウザが拒否しても、オートフライト自体は続ける。
  }
}

async function releaseWakeLock(): Promise<void> {
  const lock = wakeLock;
  wakeLock = null;
  try {
    await lock?.release();
  } catch {
    // 既にブラウザ側で解除済みなら何もしない。
  }
}

/**
 * 構えている（針が振れている）間に Esc でマウスのロックが外れたら、休憩にせず狙いに戻る。
 * ブラウザは Esc でロックを外してしまうので、次のクリックでロックを取り直す（そのクリックでは打たない）。
 */
let relockPending = false;
document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement === canvas) {
    relockPending = false;
    setInputMode('keys');
    startPlaying();
  } else if (inputMode === 'keys' && playing) {
    if (roundResult) return;
    if (golf && !scout && golf.phase === 'swing') {
      golf.cancelSwing();
      relockPending = true;
      overlay.flash('構えをやめました。クリックで操作に戻ります（もう一度 Esc で休憩）');
      return;
    }
    stopPlaying();
  }
});

// 別のアプリに移ったら止める。スマホでは戻ってきたとき勝手に動いていると困る。
document.addEventListener('visibilitychange', () => {
  if (document.hidden && playing) stopPlaying();
  else if (!document.hidden && playing && player?.autoFlight) void requestWakeLock();
});
addEventListener('blur', () => {
  if (!playing) return;
  player?.clearKeys();
  if (golf) {
    golf.aimInput = 0;
    golf.distInput = 0;
  }
});

// ── ゴルフの入力（キー・マウス・タッチを同じ関数に集める） ─────
// 狙いは落とし所の輪を動かす（左右 = 向き、前後 = 距離）。打つのは「構える → 針を止める」の 2 回押し。
/** 打つ操作を押した。狙っていれば構え、針が振れていれば打つ。カップに入った後なら次のホールへ。 */
function shotPress(): void {
  if (!golf || scout) return;
  if (golf.phase === 'holed') {
    holedPress();
    return;
  }
  golf.press();
}

/** 輪を前後に動かす量（画素あたり m）。遠くを狙うほど大きく、パットは細かく。 */
function pushPerPixel(game: GolfGame): number {
  return game.putting ? 0.03 : Math.max(0.15, game.aimDistance * 0.0035);
}

addEventListener('keydown', (e: KeyboardEvent) => {
  if (!playing) return;
  if (e.code === 'Space') e.preventDefault();
  // カップに入った後は、どのキーでも次のティーへ（Tab・M・F・Esc は除く）。
  if (golf && !scout && golf.phase === 'holed' && !e.repeat && !['Tab', 'KeyM', 'KeyF', 'Escape'].includes(e.code)) {
    holedPress();
    return;
  }
  // 構えている間の Esc は、狙いに戻る（ロックが外れていてキーが届くとき）。
  if (e.code === 'Escape') {
    if (golf && golf.phase === 'swing') golf.cancelSwing();
    else if (relockPending || roundResult) stopPlaying();
    return;
  }
  if (e.code === 'KeyF' && !e.repeat) {
    toggleScout();
    return;
  }
  if (e.code === 'KeyM' && !e.repeat && audio) {
    overlay.flash(audio.toggleMute() ? '音を消しました（M）' : '音を出します（M）');
    return;
  }
  if (e.code === 'Tab') {
    e.preventDefault();
    scorecardHeld = true;
    return;
  }
  if (scout) {
    player?.onKey(e.code, true, e.repeat);
    return;
  }
  if (!golf) return;
  if (e.code === 'KeyA' || e.code === 'ArrowLeft') golf.aimInput = 1;
  else if (e.code === 'KeyD' || e.code === 'ArrowRight') golf.aimInput = -1;
  else if (e.code === 'KeyW' || e.code === 'ArrowUp') golf.distInput = 1;
  else if (e.code === 'KeyS' || e.code === 'ArrowDown') golf.distInput = -1;
  else if (e.code === 'KeyQ' && !e.repeat) golf.changeClub(-1);
  else if (e.code === 'KeyE' && !e.repeat) golf.changeClub(1);
  else if (e.code === 'Space' && !e.repeat) shotPress();
});
addEventListener('keyup', (e: KeyboardEvent) => {
  if (!playing) return;
  if (e.code === 'Tab') scorecardHeld = false;
  if (scout) {
    player?.onKey(e.code, false);
    return;
  }
  if (!golf) return;
  if ((e.code === 'KeyA' || e.code === 'ArrowLeft') && golf.aimInput > 0) golf.aimInput = 0;
  if ((e.code === 'KeyD' || e.code === 'ArrowRight') && golf.aimInput < 0) golf.aimInput = 0;
  if ((e.code === 'KeyW' || e.code === 'ArrowUp') && golf.distInput > 0) golf.distInput = 0;
  if ((e.code === 'KeyS' || e.code === 'ArrowDown') && golf.distInput < 0) golf.distInput = 0;
});
addEventListener('mousemove', (e: MouseEvent) => {
  if (document.pointerLockElement !== canvas) return;
  if (scout) {
    player?.onLook(e.movementX, e.movementY, LOOK_SENSITIVITY);
    return;
  }
  if (!golf) return;
  if (golf.phase === 'holed') {
    golf.lookAround(-e.movementX * AIM_MOUSE, e.movementY * AIM_MOUSE);
    return;
  }
  // 左右で向き、前後（上下）で距離。
  golf.rotateAim((-e.movementX * AIM_MOUSE) / (golf.putting ? 2.5 : 1));
  if (e.movementY !== 0) golf.pushAim(-e.movementY * pushPerPixel(golf));
});
addEventListener('mousedown', (e: MouseEvent) => {
  if (document.pointerLockElement === canvas) {
    if (e.button === 0) shotPress();
    // 右クリックは構えをやめる。
    else if (e.button === 2) golf?.cancelSwing();
    return;
  }
  // Esc で構えをやめた後: このクリックでロックを取り直す（打たない）。
  if (playing && relockPending && inputMode === 'keys' && e.target === canvas) void requestMouseLock();
});
addEventListener('contextmenu', (e) => {
  if (playing) e.preventDefault();
});
addEventListener(
  'wheel',
  (e: WheelEvent) => {
    if (playing && !scout && golf && Math.abs(e.deltaY) > 4) golf.changeClub(e.deltaY > 0 ? 1 : -1);
  },
  { passive: true },
);

// タッチ: 画面をなぞって輪を動かす（左右 = 向き、上下 = 距離）。打つ・クラブ・空から・休憩はボタン。
let aimPointer: number | null = null;
let aimLastX = 0;
let aimLastY = 0;
let aimMoved = false;
let aimTravel = 0;
canvas.addEventListener('pointerdown', (e) => {
  if (!playing || scout || e.pointerType === 'mouse') return;
  aimPointer = e.pointerId;
  aimLastX = e.clientX;
  aimLastY = e.clientY;
  aimMoved = false;
  aimTravel = 0;
});
canvas.addEventListener('pointermove', (e) => {
  if (e.pointerId !== aimPointer || !golf) return;
  const dx = e.clientX - aimLastX;
  const dy = e.clientY - aimLastY;
  aimTravel += Math.hypot(dx, dy);
  if (aimTravel > 6) aimMoved = true;
  if (golf.phase === 'holed') {
    golf.lookAround(-dx * AIM_TOUCH, dy * AIM_TOUCH);
    aimLastX = e.clientX;
    aimLastY = e.clientY;
    return;
  }
  golf.rotateAim((-dx * AIM_TOUCH) / (golf.putting ? 2.5 : 1));
  golf.pushAim(-dy * pushPerPixel(golf) * 1.4);
  aimLastX = e.clientX;
  aimLastY = e.clientY;
});
const endAim = (e: PointerEvent) => {
  if (e.pointerId !== aimPointer) return;
  const holed = golf?.phase === 'holed';
  aimPointer = null;
  if (holed && !aimMoved) holedPress();
};
const cancelAim = (e: PointerEvent) => {
  if (e.pointerId === aimPointer) aimPointer = null;
};
canvas.addEventListener('pointerup', endAim);
canvas.addEventListener('pointercancel', cancelAim);
overlay.bindGolfTouch({
  onShotDown: shotPress,
  onShotUp: () => {},
  onScout: toggleScout,
  onPause: stopPlaying,
  onCancel: () => golf?.cancelSwing(),
});

let resizeQueued = false;
function scheduleResize(): void {
  if (resizeQueued) return;
  resizeQueued = true;
  requestAnimationFrame(() => {
    resizeQueued = false;
    resizeRenderer();
  });
}
addEventListener('resize', scheduleResize);
window.visualViewport?.addEventListener('resize', scheduleResize);
document.addEventListener('fullscreenchange', scheduleResize);
addEventListener('orientationchange', scheduleResize);

// ── 毎フレーム ─────────────────────────────────────────
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

/** 縦画面は視野を広げ、速く飛ぶほど少し広げる（stroll と同じ。動きを減らす設定なら速さでは広げない）。 */
function updateCameraFeel(dt: number, p: Player): void {
  const aspect = Math.max(0.35, camera.aspect);
  const portrait = THREE.MathUtils.clamp((0.75 - aspect) / 0.3, 0, 1);
  const baseFov = THREE.MathUtils.lerp(68, 82, portrait);
  const speedFov =
    p.flying && !reducedMotion ? THREE.MathUtils.clamp((p.speed - 28) / 84, 0, 1) * 6 : 0;
  const next = THREE.MathUtils.lerp(camera.fov, baseFov + speedFov, 1 - Math.exp(-5 * dt));
  if (Math.abs(next - camera.fov) > 0.01) {
    camera.fov = next;
    camera.updateProjectionMatrix();
  }
}

/** 高く飛ぶほど霧を薄くし、空から遠くまで見えるようにする（高度 220m で半分。stroll と同じ）。 */
function updateAerialVisibility(dt: number, clearance: number): void {
  const clear = THREE.MathUtils.smoothstep(clearance, 35, 220);
  const target = FOG_FLY * THREE.MathUtils.lerp(1, 0.5, clear);
  fog.density = THREE.MathUtils.lerp(fog.density, target, 1 - Math.exp(-2.5 * dt));
}

/**
 * 描画の近い側の限界（near）を、見ている距離に合わせる。
 *
 * 深度の精度は near に比例する。見渡すときにカメラは島から数 km 離れるのに、near が
 * 飛ぶとき用の 0.5m のままだと、遠くの浜辺で精度が数 m しかなく、海の板と平らな浜が
 * 描くたびに入れ替わってガタついた。見渡すときは注視点までの距離の 0.3% にする
 * （4km なら 12m、精度は 24 倍）。
 */
function fitNearPlane(): void {
  // 飛んでいる間も、地面から離れているほど near を上げる（高度 200m なら 4m）。
  // 足元近くを歩くときは 0.5m に戻る。
  const near = playing && !scout
    ? 0.2
    : playing
    ? Math.min(8, Math.max(0.5, (player?.altitudeAboveGround ?? 0) * 0.02))
    : Math.min(30, Math.max(0.5, camera.position.distanceTo(controls.target) * 0.003));
  if (Math.abs(near - camera.near) > camera.near * 0.1) {
    camera.near = near;
    camera.updateProjectionMatrix();
  }
}

const pinScreen = new THREE.Vector3();
const flagMarkers: { x: number; y: number; text: string; target: boolean; own: boolean; flag: boolean }[] = [];
/**
 * 今のホールの旗の札が画面のどこにあるか（px）。落とし所の札（placeAimLabel）と重ねないために使う。
 * top・bottom は札（下の三角を含む）の上下、half は幅の半分、ground は旗の根元。
 */
let pinLabel: { x: number; top: number; bottom: number; half: number; ground: number } | null = null;
/**
 * 旗の目印（番号と距離）を、旗の上の実際の画面位置へ（遠いと旗が小さくて見えないため）。
 * 打っている間は目標の旗に距離を付け、他の旗は番号だけ。空からは全部に距離を付ける。
 * 目標のすぐ近く（旗そのものが見える）では出さない。
 */
function placeFlagMarkers(game: GolfGame, from: { x: number; z: number }): void {
  flagMarkers.length = 0;
  pinLabel = null;
  // このフレームで動かしたカメラから投影する（描画の前なので自分で行列を更新する）。
  camera.updateMatrixWorld();
  for (const h of game.course) {
    const target = h === game.target;
    // 打つ間は、今のホールの旗だけ（ほかのホールの番号が遠くに浮いて散らかっていた）。空から見る間は全部。
    if (!target && !scout) continue;
    const d = Math.hypot(h.pin.x - from.x, h.pin.z - from.z);
    if (target && !scout && d < 25) continue;
    game.pinTop(h, pinScreen).project(camera);
    if (pinScreen.z >= 1 || Math.abs(pinScreen.x) > 1 || Math.abs(pinScreen.y) > 1) continue;
    const name = `${h.number}`;
    const x = ((pinScreen.x + 1) / 2) * innerWidth;
    const y = ((1 - pinScreen.y) / 2) * innerHeight - (target ? 10 : 2);
    // 打つ間は今のホールの旗しか出さないので、番号は付けない（旗の印と距離だけ）。空から見る間は番号も。
    const text = scout ? (target ? `${name} · ${Math.round(d)} m` : name) : `${Math.round(d)} m`;
    flagMarkers.push({ x, y, text, target, own: false, flag: target && !scout });
    if (target && !scout) {
      pinScreen.set(h.pin.x, game.ground.height(h.pin.x, h.pin.z), h.pin.z).project(camera);
      pinLabel = {
        x,
        top: y - 24,
        bottom: y + 9,
        half: (34 + text.length * 7.4) / 2,
        ground: ((1 - pinScreen.y) / 2) * innerHeight,
      };
    }
  }
  overlay.setFlagMarkers(flagMarkers);
}

const rivalScreen = new THREE.Vector3();
const rivalMarkers: { x: number; y: number; text: string; color: number }[] = [];
/** COM と友達の球の上に色の点を出す（画面に映っている球だけ）。カメラの行列は placeFlagMarkers が更新してある。 */
function placeRivalMarkers(rivals: readonly OpponentState[]): void {
  rivalMarkers.length = 0;
  for (const r of rivals) {
    if (!r.ball) continue;
    rivalScreen.set(r.ball.x, r.ball.y + 1.1, r.ball.z).project(camera);
    if (rivalScreen.z >= 1 || Math.abs(rivalScreen.x) > 1 || Math.abs(rivalScreen.y) > 1) continue;
    rivalMarkers.push({
      x: ((rivalScreen.x + 1) / 2) * innerWidth,
      y: ((1 - rivalScreen.y) / 2) * innerHeight,
      text: r.name,
      color: r.color,
    });
  }
  overlay.setRivalMarkers(rivalMarkers);
}

const ballScreen = new THREE.Vector3();
/**
 * 構えている間、球のすぐ下に正確さのバーを出す。球が画面の外（真下など）にあるときは、画面の下寄りの真ん中へ。
 * タッチでは右下の打つボタンより上に収める。球が画面下寄りにあると、バーとボタンが同じ高さへ来て重なっていた。
 */
function placeTiming(game: GolfGame): void {
  if (game.phase !== 'swing') {
    overlay.setTiming(null, 0);
    return;
  }
  ballScreen.set(game.ball.pos.x, game.ball.pos.y, game.ball.pos.z).project(camera);
  const inside = ballScreen.z < 1 && Math.abs(ballScreen.x) < 1 && Math.abs(ballScreen.y) < 1;
  const x = inside ? ((ballScreen.x + 1) / 2) * innerWidth : innerWidth / 2;
  const y = (inside ? ((1 - ballScreen.y) / 2) * innerHeight : innerHeight * 0.7) + 34;
  // バーの幅の半分（約 150px）は画面の中に収める。タッチでは打つボタン（下から約 88〜166px）も避ける。
  const touchTiming = inputMode === 'touch';
  const topClearance = touchTiming ? 80 : 140;
  const bottomClearance = touchTiming ? 230 : 130;
  const timingY = Math.max(topClearance, Math.min(Math.max(topClearance, innerHeight - bottomClearance), y));
  overlay.setTiming(
    { x: Math.max(160, Math.min(innerWidth - 160, x)), y: timingY },
    game.needle,
  );
}

const aimScreen = new THREE.Vector3();
/** 落とし所の距離の札: 輪の真ん中から下へのすき間と、札の高さ（px）。 */
const AIM_LABEL_GAP = 9;
const AIM_LABEL_H = 22;
/** 落とし所の輪の上に距離を出す（狙っている間と構えている間）。 */
function placeAimLabel(game: GolfGame): void {
  if (game.phase !== 'aim' && game.phase !== 'swing') {
    overlay.setAimLabel(null);
    return;
  }
  game.aimBase(aimScreen).project(camera);
  if (aimScreen.z >= 1 || Math.abs(aimScreen.x) > 1 || Math.abs(aimScreen.y) > 1) {
    overlay.setAimLabel(null);
    return;
  }
  const d = game.aimDistance;
  const text = game.putting ? `${d.toFixed(1)} m` : `${Math.round(d)} m`;
  const x = ((aimScreen.x + 1) / 2) * innerWidth;
  // 輪の下に出す（旗の札は旗の上）。以前はどちらも目印の上で、遠くでは高さの差が数 px しかなく重なった。
  let y = ((1 - aimScreen.y) / 2) * innerHeight + AIM_LABEL_GAP;
  // 落とし所が旗よりずっと奥なら、輪の下でも旗の札に届く。そのときは旗の根元より下へずらす。
  const half = (16 + text.length * 7.8) / 2;
  const p = pinLabel;
  if (p && Math.abs(x - p.x) < half + p.half + 4 && y < p.bottom + 4 && y + AIM_LABEL_H > p.top - 4) {
    y = Math.max(p.ground, p.bottom) + AIM_LABEL_GAP;
  }
  overlay.setAimLabel({ x, y, text });
}

const timer = new THREE.Timer();
let elapsed = 0;
let mobileFrameSum = 0;
let mobileFrameCount = 0;
let mobileFrameWindow = 0;
let mobileFastWindows = 0;

/**
 * スマホの実測フレーム時間にだけ反応する動的解像度。
 * 一時的なチャンク生成や暗転は数えず、2.5 秒続けて遅いときだけ少し下げる。
 * 余裕が戻った場合は 2 区間確認してから上げ、頻繁な往復とリサイズの引っ掛かりを防ぐ。
 */
function updateMobileRenderScale(dt: number): void {
  const stable =
    inputMode === 'touch' &&
    !document.hidden &&
    sceneReady &&
    !holeFade &&
    (chunks?.settled ?? true);
  if (!stable) {
    mobileFrameSum = 0;
    mobileFrameCount = 0;
    mobileFrameWindow = 0;
    mobileFastWindows = 0;
    return;
  }
  mobileFrameSum += dt;
  mobileFrameCount++;
  mobileFrameWindow += dt;
  if (mobileFrameWindow < 2.5 || mobileFrameCount === 0) return;

  const average = mobileFrameSum / mobileFrameCount;
  const before = renderer.getPixelRatio();
  if (average > 0.022 && mobileDprCap > MOBILE_DPR_MIN) {
    mobileDprCap = Math.max(MOBILE_DPR_MIN, mobileDprCap - 0.1);
    mobileFastWindows = 0;
  } else if (average < 0.018 && mobileDprCap < MOBILE_DPR_MAX) {
    mobileFastWindows++;
    if (mobileFastWindows >= 2) {
      mobileDprCap = Math.min(MOBILE_DPR_MAX, mobileDprCap + 0.1);
      mobileFastWindows = 0;
    }
  } else {
    mobileFastWindows = 0;
  }
  mobileFrameSum = 0;
  mobileFrameCount = 0;
  mobileFrameWindow = 0;
  // 画面や画素数の上限で実際の倍率が変わらない場合は、描画面を作り直さない。
  const budgetRatio = Math.sqrt(MOBILE_PIXEL_BUDGET / (Math.max(1, innerWidth) * Math.max(1, innerHeight)));
  const after = Math.max(0.75, Math.min(devicePixelRatio, mobileDprCap, budgetRatio));
  if (Math.abs(after - before) > 0.01) resizeRenderer();
}

renderer.setAnimationLoop(() => {
  timer.update();
  const dt = Math.min(timer.getDelta(), 0.1);
  // 別のアプリを見ている間は、空撮も WebGL も止める。戻ったときの差分は dt の上限で吸収する。
  if (document.hidden) return;
  elapsed += dt;
  updateMobileRenderScale(dt);
  if (playing && scout && player) {
    player.update(dt, camera, reducedMotion);
    touchControls?.update();
    chunks?.update(player.position.x, player.position.z);
    updateCameraFeel(dt, player);
    updateAerialVisibility(dt, player.altitudeAboveGround);
    if (golf) placeFlagMarkers(golf, player.position);
    sounds?.update(dt, lastStatus?.windSpeed ?? 0, 1, player.altitudeAboveGround);
    overlay.setFlightInfo(player.flying, player.speed, player.altitudeAboveSeaLevel, player.autoFlight);
    if (player.autoFlight !== lastAutoFlight) {
      lastAutoFlight = player.autoFlight;
      if (player.autoFlight) {
        overlay.flash('AUTO：視点は自由。左右を大きく入れると進路を変えます。');
        void requestWakeLock();
      } else {
        void releaseWakeLock();
      }
    }
  } else if (playing && golf) {
    if (!updateHoleFade(dt)) golf.update(dt);
    if (finaleCam) finaleCam.update(dt, camera);
    else {
      // 画面を回した・大きさを変えたら、画角も合わせる。
      const fov = golfFov();
      if (Math.abs(camera.fov - fov) > 0.01) {
        camera.fov = fov;
        camera.updateProjectionMatrix();
      }
      golf.updateCamera(camera, dt);
    }
    if (roundResult && roundResultAt > 0 && performance.now() >= roundResultAt && !holeFade) {
      roundResultAt = 0;
      overlay.showRoundResult(roundResult);
      // 結果の窓のボタンを押せるように、マウスを放す（ロックが外れても休憩にはしない）。
      if (document.pointerLockElement === canvas) document.exitPointerLock();
    }
    // ホールの切り替えで暗い間（暗くなる・読み込む）は、チャンクをまとめて組み立てる。
    chunks?.update(camera.position.x, camera.position.z, holeFade !== null && holeFade.phase !== 'in');
    sounds?.update(dt, lastStatus?.windSpeed ?? 0, 1, 0);
    // 最後のホールの後、COM の相手が打ち終えたら結果へ。
    if (finalePending && golf.rivalsSettled) {
      startFinale(finalePending.total, finalePending.totalPar);
      finalePending = null;
    }
    const rivals = golf.rivalStates;
    holeMap.setHole(golf.target, courseSampler);
    holeMap.draw(
      golf.ball.pos,
      golf.phase === 'aim' || golf.phase === 'swing' ? golf.aimPoint : null,
      golf.target.pin,
      rivals.flatMap((r) => (r.ball ? [{ x: r.ball.x, z: r.ball.z, color: r.color }] : [])),
    );
    if (lastStatus) {
      const pars = golf.course.map((h) => h.par);
      const roomView = party?.view;
      const waitingForFriends = playMode === 'friends' && golf.phase === 'holed' && !golf.rivalsSettled && roomView;
      const holeIndex = golf.target.number - 1;
      const doneCount = waitingForFriends
        ? roomView.players.filter((p) => p.playing && p.scores[holeIndex] != null).length
        : 0;
      const playingCount = waitingForFriends ? roomView.players.filter((p) => p.playing).length : 0;
      overlay.setHoleWait(waitingForFriends ? `みんなを待っています ${doneCount}/${playingCount}` : null);
      // カップインの後のスコアカードは、COM の相手が打ち終えてから（全員の打数を並べて出す）。
      // 友達を待つ間は景色を見回せるよう、中央のカードを自動では出さない。
      const card =
        holedCardAt > 0 &&
        performance.now() >= holedCardAt &&
        golf.phase === 'holed' &&
        !holeFade &&
        golf.rivalsSettled;
      overlay.setScorecard(
        pars,
        scoreRows(lastStatus),
        lastStatus.target.number,
        !roundResult && (card || scorecardHeld || overlay.scorecardPinned),
        card ? holedCard(golf) : null,
      );
      // スコアカードを出している間は順位をしまう（カードに全員の打数が並ぶ。スマホでは重なって見えた）。
      overlay.setStandings(finaleCam || card ? null : standingsOf(lastStatus, pars));
    }
    if (!finaleCam) {
      placeFlagMarkers(golf, golf.ball.pos);
      placeRivalMarkers(rivals);
      placeAimLabel(golf);
      placeTiming(golf);
    } else {
      overlay.setRivalMarkers([]);
      overlay.setTiming(null, 0);
    }
  } else if (flyover && sceneReady) {
    // 開始画面・休憩中: コース紹介の空撮。カットの範囲を読み込み、揃うまでは暗いまま待つ（flyover.ts）。
    chunks?.setFocus(flyover.area);
    chunks?.update(camera.position.x, camera.position.z, flyover.fade > 0.98);
    flyover.update(dt, camera, chunks?.settled ?? true);
    // 霧は空撮の間ずっと同じ濃さ（高さで変えると、カットが替わるたびに遠くの山がじわっと出たり消えたりする）。
    fog.density = FOG_ATTRACT * flyover.fogScale;
    overlay.setAttractCaption(flyover.caption);
    overlay.setFade(flyover.fade);
    loadingCurtain = flyover.fade;
  } else if (!sceneReady) {
    // 島を作っている間: 暗くしたまま待つ（別のコースへ替えるときは、今の絵から 0.35 秒で暗くする）。
    // カメラは動かさない（暗くなる途中で絵が飛ばないように）。
    loadingCurtain = Math.min(1, loadingCurtain + dt / 0.35);
    overlay.setFade(loadingCurtain);
    overlay.setAttractCaption(null);
  } else {
    // コースを置けなかった島: 見渡すだけ。
    controls.update();
    overlay.setFade(0);
  }
  if (camera.view) camera.clearViewOffset();
  // 完全な暗転中は、進捗の文字だけ更新すればよい。3D を描き続けると、島を作る Worker と
  // CPU/GPU・発熱を奪い合う。形が届いた直後だけ 1 枚描き、シェーダーと転送を先に温める。
  const fullyCovered = !sceneReady && loadingCurtain >= 0.999;
  if (!fullyCovered || renderWarmupNeeded) {
    fitNearPlane();
    sky.update(camera, elapsed);
    updateIslandLight(dt);
    water.update(camera, elapsed);
    // 遠景の島は、チャンクに覆われた升目と画面の外の升目を描かない（overviewMesh.ts）。遠くの林は画面に入る木だけ。
    overview.update(camera);
    farForest.update(camera, elapsed);
    renderer.render(scene, camera);
    renderWarmupNeeded = false;
  }
});

addEventListener('hashchange', () => location.reload());

// 開発用: 自動ブラウザから視点と時間を動かして、画面の揺れを測るための窓口。本番ビルドには入らない。
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__hako = {
    camera,
    controls,
    water,
    renderer,
    scene,
    sky,
    player: () => player,
    island: () => island,
    course: () => course,
    chunks: () => chunks,
    golf: () => golf,
    // 自動ブラウザは Pointer Lock を持たないので、入口を省いて始める。
    play: () => {
      if (ensureGolf()) startPlaying();
    },
    scout: () => toggleScout(),
    stop: () => stopPlaying(),
    isScout: () => scout,
  };
}
// 開いたら、暗い画面に作っている段階を出し、島・木・光が揃ってから空撮を始める。
overlay.setFade(1);
// 部屋に呼ぶリンク（#合言葉@部屋の番号）で開いたら、その部屋へ。
if (isRoomId(hashRoom)) joinRoom(hashRoom);
updatePartyLabel();
commit();
