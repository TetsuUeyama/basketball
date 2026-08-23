// ハンドラーの判断tick。シュート/ドライブ/パス/リセットを、状況(クロック・守備)と
// オフェンスロール・個人の傾向・チーム戦術から選ぶ。実行は ./drive ./keep 側。
import { Vector3 } from "@babylonjs/core";
import { Player } from "../../../objects/player/player";
import { THREE_DIST, SHOT_CLOCK, BUZZER_WINDOW } from "../../../config";
import { rate, clamp, chance, rand, dist2D, dirTo2D } from "../../../util";
import { twWeight, gatherFor, effShootRange, wontLoadUp } from "../../../eval";
import { pass, passToReceiver } from "../../../move/action/passing";
import { shoot, finishAtRim } from "../../../move/action/shooting";
import { denySmother } from "../../defense/shared";
import { doubleTeamApproaching, betterOptionAvailable, laneClear } from "../reads";
import { canIso, postMove, pushBreak, driveDecision, stepBack } from "./drive";
import {
  mustKeepDribble, keepDribbleDecide, trapKickOut, retreatFromTrap,
  bringUpLane, outletTo, advanceSafely,
} from "./keep";
import type { Game } from "../../../game";

// ダブルチーム記憶: 直近でトラップに遭った選手を no-feed 対象に保つ秒数
const TRAP_MEMORY = 2.5;

// クロック逼迫度: ショットクロックが SHOT_CLOCK*frac を切ってからの経過割合(0..1)。
function clockPush(game: Game, frac: number): number {
  const w = SHOT_CLOCK * frac;
  return clamp((w - game.shotClock) / w, 0, 1);
}

  // ボールハンドラーの選択 — シュート/ドライブ/パス/リセット — 選手自身の
  // 傾向とスキルを、チームの戦術的ゲームプランと融合させる。
export function decide(game: Game, h: Player, dHoop: number, dDef: number, rimFloor: Vector3): void {
    const tac = game.tactics[h.team].offense;
    const prio = h.offPriority;
    // ロール由来の行動プロファイル: 何をするかはオフェンスロールが支配する。
    // canCreate = 自分から仕掛ける役（エース/スラッシャー/得点ビッグ/balanced）、
    // passFirst = まず配球（ハンドラー/フロアジェネラル/ハブビッグ）、
    // noCreate = 無理に作らない（スポット/カッター/スクリーナー/リバウンダー等）。
    const act = h.offAction;
    const canCreate = act === "score" || act === "slash" || act === "postScore" || act === "balanced";
    const passFirst = act === "distribute" || act === "postHub";
    const noCreate = act === "spot" || act === "cut" || act === "run" || act === "screen" || act === "rebound";

    // ブザービーター: ゲーム/ショットクロックがほぼ無い — どこからでも放り上げる。
    // ゲームブザー → 常に放る。ショットクロックブザー → 強い deny に覆われて
    // いない限り放る。
    const gameBuzzer = game.gameClock > 0 && game.gameClock < BUZZER_WINDOW;
    const shotBuzzer = game.shotClock < 0.45;
    // 深い一発はギャザーするクロックが残っている時のみ放てる。
    // (クォーター終わりのゲームブザーは対象外。)
    const canGather = game.shotClock >= gatherFor(h, dHoop);
    if ((gameBuzzer || (shotBuzzer && canGather && !denySmother(game, h, dDef))) && dHoop > 1.8) {
      shoot(game, h, dHoop, dDef); return;
    }

    // ゴール至近でフリーで受けた: 迷わずフィニッシュ。
    if (dDef > 1.0 && game.frontT) {
      if (dHoop <= 2.3) { finishAtRim(game, h, dDef); return; }
      if (dHoop <= 4.0 && laneClear(game, h, rimFloor)) { game.setDrive(h, rimFloor, 1.2); return; }
    }

    // 運び上げはガードの仕事: フロントコート確立前にボールを持ったビッグは
    // PG→SG を探して渡す。プレイメイキングビッグは対象外(自分で運ぶ)。
    if (!game.frontT && game.isBig(h) && h.evalRole !== "プレイメイキングビッグ" && dHoop > 10) {
      // 最良のプレイメイカー2人が候補
      const guards = game.teamPlayers(h.team).filter((g) => g !== h)
        .sort((a, b) => b.playmaking - a.playmaking);
      for (const g of guards.slice(0, 2)) {
        if (outletTo(game, h, g)) return;
      }
      advanceSafely(game, h);                     // まだフリーのガード無し — 保持/流す
      return;
    }

    // 速攻: 守備が整う前にリムへ強く押し込む(ビッグは上でアウトレット済み)。
    if (game.pushT > 0) { pushBreak(game, h, dHoop); return; }

    // リム際 → フィニッシュ。全力バーストで到達したハンドラーは早めに踏み切る。
    if (dHoop < (h.beatenT > 0 ? 2.3 : 1.8)) { finishAtRim(game, h, dDef); return; }

    // 形成中のダブルチーム → 早めに手放す。ハンドル(D精度)が悪いほど早く手放す。
    // (既に仕掛けた move は続行。安全なアウトレットが無ければ下へ抜ける。)
    const committing = h.beatenT > 0 || h.powerT > 0 || h.jukeT > 0;
    if (!committing && game.shotClock > 1 && doubleTeamApproaching(game, h)) {
      const bail = clamp(0.15 + (1 - rate(h.attr.dribbleAcc)) * 1.0
        + (1 - rate(h.attr.handling)) * 0.15, 0.12, 0.96);
      if (chance(bail) && pass(game, h)) return;
    }

    // 低 D精度、マークされている: キープしかできない(渡す/じりじり前進/保持)。
    if (mustKeepDribble(game, h, dDef)) { keepDribbleDecide(game, h, dHoop, dDef, rimFloor); return; }

    // 仕掛けた1対1の move が進行中 — 毎tick再決定せず最後まで見届ける。
    if (h.beatenT > 0 || h.powerT > 0 || h.jukeT > 0) return;
    // 壁で止められた: より良い形へキックアウト、さもなければ引き戻して再アタック。
    if (h.stalledT > 0) { if (chance(0.5) && pass(game, h)) return; return; }

    // コンボ途中: 逆方向の次の move ですぐデュエルへ戻る
    if (h.comboN > 0) {
      if (canIso(game, h, dHoop)) { driveDecision(game, h); return; }
      h.comboN = 0;                        // コンボを打ち切る
    }

    // 担当守備者が足を離した(ギャンブル/食いついたフェイク) → ボールを床に置いて抜く。
    // (突くのはショットクリエイターだけ。)
    if (canCreate) {
      const od = game.onBallDefender(h);
      if (od && od.airborne && dDef < 2.2 && canIso(game, h, dHoop)
          && chance(0.45 + rate(h.attr.reaction) * 0.3 + rate(h.attr.handling) * 0.15)) {
        h.driveSide = game.pickSide(h);
        h.beatenT = rand(0.6, 0.9);
        od.applyReactLag();
        game.setDriveSide(h);
        return;
      }
      // クローズアウトを攻める: 勢いよく飛び込んでくる守備者は真っ直ぐ抜き去れる。
      if (od && !od.airborne && dDef < 2.4 && od.curSpd > od.runSpeed * 0.55
          && canIso(game, h, dHoop)) {
        const edge = rate(h.attr.handling) * 0.4 + rate(h.attr.agility) * 0.35
          + rate(h.attr.dribbleAcc) * 0.25 - rate(od.attr.balance) * 0.5;
        if (chance(clamp(0.3 + edge, 0.08, 0.75))) {
          h.driveSide = game.pickSide(h);
          h.beatenT = rand(0.55, 0.85);
          od.applyReactLag();
          game.setDriveSide(h);
          return;
        }
      }
    }

    // 目の前の守備を抜けない: 単騎の壁でもキックアウトで打開を試みる
    if (h.stalledT > 0 && dDef < 1.6 && trapKickOut(game, h)) return;

    // ダブルチーム/トラップ: 2人とも密着した本物のトラップ時のみ読みが引き継ぐ。
    // 正しい読みはキックアウトか保持してリセット。
    {
      const d1 = game.onBallDefender(h);
      let tight = 0, contain = 0;
      let d2: Player | null = null, d2d = Infinity;
      for (const dn of game.teamPlayers(1 - h.team)) {
        const dd = dist2D(dn.pos, h.pos);
        if (dd < 1.6) {
          tight++;
          contain += rate(dn.attr.defense) * 0.4 + rate(dn.attr.agility) * 0.35 + rate(dn.attr.balance) * 0.25;
        }
        if (dn !== d1 && dd < 1.9 && dd < d2d) { d2d = dd; d2 = dn; }
      }
      // トラップを人に紐づけて記憶する(A→B→A のラリーを潰す)
      if (tight >= 2) h.trappedT = TRAP_MEMORY;
      // 本物のトラップ: 1.6m以内に2人、かつ実際のオンボール圧(dDef が密着)
      if (tight >= 2 && dDef < 1.4) {
        // ドリブルからトラップを割る。指定スラッシャー(能力"driver" / offAction"slash")
        // は進んで行い、それ以外は稀。2人の隙間と味方のスクリーンで開き、
        // 成功はトラップに対して相対的。
        if (canIso(game, h, dHoop)) {
          // リムへのレーンに沿って測る隙間: 両側に割れている → 真ん中に隙間、
          // 一方に偏っている → 外側が開き口、ボールに重なっている → レーン無し。
          let seam = 0;
          if (d1 && d2) {
            const { ux, uz } = dirTo2D(h.pos.x, h.pos.z, rimFloor.x, rimFloor.z);
            const px = -uz, pz = ux;                                    // 横軸
            const lat1 = (d1.pos.x - h.pos.x) * px + (d1.pos.z - h.pos.z) * pz;
            const lat2 = (d2.pos.x - h.pos.x) * px + (d2.pos.z - h.pos.z) * pz;
            seam = lat1 * lat2 < 0 ? Math.min(Math.abs(lat1), Math.abs(lat2)) : 0.8;
          }
          const seamScore = clamp((seam - 0.4) / 1.2, 0, 1);           // 密着..完全にオープン
          // 味方がトラッパーにスクリーンすると彼を釘付けにし、トラップが人手不足になる
          let screen = 0;
          for (const mate of game.teamPlayers(h.team)) {
            if (mate === h) continue;
            if (d1 && dist2D(mate.pos, d1.pos) < 1.2) screen = Math.max(screen, 0.5);
            if (d2 && dist2D(mate.pos, d2.pos) < 1.2) screen = Math.max(screen, 0.5);
          }
          const attack = rate(h.attr.handling) * 0.35 + rate(h.attr.agility) * 0.35
            + rate(h.attr.dribbleAcc) * 0.20 + rate(h.attr.speed) * 0.10;
          const rel = attack - contain / tight;                        // トラップに対する優位
          const slasher = h.has("driver") || act === "slash";
          const openness = seamScore * (slasher ? 0.28 : 0.14) + screen * (slasher ? 0.22 : 0.12);
          const splitChance = slasher
            ? clamp(0.05 + rel * 1.5 + openness, 0.03, 0.65)
            : clamp(0.02 + rel * 0.45 + openness, 0.015, 0.24);
          if (chance(splitChance)) { driveDecision(game, h); return; }
        }
        // 割れない → パスで解決: トラップが空けた選手へキックアウト。誰も空いて
        // いなければリトリートドリブルでトラップから抜けてリセット。
        if (trapKickOut(game, h)) return;
        retreatFromTrap(game, h);
        return;
      }
    }

    // ロール駆動の行動 — 今何をするかはオフェンスロールに従う。
    if (passFirst) {
      // ハンドラー/フロアジェネラル/ハブビッグ: まず配球。空いた球は打ち、
      // レーンが開けば仕掛ける。
      if (!game.frontT) { bringUpLane(game, h); return; }
      if (game.shotClock < SHOT_CLOCK * 0.3 && dHoop > 1.8 && canGather && !wontLoadUp(h, dHoop, dDef) && !denySmother(game, h, dDef)) {
        // 投げ捨てる前に: 1秒以上あるなら深い3を避けてラインへ寄る。
        if (dHoop > effShootRange(h) + 0.6 && game.shotClock > 1.0) { game.setDrive(h, rimFloor, THREE_DIST + 0.2); return; }
        shoot(game, h, dHoop, dDef);
        return;
      }
      const inRange = dHoop <= effShootRange(h) + 0.3;
      const push = clockPush(game, 0.5);   // 遅いほど打つ(残半分から)
      // 綺麗なレーン → 守備を歪ませに攻める(ビッグはドリブルでなくポスト)
      if (laneClear(game, h, rimFloor) && dHoop <= 8 && canIso(game, h, dHoop)
          && chance(clamp(0.2 + rate(h.attr.handling) * 0.25 + push * 0.3, 0, 0.6))) {
        if (game.isBig(h)) postMove(game, h); else driveDecision(game, h);
        return;
      }
      const open = dDef > 1.7;
      const pS = clamp(0.16 + rate(h.attr.threeAcc) * 0.28 + (dDef - 1.7) * 0.2 + push * 0.5, 0.04, 0.9);
      if (inRange && open && chance(pS)) { shoot(game, h, dHoop, dDef); return; }
      if (pass(game, h)) return;
      game.setDrive(h, rimFloor, Math.min(4.5, Math.max(dHoop, 1.2)));   // 探り/リセット — 選手をペイントの外へ後退させない
      return;
    }
    if (noCreate) {
      // スポット/カッター/ランナー/スクリーナー/リバウンダー: キャッチ&シュートが
      // 基本。クローズアウトには仕掛け、開いた球は打つ。
      if (!game.frontT) { bringUpLane(game, h); return; }
      if (game.shotClock < SHOT_CLOCK * 0.3 && dHoop > 1.8 && canGather && !wontLoadUp(h, dHoop, dDef) && !denySmother(game, h, dDef)) {
        // 投げ捨てる前に: 1秒以上あるなら深い3を避けてラインへ寄る。
        if (dHoop > effShootRange(h) + 0.6 && game.shotClock > 1.0) { game.setDrive(h, rimFloor, THREE_DIST + 0.2); return; }
        shoot(game, h, dHoop, dDef);
        return;
      }
      const inRange = dHoop <= effShootRange(h) + 0.3;
      const push = clockPush(game, 0.5);
      // クローズアウトを攻める: ハンドルを持つシューターは飛び込む守備者を抜き去る。
      const od = game.onBallDefender(h);
      if (od && !od.airborne && dDef < 2.3 && od.curSpd > od.runSpeed * 0.5
          && canIso(game, h, dHoop) && rate(h.attr.handling) > 0.45
          && chance(clamp(0.28 + rate(h.attr.handling) * 0.4 + rate(h.attr.agility) * 0.3
              - rate(od.attr.balance) * 0.4, 0.1, 0.7))) {
        h.driveSide = game.pickSide(h); h.beatenT = rand(0.5, 0.8);
        od.applyReactLag();
        game.setDriveSide(h); return;
      }
      const isThreeL = dHoop > THREE_DIST;
      const open = dDef > (h.has("isoShooter") ? 1.3 : 1.5);
      const pS = clamp(0.42 + rate(h.attr.aggression) * 0.2 + (dDef - 1.5) * 0.22
        + (isThreeL ? tac.threeBias * 0.2 * twWeight(h) : 0.12) + push * 0.4, 0.06, 0.95);
      if (inRange && open && chance(pS)) { shoot(game, h, dHoop, dDef); return; }
      if (pass(game, h)) return;
      game.setDrive(h, rimFloor, Math.min(4.5, Math.max(dHoop, 1.2)));
      return;
    }

    // ビッグ/ポスト能力者はポストで勝負: 守備者をリムまで押し込む。
    // 強くボディアップ or 良い形が空けばキックアウト。
    if (game.isBig(h) || h.has("post")) {
      if (dDef < 1.1 && chance(0.3)) {
        const better = betterOptionAvailable(game, h);
        if (better && passToReceiver(game, h, better)) return;
      }
      if (dHoop > 6 && chance(dHoop > 10 ? 0.85 : 0.45) && pass(game, h)) return;
      postMove(game, h);
      return;
    }

    // 残クロックに対する相対しきい値(SHOT_CLOCK 依存)で「打ち急ぎ」に入る。
    const urgent = game.shotClock < SHOT_CLOCK * (0.42 + tac.pace * 0.14 * twWeight(h));
    // 打ち急ぎ圏でギャザーが間に合わない → レイアップを狙ってリムへ切り込む
    if (urgent && game.shotClock > 0.8 && wontLoadUp(h, dHoop, dDef)) {
      driveDecision(game, h);
      return;
    }
    if (urgent && canGather && !wontLoadUp(h, dHoop, dDef) && !denySmother(game, h, dDef)) {
      // 打ち急ぎでも深い3は投げ捨てない: 1秒以上あればラインへ寄る。
      if (dHoop > effShootRange(h) + 0.6 && game.shotClock > 1.0) { game.setDrive(h, rimFloor, THREE_DIST + 0.2); return; }
      shoot(game, h, dHoop, dDef);
      return;
    }

    // 各行動をしたい度合い = 性格 + スキル + 戦術(×連携) + 得点ロール
    // + 特殊能力 (ドリブラー/ストライカー/ドリブルキープ)
    const tw = twWeight(h);
    let driveDesire = rate(h.attr.aggression) * 0.35 + rate(h.attr.handling) * 0.25 + tac.driveBias * 0.4 * tw;
    if (h.has("driver")) driveDesire += 0.25;        // ドリブラー: 抜き去りを狙う
    let shootDesire = rate(h.attr.aggression) * 0.4 + prio * 0.4 + tac.pace * 0.2 * tw;
    if (h.has("striker")) shootDesire += 0.15;       // ストライカー: スコアラーの心構え
    if (h.has("keepDribble")) shootDesire -= 0.08;   // キープ型は攻め急がない
    let passDesire = (1 - rate(h.attr.aggression)) * 0.25 + rate(h.attr.passAcc) * 0.2
      + tac.ballMovement * 0.4 * tw + (1 - prio) * 0.25; // 優先度が低い者ほど手放す

    // ペイント内: 連携が低い選手ほど「自分で決める」を優先 — ドライブ/フィニッシュ
    // 意欲を上げ、キックアウト意欲を下げる。
    if (dHoop <= 4.3 && Math.abs(h.pos.x) <= 2.6) {
      const selfish = (1 - rate(h.attr.teamwork)) * 0.4;   // 連携100→+0, 連携0→+0.4
      driveDesire += selfish;
      shootDesire += selfish;
      passDesire = Math.max(0, passDesire - selfish * 1.2);
    }

    const laneOpen = laneClear(game, h, rimFloor);
    const beaten = h.beatenT > 0;
    const isThree = dHoop > THREE_DIST;

    // 射程内でリムへの道が開けている → 通常は攻める。ただしキック or
    // エリートシューターの完全オープンは除く。
    if ((beaten || laneOpen) && dHoop <= 9) {
      if (!beaten && isThree && dDef > 2.0 && rate(h.attr.threeAcc) > 0.65
          && dHoop <= effShootRange(h) + 0.3           // 効き射程内(深い3はエリートのみ)
          && chance(0.25 + tac.threeBias * 0.4 * tw)) { shoot(game, h, dHoop, dDef); return; }
      const driveChance = beaten ? 1 : clamp(0.35 + driveDesire * 0.55, 0.25, 0.95);
      if (chance(driveChance)) { driveDecision(game, h); return; }
      if (chance(passDesire * 0.7) && pass(game, h)) return;
      driveDecision(game, h);
      return;
    }

    // 綺麗なレーン無し: オープンな形は打ち、難しい形はより高い得点オプションへ回す。
    if (dHoop <= effShootRange(h) + 0.3) {
      // 1対1シュート: 単独の守備者の上からなら喜んで打つ
      const open = dDef > (h.has("isoShooter") ? 1.4 : 1.7);
      // クロック連動の撃ち急ぎ: 残クロックが減るほどオープンな射程内の球は打つ。
      const push = clockPush(game, 0.6);
      let pShoot = 0.20 + shootDesire * 0.55 - (dHoop - 2) * 0.04 + (dDef - 1) * 0.3 + push * 0.5;
      if (isThree) pShoot += tac.threeBias * 0.22 * tw - 0.05;
      pShoot = clamp(pShoot, 0.03, 0.96);
      if (open && chance(pShoot)) { shoot(game, h, dHoop, dDef); return; }

      // クローズアウトしてくる守備者をステップバックで罰する: 抜き去るか綺麗な空間で打つ
      if (!open && dDef < 1.5 && canIso(game, h, dHoop) && h.jukeT <= 0
          && (rate(h.attr.midAcc) > 0.55 || rate(h.attr.threeAcc) > 0.6)
          && chance(clamp(0.05 + rate(h.attr.dribbleAcc) * 0.14 + rate(h.attr.agility) * 0.1, 0, 0.32))) {
        const d = game.onBallDefender(h);
        if (d) { stepBack(game, h, d, dHoop); return; }
      }

      // 綺麗な形でない → スコアラーはドリブルから攻める(本物のアイソ)。
      if (canIso(game, h, dHoop) && chance(clamp(0.2 + driveDesire * 0.5, 0.08, 0.7))) {
        driveDecision(game, h); return;
      }

      // 難しいシュート → より良い(オープンな)得点オプションへ回すことを探す
      const better = betterOptionAvailable(game, h);
      if (better && passToReceiver(game, h, better)) return;

      if (chance(pShoot)) { shoot(game, h, dHoop, dDef); return; } // でなければ自分を信じて打つ
    }
    // 射程外(または打つのを見送った): ドリブルから攻める、さもなければ動かす、
    // さもなければ探ってリセット。クロックが減るとドライブ欲が上がる。
    const clockCommit = clockPush(game, 0.6); // 序盤0 .. 終盤1
    if (canIso(game, h, dHoop) && chance(clamp(driveDesire * 0.45 + clockCommit * 0.75, 0, 0.95))) {
      driveDecision(game, h); return;
    }
    const passUrge = clamp((passDesire * 0.6 + (dDef < 1.3 ? 0.2 : 0)) * (1 - clockCommit * 0.85), 0, 0.85);
    if (chance(passUrge) && pass(game, h)) return;
    // クロックが逃げているのにまだ仕掛けていない → リセットをやめて行く
    if (game.shotClock < SHOT_CLOCK * 0.5 && canIso(game, h, dHoop)) { driveDecision(game, h); return; }
    // まだ運び上げ中 → サイドのレーンを運ぶ。フロントコートではリセットの探り。
    if (!game.frontT) bringUpLane(game, h);
    else game.setDrive(h, rimFloor, Math.min(4.5, Math.max(dHoop, 1.2)));
  }
