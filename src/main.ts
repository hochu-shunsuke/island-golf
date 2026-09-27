import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import './style.css';
import './touch.css';
import type { Island } from './island/generate';
import { EROSION_RES, FULL_RES, ISLAND_SIZE } from './island/grid';
import { LOAD_STEPS } from './island/loadSteps';
import { IslandGround } from './island/ground';
import { type IslandParams, cleanSeed, courseParams, randomSeed } from './island/params';
import type { GenerateRequest, GenerateResult, WorkerResult } from './island/worker';
import { Player } from './player/controller';
import { ChunkManager } from './render/chunkManager';
import { FarForest } from './render/farForest';
import { setIslandLight, updateIslandLight } from './render/islandLight';
import { OverviewMesh } from './render/overviewMesh';
import { MORNING, Sky } from './render/sky';
import { Water } from './render/water';
import { type RoundResult, Overlay } from './ui/overlay';
import { type TouchControls, createTouchControls, hasTouchInput, isTouchDevice } from './ui/touch';
import { Flyover } from './view/flyover';
import { FinaleCamera } from './view/finale';
import { IslandWater } from './world/islandWater';
import { Terrain } from './world/terrain';
import { type Hole, holeArea, holeIntro } from './golf/course';
import { CourseField, type FieldArrays } from './golf/field';
import { GolfGame, scoreName, toPar } from './golf/game';
import { AudioEngine } from './audio/engine';
import { HoleMap } from './ui/holeMap';
import { GolfSounds } from './audio/golfSounds';

/**
 * Hole in Isle（コード名 island-golf）。合言葉ひとつで、山に囲まれた谷に 9 ホールのコースがある島がひとつできる。
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
/** 見渡すときの視野（度）。飛ぶときは stroll と同じく 68°〜82°＋速さ。 */
const MAKE_FOV = 55;
/** 球を打つときの視野（度）。 */
const GOLF_FOV = 58;
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

let params: IslandParams = courseParams(location.hash);

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
  const deviceCap = inputMode === 'touch' ? 1.5 : 2;
  renderer.setPixelRatio(Math.max(0.75, Math.min(devicePixelRatio, deviceCap, budgetRatio)));
  renderer.setSize(width, height);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}
resizeRenderer();

// ── 画面 ───────────────────────────────────────────────
const overlay = new Overlay(document.getElementById('ui')!, params, inputMode === 'touch', touchCapable, {
  onStart: (pointerType) => handleStart(pointerType),
  // 「IDで入る」: 友達から聞いたコースの合言葉へ。
  onSeed: (seed) => {
    const clean = cleanSeed(seed);
    if (!clean || clean === params.seed) return;
    params = { ...params, seed: clean };
    overlay.setParams(params);
    commit();
  },
  // サイコロ: 合言葉を振り直して、別のコースを引く。
  onRandom: () => newCourse(),
  // ラウンドの終わり: 1 番のティーへ（暗転して読み込み直す）。PC はこの押下でマウスを取り直す。
  onAgain: () => {
    if (!golf) return;
    leaveFinale();
    goNextHole();
    if (inputMode === 'keys' && document.pointerLockElement !== canvas) void requestMouseLock();
  },
  // ラウンドの終わり: 開始画面へ戻って、別のコースを引く。
  onNewCourse: () => {
    leaveFinale();
    stopPlaying();
    overlay.show();
    newCourse();
  },
});

/** 合言葉を振り直して、別のコースを引く。 */
function newCourse(): void {
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
    sun: [sun.x, sun.y, sun.z],
    // ピン位置は日ごとに替わる（同じ URL なら、同じ日は誰でも同じピン）。
    day: Math.floor(Date.now() / 86_400_000),
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
  }
  const field = courseField ? new CourseField(courseField) : null;
  courseSampler = field;
  terrain = new Terrain(made, next.landscape, new IslandWater(next.water), field);
  // 見渡す島の 1 枚と地図は Worker が作ってある。ここでは貼るだけ（画面を止めない）。
  overview.set(msg.overview, msg.overviewWater);
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
    if (msg.id === drawnId) farForest.set(msg.forest);
    return;
  }
  if (msg.type === 'light') {
    // 光は島の後から届く。今見せている島の光だけを使う。
    if (msg.id === drawnId) setIslandLight(msg.lighting);
    // 島・木・光が揃った。空撮を始めて「プレイ」を押せるようにする。
    if (msg.id === drawnId && msg.id === lastRequested) {
      sceneReady = true;
      overlay.setReady(true);
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
  history.replaceState(null, '', `#${params.seed}`);
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
    if (last) startFinale(total, totalPar);
    else holedCardAt = performance.now() + HOLED_CARD_DELAY;
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
function ensureAudio(): void {
  try {
    if (!audio) {
      audio = new AudioEngine();
      sounds = new GolfSounds(audio);
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
  const day = new Date(Math.floor(Date.now() / 86_400_000) * 86_400_000);
  const dateLabel = `${day.getUTCMonth() + 1}/${day.getUTCDate()}`;
  const marks = pars.map((p, k) => scoreEmoji(scores[k], p)).join('');
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
    birdies: pars.filter((p, k) => scores[k] !== undefined && scores[k]! < p).length,
    shareText: [
      `Hole in Isle ${seed}（${dateLabel} のピン）`,
      `${total} 打（${toPar(total, totalPar)}）`,
      marks,
      `${location.origin}${location.pathname}#${seed}`,
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
  return {
    head: `<b>${h.number} 番</b> ${strokes} 打 · ${scoreName(strokes, h.par)}<span>通算 ${toPar(total, par)}</span>`,
    foot: `${how}で ${next.number} 番のティーへ ▸`,
  };
}

/** カップインの後に押した: スコアカードがまだならすぐ出し、出ていれば次のティーへ。 */
function holedPress(): void {
  if (!golf || roundResult) return;
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
    // 空から見る間はコースの外へも飛ぶので、カメラの周りを読み込む。
    chunks?.setFocus(null);
    holeFade = null;
    overlay.setFade(0);
    overlay.setGolf(null);
    overlay.setAimLabel(null);
    overlay.flash(
      inputMode === 'touch' ? '空から見ています。「球へ戻る」で打つ所へ。' : '空から見ています。F で球へ戻ります。',
    );
  } else {
    scout = false;
    loadHole();
    player?.clearKeys();
    golf?.resetCamera();
    camera.fov = GOLF_FOV;
    camera.updateProjectionMatrix();
    overlay.setFlightInfo(false, 0, 0, false);
    golf?.emit();
  }
  applyTouchUi();
}

function handleStart(pointerType: string): void {
  if (!ground) return;
  ensureAudio();
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
  if (!entered) {
    entered = true;
    overlay.setEntered();
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
    camera.fov = GOLF_FOV;
    camera.updateProjectionMatrix();
    golf?.emit();
    if (golf && golf.strokes === 0 && golf.phase === 'aim') overlay.flash(holeIntro(golf.target));
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
  overlay.hideScorecard();
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
canvas.addEventListener('pointerdown', (e) => {
  if (!playing || scout || e.pointerType === 'mouse') return;
  // カップに入った後は、画面のどこをタップしても次のティーへ。
  if (golf?.phase === 'holed') {
    holedPress();
    return;
  }
  aimPointer = e.pointerId;
  aimLastX = e.clientX;
  aimLastY = e.clientY;
});
canvas.addEventListener('pointermove', (e) => {
  if (e.pointerId !== aimPointer || !golf) return;
  golf.rotateAim((-(e.clientX - aimLastX) * AIM_TOUCH) / (golf.putting ? 2.5 : 1));
  golf.pushAim(-(e.clientY - aimLastY) * pushPerPixel(golf) * 1.4);
  aimLastX = e.clientX;
  aimLastY = e.clientY;
});
const endAim = (e: PointerEvent) => {
  if (e.pointerId === aimPointer) aimPointer = null;
};
canvas.addEventListener('pointerup', endAim);
canvas.addEventListener('pointercancel', endAim);
overlay.bindGolfTouch({
  onShotDown: shotPress,
  onShotUp: () => {},
  onClub: (step) => golf?.changeClub(step),
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
const flagMarkers: { x: number; y: number; text: string; target: boolean; own: boolean }[] = [];
/**
 * 旗の目印（番号と距離）を、旗の上の実際の画面位置へ（遠いと旗が小さくて見えないため）。
 * 打っている間は目標の旗に距離を付け、他の旗は番号だけ。空からは全部に距離を付ける。
 * 目標のすぐ近く（旗そのものが見える）では出さない。
 */
function placeFlagMarkers(game: GolfGame, from: { x: number; z: number }): void {
  flagMarkers.length = 0;
  // このフレームで動かしたカメラから投影する（描画の前なので自分で行列を更新する）。
  camera.updateMatrixWorld();
  for (const h of game.course) {
    const target = h === game.target;
    const d = Math.hypot(h.pin.x - from.x, h.pin.z - from.z);
    if (target && !scout && d < 25) continue;
    game.pinTop(h, pinScreen).project(camera);
    if (pinScreen.z >= 1 || Math.abs(pinScreen.x) > 1 || Math.abs(pinScreen.y) > 1) continue;
    const name = `${h.number}`;
    flagMarkers.push({
      x: ((pinScreen.x + 1) / 2) * innerWidth,
      y: ((1 - pinScreen.y) / 2) * innerHeight - (target ? 10 : 2),
      text: target || scout ? `${name} · ${Math.round(d)} m` : name,
      target,
      own: false,
    });
  }
  overlay.setFlagMarkers(flagMarkers);
}

const aimScreen = new THREE.Vector3();
/** 落とし所の輪の上に距離を出す（狙っている間と構えている間）。 */
function placeAimLabel(game: GolfGame): void {
  if (game.phase !== 'aim' && game.phase !== 'swing') {
    overlay.setAimLabel(null);
    return;
  }
  game.aimTop(aimScreen).project(camera);
  if (aimScreen.z >= 1 || Math.abs(aimScreen.x) > 1 || Math.abs(aimScreen.y) > 1) {
    overlay.setAimLabel(null);
    return;
  }
  const d = game.aimDistance;
  overlay.setAimLabel({
    x: ((aimScreen.x + 1) / 2) * innerWidth,
    y: ((1 - aimScreen.y) / 2) * innerHeight,
    text: game.putting ? `${d.toFixed(1)} m` : `${Math.round(d)} m`,
  });
}

const timer = new THREE.Timer();
let elapsed = 0;
renderer.setAnimationLoop(() => {
  timer.update();
  const dt = Math.min(timer.getDelta(), 0.1);
  elapsed += dt;
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
    else golf.updateCamera(camera, dt);
    if (roundResult && roundResultAt > 0 && performance.now() >= roundResultAt && !holeFade) {
      roundResultAt = 0;
      overlay.showRoundResult(roundResult);
      // 結果の窓のボタンを押せるように、マウスを放す（ロックが外れても休憩にはしない）。
      if (document.pointerLockElement === canvas) document.exitPointerLock();
    }
    chunks?.update(camera.position.x, camera.position.z);
    sounds?.update(dt, lastStatus?.windSpeed ?? 0, 1, 0);
    holeMap.setHole(golf.target, courseSampler);
    holeMap.draw(golf.ball.pos, golf.phase === 'aim' || golf.phase === 'swing' ? golf.aimPoint : null, golf.target.pin);
    if (lastStatus) {
      const card = holedCardAt > 0 && performance.now() >= holedCardAt && golf.phase === 'holed' && !holeFade;
      overlay.setScorecard(
        golf.course.map((h) => h.par),
        lastStatus.scores,
        lastStatus.target.number,
        !roundResult && (card || scorecardHeld || overlay.scorecardPinned),
        card ? holedCard(golf) : null,
      );
    }
    if (!finaleCam) {
      placeFlagMarkers(golf, golf.ball.pos);
      placeAimLabel(golf);
    }
  } else if (flyover && sceneReady) {
    // 開始画面・休憩中: コース紹介の空撮。カットの範囲を読み込み、揃うまでは暗いまま待つ（flyover.ts）。
    chunks?.setFocus(flyover.area);
    chunks?.update(camera.position.x, camera.position.z);
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
  fitNearPlane();
  sky.update(camera, elapsed);
  updateIslandLight(dt);
  water.update(camera, elapsed);
  renderer.render(scene, camera);
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
commit();
