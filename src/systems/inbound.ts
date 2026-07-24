// スローイン/インバウンド機能。方式A: Game 参照を受け取るサブシステム。固有状態
// (投げ入れ残り時間/受け手/OOB歩行者と地点)はこのクラスが所有。実際の投げ入れ(throwIn)
// はパス飛行の内部機構を使うため Game 側に残し、update() から this.game.throwIn を呼ぶ。
// t/receiver/oobWalker/oobSpot は外部(クォーター開始・サイドイン・reset・updatePause)も参照。
import { Vector3 } from "@babylonjs/core";
import { Player } from "../player";
import { COURT, RIM, SHOT_CLOCK, SHOT_CLOCK_PARTIAL, teamShort } from "../config";
import { clamp, rand, dist2DTo, moveToward2D } from "../util";
import { runDefenseDuringDeadish } from "../action/defense";
import type { Game } from "../game";

export class InboundSystem {
  t = 0;                            // 投げ入れまでの残り時間（旧 inboundT）
  receiver: Player | null = null;   // 受け手（旧 inboundReceiver）
  oobWalker: Player | null = null;  // OOB地点へ歩く投げ手（updatePause が動かす）
  oobSpot = new Vector3();
  private oobTeam = 0;
  private oobShotClock = 0;          // 投げ入れ時に戻すショットクロック(笛の時点で決定)

  constructor(private game: Game) {}

  // ゴール成功後のスローイン: 相手が決めたので、そのベースライン後方から入れる。
  start(team: number): void {
    const g = this.game;
    g.possession = team;
    const scorer = 1 - team;
    const sign = g.attackSign(scorer);
    const baselineZ = sign * RIM.z;
    const tp = g.teamPlayers(team);
    let taker = tp[0];
    for (const p of tp) {
      if (Math.abs(p.pos.z - baselineZ) < Math.abs(taker.pos.z - baselineZ)) taker = p;
    }
    taker.pos.set(rand(-2, 2), 0, sign * (COURT.halfL + 0.3)); // エンドライン後方
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
      sx = Math.sign(ox || 1) * (COURT.halfW + 0.3);
      sz = clamp(oz, -(COURT.halfL - 1), COURT.halfL - 1);
    } else {                                        // エンドライン(ベースライン)外
      sx = clamp(ox, -(COURT.halfW - 1), COURT.halfW - 1);
      sz = Math.sign(oz || 1) * (COURT.halfL + 0.3);
    }
    const tp = g.teamPlayers(team);
    let taker = tp[0];
    for (const p of tp) {
      if (dist2DTo(g.ball.pos, p.pos.x, p.pos.z) < dist2DTo(g.ball.pos, taker.pos.x, taker.pos.z)) taker = p;
    }
    // ボールはその地点で死ぬ。OOBを告知し、投げ手が地点へ歩く(updatePauseが動かす)まで
    // 再開しない。finishOOB でボールを手に持たせライブへ。
    g.ball.pos.set(sx, 1.2, sz);
    g.ball.vel.set(0, 0, 0);
    g.handler = null;
    g.possession = team;
    this.oobWalker = taker;
    this.oobSpot.set(sx, 0, sz);
    this.oobTeam = team;
    // 再開時のショットクロックを今決める(デッドボール中は止まる): ポゼッション交代は
    // フルリセット、リムからの攻撃側維持は partial、ブロック/スティール(リム無し)は現状維持。
    // …呼び出し側がクロックを既に指定した場合(ショットクロック違反等)はそれを優先。
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
    g.shotClock = this.oobShotClock;   // フル/partial/継続 — 笛の時点で決定済み
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
