import * as THREE from 'three';
import { mulberry32 } from '../core/rng';

/**
 * 空の雲に使う、上下左右がつながった fBm ノイズ。
 *
 * 以前は空を描く全画素で 5 段 × 4 点の値ノイズを計算していた。空は常に画面の広い範囲を
 * 占めるため、スマホでは地形よりこちらが重くなりやすい。同じ 5 段を起動時に一度だけ
 * テクスチャへ焼き、描画中は 1 回読む。雲の輪郭・濃淡・流れ方は従来と同じ仕組みのまま。
 */

const SIZE = 512;
/** シェーダーの座標で、この長さごとに繰り返す。通常の視野より十分広い。 */
export const CLOUD_PERIOD = 16;
const OCTAVES = 5;

function fade(t: number): number {
  return t * t * (3 - 2 * t);
}

export function createCloudTexture(): THREE.DataTexture {
  const rand = mulberry32(0xc10d_5eed);
  const grids: { cells: number; values: Float32Array }[] = [];
  for (let octave = 0; octave < OCTAVES; octave++) {
    const cells = CLOUD_PERIOD << octave;
    grids.push({ cells, values: Float32Array.from({ length: cells * cells }, rand) });
  }

  const data = new Uint8Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let sum = 0;
      let amount = 0.5;
      for (const { cells, values } of grids) {
        const gx = (x / SIZE) * cells;
        const gy = (y / SIZE) * cells;
        const x0 = Math.floor(gx) % cells;
        const y0 = Math.floor(gy) % cells;
        const x1 = (x0 + 1) % cells;
        const y1 = (y0 + 1) % cells;
        const fx = fade(gx - Math.floor(gx));
        const fy = fade(gy - Math.floor(gy));
        const a = values[y0 * cells + x0];
        const b = values[y0 * cells + x1];
        const c = values[y1 * cells + x0];
        const d = values[y1 * cells + x1];
        sum += ((a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy) * amount;
        amount *= 0.5;
      }
      data[y * SIZE + x] = Math.max(0, Math.min(255, Math.round(sum * 255)));
    }
  }

  const texture = new THREE.DataTexture(data, SIZE, SIZE, THREE.RedFormat, THREE.UnsignedByteType);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}
