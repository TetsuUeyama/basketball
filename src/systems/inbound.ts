// スローイン/インバウンド機能。固有状態(残り時間/受け手/OOB歩行者と地点)はこのクラスが所有。
// 実際の投げ入れ(throwIn)は Game 側に残し、update() から呼ぶ。
import { Vector3 } from "@babylonjs/core";
import { Player } from "../objects/player/player";
import { COURT, RIM, SHOT_CLOCK, SHOT_CLOCK_PARTIAL, OOB_OUTSET, INBOUNDS_INSET, teamShort } from "../config";
import { clamp, rand, dist2DTo, moveToward2D, nearestOf } from "../util";
import { runDefenseDuringDeadish } from "../ai/defense";
import type { Game } from "../game";

export class InboundSystem {
  t = 0;                            // 投げ入れまでの残り時間
  receiver: Player | null = null;   // 受け手
  oobWalker: Player | null = null;  // OOB地点へ歩く投げ手（updatePause が動かす）
  oobSpot = new Vector3();
  private oobTeam = 0;
  private oobShotClock = 0;          // 投げ入れ時に戻すショットクロック

  constructor(private game: Game) {}

  // ゴール成功後のスローイン: 相手が決めたので、そのベースライン後方から入れる。
  start(team: number): void {
    const g = this.game;
    g.possession = team;
    const scorer = 1 - team;
    const sign = g.attackSign(scorer);
    const baselineZ = sign * RIM.z;
    const tp = g.teamPlayers(team);
    const taker = nearestOf(tp, (p) => Math.abs(p.pos.z - baselineZ))!;
    taker.pos.set(rand(-2, 2), 0, sign * (COURT.halfL + OOB_OUTSET)); // エンドライン後方
    g.handler = taker;
    g.ballMode = "inbound";
    this.t = 2.4;   // ゴール後、インバウンダーが持って投げ入れるまでの時間
    g.shotClock = SHOT_CLOCK;
    g.resetMotion();
    this.receiver = this.pickReceiver(taker);
    // メイド/FT後は失点側が入れる — 誰のボールか表示
    g.setEvent(`THROW-IN\n${teamShort(team)} BALL`, team, 1.8);
  }

  // ボールが出た地点からのスローイン: 最寄りの味方が最も近い縁(サイド/ベース)の外へ。
  startAt(team: number, ox: number, oz: number,
          opts: { clock?: number; announce?: string | null } = {}): void {
    const g = this.game;
    g.possession = team;
    const overSide = Math.abs(ox) - COURT.halfW;   // 各縁をどれだけ越えたか
    const overEnd = Math.abs(oz) - COURT.halfL;
    let sx: number, sz: number;
    if (overSide >= overEnd) {                     // サイドライン外
      sx = Math.sign(ox || 1) * (COURT.halfW + OOB_OUTSET);
      sz = clamp(oz, -(COURT.halfL - INBOUNDS_INSET), COURT.halfL - INBOUNDS_INSET);
    } else {                                        // エンドライン(ベースライン)外
      sx = clamp(ox, -(COURT.halfW - INBOUNDS_INSET), COURT.halfW - INBOUNDS_INSET);
      sz = Math.sign(oz || 1) * (COURT.halfL + OOB_OUTSET);
    }
    const tp = g.teamPlayers(team);
    const taker = nearestOf(tp, (p) => dist2DTo(g.ball.pos, p.pos.x, p.pos.z))!;
    // ボールはその地点で死ぬ。OOBを告知し、投げ手が地点へ歩く(updatePauseが動かす)まで
    // 再開しない。finishOOB でボールを手に持たせライブへ。
    g.ball.pos.set(sx, 1.2, sz);
    g.ball.vel.set(0, 0, 0);
    g.handler = null;
    g.possession = team;
    this.oobWalker = taker;
    this.oobSpot.set(sx, 0, sz);
    this.oobTeam = team;
    // 再開時のショットクロックを決める: ポゼッション交代=フルリセット、攻撃側維持=partial、
    // リム無し=現状維持。呼び出し側が指定した場合はそれを優先。
    this.oobShotClock = opts.clock ?? (team !== g.looseOff ? SHOT_CLOCK
      : g.looseFromRim ? Math.max(g.shotClock, SHOT_CLOCK_PARTIAL)
      : g.shotClock);
    if (opts.announce !== null) {
      g.setEvent(opts.announce ?? `THROW-IN\n${teamShort(team)} BALL`, team, 2.0);
    }
    g.pauseThen(1.5, () => this.finishOOB());
  }

  // 告知が終わった: 投げ手が地点に着いた — ボールを手に持たせて投げ入れ開始。
  finishOOB(): void {
    const g = this.game;
    const taker = this.oobWalker ?? g.teamPlayers(this.oobTeam)[0];
    taker.pos.set(this.oobSpot.x, 0, this.oobSpot.z);
    g.handler = taker;
    g.lastTouch = taker;
    g.possession = this.oobTeam;
    g.ballMode = "inbound";
    this.t = 0.9;
    g.shotClock = this.oobShotClock;   // フル/partial/継続
    g.resetMotion();
    this.receiver = this.pickReceiver(taker);
    this.oobWalker = null;
  }

  // 味方(可能ならガード)が入れ役に飛び込む — ただしロング投げは深く見て最前の味方へ。
  pickReceiver(taker: Player): Player {
    const g = this.game;
    const tp = g.teamPlayers(taker.team);
    if (taker.has("longThrow")) {
      const sign = g.attackSign(taker.team);
      let deep: Player | null = null;
      for (const p of tp) {
        if (p === taker) continue;
        if (!deep || p.pos.z * sign > deep.pos.z * sign) deep = p;
      }
      // 本当に前方に走っている味方がいる時だけ
      if (deep && (deep.pos.z - taker.pos.z) * sign > 6) return deep;
    }
    // それ以外: フロアで最良のプレイメーカーが入れ役
    return tp.filter((p) => p !== taker)
      .sort((a, b) => b.playmaking - a.playmaking)[0];
  }

  update(dt: number): void {
    const g = this.game;
    const inb = g.handler!;             // インバウンダー(ラインの外に立つ)
    const team = g.possession;
    const spots = g.formationSpots(team);
    const r = this.receiver;

    for (const p of g.teamPlayers(team)) {
      if (p === inb) continue;             // インバウンダーはボールを持って静止
      if (p === r) {
        // インバウンダーへ飛び込んで投げ入れを受けに開く
        moveToward2D(p.pos, inb.pos.x * 0.35, inb.pos.z * 0.55, p.accelSpeed(dt) * dt);
      } else {
        moveToward2D(p.pos, spots[p.spotIdx].x, spots[p.spotIdx].z, p.accelSpeed(dt) * dt);
      }
      g.clampCourt(p.pos);
    }
    runDefenseDuringDeadish(g, dt);

    // ボールはインバウンダーの手で、ラインのすぐ外に待機
    g.ball.pos.set(inb.pos.x, 1.3, inb.pos.z);

    this.t -= dt;
    if (this.t <= 0) g.throwIn(inb);
  }
}
