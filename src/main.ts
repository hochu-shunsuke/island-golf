import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import './style.css';
import './touch.css';
import type { Island } from './island/generate';
import { EROSION_PREVIEW_RES, EROSION_RES, FULL_RES, ISLAND_SIZE, PREVIEW_RES } from './island/grid';
import { IslandGround } from './island/ground';
import {
  type IslandParams,
  PARAM_SPECS,
  cleanSeed,
  decodeParams,
  encodeParams,
  randomSeed,
} from './island/params';
import type { GenerateRequest, GenerateResult, WorkerResult } from './island/worker';
import { Player } from './player/controller';
import { ChunkManager } from './render/chunkManager';
import { FarForest } from './render/farForest';
import { setIslandLight, updateIslandLight } from './render/islandLight';
import { OverviewMesh } from './render/overviewMesh';
import { MORNING, Sky } from './render/sky';
import { Water } from './render/water';
import { Overlay } from './ui/overlay';
import { type TouchControls, createTouchControls, hasTouchInput, isTouchDevice } from './ui/touch';
import { drawIslandMap } from './view/mapView';
import { IslandWater } from './world/islandWater';
import { Terrain } from './world/terrain';
import type { Hole } from './golf/course';
import { GolfGame } from './golf/game';

/**
 * island golf（island-maker の島で回るゴルフ。作り始め）。カードのつまみで島を作りながら見渡し、
 * 「この島へ入る」で鳥になって飛ぶ。
 * つまみと種は URL の `#` に載るので、URL を送れば同じ島を渡せる。
 *
 * 入口と操作は stroll と同じ（Pointer Lock とタッチの切り替え、iOS Safari の入力の誤報への備え、
 * Esc で休憩、最初の 15 秒の操作ガイド、速度と高度の表示、AUTO、速さで広がる視野、
 * 高度で薄くなる霧）。休憩すると島を見渡す画面へ戻り、つまみを触れる。
 */

const LOOK_SENSITIVITY = 0.0022;
/** 霧。見渡すときは島全体が見えるよう薄く、飛ぶときは奥行きが出るよう少し濃く。 */
const FOG_MAKE = 0.00007;
const FOG_FLY = 0.0002;
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

let params: IslandParams = decodeParams(location.hash);

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
  onSeed: (seed) => {
    params.seed = cleanSeed(seed) || params.seed;
    overlay.setParams(params);
    commit();
  },
  onParam: (key, value, final) => {
    params[key] = value;
    if (final) commit();
    else request(PREVIEW_RES);
  },
  // サイコロ: 種もつまみも全部振り直して、まったく別の島を引く。
  onRandom: () => {
    params = { ...params, seed: randomSeed() };
    for (const spec of PARAM_SPECS) params[spec.key] = randomParam();
    overlay.setParams(params);
    commit();
  },
});

/** サイコロのつまみ。端（0 や 100）は極端な島になりやすいので、少し内側から引く。 */
function randomParam(): number {
  return Math.round(10 + Math.random() * 80);
}

// ── 島の計算 ───────────────────────────────────────────
// Worker は 1 つ。計算中に新しい依頼が来たら最新の 1 件だけを取っておき、終わったら流す。
const worker = new Worker(new URL('./island/worker.ts', import.meta.url), { type: 'module' });
let nextId = 1;
/** 最後に頼んだ島。これが描かれるまで「入る」を押せない（下見の島で飛ばない）。 */
let lastRequested = 0;
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
/** この島のホール（golf/course.ts）。 */
let hole: Hole | null = null;

function request(n: number): void {
  const erosionN = n === FULL_RES ? EROSION_RES : EROSION_PREVIEW_RES;
  const sun = sky.sunDirection;
  const req: GenerateRequest = { id: nextId++, params: { ...params }, n, erosionN, sun: [sun.x, sun.y, sun.z] };
  lastRequested = req.id;
  overlay.setReady(false);
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
  hole = msg.hole;
  // 島（とホール）が変わったら、回っていたゲームは作り直す。
  if (golf) {
    scene.remove(golf.group);
    golf = null;
  }
  terrain = new Terrain(made, next.landscape, new IslandWater(next.water), hole);
  // 見渡す島の 1 枚と地図は Worker が作ってある。ここでは貼るだけ（画面を止めない）。
  overview.set(msg.overview, msg.overviewWater);
  drawIslandMap(overlay.minimap, msg.map);
  // 水深は川に合わせて彫った後の高さで測る。彫る前の高さだと川の中が浅瀬扱いになり、
  // 川幅いっぱいに岸の泡が立って雪の土手のように見えた。
  const carved = next.landscape.height.map((h, k) => h + next.water.carve[k]);
  water.setHeightMap(carved, next.landscape.n);
  if (ground) ground.terrain = terrain;
  else ground = new IslandGround(terrain);
  // 木は島の後から届く。古い島の木を残すと地形と食い違う。
  farForest.clear();
}

worker.onmessage = (ev: MessageEvent<WorkerResult>) => {
  const msg = ev.data;
  if (msg.type === 'forest') {
    if (msg.id === drawnId) farForest.set(msg.forest);
    return;
  }
  if (msg.type === 'light') {
    // 光は島の後から届く。今見せている島の光だけを使う。
    if (msg.id === drawnId) setIslandLight(msg.lighting);
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
    const full = msg.island.n === FULL_RES;
    overlay.setStatus(full ? `${(msg.ms / 1000).toFixed(1)} 秒で島をつくりました` : '下見しています…');
    overlay.setReady(full && msg.id === lastRequested);
  }
};

function commit(): void {
  history.replaceState(null, '', `#${encodeParams(params)}`);
  request(FULL_RES);
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
  if (golf || !terrain || !hole) return golf;
  golf = new GolfGame(
    terrain,
    hole,
    (status) => overlay.setGolf(playing && !scout ? status : null),
    (text) => overlay.flash(text),
  );
  scene.add(golf.group);
  return golf;
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
    overlay.setGolf(null);
    overlay.setPinMarker(null);
    overlay.flash(
      inputMode === 'touch' ? '空から見ています。「球へ戻る」で打つ所へ。' : '空から見ています。F で球へ戻ります。',
    );
  } else {
    scout = false;
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

function startPlaying(): void {
  if (playing) return;
  playing = true;
  if (!entered) {
    entered = true;
    overlay.setEntered();
  }
  // 近くは stroll と同じチャンク（足元 2m 格子・木）で細かく描き、遠くは島全体の 1 枚に任せる。
  if (island && madeParams) {
    chunks = new ChunkManager(
      scene,
      { params: madeParams, landscape: island.landscape, water: island.water, hole },
      water.material,
    );
    overview.setCoverage(chunks.coverage);
    farForest.setCoverage(chunks.coverage);
  }
  controls.enabled = false;
  golf?.resetCamera();
  if (!scout) {
    camera.fov = GOLF_FOV;
    camera.updateProjectionMatrix();
    golf?.emit();
  }
  fog.density = FOG_FLY;
  overlay.hide();
  overlay.showKeyboardGuide();
  applyTouchUi();
  if (scout && player?.autoFlight) void requestWakeLock();
}

function stopPlaying(): void {
  if (!playing) return;
  playing = false;
  // 押しっぱなし・倒しっぱなしの判定が残らないように全部戻す。
  player?.clearKeys();
  if (golf) golf.aimInput = 0;
  applyTouchUi();
  overlay.setGolf(null);
  overlay.setPinMarker(null);
  overlay.setFlightInfo(false, 0, 0, false);
  void releaseWakeLock();
  chunks?.dispose();
  chunks = null;
  overview.setCoverage(null);
  farForest.setCoverage(null);
  // 今の視点の前方を注視点にして、見渡す視点へ戻る。
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  controls.target.copy(camera.position).addScaledVector(dir, 400);
  if (ground) controls.target.y = Math.max(0, ground.heightAt(controls.target.x, controls.target.z));
  controls.enabled = true;
  controls.update();
  camera.fov = MAKE_FOV;
  camera.updateProjectionMatrix();
  fog.density = FOG_MAKE;
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

document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement === canvas) {
    setInputMode('keys');
    startPlaying();
  } else if (inputMode === 'keys' && playing) {
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
  if (golf) golf.aimInput = 0;
});

// ── ゴルフの入力（キー・マウス・タッチを同じ関数に集める） ─────
/** 打つ操作を押した。カップに入った後なら、もう一度ティーから。 */
function shotDown(): void {
  if (!golf || scout) return;
  if (golf.phase === 'holed') {
    golf.restart();
    return;
  }
  golf.startCharge();
}
function shotUp(): void {
  if (!golf || scout) return;
  golf.release();
}

addEventListener('keydown', (e: KeyboardEvent) => {
  if (!playing) return;
  if (e.code === 'Space') e.preventDefault();
  if (e.code === 'KeyF' && !e.repeat) {
    toggleScout();
    return;
  }
  if (scout) {
    player?.onKey(e.code, true, e.repeat);
    return;
  }
  if (!golf) return;
  if (e.code === 'KeyA' || e.code === 'ArrowLeft') golf.aimInput = 1;
  else if (e.code === 'KeyD' || e.code === 'ArrowRight') golf.aimInput = -1;
  else if ((e.code === 'KeyW' || e.code === 'ArrowUp') && !e.repeat) golf.changeClub(-1);
  else if ((e.code === 'KeyS' || e.code === 'ArrowDown') && !e.repeat) golf.changeClub(1);
  else if (e.code === 'Space' && !e.repeat) shotDown();
});
addEventListener('keyup', (e: KeyboardEvent) => {
  if (!playing) return;
  if (scout) {
    player?.onKey(e.code, false);
    return;
  }
  if (!golf) return;
  if ((e.code === 'KeyA' || e.code === 'ArrowLeft') && golf.aimInput > 0) golf.aimInput = 0;
  if ((e.code === 'KeyD' || e.code === 'ArrowRight') && golf.aimInput < 0) golf.aimInput = 0;
  if (e.code === 'Space') shotUp();
});
addEventListener('mousemove', (e: MouseEvent) => {
  if (document.pointerLockElement !== canvas) return;
  if (scout) player?.onLook(e.movementX, e.movementY, LOOK_SENSITIVITY);
  else golf?.rotateAim(-e.movementX * AIM_MOUSE);
});
addEventListener('mousedown', (e: MouseEvent) => {
  if (document.pointerLockElement === canvas && e.button === 0) shotDown();
});
addEventListener('mouseup', (e: MouseEvent) => {
  if (document.pointerLockElement === canvas && e.button === 0) shotUp();
});
addEventListener(
  'wheel',
  (e: WheelEvent) => {
    if (playing && !scout && golf && Math.abs(e.deltaY) > 4) golf.changeClub(e.deltaY > 0 ? 1 : -1);
  },
  { passive: true },
);

// タッチ: 画面をなぞって狙いを回す。打つ・クラブ・空から・休憩はボタン。
let aimPointer: number | null = null;
let aimLastX = 0;
canvas.addEventListener('pointerdown', (e) => {
  if (!playing || scout || e.pointerType === 'mouse') return;
  aimPointer = e.pointerId;
  aimLastX = e.clientX;
});
canvas.addEventListener('pointermove', (e) => {
  if (e.pointerId !== aimPointer || !golf) return;
  golf.rotateAim(-(e.clientX - aimLastX) * AIM_TOUCH);
  aimLastX = e.clientX;
});
const endAim = (e: PointerEvent) => {
  if (e.pointerId === aimPointer) aimPointer = null;
};
canvas.addEventListener('pointerup', endAim);
canvas.addEventListener('pointercancel', endAim);
overlay.bindGolfTouch({
  onShotDown: shotDown,
  onShotUp: shotUp,
  onClub: (step) => golf?.changeClub(step),
  onScout: toggleScout,
  onPause: stopPlaying,
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

/**
 * 見渡すとき、島をカードの外の空いた所の真ん中に映す（カメラの中心をずらす）。
 * PC はカードが左にあるので右へ、スマホはカードが下にあるので上へずらす。飛んでいる間は戻す。
 * カードの出入りに合わせて少しずつ動かす。
 */
const viewShift = { x: 0, y: 0 };
function frameIsland(dt: number): void {
  const w = Math.max(1, innerWidth);
  const h = Math.max(1, innerHeight);
  const rect = playing ? null : overlay.panelRect();
  let tx = 0;
  let ty = 0;
  if (rect) {
    // 横に空きがあるならカードの右側の真ん中、無ければカードの上側の真ん中。
    if (rect.right < w * 0.6) tx = rect.right / 2;
    else ty = (rect.top - h) / 2;
  }
  const k = 1 - Math.exp(-8 * dt);
  viewShift.x += (tx - viewShift.x) * k;
  viewShift.y += (ty - viewShift.y) * k;
  if (Math.abs(viewShift.x) < 0.5 && Math.abs(viewShift.y) < 0.5) {
    if (camera.view) camera.clearViewOffset();
    return;
  }
  camera.setViewOffset(w, h, -viewShift.x, -viewShift.y, w, h);
}

const pinScreen = new THREE.Vector3();
/** ピンの目印を、旗の上の実際の画面位置へ（遠いと旗が小さくて見えないため）。近ければ出さない。 */
function placePinMarker(game: GolfGame): void {
  const b = game.ball.pos;
  const far = Math.hypot(game.hole.pin.x - b.x, game.hole.pin.z - b.z) > 25;
  pinScreen.copy(game.pinTop).project(camera);
  const inView = pinScreen.z < 1 && Math.abs(pinScreen.x) < 1 && Math.abs(pinScreen.y) < 1;
  if (!far || !inView) {
    overlay.setPinMarker(null);
    return;
  }
  overlay.setPinMarker({
    x: ((pinScreen.x + 1) / 2) * innerWidth,
    y: ((1 - pinScreen.y) / 2) * innerHeight,
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
    golf.update(dt);
    golf.updateCamera(camera, dt);
    chunks?.update(camera.position.x, camera.position.z);
    placePinMarker(golf);
  } else {
    controls.update();
  }
  frameIsland(dt);
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
    hole: () => hole,
    golf: () => golf,
    // 自動ブラウザは Pointer Lock を持たないので、入口を省いて始める。
    play: () => {
      if (ensureGolf()) startPlaying();
    },
    scout: () => toggleScout(),
  };
}
// 開いたら、まず粗い下見（約 0.3 秒）で島を見せ、続けて本番の細かさで作り直す。
request(PREVIEW_RES);
commit();
