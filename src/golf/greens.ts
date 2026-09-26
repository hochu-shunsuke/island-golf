/**
 * グリーンの型。グリーンは「土台の傾いた面」に「型ごとの起伏」を重ねたもの。
 * 設計図（design.ts）がピン位置を選ぶときと、造成（field.ts）が地面に刻むときの両方がここを見る
 * （同じ関数を使うので、ピンを立てた所の傾きと、描いた地面の傾きが食い違わない）。
 *
 * 型（実在の設計の言葉）:
 * - 受け（receptive）: 手前へ下る。球が止まりやすい。やさしいホールに
 * - 2 段（tiered）: 真ん中に段。ピンのある段に乗せないと難しい
 * - 砲台（falsefront）: 台地の上。手前の縁が急に落ち、短いと転がり戻る
 * - 亀の甲（crowned）: 真ん中が高く、外へ転がり落ちる
 * - すり鉢（punchbowl）: 球が真ん中へ集まる。縁は小山（field.ts）
 * - Biarritz: 真ん中を谷が横切る。手前と奥に分かれる
 * - 背骨（spine）: 真ん中を縦に尾根が通り、左右に分かれる
 * - Redan: 斜めに奥へ下る台地
 *
 * 大きさと起伏の強さは、寄せの距離で決める（長いクラブで狙うグリーンは広く穏やかに、ウェッジなら小さく強く）。
 */

import type { Vec2 } from './design';

export type GreenKind =
  | 'receptive'
  | 'tiered'
  | 'falsefront'
  | 'crowned'
  | 'punchbowl'
  | 'biarritz'
  | 'spine'
  | 'redan';

export const GREEN_NAMES: Record<GreenKind, string> = {
  receptive: '受けグリーン',
  tiered: '2 段グリーン',
  falsefront: '砲台グリーン',
  crowned: '亀の甲グリーン',
  punchbowl: 'すり鉢グリーン',
  biarritz: 'ビアリッツ',
  spine: '背骨のグリーン',
  redan: 'レダン',
};

/** グリーンの形（design.ts の GreenDesign のうち、起伏に要る所）。 */
export interface GreenShape {
  kind: GreenKind;
  x: number;
  z: number;
  rx: number;
  rz: number;
  /** 長軸の向き。 */
  ax: number;
  az: number;
  /** 手前（ティーの側）の向き。 */
  fx: number;
  fz: number;
  /** 中心の高さと、土台の面の傾き（m/m）。 */
  h: number;
  sx: number;
  sz: number;
  /** 起伏の強さ（寄せの距離で決める。1 が標準）。 */
  strength: number;
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** 型ごとの、周りより高くする量（m）と、手前から奥への土台の傾き（m/m、正なら奥が高い）。 */
export const GREEN_BASE: Record<GreenKind, { raise: number; tilt: number }> = {
  receptive: { raise: 0.4, tilt: 0.025 },
  tiered: { raise: 0.5, tilt: 0.012 },
  falsefront: { raise: 1.3, tilt: 0.02 },
  crowned: { raise: 0.7, tilt: 0 },
  punchbowl: { raise: -0.3, tilt: 0 },
  biarritz: { raise: 0.3, tilt: 0.01 },
  spine: { raise: 0.4, tilt: 0.015 },
  redan: { raise: 1.1, tilt: 0 },
};

/**
 * 型の起伏（m）。土台の面（h と傾き）に足す。グリーンの外でも値を返す（周りへつなぐ帯で使う）。
 * u は手前から奥へ、v は右へ、どちらもグリーンの平均の半径で割った値。
 */
export function greenContour(g: GreenShape, x: number, z: number): number {
  const R = (g.rx + g.rz) / 2;
  const dx = x - g.x;
  const dz = z - g.z;
  // 奥へ向かう向き = 手前の向きの逆。
  const u = -(dx * g.fx + dz * g.fz) / R;
  const v = (dx * g.fz - dz * g.fx) / R;
  const r2 = Math.min(1.2, u * u + v * v);
  const k = g.strength;
  switch (g.kind) {
    case 'tiered':
      // 真ん中から少し奥で 0.6m の段。段の線は少し斜め。
      return k * (0.6 * smooth(-0.14, 0.14, u - 0.1 + v * 0.25) - 0.3);
    case 'falsefront':
      // 手前の 2 割が急に落ちる。
      return -k * 0.9 * (1 - smooth(-1.05, -0.62, u));
    case 'crowned':
      return k * 0.45 * (1 - r2);
    case 'punchbowl':
      return -k * 0.7 * (1 - r2);
    case 'biarritz':
      // 真ん中を横切る谷（深さ 0.55m）。
      return -k * 0.55 * Math.exp(-(u * u) / 0.04);
    case 'spine':
      // 手前から奥へ縦に通る尾根。
      return k * 0.35 * Math.exp(-(v * v) / 0.05) * (1 - smooth(0.7, 1.1, Math.abs(u)));
    default:
      return 0;
  }
}

/** グリーンの面の高さ（土台の面 + 型の起伏）。 */
export function greenSurface(g: GreenShape, x: number, z: number): number {
  return g.h + g.sx * (x - g.x) + g.sz * (z - g.z) + greenContour(g, x, z);
}

/** 楕円の中での位置（1 で縁）。 */
export function greenEllipseAt(g: GreenShape, x: number, z: number): number {
  const dx = x - g.x;
  const dz = z - g.z;
  const u = dx * g.ax + dz * g.az;
  const v = -dx * g.az + dz * g.ax;
  return Math.sqrt((u / g.rx) * (u / g.rx) + (v / g.rz) * (v / g.rz));
}

/**
 * ピン位置を 4 つ選ぶ。カップの周りの傾きが 3% 以下の所から、手前・奥・左右に散らして。
 * 本物のコースは日ごとにピンを切り替える（同じコースでも、日によって攻め方が変わる）。
 * 1 つ目は一番やさしい所（真ん中に近く、平ら）。
 */
export function pickPins(g: GreenShape): Vec2[] {
  interface Spot {
    x: number;
    z: number;
    slope: number;
    u: number;
    v: number;
  }
  const spots: Spot[] = [];
  const R = (g.rx + g.rz) / 2;
  const e = 0.5;
  for (let j = -12; j <= 12; j++) {
    for (let i = -12; i <= 12; i++) {
      const x = g.x + (i / 12) * Math.max(g.rx, g.rz);
      const z = g.z + (j / 12) * Math.max(g.rx, g.rz);
      // 縁から 3m 以上内側。
      if (greenEllipseAt(g, x, z) > 1 - 3 / Math.min(g.rx, g.rz)) continue;
      const gx = (greenSurface(g, x + e, z) - greenSurface(g, x - e, z)) / (2 * e);
      const gz = (greenSurface(g, x, z + e) - greenSurface(g, x, z - e)) / (2 * e);
      const dx = x - g.x;
      const dz = z - g.z;
      spots.push({
        x,
        z,
        slope: Math.sqrt(gx * gx + gz * gz),
        u: -(dx * g.fx + dz * g.fz) / R,
        v: (dx * g.fz - dz * g.fx) / R,
      });
    }
  }
  if (spots.length === 0) return [{ x: g.x, z: g.z }];
  const flat = spots.filter((s) => s.slope <= 0.03);
  const pool = flat.length >= 4 ? flat : [...spots].sort((a, b) => a.slope - b.slope).slice(0, Math.max(4, spots.length >> 2));
  // 1 つ目: 真ん中に近く平らな所。残り: 手前左・奥右・奥左/手前右の順に、それぞれの向きへ一番寄った所。
  const easy = [...pool].sort((a, b) => a.u * a.u + a.v * a.v + a.slope * 20 - (b.u * b.u + b.v * b.v + b.slope * 20))[0];
  const toward = (du: number, dv: number) => [...pool].sort((a, b) => b.u * du + b.v * dv - (a.u * du + a.v * dv))[0];
  const pins = [easy, toward(-0.7, -0.7), toward(0.7, 0.7), toward(0.7, -0.7)];
  return pins.map((p) => ({ x: p.x, z: p.z }));
}
