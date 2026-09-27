import type { CourseField } from '../golf/field';
import type { Hole } from '../golf/course';

/**
 * ホールの小さな地図（ティーを下、グリーンを上）。PGA TOUR 2K・Golf Clash・みんゴルの定番の表示。
 * ホールの形（フェアウェイ・グリーン・バンカー・池・林）は造成の格子（golf/field.ts）から 1 度だけ描き、
 * 毎フレームは球・狙いの輪・ピンだけを重ねる。
 */

const C = {
  forest: '#28502a',
  rough: '#4b7a37',
  fairway: '#7fbf58',
  green: '#a6e37f',
  tee: '#93d06a',
  sand: '#eadcae',
  water: '#4a93d6',
};

export class HoleMap {
  private readonly ctx: CanvasRenderingContext2D;
  private base: HTMLCanvasElement | null = null;
  private hole: Hole | null = null;
  /** 地図の向き: 原点（ティー）、上向きの単位ベクトル（ティー → ピン）、右向き、縮尺（px/m）と中心のずれ。 */
  private ox = 0;
  private oz = 0;
  private ux = 0;
  private uz = -1;
  private rx = 1;
  private rz = 0;
  private scale = 1;
  private cu = 0;
  private cv = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  /** ホールが替わったら地図を描き直す。 */
  setHole(hole: Hole, field: CourseField | null): void {
    if (this.hole === hole) return;
    this.hole = hole;
    const w = this.canvas.width;
    const h = this.canvas.height;
    // 上向き = ティーからピン。
    const dx = hole.pin.x - hole.tee.x;
    const dz = hole.pin.z - hole.tee.z;
    const len = Math.hypot(dx, dz) || 1;
    this.ox = hole.tee.x;
    this.oz = hole.tee.z;
    this.ux = dx / len;
    this.uz = dz / len;
    // 画面の右 = 上向きを時計回りに 90°（世界の右 (-z, x) と同じ）。
    this.rx = -this.uz;
    this.rz = this.ux;
    // 打つ線とピンが入る範囲（横 u・縦 v）に、周りの余白。
    let u0 = -35;
    let u1 = 35;
    let v0 = -25;
    let v1 = len + 30;
    for (const p of [...hole.line, hole.pin, hole.aim]) {
      const [u, v] = this.toUV(p.x, p.z);
      u0 = Math.min(u0, u - 40);
      u1 = Math.max(u1, u + 40);
      v0 = Math.min(v0, v - 25);
      v1 = Math.max(v1, v + 30);
    }
    this.scale = Math.min(w / (u1 - u0), h / (v1 - v0));
    this.cu = (u0 + u1) / 2;
    this.cv = (v0 + v1) / 2;

    const base = document.createElement('canvas');
    base.width = w;
    base.height = h;
    const g = base.getContext('2d')!;
    const img = g.createImageData(w, h);
    const rgb = (hex: string): [number, number, number] => [
      parseInt(hex.slice(1, 3), 16),
      parseInt(hex.slice(3, 5), 16),
      parseInt(hex.slice(5, 7), 16),
    ];
    const cols = Object.fromEntries(Object.entries(C).map(([k, v]) => [k, rgb(v)])) as Record<keyof typeof C, [number, number, number]>;
    for (let py = 0; py < h; py++) {
      for (let px = 0; px < w; px++) {
        const [x, z] = this.toWorld(px + 0.5, py + 0.5);
        let c = cols.forest;
        if (field && field.sample(x, z)) {
          if (Number.isFinite(field.waterAt(x, z))) c = cols.water;
          else if (field.green > 0.5) c = cols.green;
          else if (field.sand > 0.5) c = cols.sand;
          else if (field.tee > 0.5) c = cols.tee;
          else if (field.fairway > 0.5) c = cols.fairway;
          else if (field.clear > 0.5) c = cols.rough;
        }
        const k = (py * w + px) * 4;
        img.data[k] = c[0];
        img.data[k + 1] = c[1];
        img.data[k + 2] = c[2];
        img.data[k + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    this.base = base;
  }

  private toUV(x: number, z: number): [number, number] {
    const dx = x - this.ox;
    const dz = z - this.oz;
    return [dx * this.rx + dz * this.rz, dx * this.ux + dz * this.uz];
  }

  /** 地図の画素 → 世界の (x, z)。 */
  private toWorld(px: number, py: number): [number, number] {
    const u = (px - this.canvas.width / 2) / this.scale + this.cu;
    const v = -(py - this.canvas.height / 2) / this.scale + this.cv;
    return [this.ox + this.rx * u + this.ux * v, this.oz + this.rz * u + this.uz * v];
  }

  /** 世界の (x, z) → 地図の画素（地図の外は縁に寄せる）。 */
  private toPixel(x: number, z: number): [number, number] {
    const [u, v] = this.toUV(x, z);
    const px = (u - this.cu) * this.scale + this.canvas.width / 2;
    const py = -(v - this.cv) * this.scale + this.canvas.height / 2;
    return [Math.max(4, Math.min(this.canvas.width - 4, px)), Math.max(4, Math.min(this.canvas.height - 4, py))];
  }

  /** 球・狙いの輪・ピンを重ねる。aim は狙っている間だけ。others は COM の相手の球（色の点）。 */
  draw(
    ball: { x: number; z: number },
    aim: { x: number; z: number } | null,
    pin: { x: number; z: number },
    others: readonly { x: number; z: number; color: number }[] = [],
  ): void {
    const g = this.ctx;
    const { width: w, height: h } = this.canvas;
    g.clearRect(0, 0, w, h);
    if (this.base) g.drawImage(this.base, 0, 0);
    const [bx, by] = this.toPixel(ball.x, ball.z);
    const [fx, fy] = this.toPixel(pin.x, pin.z);
    if (aim) {
      const [ax, ay] = this.toPixel(aim.x, aim.z);
      g.strokeStyle = 'rgba(255,255,255,0.85)';
      g.lineWidth = 1.5;
      g.setLineDash([3, 3]);
      g.beginPath();
      g.moveTo(bx, by);
      g.lineTo(ax, ay);
      g.stroke();
      g.setLineDash([]);
      g.beginPath();
      g.arc(ax, ay, 5, 0, Math.PI * 2);
      g.stroke();
    }
    // ピン（赤い旗）。
    g.fillStyle = '#e8413c';
    g.beginPath();
    g.moveTo(fx, fy);
    g.lineTo(fx, fy - 10);
    g.lineTo(fx + 7, fy - 7);
    g.lineTo(fx, fy - 4);
    g.fill();
    g.strokeStyle = '#fff';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(fx, fy);
    g.lineTo(fx, fy - 10);
    g.stroke();
    // COM の相手の球（自分の球の下に）。
    for (const o of others) {
      const [ox, oy] = this.toPixel(o.x, o.z);
      g.fillStyle = `#${o.color.toString(16).padStart(6, '0')}`;
      g.strokeStyle = 'rgba(0,0,0,0.6)';
      g.beginPath();
      g.arc(ox, oy, 3, 0, Math.PI * 2);
      g.fill();
      g.stroke();
    }
    // 球。
    g.fillStyle = '#fff';
    g.strokeStyle = 'rgba(0,0,0,0.6)';
    g.beginPath();
    g.arc(bx, by, 3.5, 0, Math.PI * 2);
    g.fill();
    g.stroke();
  }
}
