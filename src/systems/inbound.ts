// スローイン/インバウンド機能。固有状態(残り時間/受け手/OOB歩行者と地点)はこのクラスが所有。
// 実際の投げ入れ(throwIn)は Game 側に残し、update() から呼ぶ。
import { Vector3 } from "@babylonjs/core";
import { Player } from "../objects/player/player";
import { COURT, RIM, SHOT_CLOCK, SHOT_CLOCK_PARTIAL, OOB_OUTSET, INBOUNDS_INSET, teamShort } from "../config";
import { clamp, rand, dist2DTo, moveToward2D, nearestOf } from "../util";
import { runDefenseDuringDeadish } from "../ai/defense";
import type { Game } from "../game";

export class InboundSystem {
  t = 0;                            // 投げ入れまでの残り時間(審判不在時のフォールバック)
  private threw = false;             // 審判がスローワーへ投げ始めたか
  private throwT = 0;                // 審判→スローワーの投げ渡しの残り時間
  private throwDur = 0.55;           // 投げ渡しの所要時間(P速度で決まる)
  private passOffX = 0;              // パスの着弾ぶれ(P精度で決まる)
  private passOffZ = 0;
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
    // ハンドリングの高くないビッグが投げ手なら、投げたらフロントコートへ抜けさせる
    // （ガードが降りて組み立て、ビッグがバックコートでトラップされるのを避ける）。
    if (g.isBig(taker) && taker.evalRole !== "プレイメイキングビッグ") taker.frontRunT = 8;
    // 得点後などボールはコート上(リム下)にある: 近くの選手が審判へ投げ、審判がスローワーへ投げ渡す。
    this.refRelay(taker);
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
    // 集球演出: OOBなら審判が拾いに行き、コート内なら最寄りの選手が審判へ投げる。
    const oob = Math.abs(ox) > COURT.halfW + 0.1 || Math.abs(oz) > COURT.halfL + 0.1;
    g.referees.acquireBall(ox, oz, sx, sz, oob ? "retrieve" : "auto");
    g.pauseThen(oob ? 2.6 : 2.0, () => this.finishOOB());
  }

  // 既に審判がボールを持っている状態(クオーター開始等)からの投げ渡しを準備する。
  // taker がスローイン地点に着いていること前提。審判が taker へ投げ渡す。
  // コート上のボールを 選手→審判→スローワー で投げ渡す(得点後/ファウル等)。taker は地点に立つ。
  refRelay(taker: Player): void {
    this.threw = false;
    // ボール地点の近くに選手がいれば「選手→審判へ投げ渡し」、いなければ「審判が拾いに行く」を
    // 自動判定(acquireBall 内)。集球完了後、審判がスローワーへ投げ渡す(update)。
    this.game.referees.acquireBall(this.game.ball.pos.x, this.game.ball.pos.z, taker.pos.x, taker.pos.z, "throw");
  }

  beginRefThrow(taker: Player): void {
    this.threw = false;   // 審判は既にボールを保持済み → update が投げ渡す
    this.game.referees.inboundSetup(taker.pos.x, taker.pos.z);
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
    if (g.isBig(taker) && taker.evalRole !== "プレイメイキングビッグ") taker.frontRunT = 8;
    this.threw = false;   // 集球(拾う/選手が投げる)は pause 中に済み → update が投げ渡す
    g.referees.inboundSetup(taker.pos.x, taker.pos.z);
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

    // 再開の演出: 集球中(選手が審判へ投げる/審判が拾いに行く)は referees が管理。集球完了後、
    // 審判がスローワーへ投げ渡してから投げ入れる。
    const refs = g.referees;
    const ref = refs.onBallRef;
    if (refs.acqActive) {
      return;   // 集球中: ボールは updateAcq が管理。まだ投げ入れない。
    }
    if (ref) {
      if (ref.frozen && !this.threw) { g.ball.pos.copyFrom(ref.ballHold()); return; }   // キャッチ硬直中は待つ
      // 集球完了 → 審判がスローワーへパスモーションで投げ渡す。P速度で速さ、P精度で着弾ぶれ。
      if (!this.threw) {
        this.threw = true; ref.signal("pass", 0.6);
        const acc = 1 - ref.body.attr.passAcc / 100;   // P精度50 → 0.5
        this.passOffX = rand(-1, 1) * acc * 0.6; this.passOffZ = rand(-1, 1) * acc * 0.6;
        this.throwDur = 0.4 + (1 - ref.body.attr.passSpd / 100) * 0.4;   // P速度50 → 0.6秒
        this.throwT = this.throwDur;
      }
      this.throwT -= dt;
      const k = clamp(1 - this.throwT / this.throwDur, 0, 1);
      const h = ref.ballHold();
      const tx = inb.pos.x + this.passOffX, tz = inb.pos.z + this.passOffZ;
      g.ball.pos.set(h.x + (tx - h.x) * k, h.y + (1.3 - h.y) * k + 0.9 * Math.sin(k * Math.PI), h.z + (tz - h.z) * k);
      if (this.throwT <= 0) { refs.inboundDone(); g.throwIn(inb); }
    } else {
      g.ball.pos.set(inb.pos.x, 1.3, inb.pos.z);  // 審判不在時はスローワーの手に
      this.t -= dt;
      if (this.t <= 0) g.throwIn(inb);
    }
  }
}
