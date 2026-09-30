import * as THREE from 'three';

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

/** 軌跡の点の間隔（m）。2m おきにしていた頃は、跳ねて転がる所が折れ線になって角ばって見えた。 */
const TRAIL_STEP = 0.5;
/** 軌跡に残す点の数の上限（0.5m おきで 1.5km）。 */
const TRAIL_MAX = 3000;

/** 球の位置 p を軌跡に足す（前の点から TRAIL_STEP 以上動いていれば）。足したら true。 */
export function addTrailPoint(points: { x: number; y: number; z: number }[], p: { x: number; y: number; z: number }): boolean {
  const last = points[points.length - 1];
  if (last && Math.hypot(last.x - p.x, last.y - p.y, last.z - p.z) < TRAIL_STEP) return false;
  points.push({ x: p.x, y: p.y, z: p.z });
  if (points.length > TRAIL_MAX) points.shift();
  return true;
}

/** 軌跡の線を、点をなめらかな曲線（Catmull-Rom）でつないで描き直す。 */
export function setTrailLine(line: THREE.Line, points: readonly { x: number; y: number; z: number }[]): void {
  const v = points.map((q) => new THREE.Vector3(q.x, q.y, q.z));
  const smooth = v.length >= 3 ? new THREE.CatmullRomCurve3(v, false, 'centripetal').getPoints(v.length * 3) : v;
  line.geometry.dispose();
  line.geometry = new THREE.BufferGeometry().setFromPoints(smooth);
}
