import { type IslandParams, PARAM_SPECS, type ParamKey, encodeParams } from '../island/params';

/**
 * island golf の画面（island-maker と同じ作り）。見た目と入口の作りは stroll の開始画面と同じ（ガラスのカード、丸いボタン、
 * 折りたたみの操作説明、飛んでいる間の最小限の表示）。
 *
 * stroll と違うのは、カードが島を隠さないこと。つまみを動かしながら島の変わり方を見るので、
 * PC では左に浮かべ、スマホでは下から出す（全面を暗くする幕は掛けない）。
 */

export interface OverlayHandlers {
  /** 「この島へ入る」。pointerType は入口に使われた入力（resolveEntryPointerType）。 */
  onStart: (pointerType: string) => void;
  /** 合言葉を打ち直したとき。 */
  onSeed: (seed: string) => void;
  /** つまみ。final は指を離したとき（本番の格子で作り直す）。 */
  onParam: (key: ParamKey, value: number, final: boolean) => void;
  /** サイコロ。合言葉もつまみも全部振り直す。 */
  onRandom: () => void;
}

/** 見出しの下の一文。ふだんは出さず、休憩中の知らせだけに使う。 */
const DEFAULT_LEAD = '';

export class Overlay {
  /** 島を真上から描く小さな地図。 */
  readonly minimap: HTMLCanvasElement;
  private readonly root: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly lead: HTMLElement;
  private readonly seedInput: HTMLInputElement;
  private readonly sliders = new Map<ParamKey, { input: HTMLInputElement; value: HTMLElement }>();
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
      <aside class="panel">
        <div class="panel-body">
          <header class="brand">
            <h1>island golf</h1>
            <p class="lead">${DEFAULT_LEAD}</p>
          </header>

          <div class="fields">
            <div class="field">
              <span class="field-label">合言葉</span>
              <div class="seed-field">
                <input class="seed-input" type="text" maxlength="16" autocapitalize="off"
                  autocomplete="off" spellcheck="false" />
                <button type="button" class="seed-dice" title="別の島を引く" aria-label="別の島を引く">⚄</button>
              </div>
              <p class="hint">同じ合言葉とつまみなら、同じ島。サイコロでつまみも全部変わる。</p>
            </div>
            <div class="sliders"></div>
          </div>

          <canvas class="minimap"></canvas>

          <details class="controls">
            <summary>操作</summary>
            <ul class="keys">
              <li><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> 歩く</li>
              <li><kbd>Shift</kbd> 走る／高速飛行</li>
              <li><kbd>Space</kbd> 跳ぶ</li>
              <li><kbd>F</kbd> 飛ぶ／降りる</li>
              <li><kbd>R</kbd> 自動飛行</li>
              <li><kbd>Esc</kbd> 一時停止</li>
            </ul>
            <p class="controls-note">飛行中は <kbd>Space</kbd> 上昇、<kbd>C</kbd> 下降。自動飛行中は視点が自由で、左右だけを押すと新しい進路を保ちます。</p>
          </details>
        </div>

        <footer class="panel-foot">
          <button class="start" disabled>島を作っています…</button>
          <button class="share">この島のURLをコピー</button>
          <p class="status"></p>
        </footer>
      </aside>
      <div class="hud dim"><span class="hud-seed"></span></div>
      <div class="flight-hud"></div>
      <div class="keyboard-guide" aria-label="操作方法" aria-hidden="true">
        <span><kbd>WASD</kbd> 移動</span>
        <span><kbd>マウス</kbd> 見る</span>
        <span><kbd>Shift</kbd> 加速</span>
        <span><kbd>Space</kbd> 跳ぶ／上昇</span>
        <span><kbd>C</kbd> 下降</span>
        <span><kbd>F</kbd> 飛行</span>
        <span><kbd>R</kbd> AUTO</span>
        <span><kbd>Esc</kbd> 休憩</span>
      </div>
      <div class="toast"></div>
    `;

    this.panel = this.root.querySelector('.panel')!;
    this.lead = this.root.querySelector('.lead')!;
    this.seedInput = this.root.querySelector('.seed-input')!;
    this.minimap = this.root.querySelector('.minimap')!;
    this.startBtn = this.root.querySelector('.start')!;
    this.status = this.root.querySelector('.status')!;
    this.hud = this.root.querySelector('.hud')!;
    this.hudSeed = this.root.querySelector('.hud-seed')!;
    this.flightHud = this.root.querySelector('.flight-hud')!;
    this.keyboardGuide = this.root.querySelector('.keyboard-guide')!;
    this.toast = this.root.querySelector('.toast')!;

    const sliders = this.root.querySelector('.sliders')!;
    for (const spec of PARAM_SPECS) {
      const wrap = document.createElement('label');
      wrap.className = 'slider';
      wrap.innerHTML = `
        <span class="slider-head"><span class="field-label"></span><span class="slider-value"></span></span>
        <input type="range" min="0" max="100" step="1" />
        <span class="slider-ends"><span></span><span></span></span>`;
      wrap.querySelector('.field-label')!.textContent = spec.label;
      const ends = wrap.querySelectorAll('.slider-ends span');
      ends[0].textContent = spec.low;
      ends[1].textContent = spec.high;
      const input = wrap.querySelector('input')!;
      const value = wrap.querySelector('.slider-value') as HTMLElement;
      // 動かしている間は粗い格子で下見し、離したら細かい格子で作り直す。
      input.addEventListener('input', () => {
        value.textContent = input.value;
        this.params[spec.key] = Number(input.value);
        this.handlers.onParam(spec.key, Number(input.value), false);
      });
      input.addEventListener('change', () => {
        this.params[spec.key] = Number(input.value);
        this.handlers.onParam(spec.key, Number(input.value), true);
      });
      this.sliders.set(spec.key, { input, value });
      sliders.appendChild(wrap);
    }

    this.seedInput.addEventListener('change', () => this.handlers.onSeed(this.seedInput.value));
    this.seedInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.seedInput.blur();
    });
    this.root.querySelector('.seed-dice')!.addEventListener('click', () => this.handlers.onRandom());
    this.root.querySelector('.share')!.addEventListener('click', () => void this.copyUrl());
    this.bindEntryButton(this.startBtn);
    this.setParams(params);
  }

  /** つまみと合言葉の表示を島に合わせる（サイコロや URL から変わったとき）。 */
  setParams(params: IslandParams): void {
    this.params = { ...params };
    this.seedInput.value = params.seed;
    this.hudSeed.textContent = params.seed;
    for (const spec of PARAM_SPECS) {
      const s = this.sliders.get(spec.key)!;
      s.input.value = String(params[spec.key]);
      s.value.textContent = String(params[spec.key]);
    }
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

  private updateStartLabel(): void {
    this.startBtn.disabled = !this.ready;
    if (!this.ready) {
      this.startBtn.textContent = '島を作っています…';
    } else if (this.entered) {
      this.startBtn.textContent = this.touch ? 'タップして続ける' : '続きから飛ぶ';
    } else {
      this.startBtn.textContent = this.touch ? 'タップして島へ入る' : 'この島へ入る';
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

  private async copyUrl(): Promise<void> {
    const url = `${location.origin}${location.pathname}#${encodeParams(this.params)}`;
    try {
      await navigator.clipboard.writeText(url);
      this.flash('リンクをコピーしました。友達に同じ島を渡せます。');
    } catch {
      this.flash(url);
    }
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
