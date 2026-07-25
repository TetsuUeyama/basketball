// スクリーン（ピック&ロール）への守備リアクション: カバレッジ選択(drop/show/switch)、
// 成立時の効果適用、窓のカウントダウン、2守備者の動き。共有状態(ScreenState)は Game が保持。
import { Vector3 } from "@babylonjs/core";
import { Player } from "../../objects/player/player";
import { TACTICS } from "../../attributes";
import { rate, clamp, rand, moveToward2D } from "../../util";
import { defEffort, defendOnBall } from "../../ai/defense";
import type { Game } from "../../game";

// スクリーンの共有状態。resolveScreenCoverage が書き、runDefense/defendScreen が読む。
export class ScreenState {
  cov: "" | "drop" | "show" | "switch" = "";   // カバレッジ種別
  t = 0;                                         // カバレッジ窓の残り秒
  screener: Player | null = null;               // ローラー
  screenerDef: Player | null = null;            // スクリーナーの守備者
  handlerDef: Player | null = null;             // ハンドラーの守備者

  // ポゼッションが変わればライブのカバレッジは終了。
  clear(): void {
    this.cov = "";
    this.t = 0;
    this.handlerDef = this.screenerDef = this.screener = null;
  }
}

// カバレッジを選び、ピック成立時に効果を適用。runDefense が cov/t を読んで両守備者を動かす。
export function resolveScreenCoverage(game: Game, handler: Player, screener: Player, hDef: Player): void {
  const st = game.screen;
  const defTeam = 1 - handler.team;
  const sDef = game.teamPlayers(defTeam)[screener.slot];
  const cov = chooseCoverage(game, hDef, sDef);
  st.cov = cov;
  st.t = 1.3;
  st.handlerDef = hDef;
  st.screenerDef = sDef;
  st.screener = screener;
  handler.decisionT = Math.max(handler.decisionT, 0.2);
  game.setDriveSide(handler);
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
function chooseCoverage(game: Game, hDef: Player, sDef: Player): "drop" | "show" | "switch" {
  const press = TACTICS[sDef.team].defense.pressure;
  const sAgi = rate(sDef.attr.agility);
  const wDrop = (game.isBig(sDef) ? 0.5 : 0.2) + (1 - sAgi) * 0.7 + (1 - press) * 0.3;
  const wShow = 0.15 + press * 0.7 + sAgi * 0.25;
  const sizeGap = Math.abs(sDef.height - hDef.height);
  const wSwitch = 0.15 + sAgi * 0.4 + clamp(1 - sizeGap * 2.5, 0, 1) * 0.5
    + (game.teamHas(sDef.team, "manMark") ? 0.15 : 0);   // ロックダウン型は自信を持ってスイッチ
  const total = wDrop + wShow + wSwitch;
  let r = rand(0, total);
  if ((r -= wDrop) < 0) return "drop";
  if ((r -= wShow) < 0) return "show";
  return "switch";
}

// カバレッジ窓のカウントダウン（runDefense が毎フレーム呼ぶ）。
export function tickScreenCoverage(game: Game, dt: number): void {
  const st = game.screen;
  if (st.t > 0) {
    st.t -= dt;
    if (st.t <= 0) st.cov = "";
  }
}

// 選んだカバレッジで、ボールスクリーンの2守備者を窓の間動かす。
export function defendScreen(game: Game, dt: number, d: Player, protect: Vector3): void {
  const st = game.screen;
  const h = game.handler;
  const screener = st.screener;
  if (!h || !screener) return;
  const effort = defEffort(game, d, protect);
  if (d === st.screenerDef) {
    if (st.cov === "drop") {
      // ドロップ: ボールとリムの間で深くサグる
      const tx = h.pos.x + (protect.x - h.pos.x) * 0.62;
      const tz = h.pos.z + (protect.z - h.pos.z) * 0.62;
      moveToward2D(d.pos, tx, tz, d.accelToward(dt, tx, tz, 1.05 * effort) * dt);
    } else if (st.cov === "show") {
      // 早くボールへ強くヘッジし、その後ローラーへ戻る
      const early = st.t > 0.75;
      const t = early ? h : screener;
      const gx = t.pos.x + (protect.x - t.pos.x) * 0.35;
      const gz = t.pos.z + (protect.z - t.pos.z) * 0.35;
      moveToward2D(d.pos, gx, gz, d.accelToward(dt, gx, gz, 1.15 * effort) * dt);
    } else {
      defendOnBall(game, dt, d, h, protect);   // スイッチ: 彼が今ボールを守る
    }
  } else {   // d === st.handlerDef
    if (st.cov === "switch") {
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
  game.clampCourt(d.pos);
}
