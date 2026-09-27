import type { AudioEngine } from './engine';

/** public の MP3 は初期バンドルには入らず、プレイを押すまで取得しない。 */
export const MUSIC_TRACK = '/mp3/MusMus-BGM-102.mp3';

/**
 * MP3 を HTMLAudioElement でストリーミング再生する。
 * AudioBuffer に全曲を展開しないので、4 分前後の曲でもスマホのメモリを大きく消費しない。
 */
export class Music {
  private readonly element = new Audio();
  private readonly gain: GainNode;
  private current = '';
  private pauseTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly engine: AudioEngine) {
    this.element.preload = 'none';
    this.element.loop = true;
    const source = engine.ctx.createMediaElementSource(this.element);
    this.gain = engine.ctx.createGain();
    this.gain.gain.value = 0;
    source.connect(this.gain).connect(engine.master);
  }

  /** 利用者がプレイを押したときだけ、選ばれた 1 曲の取得と再生を始める。 */
  play(): void {
    if (this.pauseTimer !== null) {
      clearTimeout(this.pauseTimer);
      this.pauseTimer = null;
    }
    if (MUSIC_TRACK !== this.current) {
      this.element.pause();
      this.element.src = MUSIC_TRACK;
      this.current = MUSIC_TRACK;
    }
    const now = this.engine.ctx.currentTime;
    this.gain.gain.cancelScheduledValues(now);
    this.gain.gain.setValueAtTime(this.gain.gain.value, now);
    // 効果音と風を邪魔しない、小さめの BGM。開始時のプチ音もフェードで避ける。
    this.gain.gain.linearRampToValueAtTime(0.14, now + 1.2);
    void this.element.play().catch(() => {
      // 自動再生を厳しく止める環境では、次のプレイ操作でもう一度試す。
    });
  }

  /** 休憩やバックグラウンド移動では、通信と再生を増やさず同じ位置で止める。 */
  pause(): void {
    if (this.element.paused) return;
    const now = this.engine.ctx.currentTime;
    this.gain.gain.cancelScheduledValues(now);
    this.gain.gain.setValueAtTime(this.gain.gain.value, now);
    this.gain.gain.linearRampToValueAtTime(0, now + 0.35);
    if (this.pauseTimer !== null) clearTimeout(this.pauseTimer);
    this.pauseTimer = setTimeout(() => {
      this.element.pause();
      this.pauseTimer = null;
    }, 450);
  }
}
