import { isRoomId } from '../../shared/room';
import { PERFECT } from '../golf/aim';
import { LIE_NAMES, toPar, type GolfStatus } from '../golf/game';
import type { IslandParams } from '../island/params';

/**
 * Hole in Isle の画面。見た目は stroll と同じ言葉（モノクロのガラス、字間を空けた見出し、丸いボタン）。
 *
 * 開始・休憩の画面は、後ろでコース紹介の空撮を流し、部品を四隅に寄せる:
 * 左上にタイトル、左下にコース ID と「新しいコース」、右下に「プレイ」と「IDで入る」「共有」。
 */

export interface OverlayHandlers {
  /** 「IDで入る」でコースの合言葉を入れたとき。 */
  onSeed: (seed: string) => void;
  /** 「プレイ」「続きから」。pointerType は入口に使われた入力（resolveEntryPointerType）。 */
  onStart: (pointerType: string) => void;
  /** 「新しいコース」。合言葉を振り直す。 */
  onRandom: () => void;
  /** ラウンドの終わりの「もう一度回る」。 */
  onAgain: () => void;
  /** ラウンドの終わりの「新しいコース」（開始画面へ戻って合言葉を振り直す）。 */
  onNewCourse: () => void;
  /** 遊び方（COM と対戦・ひとりで）を替えた。 */
  onMode: (mode: PlayMode) => void;
  /** 「今日のコースへ」（別のコースを回っているとき）。 */
  onToday: () => void;
  /** 「部屋に入る」で部屋の番号（数字 6 桁）を入れた。 */
  onJoinRoom: (id: string) => void;
  /** 友達とのときの 2 つ目のボタン（部屋に入る・友達を呼ぶ）。 */
  onFriendsSecondary: () => void;
  /** 部屋の窓の下の大きなボタン（はじめる・スタート）。pointerType は押した入力。 */
  onRoomAction: (pointerType: string) => void;
  /** 部屋を出る。 */
  onRoomLeave: () => void;
  /** 名前を替えた。 */
  onRoomName: (name: string) => void;
}

/** 遊び方。 */
export type PlayMode = 'solo' | 'com' | 'friends';

/** 部屋の窓に出す様子。 */
export interface RoomPanel {
  id: string;
  /** 友達を呼ぶリンク。 */
  link: string;
  /** 上の一文（つないでいます・友達を待っています・始まりました など）。 */
  status: string;
  /** note は名前の右の小さな札（プレイ中・準備中・離席中）。 */
  players: { name: string; color: number | null; you: boolean; online: boolean; note: string | null }[];
  /** 下の大きなボタン（はじめる・スタート など）。null なら出さない。 */
  action: { label: string; enabled: boolean } | null;
}

/** スコアカードの 1 行（プレイヤーか COM の 1 人）。 */
export interface ScoreRow {
  label: string;
  /** ホールごとの打数（回っていないホールは null か undefined）。 */
  scores: readonly (number | null | undefined)[];
  /** 自分の行（強調する）。 */
  you?: boolean;
  /** COM の色（名前の前の点）。 */
  color?: number;
}

/** 順位の表示の 1 行。 */
export interface StandingRow {
  rank: number;
  name: string;
  color: number | null;
  /** 回り終えたホールの通算（+2・±0）。 */
  total: string;
  /** 今のホールの様子（「ティー」「3 打」、入れたら「✓」）。 */
  now: string;
  you: boolean;
}

/** ラウンドの終わりに出す結果。 */
export interface RoundResult {
  /** 合言葉と、ピン・風の日付（「9/27 のピン」）。 */
  seed: string;
  dateLabel: string;
  pars: readonly number[];
  scores: readonly (number | null | undefined)[];
  total: number;
  totalPar: number;
  /** このラウンドの前までの自己ベスト（初めてなら null）と、更新したか。 */
  best: { total: number; par: number } | null;
  newBest: boolean;
  gir: number;
  fairway: number;
  fairwayOf: number;
  putts: number;
  birdies: number;
  /** 「結果を共有」で渡す文。 */
  shareText: string;
  /** COM と回ったときの順位（ひとりなら空）。 */
  ranking: readonly { rank: number; name: string; total: number; toPar: string; you: boolean; color: number | null }[];
  /** スコアカードの COM の行（ひとりなら空）。 */
  rivalRows: readonly ScoreRow[];
}

/** 見出しの下の一文。ふだんは出さず、休憩中の知らせだけに使う。 */
const DEFAULT_LEAD = '';

/** 線だけの小さなアイコン（字と同じ色）。 */
const svg = (d: string) =>
  `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
const ICON = {
  refresh: svg('M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5'),
  enter: svg('M10 17l5-5-5-5M15 12H3M14 4h5a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-5'),
  link: svg('M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1'),
  close: svg('M6 6l12 12M18 6L6 18'),
  /** 空から見る（目）。 */
  eye: svg('M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'),
  /** 書き替える（コース ID を入れる）。 */
  edit: svg('M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4'),
  /** 球へ戻る（戻る矢印）。 */
  back: svg('M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11'),
};

/** 旗の札の小さな旗（打つ間、番号の代わりに付ける）。 */
const FLAG_ICON = `<svg class="fm-flag" viewBox="0 0 12 14" aria-hidden="true"><path d="M2.5 1.2v11.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"/><path d="M3.2 1.6h7l-1.9 2.4 1.9 2.4h-7z" fill="currentColor"/></svg>`;

/** 打つボタンの球（白い丸の中に、くぼみの点）。 */
const BALL_ICON = `<svg class="ball-icon" viewBox="0 0 24 24" aria-hidden="true">
  <circle cx="12" cy="12" r="8.5"/>
  <circle class="dimple" cx="9" cy="9.5" r="1.1"/><circle class="dimple" cx="13" cy="8.5" r="1.1"/>
  <circle class="dimple" cx="15" cy="12.2" r="1.1"/><circle class="dimple" cx="10.5" cy="13.4" r="1.1"/>
  <circle class="dimple" cx="13.6" cy="15.8" r="1.1"/>
</svg>`;

/** 打数とパーの差から、スコアカードの印（丸・四角）の種類。 */
function scoreMark(s: number | null | undefined, p: number): string {
  if (s == null) return '';
  const d = s - p;
  return d <= -2 ? 'eagle' : d === -1 ? 'birdie' : d === 0 ? 'par' : d === 1 ? 'bogey' : 'double';
}

/** 名前などを HTML に埋めるとき、タグとして読まれないように。 */
function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** 0xrrggbb → CSS の色。 */
function hex(c: number): string {
  return `#${c.toString(16).padStart(6, '0')}`;
}

/**
 * スコアカードの表（ホール・パー・打数の行）。rows の 1 行目が自分、続けて COM。current のホールを強調し、
 * fresh なら入れたばかりの打数を弾ませる。stagger なら打数のマスを 1 つずつ順に出す（ラウンドの終わり）。
 */
function scoreTable(
  pars: readonly number[],
  rows: readonly ScoreRow[],
  current: number,
  fresh: boolean,
  stagger = false,
): string {
  const head = pars.map((_, k) => `<th class="${k + 1 === current ? 'now' : ''}">${k + 1}</th>`).join('');
  const parRow = pars.map((p) => `<td>${p}</td>`).join('');
  const sum = pars.reduce((a, b) => a + b, 0);
  const many = rows.length > 1;
  const body = rows
    .map((row, n) => {
      let total = 0;
      let par = 0;
      pars.forEach((p, k) => {
        const s = row.scores[k];
        if (s == null) return;
        total += s;
        par += p;
      });
      const cells = pars
        .map((p, k) => {
          const s = row.scores[k];
          const cls = [scoreMark(s, p), fresh && k + 1 === current ? 'fresh' : '', stagger ? 'stagger' : ''].join(' ');
          const delay = stagger ? ` style="animation-delay:${(300 + (k + n * 3) * 70).toString()}ms"` : '';
          return `<td><span class="${cls}"${delay}>${s ?? ''}</span></td>`;
        })
        .join('');
      const dot = row.color !== undefined ? `<i class="sc-dot" style="background:${hex(row.color)}"></i>` : '';
      const label = many ? `${dot}${escapeHtml(row.label)}` : '打数';
      return `<tr class="score${row.you && many ? ' you' : ''}"><th>${label}</th>${cells}<td>${total || ''}<small>${par === 0 ? '' : toPar(total, par)}</small></td></tr>`;
    })
    .join('');
  return `
    <table>
      <tr><th>ホール</th>${head}<th>計</th></tr>
      <tr class="par"><th>パー</th>${parRow}<td>${sum}</td></tr>
      ${body}
    </table>`;
}

/** 文をクリップボードへ。API が無い所（http の LAN など）は昔のやり方で。できなければ false。 */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}

export class Overlay {
  private readonly root: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly lead: HTMLElement;
  private readonly courseSeed: HTMLButtonElement;
  private readonly attractCaption: HTMLElement;
  private readonly screenFade: HTMLElement;
  private fadeShown = -1;
  private attractText = '';
  private readonly startBtn: HTMLButtonElement;
  private readonly status: HTMLElement;
  private readonly hud: HTMLElement;
  private readonly hudSeed: HTMLElement;
  private readonly flightHud: HTMLElement;
  private readonly keyboardGuide: HTMLElement;
  private readonly toast: HTMLElement;
  private params: IslandParams;
  private touch: boolean;
  private readonly touchCapable: boolean;
  private ready = false;
  /** プレイのボタンの字の差し替え（null なら「プレイ」「続きから」）。 */
  private startLabel: string | null = null;
  /** 押せない間のボタンの字（作っている段階）。 */
  private loadingText = 'コースを作っています…';
  private entered = false;
  private flightText = '';
  private toastTimer = 0;
  private keyboardGuideTimer = 0;
  private keyboardGuideShown = false;

  constructor(
    root: HTMLElement,
    params: IslandParams,
    touch: boolean,
    touchCapable: boolean,
    private readonly handlers: OverlayHandlers,
  ) {
    this.root = root;
    this.params = { ...params };
    this.touch = touch;
    this.touchCapable = touchCapable;

    this.root.innerHTML = `
      <div class="screen-fade"></div>
      <aside class="panel">
        <header class="title">
          <h1 class="title-logo">Hole in Isle</h1>
        </header>
        <section class="course-panel">
          <div class="course-top">
            <span class="course-label">コース ID</span>
            <button type="button" class="today-btn">今日のコースへ</button>
          </div>
          <div class="course-id">
            <button type="button" class="course-seed" title="別のコース ID を入れる"></button>
            <div class="course-actions">
              <button type="button" class="icon-btn course-share" aria-label="このコースを共有" title="このコースを共有">${ICON.link}</button>
              <button type="button" class="seed-dice" title="ランダムに新しいコースを作る">${ICON.refresh}新しいコース</button>
            </div>
          </div>
          <p class="status"></p>
          <p class="music-credit">BGM: <a href="https://musmus.main.jp" target="_blank" rel="noreferrer">MusMus</a></p>
        </section>
        <section class="play-panel">
          <p class="lead">${DEFAULT_LEAD}</p>
          <div class="mode-switch" role="radiogroup" aria-label="遊び方">
            <button type="button" class="mode-btn" data-mode="solo" role="radio">ひとりで</button>
            <button type="button" class="mode-btn" data-mode="com" role="radio">COM と対戦</button>
            <button type="button" class="mode-btn" data-mode="friends" role="radio">友達と</button>
          </div>
          <button class="start" disabled>コースを作っています…</button>
          <button type="button" class="join-room">${ICON.enter}部屋に入る</button>
        </section>
      </aside>
      <div class="modal join-modal" role="dialog">
        <div class="modal-card">
          <header class="modal-head"><span class="join-title"></span><button type="button" class="modal-close" aria-label="閉じる">${ICON.close}</button></header>
          <label class="modal-label join-label" for="join-id"></label>
          <div class="modal-row">
            <input id="join-id" class="join-input" type="text" maxlength="16" autocapitalize="off" autocomplete="off" spellcheck="false" />
            <button type="button" class="modal-go join-go">入る</button>
          </div>
          <p class="modal-note join-note"></p>
        </div>
      </div>
      <div class="modal share-modal" role="dialog" aria-label="このコースを共有">
        <div class="modal-card">
          <header class="modal-head">このコースを共有<button type="button" class="modal-close" aria-label="閉じる">${ICON.close}</button></header>
          <label class="modal-label">リンク</label>
          <div class="modal-row"><input class="share-link" type="text" readonly /><button type="button" class="modal-go copy-link">コピー</button></div>
          <label class="modal-label">コース ID</label>
          <div class="modal-row"><input class="share-id" type="text" readonly /><button type="button" class="modal-go copy-id">コピー</button></div>
          <p class="modal-note">リンクを送るか ID を伝えると、同じコース・同じピンと風で遊べます。</p>
        </div>
      </div>
      <div class="modal room-modal" role="dialog" aria-label="部屋">
        <div class="modal-card">
          <header class="modal-head">友達と回る<button type="button" class="modal-close room-close" aria-label="閉じる">${ICON.close}</button></header>
          <div class="room-code"><span>部屋の番号</span><b class="room-id"></b></div>
          <p class="room-status"></p>
          <ul class="room-players"></ul>
          <label class="modal-label" for="room-name">あなたの名前</label>
          <div class="modal-row"><input id="room-name" class="room-name" type="text" maxlength="12" autocomplete="off" spellcheck="false" /></div>
          <label class="modal-label">友達を呼ぶ</label>
          <div class="modal-row"><input class="room-link" type="text" readonly /><button type="button" class="modal-go room-copy">${touch ? '送る' : 'コピー'}</button></div>
          <p class="modal-note">友達はこのリンクを開くか、「友達と」→「部屋に入る」でこの番号を入れると入れます。</p>
          <div class="room-actions">
            <button type="button" class="room-leave">部屋を出る</button>
            <button type="button" class="room-action"></button>
          </div>
        </div>
      </div>
      <div class="attract-caption"></div>
      <div class="hud dim"><span class="hud-seed"></span></div>
      <div class="flight-hud"></div>
      <div class="golf-hud">
        <div class="hole-num"><b class="hole-no"></b><small class="hole-of"></small></div>
        <div class="hole-meta"><div class="golf-hole"></div><div class="golf-line"><span class="gl-shot"></span><span class="gl-total"></span></div></div>
      </div>
      <div class="wind-meter">
        <div class="wind-dial"><i class="wind-needle"></i></div>
        <div class="wind-info"><b class="wind-num"></b><small>m/s</small><span class="wind-kind"></span></div>
      </div>
      <canvas class="hole-map" width="120" height="220"></canvas>
      <div class="shot-feedback"></div>
      <div class="flag-markers" aria-hidden="true"></div>
      <div class="rival-markers" aria-hidden="true"></div>
      <button type="button" class="score-chip" aria-label="順位を開く"></button>
      <div class="standings" aria-label="順位"></div>
      <div class="aim-label" aria-hidden="true"></div>
      <div class="celebrate" aria-live="polite"></div>
      <div class="hole-wait" aria-live="polite"></div>
      <div class="scorecard"></div>
      <div class="round-result" role="dialog" aria-label="ラウンド終了">
        <div class="rr-card">
          <header class="rr-head"><span class="rr-title">ラウンド終了</span><span class="rr-course"></span></header>
          <div class="rr-total"><b class="rr-strokes"></b><span class="rr-unit">打</span><span class="rr-par"></span></div>
          <div class="rr-best"></div>
          <div class="rr-ranking"></div>
          <div class="rr-table"></div>
          <div class="rr-stats"></div>
          <div class="rr-actions">
            <button type="button" class="rr-again">もう一度回る</button>
            <button type="button" class="rr-share">${ICON.link}結果を共有</button>
            <button type="button" class="rr-new">${ICON.refresh}新しいコース</button>
          </div>
        </div>
      </div>
      <div class="golf-power">
        <div class="shot-top">
          <span class="shot-club"><b class="shot-short"></b><span class="shot-name"></span></span>
          <span class="shot-lie"></span>
          <span class="shot-dist"></span>
        </div>
      </div>
      <div class="timing" aria-hidden="true">
        <div class="t-track"><i class="t-sweet"></i><i class="t-needle"></i></div>
      </div>
      <div class="golf-touch">
        <button class="g-btn g-pause" aria-label="休憩"></button>
        <button class="g-btn g-scout" aria-label="空から見る">${ICON.eye}</button>
        <button class="g-btn g-cancel" aria-label="構えをやめる">${ICON.close}</button>
        <button class="g-btn g-shot" aria-label="打つ">${BALL_ICON}</button>
      </div>
      <div class="keyboard-guide" aria-label="操作方法" aria-hidden="true">
        <span><kbd>マウス</kbd><kbd>WASD</kbd> 落とし所の輪を動かす</span>
        <span><kbd>クリック</kbd><kbd>Space</kbd> 構える → 針が真ん中で打つ</span>
        <span><kbd>F</kbd> 空から見る／戻る</span>
        <span><kbd>Esc</kbd> 構えをやめる／休憩</span>
      </div>
      <div class="toast"></div>
    `;

    this.panel = this.root.querySelector('.panel')!;
    this.lead = this.root.querySelector('.lead')!;
    this.courseSeed = this.root.querySelector('.course-seed')!;
    this.roomModal = this.root.querySelector('.room-modal')!;
    this.bindRoom();
    this.courseLabel = this.root.querySelector('.course-label')!;
    this.coursePanel = this.root.querySelector('.course-panel')!;
    this.todayBtn = this.root.querySelector('.today-btn')!;
    this.todayBtn.addEventListener('click', () => this.handlers.onToday());
    this.attractCaption = this.root.querySelector('.attract-caption')!;
    this.screenFade = this.root.querySelector('.screen-fade')!;
    this.startBtn = this.root.querySelector('.start')!;
    this.status = this.root.querySelector('.status')!;
    this.hud = this.root.querySelector('.hud')!;
    this.hudSeed = this.root.querySelector('.hud-seed')!;
    this.flightHud = this.root.querySelector('.flight-hud')!;
    this.keyboardGuide = this.root.querySelector('.keyboard-guide')!;
    this.toast = this.root.querySelector('.toast')!;

    this.root.querySelector('.seed-dice')!.addEventListener('click', () => this.handlers.onRandom());
    this.bindModals();
    this.bindEntryButton(this.startBtn);
    this.setParams(params);

    this.golfHud = this.root.querySelector('.golf-hud')!;
    this.golfHole = this.root.querySelector('.golf-hole')!;
    this.golfShot = this.root.querySelector('.gl-shot')!;
    this.golfTotal = this.root.querySelector('.gl-total')!;
    this.scoreChip = this.root.querySelector('.score-chip')!;
    // スマホ: 通算と順位の札を押すと、順位表を開く・しまう。
    this.scoreChip.addEventListener('click', () => {
      if (!this.standingsShown) return;
      this.standings.classList.toggle('open');
      this.scoreChip.classList.toggle('open', this.standings.classList.contains('open'));
    });
    this.golfPower = this.root.querySelector('.golf-power')!;
    this.shotShort = this.root.querySelector('.shot-short')!;
    this.shotName = this.root.querySelector('.shot-name')!;
    this.shotDist = this.root.querySelector('.shot-dist')!;
    this.timing = this.root.querySelector('.timing')!;
    this.timingNeedle = this.root.querySelector('.t-needle')!;
    this.aimLabel = this.root.querySelector('.aim-label')!;
    this.holeNo = this.root.querySelector('.hole-no')!;
    this.holeOf = this.root.querySelector('.hole-of')!;
    this.windMeter = this.root.querySelector('.wind-meter')!;
    this.windNeedle = this.root.querySelector('.wind-needle')!;
    this.windNum = this.root.querySelector('.wind-num')!;
    this.windKind = this.root.querySelector('.wind-kind')!;
    this.shotLie = this.root.querySelector('.shot-lie')!;
    this.feedbackEl = this.root.querySelector('.shot-feedback')!;
    this.holeMapCanvas = this.root.querySelector('.hole-map')!;
    this.celebrateEl = this.root.querySelector('.celebrate')!;
    this.holeWait = this.root.querySelector('.hole-wait')!;
    this.scorecard = this.root.querySelector('.scorecard')!;
    this.roundResult = this.root.querySelector('.round-result')!;
    this.root.querySelector('.rr-again')!.addEventListener('click', () => this.handlers.onAgain());
    this.root.querySelector('.rr-new')!.addEventListener('click', () => this.handlers.onNewCourse());
    const shareBtn = this.root.querySelector('.rr-share') as HTMLButtonElement;
    shareBtn.addEventListener('click', () => void this.shareResult(shareBtn));
    // 左上の表示の下端。狭い画面で何行かに折り返しても、風のメーターと地図をその下に置く（style.css）。
    new ResizeObserver(() => {
      this.root.style.setProperty('--hud-bottom', `${Math.round(this.golfHud.getBoundingClientRect().bottom)}px`);
    }).observe(this.golfHud);
    // 打数の表示を押すと、スコアカードを出す・しまう（タッチには Tab が無いため）。
    this.golfHud.addEventListener('click', () => {
      this.scorecardPinned = !this.scorecardPinned;
    });
    this.golfTouch = this.root.querySelector('.golf-touch')!;
    this.flagLayer = this.root.querySelector('.flag-markers')!;
    this.rivalLayer = this.root.querySelector('.rival-markers')!;
    this.standings = this.root.querySelector('.standings')!;
    for (const b of this.root.querySelectorAll<HTMLButtonElement>('.mode-btn')) {
      b.addEventListener('click', () => {
        const mode = b.dataset.mode as PlayMode;
        if (mode === this.mode) return;
        this.setMode(mode);
        this.handlers.onMode(mode);
      });
    }
    this.golfScoutBtn = this.root.querySelector('.g-scout')!;
  }

  private readonly golfHud: HTMLElement;
  private readonly golfHole: HTMLElement;
  private readonly golfShot: HTMLElement;
  private readonly golfTotal: HTMLElement;
  /** スマホの、通算と順位の小さな札（押すと順位表が開く）。 */
  private readonly scoreChip: HTMLElement;
  private chipTotal = '';
  private chipRank: { rank: number; of: number } | null = null;
  private standingsShown = false;
  private readonly golfPower: HTMLElement;
  private readonly shotShort: HTMLElement;
  private readonly shotName: HTMLElement;
  private readonly shotDist: HTMLElement;
  private readonly timing: HTMLElement;
  private readonly timingNeedle: HTMLElement;
  private readonly aimLabel: HTMLElement;
  private aimLabelText = '';
  private readonly holeNo: HTMLElement;
  private readonly holeOf: HTMLElement;
  private readonly windMeter: HTMLElement;
  private readonly windNeedle: HTMLElement;
  private readonly windNum: HTMLElement;
  private readonly windKind: HTMLElement;
  private readonly shotLie: HTMLElement;
  private readonly feedbackEl: HTMLElement;
  /** ホールの小さな地図（ui/holeMap.ts が描く）。 */
  readonly holeMapCanvas: HTMLCanvasElement;
  private feedbackTimer = 0;
  private readonly celebrateEl: HTMLElement;
  private readonly holeWait: HTMLElement;
  private holeWaitText: string | null = null;
  private readonly scorecard: HTMLElement;
  private readonly roundResult: HTMLElement;
  private roundShareText = '';
  private countUp = 0;
  private celebrateTimer = 0;
  private scorecardKey = '';
  /** 打数の表示を押して、スコアカードを出したままにしているか（タッチ）。 */
  scorecardPinned = false;
  private readonly golfTouch: HTMLElement;
  private readonly flagLayer: HTMLElement;
  private readonly courseLabel: HTMLElement;
  private readonly coursePanel: HTMLElement;
  private dailyDate: string | null = null;
  private lockedRoom: string | null = null;
  /** 部屋の番号を入れる窓を開く（bindModals がつなぐ）。 */
  openJoinRoom: () => void = () => {};
  private readonly roomModal: HTMLElement;
  private readonly todayBtn: HTMLElement;
  private readonly rivalLayer: HTMLElement;
  private readonly rivalEls: { el: HTMLElement; text: string }[] = [];
  private readonly standings: HTMLElement;
  private standingsKey = '';
  private mode: PlayMode = 'solo';
  private readonly flagEls: { el: HTMLElement; text: string; cls: string }[] = [];
  private readonly golfScoutBtn: HTMLElement;
  private golfText = '';

  /** ゴルフの表示。null で隠す（休憩中・空から見ている間）。 */
  setGolf(status: GolfStatus | null): void {
    const on = status !== null;
    this.golfHud.classList.toggle('on', on);
    this.windMeter.classList.toggle('on', on);
    this.holeMapCanvas.classList.toggle('on', on);
    this.root.classList.toggle('golfing', on);
    this.scoreChip.classList.toggle('on', on && this.scoreChip.innerHTML !== '');
    // カップインの後は画面のタップで進めるので、下の打つ表示はしまう。
    this.golfPower.classList.toggle('on', on && status.phase !== 'moving' && status.phase !== 'holed');
    this.golfTouch.classList.toggle('swinging', on && status.phase === 'swing');
    this.golfTouch.classList.toggle('holed', on && status.phase === 'holed');
    if (!status) return;
    const { target } = status;
    const totalPar = status.total > 0 ? toPar(status.total, status.totalPar) : '';
    const total = totalPar ? ` · 通算 ${totalPar}` : '';
    const holeText = `パー ${target.par} · ${Math.round(target.length)} m`;
    const shot = status.phase === 'holed' ? `${status.strokes} 打でカップイン` : `${status.strokes + 1} 打目`;
    const remaining = status.phase === 'holed' ? '' : ` · 残り ${Math.round(status.toPin)} m`;
    const line = `${shot}${remaining}`;
    const putt = status.club.loft === 0;
    // 狙いの距離は落とし所に直接出す。ここはクラブで届く最大距離だけにして重複を避ける。
    const reach = putt ? status.aimDistance.toFixed(1) : String(Math.round(status.reach));
    // ライと、狙いの高低差（1m 以上のときだけ）。
    const elev = Math.abs(status.elevation) >= 1 ? ` · ${status.elevation > 0 ? '↑' : '↓'} ${Math.round(Math.abs(status.elevation))} m` : '';
    const lie = `${LIE_NAMES[status.lie]}${elev}`;
    const text = holeText + line + status.club.name + status.phase + reach + lie;
    if (text !== this.golfText) {
      this.golfText = text;
      this.holeNo.textContent = String(target.number);
      this.holeOf.textContent = `/${status.holeCount}`;
      this.golfHole.textContent = holeText;
      this.golfShot.textContent = line;
      this.golfTotal.textContent = total;
      this.shotLie.textContent = lie;
      this.shotShort.textContent = status.club.short;
      this.shotName.textContent = status.club.name;
      this.shotDist.innerHTML = `${putt ? '狙い' : '最大'} <b>${reach}</b> m`;
    }
    // 風のメーター: 針は狙う向きを上にした風の向き。数字は大きく。
    const calm = status.windSpeed < 0.3;
    this.windNeedle.style.visibility = calm ? 'hidden' : 'visible';
    this.windNeedle.style.transform = `rotate(${status.windAngle.toFixed(3)}rad)`;
    const deg = (Math.abs(status.windAngle) * 180) / Math.PI;
    const kind = calm ? '無風' : deg < 35 ? '追い風' : deg > 145 ? '向かい風' : status.windAngle > 0 ? '左から' : '右から';
    const num = calm ? '0' : status.windSpeed.toFixed(1);
    if (this.windNum.textContent !== num) this.windNum.textContent = num;
    if (this.windKind.textContent !== kind) this.windKind.textContent = kind;
    if (totalPar !== this.chipTotal) {
      this.chipTotal = totalPar;
      this.renderChip();
    }
  }

  /** 通算と順位の札（スマホ）。順位があれば「1 位 · −1」、ひとりなら「通算 −1」。どちらも無ければ隠す。 */
  private renderChip(): void {
    const r = this.chipRank;
    const total = this.chipTotal || '±0';
    const text = r ? `${r.rank} 位 <small>/ ${r.of}</small> · ${total}` : this.chipTotal ? `通算 ${total}` : '';
    this.scoreChip.innerHTML = text ? `${text}${r ? '<i class="chip-caret"></i>' : ''}` : '';
    this.scoreChip.classList.toggle('on', text !== '' && this.golfHud.classList.contains('on'));
    this.scoreChip.classList.toggle('has-rank', r !== null);
  }

  /** 打った一打のでき（ナイスショット・フック・スライス）を画面の真ん中に大きく。 */
  shotFeedback(kind: 'nice' | 'hook' | 'slice'): void {
    const el = this.feedbackEl;
    el.textContent = kind === 'nice' ? 'ナイスショット！' : kind === 'hook' ? 'フック' : 'スライス';
    el.classList.remove('on', 'nice', 'miss');
    void el.offsetWidth;
    el.classList.add('on', kind === 'nice' ? 'nice' : 'miss');
    window.clearTimeout(this.feedbackTimer);
    this.feedbackTimer = window.setTimeout(() => el.classList.remove('on'), 1600);
  }

  /**
   * 開始画面の後ろのコース紹介（マリオカートのコース紹介のような空撮）の字幕。null で隠す。
   */
  /** 画面の暗転（0..1）。空撮のカットの間と、ホールの切り替えで使う。字や操作の部品より下に敷く。 */
  setFade(a: number): void {
    const v = Math.round(a * 100) / 100;
    if (v === this.fadeShown) return;
    this.fadeShown = v;
    this.screenFade.style.opacity = String(v);
  }

  /**
   * 空撮の字幕。カットの切り替えではゆっくり出し入れする。instant なら動きなしですぐ消す
   * （遊び始めたとき。暗転した画面に字幕だけが一瞬残って見えていた）。
   */
  setAttractCaption(text: string | null, instant = false): void {
    if (instant) {
      this.attractCaption.style.transition = 'none';
      this.attractCaption.classList.remove('on');
      void this.attractCaption.offsetWidth;
      this.attractCaption.style.transition = '';
      return;
    }
    this.attractCaption.classList.toggle('on', text !== null);
    if (text !== null && text !== this.attractText) {
      this.attractText = text;
      this.attractCaption.textContent = text;
    }
  }

  hideScorecard(): void {
    this.scorecardPinned = false;
    this.scorecard.classList.remove('on');
  }

  /** 友達が同じホールを終えるまでの、小さな待機表示。 */
  setHoleWait(text: string | null): void {
    if (text === this.holeWaitText) return;
    this.holeWaitText = text;
    this.holeWait.classList.toggle('on', text !== null);
    if (text !== null) this.holeWait.textContent = text;
  }

  /** カップインのお祝い（大きな文字）。 */
  celebrate(text: string, big: boolean): void {
    this.celebrateEl.textContent = text;
    this.celebrateEl.classList.remove('on', 'big');
    // 同じ文字でもアニメーションをやり直す。
    void this.celebrateEl.offsetWidth;
    this.celebrateEl.classList.add('on');
    if (big) this.celebrateEl.classList.add('big');
    window.clearTimeout(this.celebrateTimer);
    this.celebrateTimer = window.setTimeout(() => this.celebrateEl.classList.remove('on', 'big'), 2600);
  }

  /**
   * スコアカード（9 ホールのパーと打数）。visible で出し入れする。current は今のホール番号（強調する）。
   * card を渡すと、カップインの後の出し方にする: 上に見出し（今のホールのスコア）、下に次へ進む案内。
   */
  setScorecard(
    pars: readonly number[],
    rows: readonly ScoreRow[],
    current: number,
    visible: boolean,
    card: { head: string; foot: string } | null = null,
  ): void {
    this.scorecard.classList.toggle('on', visible);
    this.scorecard.classList.toggle('result', card !== null);
    const key = `${pars.join(',')}|${rows.map((r) => r.scores.join(',')).join('/')}|${current}|${card?.head ?? ''}|${card?.foot ?? ''}`;
    if (key === this.scorecardKey) return;
    this.scorecardKey = key;
    this.scorecard.innerHTML = `
      ${card ? `<div class="sc-head">${card.head}</div>` : ''}
      ${scoreTable(pars, rows, current, card !== null)}
      ${card ? `<div class="sc-foot">${card.foot}</div>` : ''}`;
  }

  /**
   * 今日のコースか。date（「9/27」）を渡すと「今日のコース · 9/27」と出し、null なら「コース ID」と
   * 「今日のコースへ」のボタンを出す。
   */
  setDaily(date: string | null): void {
    this.dailyDate = date;
    this.renderCourseLabel();
  }

  /**
   * 友達の部屋にいる間は、コースを部屋のものに固定する（roomId を渡す。null で外す）。
   * 合言葉の入れ直し・新しいコース・今日のコースへを隠す（押すと黙って部屋を出てしまっていた）。
   */
  setCourseLocked(roomId: string | null): void {
    this.lockedRoom = roomId;
    this.coursePanel.classList.toggle('locked', roomId !== null);
    this.courseSeed.disabled = roomId !== null;
    this.renderCourseLabel();
  }

  private renderCourseLabel(): void {
    const date = this.dailyDate;
    this.courseLabel.textContent = this.lockedRoom
      ? `部屋 ${this.lockedRoom} のコース`
      : date
        ? `今日のコース · ${date}`
        : 'コース ID';
    this.courseLabel.classList.toggle('daily', date !== null || this.lockedRoom !== null);
    this.todayBtn.classList.toggle('on', date === null && this.lockedRoom === null);
  }

  /** 部屋の窓を開く・閉じる。 */
  showRoom(open: boolean): void {
    this.roomModal.classList.toggle('on', open);
  }

  /** 部屋の窓の中身。 */
  setRoom(panel: RoomPanel): void {
    const q = (sel: string) => this.roomModal.querySelector(sel) as HTMLElement;
    q('.room-id').textContent = panel.id;
    q('.room-status').textContent = panel.status;
    q('.room-players').innerHTML = panel.players
      .map(
        (p) =>
          `<li class="${p.online ? '' : 'away'}"><i style="background:${p.color === null ? '#ffffff' : hex(p.color)}"></i>` +
          `<span>${escapeHtml(p.name)}${p.you ? '（あなた）' : ''}</span>` +
          `${p.note ? `<small>${escapeHtml(p.note)}</small>` : ''}</li>`,
      )
      .join('');
    (q('.room-link') as HTMLInputElement).value = panel.link;
    const action = q('.room-action') as HTMLButtonElement;
    action.style.display = panel.action ? '' : 'none';
    if (panel.action) {
      action.textContent = panel.action.label;
      action.disabled = !panel.action.enabled;
    }
  }

  /** 名前の欄（入れ直した名前を消さないよう、打っている間は書き換えない）。 */
  setRoomName(name: string): void {
    const input = this.roomModal.querySelector('.room-name') as HTMLInputElement;
    if (document.activeElement !== input) input.value = name;
  }

  /** 友達とのときの 2 つ目のボタンの字（部屋に入る・友達を呼ぶ）。null で隠す。 */
  setFriendsSecondary(label: string | null): void {
    const b = this.root.querySelector('.join-room') as HTMLElement;
    b.classList.toggle('none', label === null);
    if (label !== null) b.innerHTML = `${label === '友達を呼ぶ' ? ICON.link : ICON.enter}${label}`;
  }

  /** 遊び方の切り替えの見た目（選んでいる方）。 */
  setMode(mode: PlayMode): void {
    this.mode = mode;
    this.root.querySelector('.play-panel')!.classList.toggle('friends', mode === 'friends');
    for (const b of this.root.querySelectorAll<HTMLButtonElement>('.mode-btn')) {
      const on = b.dataset.mode === mode;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    }
  }

  /** 順位の表示（COM や友達と回っている間）。null で隠す。 */
  setStandings(rows: readonly StandingRow[] | null): void {
    const shown = rows !== null && rows.length > 0;
    this.standings.classList.toggle('on', shown);
    const you = rows?.find((r) => r.you);
    const rank = shown && you ? { rank: you.rank, of: rows!.length } : null;
    if (shown !== this.standingsShown || rank?.rank !== this.chipRank?.rank || rank?.of !== this.chipRank?.of) {
      this.standingsShown = shown;
      this.chipRank = rank;
      if (!shown) {
        this.standings.classList.remove('open');
        this.scoreChip.classList.remove('open');
      }
      this.renderChip();
    }
    if (!rows) return;
    const key = rows.map((r) => `${r.rank}${r.name}${r.total}${r.now}`).join('|');
    if (key === this.standingsKey) return;
    this.standingsKey = key;
    this.standings.innerHTML = rows
      .map(
        (r) => `<div class="st-row${r.you ? ' you' : ''}">
          <span class="st-rank">${r.rank}</span>
          <i class="st-dot" style="background:${r.color === null ? '#ffffff' : hex(r.color)}"></i>
          <span class="st-name">${escapeHtml(r.name)}</span>
          <span class="st-now">${r.now}</span>
          <b class="st-total">${r.total}</b>
        </div>`,
      )
      .join('');
  }

  /**
   * COM と友達の球の上の目印。画面の位置（px）で。色の点だけにする（名前は順位表にある。名前の札を出していた頃は、
   * 旗や狙いの距離の札に重なって画面が散らかった）。
   */
  setRivalMarkers(items: readonly { x: number; y: number; text: string; color: number }[]): void {
    while (this.rivalEls.length < items.length) {
      const el = document.createElement('div');
      el.className = 'rival-marker';
      this.rivalLayer.appendChild(el);
      this.rivalEls.push({ el, text: '' });
    }
    this.rivalEls.forEach((m, k) => {
      const item = items[k];
      m.el.classList.toggle('on', item !== undefined);
      if (!item) return;
      if (item.text !== m.text) {
        m.text = item.text;
        m.el.innerHTML = `<i style="background:${hex(item.color)}"></i>`;
        m.el.setAttribute('aria-label', item.text);
      }
      m.el.style.transform = `translate(${item.x.toFixed(1)}px, ${item.y.toFixed(1)}px)`;
    });
  }

  /** 画面の飾りを隠して、ラウンドの終わりの絵にする（打つための表示を全部しまう）。 */
  setFinale(on: boolean): void {
    this.root.classList.toggle('finale', on);
  }

  /** ラウンドの結果を出す。合計の打数は数え上げ、打数のマスは 1 つずつ出す。 */
  showRoundResult(r: RoundResult): void {
    const q = (sel: string) => this.roundResult.querySelector(sel) as HTMLElement;
    q('.rr-course').textContent = `${r.seed} · ${r.dateLabel} のピン`;
    const diff = r.total - r.totalPar;
    const par = q('.rr-par');
    par.textContent = toPar(r.total, r.totalPar);
    par.className = `rr-par ${diff < 0 ? 'under' : diff > 0 ? 'over' : 'even'}`;
    q('.rr-best').innerHTML = r.newBest
      ? r.best
        ? `<span class="rr-badge">自己ベスト更新</span><small>これまで ${r.best.total} 打（${toPar(r.best.total, r.best.par)}）</small>`
        : `<span class="rr-badge">このコースの初めての記録</span>`
      : r.best
        ? `<small>自己ベスト ${r.best.total} 打（${toPar(r.best.total, r.best.par)}）</small>`
        : '';
    q('.rr-table').innerHTML = scoreTable(
      r.pars,
      [{ label: 'あなた', scores: r.scores, you: true }, ...r.rivalRows],
      0,
      false,
      true,
    );
    const me = r.ranking.find((x) => x.you);
    q('.rr-ranking').innerHTML = me
      ? `<div class="rr-place">${me.rank === 1 ? '優勝' : `${me.rank} 位`}<small>${r.ranking.length} 人中</small></div>` +
        r.ranking
          .map(
            (x) => `<div class="rr-rank${x.you ? ' you' : ''}"><span>${x.rank}</span><i style="background:${x.color === null ? '#ffffff' : hex(x.color)}"></i><span>${escapeHtml(x.name)}</span><b>${x.total}</b><small>${x.toPar}</small></div>`,
          )
          .join('')
      : '';
    const holes = r.pars.length;
    q('.rr-stats').innerHTML = [
      [`${r.gir}<small>/${holes}</small>`, 'パーオン'],
      [`${r.fairway}<small>/${r.fairwayOf}</small>`, 'フェアウェイ'],
      [String(r.putts), 'パット'],
      [String(r.birdies), 'バーディ以上'],
    ]
      .map(([v, k]) => `<div><b>${v}</b><span>${k}</span></div>`)
      .join('');
    this.roundShareText = r.shareText;
    const shareBtn = q('.rr-share');
    shareBtn.classList.remove('done');
    shareBtn.innerHTML = `${ICON.link}結果を共有`;
    this.roundResult.classList.remove('on');
    void this.roundResult.offsetWidth;
    this.roundResult.classList.add('on');
    // 合計の打数を数え上げる。
    const strokes = q('.rr-strokes');
    const start = performance.now();
    cancelAnimationFrame(this.countUp);
    const step = (now: number) => {
      const u = Math.min(1, (now - start) / 900);
      strokes.textContent = String(Math.round(r.total * (1 - (1 - u) ** 3)));
      if (u < 1) this.countUp = requestAnimationFrame(step);
    };
    this.countUp = requestAnimationFrame(step);
  }

  hideRoundResult(): void {
    cancelAnimationFrame(this.countUp);
    this.roundResult.classList.remove('on');
  }

  /** 結果を共有: スマホは端末の共有、PC はコピー。 */
  private async shareResult(btn: HTMLElement): Promise<void> {
    const text = this.roundShareText;
    if (this.touch && typeof navigator.share === 'function') {
      try {
        await navigator.share({ text });
      } catch {
        // 取り消した。何もしない。
      }
      return;
    }
    if (await copyText(text)) {
      btn.innerHTML = 'コピーしました';
      btn.classList.add('done');
    }
  }

  /**
   * 構えている間、球のすぐ下に出す正確さのバー（針が左右に振れる）。真ん中の帯で止めるとナイスショット、
   * 端ほど左・右へ曲がる。画面の下の端に置くと、狙いから目線が離れて見づらかった。
   * 同じ太さのバーにする（真ん中が高い山の形は、強さのゲージに見えた）。at は球の画面の位置（px）、null で隠す。
   */
  setTiming(at: { x: number; y: number } | null, needle: number): void {
    this.timing.classList.toggle('on', at !== null);
    if (!at) return;
    this.timing.style.transform = `translate(${at.x.toFixed(1)}px, ${at.y.toFixed(1)}px)`;
    this.timingNeedle.style.left = `${(((needle + 1) / 2) * 100).toFixed(2)}%`;
    this.timing.classList.toggle('sweet', Math.abs(needle) < PERFECT);
  }

  /** 落とし所の輪の上に、距離の目印。画面の位置（px）か、null で隠す。 */
  setAimLabel(at: { x: number; y: number; text: string } | null): void {
    this.aimLabel.classList.toggle('on', at !== null);
    if (!at) return;
    if (at.text !== this.aimLabelText) {
      this.aimLabelText = at.text;
      this.aimLabel.textContent = at.text;
    }
    this.aimLabel.style.transform = `translate(${at.x.toFixed(1)}px, ${at.y.toFixed(1)}px)`;
  }

  /**
   * 旗の目印（番号と距離）。旗の上の実際の画面位置（px）に出す。毎フレーム呼ぶので、
   * 要素は使い回して位置は transform だけで動かす（stroll の友達の名前と同じ）。
   * target は今の目標、own は自分の旗。
   */
  setFlagMarkers(
    items: readonly { x: number; y: number; text: string; target: boolean; own: boolean; flag?: boolean }[],
  ): void {
    while (this.flagEls.length < items.length) {
      const el = document.createElement('div');
      el.className = 'flag-marker';
      this.flagLayer.appendChild(el);
      this.flagEls.push({ el, text: '', cls: '' });
    }
    this.flagEls.forEach((m, k) => {
      const item = items[k];
      const cls = item ? `flag-marker on${item.target ? ' target' : ''}${item.own ? ' own' : ''}` : 'flag-marker';
      if (cls !== m.cls) {
        m.cls = cls;
        m.el.className = cls;
      }
      if (!item) return;
      const key = `${item.flag ? '⚑' : ''}${item.text}`;
      if (key !== m.text) {
        m.text = key;
        if (item.flag) m.el.innerHTML = `${FLAG_ICON}${escapeHtml(item.text)}`;
        else m.el.textContent = item.text;
      }
      m.el.style.transform = `translate(${item.x.toFixed(1)}px, ${item.y.toFixed(1)}px)`;
    });
  }

  /**
   * タッチのゴルフ用ボタン。scouting（空から見ている間）は「球へ戻る」（目のボタンと同じ場所）だけを出す。
   * 飛ぶ操作と休憩は stroll と同じタッチ操作が受け持つ。
   */
  setGolfTouch(active: boolean, scouting = false): void {
    this.golfTouch.classList.toggle('on', active);
    this.golfTouch.classList.toggle('scouting', scouting);
    this.golfScoutBtn.innerHTML = scouting ? ICON.back : ICON.eye;
    this.golfScoutBtn.setAttribute('aria-label', scouting ? '球へ戻る' : '空から見る');
  }

  /** タッチのゴルフ用ボタンに役割をつなぐ。 */
  bindGolfTouch(handlers: {
    onShotDown: () => void;
    onShotUp: () => void;
    onScout: () => void;
    onPause: () => void;
    onCancel: () => void;
  }): void {
    const shot = this.golfTouch.querySelector('.g-shot') as HTMLButtonElement;
    shot.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      shot.setPointerCapture(e.pointerId);
      handlers.onShotDown();
    });
    shot.addEventListener('pointerup', () => handlers.onShotUp());
    shot.addEventListener('pointercancel', () => handlers.onShotUp());
    this.golfTouch.querySelector('.g-scout')!.addEventListener('click', () => handlers.onScout());
    this.golfTouch.querySelector('.g-pause')!.addEventListener('click', () => handlers.onPause());
    this.golfTouch.querySelector('.g-cancel')!.addEventListener('click', () => handlers.onCancel());

  }

  /** 合言葉の表示をコースに合わせる（サイコロや URL から変わったとき）。 */
  setParams(params: IslandParams): void {
    this.params = { ...params };
    // ID を押すと入れ直せる（書き替えの小さな印を添える）。合言葉は英数字だけなのでそのまま埋めてよい。
    this.courseSeed.innerHTML = `${params.seed}${ICON.edit}`;
    this.hudSeed.textContent = params.seed;
  }

  /**
   * iOS Safari はタッチ由来の click を MouseEvent、または pointerType="mouse" として
   * 送る版がある。click だけを見ると PC 用 Pointer Lock へ入り、開始できなくなる。
   * 直前の pointerdown は正しく touch なので、そちらを優先して入口を決める（stroll と同じ）。
   */
  private bindEntryButton(button: HTMLButtonElement): void {
    let recentPointerType = '';
    let recentPointerAt = 0;
    button.addEventListener('pointerdown', (event) => {
      recentPointerType = event.pointerType;
      recentPointerAt = performance.now();
    });
    button.addEventListener('pointerup', () => {
      recentPointerAt = performance.now();
    });
    button.addEventListener('pointercancel', () => {
      recentPointerType = '';
      recentPointerAt = 0;
    });
    button.addEventListener('click', (event) => {
      const clickPointerType =
        typeof PointerEvent !== 'undefined' && event instanceof PointerEvent
          ? event.pointerType
          : event instanceof MouseEvent
            ? 'mouse'
            : '';
      const clickDetail = event instanceof MouseEvent ? event.detail : 0;
      const pointerType = resolveEntryPointerType(
        performance.now() - recentPointerAt < 1_500 ? recentPointerType : '',
        clickPointerType,
        this.touchCapable,
        clickDetail,
      );
      recentPointerType = '';
      recentPointerAt = 0;
      this.handlers.onStart(pointerType);
    });
  }

  /** 島ができていて、作り直しの最中でなければ入れる。 */
  setReady(ready: boolean): void {
    if (ready === this.ready) return;
    this.ready = ready;
    this.updateStartLabel();
  }

  /**
   * 作っている途中の段階（押せない「プレイ」のボタンに出す）。step は 0 から、total は段階の数。
   * ボタンの下の細い線は、終えた段階の割合。
   */
  setLoading(label: string, step: number, total: number): void {
    this.loadingText = `${label}… <small>${step + 1}/${total}</small>`;
    this.startBtn.style.setProperty('--progress', String(step / total));
    this.updateStartLabel();
  }

  /** 島を作るのにかかった時間など、小さな知らせ。 */
  setStatus(text: string): void {
    this.status.textContent = text;
  }

  setInputMode(touch: boolean): void {
    this.touch = touch;
    if (touch) {
      this.keyboardGuide.classList.remove('on');
      this.keyboardGuide.ariaHidden = 'true';
    }
    this.updateStartLabel();
  }

  /** 一度入った後は「続きから」にする。 */
  setEntered(): void {
    this.entered = true;
    this.updateStartLabel();
  }

  /** 別のコースになった（「続きから」ではなく、最初から）。 */
  resetEntered(): void {
    this.entered = false;
    this.updateStartLabel();
  }

  /** プレイのボタンの字を差し替える（友達と: 部屋を作る・部屋を開く）。null で元に戻す。 */
  setStartLabel(label: string | null): void {
    this.startLabel = label;
    this.updateStartLabel();
  }

  private updateStartLabel(): void {
    this.startBtn.disabled = !this.ready;
    if (!this.ready) {
      this.startBtn.innerHTML = this.loadingText;
    } else if (this.startLabel) {
      this.startBtn.textContent = this.startLabel;
    } else if (this.entered) {
      this.startBtn.textContent = '続きから';
    } else {
      this.startBtn.textContent = 'プレイ';
    }
  }

  setFlightInfo(flying: boolean, speed: number, altitude: number, auto: boolean): void {
    if (!flying) {
      if (this.flightText === '') return;
      this.flightText = '';
      this.flightHud.textContent = '';
      this.flightHud.classList.remove('on');
      return;
    }
    const label = auto ? 'AUTO · ' : '';
    const text = `${label}${Math.round(speed * 3.6)} km/h · 高度 ${Math.round(altitude)} m`;
    if (text === this.flightText) return;
    this.flightText = text;
    this.flightHud.textContent = text;
    this.flightHud.classList.add('on');
  }

  /** PC で最初に島へ入ったときだけ、操作を15秒見せる。休憩から戻るたびには繰り返さない。 */
  showKeyboardGuide(): void {
    if (this.touch || this.keyboardGuideShown) return;
    this.keyboardGuideShown = true;
    this.keyboardGuide.classList.add('on');
    this.keyboardGuide.ariaHidden = 'false';
    clearTimeout(this.keyboardGuideTimer);
    this.keyboardGuideTimer = window.setTimeout(() => {
      this.keyboardGuide.classList.remove('on');
      this.keyboardGuide.ariaHidden = 'true';
    }, 15_000);
  }

  /** カードを出す（つくる・休憩）。message は見出しの下の一文を差し替える。 */
  show(message?: string): void {
    this.panel.classList.remove('hidden');
    this.hud.classList.add('dim');
    this.keyboardGuide.classList.remove('on');
    this.keyboardGuide.ariaHidden = 'true';
    this.lead.textContent = message ?? DEFAULT_LEAD;
  }

  /** カードが今占めている画面の四角（隠れていれば null）。島をその外の真ん中に映すのに使う。 */
  panelRect(): DOMRect | null {
    return this.panel.classList.contains('hidden') ? null : this.panel.getBoundingClientRect();
  }

  /** カードを隠す（飛んでいる間）。 */
  hide(): void {
    this.panel.classList.add('hidden');
    this.hud.classList.remove('dim');
  }

  /** 部屋の窓のボタンと名前の欄をつなぐ。 */
  private bindRoom(): void {
    const m = this.roomModal;
    m.querySelector('.room-close')!.addEventListener('click', () => this.showRoom(false));
    m.addEventListener('click', (e) => {
      if (e.target === m) this.showRoom(false);
    });
    m.querySelector('.room-leave')!.addEventListener('click', () => this.handlers.onRoomLeave());
    let lastPointer = 'mouse';
    const action = m.querySelector('.room-action') as HTMLButtonElement;
    action.addEventListener('pointerdown', (e) => {
      lastPointer = e.pointerType || 'mouse';
    });
    action.addEventListener('click', () => this.handlers.onRoomAction(lastPointer));
    const name = m.querySelector('.room-name') as HTMLInputElement;
    const commit = () => this.handlers.onRoomName(name.value);
    name.addEventListener('change', commit);
    name.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') name.blur();
    });
    const copyBtn = m.querySelector('.room-copy') as HTMLButtonElement;
    const link = m.querySelector('.room-link') as HTMLInputElement;
    copyBtn.addEventListener('click', async () => {
      // スマホは端末の共有（LINE などへそのまま送れる）、PC はコピー。
      if (this.touch && typeof navigator.share === 'function') {
        try {
          await navigator.share({ text: `Hole in Isle で一緒に回ろう（部屋 ${link.value.split('@')[1] ?? ''}）`, url: link.value });
        } catch {
          // 取り消した。
        }
        return;
      }
      if (await copyText(link.value)) {
        copyBtn.textContent = 'コピーしました';
        setTimeout(() => (copyBtn.textContent = 'コピー'), 1600);
      } else link.select();
    });
  }

  /**
   * 「IDで入る」と「共有」の窓（Sword Masters などのブラウザゲームの定番: リンクと ID を分けて、
   * それぞれにコピーを付ける）。ID はコースの合言葉そのもの（同じ ID なら同じコース）。
   */
  private bindModals(): void {
    const join = this.root.querySelector('.join-modal') as HTMLElement;
    const share = this.root.querySelector('.share-modal') as HTMLElement;
    const joinInput = this.root.querySelector('.join-input') as HTMLInputElement;
    const shareLink = this.root.querySelector('.share-link') as HTMLInputElement;
    const shareId = this.root.querySelector('.share-id') as HTMLInputElement;
    const open = (m: HTMLElement) => m.classList.add('on');
    const close = () => {
      join.classList.remove('on');
      share.classList.remove('on');
    };
    for (const b of this.root.querySelectorAll('.modal-close')) b.addEventListener('click', close);
    for (const m of [join, share]) {
      m.addEventListener('click', (e) => {
        if (e.target === m) close();
      });
    }
    // 入れる窓: コース ID（コースの札の ID を押す）と、部屋の番号（友達と →「部屋に入る」）で中身を替える。
    let kind: 'course' | 'room' = 'course';
    const openJoin = (k: 'course' | 'room') => {
      kind = k;
      const q = (sel: string) => join.querySelector(sel) as HTMLElement;
      q('.join-title').textContent = k === 'room' ? '部屋に入る' : 'コース ID を入れる';
      q('.join-label').textContent = k === 'room' ? '部屋の番号（数字 6 桁）' : 'コース ID';
      q('.join-note').textContent =
        k === 'room' ? '友達の「友達と回る」の窓に出ている番号です。' : '友達から聞いたコース ID を入れると、同じコースで遊べます。';
      joinInput.placeholder = k === 'room' ? '例: 482913' : '例: k7p2mq9x';
      joinInput.inputMode = k === 'room' ? 'numeric' : 'text';
      joinInput.maxLength = k === 'room' ? 6 : 16;
      joinInput.value = '';
      open(join);
      joinInput.focus();
    };
    this.root.querySelector('.course-seed')!.addEventListener('click', () => openJoin('course'));
    this.openJoinRoom = () => openJoin('room');
    this.root.querySelector('.join-room')!.addEventListener('click', () => this.handlers.onFriendsSecondary());
    const go = () => {
      const value = joinInput.value.trim();
      if (!value) return;
      if (kind === 'room') {
        if (!isRoomId(value)) {
          (join.querySelector('.join-note') as HTMLElement).textContent = '数字 6 桁で入れてください。';
          return;
        }
        close();
        this.handlers.onJoinRoom(value);
      } else {
        close();
        this.handlers.onSeed(value);
      }
    };
    this.root.querySelector('.join-go')!.addEventListener('click', go);
    joinInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') go();
      if (e.key === 'Escape') close();
    });
    this.root.querySelector('.course-share')!.addEventListener('click', () => {
      shareLink.value = `${location.origin}${location.pathname}#${this.params.seed}`;
      shareId.value = this.params.seed;
      open(share);
    });
    // コピーできたかは押したボタンの字で返す（窓の後ろの知らせは見えないため）。
    const copy = async (btn: HTMLButtonElement, input: HTMLInputElement) => {
      if (!(await copyText(input.value))) {
        // コピーできなければ選んだ状態にして、手でコピーしてもらう。
        input.select();
        return;
      }
      btn.textContent = 'コピーしました';
      btn.classList.add('done');
      setTimeout(() => {
        btn.textContent = 'コピー';
        btn.classList.remove('done');
      }, 1600);
    };
    const copyLink = this.root.querySelector('.copy-link') as HTMLButtonElement;
    const copyId = this.root.querySelector('.copy-id') as HTMLButtonElement;
    copyLink.addEventListener('click', () => void copy(copyLink, shareLink));
    copyId.addEventListener('click', () => void copy(copyId, shareId));
    share.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close();
    });
  }

  flash(text: string): void {
    this.toast.textContent = text;
    this.toast.classList.add('on');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toast.classList.remove('on'), 2600);
  }
}

/**
 * 開始操作に使われた入力。引数だけの純粋関数（stroll と同じ。iOS Safari の互換経路）。
 */
export function resolveEntryPointerType(
  recentPointerType: string,
  clickPointerType: string,
  touchCapable: boolean,
  clickDetail: number,
): string {
  // キーボードで button を起動した click は detail=0。タッチ端末でも区別できる。
  if (clickDetail === 0) return 'keyboard';
  if (recentPointerType) return recentPointerType;
  // iOS Safari 18.2 はタッチ由来の click を mouse と報告する。
  if (touchCapable && (clickPointerType === '' || clickPointerType === 'mouse')) {
    return 'touch';
  }
  return clickPointerType || 'keyboard';
}
