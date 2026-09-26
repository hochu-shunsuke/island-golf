import assert from 'node:assert/strict';
import { createServer } from 'vite';

/**
 * コースを先に作る生成を確かめる。
 * - 並べる（routeCourse）: どの合言葉でも 9 ホール・パー 36 が並び、ホールどうしが重ならない。同じ合言葉なら同じ
 * - 世界（generateIsland にコースを渡す）: ティーとピンが陸の上にあり、池の水面が海面より上。
 *   コースの周りが山で囲まれている
 */
const server = await createServer({ configFile: false, appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } });
try {
  const { routeCourse, settleCourse, lineDistance } = await server.ssrLoadModule('/src/golf/design.ts');
  const { generateIsland } = await server.ssrLoadModule('/src/island/generate.ts');
  const { buildCourseField, CourseField } = await server.ssrLoadModule('/src/golf/field.ts');
  const { FULL_RES, EROSION_RES, ISLAND_SIZE } = await server.ssrLoadModule('/src/island/grid.ts');

  // 1. 並べる: 30 の合言葉で。
  let minGap = Infinity;
  for (let k = 0; k < 30; k++) {
    const seed = `s${k}x${(k * 7919) % 1000}`;
    const course = routeCourse(seed);
    assert.equal(course.holes.length, 9, `${seed}: ホールが 9 つありません（${course.holes.length}）`);
    assert.equal(course.holes.reduce((a, h) => a + h.par, 0), 36, `${seed}: パーが 36 ではありません`);
    assert.deepEqual(routeCourse(seed), course, `${seed}: 同じ合言葉でコースが変わりました`);
    // 別のホールの打つ線どうしの間隔（つなぎ目のティーの近く 40m は除く）。
    for (const a of course.holes) {
      for (const b of course.holes) {
        if (a === b) continue;
        for (let t = 0; t <= 1; t += 0.05) {
          const p = a.line[0];
          const q = a.line[a.line.length - 1];
          const x = p.x + (q.x - p.x) * t;
          const z = p.z + (q.z - p.z) * t;
          if (Math.hypot(x - b.line[0].x, z - b.line[0].z) < 60) continue;
          if (Math.hypot(x - p.x, z - p.z) < 60) continue;
          minGap = Math.min(minGap, lineDistance(b.line, x, z).d);
        }
      }
    }
  }
  assert(minGap > 45, `ホールどうしが近すぎます（${minGap.toFixed(0)}m）`);

  // 2. 世界: 2 つの合言葉で。
  const rows = [];
  for (const seed of ['hakoniwa', 'k7p2mq9x']) {
    const p = { seed, size: 60, shape: 20, mountains: 55, erosion: 50, wetness: 60, warmth: 55 };
    const route = routeCourse(seed);
    const island = generateIsland(p, FULL_RES, EROSION_RES, route);
    const { n, height } = island;
    const at = (x, z) =>
      height[Math.round((z / ISLAND_SIZE + 0.5) * (n - 1)) * n + Math.round((x / ISLAND_SIZE + 0.5) * (n - 1))];
    const design = settleCourse(route, at);
    const field = new CourseField(buildCourseField(island, design, seed));
    let highest = 0;
    for (const h of design.holes) {
      assert(at(h.tee.x, h.tee.z) > 1 && at(h.pin.x, h.pin.z) > 1, `${seed} ${h.number} 番: ティーかピンが海の中です`);
      for (const pond of h.ponds) assert(pond.level >= 1.5, `${seed} ${h.number} 番: 池の水面が海面に近すぎます`);
      assert(!Number.isFinite(field.waterAt(h.tee.x, h.tee.z)), `${seed} ${h.number} 番: ティーが池の中です`);
      assert(!Number.isFinite(field.waterAt(h.pin.x, h.pin.z)), `${seed} ${h.number} 番: ピンが池の中です`);
    }
    // コースから 900m 離れた輪の上に、コースより 150m 以上高い山がある方角が多い（山に囲まれている）。
    const c = design.holes[0].tee;
    let walled = 0;
    for (let a = 0; a < 16; a++) {
      const dx = Math.cos((a * Math.PI) / 8);
      const dz = Math.sin((a * Math.PI) / 8);
      let peak = 0;
      for (let r = 500; r <= 1300; r += 50) peak = Math.max(peak, at(c.x + dx * r, c.z + dz * r));
      if (peak > at(c.x, c.z) + 150) walled++;
      highest = Math.max(highest, peak);
    }
    assert(walled >= 10, `${seed}: 山に囲まれていません（16 方角のうち ${walled}）`);
    rows.push(`${seed} 山 ${walled}/16 方角・最高 ${highest.toFixed(0)}m`);
  }
  console.log(`PASS  コース 30 の合言葉で 9 ホール（ホールの間隔 ${minGap.toFixed(0)}m 以上） / ${rows.join(' / ')}`);
} finally {
  await server.close();
}
