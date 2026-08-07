// ラインナップ/ユーセージの「コーチング」判断（先発選び・使用率・ポジション適格性）。
// 実際の入れ替えは Game 側、交代の要否判断は systems/subs.ts。
import { Player } from "../objects/player/player";
import { ROSTER, EXTRA_POSITIONS } from "../roster";
import { TACTICS, type PlayerDef } from "../attributes";
import { scoringPower, usageFromRank } from "../roles";
import { rate, clamp } from "../util";
import type { Game } from "../game";

// 総合的な才能（全能力値の平均、0..1）。
export function overallOf(p: Player): number {
  const a = p.attr as unknown as Record<string, number>;
  let sum = 0, n = 0;
  for (const k in a) { sum += a[k]; n++; }
  return n ? sum / n / 100 : 0.5;
}

// ポジション適格性: 自分のロールと EXTRA_POSITIONS のみ可。適格なら 1、不適格なら 0。
export function roleFit(p: { role: string; name: string }, slot: string): number {
  if (slot === p.role) return 1;
  return (EXTRA_POSITIONS[p.name] ?? []).includes(slot) ? 1 : 0;
}

// ---- 相手を考慮した先発ラインナップ（コーチング） -------------------------
// 各チームの13人からベスト5を相手の脅威で重み付けして選ぶ。ROSTER[t] をインプレースで
// 並べ替える（ベスト5を先頭、PG-SG-SF-PF-C 順）。
// ROSTER と TACTICS だけを見る（Game 生成前=チーム決定直後にも呼べる）。
export function optimizeLineups(): void {
  const oppInfo = (opp: number) => {
    let bigThreat = 0;
    for (const d of ROSTER[opp]) {
      if (d.role !== "PF" && d.role !== "C" && d.height < 1.98) continue;
      bigThreat = Math.max(bigThreat, scoringPower(d.attr) + (d.height - 1.9) * 0.6);
    }
    const press = TACTICS[opp].defense.pressure + TACTICS[opp].defense.press * 0.5;
    return { bigThreat, press };
  };
  const overall = (d: PlayerDef) =>
    scoringPower(d.attr) * 0.45 + rate(d.attr.defense) * 0.28
    + rate(d.attr.balance) * 0.08 + rate(d.attr.stamina) * 0.05 + (d.height - 1.9) * 0.30;

  const roles = ["PG", "SG", "SF", "PF", "C"] as const;
  for (let team = 0; team < 2; team++) {
    const info = oppInfo(1 - team);
    const pool = ROSTER[team];
    // 相手の脅威が状況バイアスをどれだけ強めるか（0..1）。
    const bigDom = clamp((info.bigThreat - 0.45) / 0.30, 0, 1);   // 支配的な相手ビッグ
    const heavyPress = clamp((info.press - 0.50) / 0.40, 0, 1);   // 強いオンボールプレッシャー
    const value = (d: PlayerDef, slot: string): number => {
      // 適格な選手のみが到達。主ポジションを副次(EXTRA_POSITIONS)より優先。
      const fit = d.role === slot ? 1.0 : 0.5;
      let v = fit + overall(d) * 0.4;
      // 支配的な相手ビッグには守備型のビッグ(守備+身長+ジャンプ)を優先。
      if (slot === "PF" || slot === "C") {
        v += bigDom * (rate(d.attr.defense) * 0.60 + (d.height - 1.9) * 0.55 + rate(d.attr.jump) * 0.20);
      }
      // 強いプレッシャーに対しては、純粋なスコアラーより確実なハンドラーが先発
      if (slot === "PG" || slot === "SG") {
        v += heavyPress * rate(d.attr.handling) * 0.55;
      }
      return v;
    };
    const picked = new Set<PlayerDef>();
    const starters: PlayerDef[] = [];
    for (const slot of roles) {
      let best: PlayerDef | null = null, bestV = -Infinity;
      for (const d of pool) {
        if (picked.has(d)) continue;
        if (roleFit(d, slot) <= 0) continue;   // このポジションに適格な選手のみ
        const v = value(d, slot);
        if (v > bestV) { bestV = v; best = d; }
      }
      if (best) { picked.add(best); starters.push(best); }
    }
    // 安全策: 適格な選手が残らないスロットは残りのベストで埋め、5人を揃える
    if (starters.length < 5) {
      const rest = pool.filter((d) => !picked.has(d)).sort((a, b) => overall(b) - overall(a));
      for (const d of rest) { if (starters.length >= 5) break; picked.add(d); starters.push(d); }
    }
    const benchDefs = pool.filter((d) => !picked.has(d));
    pool.length = 0;                     // インプレースで並べ替え（同じ配列参照を保つ）
    pool.push(...starters, ...benchDefs);
  }
}

// 選択順を各コート上選手のユーセージ(offPriority)へ変換する。明示的な choiceRank は保持、
// 重複ランクは「共同エース」、残りはスコアリング力で 1..5 へ自動ランク付け。
export function refreshChoiceRanks(game: Game, team: number): void {
  const on = game.teamPlayers(team);
  const used = new Set<number>();
  for (const p of on) if (p.choiceRank) used.add(p.choiceRank);
  const auto = on.filter((p) => !p.choiceRank)
    .sort((a, b) => scoringPower(b.attr) - scoringPower(a.attr));
  let r = 1;
  for (const p of auto) {
    while (used.has(r) && r < 5) r++;
    p.autoRank = clamp(r, 1, 5); used.add(r); r++;
  }
  for (const p of on) {
    const rank = p.choiceRank ?? p.autoRank;
    // 指名されたエースは小さなユーセージ加算を得る
    p.offPriority = clamp(usageFromRank(rank) + (p.offAction === "score" ? 0.06 : 0), 0, 1);
  }
}
