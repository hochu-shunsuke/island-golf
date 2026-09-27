import { mulberry32 } from '../core/rng';

/**
 * 音は全部その場で合成する。音声ファイルを持たないので、
 * 地形と同じく URL ひとつで完結する。
 */
export class AudioEngine {
  readonly ctx: AudioContext;
  /** 環境音・効果音の最終段。 */
  readonly master: GainNode;
  /** 屋外らしい響きを足すための送り先。 */
  readonly reverbSend: GainNode;

  readonly white: AudioBuffer;
  readonly brown: AudioBuffer;

  private muted = false;

  constructor() {
    this.ctx = new AudioContext();

    this.master = this.ctx.createGain();
    // 音量は常に最大。全体の大きさは端末側で調整してもらう。
    this.master.gain.value = 1;
    this.master.connect(this.ctx.destination);

    const convolver = this.ctx.createConvolver();
    convolver.buffer = makeImpulse(this.ctx, 1.9, 2.6);
    convolver.connect(this.master);

    this.reverbSend = this.ctx.createGain();
    this.reverbSend.gain.value = 0.5;
    this.reverbSend.connect(convolver);

    this.white = makeNoise(this.ctx, 3, 'white');
    this.brown = makeNoise(this.ctx, 6, 'brown');
  }

  /** ブラウザの制限があるので、必ずクリック等の操作の中から呼ぶこと。 */
  resume(): void {
    if (this.ctx.state !== 'running') void this.ctx.resume().catch(() => {});
  }

  /** ループ再生するノイズ源を作る。開始位置をずらして重なりの癖を消す。 */
  loopNoise(kind: 'white' | 'brown'): AudioBufferSourceNode {
    const src = this.ctx.createBufferSource();
    const buf = kind === 'white' ? this.white : this.brown;
    src.buffer = buf;
    src.loop = true;
    src.start(0, Math.random() * buf.duration);
    return src;
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    this.master.gain.setTargetAtTime(this.muted ? 0 : 1, this.ctx.currentTime, 0.05);
    return this.muted;
  }
}

/**
 * ホワイト／ブラウンノイズのループ用バッファ。
 * 継ぎ目でプチッと鳴らないよう、末尾を先頭へ重ねてから切る。
 * 環境音は延々ループするので、ここが一番効く。
 */
function makeNoise(ctx: AudioContext, seconds: number, kind: 'white' | 'brown'): AudioBuffer {
  const n = Math.floor(ctx.sampleRate * seconds);
  const fade = Math.floor(ctx.sampleRate * 0.08);
  const rand = mulberry32(kind === 'white' ? 0x5eed : 0xc0ffee);

  // クロスフェードに使う分だけ余分に作る。
  const tmp = new Float32Array(n + fade);
  if (kind === 'white') {
    for (let i = 0; i < tmp.length; i++) tmp[i] = rand() * 2 - 1;
  } else {
    // 一次の積分で低域に寄せる。風の土台になる。
    let last = 0;
    for (let i = 0; i < tmp.length; i++) {
      last = (last + 0.02 * (rand() * 2 - 1)) / 1.02;
      tmp[i] = last * 3.2;
    }
    // 直流成分は聞こえないのに音量だけ食うので抜く。
    let mean = 0;
    for (let i = 0; i < tmp.length; i++) mean += tmp[i];
    mean /= tmp.length;
    for (let i = 0; i < tmp.length; i++) tmp[i] -= mean;
  }

  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < n; i++) {
    if (i < fade) {
      // 末尾 fade 分を先頭に重ねる。末尾 → 先頭 が滑らかに繋がる。
      const t = i / fade;
      data[i] = tmp[i] * t + tmp[n + i] * (1 - t);
    } else {
      data[i] = tmp[i];
    }
  }
  return buf;
}

/** ノイズを指数で減衰させただけの簡易インパルス応答。屋外の広がりが出る。 */
function makeImpulse(ctx: AudioContext, seconds: number, decay: number): AudioBuffer {
  const n = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, n, ctx.sampleRate);
  const rand = mulberry32(0xbeef);
  for (let c = 0; c < 2; c++) {
    const data = buf.getChannelData(c);
    for (let i = 0; i < n; i++) {
      data[i] = (rand() * 2 - 1) * Math.pow(1 - i / n, decay);
    }
  }
  return buf;
}
