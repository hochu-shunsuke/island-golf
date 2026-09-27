import { LIE_NAMES, toPar, type GolfStatus } from '../golf/game';
import { KIND_NAMES } from '../golf/course';
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
}

/** ラウンドの終わりに出す結果。 */
export interface RoundResult {
  /** 合言葉と、ピン・風の日付（「9/27 のピン」）。 */
  seed: string;
  dateLabel: string;
  pars: readonly number[];
  scores: readonly (number | undefined)[];
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
};

/** 打数とパーの差から、スコアカードの印（丸・四角）の種類。 */
function scoreMark(s: number | undefined, p: number): string {
  if (s === undefined) return '';
  const d = s - p;
  return d <= -2 ? 'eagle' : d === -1 ? 'birdie' : d === 0 ? 'par' : d === 1 ? 'bogey' : 'double';
}

/**
 * スコアカードの表（ホール・パー・打数）。current のホールを強調し、fresh なら入れたばかりの打数を弾ませる。
 * stagger なら打数のマスを 1 つずつ順に出す（ラウンドの終わり）。
 */
function scoreTable(
  pars: readonly number[],
  scores: readonly (number | undefined)[],
  current: number,
  fresh: boolean,
  stagger = false,
): string {
  let total = 0;
  let par = 0;
  pars.forEach((p, k) => {
    const s = scores[k];
    if (s === undefined) return;
    total += s;
    par += p;
  });
  const head = pars.map((_, k) => `<th class="${k + 1 === current ? 'now' : ''}">${k + 1}</th>`).join('');
  const parRow = pars.map((p) => `<td>${p}</td>`).join('');
  const scoreRow = pars
    .map((p, k) => {
      const s = scores[k];
      const cls = [scoreMark(s, p), fresh && k + 1 === current ? 'fresh' : '', stagger ? 'stagger' : ''].join(' ');
      const delay = stagger ? ` style="animation-delay:${(300 + k * 90).toString()}ms"` : '';
      return `<td><span class="${cls}"${delay}>${s ?? ''}</span></td>`;
    })
    .join('');
  const sum = pars.reduce((a, b) => a + b, 0);
  return `
    <table>
      <tr><th>ホール</th>${head}<th>計</th></tr>
      <tr class="par"><th>パー</th>${parRow}<td>${sum}</td></tr>
      <tr class="score"><th>打数</th>${scoreRow}<td>${total || ''}<small>${par === 0 ? '' : toPar(total, par)}</small></td></tr>
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
  private readonly courseSeed: HTMLElement;
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
          <p class="tagline">合言葉ひとつで、ゴルフの島がひとつ。</p>
        </header>
        <section class="course-panel">
          <span class="course-label">コース ID</span>
          <div class="course-id">
            <b class="course-seed"></b>
            <button type="button" class="seed-dice" title="ランダムに新しいコースを作る">${ICON.refresh}新しいコース</button>
          </div>
          <p class="status"></p>
          <p class="lead">${DEFAULT_LEAD}</p>
        </section>
        <section class="play-panel">
          <button class="start" disabled>コースを作っています…</button>
          <div class="sub-btns">
            <button type="button" class="join-open">${ICON.enter}IDで入る</button>
            <button type="button" class="share">${ICON.link}共有</button>
          </div>
        </section>
      </aside>
      <div class="modal join-modal" role="dialog" aria-label="IDで入る">
        <div class="modal-card">
          <header class="modal-head">IDで入る<button type="button" class="modal-close" aria-label="閉じる">${ICON.close}</button></header>
          <label class="modal-label" for="join-id">コース ID</label>
          <div class="modal-row">
            <input id="join-id" class="join-input" type="text" maxlength="16" autocapitalize="off" autocomplete="off" spellcheck="false" placeholder="例: k7p2mq9x" />
            <button type="button" class="modal-go join-go">入る</button>
          </div>
          <p class="modal-note">友達から聞いた ID を入れると、同じコースで遊べます。</p>
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
      <div class="attract-caption"></div>
      <div class="hud dim"><span class="hud-seed"></span></div>
      <div class="flight-hud"></div>
      <div class="golf-hud">
        <div class="hole-num"><b class="hole-no"></b><small class="hole-of"></small></div>
        <div class="hole-meta"><div class="golf-hole"></div><div class="golf-line"></div></div>
      </div>
      <div class="wind-meter">
        <div class="wind-dial"><i class="wind-needle"></i></div>
        <div class="wind-info"><b class="wind-num"></b><small>m/s</small><span class="wind-kind"></span></div>
      </div>
      <canvas class="hole-map" width="120" height="220"></canvas>
      <div class="shot-feedback"></div>
      <div class="flag-markers" aria-hidden="true"></div>
      <div class="aim-label" aria-hidden="true"></div>
      <div class="celebrate" aria-live="polite"></div>
      <div class="scorecard"></div>
      <div class="round-result" role="dialog" aria-label="ラウンド終了">
        <div class="rr-card">
          <header class="rr-head"><span class="rr-title">ラウンド終了</span><span class="rr-course"></span></header>
          <div class="rr-total"><b class="rr-strokes"></b><span class="rr-unit">打</span><span class="rr-par"></span></div>
          <div class="rr-best"></div>
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
        <div class="golf-meter"><div class="shot-sweet"></div><div class="shot-needle"></div></div>
        <span class="golf-hint"></span>
      </div>
      <div class="golf-touch">
        <button class="g-btn g-pause" aria-label="休憩"></button>
        <button class="g-btn g-scout">空から</button>
        <button class="g-btn g-cancel">やめる</button>
        <button class="g-btn g-prev" aria-label="長いクラブへ">‹</button>
        <button class="g-btn g-next" aria-label="短いクラブへ">›</button>
        <button class="g-btn g-shot">打つ</button>
      </div>
      <div class="keyboard-guide" aria-label="操作方法" aria-hidden="true">
        <span><kbd>マウス</kbd><kbd>WASD</kbd> 落とし所の輪を動かす</span>
        <span><kbd>Q</kbd><kbd>E</kbd><kbd>ホイール</kbd> クラブ</span>
        <span><kbd>クリック</kbd><kbd>Space</kbd> 構える → 針が真ん中で打つ</span>
        <span><kbd>F</kbd> 空から見る／戻る</span>
        <span><kbd>Esc</kbd> 構えをやめる／休憩</span>
      </div>
      <div class="toast"></div>
    `;

    this.panel = this.root.querySelector('.panel')!;
    this.lead = this.root.querySelector('.lead')!;
    this.courseSeed = this.root.querySelector('.course-seed')!;
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
    this.golfLine = this.root.querySelector('.golf-line')!;
    this.golfPower = this.root.querySelector('.golf-power')!;
    this.shotShort = this.root.querySelector('.shot-short')!;
    this.shotName = this.root.querySelector('.shot-name')!;
    this.shotDist = this.root.querySelector('.shot-dist')!;
    this.shotNeedle = this.root.querySelector('.shot-needle')!;
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
    this.golfHint = this.root.querySelector('.golf-hint')!;
    this.golfTouch = this.root.querySelector('.golf-touch')!;
    this.flagLayer = this.root.querySelector('.flag-markers')!;
    this.golfScoutBtn = this.root.querySelector('.g-scout')!;
  }

  private readonly golfHud: HTMLElement;
  private readonly golfHole: HTMLElement;
  private readonly golfLine: HTMLElement;
  private readonly golfPower: HTMLElement;
  private readonly shotShort: HTMLElement;
  private readonly shotName: HTMLElement;
  private readonly shotDist: HTMLElement;
  private readonly shotNeedle: HTMLElement;
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
  private readonly scorecard: HTMLElement;
  private readonly roundResult: HTMLElement;
  private roundShareText = '';
  private countUp = 0;
  private celebrateTimer = 0;
  private scorecardKey = '';
  /** 打数の表示を押して、スコアカードを出したままにしているか（タッチ）。 */
  scorecardPinned = false;
  private readonly golfHint: HTMLElement;
  private readonly golfTouch: HTMLElement;
  private readonly flagLayer: HTMLElement;
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
    // カップインの後は、真ん中のスコアカードが次へ進む案内を出すので、下の打つ表示はしまう。
    this.golfPower.classList.toggle('on', on && status.phase !== 'moving' && status.phase !== 'holed');
    this.golfPower.classList.toggle('swing', on && status.phase === 'swing');
    this.golfTouch.classList.toggle('swinging', on && status.phase === 'swing');
    if (!status) return;
    const { target } = status;
    const total = status.total > 0 ? ` · 通算 ${toPar(status.total, status.totalPar)}` : '';
    const holeText = `${KIND_NAMES[target.kind]} · パー ${target.par} · ${Math.round(target.length)} m`;
    const shot = status.phase === 'holed' ? `${status.strokes} 打でカップイン` : `${status.strokes + 1} 打目`;
    const line = `${shot} · ピンまで ${Math.round(status.toPin)} m${total}`;
    const putt = status.club.loft === 0;
    // 狙いの距離: パットは小数 1 桁まで。
    const dist = putt ? status.aimDistance.toFixed(1) : String(Math.round(status.aimDistance));
    const reach = putt ? '' : ` / ${Math.round(status.reach)}`;
    // ライと、狙いの高低差（1m 以上のときだけ）。
    const elev = Math.abs(status.elevation) >= 1 ? ` · ${status.elevation > 0 ? '↑' : '↓'} ${Math.round(Math.abs(status.elevation))} m` : '';
    const lie = `${LIE_NAMES[status.lie]}${elev}`;
    const text = holeText + line + status.club.name + status.phase + dist + reach + lie;
    if (text !== this.golfText) {
      this.golfText = text;
      this.holeNo.textContent = String(target.number);
      this.holeOf.textContent = `/${status.holeCount}`;
      this.golfHole.textContent = holeText;
      this.golfLine.textContent = line;
      this.shotLie.textContent = lie;
      this.shotShort.textContent = status.club.short;
      this.shotName.textContent = status.club.name;
      // 狙いまでの距離と、このクラブ・ライで届く一番遠い距離。
      this.shotDist.innerHTML = `<b>${dist}</b> m<small>${reach}</small>`;
      this.golfHint.textContent =
        status.phase === 'swing'
          ? this.touch
            ? '針が真ん中に来たら、もう一度 打つ（やめるで戻る）'
            : '針が真ん中に来たら、もう一度押す（Esc か右クリックで戻る）'
          : this.touch
            ? '画面をなぞって輪を動かす · 打つで構える'
            : 'マウスで輪を動かす · クリックか Space で構える';
    }
    this.shotNeedle.style.transform = `translateX(${(((status.needle + 1) / 2) * 100).toFixed(2)}%)`;
    // 風のメーター: 針は狙う向きを上にした風の向き。数字は大きく。
    const calm = status.windSpeed < 0.3;
    this.windNeedle.style.visibility = calm ? 'hidden' : 'visible';
    this.windNeedle.style.transform = `rotate(${status.windAngle.toFixed(3)}rad)`;
    const deg = (Math.abs(status.windAngle) * 180) / Math.PI;
    const kind = calm ? '無風' : deg < 35 ? '追い風' : deg > 145 ? '向かい風' : status.windAngle > 0 ? '左から' : '右から';
    const num = calm ? '0' : status.windSpeed.toFixed(1);
    if (this.windNum.textContent !== num) this.windNum.textContent = num;
    if (this.windKind.textContent !== kind) this.windKind.textContent = kind;
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
    scores: readonly (number | undefined)[],
    current: number,
    visible: boolean,
    card: { head: string; foot: string } | null = null,
  ): void {
    this.scorecard.classList.toggle('on', visible);
    this.scorecard.classList.toggle('result', card !== null);
    const key = `${pars.join(',')}|${scores.join(',')}|${current}|${card?.head ?? ''}|${card?.foot ?? ''}`;
    if (key === this.scorecardKey) return;
    this.scorecardKey = key;
    this.scorecard.innerHTML = `
      ${card ? `<div class="sc-head">${card.head}</div>` : ''}
      ${scoreTable(pars, scores, current, card !== null)}
      ${card ? `<div class="sc-foot">${card.foot}</div>` : ''}`;
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
    q('.rr-table').innerHTML = scoreTable(r.pars, r.scores, 0, false, true);
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
  setFlagMarkers(items: readonly { x: number; y: number; text: string; target: boolean; own: boolean }[]): void {
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
      if (item.text !== m.text) {
        m.text = item.text;
        m.el.textContent = item.text;
      }
      m.el.style.transform = `translate(${item.x.toFixed(1)}px, ${item.y.toFixed(1)}px)`;
    });
  }

  /**
   * タッチのゴルフ用ボタン。scouting（空から見ている間）は「球へ戻る」だけを出す
   * （飛ぶ操作は stroll と同じタッチ操作が受け持つ）。
   */
  setGolfTouch(active: boolean, scouting = false): void {
    this.golfTouch.classList.toggle('on', active);
    this.golfTouch.classList.toggle('scouting', scouting);
    this.golfScoutBtn.textContent = scouting ? '球へ戻る' : '空から';
  }

  /** タッチのゴルフ用ボタンに役割をつなぐ。 */
  bindGolfTouch(handlers: {
    onShotDown: () => void;
    onShotUp: () => void;
    onClub: (step: number) => void;
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
    this.golfTouch.querySelector('.g-prev')!.addEventListener('click', () => handlers.onClub(-1));
    this.golfTouch.querySelector('.g-next')!.addEventListener('click', () => handlers.onClub(1));
    this.golfTouch.querySelector('.g-scout')!.addEventListener('click', () => handlers.onScout());
    this.golfTouch.querySelector('.g-pause')!.addEventListener('click', () => handlers.onPause());
    this.golfTouch.querySelector('.g-cancel')!.addEventListener('click', () => handlers.onCancel());

  }

  /** 合言葉の表示をコースに合わせる（サイコロや URL から変わったとき）。 */
  setParams(params: IslandParams): void {
    this.params = { ...params };
    this.courseSeed.textContent = params.seed;
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

  private updateStartLabel(): void {
    this.startBtn.disabled = !this.ready;
    if (!this.ready) {
      this.startBtn.innerHTML = this.loadingText;
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
    this.root.querySelector('.join-open')!.addEventListener('click', () => {
      joinInput.value = '';
      open(join);
      joinInput.focus();
    });
    const go = () => {
      const seed = joinInput.value.trim();
      if (!seed) return;
      close();
      this.handlers.onSeed(seed);
    };
    this.root.querySelector('.join-go')!.addEventListener('click', go);
    joinInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') go();
      if (e.key === 'Escape') close();
    });
    this.root.querySelector('.share')!.addEventListener('click', () => {
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
