import type { Surface } from '../golf/ball';
import type { AudioEngine } from './engine';

/**
 * ゴルフの音。全部その場で合成する（音声ファイルを持たない。stroll と同じ）。
 *
 * - 打つ音: ドライバーは低く強い「パーン」、アイアンは鋭い「カシッ」、パターは軽い「コツ」。
 *   芯で捉えると高い澄んだ響きが乗る
 * - 落ちた音: 芝は鈍い「トッ」、砂は「ザッ」、水は「バシャ」
 * - カップイン: 縁に当たる小さな音と、底へ落ちる「コトン」
 * - 環境: ホールの風の強さに合わせたそよ風と、森の鳥
 */
export class GolfSounds {
  private readonly bus: GainNode;
  private readonly windGain: GainNode;
  private readonly windFilter: BiquadFilterNode;
  private readonly birdBus: GainNode;
  private birdTimer = 3;

  constructor(private readonly engine: AudioEngine) {
    const ctx = engine.ctx;
    this.bus = ctx.createGain();
    this.bus.gain.value = 0.9;
    this.bus.connect(engine.master);
    const send = ctx.createGain();
    send.gain.value = 0.35;
    this.bus.connect(send).connect(engine.reverbSend);

    // そよ風（ブラウンノイズを低く絞る）。
    const src = engine.loopNoise('brown');
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'lowpass';
    this.windFilter.frequency.value = 260;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    src.connect(this.windFilter).connect(this.windGain).connect(engine.master);

    this.birdBus = ctx.createGain();
    this.birdBus.gain.value = 1;
    this.birdBus.connect(engine.master);
    const birdSend = ctx.createGain();
    birdSend.gain.value = 0.8;
    this.birdBus.connect(birdSend).connect(engine.reverbSend);
  }

  private get ctx(): AudioContext {
    return this.engine.ctx;
  }

  /** 短いノイズの破裂（帯域を絞って音色を作る）。 */
  private burst(t: number, freq: number, q: number, dur: number, gain: number, type: BiquadFilterType = 'bandpass'): void {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.engine.white;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.bus);
    src.start(t, Math.random() * 2);
    src.stop(t + dur + 0.05);
  }

  /** 減衰する音（響き）。 */
  private ring(t: number, freq: number, dur: number, gain: number, type: OscillatorType = 'sine', drop = 1): void {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (drop !== 1) osc.frequency.exponentialRampToValueAtTime(freq * drop, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(this.bus);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  /**
   * 打った音。kind はクラブの種類、strength は初速の割合（0..1）、perfect は芯で捉えたか。
   */
  hit(kind: 'wood' | 'iron' | 'wedge' | 'putter', strength: number, perfect: boolean): void {
    const t = this.ctx.currentTime + 0.005;
    const s = Math.max(0.25, Math.min(1, strength));
    if (kind === 'putter') {
      this.burst(t, 1800, 3, 0.05, 0.08 * s + 0.03);
      this.ring(t, 950, 0.09, 0.05 * s + 0.02);
      return;
    }
    if (kind === 'wood') {
      // 低く太い破裂と、金属の響き。
      this.burst(t, 1100, 1.2, 0.12, 0.55 * s);
      this.burst(t, 300, 0.8, 0.09, 0.35 * s, 'lowpass');
      this.ring(t, 1650, 0.22, 0.12 * s, 'triangle', 0.97);
    } else {
      // アイアン・ウェッジは鋭く短い。
      const f = kind === 'iron' ? 2600 : 3200;
      this.burst(t, f, 2, 0.06, 0.45 * s);
      this.burst(t, 700, 1, 0.05, 0.2 * s);
      this.ring(t, f * 0.9, 0.12, 0.07 * s, 'triangle', 0.98);
    }
    if (perfect) this.ring(t + 0.01, 2900, 0.35, 0.06, 'sine', 1.0);
  }

  /** 構えた（針が振れ始めた）ときの小さな合図。 */
  ready(): void {
    const t = this.ctx.currentTime + 0.005;
    this.ring(t, 660, 0.08, 0.025);
  }

  /** 地面に落ちた。speed は当たったときの速さ（m/s）。 */
  land(surface: Surface, speed: number): void {
    const t = this.ctx.currentTime + 0.005;
    const s = Math.max(0.05, Math.min(1, speed / 30));
    if (surface === 'sand') {
      this.burst(t, 3500, 0.7, 0.18, 0.18 * s);
    } else if (surface === 'rock') {
      this.burst(t, 2400, 3, 0.05, 0.25 * s);
      this.ring(t, 1300, 0.08, 0.05 * s);
    } else {
      this.burst(t, 260, 0.9, 0.09, 0.3 * s, 'lowpass');
      this.burst(t, 1200, 1, 0.04, 0.06 * s);
    }
  }

  /** 水に入った。 */
  splash(): void {
    const t = this.ctx.currentTime + 0.005;
    this.burst(t, 900, 0.6, 0.35, 0.35, 'lowpass');
    this.burst(t + 0.03, 2500, 0.8, 0.45, 0.16);
    this.ring(t, 420, 0.25, 0.06, 'sine', 0.5);
  }

  /** カップイン: 縁に触れる音と、底へ落ちる音。 */
  cup(): void {
    const t = this.ctx.currentTime + 0.005;
    this.burst(t, 3000, 4, 0.03, 0.08);
    this.ring(t + 0.05, 1200, 0.06, 0.05);
    this.burst(t + 0.16, 500, 2, 0.12, 0.3);
    this.ring(t + 0.16, 330, 0.25, 0.12, 'sine', 0.8);
  }

  /** うれしい知らせ（バーディ以上）。3 音の上りの和音。 */
  cheer(big: boolean): void {
    const t = this.ctx.currentTime + 0.35;
    const notes = big ? [523, 659, 784, 1047] : [523, 659, 784];
    notes.forEach((f, i) => {
      this.ring(t + i * 0.1, f, 0.6, 0.06, 'triangle');
      this.ring(t + i * 0.1, f * 2, 0.4, 0.02, 'sine');
    });
  }

  /**
   * 環境音。wind はホールの風（m/s）、forest は周りの木の多さ 0..1、altitude は地面からの高さ（m）。
   * 空高く飛んでいる間は鳥を鳴らさない。
   */
  update(dt: number, wind: number, forest: number, altitude: number): void {
    const now = this.ctx.currentTime;
    const w = Math.min(1, wind / 8);
    this.windGain.gain.setTargetAtTime(0.012 + w * 0.05, now, 0.6);
    this.windFilter.frequency.setTargetAtTime(220 + w * 260, now, 0.6);
    const near = 1 - Math.min(1, Math.max(0, (altitude - 20) / 90));
    this.birdBus.gain.setTargetAtTime(near, now, 0.5);
    this.birdTimer -= dt;
    if (this.birdTimer <= 0) {
      this.birdTimer = 4 + Math.random() * 10;
      if (near > 0.1 && Math.random() < 0.3 + forest * 0.6) this.chirp(0.5 + forest * 0.5);
    }
  }

  /** 数音の短いさえずり。音程と間を毎回変える（stroll の鳥と同じ作り）。 */
  private chirp(loudness: number): void {
    const ctx = this.ctx;
    const t0 = ctx.currentTime + 0.02;
    const base = 1500 + Math.random() * 1900;
    const notes = 2 + ((Math.random() * 3) | 0);
    for (let i = 0; i < notes; i++) {
      const t = t0 + i * (0.075 + Math.random() * 0.09);
      const f = base * (0.82 + Math.random() * 0.4);
      const dur = 0.05 + Math.random() * 0.06;
      const osc = ctx.createOscillator();
      osc.type = Math.random() < 0.5 ? 'sine' : 'triangle';
      osc.frequency.setValueAtTime(f, t);
      osc.frequency.exponentialRampToValueAtTime(f * (1.15 + Math.random() * 0.5), t + dur * 0.4);
      osc.frequency.exponentialRampToValueAtTime(f * 0.85, t + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.045 * loudness, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(g).connect(this.birdBus);
      osc.start(t);
      osc.stop(t + dur + 0.05);
    }
  }
}
