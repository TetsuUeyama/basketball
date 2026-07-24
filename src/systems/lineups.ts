// ラインナップ/ユーセージの「コーチング」判断（誰を先発させ、誰にボールを集めるか、
// どのポジションに適格か）。方式A: Game を受け取る関数群 / Player・PlayerDef を受け取る
// 純ヘルパ。実際の入れ替えアニメ(substitute/updateSubs)は Game 側、交代の要否判断は
// systems/subs.ts。game.ts から分離（workPlan.md / [[game-split-optionb]] 参照）。
import { Player } from "../objects/player/player";
import { ROSTER, EXTRA_POSITIONS, rate, scoringPower, usageFromRank,
  type PlayerDef } from "../attributes";
import { clamp } from "../util";
import type { Game } from "../game";

// 総合的な才能、誰を出場させるか選ぶ用（全能力値の平均、0..1）。
export function overallOf(p: Player): number {
  const a = p.attr as unknown as Record<string, number>;
  let sum = 0, n = 0;
  for (const k in a) { sum += a[k]; n++; }
  return n ? sum / n / 100 : 0.5;
}

// ポジション適格性（厳格ルール）: 選手は自分にリストされたロール、および明示的に
// 付与された EXTRA_POSITIONS のみプレー可能。隣接も能力による代替もなし——選手が
// 自分のものでないポジションに置かれることは決してない。スロットに適格なら 1、
// 不適格なら 0 を返す（セレクタは 0 を「埋められない」として扱う）。
export function roleFit(p: { role: string; name: string }, slot: string): number {
  if (slot === p.role) return 1;
  return (EXTRA_POSITIONS[p.name] ?? []).includes(slot) ? 1 : 0;
}

// ---- 相手を考慮した先発ラインナップ（コーチング） -------------------------
// 各チームの13人からベスト5を、相手チームの脅威で重み付けして選ぶ: 危険な
// インサイドのスコアラーは守備型のビッグを引き込み、強いオンボールプレッシャー
// はより確実なハンドラーを引き込む。ROSTER[t] をインプレースで並べ替える
// （ベスト5を先頭、PG-SG-SF-PF-C 順）。マッチアップが最初に確立されたとき
// （エディタ表示前）に UI から呼ばれるので、ユーザーがその後自由に編集する
// デフォルトになる——ティップオフで再実行されないため、手で組んだラインナップが上書きされることはない。
export function optimizeLineups(game: Game): void {
  const oppInfo = (opp: number) => {
    let bigThreat = 0;
    for (const d of ROSTER[opp]) {
      if (d.role !== "PF" && d.role !== "C" && d.height < 1.98) continue;
      bigThreat = Math.max(bigThreat, scoringPower(d.attr) + (d.height - 1.9) * 0.6);
    }
    const press = game.tactics[opp].defense.pressure + game.tactics[opp].defense.press * 0.5;
    return { bigThreat, press };
  };
  const overall = (d: PlayerDef) =>
    scoringPower(d.attr) * 0.45 + rate(d.attr.defense) * 0.28
    + rate(d.attr.balance) * 0.08 + rate(d.attr.stamina) * 0.05 + (d.height - 1.9) * 0.30;

  const roles = ["PG", "SG", "SF", "PF", "C"] as const;
  for (let team = 0; team < 2; team++) {
    const info = oppInfo(1 - team);
    const pool = ROSTER[team];
    // 相手の脅威が状況バイアスをどれだけ強めるか（0 = 平凡な相手 → 能力で
    // ベスト5を選ぶ。1 = 極端 → マッチアップ項が実際の能力差を上回り、
    // 選択を入れ替えうる）。
    const bigDom = clamp((info.bigThreat - 0.45) / 0.30, 0, 1);   // 支配的な相手ビッグ
    const heavyPress = clamp((info.press - 0.50) / 0.40, 0, 1);   // 強いオンボールプレッシャー
    const value = (d: PlayerDef, slot: string): number => {
      // ここに到達するのは適格な選手のみ（下のゲートで残りは除外）。副次的な
      // (EXTRA_POSITIONS) ポジションより主ポジションを優先する。能力と相手による
      // 傾きが、どの適格選手が先発するかを選ぶ。
      const fit = d.role === slot ? 1.0 : 0.5;
      let v = fit + overall(d) * 0.4;
      // 支配的なビッグに対しては、守備型のビッグ(守備+身長+ジャンプ)がより優れた
      // スコアラーより先発させる価値がある——どのビッグが先発するかを調整する。
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
    // 安全策: 適格な選手が残っていないスロット（そのポジションでロスターが不足）は
    // 残りのベストで埋め、5人を揃える
    if (starters.length < 5) {
      const rest = pool.filter((d) => !picked.has(d)).sort((a, b) => overall(b) - overall(a));
      for (const d of rest) { if (starters.length >= 5) break; picked.add(d); starters.push(d); }
    }
    const benchDefs = pool.filter((d) => !picked.has(d));
    pool.length = 0;                     // インプレースで並べ替え（同じ配列参照を保つ）
    pool.push(...starters, ...benchDefs);
  }
}

// 選択順を各コート上選手のユーセージ（offPriority = 誰にボールを集めるか）へ
// 変換する。明示的な choiceRank を持つ選手はそれを保持。重複した明示ランクは
// 等しいまま = ボールを分け合う「共同エース」。残りはスコアリング力で残りの
// 1..5 スロットへ自動ランク付け——これがユーザーの求めた「能力で自動」の
// デフォルト。コート上ユニットごとに再計算するので、交代で序列が再シャッフル
// される。
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
    // 指名されたショットクリエイター(エース)はランクに加えて小さなユーセージ加算を得る
    p.offPriority = clamp(usageFromRank(rank) + (p.offAction === "score" ? 0.06 : 0), 0, 1);
  }
}
