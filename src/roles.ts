// 選手のロール定義と、それに紐づく評価ロジック（オフェンス/守備アイデンティティ）。
// - ROLE_BEHAVIOR / OFF_ROLE_ACTION / DEF_ROLE_BEHAVIOR: 評価ロール→仮想特能・行動・守備エフォート
// - offActionOf / roleOffense / usageFromRank / scoringPower / computeOffPriority: 使用率・優先度・得点力の算出
// attributes へは型参照のみ（循環回避）。
import { clamp, rate } from "./util";
import type { AbilityKey, Attributes, PlayerDef } from "./attributes";
// ---------------------------------------------------------------------------
// 評価ロール → 試合中の挙動 (keys = UI の EVAL_ROLES と同じ日本語名)。
// `ab` はロールが付与する仮想特能、`pri` は攻撃優先度への加算、`pm` はプレイメイキング加算。
// ---------------------------------------------------------------------------
export const ROLE_BEHAVIOR: Record<string, { ab?: AbilityKey[]; pri?: number; pm?: number }> = {
  メインハンドラー:      { ab: ["keepDribble"], pm: 0.5 },               // ボール運び役を奪う(PG基準1.0超え)
  セカンドハンドラー:    { pm: 0.2 },                                    // 第2の組み立て役
  フロアジェネラル:      { ab: ["general"], pm: 0.45 },                  // チーム全体の動きを速く正確に
  スラッシャー:          { ab: ["driver"], pri: 0.06 },                  // ドライブを積極的に選ぶ
  エース:                { ab: ["striker", "isoShooter"], pri: 0.18 },   // 第1オプション化+単独で打ち切る
  スポットアップ:        { ab: ["oneTouch"], pri: 0.02 },                // キャッチ&シュート特化
  "3&D":                 { ab: ["oneTouch", "manMark"], pri: -0.06 },    // C&S+タイトなマンマーク
  ポイントフォワード:    { pm: 0.3 },                                    // FWがボールを運ぶ
  ストレッチ:            { ab: ["range", "sideSpot"], pri: 0.02 },       // 射程延長+外に張る(ポスト常駐しない)
  リムプロテクター:      { ab: ["covering"], pri: -0.1 },                // 抜かれた味方のカバーへ先回り
  リムランナー:          { ab: ["leakOut"], pri: -0.04 },                // 攻守交替で真っ先に走る
  スクリーナー:          { pri: -0.12 },                                 // スクリーン頻度はgame.ts側で加算
  プレイメイキングビッグ: { ab: ["throughPass"], pm: 0.35 },              // ビッグがラストパスを配る
  リバウンダー:          { ab: ["centerSpot"], pri: -0.12 },             // ペイント常駐+ビッグ同様に板へ突入
  フロアスペーサー:      { ab: ["sideSpot", "oneTouch"], pri: -0.04 },   // コーナーに張ってC&S
  オフボールカッター:    { ab: ["lineMove"], pri: -0.02 },               // カットが速く頻度も上がる
  ロックダウン:          { ab: ["manMark"], pri: -0.1 },                 // 常時全力マーク(省エネ免除)
  スイッチディフェンダー: { ab: ["covering", "manMark"], pri: -0.08 },    // カバー+マーク両立(省エネ免除)
  エナジーガイ:          { ab: ["interceptor"], pri: -0.08 },            // リーチイン/飛び出し+常時全力
};

// ---------------------------------------------------------------------------
// オフェンスロール → ボールが手に渡った時の“行動プロファイル”。game.ts の decide() が読む。
//   score     … 自分で打ち切る/iso（エース）
//   slash     … ドリブルでリムへアタック（スラッシャー）
//   distribute… まず配球。明確に空いた時だけ打つ（ハンドラー/フロアジェネラル/PF）
//   postHub   … ポスト/ハイポストから配る（プレイメイキングビッグ）
//   spot      … キャッチ&シュート。無理なドリブルはしない（スポット/ストレッチ等）
//   cut/run   … 合わせ/リムラン。空けば決める、無ければ移動
//   screen    … スクリーン主。貰っても捌く
//   rebound   … ペイント/板。貰ってもゴール下フィニッシュか捌くのみ
//   balanced  … 強いロール補正なし＝従来の属性ドリブンな判断
// ---------------------------------------------------------------------------
export type OffAction =
  | "score" | "slash" | "distribute" | "postHub" | "postScore"
  | "spot" | "cut" | "run" | "screen" | "rebound" | "balanced";

export const OFF_ROLE_ACTION: Record<string, OffAction> = {
  メインハンドラー: "distribute", セカンドハンドラー: "distribute",
  フロアジェネラル: "distribute", ポイントフォワード: "distribute",
  スラッシャー: "slash", エース: "score",
  スポットアップ: "spot", "3&D": "spot", ストレッチ: "spot", フロアスペーサー: "spot",
  オフボールカッター: "cut", リムランナー: "run",
  スクリーナー: "screen", プレイメイキングビッグ: "postHub",
  リバウンダー: "rebound", リムプロテクター: "rebound",
  ロックダウン: "balanced", スイッチディフェンダー: "balanced", エナジーガイ: "balanced",
};
export function offActionOf(role: string | undefined): OffAction {
  return (role && OFF_ROLE_ACTION[role]) || "balanced";
}

// ---------------------------------------------------------------------------
// ディフェンスロール → 守備時の仮想特能とエフォート・ギア。オフェンスロールと独立。
// `effort`(0..1) は守備の“出力”＝どれだけ全力で守るか。低いほどスタミナ消費が少ない。
// `lockEffort` はクラッチ以外でも常に全力(effort 1.0)。
// ---------------------------------------------------------------------------
export const DEF_ROLE_BEHAVIOR: Record<string, { ab?: AbilityKey[]; effort: number; lockEffort?: boolean }> = {
  ロックダウン:          { ab: ["manMark"], effort: 1.0, lockEffort: true },
  スイッチディフェンダー: { ab: ["covering", "manMark"], effort: 1.0, lockEffort: true },
  パスカット:            { ab: ["interceptor"], effort: 1.0, lockEffort: true },
  リムプロテクター:      { ab: ["covering"], effort: 1.0 },
  ヘルプディフェンダー:  { ab: ["covering"], effort: 0.95 },
  守備司令塔:            { ab: ["dfLine"], effort: 0.95 },
  ハッスルディフェンダー: { effort: 1.0, lockEffort: true },  // 常時全力・特能なし
  バランス:              { effort: 0.9 },                     // 標準
  省エネ:                { effort: 0.7 },                     // 攻撃専念で脚を温存(スタミナ消費小)
};

// オフェンス選択順位(1..5) → 使用率(0..1)。
const RANK_USAGE = [0.86, 0.72, 0.60, 0.52, 0.45];
export function usageFromRank(rank: number): number {
  return RANK_USAGE[clamp(Math.round(rank), 1, 5) - 1];
}

// 得点力スコア（選択順位の自動割当に使う。チーム内で相対比較）。
export function scoringPower(a: Attributes): number {
  return rate(a.threeAcc) * 0.26 + rate(a.midAcc) * 0.24 + rate(a.dunk) * 0.12
    + rate(a.aggression) * 0.14 + rate(a.handling) * 0.12 + rate(a.offense) * 0.12;
}

// ---------------------------------------------------------------------------
// ポジションに基づくオフェンスの個性。`scoreBase` はそのポジションの得点オプション度、
// `playmaking` はボール運び/お膳立て度。この後、選手個々の能力値で微調整する。
// ---------------------------------------------------------------------------
const ROLE_OFFENSE: Record<string, { scoreBase: number; playmaking: number }> = {
  PG: { scoreBase: 0.55, playmaking: 1.00 },
  SG: { scoreBase: 0.85, playmaking: 0.55 },
  SF: { scoreBase: 0.80, playmaking: 0.45 },
  PF: { scoreBase: 0.55, playmaking: 0.30 },
  C:  { scoreBase: 0.45, playmaking: 0.25 },
};
export function roleOffense(role: string): { scoreBase: number; playmaking: number } {
  return ROLE_OFFENSE[role] ?? { scoreBase: 0.6, playmaking: 0.4 };
}

// 選手の得点オプションとしての重み(0..1)。明示的な `priority` が優先、それ以外はポジションの
// ベースラインを得点能力値で微調整して導出する。
export function computeOffPriority(def: PlayerDef): number {
  // 明示的な選択順位(1..5)を最優先。ここは単独/プレビューのケースをカバーする。
  if (def.choiceRank) return usageFromRank(def.choiceRank);
  if (def.priority !== undefined) return clamp(def.priority, 0, 1);
  const ro = roleOffense(def.role);
  const a = def.attr;
  const scoringSkill = (rate(a.aggression) + rate(a.threeAcc) + rate(a.midAcc)) / 3;
  let base = ro.scoreBase * 0.65 + scoringSkill * 0.35;
  if (def.abilities?.includes("striker")) base += 0.12;  // ストライカー: 頼れる中心選手
  return clamp(base, 0, 1);
}
