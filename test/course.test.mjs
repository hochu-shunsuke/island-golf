import assert from 'node:assert/strict';
import { createServer } from 'vite';

/**
 * コース（おすすめの旗）が、どんな島にも必ず立つこと。以前はサイコロの島の 4 つに 1 つで
 * ホールを置けなかった。そのとき置けなかった島（険しい・小さい・寒い・湿った）を固定で確かめる。
 * あわせて、同じ島なら同じコースになること、旗が水の中や互いに近すぎる所に立たないこと、
 * 自分の旗が水辺と急な斜面を断ることを確かめる。
 */
const ISLANDS = [
  { seed: 'hakoniwa', size: 55, shape: 35, mountains: 55, erosion: 50, wetness: 55, warmth: 55 },
  { seed: 'tz46mh', size: 12, shape: 74, mountains: 82, erosion: 67, wetness: 90, warmth: 52 },
  { seed: 'zgthjf', size: 67, shape: 66, mountains: 73, erosion: 72, wetness: 30, warmth: 27 },
  { seed: '3nucry', size: 13, shape: 69, mountains: 48, erosion: 57, wetness: 48, warmth: 13 },
  { seed: 'a2kjj7', size: 48, shape: 60, mountains: 89, erosion: 50, wetness: 66, warmth: 68 },
];

const server = await createServer({ configFile: false, appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } });
try {
  const { generateIsland } = await server.ssrLoadModule('/src/island/generate.ts');
  const { pickCourse, makeFlag } = await server.ssrLoadModule('/src/golf/course.ts');
  const { FULL_RES, EROSION_RES, ISLAND_SIZE } = await server.ssrLoadModule('/src/island/grid.ts');
  const rows = [];
  for (const p of ISLANDS) {
    const island = generateIsland(p, FULL_RES, EROSION_RES);
    const { n, height, waterKind } = island;
    const cellAt = (x, z) =>
      Math.round((z / ISLAND_SIZE + 0.5) * (n - 1)) * n + Math.round((x / ISLAND_SIZE + 0.5) * (n - 1));
    const course = pickCourse(island, p.seed);
    assert(course.length >= 1, `${p.seed}: ホールが 1 つもありません`);
    assert.deepEqual(pickCourse(island, p.seed), course, `${p.seed}: 同じ島でコースが変わりました`);
    course.forEach((h, k) => {
      assert.equal(h.number, k + 1);
      for (const spot of [h.pin, h.tee]) {
        const c = cellAt(spot.x, spot.z);
        assert(height[c] >= 1 && waterKind[c] === 0, `${p.seed} ${h.number} 番: 旗かティーが水の中です`);
      }
      assert(h.length >= 55 && h.length <= 520, `${p.seed} ${h.number} 番: 長さ ${h.length.toFixed(0)}m`);
      for (const o of course.slice(0, k)) {
        assert(Math.hypot(o.pin.x - h.pin.x, o.pin.z - h.pin.z) >= 80, `${p.seed}: ${o.number} 番と ${h.number} 番のピンが近すぎます`);
      }
    });
    rows.push(`${p.seed} ${course.length} ホール（パー ${course.map((h) => h.par).join('')}）`);
  }

  // 自分の旗: 平らな所には立ち、水辺と急な斜面は断る。
  const dry = () => false;
  const flat = makeFlag(() => 10, dry, [], 0, 0);
  assert.equal(typeof flat, 'object', '平らな所に旗が立ちません');
  assert(Math.abs(flat.green.h - 10) < 1e-6);
  assert.equal(makeFlag(() => 10, (x) => x > 10, [], 0, 0), 'water');
  assert.equal(makeFlag((x) => x * 0.8, dry, [], 0, 0), 'steep');

  console.log('PASS  コース', rows.join(' / '));
} finally {
  await server.close();
}
