import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mulberry32 } from '../core/rng';
import { paint, isLite } from './treeGeometry';

/**
 * 針葉樹は主幹が最後まで真っ直ぐ伸びるので、枝の再帰ではなく「幹＋段」で作る。
 */
export interface ConiferParams {
  tiers: number;
  baseRadius: number;
  taper: number;
  /** 段の高さ / 半径。大きいほど尖る。 */
  aspect: number;
  /** 段をどれだけ詰めるか。0.6 なら 4 割重なる。 */
  overlap: number;
  /** 根元の、段の無い幹の長さ。 */
  clear: number;
  bark: number;
  greens: readonly number[];
}

export function buildConifer(
  p: ConiferParams,
  seed: number,
): THREE.BufferGeometry {
  const rand = mulberry32(seed >>> 0);
  const tierY: number[] = [];
  const tierR: number[] = [];
  let y = p.clear;
  let r = p.baseRadius;
  for (let i = 0; i < p.tiers; i++) {
    const jitter = 0.84 + rand() * 0.32;
    tierY.push(y);
    tierR.push(r * jitter);
    y += r * jitter * p.aspect * p.overlap;
    r *= p.taper;
  }

  // 一番上の段の頂点まで幹を伸ばすと串刺しに見える。円錐の半径が
  // 幹の 2.2 倍以上ある所で止め、樹冠の中へ隠す。
  const lastR = tierR[p.tiers - 1];
  const lastH = lastR * p.aspect;
  const trunkTopR = p.baseRadius * 0.08;
  const safe = Math.max(0, 1 - (trunkTopR * 2.2) / lastR);
  const trunkTop = tierY[p.tiers - 1] + lastH * safe;

  const parts: THREE.BufferGeometry[] = [
    paint(
      new THREE.CylinderGeometry(
        trunkTopR,
        p.baseRadius * 0.2,
        trunkTop,
        isLite() ? 3 : 6,
      ).translate(0, trunkTop * 0.5, 0),
      p.bark,
    ),
  ];
  for (let i = 0; i < p.tiers; i++) {
    const hgt = tierR[i] * p.aspect;
    const g = new THREE.ConeGeometry(tierR[i], hgt, isLite() ? 4 : 7);
    g.rotateY(rand() * Math.PI * 2);
    g.rotateX((rand() - 0.5) * 0.11);
    parts.push(
      paint(
        g.translate(0, tierY[i] + hgt * 0.5, 0),
        p.greens[i % p.greens.length],
      ),
    );
  }
  return mergeGeometries(parts)!;
}
