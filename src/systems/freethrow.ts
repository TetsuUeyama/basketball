// フリースロー機能（方式A: Game 参照を受け取るサブシステム）。FT 固有の状態はこの
// クラスが所有し、共有状態・フロー(得点/インバウンド/交代/リバウンド)は game 経由で
// 呼ぶ。game.ts から分離（workPlan.md 参照）。
import { Vector3 } from "@babylonjs/core";
import { Player } from "../player";
import { COURT, RIM } from "../config";
import { rate } from "../attributes";
import { clamp, chance, rand, dist2D } from "../util";
import { swishNet } from "../core/visuals";
import { benchCheer } from "../core/bench";
import type { Game } from "../game";

export class FreeThrowSystem {
  shooter!: Player;
  remaining = 0;
  team = 0;
  t = 0;                 // poseHands が参照（構え中に手をボールへ伸ばす）
  made = false;
  private target = new Vector3();
  private missKind: "make" | "rimOut" | "air" = "make";

  constructor(private game: Game) {}

  start(shooter: Player, count: number): void {
    const g = this.game;
    g.handler = null;
    g.possession = shooter.team;
    this.team = shooter.team;
    this.shooter = shooter;
    this.remaining = count;
    g.ballMode = "freethrow";

    const sign = g.attackSign(shooter.team);
    const ftZ = sign * (COURT.halfL - 5.8); // 攻めるゴールのフリースローライン
    shooter.pos.set(0, 0, ftZ);
    this.lineUp(shooter, sign);
    this.beginAttempt();
  }

  // シューター以外をレーン脇/トップに並べる。
  private lineUp(shooter: Player, sign: number): void {
    const slots: number[][] = [
      [-2.4, 1.0], [2.4, 1.0], [-2.4, 2.4], [2.4, 2.4], [-2.4, 3.8], [2.4, 3.8],
      [-5.0, 1.5], [5.0, 1.5], [0, 8.5],
    ]; // [x, ベースラインから内側への距離]
    let i = 0;
    for (const p of this.game.players) {
      if (p === shooter) continue;
      const s = slots[i % slots.length];
      p.pos.set(s[0], 0, sign * (COURT.halfL - s[1]));
      p.cutting = false;
      i++;
    }
  }

  private beginAttempt(): void {
    const g = this.game;
    this.t = 0;
    g.ballFalling = false;
    // FK精度、弱い精神なら疲労/スコアで揺れる。PKキッカーはルーティンが染み付く。
    const p = 0.5 + rate(this.shooter.attr.freeThrow) * 0.45
      + (this.shooter.has("ftKicker") ? 0.08 : 0)
      - g.clutchFactor(this.shooter) * 0.15;
    this.made = chance(clamp(p, 0.3, 0.97));
    g.ball.pos.set(this.shooter.pos.x, 1.2, this.shooter.pos.z);

    // 結果からどこへ飛ぶか決め、軌道で物語る
    const rim = g.attackRim(this.team);
    const sh = this.shooter.pos;
    if (this.made) {
      this.missKind = "make";
      this.target.copyFrom(rim);                 // ど真ん中 → 吸い込まれる
      return;
    }
    // エアボールは本当に下手な選手のみ(稀)。それ以外はリムアウト。
    const ftr = rate(this.shooter.attr.freeThrow);
    const airP = Math.max(0, (0.32 - ftr) / 0.32) * 0.12;   // ~0.32超で0、どん底で最大~12%
    if (chance(airP)) {
      this.missKind = "air";
      // 届かず手前で失速: ~82%地点、リムより十分低く
      this.target.set(sh.x + (rim.x - sh.x) * 0.82, RIM.height - 0.7, sh.z + (rim.z - sh.z) * 0.82);
      return;
    }
    // リムアウト: リムの縁(主に前後、時々横)を狙い、ど真ん中に来てから跳ねるのでなく
    // 目に見えてリングに当てる
    this.missKind = "rimOut";
    let ux = sh.x - rim.x, uz = sh.z - rim.z;      // シューター方向(前リム方向)の単位
    const ul = Math.hypot(ux, uz) || 1; ux /= ul; uz /= ul;
    const px = -uz, pz = ux;                        // 横方向
    const along = rand(-1, 1);                      // + 前リム(短い) .. − 後リム(長い)
    const side = rand(-0.6, 0.6);
    let ex = ux * along + px * side, ez = uz * along + pz * side;
    const el = Math.hypot(ex, ez) || 1; ex /= el; ez /= el;
    this.target.set(rim.x + ex * RIM.radius, RIM.height + 0.02, rim.z + ez * RIM.radius);
  }

  update(dt: number): void {
    const g = this.game;
    this.t += dt;
    const setup = 0.6, shotDur = 0.8;

    if (this.t < setup) {
      // シューターがラインでボールを構える
      g.ball.pos.set(this.shooter.pos.x, 1.2, this.shooter.pos.z);
      return;
    }
    if (this.t < setup + shotDur) {
      const k = (this.t - setup) / shotDur;
      const a = this.shooter.pos, b = this.target;   // リム中心 / リム縁 / 手前
      const baseY = 2.0 + (b.y - 2.0) * k;
      // 弾道高さ: FTのアーチも評価で上がる(ノーコンテストなので見た目)。エアボールは
      // 弱くフラットで目に見えて手前に失速(低いアーチで届かない)。
      const ftArc = 1.2 + rate(this.shooter.attr.bank) * 1.2;
      const arc = this.missKind === "air" ? ftArc * 0.55 : ftArc;
      g.ball.pos.set(a.x + (b.x - a.x) * k, baseY + Math.sin(k * Math.PI) * arc, a.z + (b.z - a.z) * k);
      return;
    }
    this.resolve();
  }

  private resolve(): void {
    const g = this.game;
    this.shooter.stats.fta++;
    const wasLast = this.remaining <= 1;
    if (this.made) {
      g.score[this.team] += 1;
      this.shooter.stats.pts += 1;
      this.shooter.stats.ftm++;
      benchCheer(g, this.team, 1.2);   // FTは素早めのポップ
      swishNet(g, this.team);          // メイクでネットが弾ける
    }
    this.remaining -= 1;
    if (!wasLast) { this.beginAttempt(); return; }

    // 最後のFTが解決
    if (this.made) {
      // ボールがネットを抜けてホールド中に床で弾む
      const rim = g.attackRim(this.team);
      g.ball.pos.set(rim.x, RIM.height - 0.15, rim.z);
      g.ball.vel.set(rand(-0.4, 0.4), -2.4, -Math.sign(rim.z || 1) * rand(0.2, 0.7));
      g.ballFalling = true;
      const conceding = 1 - this.team;
      g.setEvent("GOOD", this.team);
      g.handler = null;
      g.pauseThen(1.1, () => g.withSubs(() => g.inbound.start(conceding)));
    } else {
      g.possession = this.team;       // ミス: ライブリバウンド
      g.setEvent(this.missKind === "air" ? "AIR BALL" : "MISS", this.team);
      this.startRebound();
    }
  }

  // 外したFTはライブボールになり、最初のバウンドが外し方に対応: リムアウトはリングに
  // 当たって弾き、エアボールは手前に落ちる。その後は通常の競り合いリバウンド。
  private startRebound(): void {
    const g = this.game;
    const rim = g.attackRim(this.team);
    const rimFloor = g.attackFloor(this.team);
    if (this.missKind === "air") {
      // リングに届かず — その場から手前へ落とす(リム接触なし → 14秒リセット無し fromRim:false)
      g.ball.vel.set(rand(-0.6, 0.6), 0.2, -Math.sign(rim.z || 1) * rand(0.3, 0.9));
      g.goLoose(this.team, 2.6, { rebound: true, fromRim: false });
    } else {
      // リムアウト: 届いた縁から弾く — 中心から上＆外へ
      let ox = g.ball.pos.x - rim.x, oz = g.ball.pos.z - rim.z;
      const ol = Math.hypot(ox, oz) || 1; ox /= ol; oz /= ol;
      g.ball.pos.set(rim.x + ox * RIM.radius, RIM.height + 0.06, rim.z + oz * RIM.radius);
      g.ball.vel.set(ox * rand(2.2, 3.8) + rand(-0.8, 0.8), rand(1.3, 2.8), oz * rand(2.2, 3.8) + rand(-0.6, 0.6));
      g.goLoose(this.team, 2.6, { rebound: true, fromRim: true });
    }
    // ビッグ(とリム至近の全員)がボードを取りに跳ぶ
    for (const p of g.players) {
      const d = dist2D(p.pos, rimFloor);
      if (d < 2.8 && (g.isBig(p) || d < 1.4)) p.jump(g.isBig(p) ? 0.7 : 0.5, 0.6);
    }
  }
}
