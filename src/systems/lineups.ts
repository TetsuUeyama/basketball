// ラインナップ/ユーセージの「コーチング」判断（誰を先発させ、誰にボールを集めるか、
// どのポジションに適格か）。方式A: Game を受け取る関数群 / Player・PlayerDef を受け取る
// 純ヘルパ。実際の入れ替えアニメ(substitute/updateSubs)は Game 側、交代の要否判断は
// systems/subs.ts。game.ts から分離（workPlan.md / [[game-split-optionb]] 参照）。
import { Player } from "../player";
import { ROSTER, EXTRA_POSITIONS, rate, scoringPower, usageFromRank,
  type PlayerDef } from "../attributes";
import { clamp } from "../util";
import type { Game } from "../game";

// Overall talent, for choosing who checks in (average of all ratings, 0..1).
export function overallOf(p: Player): number {
  const a = p.attr as unknown as Record<string, number>;
  let sum = 0, n = 0;
  for (const k in a) { sum += a[k]; n++; }
  return n ? sum / n / 100 : 0.5;
}

// Position ELIGIBILITY (hard rule): a player may ONLY play his own listed role,
// plus any EXTRA_POSITIONS explicitly granted to him. No adjacency, no ability
// substitution — a player is never put in a position that isn't his. Returns 1
// if eligible for the slot, 0 if not (the selectors treat 0 as "can't fill it").
export function roleFit(p: { role: string; name: string }, slot: string): number {
  if (slot === p.role) return 1;
  return (EXTRA_POSITIONS[p.name] ?? []).includes(slot) ? 1 : 0;
}

// ---- opponent-aware STARTING lineup (coaching) -------------------------
// Pick each team's best five from its 13, weighted by the OTHER team's threats:
// a dangerous interior scorer pulls in a defensive big; heavy on-ball pressure
// pulls in a surer ball-handler. Reorders ROSTER[t] IN PLACE (best five first,
// in PG-SG-SF-PF-C order). Called by the UI when a matchup is FIRST established
// (before the editor is shown) so it's the DEFAULT the user then freely edits —
// it is NOT re-run at tip-off, so a hand-arranged lineup is never clobbered.
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
    // How much the opponent's threat RAMPS the situational bias (0 = ordinary
    // opponent → pick the best five by ability; 1 = extreme → the matchup term
    // can outweigh a real ability gap and swap the pick).
    const bigDom = clamp((info.bigThreat - 0.45) / 0.30, 0, 1);   // dominant opposing big
    const heavyPress = clamp((info.press - 0.50) / 0.40, 0, 1);   // heavy on-ball pressure
    const value = (d: PlayerDef, slot: string): number => {
      // Only ELIGIBLE players reach here (the gate below drops the rest). Prefer
      // his PRIMARY position over a secondary (EXTRA_POSITIONS) one; ability and
      // the opponent tilt then choose WHICH eligible player starts.
      const fit = d.role === slot ? 1.0 : 0.5;
      let v = fit + overall(d) * 0.4;
      // vs a dominant big, a defensive big (守備+身長+ジャンプ) is worth starting
      // even over a better scorer — refines which big starts.
      if (slot === "PF" || slot === "C") {
        v += bigDom * (rate(d.attr.defense) * 0.60 + (d.height - 1.9) * 0.55 + rate(d.attr.jump) * 0.20);
      }
      // vs heavy pressure, a surer ball-handler starts over a pure scorer
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
        if (roleFit(d, slot) <= 0) continue;   // only players ELIGIBLE for this position
        const v = value(d, slot);
        if (v > bestV) { bestV = v; best = d; }
      }
      if (best) { picked.add(best); starters.push(best); }
    }
    // safety: a slot with NO eligible player left (roster short at that position)
    // is filled from the best remaining so the five is complete
    if (starters.length < 5) {
      const rest = pool.filter((d) => !picked.has(d)).sort((a, b) => overall(b) - overall(a));
      for (const d of rest) { if (starters.length >= 5) break; picked.add(d); starters.push(d); }
    }
    const benchDefs = pool.filter((d) => !picked.has(d));
    pool.length = 0;                     // reorder in place (keep the same array ref)
    pool.push(...starters, ...benchDefs);
  }
}

// Turn the CHOICE ORDER into each on-court player's usage (offPriority = who
// the ball is funnelled to). A player with an explicit choiceRank keeps it;
// duplicate explicit ranks stay equal = "co-primary" who share the ball. The
// rest are auto-ranked by scoring power into the remaining 1..5 slots — this is
// the "auto by ability" default the user asked for. Recomputed per on-court
// unit so a substitution re-shuffles the pecking order.
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
    // a designated shot-creator (エース) gets a small usage bump on top of rank
    p.offPriority = clamp(usageFromRank(rank) + (p.offAction === "score" ? 0.06 : 0), 0, 1);
  }
}
