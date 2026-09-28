import assert from 'node:assert/strict';
import { createServer } from 'vite';

/**
 * 友達と対戦する部屋（server/room.ts）の進め方を、Durable Object の作りを真似た偽物の上で確かめる。
 * 途中から入れること、見ているだけの人を待たないこと、時間切れ、全員が一瞬切れても部屋が消えないこと、
 * 部屋を出た人が消えること、満員でもつながっていない人の枠は空くこと、同じ名前に番号が付くこと、送り付けを切ること。
 */

/** 休眠する WebSocket の偽物。 */
class FakeSocket {
  constructor() {
    this.attachment = null;
    this.sent = [];
    this.closed = false;
  }
  serializeAttachment(a) {
    this.attachment = structuredClone(a);
  }
  deserializeAttachment() {
    return this.attachment;
  }
  send(text) {
    this.sent.push(JSON.parse(text));
  }
  close() {
    this.closed = true;
  }
  /** 最後に届いた部屋の様子。 */
  get room() {
    for (let i = this.sent.length - 1; i >= 0; i--) if (this.sent[i].room) return this.sent[i].room;
    return null;
  }
}

/** DurableObjectState の偽物（使っている所だけ）。 */
function fakeState() {
  const data = new Map();
  const state = {
    sockets: [],
    alarm: null,
    storage: {
      get: async (k) => structuredClone(data.get(k)),
      put: async (k, v) => void data.set(k, structuredClone(v)),
      setAlarm: async (t) => void (state.alarm = t),
      deleteAlarm: async () => void (state.alarm = null),
      deleteAll: async () => void data.clear(),
    },
    data,
    setWebSocketAutoResponse() {},
    blockConcurrencyWhile: (fn) => fn(),
    getWebSockets: () => state.sockets.filter((s) => !s.closed),
  };
  return state;
}

globalThis.WebSocketRequestResponsePair ??= class {};

const server = await createServer({ configFile: false, appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } });
try {
  const { GolfRoom } = await server.ssrLoadModule('/server/room.ts');
  const { HOLE_WAIT_MS, AWAY_WAIT_MS, isRoomId, cleanName, newRoomId } = await server.ssrLoadModule('/shared/room.ts');

  // 決まり
  assert.ok(isRoomId(newRoomId()) && !isRoomId('12345') && !isRoomId('abcdef') && !isRoomId(123456));
  assert.equal(cleanName('  <b>名前</b>\u0007  '), 'b名前/b');
  assert.equal(cleanName('あいうえおかきくけこさしすせそ').length, 12);

  const state = fakeState();
  const room = new GolfRoom(state);
  await Promise.resolve();
  const say = (ws, msg) => room.webSocketMessage(ws, JSON.stringify(msg));
  const connect = async (cid, name) => {
    const ws = new FakeSocket();
    ws.serializeAttachment({ cid: '' });
    state.sockets.push(ws);
    await say(ws, { t: 'hello', cid, name, seed: 'abcdefgh', day: 10, pars: [4, 3, 5] });
    return ws;
  };
  const drop = async (ws) => {
    ws.closed = true;
    await room.webSocketClose(ws);
  };
  const player = (ws, name) => ws.room.players.find((p) => p.name === name);
  const holeOut = (ws, hole, strokes) =>
    say(ws, { t: 'rest', hole, rest: { x: 0, y: 0, z: 0, lie: 'green', strokes, holed: true } });

  // 1 人で先に始める。後から来た人は見ているだけ（ホールが進むのを止めない）。
  const x = await connect('xcid', 'ゲスト');
  assert.equal(x.room.phase, 'lobby');
  await say(x, { t: 'start' });
  const y = await connect('ycid', 'ゲスト');
  assert.equal(player(y, 'ゲスト2')?.playing, false, '同じ名前には番号が付き、途中から来た人はまだ回っていない');
  assert.equal(y.room.phase, 'play');
  await holeOut(x, 1, 4);
  assert.equal(y.room.hole, 2, '見ているだけの人は待たない');
  assert.equal(player(y, 'ゲスト2').scores[0], null, '回っていないホールにダブルパーは付かない');
  assert.equal(state.alarm, null);

  // 途中から加わる → 全員が入れるまで待つ。
  await say(y, { t: 'start' });
  assert.equal(player(x, 'ゲスト2').playing, true);
  await holeOut(x, 2, 3);
  assert.equal(x.room.hole, 2, '加わった人が入れるまで待つ');
  assert.ok(state.alarm !== null, '待ち時間のアラーム');
  await holeOut(y, 2, 4);
  assert.equal(x.room.hole, 3);
  assert.equal(state.alarm, null);

  // 時間切れ: まだの人はダブルパー。
  await holeOut(x, 3, 5);
  room.room.firstDoneAt -= HOLE_WAIT_MS;
  await room.alarm();
  assert.equal(x.room.phase, 'done');
  assert.deepEqual(player(x, 'ゲスト2').scores, [null, 4, 10]);

  // もう一度（誰が押してもよい）。押した人だけが回っている。
  await say(y, { t: 'start' });
  assert.equal(y.room.phase, 'play');
  assert.equal(y.room.hole, 1);
  assert.equal(player(y, 'ゲスト').playing, false);
  assert.equal(player(y, 'ゲスト2').playing, true);
  await say(x, { t: 'start' });
  await holeOut(y, 1, 4);

  // 切れた人も待つ（別のアプリへ行っただけでダブルパーにしない）。
  await drop(x);
  assert.equal(y.room.hole, 1, '切れた人も待ち時間までは待つ');
  // 全員が一瞬切れている間に待ち時間が来ても、部屋は消えない。戻ったら時間切れを進める。
  await drop(y);
  room.room.firstDoneAt -= HOLE_WAIT_MS;
  await room.alarm();
  assert.ok(room.room, '全員が一瞬切れても部屋は残る');
  assert.ok(state.alarm > Date.now() + 60_000, '片付けは、誰もいない時間が続いてから');
  const x2 = await connect('xcid', 'ゲスト');
  assert.ok(state.alarm <= Date.now(), '戻ったら、過ぎていた待ち時間のアラームを入れ直す');
  await room.alarm();
  assert.equal(x2.room.hole, 2);
  assert.equal(player(x2, 'ゲスト').scores[0], 8);
  assert.equal(player(x2, 'ゲスト2').online, false, '切れた人は残る（離席中）');

  // 切れた人は AWAY_WAIT_MS だけ待つ（残り時間を部屋の様子で知らせる）。過ぎても戻らなければ
  // ダブルパーにして回りから外す（次のホールからは待たない）。
  await holeOut(x2, 2, 3);
  assert.equal(x2.room.hole, 2, '切れて間もない人は待つ');
  const left = player(x2, 'ゲスト2').awayMs;
  assert.ok(left > 0 && left <= AWAY_WAIT_MS, `離席中の残り時間を知らせる（${left}）`);
  assert.ok(state.alarm <= Date.now() + AWAY_WAIT_MS, '切れた人を待つ時間のアラーム');
  room.room.members.find((m) => m.name === 'ゲスト2').goneAt -= AWAY_WAIT_MS;
  await room.alarm();
  assert.equal(x2.room.hole, 3);
  assert.equal(player(x2, 'ゲスト2').scores[1], 6);
  assert.equal(player(x2, 'ゲスト2').playing, false);
  await holeOut(x2, 3, 5);
  assert.equal(x2.room.phase, 'done', '外れた人は待たない');

  // 部屋を出た人は一覧から消える。
  const z = await connect('zcid', 'Z');
  assert.ok(player(x2, 'Z'));
  await say(z, { t: 'leave' });
  assert.equal(player(x2, 'Z'), undefined);

  // 満員でも、つながっていない人の枠は空ける。
  await connect('c3', 'C3');
  await connect('c4', 'C4');
  assert.equal(x2.room.players.length, 4);
  const late = await connect('c5', 'C5');
  assert.ok(!late.closed, 'つながっていない人の枠を空けて入れる');
  assert.equal(player(late, 'ゲスト2'), undefined);
  const full = await connect('c6', 'C6');
  assert.ok(full.closed && full.sent.some((m) => m.t === 'refused'), '全員つながっていれば満員');

  // 誰もいない時間が続いたら片付ける。
  for (const ws of state.getWebSockets()) await drop(ws);
  room.room.emptyAt -= 31 * 60_000;
  await room.alarm();
  assert.equal(room.room, null);
  assert.equal(state.data.size, 0);

  // 送り付けは切る。
  const r2 = new GolfRoom(fakeState());
  await Promise.resolve();
  const spam = new FakeSocket();
  spam.serializeAttachment({ cid: '' });
  for (let i = 0; i < 60; i++) await r2.webSocketMessage(spam, JSON.stringify({ t: 'name', name: 'x' }));
  assert.ok(spam.closed, '送り付けは切る');

  console.log('PASS  部屋 途中から入る・見ているだけは待たない・時間切れ・切れた人を 30 秒待つ／外す・全員が一瞬切れても残る・出る・満員の空け直し・同じ名前・送り付け');
} finally {
  await server.close();
}
