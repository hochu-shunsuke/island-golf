/**
 * ゴルフの球の物理。地形の上を飛び、跳ね、転がって止まる。
 *
 * 空気の力は抗力（速さの 2 乗）と、バックスピンの揚力（同じく速さの 2 乗、スピンは時間で弱まる）。
 * 実際の球の値（直径 43mm・46g・抗力係数 0.25 前後）から、ドライバーで 220m 前後飛ぶように合わせてある。
 * 地面に当たると、地面の種類ごとの反発と摩擦で跳ね、跳ねが小さくなったら斜面に沿って転がる。
 *
 * 画面や three.js には触らない（Worker やテストからも動かせるように）。
 */

export type Surface = 'green' | 'fairway' | 'rough' | 'sand' | 'rock' | 'snow';

/** 地面の種類ごとの跳ね方と転がり方。 */
export interface SurfaceFeel {
  /** 当たった瞬間の、面に垂直な速さの戻り（0..1）。 */
  bounce: number;
  /** 当たった瞬間に、面に沿った速さを失う割合（0..1）。 */
  grip: number;
  /** 転がるときの抵抗（重力に対する割合）。小さいほどよく転がる。 */
  roll: number;
}

export const SURFACE_FEEL: Record<Surface, SurfaceFeel> = {
  green: { bounce: 0.28, grip: 0.3, roll: 0.055 },
  fairway: { bounce: 0.33, grip: 0.3, roll: 0.11 },
  rough: { bounce: 0.22, grip: 0.5, roll: 0.3 },
  sand: { bounce: 0.04, grip: 0.85, roll: 0.9 },
  rock: { bounce: 0.55, grip: 0.12, roll: 0.09 },
  snow: { bounce: 0.1, grip: 0.6, roll: 0.4 },
};

/**
 * 木。幹（縦の円柱）は球を跳ね返し、葉のかたまり（少しつぶした球）は球の勢いを殺す。
 * 高さはすべて海面からの m。
 */
export interface Tree {
  x: number;
  z: number;
  /** 根元の高さ。 */
  y: number;
  trunkR: number;
  trunkTop: number;
  canopyY: number;
  canopyR: number;
}

/** 球が地面について知りたいこと。 */
export interface GolfGround {
  /** 地面の高さ（m）。描いている地面と同じ三角形で補間したもの。 */
  height(x: number, z: number): number;
  /** 水面の高さ（m）。海は 0、湖と川はその水面。水が無ければ -Infinity。 */
  water(x: number, z: number): number;
  surface(x: number, z: number): Surface;
  /** (x, z) から半径 r の中の木を visit に渡す。無ければ木に当たらない。 */
  trees?: (x: number, z: number, r: number, visit: (t: Tree) => void) => void;
}

export type BallState = 'rest' | 'flight' | 'roll' | 'holed' | 'water';

/** 球に起きたこと（音を鳴らすため）。 */
export type BallEvent = { type: 'land'; surface: Surface; speed: number } | { type: 'water' } | { type: 'cup' };

/** 球の半径（m）。本物は 21mm だが、見えるように大きめにしてある（物理も同じ大きさで扱う）。 */
export const BALL_RADIUS = 0.1;
const G = 9.81;
/** 抗力と揚力の係数（1/m）。0.5 ρ C A / m。 */
const DRAG = 0.0047;
const LIFT = 0.0042;
/** 横回転で曲がる強さ（1/m）。 */
const CURVE = 0.0022;
/** スピンが弱まる時間（s）。 */
const SPIN_DECAY = 6;
/** 1 回の計算の刻み（s）。速い球でも地面をすり抜けないよう細かく。 */
export const BALL_STEP = 1 / 240;
/** 地面に着いてからこの秒数を過ぎても転がっていれば、FAST_ROLL 倍の速さで進める（長く転がる球を待つのがつらい）。 */
const FAST_ROLL_AFTER = 6;
const FAST_ROLL = 4;

/**
 * 球を進める速さの倍率。groundTime は地面に着いてからの秒数（まだなら null）。急に速くならないよう、
 * 0.8 秒かけて 4 倍まで上げる。自分の球と友達の球（golf/peers.ts）で同じにする（違うと、友達の球だけ
 * ゆっくり転がり、止まった所の知らせを待たされる）。
 */
export function rollSpeed(groundTime: number | null): number {
  if (groundTime === null) return 1;
  const t = Math.max(0, Math.min(1, (groundTime - FAST_ROLL_AFTER) / 0.8));
  return 1 + (FAST_ROLL - 1) * t * t * (3 - 2 * t);
}
/** 葉の中で勢いが減る速さ（1/s）。3m の葉を 40m/s で抜けると 7 割ほど減る。 */
const CANOPY_DRAG = 8;
/** 幹で跳ね返る強さ。 */
const TRUNK_BOUNCE = 0.35;
/**
 * 打った直後、打った所の真上に葉がある木はこの時間だけ葉を無視する（幹は当たる）。
 * 木の下で止まった球が、真上の葉に当たって出せなくなるのを防ぐ（ゴルフゲームの開発記録で踏まれた穴）。
 */
const UNDER_CANOPY_GRACE = 0.6;
/**
 * カップに入る速さの上限（m/s）。真ん中を通れば速くても入り、縁にかかっただけなら遅いときだけ入る（蹴られない）。
 * 本物のカップ（半径 54mm）は真ん中でも 1.6m/s ほどで蹴られるが、ここのカップは 4 倍の大きさで、
 * 見た目に黒い穴の上を通った球が入らないと理不尽に感じる。
 */
const CUP_CENTER_SPEED = 4.5;
const CUP_EDGE_SPEED = 2.2;

export class Ball {
  readonly pos = { x: 0, y: 0, z: 0 };
  readonly vel = { x: 0, y: 0, z: 0 };
  state: BallState = 'rest';
  /** 揚力の強さ（打ち出しのスピン。時間で弱まる）。 */
  private spin = 0;
  /** 落ちたときに止まる強さ（0..1）。跳ねるたびに弱まる。 */
  private bite = 0;
  /** 横回転（正で右へ曲がる）。スピンと同じく時間で弱まる。 */
  private curve = 0;
  /** 最後に地面に触れた場所の種類。 */
  lie: Surface = 'fairway';
  /** 打った所と、打ってからの時間（木の下から打つときの決まりに使う）。 */
  private readonly start = { x: 0, z: 0 };
  private airTime = 0;
  /** 狙っているカップ（中心と半径）。無ければ入らない（狙いの線を引くための試し打ちなど）。 */
  cup: { x: number; z: number; r: number } | null = null;
  /** 風（m/s、水平）。飛んでいる間の空気の抵抗は、風に対する速さで決まる。転がりには効かない。 */
  wind = { x: 0, z: 0 };
  /** 落ちた・水に入った・カップに入ったときに呼ぶ（音のため。試し打ちの球には付けない）。 */
  onEvent: ((e: BallEvent) => void) | null = null;

  /**
   * step は 1 回の計算の刻み。狙いの線を引くための試し打ちは粗く（1/60s）して軽くする
   * （落ちる所は 1m ほどしか違わない）。本当に打つ球は細かい刻みのまま。
   */
  constructor(
    private readonly ground: GolfGround,
    private readonly step = BALL_STEP,
  ) {}

  /** 地面に置く。 */
  place(x: number, z: number): void {
    this.pos.x = x;
    this.pos.z = z;
    this.pos.y = this.ground.height(x, z) + BALL_RADIUS;
    this.vel.x = this.vel.y = this.vel.z = 0;
    this.state = 'rest';
    this.spin = 0;
    this.lie = this.ground.surface(x, z);
  }

  /**
   * 打つ。yaw は水平の向き（ラジアン、-z が 0 で左回り）、loft は打ち出し角（度）、
   * speed は初速（m/s）、spin は揚力の強さ（バックスピン）。
   * bite は落ちたときに止まる強さ（0 はよく転がり、1 に近いほどその場で止まる。短いクラブほど強い）。
   * curve は横回転（正で右へ曲がる。芯を外したときの曲がり）。
   */
  hit(yaw: number, loftDeg: number, speed: number, spin: number, bite = 0, curve = 0): void {
    const loft = (loftDeg * Math.PI) / 180;
    const horizontal = Math.cos(loft) * speed;
    this.vel.x = -Math.sin(yaw) * horizontal;
    this.vel.z = -Math.cos(yaw) * horizontal;
    this.vel.y = Math.sin(loft) * speed;
    this.spin = spin;
    this.bite = bite;
    this.curve = curve;
    this.state = loftDeg > 0.5 ? 'flight' : 'roll';
    this.start.x = this.pos.x;
    this.start.z = this.pos.z;
    this.airTime = 0;
  }

  get speed(): number {
    return Math.hypot(this.vel.x, this.vel.y, this.vel.z);
  }

  /** dt 秒ぶん進める（中で BALL_STEP 刻みに分ける）。 */
  update(dt: number): void {
    let t = dt;
    while (t > 1e-6 && (this.state === 'flight' || this.state === 'roll')) {
      const h = Math.min(this.step, t);
      if (this.state === 'flight') this.fly(h);
      else this.rollStep(h);
      // カップは刻みごとに見る（1 コマごとに見ると、速い球が穴の上を飛び越えて見逃す）。
      this.dropIntoCup();
      t -= h;
    }
    // 縁に止まった球も落ちる。
    if (this.state === 'rest') this.dropIntoCup();
  }

  /** 球の中心がカップの上にあり、地面すれすれで、速すぎなければ入る。 */
  private dropIntoCup(): void {
    const c = this.cup;
    if (!c || this.state === 'water' || this.state === 'holed') return;
    const d = Math.hypot(this.pos.x - c.x, this.pos.z - c.z);
    if (d > c.r + BALL_RADIUS) return;
    const low = this.pos.y - this.ground.height(this.pos.x, this.pos.z) < BALL_RADIUS + 0.15;
    if (!low) return;
    const s = this.speed;
    const inside = d < c.r && (s < CUP_CENTER_SPEED || this.state === 'flight');
    const edge = d < c.r + BALL_RADIUS * 0.5 && s < CUP_EDGE_SPEED;
    if (inside || edge) {
      this.state = 'holed';
      this.onEvent?.({ type: 'cup' });
      this.vel.x = this.vel.y = this.vel.z = 0;
      this.pos.x = c.x;
      this.pos.z = c.z;
    }
  }

  /** 地面の法線（中心差分）。 */
  private normal(x: number, z: number): { x: number; y: number; z: number } {
    const e = 0.5;
    const dx = (this.ground.height(x + e, z) - this.ground.height(x - e, z)) / (2 * e);
    const dz = (this.ground.height(x, z + e) - this.ground.height(x, z - e)) / (2 * e);
    const len = Math.sqrt(dx * dx + 1 + dz * dz);
    return { x: -dx / len, y: 1 / len, z: -dz / len };
  }

  private fly(h: number): void {
    const v = this.vel;
    const s = Math.hypot(v.x, v.y, v.z);
    // 抗力は風に対する速さの逆向き（向かい風で押し戻され、横風で流される）。
    // 揚力は速さに垂直で上向き（水平面内の向きは変えない）。
    const rx = v.x - this.wind.x;
    const rz = v.z - this.wind.z;
    const rs = Math.hypot(rx, v.y, rz);
    let ax = -DRAG * rs * rx;
    let ay = -DRAG * rs * v.y - G;
    let az = -DRAG * rs * rz;
    if (this.spin > 0 && s > 1) {
      const hs = Math.hypot(v.x, v.z);
      // 速さに垂直な上向きの単位ベクトル。
      const ux = (-v.x * v.y) / (s * Math.max(hs, 1e-6));
      const uy = hs / s;
      const uz = (-v.z * v.y) / (s * Math.max(hs, 1e-6));
      const lift = LIFT * this.spin * s * s;
      ax += ux * lift;
      ay += uy * lift;
      az += uz * lift;
      this.spin *= Math.exp(-h / SPIN_DECAY);
    }
    if (this.curve !== 0 && s > 1) {
      // 横回転: 水平面で速さに垂直な向き（右が正）。
      const hs = Math.max(Math.hypot(v.x, v.z), 1e-6);
      const side = CURVE * this.curve * s * s;
      ax += (-v.z / hs) * side;
      az += (v.x / hs) * side;
      this.curve *= Math.exp(-h / SPIN_DECAY);
    }
    v.x += ax * h;
    v.y += ay * h;
    v.z += az * h;
    const p = this.pos;
    p.x += v.x * h;
    p.y += v.y * h;
    p.z += v.z * h;
    this.airTime += h;
    this.hitTrees(h, true);

    if (p.y - BALL_RADIUS < this.ground.water(p.x, p.z)) {
      this.state = 'water';
      this.onEvent?.({ type: 'water' });
      return;
    }
    const floor = this.ground.height(p.x, p.z) + BALL_RADIUS;
    if (p.y <= floor) {
      p.y = floor;
      this.bounce();
    }
  }

  /** 地面に当たった。面に垂直な速さを反発で返し、面に沿った速さを摩擦で削る。 */
  private bounce(): void {
    const p = this.pos;
    const v = this.vel;
    const n = this.normal(p.x, p.z);
    this.lie = this.ground.surface(p.x, p.z);
    const feel = SURFACE_FEEL[this.lie];
    const vn = v.x * n.x + v.y * n.y + v.z * n.z;
    if (vn >= 0) return;
    if (-vn > 1.5) this.onEvent?.({ type: 'land', surface: this.lie, speed: -vn });
    const tx = v.x - vn * n.x;
    const ty = v.y - vn * n.y;
    const tz = v.z - vn * n.z;
    // 短いクラブの球ほど、着地で面に沿った速さを失う（ウェッジはその場で止まり、ドライバーは転がる）。
    const keep = Math.max(0.03, (1 - feel.grip) * (1 - this.bite));
    const out = -vn * feel.bounce;
    v.x = tx * keep + n.x * out;
    v.y = ty * keep + n.y * out;
    v.z = tz * keep + n.z * out;
    // スピンと止まる力は、当たるたびにほぼ消える。
    this.spin *= 0.3;
    this.bite *= 0.35;
    this.curve = 0;
    // 跳ねが小さくなったら転がりへ。
    if (out < 1.2) {
      v.x -= n.x * out;
      v.y -= n.y * out;
      v.z -= n.z * out;
      this.state = 'roll';
    }
  }

  private rollStep(h: number): void {
    const p = this.pos;
    const v = this.vel;
    const n = this.normal(p.x, p.z);
    this.lie = this.ground.surface(p.x, p.z);
    const feel = SURFACE_FEEL[this.lie];
    // 重力のうち斜面に沿った分: g - (g·n) n。法線は下り側へ傾いているので、x と z は法線と同じ向き。
    const gx = G * n.y * n.x;
    const gy = -G + G * n.y * n.y;
    const gz = G * n.y * n.z;
    const s = Math.hypot(v.x, v.y, v.z);
    const slopeG = Math.hypot(gx, gy, gz);
    const resist = feel.roll * G * n.y;
    // 止まる: 遅く、斜面の引きが抵抗に負けるとき。
    if (s < 0.04 && slopeG < resist * 1.4) {
      v.x = v.y = v.z = 0;
      p.y = this.ground.height(p.x, p.z) + BALL_RADIUS;
      this.state = 'rest';
      return;
    }
    let ax = gx;
    let ay = gy;
    let az = gz;
    if (s > 1e-6) {
      ax -= (resist * v.x) / s;
      ay -= (resist * v.y) / s;
      az -= (resist * v.z) / s;
    }
    const nx = v.x + ax * h;
    const ny = v.y + ay * h;
    const nz = v.z + az * h;
    // 抵抗で向きが逆転しないように（止まる手前で行き過ぎない）。
    if (s > 1e-6 && nx * v.x + ny * v.y + nz * v.z < 0) {
      v.x = v.y = v.z = 0;
    } else {
      v.x = nx;
      v.y = ny;
      v.z = nz;
    }
    // 面に沿った速さだけ残す。
    const vn = v.x * n.x + v.y * n.y + v.z * n.z;
    v.x -= vn * n.x;
    v.y -= vn * n.y;
    v.z -= vn * n.z;

    p.x += v.x * h;
    p.z += v.z * h;
    this.hitTrees(h, false);
    const ahead = p.y + v.y * h;
    const floor = this.ground.height(p.x, p.z) + BALL_RADIUS;
    if (ahead > floor + 0.08) {
      // 地面が急に下がった（段や崖の縁）。飛んで落ちる。
      p.y = ahead;
      this.state = 'flight';
      return;
    }
    p.y = floor;
    if (p.y - BALL_RADIUS < this.ground.water(p.x, p.z) - 0.05) {
      this.state = 'water';
      this.onEvent?.({ type: 'water' });
    }
  }

  /** 木に当たる。幹は跳ね返し、葉（飛んでいるときだけ）は勢いを殺す。 */
  private hitTrees(h: number, flying: boolean): void {
    if (!this.ground.trees) return;
    const p = this.pos;
    const v = this.vel;
    this.ground.trees(p.x, p.z, 8, (t) => {
      const dx = p.x - t.x;
      const dz = p.z - t.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (p.y < t.trunkTop && p.y > t.y - 0.5 && d < t.trunkR + BALL_RADIUS) {
        const nx = d > 1e-6 ? dx / d : 1;
        const nz = d > 1e-6 ? dz / d : 0;
        const vn = v.x * nx + v.z * nz;
        if (vn < 0) {
          v.x = (v.x - (1 + TRUNK_BOUNCE) * vn * nx) * 0.7;
          v.z = (v.z - (1 + TRUNK_BOUNCE) * vn * nz) * 0.7;
          this.spin = 0;
        }
        p.x = t.x + nx * (t.trunkR + BALL_RADIUS + 0.01);
        p.z = t.z + nz * (t.trunkR + BALL_RADIUS + 0.01);
        return;
      }
      if (!flying) return;
      const underStart =
        this.airTime < UNDER_CANOPY_GRACE && Math.hypot(t.x - this.start.x, t.z - this.start.z) < t.canopyR + 0.5;
      if (underStart) return;
      const dy = (p.y - t.canopyY) / 0.8;
      if (dx * dx + dz * dz + dy * dy < t.canopyR * t.canopyR) {
        const k = Math.exp(-CANOPY_DRAG * h);
        v.x *= k;
        v.y *= k;
        v.z *= k;
        this.spin *= k;
      }
    });
  }

}
