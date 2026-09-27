import type * as THREE from 'three';

/**
 * 実機で重さを測るための表示（アドレスに ?perf を付けて開いたときだけ）。
 * fps・コマの長さ（平均と最大）・描く回数・三角形の数・画素倍率と描く大きさを 0.5 秒ごとに出す。
 * Mac の GPU で測った数字は、スマホや Windows の内蔵 GPU の重さとは違うので、手持ちの端末で確かめるために使う。
 */
export class PerfHud {
  private readonly el: HTMLElement;
  private frames = 0;
  private sum = 0;
  private max = 0;
  private since = 0;

  constructor(root: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'perf-hud';
    root.appendChild(this.el);
  }

  /** 描いた直後に毎コマ呼ぶ（renderer.info は直前の 1 コマの数）。 */
  frame(dt: number, renderer: THREE.WebGLRenderer): void {
    this.frames++;
    this.sum += dt;
    this.max = Math.max(this.max, dt);
    this.since += dt;
    if (this.since < 0.5) return;
    const avg = this.sum / this.frames;
    const info = renderer.info.render;
    const canvas = renderer.domElement;
    this.el.textContent =
      `${Math.round(1 / avg)} fps · ${(avg * 1000).toFixed(1)} ms（最大 ${(this.max * 1000).toFixed(0)}）` +
      ` · 描く ${info.calls} 回 · 三角形 ${Math.round(info.triangles / 1000)}k` +
      ` · 倍率 ${renderer.getPixelRatio().toFixed(2)} ${canvas.width}×${canvas.height}`;
    this.frames = 0;
    this.sum = 0;
    this.max = 0;
    this.since = 0;
  }
}
