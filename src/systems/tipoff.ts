// ティップオフ（開幕ジャンプボール）機能。固有状態(進行時間/勝者/タップ先ガード/跳んだか)は
// このクラスが所有。winner/guard は外部(団子回避・ポゼッション矢印)も参照。
import { Player } from "../objects/player/player";
import { chance, rand } from "../util";
import type { Game } from "../game";

export class TipoffSystem {
  winner = 0;          // どちらがティップを制したか（ポゼッション矢印が参照）
  guard!: Player;      // タップ先ガード（chaseLoose の団子回避が参照）
  private t = 0;
  private jumped = false;

  constructor(private game: Game) {}

  // 開幕ジャンプボール: 2人のセンターがサークルで対面、ボールが真上に上げられ、
  // 跳んで勝者がガードへタップする。
  start(): void {
    const g = this.game;
    g.placeFormation();
    const t0 = g.teamPlayers(0), t1 = g.teamPlayers(1);
    // ジャンパー(センター idx4)がセンターサークルで対面
    t0[4].pos.set(0, 0, -0.7);
    t1[4].pos.set(0, 0, 0.7);
    // 各チーム、サークル付近に2人(idx0=タップ先ガード, idx1)、自陣に2人(idx2,3)を
    // セーフティとして下げる。os=自陣(守備側)の符号。
    const os0 = -g.attackSign(0), os1 = -g.attackSign(1);
    t0[0].pos.set(-2.4, 0, os0 * 2.2);  t0[1].pos.set(2.4, 0, os0 * 2.2);
    t1[0].pos.set(-2.4, 0, os1 * 2.2);  t1[1].pos.set(2.4, 0, os1 * 2.2);
    t0[2].pos.set(-4.5, 0, os0 * 9.5);  t0[3].pos.set(4.5, 0, os0 * 9.5);
    t1[2].pos.set(-4.5, 0, os1 * 9.5);  t1[3].pos.set(4.5, 0, os1 * 9.5);
    // フロアの全員を立たせる
    for (const p of g.players) { p.stand(); p.cutting = false; p.offTimer = rand(0.4, 2); p.spotIdx = g.homeSpotIdx(p); }

    this.winner = chance(0.5) ? 0 : 1;
    this.guard = g.teamPlayers(this.winner)[0];
    this.t = 0;
    this.jumped = false;
    g.handler = null;
    g.ballMode = "tipoff";
    g.ball.pos.set(0, 2, 0);
    g.ball.vel.set(0, 0, 0);
    // センターはまだ接地: トスに合わせてジャンプのタイミングを取る
  }

  update(dt: number): void {
    const g = this.game;
    this.t += dt;
    const t = this.t;

    const TOSS_UP = 0.7;   // ボールがピークまで上がる
    const TIP_AT = 1.15;   // ジャンパーの手の届く高さまで落ちてきてタップ
    const START_Y = 2.0, PEAK_Y = 5.0, TIP_Y = 3.6;

    if (t < TOSS_UP) {
      // レフェリーのトス: ボールがピークまで弧を描く(上がるにつれ減速)
      const k = t / TOSS_UP;
      g.ball.pos.set(0, START_Y + (PEAK_Y - START_Y) * Math.sin(k * Math.PI / 2), 0);
      return;
    }

    // ピークで両センターが跳ぶ: 頂点がタップ時刻に合うようタイミング
    if (!this.jumped) {
      this.jumped = true;
      const dur = (TIP_AT - TOSS_UP) * 2; // TIP_AT で頂点
      g.teamPlayers(0)[4].jump(1.0, dur);
      g.teamPlayers(1)[4].jump(1.0, dur);
    }

    if (t < TIP_AT) {
      // ボールがピークから上がってきた手へ落ちる
      const k = (t - TOSS_UP) / (TIP_AT - TOSS_UP);
      g.ball.pos.set(0, PEAK_Y + (TIP_Y - PEAK_Y) * k, 0);
      return;
    }

    // 勝ったセンターがタップ: ボールを自軍ガードへ送りライブへ。誰が確保するかは
    // ルーズボールの争奪で決まる。
    const gp = this.guard.pos;
    const dx = gp.x, dz = gp.z;
    const len = Math.hypot(dx, dz) || 1;
    g.ball.pos.set(0, TIP_Y, 0);
    g.ball.vel.set((dx / len) * 3.6, 1.0, (dz / len) * 3.6);
    g.goLoose(this.winner, 2.6, { tip: true });
    g.setEvent("TIP-OFF", this.winner);
  }
}
