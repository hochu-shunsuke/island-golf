import {
  AWAY_WAIT_MS,
  HOLE_WAIT_MS,
  MAX_NAME_LENGTH,
  MAX_ROOM_PLAYERS,
  STAMPS,
  STAMP_GAP_MS,
  type RestInfo,
  type RoomPlayer,
  type RoomView,
  type ServerMessage,
  type ShotInfo,
  cleanName,
} from '../shared/room';

/**
 * 友達と対戦する部屋（部屋の番号ごとに 1 つの Durable Object）。
 *
 * - 全員が同じホールを同時に、自分の球を自分の速さで打つ（Golf With Your Friends のオンラインと同じ）。
 *   全員が入れたら、そろって次のホールへ。誰かが入れてから HOLE_WAIT_MS 待っても終わらない人はダブルパーで打ち切る
 * - 中継するのは打った一打と止まった所だけ。コースは各自のブラウザが合言葉から同じものを作る
 * - 休眠する WebSocket で受ける（全員が黙っている間は課金されない）。部屋の様子は storage に置き、休眠から覚めても残す
 * - いつでも入れる。回っている途中に来た人は、そのとき回っているホールから加わる（順位は回ったホールのパーとの差で比べる）。
 *   以前は途中から入れず、先に始めると友達が締め出された
 * - 始めるのは誰でもよい（そろうのを待たずに始めてよい）。ホストは置かない（以前は置いていて、ホストが別のアプリへ
 *   行くと次の人へ移り、「後から来た人がホストになった」ように見えた）
 * - 「部屋を出る」を押した人は一覧から消す。切れただけの人は残す（別のアプリから戻れば続きから）。
 *   満員のときは、つながっていない人の枠を空けて新しい人を入れる
 * - 切れた人も、ホールの待ち時間までは待つ（LINE を開いて戻っただけでダブルパーにしない）。待ち時間を過ぎても
 *   戻らなければダブルパーにして、回りから外す（次のホールからは待たない。戻ればゲームが加わり直す）
 */

interface Member {
  /** ブラウザが持つ固定の番号（つなぎ直しても同じ）。他の人には見せない。 */
  cid: string;
  /** 他の人に見せる番号。 */
  id: string;
  slot: number;
  name: string;
  scores: (number | null)[];
  done: boolean;
  /** 今の回りに加わっているか（shared/room.ts の RoomPlayer.playing）。 */
  playing: boolean;
  /** 切れた時刻（ms）。つながっていれば null。AWAY_WAIT_MS 過ぎても戻らなければ、待たずに先へ進む。 */
  goneAt: number | null;
}

interface RoomState {
  seed: string;
  day: number;
  pars: number[];
  phase: RoomView['phase'];
  hole: number;
  members: Member[];
  /** 今のホールで最初に入れた時刻（ms）。まだなら null。 */
  firstDoneAt: number | null;
  /** 誰もつながっていなくなった時刻（ms）。誰かいれば null。 */
  emptyAt: number | null;
}

/** WebSocket に付けておく情報（休眠から覚めても残る）。 */
interface Attachment {
  cid: string;
}

/** 誰もいなくなってから部屋を片付けるまで（ms）。 */
const CLEANUP_MS = 30 * 60_000;
/**
 * 1 つの接続から受ける言葉の上限（RATE_WINDOW_MS あたり）。普通に遊べば 1 打に 2 つ（打った・止まった）なので
 * 届かない。大量に送り付けられて、アカウントで共有する無料枠（stroll も同じ）を食い潰されないように。
 */
const RATE_LIMIT = 40;
const RATE_WINDOW_MS = 10_000;

function cleanCid(raw: unknown): string {
  return typeof raw === 'string' ? raw.replace(/[^a-z0-9]/gi, '').slice(0, 32) : '';
}

/** 同じ名前の人がいれば番号を付ける（「ゲスト」が 2 人並ぶと、どちらがどちらか分からない）。 */
function uniqueName(room: RoomState, name: string, cid: string): string {
  const taken = new Set(room.members.filter((m) => m.cid !== cid).map((m) => m.name));
  if (!taken.has(name)) return name;
  for (let n = 2; ; n++) {
    const next = `${name.slice(0, MAX_NAME_LENGTH - String(n).length)}${n}`;
    if (!taken.has(next)) return next;
  }
}

function cleanSeed(raw: unknown): string {
  return typeof raw === 'string' ? raw.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16) : '';
}

/** 受け取った数をそのまま信じない（NaN や巨大な値で他の人の画面を壊さないように）。 */
function num(v: unknown, limit = 1e6): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.max(-limit, Math.min(limit, v));
}

function cleanShot(raw: unknown): ShotInfo | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const s = raw as Record<string, unknown>;
  const keys = ['x', 'z', 'yaw', 'loft', 'speed', 'spin', 'bite', 'curve'] as const;
  const out: Partial<ShotInfo> = { lie: typeof s.lie === 'string' ? s.lie.slice(0, 12) : 'fairway' };
  for (const k of keys) {
    const v = num(s[k]);
    if (v === null) return null;
    out[k] = v;
  }
  return out as ShotInfo;
}

function cleanRest(raw: unknown): RestInfo | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const s = raw as Record<string, unknown>;
  const x = num(s.x);
  const y = num(s.y);
  const z = num(s.z);
  const strokes = num(s.strokes, 99);
  if (x === null || y === null || z === null || strokes === null) return null;
  return {
    x,
    y,
    z,
    lie: typeof s.lie === 'string' ? s.lie.slice(0, 12) : 'fairway',
    strokes: Math.max(0, Math.round(strokes)),
    holed: s.holed === true,
  };
}

export class GolfRoom {
  private room: RoomState | null = null;
  /** 人ごとの最後にスタンプを中継した時刻（休眠で消えてよい）。 */
  private readonly lastStamp = new Map<string, number>();
  /** 接続ごとの、今の区切りで受けた言葉の数（休眠で消えてよい）。 */
  private readonly rate = new WeakMap<WebSocket, { from: number; count: number }>();

  constructor(private readonly state: DurableObjectState) {
    // 休眠したまま ping に pong を返す（立ち止まって考えている間に切られないように。DO は起きない）。
    state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    void state.blockConcurrencyWhile(async () => {
      this.room = (await state.storage.get<RoomState>('room')) ?? null;
      // playing を持つ前に作られた部屋は、全員が回っている扱い。
      for (const m of this.room?.members ?? []) m.playing ??= this.room!.phase === 'play';
      if (this.room) this.room.emptyAt ??= null;
      for (const m of this.room?.members ?? []) m.goneAt ??= null;
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
    const pair = new WebSocketPair();
    this.state.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ cid: '' } satisfies Attachment);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== 'string' || raw.length > 2048) return;
    if (!this.allow(ws)) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const me = ws.deserializeAttachment() as Attachment | null;
    if (!me) return;

    if (msg.t === 'hello') {
      await this.hello(ws, msg);
      return;
    }
    const room = this.room;
    const member = room?.members.find((m) => m.cid === me.cid);
    if (!room || !member) return;

    if (msg.t === 'name') {
      const name = uniqueName(room, cleanName(msg.name) || member.name, member.cid);
      if (name === member.name) return;
      member.name = name;
      await this.save();
      this.broadcastRoom();
    } else if (msg.t === 'start') {
      if (room.phase === 'play') {
        // 途中から加わる（今のホールから）。もう誰かが入れていれば、待ち時間を数え直す（来たばかりの人が打てるように）。
        if (member.playing) return;
        member.playing = true;
        member.done = false;
        if (room.firstDoneAt !== null) room.firstDoneAt = Date.now();
      } else {
        // 誰が押しても始まる（ホストを待たなくてよい）。ほかの人は、それぞれ押したときに加わる。
        room.phase = 'play';
        room.hole = 1;
        room.firstDoneAt = null;
        for (const m of room.members) {
          m.scores = room.pars.map(() => null);
          m.done = false;
          m.playing = m === member;
        }
      }
      await this.scheduleAlarm();
      await this.save();
      this.broadcastRoom();
    } else if (msg.t === 'leave') {
      room.members = room.members.filter((m) => m !== member);
      ws.serializeAttachment({ cid: '' } satisfies Attachment);
      await this.left(ws);
      try {
        ws.close(1000, 'leave');
      } catch {
        // 閉じかけていれば放っておく。
      }
    } else if (msg.t === 'shot') {
      const shot = cleanShot(msg.shot);
      const hole = num(msg.hole, 99);
      if (!shot || hole === null) return;
      this.broadcast(ws, { t: 'shot', id: member.id, hole, shot });
    } else if (msg.t === 'stamp') {
      // 番号だけを中継する（文字は送らせない）。1 人 STAMP_GAP_MS に 1 回まで。
      const i = typeof msg.s === 'number' && Number.isInteger(msg.s) ? msg.s : -1;
      if (i < 0 || i >= STAMPS.length) return;
      const now = Date.now();
      if (now - (this.lastStamp.get(member.cid) ?? 0) < STAMP_GAP_MS) return;
      this.lastStamp.set(member.cid, now);
      this.broadcast(ws, { t: 'stamp', id: member.id, s: i });
    } else if (msg.t === 'rest') {
      const rest = cleanRest(msg.rest);
      const hole = num(msg.hole, 99);
      if (!rest || hole === null) return;
      this.broadcast(ws, { t: 'rest', id: member.id, hole, rest });
      if (room.phase !== 'play' || !member.playing || hole !== room.hole || !rest.holed || member.done) return;
      member.scores[room.hole - 1] = rest.strokes;
      member.done = true;
      room.firstDoneAt ??= Date.now();
      this.advanceIfAllDone();
      await this.scheduleAlarm();
      await this.save();
      this.broadcastRoom();
    }
  }

  /** 入る（初めての人は部屋に加え、つなぎ直しの人は古い接続を閉じる）。 */
  private async hello(ws: WebSocket, msg: Record<string, unknown>): Promise<void> {
    const cid = cleanCid(msg.cid);
    if (!cid) return;
    const name = cleanName(msg.name) || 'ゲスト';
    let room = this.room;
    // 空の部屋: 作る人のコースで始める。
    if (!room || room.members.length === 0) {
      const pars = Array.isArray(msg.pars)
        ? msg.pars.slice(0, 18).map((p) => Math.max(2, Math.min(7, Math.round(Number(p) || 4))))
        : [];
      room = this.room = {
        seed: cleanSeed(msg.seed) || 'hakoniwa',
        day: Math.round(num(msg.day, 1e6) ?? 0),
        pars: pars.length > 0 ? pars : [4, 4, 4, 3, 5, 3, 5, 4, 4],
        phase: 'lobby',
        hole: 1,
        members: [],
        firstDoneAt: null,
        emptyAt: null,
      };
    }
    let member = room.members.find((m) => m.cid === cid);
    if (!member) {
      // 満員なら、つながっていない人（タブを閉じた人など）の枠を空ける。
      if (room.members.length >= MAX_ROOM_PLAYERS) {
        const online = this.onlineCids(ws);
        room.members = room.members.filter((m) => online.has(m.cid));
      }
      if (room.members.length >= MAX_ROOM_PLAYERS) {
        ws.send(JSON.stringify({ t: 'refused', reason: 'full' } satisfies ServerMessage));
        ws.close(1000, 'full');
        return;
      }
      const used = new Set(room.members.map((m) => m.slot));
      let slot = 0;
      while (used.has(slot)) slot++;
      member = {
        cid,
        id: crypto.randomUUID().slice(0, 8),
        slot,
        name: uniqueName(room, name, cid),
        scores: room.pars.map(() => null),
        done: false,
        playing: false,
        goneAt: null,
      };
      room.members.push(member);
    } else {
      member.name = uniqueName(room, name, cid);
      // 同じ人の古い接続は閉じる（つなぎ直しの後に、古い方が残って二重にならないように）。
      for (const other of this.state.getWebSockets()) {
        if (other === ws) continue;
        const a = other.deserializeAttachment() as Attachment | null;
        if (a?.cid === cid) {
          try {
            other.close(1000, 'replaced');
          } catch {
            // 閉じかけていれば放っておく。
          }
        }
      }
    }
    ws.serializeAttachment({ cid } satisfies Attachment);
    // 誰かが戻ってきたら、片付けの予定は取り消す（ホールの待ち時間があれば、そちらを入れ直す）。
    room.emptyAt = null;
    member.goneAt = null;
    await this.scheduleAlarm();
    await this.save();
    ws.send(JSON.stringify({ t: 'welcome', you: member.id, room: this.view() } satisfies ServerMessage));
    this.broadcastRoom({ skip: ws });
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.left(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.left(ws);
  }

  /** 切れた・出た: 残りが全員入れていれば次のホールへ。誰もいなければ片付けの予定。 */
  private async left(ws: WebSocket): Promise<void> {
    const room = this.room;
    if (!room) return;
    const online = this.onlineCids(ws);
    // 切れた人の時刻を覚える（AWAY_WAIT_MS まで待つ）。同じ人の別の接続が生きていれば切れていない。
    const cid = (ws.deserializeAttachment() as Attachment | null)?.cid;
    const gone = cid ? room.members.find((m) => m.cid === cid) : undefined;
    if (gone && !online.has(gone.cid)) gone.goneAt ??= Date.now();
    if (online.size === 0) room.emptyAt ??= Date.now();
    // 出た人（一覧から消えた）を待っていたなら、残りで次へ。切れただけの人は AWAY_WAIT_MS まで待つ。
    else this.advanceIfAllDone();
    await this.scheduleAlarm();
    await this.save();
    this.broadcastRoom({ gone: ws });
  }

  /**
   * 待ち時間が過ぎた・誰もいなくなってしばらくたった。
   * 全員が一瞬だけ切れている間（そろって別のアプリへ行った）にホールの待ち時間が来ても、部屋は消さない。
   * 片付けるのは、誰もいない時間が CLEANUP_MS 続いたときだけ。
   */
  async alarm(): Promise<void> {
    const room = this.room;
    if (!room) return;
    const online = this.onlineCids();
    if (online.size === 0) {
      room.emptyAt ??= Date.now();
      if (Date.now() >= room.emptyAt + CLEANUP_MS - 1000) {
        await this.state.storage.deleteAll();
        this.room = null;
        return;
      }
    } else {
      room.emptyAt = null;
      const hole = room.hole;
      const phase = room.phase;
      if (room.phase === 'play' && room.firstDoneAt !== null && Date.now() >= room.firstDoneAt + HOLE_WAIT_MS - 1000) {
        this.advance();
      } else {
        // 切れた人を待つ時間が過ぎた。
        this.advanceIfAllDone();
      }
      if (room.hole !== hole || room.phase !== phase) this.broadcastRoom();
    }
    await this.scheduleAlarm();
    await this.save();
  }

  /**
   * アラームは 1 つだけ: 誰もいなければ片付け。回っている間は、ホールの待ち時間と、切れた人を待つ時間の早い方。
   * どれも無ければ止める。
   */
  private async scheduleAlarm(): Promise<void> {
    const room = this.room;
    if (!room) return;
    if (room.emptyAt !== null) {
      await this.state.storage.setAlarm(room.emptyAt + CLEANUP_MS);
      return;
    }
    let at = Infinity;
    if (room.phase === 'play') {
      if (room.firstDoneAt !== null) at = room.firstDoneAt + HOLE_WAIT_MS;
      for (const m of this.awaiting()) at = Math.min(at, m.goneAt! + AWAY_WAIT_MS);
    }
    if (Number.isFinite(at)) await this.state.storage.setAlarm(at);
    else await this.state.storage.deleteAlarm();
  }

  /** 回っていて、このホールをまだ終えず、切れている人（戻るのを待っている人）。 */
  private awaiting(online = this.onlineCids()): Member[] {
    const room = this.room;
    if (!room) return [];
    return room.members.filter((m) => m.playing && !m.done && m.goneAt !== null && !online.has(m.cid));
  }

  /** 送り付けすぎる接続は切る（RATE_LIMIT）。 */
  private allow(ws: WebSocket): boolean {
    const now = Date.now();
    let r = this.rate.get(ws);
    if (!r || now - r.from > RATE_WINDOW_MS) {
      r = { from: now, count: 0 };
      this.rate.set(ws, r);
    }
    if (++r.count <= RATE_LIMIT) return true;
    try {
      ws.close(1008, 'too many messages');
    } catch {
      // 閉じかけていれば放っておく。
    }
    return false;
  }

  /**
   * 回っている人が全員このホールを終えたら、次のホールへ。見ているだけの人は待たない。
   * 切れている人も待つ（戻ってくるかもしれない。戻らなければ待ち時間で打ち切る）。
   */
  private advanceIfAllDone(): void {
    const room = this.room;
    if (!room || room.phase !== 'play') return;
    const now = Date.now();
    // 切れて AWAY_WAIT_MS たった人は待たない（advance でダブルパーにして回りから外す）。
    const expired = new Set(this.awaiting().filter((m) => now >= m.goneAt! + AWAY_WAIT_MS - 500));
    const playing = room.members.filter((m) => m.playing && !expired.has(m));
    if (playing.length > 0 && playing.every((m) => m.done)) this.advance();
  }

  /**
   * 次のホールへ（回っていて終えていない人はダブルパー）。最後のホールの後は終わり。
   * そのとき切れている人は回りから外す（次のホールからは待たない）。
   */
  private advance(): void {
    const room = this.room;
    if (!room) return;
    const par = room.pars[room.hole - 1] ?? 4;
    const online = this.onlineCids();
    for (const m of room.members) {
      if (m.playing && !m.done) {
        m.scores[room.hole - 1] = par * 2;
        if (!online.has(m.cid)) m.playing = false;
      }
      m.done = false;
    }
    room.firstDoneAt = null;
    if (room.hole >= room.pars.length) room.phase = 'done';
    else room.hole++;
  }

  private onlineCids(except?: WebSocket): Set<string> {
    const set = new Set<string>();
    for (const ws of this.state.getWebSockets()) {
      if (ws === except) continue;
      const a = ws.deserializeAttachment() as Attachment | null;
      if (a?.cid) set.add(a.cid);
    }
    return set;
  }

  private view(except?: WebSocket): RoomView {
    const room = this.room!;
    const online = this.onlineCids(except);
    const now = Date.now();
    const awaiting = new Set(this.awaiting(online));
    return {
      seed: room.seed,
      day: room.day,
      phase: room.phase,
      hole: room.hole,
      pars: room.pars,
      players: room.members.map(
        (m): RoomPlayer => ({
          slot: m.slot,
          id: m.id,
          name: m.name,
          scores: m.scores,
          done: m.done,
          playing: m.playing === true,
          online: online.has(m.cid),
          awayMs: awaiting.has(m) ? Math.max(0, m.goneAt! + AWAY_WAIT_MS - now) : null,
        }),
      ),
    };
  }

  private async save(): Promise<void> {
    if (this.room) await this.state.storage.put('room', this.room);
  }

  /**
   * 部屋の様子を全員へ。skip には送らない（入ったばかりの人。welcome で送ってある）。
   * gone は閉じかけの接続（つながっている数に入れず、送りもしない）。
   */
  private broadcastRoom(opts: { skip?: WebSocket; gone?: WebSocket } = {}): void {
    if (!this.room) return;
    const text = JSON.stringify({ t: 'room', room: this.view(opts.gone) } satisfies ServerMessage);
    for (const ws of this.state.getWebSockets()) {
      if (ws === opts.skip || ws === opts.gone) continue;
      try {
        ws.send(text);
      } catch {
        // 切れかけの接続は放っておく（close で片付く）。
      }
    }
  }

  /** 送った本人以外へ（送るのは課金されないので、人数分そのまま配る）。 */
  private broadcast(from: WebSocket, payload: ServerMessage): void {
    const text = JSON.stringify(payload);
    for (const ws of this.state.getWebSockets()) {
      if (ws === from) continue;
      try {
        ws.send(text);
      } catch {
        // 同上。
      }
    }
  }
}
