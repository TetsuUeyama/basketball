// 交代の判断・実行ロジック一式。要否判断(subDesire/matchupSubs/planSubs)・入れ替え(substitute)・
// 歩行アニメ(subWalkers/updateSubs)・凍結ゲート(withSubs)を集約。
import { Player } from "../objects/player/player";
import { QUARTERS } from "../config";
import { STARTERS } from "../roster";
import { scoringPower } from "../roles";
import { rate, clamp, dist2DTo, moveToward2D } from "../util";
import { roleFit, overallOf, refreshChoiceRanks } from "../ai/lineups";
import { benchSeat, benchStandSpot } from "../core/bench";
import { blockBench, pushApart } from "../core/collision";
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
        if (best) { substitute(game, ourDef, best); ourDef.matchupHoldT = 45; return; }
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
      if (best) { substitute(game, ourPG, best); ourPG.matchupHoldT = 45; return; }
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
        substitute(game, out, best);
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
        if (target) substitute(game, target, starter);
      }
    }
  }
  return game.subWalkers.length > 0;
}

// 帳簿上の入れ替え: 交代選手が即座にコート枠を引き継ぐ(マンマッチ、出場時計、
// フィード登録)。ただし物理的にはベンチから走って入る必要があり —
// 休む選手は自席へ歩いて退く。
export function substitute(game: Game, out: Player, sub: Player): void {
  const i = game.players.indexOf(out);
  if (i < 0) return;
  const cx = out.pos.x, cz = out.pos.z;   // 引き継がれるコート上の位置
  sub.slot = out.slot;
  sub.spotIdx = out.slot;
  sub.stintT = 0;
  sub.cutting = false;
  sub.screening = false;
  sub.beatenT = sub.powerT = sub.stalledT = sub.jukeT = sub.comboN = sub.reactT = sub.coolT = sub.landT = 0;
  out.lean = 0;        // 退く選手はベンチへの歩行のため体を起こす
  sub.resetFacing();   // コート上の体はヨーを持たない — ベンチでの視線をクリア
  sub.stand();         // ベンチから立ち上がって走り込む
  game.players[i] = sub;
  const stand = benchStandSpot(game, out);
  sub.pos.x = Math.min(sub.pos.x, benchStandSpot(game, sub).x);   // 立ち上がりはベンチの前へ
  game.subWalkers.push({ p: sub, tx: cx, tz: cz });     // 自席から走って入る
  game.subWalkers.push({ p: out, tx: stand.x, tz: stand.z }); // 自席の手前へ歩いて退く
  game.subsMade++;
  game.subEvents.push({
    inNum: sub.idx + 1, inName: sub.name,
    outNum: out.idx + 1, outName: out.name,
    team: out.team, ttl: 3.0,   // 表示時間(約2.2秒表示→0.8秒フェード)。上限 subT>=9秒に収まる
  });
  // コート上のユニットが変わった → 選択順(自動ユーセージ)を再導出し、入る選手が
  // 能力順の序列に収まるようにする
  refreshChoiceRanks(game, out.team);
}

// 入れ替え本体: プレーは凍結、各歩行者が目的地へ移動し、交代チップは画面に残り、
// 全員が(安全タイムアウト付きで)配置に着いたら保留中の再開が走る。
export function updateSubs(game: Game, dt: number): void {
  game.subT += dt;
  // 交代チップは通常どおり経過する。プレー再開は全チップが消えてから(下の再開ゲート参照)。
  game.ball.pos.y = Math.max(0.12, game.ball.pos.y - 3 * dt);   // 床へ落ち着く

  const timedOut = game.subT >= 9;   // 安全上限: 歩行/フィードで試合を止めない
  let done = true;
  for (const w of game.subWalkers) {
    if (!timedOut && dist2DTo(w.p.pos, w.tx, w.tz) > 0.25) {
      done = false;
      // 単純なジョグで両歩行者を一定ペースで動かす(退場者は players にいないため accelSpeed 不可)
      const jog = w.p.runSpeed * 0.85 * (1 - w.p.fatigue * 0.2);
      moveToward2D(w.p.pos, w.tx, w.tz, jog * dt);
      // 向かう先を向き、脚/腕のサイクルを回す
      w.p.faceToward(w.tx, w.tz);
      w.p.twistToward(w.tx, w.tz, dt);   // プレーで残ったツイストをほどく
      w.p.curSpd = jog;
      w.p.updateLegs(dt);
      w.p.runArms();
    } else {
      w.p.pos.set(w.tx, 0, w.tz);
    }
  }
  // 歩く体同士を押し離し、すり抜けないようにする
  const bodies = new Set<Player>(game.players);
  for (const w of game.subWalkers) bodies.add(w.p);
  pushApart([...bodies]);
  for (const w of game.subWalkers) if (!w.p.seated) blockBench(w.p.pos);   // ベンチを突き抜けない
  for (const w of game.subWalkers) w.p.sync(); // 退場者は `players` を離れた — ここで sync
  // 再開は歩行者が配置に着き、かつ交代フィードが消えてから。timedOut はハード上限。
  if ((done && game.subEvents.length === 0) || timedOut) {
    for (const w of game.subWalkers) {
      w.p.pos.set(w.tx, 0, w.tz);
      // コート上に立つ者はベンチのヨーを持たない — ここで強制
      if (game.onCourt(w.p)) w.p.resetFacing();
      else {
        const seat = benchSeat(game, w.p);        // 手前まで歩いてから席へ座る
        w.p.pos.set(seat.x, 0, seat.z);
        w.p.faceToward(seat.x - 1, seat.z);
        w.p.sit();
      }
      w.p.sync();
    }
    game.subWalkers = [];
    const next = game.subNext;
    game.subNext = null;
    if (next) next();
  }
}

// デッドボール時: 交代が必要な者がいれば "subs" ボールモードでプレーを凍結し
// 入場/退場の入れ替えを実行。`next`(インバウンド等)は全歩行者が自分の位置に
// 着いてから初めて走る。交代がなければプレーはそのまま続行。
export function withSubs(game: Game, next: () => void, exclude: Player | null = null): void {
  if (!planSubs(game, exclude)) { next(); return; }
  game.subNext = next;
  game.subT = 0;
  game.handler = null;               // 入れ替え中は誰もボールを扱わない
  game.ballMode = "subs";
}
