/**
 * 友達と対戦する部屋の決まり。ゲーム（src/net/room.ts）と中継（server/room.ts）の両方がここを読む。
 * 片方だけ変えると、もう片方が相手の言葉を読めなくなる。
 *
 * - 部屋はコースの合言葉とは別の番号で作る。合言葉ごとに部屋にすると、今日のコースに来た全員が 1 部屋に集まる
 * - 部屋の番号は数字 6 桁（口で伝えやすい。「部屋に入る」は数字のキーボードで入れる）
 * - 送るのは、打った一打と止まった所だけ（座標を流し続けない）。コースは各自のブラウザが合言葉から同じものを作る
 */

/** 1 部屋の人数の上限。 */
export const MAX_ROOM_PLAYERS = 4;
/** 名前の長さの上限。 */
export const MAX_NAME_LENGTH = 12;
/** 誰かが入れてから、まだの人を待つ時間（ms）。過ぎたらダブルパーで次のホールへ（放置で全員が止まらないように）。 */
export const HOLE_WAIT_MS = 180_000;

/** 部屋の番号か（数字 6 桁）。 */
export function isRoomId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9]{6}$/.test(value);
}

/** 新しい部屋の番号（先頭は 0 以外）。 */
export function newRoomId(): string {
  const buf = new Uint32Array(6);
  crypto.getRandomValues(buf);
  let s = String(1 + (buf[0] % 9));
  for (let i = 1; i < 6; i++) s += String(buf[i] % 10);
  return s;
}

/** 名前は他の人の画面に出るので、長さと文字種を絞る。 */
export function cleanName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, MAX_NAME_LENGTH);
}

/** 打った一打（受け取った側が同じ物理でもう一度飛ばす。golf/ball.ts の hit の引数そのまま）。 */
export interface ShotInfo {
  x: number;
  z: number;
  lie: string;
  yaw: number;
  loft: number;
  speed: number;
  spin: number;
  bite: number;
  curve: number;
}

/** 止まった所（打った本人の画面での結果。受け取った側はこれに合わせる）。 */
export interface RestInfo {
  x: number;
  y: number;
  z: number;
  lie: string;
  /** このホールの今の打数。 */
  strokes: number;
  holed: boolean;
}

/** 部屋の中の 1 人。 */
export interface RoomPlayer {
  /** 画面で見分けるための番号（入った順の 0..3。色もこれで決まる）。 */
  slot: number;
  id: string;
  name: string;
  /** ホールごとの打数（回っていないホールは null）。 */
  scores: (number | null)[];
  /** 今のホールを終えたか。 */
  done: boolean;
  /**
   * 今の回りに加わっているか（「はじめる」「n 番から入る」を押した）。部屋を開いて見ているだけの人は
   * ホールが進むのを止めず、時間切れのダブルパーも付かない。
   */
  playing: boolean;
  /** つながっているか（切れても打数は残す。つなぎ直せば戻れる。別のアプリへ行っただけの人など）。 */
  online: boolean;
}

/** 部屋の様子（変わるたびに全員へ丸ごと送る。4 人までなので小さい）。 */
export interface RoomView {
  seed: string;
  /** ピンと風の日（core/day.ts の dayIndex）。部屋を作った人の日に合わせる。 */
  day: number;
  phase: 'lobby' | 'play' | 'done';
  /** 回っているホールの番号（1..）。 */
  hole: number;
  /** ホールごとのパー（時間切れのダブルパーに使う）。 */
  pars: number[];
  players: RoomPlayer[];
}

/** ゲーム → 中継。 */
export type ClientMessage =
  /** 入る。seed・day・pars は部屋を作る人のもの（部屋が空のときだけ使う。後から入る人は部屋に合わせる）。 */
  | { t: 'hello'; cid: string; name: string; seed: string; day: number; pars: number[] }
  | { t: 'name'; name: string }
  /** 回る。始まっていなければ 1 番から始め（誰が押してもよい）、始まっていれば今のホールから加わる。 */
  | { t: 'start' }
  | { t: 'shot'; hole: number; shot: ShotInfo }
  | { t: 'rest'; hole: number; rest: RestInfo }
  /** 「部屋を出る」を押した（一覧から消す。切れただけの人は残して、つなぎ直せば戻れる）。 */
  | { t: 'leave' };

/** 中継 → ゲーム。 */
export type ServerMessage =
  | { t: 'welcome'; you: string; room: RoomView }
  | { t: 'room'; room: RoomView }
  | { t: 'shot'; id: string; hole: number; shot: ShotInfo }
  | { t: 'rest'; id: string; hole: number; rest: RestInfo }
  /** 入れなかった（満員）。 */
  | { t: 'refused'; reason: 'full' };
