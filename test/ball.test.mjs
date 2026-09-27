import assert from 'node:assert/strict';
import { createServer } from 'vite';

/**
 * 球の物理を、平らなフェアウェイ・グリーン・斜面で確かめる。
 * クラブの飛距離がゴルフらしい範囲に収まり、球が必ず止まり、すり抜けないこと。
 */
const server = await createServer({ configFile: false, appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } });
try {
  const { Ball } = await server.ssrLoadModule('/src/golf/ball.ts');
  const { CLUBS } = await server.ssrLoadModule('/src/golf/clubs.ts');
  const { trial } = await server.ssrLoadModule('/src/golf/aim.ts');
  // 球は -z へ打つ。tilt > 0 なら -z へ下る（打つ向きが下り）、tiltX > 0 なら -x が低い。
  const flat = (surface, tilt = 0, tiltX = 0) => ({
    height: (x, z) => 10 + tilt * z + tiltX * x,
    water: () => -Infinity,
    surface: () => surface,
  });
  // 刻みごとに見て、最初に地面に触れた所をキャリーにする。
  const shoot = (ground, club, power = 1, curve = 0) => {
    const ball = new Ball(ground);
    ball.place(0, 0);
    ball.hit(0, club.loft, club.speed * power, club.spin, club.bite, curve);
    let carry = null;
    let maxY = 0;
    const base = ground.height(0, 0) + 0.1;
    for (let t = 0; t < 30 && ball.state !== 'rest'; t += 1 / 240) {
      ball.update(1 / 240);
      maxY = Math.max(maxY, ball.pos.y - base);
      if (carry === null && t > 0.2 && club.loft > 0 && ball.pos.y - ground.height(ball.pos.x, ball.pos.z) <= 0.1 + 1e-6) carry = -ball.pos.z;
    }
    return { total: -ball.pos.z, side: ball.pos.x, carry: carry ?? 0, apex: maxY, state: ball.state };
  };
  const rows = [];
  for (const club of CLUBS) {
    const r = shoot(flat(club.loft === 0 ? 'green' : 'fairway'), club);
    rows.push(`${club.short} キャリー ${r.carry.toFixed(0)}m 合計 ${r.total.toFixed(0)}m 最高 ${r.apex.toFixed(0)}m`);
    assert.equal(r.state, 'rest', `${club.name} の球が止まりません`);
    if (club.loft === 0) continue;
    // ゲームらしい高い弧（最高点 24m 以上）で、表のキャリーどおりに飛ぶ。
    assert(r.apex >= 24, `${club.name} の弧が低すぎます（最高 ${r.apex.toFixed(0)}m）`);
    assert(Math.abs(r.carry - club.carry) < 6, `${club.name} のキャリーが表と違います（${r.carry.toFixed(0)}m、表は ${club.carry}m）`);
  }
  const driver = shoot(flat('fairway'), CLUBS[0]);
  assert(driver.total > 220 && driver.total < 275, `ドライバーの飛距離がゴルフらしくありません: ${driver.total.toFixed(0)}m`);
  // 狙い線の空中部分は地面へ投影せず、実際の放物線を保つ。
  const previewGround = flat('fairway');
  const preview = trial(previewGround, { x: 0, z: 0 }, 'fairway', 0, 0, 1);
  const previewApex = Math.max(...preview.arc.map((p) => p.y - previewGround.height(p.x, p.z)));
  assert(previewApex > 20, `狙い線が放物線になっていません（地面から最高 ${previewApex.toFixed(1)}m）`);
  assert(preview.land && preview.arc.at(-1).z === preview.land.z, '狙い線が着地点まで繋がっていません');
  // 短いクラブほど落ちてから止まる（サンドは 5m 以内）。
  const sand = shoot(flat('fairway'), CLUBS[6]);
  assert(sand.total - sand.carry < 5, `サンドの球が転がりすぎます（${(sand.total - sand.carry).toFixed(1)}m）`);
  // 芯を外した横回転で右へ曲がる。
  const sliced = shoot(flat('fairway'), CLUBS[3], 1, 0.5);
  assert(sliced.side > 8, `横回転で曲がりません（横 ${sliced.side.toFixed(1)}m）`);
  const putt = shoot(flat('green'), CLUBS[CLUBS.length - 1], 0.5);
  assert(putt.total > 2 && putt.total < 15, `パターの半分の力が ${putt.total.toFixed(1)}m 転がりました`);
  const putter = CLUBS[CLUBS.length - 1];
  // 斜面では下りの方がよく転がり、上りは手前で止まる。
  const up = shoot(flat('green', -0.03), putter, 0.5);
  const down = shoot(flat('green', 0.03), putter, 0.5);
  assert(down.total > putt.total && putt.total > up.total, `上り ${up.total.toFixed(1)}m・平ら ${putt.total.toFixed(1)}m・下り ${down.total.toFixed(1)}m の順になりません`);
  // 急な上りでは、登り切れずに打った所より下へ戻ってくる。
  const back = shoot(flat('fairway', -0.2), putter, 0.5);
  assert(back.total < 0, `20% の上りで球が戻ってきません（${back.total.toFixed(1)}m 先で止まった）`);
  // 横に傾いた所では、低い方（-x）へ曲がる。
  const side = shoot(flat('green', 0, 0.03), putter, 0.5);
  assert(side.side < -0.3, `横の傾きで低い方へ曲がりません（横 ${side.side.toFixed(2)}m）`);
  // カップ（4m 先）: 黒い穴の真ん中を通れば速めでも入り、縁をかすめる程度なら遅いときだけ入り、外れた球は入らない。
  // 初速 2.4m/s でカップに 1.2m/s ほどで着く（グリーンの転がりの抵抗で）。
  const putAt = (offset, speed) => {
    const ball = new Ball(flat('green'));
    ball.place(offset, 0);
    ball.cup = { x: 0, z: -4, r: 0.22 };
    ball.hit(0, 0, speed, 0);
    for (let t = 0; t < 20 && ball.state !== 'rest' && ball.state !== 'holed'; t += 1 / 60) ball.update(1 / 60);
    return ball.state === 'holed';
  };
  assert(putAt(0, 3.5), '真ん中を 3m/s ほどで通った球が入りません');
  assert(putAt(0.25, 2.4), '縁にかかった遅い球が入りません');
  assert(!putAt(0.4, 2.4), '穴に触れていない球が入りました');
  assert(!putAt(0, 7), '強すぎる球が入りました');
  console.log('PASS  球の物理', rows.join(' / '), `スライス ${sliced.side.toFixed(0)}m 右へ`, `パター半分 ${putt.total.toFixed(1)}m（上り ${up.total.toFixed(1)} 下り ${down.total.toFixed(1)}、20% の上り ${back.total.toFixed(1)}、横の傾きで ${side.side.toFixed(1)}m 曲がる）`);
} finally {
  await server.close();
}
