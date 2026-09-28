import type { ClientMessage, RestInfo, RoomView, ServerMessage, ShotInfo } from '../../shared/room';

/**
 * 友達と対戦する部屋への接続（stroll の net/connection.ts と同じ作り）。
 *
 * - つなぐ先は同じ場所の /ws（本番は Worker、手元は vite が npm run relay へ取り次ぐ）。環境変数は見ない
 * - 切れたら 3 秒ごとにつなぎ直す。つなぎ直しても同じ人と分かるよう、タブごとの固定の番号（cid）を送る
 *   （sessionStorage に置く。スマホは別のアプリから戻ると読み直すことがあり、メモリだけだと別人になる）
 * - 無通信で切られないよう、25 秒ごとに ping（中継は休眠したまま pong を返す）
 * - 死んだ接続を待たない。スマホで電波やアプリを切り替えると、接続は「閉じかけ」のまま何分も残り、その間は
 *   つなぎ直しが始まらない。何も届かないまま HEARD_TIMEOUT_MS たったら張り直し、画面に戻った・電波が戻ったときは
 *   すぐ確かめる（pong が CHECK_MS 以内に来なければ張り直す）
 */

export type RoomStatus = 'connecting' | 'open' | 'lost' | 'full';

export interface RoomHandlers {
  /** 入れた（つなぎ直しのたびにも届く）。me は自分の番号。 */
  onWelcome(me: string, room: RoomView): void;
  onRoom(room: RoomView): void;
  onShot(id: string, hole: number, shot: ShotInfo): void;
  onRest(id: string, hole: number, rest: RestInfo): void;
  /** 友達がスタンプを送った（STAMPS の番号）。 */
  onStamp(id: string, s: number): void;
  onStatus(status: RoomStatus): void;
}

const RECONNECT_MS = 3000;
const PING_MS = 25_000;
const HEARD_TIMEOUT_MS = 60_000;
const CHECK_MS = 4000;
const CID_KEY = 'hole-in-isle:cid';

function stableCid(): string {
  const fresh = () => Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 6);
  try {
    const saved = sessionStorage.getItem(CID_KEY);
    if (saved && /^[a-z0-9]{1,32}$/.test(saved)) return saved;
    const id = fresh();
    sessionStorage.setItem(CID_KEY, id);
    return id;
  } catch {
    return fresh();
  }
}

export class RoomClient {
  private ws: WebSocket | null = null;
  private closed = false;
  private retryTimer = 0;
  private pingTimer = 0;
  private checkTimer = 0;
  /** 最後に中継から何か届いた時刻（pong を含む）。 */
  private lastHeard = 0;
  private readonly cid = stableCid();
  /** 画面に戻った・電波が戻った: 接続が生きているか確かめる。 */
  private readonly onWake = () => {
    if (this.closed || document.visibilityState === 'hidden') return;
    const ws = this.ws;
    if (ws?.readyState === WebSocket.CONNECTING) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      if (ws) this.drop(ws);
      else this.reconnectNow();
      return;
    }
    const asked = Date.now();
    ws.send('ping');
    window.clearTimeout(this.checkTimer);
    this.checkTimer = window.setTimeout(() => {
      if (this.ws === ws && this.lastHeard < asked) this.drop(ws);
    }, CHECK_MS);
  };

  constructor(
    readonly roomId: string,
    /** 入るときに送る名前と、部屋を作るときのコース（空の部屋にだけ使われる）。つなぎ直しのたびに読み直す。 */
    private readonly hello: () => { name: string; seed: string; day: number; pars: number[] },
    private readonly handlers: RoomHandlers,
  ) {
    document.addEventListener('visibilitychange', this.onWake);
    window.addEventListener('online', this.onWake);
    this.connect();
  }

  private connect(): void {
    if (this.closed) return;
    this.handlers.onStatus('connecting');
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?room=${this.roomId}`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.addEventListener('open', () => {
      if (this.ws !== ws) return;
      this.lastHeard = Date.now();
      this.send({ t: 'hello', cid: this.cid, ...this.hello() });
      this.handlers.onStatus('open');
      window.clearInterval(this.pingTimer);
      this.pingTimer = window.setInterval(() => {
        if (this.ws !== ws) return;
        if (Date.now() - this.lastHeard > HEARD_TIMEOUT_MS) this.drop(ws);
        else if (ws.readyState === WebSocket.OPEN) ws.send('ping');
      }, PING_MS);
    });
    ws.addEventListener('message', (ev) => {
      if (this.ws !== ws) return;
      this.lastHeard = Date.now();
      this.receive(ev.data);
    });
    // 捨てた接続（drop）の close が後から届いても、何もしない（つなぎ直した接続を二重にしない）。
    ws.addEventListener('close', () => {
      if (this.ws === ws) this.drop(ws);
    });
  }

  /** この接続を捨てて、つなぎ直す（閉じ終わるのを待たない）。 */
  private drop(ws: WebSocket): void {
    if (this.ws !== ws) return;
    this.ws = null;
    window.clearInterval(this.pingTimer);
    window.clearTimeout(this.checkTimer);
    try {
      ws.close();
    } catch {
      // 閉じかけていれば放っておく。
    }
    if (!this.closed) {
      this.handlers.onStatus('lost');
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    window.clearTimeout(this.retryTimer);
    this.retryTimer = window.setTimeout(() => this.connect(), RECONNECT_MS);
  }

  /** つなぎ直しを待たずに、今つなぐ（画面に戻ったとき）。 */
  private reconnectNow(): void {
    window.clearTimeout(this.retryTimer);
    this.connect();
  }

  private receive(raw: unknown): void {
    if (typeof raw !== 'string' || raw === 'pong') return;
    let msg: ServerMessage;
    try {
      msg = JSON.parse(raw) as ServerMessage;
    } catch {
      return;
    }
    if (msg.t === 'welcome') this.handlers.onWelcome(msg.you, msg.room);
    else if (msg.t === 'room') this.handlers.onRoom(msg.room);
    else if (msg.t === 'shot') this.handlers.onShot(msg.id, msg.hole, msg.shot);
    else if (msg.t === 'rest') this.handlers.onRest(msg.id, msg.hole, msg.rest);
    else if (msg.t === 'stamp') this.handlers.onStamp(msg.id, msg.s);
    else if (msg.t === 'refused') {
      // 満員の部屋には、つなぎ直しても入れない。
      this.closed = true;
      this.handlers.onStatus(msg.reason);
    }
  }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  /** 部屋を出る（部屋の一覧からも消える）。 */
  close(): void {
    this.send({ t: 'leave' });
    this.closed = true;
    document.removeEventListener('visibilitychange', this.onWake);
    window.removeEventListener('online', this.onWake);
    window.clearTimeout(this.retryTimer);
    window.clearTimeout(this.checkTimer);
    window.clearInterval(this.pingTimer);
    this.ws?.close(1000, 'leave');
    this.ws = null;
  }
}
