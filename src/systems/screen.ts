// スクリーン（ピック&ロール）機能。攻撃側のスクリーン設定と守備側のカバレッジ(drop/show/switch)を扱う。
// カバレッジ状態(cov/screenerDef/handlerDef)は runDefense からも読まれるため public。
import { Vector3 } from "@babylonjs/core";
import { Player } from "../objects/player/player";
import { TACTICS } from "../attributes";
import { rate, clamp, chance, rand, dist2D, dist2DTo, moveToward2D } from "../util";
import { defEffort, defendOnBall } from "../ai/defense";
import { bestOpenSpot } from "../ai/offball";
import type { Game } from "../game";

export class ScreenSystem {
  cov: "" | "drop" | "show" | "switch" = "";   // カバレッジ種別（runDefense が参照）
  screenerDef: Player | null = null;           // スクリーナーの守備者（runDefense が参照）
  handlerDef: Player | null = null;            // ハンドラーの守備者（runDefense が参照）
  private t = 0;                                // カバレッジ窓の残り秒
  private screener: Player | null = null;      // ローラー

  constructor(private game: Game) {}

  // チーム内でスクリーン中の人数
  countScreening(team: number): number {
    let n = 0;
    for (const p of this.game.teamPlayers(team)) if (p.screening) n++;
    return n;
  }

  // ハンドラーがスクリーンで助かる程度に密着で守られているか
  handlerPressured(): boolean {
    const h = this.game.handler;
    if (!h) return false;
    const d = this.game.onBallDefender(h);
    return !!d && dist2D(d.pos, h.pos) < 1.7;
  }

  // ピックを掛けに来られる近さの味方か
  goodScreener(p: Player): boolean {
    const h = this.game.handler;
    return !!h && dist2D(p.pos, h.pos) < 7.5;
  }

  // ボールスクリーン開始。オンボール守備がシェードしている逆側でハンドラーを解放し、
  // ハンドラーはその側を攻めると決める。
  start(p: Player): void {
    const g = this.game;
    const h = g.handler!;
    const d = g.onBallDefender(h);
    p.screening = true;
    p.cutting = false;
    p.screenT = rand(1.2, 2.0);
    p.screenSide = d ? -d.shadeSide : (chance(0.5) ? 1 : -1);
    h.driveSide = p.screenSide;
  }

  // 選んだ側でハンドラーの横のピックへ入る。繋がればハンドラーは角を曲がり、スクリーナーは
  // リムへロール。使われなかったピックは失効しポップアウト。
  update(dt: number, p: Player): void {
    const g = this.game;
    const h = g.handler;
    p.screenT -= dt;
    const d = h ? g.onBallDefender(h) : undefined;
    if (!h || !d) { this.endScreen(p, false); return; }

    const rim = g.attackFloor(p.team);
    const dx = rim.x - h.pos.x, dz = rim.z - h.pos.z;
    const len = Math.hypot(dx, dz) || 1;
    const fx = dx / len, fz = dz / len;                 // ハンドラー→リム
    const lx = -fz * p.screenSide, lz = fx * p.screenSide;
    // 攻める側でハンドラーの一歩前 — 守備の進路上
    const tx = h.pos.x + fx * 0.5 + lx * 0.9;
    const tz = h.pos.z + fz * 0.5 + lz * 0.9;
    moveToward2D(p.pos, tx, tz, p.accelSpeed(dt) * dt);

    const set = dist2DTo(p.pos, tx, tz) < 0.5;
    if (set && dist2D(p.pos, d.pos) < 0.95) {
      // ピックが繋がる — 守備のカバレッジを決め、ハンドラーの結末がそれに従う
      this.resolveCoverage(h, p, d);
      this.endScreen(p, true);                          // スクリーナーはロール
      return;
    }
    if (p.screenT <= 0) this.endScreen(p, false);       // 未使用のピック — ポップアウト
  }

  // カバレッジを選び、ピックが繋がった瞬間に呼ばれる。カバレッジ窓(t)を張り、runDefense が
  // それを読んで両守備者を動かす。攻撃側には対応する結果を適用。
  private resolveCoverage(handler: Player, screener: Player, hDef: Player): void {
    const g = this.game;
    const defTeam = 1 - handler.team;
    const sDef = g.teamPlayers(defTeam)[screener.slot];
    const cov = this.chooseCoverage(hDef, sDef);
    this.cov = cov;
    this.t = 1.3;
    this.handlerDef = hDef;
    this.screenerDef = sDef;
    this.screener = screener;
    handler.decisionT = Math.max(handler.decisionT, 0.2);
    g.setDriveSide(handler);
    if (cov === "drop") {
      // ドロップ: ビッグが下がってリムを守る。ハンドラーはプルアップの一歩を得る
      handler.beatenT = Math.max(handler.beatenT, rand(0.18, 0.32));
      hDef.reactT = Math.max(hDef.reactT, 0.35);   // ハンドラーの守備者は上を追う
    } else if (cov === "show") {
      // ショー: ビッグが飛び出してボールを止める。スクリーナーは空きへロール
      handler.stalledT = Math.max(handler.stalledT, rand(0.35, 0.55));
      hDef.reactT = Math.max(hDef.reactT, 0.45);
      screener.openRollT = 0.9;
    } else {
      // スイッチ: マークを入れ替える。ハンドラーはミスマッチを攻め、ローラーもレーンを得る
      const agiGap = rate(handler.attr.agility) - rate(sDef.attr.agility);
      handler.beatenT = Math.max(handler.beatenT, clamp(agiGap, 0, 0.45) * 1.3);
      hDef.reactT = Math.max(hDef.reactT, 0.3);
      if (screener.height - hDef.height > 0.06) screener.openRollT = 0.7;   // ロールのサイズミスマッチ
    }
  }

  // スクリーナーの守備者がどのカバレッジを取るか(重み付き抽選): 遅いビッグはドロップ、
  // 攻撃的/速いビッグはショー、同格ならスイッチ。
  private chooseCoverage(hDef: Player, sDef: Player): "drop" | "show" | "switch" {
    const g = this.game;
    const press = TACTICS[sDef.team].defense.pressure;
    const sAgi = rate(sDef.attr.agility);
    // 遅いビッグは速いガードに出られない — ドロップ
    const wDrop = (g.isBig(sDef) ? 0.5 : 0.2) + (1 - sAgi) * 0.7 + (1 - press) * 0.3;
    // 攻撃的で速い守備はヘッジ/ショーでハンドラーを乱す
    const wShow = 0.15 + press * 0.7 + sAgi * 0.25;
    // サイズが近い時はスイッチ(大きな差=悪いスイッチは避ける)
    const sizeGap = Math.abs(sDef.height - hDef.height);
    const wSwitch = 0.15 + sAgi * 0.4 + clamp(1 - sizeGap * 2.5, 0, 1) * 0.5
      + (g.teamHas(sDef.team, "manMark") ? 0.15 : 0);   // ロックダウン型は自信を持ってスイッチ
    const total = wDrop + wShow + wSwitch;
    let r = rand(0, total);
    if ((r -= wDrop) < 0) return "drop";
    if ((r -= wShow) < 0) return "show";
    return "switch";
  }

  // カバレッジ窓のカウントダウン（runDefense が毎フレーム呼ぶ）。
  tickCoverage(dt: number): void {
    if (this.t > 0) {
      this.t -= dt;
      if (this.t <= 0) this.cov = "";
    }
  }

  // 選んだカバレッジで、ボールスクリーンの2守備者を窓の間動かす。
  defend(dt: number, d: Player, protect: Vector3): void {
    const g = this.game;
    const h = g.handler;
    const screener = this.screener;
    if (!h || !screener) return;
    const effort = defEffort(g, d, protect);
    if (d === this.screenerDef) {
      if (this.cov === "drop") {
        // ドロップ: ボールとリムの間で深くサグる
        const tx = h.pos.x + (protect.x - h.pos.x) * 0.62;
        const tz = h.pos.z + (protect.z - h.pos.z) * 0.62;
        moveToward2D(d.pos, tx, tz, d.accelToward(dt, tx, tz, 1.05 * effort) * dt);
      } else if (this.cov === "show") {
        // 早くボールへ強くヘッジし、その後ローラーへ戻る
        const early = this.t > 0.75;
        const t = early ? h : screener;
        const gx = t.pos.x + (protect.x - t.pos.x) * 0.35;
        const gz = t.pos.z + (protect.z - t.pos.z) * 0.35;
        moveToward2D(d.pos, gx, gz, d.accelToward(dt, gx, gz, 1.15 * effort) * dt);
      } else {
        defendOnBall(g, dt, d, h, protect);   // スイッチ: 彼が今ボールを守る
      }
    } else {   // d === this.handlerDef
      if (this.cov === "switch") {
        // ローラーをゴールサイドでピックアップ
        const gx = screener.pos.x + (protect.x - screener.pos.x) * 0.3;
        const gz = screener.pos.z + (protect.z - screener.pos.z) * 0.3;
        moveToward2D(d.pos, gx, gz, d.accelToward(dt, gx, gz, 1.1 * effort) * dt);
      } else {
        // ドロップ/ショー: ピックの上を追ってハンドラーへ復帰
        const gx = h.pos.x + (protect.x - h.pos.x) * 0.2;
        const gz = h.pos.z + (protect.z - h.pos.z) * 0.2;
        moveToward2D(d.pos, gx, gz, d.accelToward(dt, gx, gz, 1.12 * effort) * dt);
      }
    }
    g.clampCourt(d.pos);
  }

  private endScreen(p: Player, connected: boolean): void {
    const g = this.game;
    p.screening = false;
    p.screenT = 0;
    if (!connected) {
      p.spotIdx = bestOpenSpot(g, p.team, g.formationSpots(p.team), p);
      return;
    }
    const rim = g.attackFloor(p.team);
    // ピック&ポップ vs ロール: シューターはアークへポップ、それ以外はリムへロール
    const canPop = rate(p.attr.threeAcc) > 0.68 || p.has("range") || p.evalRole === "ストレッチ";
    p.cutting = true;
    p.offTimer = rand(1.5, 2.5);
    if (canPop && chance(0.6)) {
      const dir = -g.attackSign(p.team);              // ミッドコート方向
      const px = clamp(p.pos.x + p.screenSide * 1.5, -6.5, 6.5);
      p.offTarget.set(px, 0, rim.z + dir * 7.2);       // 3Pレンジへ
      p.openRollT = 2.0;                               // ポップアウト移動中もフィード対象
    } else {
      p.offTarget.set(rim.x + rand(-0.6, 0.6), 0, rim.z - Math.sign(rim.z) * 0.4);   // リムへロール
    }
  }

  // ポゼッションが変わればライブのピック&ロールカバレッジは終了。
  clear(): void {
    this.cov = "";
    this.t = 0;
    this.handlerDef = this.screenerDef = this.screener = null;
  }
}
