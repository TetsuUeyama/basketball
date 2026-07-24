// 交代の「判断」ロジック（誰を交代させるか）。方式A: Game を受け取る関数群。実際の
// 入れ替え(substitute)・歩行アニメ(subWalkers/updateSubs)・withSubs は Game 側に残す。
// game.ts から分離（workPlan.md 参照）。
import { Player } from "../player";
import { QUARTERS } from "../config";
import { STARTERS, rate, scoringPower } from "../attributes";
import { clamp } from "../util";
import { roleFit, overallOf } from "./lineups";
import type { Game } from "../game";

// この選手がどれだけ交代を必要とするか: 疲れた脚、不調(TO過多で結果なし)、
// ブローアウトのガベージタイム。>0 で交代候補。
export function subDesire(game: Game, p: Player): number {
  const s = p.stats;
  // プライマリ順の首輪: primary1が最も出ずっぱり、5に向かって交代されやすい。
  // 得点役(エース/スラッシャー)は順位に依らず長め。
  const rank = p.choiceRank ?? p.autoRank;              // 1..5
  let leash = p.idx < STARTERS ? clamp((5 - rank) / 4, 0, 1) : 0;  // rank1→1 .. rank5→0
  if (p.offAction === "score") leash = Math.max(leash, 0.9);
  else if (p.offAction === "slash") leash = Math.max(leash, 0.6);
  const coeff = 1.6 - leash * 0.3;   // 疲労の重み: 1.6(早い交代) .. 1.3(粘る)
  const base = 0.45 + leash * 0.2;   // フック閾値 ≈ 疲労 0.28(rank5) .. 0.50(rank1)
  let d = p.fatigue * coeff - base;
  // 活躍度: 好調なら少し長く、不調(TO過多/決まらない)なら早め。効果は控えめ。
  const eff = s.pts + s.reb + s.ast - s.tov * 2 - (s.fga - s.fgm) * 0.5;
  d -= clamp(eff * 0.025, -0.1, 0.3);
  // 4Qのブローアウト: レギュラーを休ませベンチを空にする(先発優先)
  const diff = Math.abs(game.score[0] - game.score[1]);
  const blowout = game.quarter >= QUARTERS && diff >= 18;
  if (blowout) d += p.idx < STARTERS ? 0.7 : 0.2;
  // 4Q接戦のローテ形(ガベージ時は除外): 3Qで先発を休ませ、4Qはクロージング
  // ラインナップ(先発、上位primaryほど)を残す。
  else if (p.idx < STARTERS) {
    if (game.quarter === 3) d += 0.2 + leash * 0.25;   // 計画的な3Qの息継ぎ(スター最優先)
    else if (game.quarter >= QUARTERS) d -= 0.4 + leash * 0.3;  // 先発で締める
  }
  if (p.stintT < 12) d -= 0.6;                          // 入ったばかり — 残す
  return d;
}

// 相手のマッチアップに応じた交代(コーチング)。(1)相手のインテリア得点役を抑えられない
// →守備ビッグ投入 (2)相手の圧力/ダブルを捌けない→ボールハンドラー投入。1停止1チーム1回。
export function matchupSubs(game: Game, team: number, exclude: Player | null): void {
  const opp = 1 - team;
  const ourOn = game.teamPlayers(team);
  const bench = game.roster[team].filter((p) => !game.onCourt(p)
    && p.fatigue < 0.5 && p.matchupHoldT <= 0 && !game.subWalkers.some((w) => w.p === p));
  if (bench.length === 0) return;

  // (1) インテリアのミスマッチ — 「相手のセンターを止められない」
  const interior = (p: Player) => p.role === "PF" || p.role === "C" || p.height >= 1.98;
  const defRating = (p: Player) => rate(p.attr.defense) * 0.5 + (p.height - 1.9) * 0.6 + rate(p.attr.jump) * 0.15;
  let oppBig: Player | null = null, bigThreat = -Infinity;
  for (const o of game.teamPlayers(opp)) {
    if (!interior(o)) continue;
    const s = scoringPower(o.attr) + (o.height - 1.9) * 0.6;
    if (s > bigThreat) { bigThreat = s; oppBig = o; }
  }
  if (oppBig) {
    const ourDef = ourOn.find((p) => p.slot === oppBig!.slot);
    if (ourDef && ourDef !== game.handler && ourDef !== exclude
        && ourDef.matchupHoldT <= 0 && ourDef.stintT > 8) {
      const gap = (scoringPower(oppBig.attr) + (oppBig.height - 1.9) * 0.5)
        - (rate(ourDef.attr.defense) + (ourDef.height - 1.9) * 0.5);
      const hurting = oppBig.stats.pts >= 8;               // 既に決められている
      if (gap > 0.12 || hurting) {
        let best: Player | null = null, bestD = defRating(ourDef) + 0.06;   // 本当のアップグレードが必要
        for (const b of bench) {
          if (roleFit(b, ourDef.role) <= 0) continue;   // そのポジション適格のみ
          const d = defRating(b);
          if (d > bestD) { bestD = d; best = b; }
        }
        if (best) { game.substitute(ourDef, best); ourDef.matchupHoldT = 45; return; }
      }
    }
  }

  // (2) 圧力/ダブルチーム — 「相手の圧力を捌けない」
  const oppPress = game.tactics[opp].defense.pressure + game.tactics[opp].defense.press * 0.5;
  const ourPG = ourOn.reduce((a, b) => (a.slot <= b.slot ? a : b));   // 最小slot = ポイント
  if (ourPG !== game.handler && ourPG !== exclude
      && ourPG.matchupHoldT <= 0 && ourPG.stintT > 8) {
    const teamTov = ourOn.reduce((s, p) => s + p.stats.tov, 0);
    const handleScore = (p: Player) => rate(p.attr.handling) * 0.6 + rate(p.attr.passAcc) * 0.25 + p.playmaking * 0.3;
    const pressured = oppPress > 0.6 && rate(ourPG.attr.handling) < 0.6;
    if (pressured || teamTov >= 5) {                       // 静的(相手の圧)or動的(自分のTO)
      let best: Player | null = null, bestH = handleScore(ourPG) + 0.08;
      for (const b of bench) {
        if (b.role !== "PG" && b.role !== "SG") continue;  // ガード
        if (roleFit(b, ourPG.role) <= 0) continue;   // そのポジション適格のみ
        const hs = handleScore(b);
        if (hs > bestH) { bestH = hs; best = b; }
      }
      if (best) { game.substitute(ourPG, best); ourPG.matchupHoldT = 45; return; }
    }
  }
}

// 交代を決め論理的な入れ替え(roster slot/クロック/フィード)を行う。歩行アニメが各体を
// 目的地へ運ぶ。再出場可。4Qブローアウトでは鮮度要件を免除しベンチを空にする。
// 交代が発生したら true。
export function planSubs(game: Game, exclude: Player | null): boolean {
  game.subWalkers = [];
  const blowout = game.quarter >= QUARTERS
    && Math.abs(game.score[0] - game.score[1]) >= 18;
  // まず相手マッチアップのコーチング交代(この停止で優先)
  if (!blowout) for (let team = 0; team < 2; team++) matchupSubs(game, team, exclude);
  for (let team = 0; team < 2; team++) {
    const bench = game.roster[team].filter((p) => !game.onCourt(p));
    for (const out of [...game.teamPlayers(team)]) {
      if (out === game.handler || out === exclude) continue; // ボール保持者は残す
      if (subDesire(game, out) <= 0) continue;
      let best: Player | null = null;
      let bestScore = 0;
      for (const b of bench) {
        if (b.matchupHoldT > 0) continue;               // マッチアップで下げたばかり
        if (b.fatigue > 0.35) continue;                 // 回復不十分
        // ガベージ時以外は明確に新しい脚が必要
        if (!blowout && b.fatigue > out.fatigue - 0.15) continue;
        const fit = roleFit(b, out.role);
        if (fit <= 0) continue;
        const score = overallOf(b) * 0.5 + (1 - b.fatigue) * 0.5 + fit * 0.3;
        if (score > bestScore) { bestScore = score; best = b; }
      }
      if (best) {
        game.substitute(out, best);
        bench.splice(bench.indexOf(best), 1);
      }
    }
  }
  // 事前復帰: 休んだ先発を、フロアのベンチレベル選手と入れ替えて戻す。3Qは意図的に
  // スキップ(計画的な息継ぎ)。4Qは閾値を緩めクロージングラインナップを戻す。ガベージ除外。
  const closing = game.quarter >= QUARTERS;
  if (!blowout && game.quarter !== 3) {
    const restThresh = closing ? 0.7 : 0.30;
    for (let team = 0; team < 2; team++) {
      const resting = game.roster[team]
        .filter((p) => p.idx < STARTERS && !game.onCourt(p) && p.fatigue < restThresh
          && p.matchupHoldT <= 0                                  // マッチアップ下げをまだ戻さない
          && !game.subWalkers.some((w) => w.p === p))
        .sort((a, b) => (a.choiceRank ?? a.autoRank) - (b.choiceRank ?? b.autoRank)); // primary優先
      for (const starter of resting) {
        let target: Player | null = null, worst = -Infinity;
        for (const oc of game.teamPlayers(team)) {
          if (oc === game.handler || oc === exclude) continue;
          if (oc.idx < STARTERS) continue;                       // 他の先発は下げない
          if (oc.stintT < 12) continue;                          // 入ったばかり
          if (roleFit(starter, oc.role) <= 0) continue; // 適格のみ
          if (game.subWalkers.some((w) => w.p === oc)) continue;
          const bad = oc.fatigue + (1 - overallOf(oc) / 99);   // 最も疲れ/弱い者から
          if (bad > worst) { worst = bad; target = oc; }
        }
        if (target) game.substitute(target, starter);
      }
    }
  }
  return game.subWalkers.length > 0;
}
