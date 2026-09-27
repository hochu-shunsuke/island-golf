import type * as THREE from 'three';

/**
 * 打った球の軌跡は、止まってから少し見せて消す（自分・COM・友達とも同じ）。
 * 次に打つまで残していた頃は、前の一打や相手の弾道が画面を縦横に横切ったまま残り、スマホの狭い画面が散らかった。
 */
const TRAIL_HOLD = 1.2;
const TRAIL_FADE = 0.8;

export class TrailFade {
  /** 止まってからの秒数（飛んでいる間・消えた後は null）。 */
  private since: number | null = null;

  constructor(
    private readonly line: THREE.Line,
    private readonly material: THREE.LineBasicMaterial,
    private readonly opacity: number,
  ) {}

  /** 打った: はっきり出す。 */
  show(): void {
    this.since = null;
    this.line.visible = true;
    this.material.opacity = this.opacity;
  }

  /** 止まった: ここから消し始める。 */
  settle(): void {
    if (this.since === null && this.line.visible) this.since = 0;
  }

  update(dt: number): void {
    if (this.since === null) return;
    this.since += dt;
    const k = 1 - Math.min(1, Math.max(0, (this.since - TRAIL_HOLD) / TRAIL_FADE));
    this.material.opacity = this.opacity * k;
    if (k <= 0) {
      this.line.visible = false;
      this.since = null;
    }
  }
}
