import type * as THREE from 'three';
import type { Point3 } from './aim';
import type { Hole } from './course';

/**
 * 一緒に回る相手。COM（rivals.ts）と友達（peers.ts）が同じ形を持ち、GolfGame と画面はこの形だけを見る
 * （順位・球の上の名前・スコアカードの行・結果の順位を、COM と友達で同じ作りにできる）。
 */

/** 画面に出すための、相手 1 人の今の様子。 */
export interface OpponentState {
  id: string;
  name: string;
  color: number;
  /** ホールごとの打数（回っていないホールは null か undefined）。 */
  scores: readonly (number | null | undefined)[];
  /** 今のホールの打数と、入れたか。 */
  strokes: number;
  holed: boolean;
  /** 球の位置（入れた・別のホールにいるなら null）。 */
  ball: Point3 | null;
  /** つながっていない（友達が別のアプリへ行った・通信が切れた。戻れば続きから）。 */
  away?: boolean;
  /** 部屋にはいるが、まだ回っていない（友達が部屋を開いて見ている）。 */
  idle?: boolean;
}

export interface Opponents {
  readonly group: THREE.Group;
  /** 様子が変わったとき（止まった・入った・部屋の様子が届いた）に呼ぶ。 */
  onChange: (() => void) | null;
  teeOff(hole: Hole): void;
  /** プレイヤーが打った（COM は同時に打つ。友達はそれぞれ自分で打つので何もしない）。 */
  shoot(hole: Hole): void;
  /** プレイヤーが入れた（COM は残りを打ち切る）。 */
  finish(): void;
  update(dt: number, hole: Hole): void;
  /** 全員が今のホールを終えたか（カップインの後のスコアカードと、次のティーはこれを待つ）。 */
  readonly settled: boolean;
  states(): OpponentState[];
}
