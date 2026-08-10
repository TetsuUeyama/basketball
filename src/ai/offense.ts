// オフェンスの状況判断エンジン（方式B: GameState 集約）。ボールを持った選手の
// 意思決定（decide）とドライブ実行（driveDecision）、およびその補助を関数として集約。
// 状態は Game に集約し、各関数は第一引数 game を受け取る。
// pickSide/setDriveSide/setDrive は Game 側に残置し game.X 経由で呼ぶ。
import { Vector3 } from "@babylonjs/core";
import { Player } from "../objects/player/player";
import { COURT, THREE_DIST, SHOT_CLOCK, PALM_HITBOX, MAX_PASS, BUZZER_WINDOW } from "../config";
import { rate, clamp, dist2D, dist2DTo, moveToward2D, chance, rand, dirTo2D, segPerp } from "../util";
import { twWeight, gatherFor, effShootRange, wontLoadUp, reactionLag, palmRadius, jukeDeception, jukeDiscipline, shotThreat, burstTime } from "../eval";
import { denySmother } from "./defense";
import { pass, passToReceiver, chooseReceiver } from "../move/action/passing";
import { updateOffBallMotion } from "./offball";
import { shoot, finishAtRim } from "../move/action/shooting";
import { laneVetoed, passRisk } from "../move/reaction/pass-risk";
import { doubleTeamed } from "./reads";
import type { Game } from "../game";

// ダブルチーム記憶: 直近でトラップに遭った選手を no-feed 対象に保つ秒数
const TRAP_MEMORY = 2.5;
// この D精度未満のハンドラーはドリブルで抜け（クロスオーバー/ブロウバイ/ポスト）を
// 仕掛けられず、キープ（シールド/にじり寄り/味方へ渡す）のみ
const KEEP_DRIBBLE_THRESH = 0.55;

// クロック逼迫度: ショットクロックが SHOT_CLOCK*frac を切ってからの経過割合(0..1)。
function clockPush(game: Game, frac: number): number {
  const w = SHOT_CLOCK * frac;
  return clamp((w - game.shotClock) / w, 0, 1);
}

export function runOffense(game: Game, dt: number, h: Player): void {
    // 空中でリバウンドを掴んだ直後: 着地を待たず、そのままプットバック/アウトレットへ。
    if (h.reboundGo) {
      h.reboundGo = false;
      reboundAirAction(game, h);
      if (game.ballMode !== "held") return;   // 撃った/投げた → このtickは終了
    }
    const team = h.team;
    const rimFloor = game.attackFloor(team);
    const dHoop = dist2D(h.pos, rimFloor);
    const dDef = game.nearestDefenderDist(h);

    // オフボールの選手はモーションを走る(カット/ギブ&ゴー/ペリメーターの動き)
    updateOffBallMotion(game, dt, team, h);

    // ハンドラーの意思決定 — 高い攻判断ほどフロアを速く読む
    h.decisionT -= dt;
    if (h.decisionT <= 0) {
      // 次の行動はボールが手に戻った時にのみ START できる。仕掛け中の move /
      // デッドクロックは対象外(ボールは既に手にある)。
      const committed = h.beatenT > 0 || h.powerT > 0 || h.jukeT > 0;
      if (!committed && !game.ballInHand(h) && game.shotClock > 1) {
        h.decisionT = 0.02;   // 保留 — 手に戻ったら動く
      } else {
        h.decisionT = rand(0.25, 0.45) * (1.35 - rate(h.attr.offense) * 0.7);
        decide(game, h, dHoop, dDef, rimFloor);
      }
    }

    // 移動: 仕掛けた1対1の move の展開。D速度 が最高速の保持率を決め、
    // 前に押し出したボールは少し加える。
    let mult = 0.84 + rate(h.attr.dribbleSpd) * 0.18;
    // 床のボールをすくい上げている間は屈んでいる — 滑って移動しない
    if (h.scoopLoad > 0.05) mult *= clamp(1 - h.scoopLoad * 1.3, 0, 1);
    if (dHoop > 0.5) {
      const frontness = (h.carryX * (rimFloor.x - h.pos.x) + h.carryZ * (rimFloor.z - h.pos.z)) / dHoop;
      mult *= 1 + clamp(frontness, 0, 0.6) * 0.1;
    }
    if (h.jukeT > 0) {
      // ドリブルの move を実行中 — 守備者を揺さぶるフットワーク
      // (ジャブステップイン、サイドステップ、ステップバック)
      h.jukeT = Math.max(0, h.jukeT - dt);
      moveToward2D(h.pos, h.jukeTarget.x, h.jukeTarget.z, h.accelToward(dt, h.jukeTarget.x, h.jukeTarget.z, 0.95) * dt);
    } else if (h.beatenT > 0) {
      // SPEED 抜き去り: 抜かれた守備者を突き抜けてリムへバースト
      h.beatenT = Math.max(0, h.beatenT - dt);
      mult *= 1.12 + rate(h.attr.agility) * 0.14;        // 速いハンドラーほど強くバースト
      // バーストは復帰中の守備者の、抜いた側の肩を抜いていく — 決して胸を通らない
      let btx = h.driveTarget.x, btz = h.driveTarget.z;
      const bd = game.onBallDefender(h);
      if (bd && dist2D(h.pos, bd.pos) < 1.7
          && dist2D(bd.pos, rimFloor) < dist2D(h.pos, rimFloor)) {
        const dx = rimFloor.x - h.pos.x, dz = rimFloor.z - h.pos.z;
        const dl = Math.hypot(dx, dz) || 1;
        const lx = -dz / dl, lz = dx / dl;               // 横方向、driveSide の空間
        btx = bd.pos.x + lx * h.driveSide * 1.05 + (dx / dl) * 0.5;
        btz = bd.pos.z + lz * h.driveSide * 1.05 + (dz / dl) * 0.5;
      }
      moveToward2D(h.pos, btx, btz, h.accelToward(dt, btx, btz, mult) * dt);
    } else if (h.powerT > 0) {
      // POWER ドライブ: 逆側の肩を守備者に当て、力比べで押し込む。前進は遅いが、
      // 衝突ステップが弱い相手を押し戻す。
      h.powerT = Math.max(0, h.powerT - dt);
      mult *= 0.5 + rate(h.attr.balance) * 0.35;         // 強い = 接触を通しても押し進み続ける
      moveToward2D(h.pos, h.driveTarget.x, h.driveTarget.z, h.accelToward(dt, h.driveTarget.x, h.driveTarget.z, mult) * dt);
      powerShove(game, h, dt);                           // 肩で押し戻す / 空いた手のボールを狙われる
      if (game.ballMode !== "held") return;              // はたき出された
      // 物理的な壁: ボディアップした守備者が力比べに勝つと、ドライブを完全に止める。
      const dm = game.onBallDefender(h);
      // 押し戻しゾーン: ドライブを壁で止められる距離 = 手のひらヒットゾーン
      // (def − off でサイズ決定)。無効時は 0.95m 接触にフォールバック。
      const wallR = PALM_HITBOX && dm ? clamp(palmRadius(dm, h) * 0.62, 0.6, 1.5) : 0.95;
      if (dm && dist2D(h.pos, dm.pos) < wallR) {
        const overlap = PALM_HITBOX ? clamp(1 - dist2D(h.pos, dm.pos) / wallR, 0, 1) : 1;
        // 構えた強靭な守備者(ボディバランス + 守判断)がドライブを止める。
        // ハンドラーの強さ(とポスト)は止めにくくする。
        const stop = rate(dm.attr.balance) * 0.85 + rate(dm.attr.defense) * 0.2
          - rate(h.attr.balance) * 0.75 - (h.has("post") ? 0.15 : 0);
        if (chance(clamp(stop, 0, 0.85) * dt * 2.5 * (0.55 + overlap * 0.9))) {
          h.powerT = 0;
          h.postT = 0;                                   // 背負い終了(壁で止められた)
          h.stalledT = rand(0.3, 0.5);                   // 壁で止められた
          dm.defWin("stop");                             // 踏ん張った
        }
      }
    } else if (h.stalledT > 0) {
      // 壁で止められた: ハンドラーはボールを引き戻す。
      h.stalledT = Math.max(0, h.stalledT - dt);
      game.setDrive(h, rimFloor, dist2D(h.pos, rimFloor) + 0.5); // リトリートドリブル
      moveToward2D(h.pos, h.driveTarget.x, h.driveTarget.z, h.accelToward(dt, h.driveTarget.x, h.driveTarget.z, 0.5) * dt);
    } else if (usingScreen(game, h)) {
      // ピック&ロール連携: 味方が掛けているスクリーンを使いに行く。スクリーナーの
      // ドライブ側を回ってリムへ向かい、守備者をピックに通す。
      const scr = activeScreener(game, h)!;
      const { ux, uz } = dirTo2D(h.pos.x, h.pos.z, rimFloor.x, rimFloor.z);
      const lx = -uz * h.driveSide, lz = ux * h.driveSide;
      const tx = scr.pos.x + lx * 0.7 + ux * 0.4;   // スクリーナーの脇を抜けてリム方向
      const tz = scr.pos.z + lz * 0.7 + uz * 0.4;
      moveToward2D(h.pos, tx, tz, h.accelToward(dt, tx, tz, mult) * dt);
    } else {
      // move の合間の探るドリブル。押し込むビッグは押し合いを続け、
      // それ以外はレーン内の体を回り込む。
      const imp = driveImpeder(game, h);
      const posting = game.isBig(h) || h.has("post");
      let tx = h.driveTarget.x, tz = h.driveTarget.z;
      if (imp && posting) {
        const edge = clamp(rate(h.attr.balance) - rate(imp.attr.balance)
          + (h.has("post") ? 0.12 : 0), -0.6, 1);
        const base = game.isBig(h) ? 0.34 : 0.38;
        mult *= clamp(base + edge * 0.6, 0.2, 0.95);
      } else {
        const av = game.steerAround(h, tx, tz, true);
        tx = av.x; tz = av.z;
        if (imp) mult *= 0.8;   // 体のすぐ横をかすめて抜けてもタダではない
      }
      // キープドリブル: マークされた下手なハンドラーはじりじりとしか進めない
      if (h.keepShieldT > 0) mult = Math.min(mult, 0.28);
      moveToward2D(h.pos, tx, tz, h.accelToward(dt, tx, tz, mult) * dt);
    }
    game.clampCourt(h.pos);
    // フロントコートを確立したら、ハンドラーはハーフウェイを越えて戻ってはいけない
    if (game.frontT) {
      const s = game.attackSign(h.team);
      if (h.pos.z * s < 0.05) h.pos.z = 0.05 * s;
    }
  }

  // 押し込むドリブルの1フレーム。
  // (1) ボディバランスの差ぶんだけ担当守備者をリム方向へ押し戻す（差が大きいほど深く）。
  // (2) ボールは押している肩と反対＝空いた手にあるので、担当**以外**の寄せに晒される。
  //     はたかれるかは技術(handling)で決まる。
export function powerShove(game: Game, h: Player, dt: number): void {
    const dm = game.onBallDefender(h);
    const { ux, uz } = dirTo2D(h.pos.x, h.pos.z, h.driveTarget.x, h.driveTarget.z);
    if (dm && dist2D(h.pos, dm.pos) < 1.15) {
      // ボディバランス差が押し込み速度を決める。実分布では差が±0.11しかないのでゲインを掛ける
      // (差なし=拮抗してほぼ動かない / 差0.11=約0.8m/s)。負なら逆に押し返される。
      const edge = (rate(h.attr.balance) - rate(dm.attr.balance)) * 7.0
        + (h.has("post") ? 0.25 : 0);
      const push = clamp(edge, -0.4, 1.2) * dt;
      if (push > 0) {
        dm.pos.x += ux * push; dm.pos.z += uz * push;
        game.clampCourt(dm.pos);
        // 押されている側は土台を失う: 反応も踏ん張りもできず、押される方向に流されるだけ。
        // 崩れている長さも力の差で決まる — 踏ん張れる守備者ほど一瞬で立て直す。
        dm.shovedT = Math.max(dm.shovedT, clamp(0.10 + edge * 0.35, 0.06, 0.45));
        dm.leanAxisX = ux; dm.leanAxisZ = uz;
        dm.lean = clamp(dm.lean + edge * dt * 3, -1, 1);   // 押される方向へ体が反る
      } else {
        // 守備が上回る: 守備者は踏ん張り、押し返されるのはハンドラーの方(リムから遠ざかる)。
        h.pos.x += ux * push; h.pos.z += uz * push;
        game.clampCourt(h.pos);
      }
    }
    // 空いた手のボールへ、担当以外が寄って突く
    for (const dd of game.teamPlayers(1 - h.team)) {
      if (dd === dm || dd.airborne || dd.landT > 0) continue;
      if (dist2D(dd.pos, h.pos) > 1.3) continue;
      const swipe = 0.30 + rate(dd.attr.defense) * 0.75 + rate(dd.attr.reaction) * 0.55
        - rate(h.attr.handling) * 1.35;                  // 技術が高いほどかわす
      if (chance(clamp(swipe, 0.05, 1.2) * dt)) { game.steal(dd); return; }
    }
  }

  // 空中で確保したリバウンドを、着地を待たずに処理する。プットバック(リムへフィニッシュ)
  // か、アウトレット/キック(良い相手が居れば即リリース)。どちらも不成立なら held のまま
  // 着地し、通常オフェンスへ委ねる。reboundPutback は secureLoose が判定済み。
function reboundAirAction(game: Game, h: Player): void {
    if (h.reboundPutback) {
      finishAtRim(game, h, game.nearestDefenderDist(h));
      return;
    }
    // 空中からのアウトレットはジャンプパス(頭上リリース)。通常のジャンプパスと同じ経路。
    const target = chooseReceiver(game, h);
    if (target) passToReceiver(game, h, target, false, "jump");   // 通らなければ着地
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

  // より余裕のある側(−1 左 / +1 右) — 味方が少ない側。
export function openSide(game: Game, h: Player): number {
    let l = 0, r = 0;
    for (const p of game.teamPlayers(h.team)) {
      if (p === h) continue;
      if (p.pos.x < -0.5) l++; else if (p.pos.x > 0.5) r++;
    }
    return l <= r ? -1 : 1;
  }

  // ボールをウイングのレーンでフロントコートへ運び上げる。中央から外れていれば
  // その側を保ち、ど真ん中からは空いた側を選ぶ。
  // 運び上げを支える最良のハンドラー候補: 自分以外の非ビッグの最良プレイメイカー(=ガード)。
export function supportHandler(game: Game, h: Player): Player | null {
    let best: Player | null = null, bs = -Infinity;
    for (const p of game.teamPlayers(h.team)) {
      if (p === h || game.isBig(p)) continue;
      if (p.playmaking > bs) { bs = p.playmaking; best = p; }
    }
    return best;
  }

export function bringUpLane(game: Game, h: Player): void {
    const s = game.attackSign(h.team);
    const side = Math.abs(h.pos.x) > 1.5 ? Math.sign(h.pos.x) : openSide(game, h);
    // 目標をフロントコート(トップ付近)まで遠くに固定して連続的に運ぶ。近い点にすると
    // 決定間隔(~0.3s)ごとに目標へ届いて止まり「歩いて止まって」のかくつきになるため、
    // 常に十分前方を目標にして滑らかに運ぶ(走っても止まらず歩いてもOK)。
    const tz = game.attackFloor(h.team).z - s * 8;   // フロントコートのトップ付近
    h.driveTarget.set(side * 5.5, 0, tz);
  }

  // まだ形成中のダブルチーム — 2人目がローテート中でまだ発動していない。
  // 近づいてくるヘルプ守備者を返す。トラップが無ければ null。
export function doubleTeamApproaching(game: Game, h: Player): Player | null {
    const opps = game.teamPlayers(1 - h.team);
    // まずオンボール守備者が実際に圧をかけていること
    let onD = Infinity;
    for (const d of opps) { const dd = dist2D(d.pos, h.pos); if (dd < onD) onD = dd; }
    if (onD > 2.6) return null;
    // ハンドラーへ向かって突っ込んでくる2人目 = 閉じるトラップ
    for (const d of opps) {
      const dx = h.pos.x - d.pos.x, dz = h.pos.z - d.pos.z;
      const dd = Math.hypot(dx, dz) || 1;
      if (dd <= onD + 0.05) continue;             // それはオンボール守備者本人
      if (dd < 1.9 || dd > 4.5) continue;         // 既にトラップ済み(<1.9) / 寄せるには遠すぎる
      const sp = Math.hypot(d.velX, d.velZ);
      if (sp < 0.7) continue;                     // 近くに立っているだけでなく動いていること
      const closing = (dx * d.velX + dz * d.velZ) / (dd * sp); // 1 = 真っ直ぐ彼へ全力疾走
      if (closing > 0.5) return d;
    }
    return null;
  }

export function betterOptionAvailable(game: Game, h: Player): Player | null {
    let best: Player | null = null;
    let bestPrio = h.offPriority + 0.1;          // 意味のあるほど良いオプションであること
    for (const p of game.teamPlayers(h.team)) {
      if (p === h || p.offPriority <= bestPrio) continue;
      if (p === game.assistFrom && game.assistTo === h && !p.cutting) continue; // ピンポン禁止
      if (dist2D(h.pos, p.pos) > MAX_PASS) continue;            // 射程外
      if (game.frontT && game.attackSign(h.team) * p.pos.z < 0.4) continue; // バックコート
      if (game.nearestDefenderDist(p) < 2.0) continue;          // 実際にはオープンでない
      if (doubleTeamed(game, p) || p.trappedT > 0) continue;      // (直近の)トラップへ決して戻さない
      if (p.justPassedT > 0) continue;                           // 彼は今手放した — ピンポン禁止
      if (laneVetoed(game.oppTeam(h), h, p) || passRisk(game.oppTeam(h), h, p) > 0.25) continue; // レーン無し
      bestPrio = p.offPriority;
      best = p;
    }
    return best;
  }

  // マークされた下手なハンドラー(低 D精度)はキープするしかない。
  // フロントコートで守備者が付き、クロックに余裕がある時に真。
export function mustKeepDribble(game: Game, h: Player, dDef: number): boolean {
    if (!game.frontT) return false;                          // 運び上げは別所で処理
    if (dDef > 1.8) return false;                            // 誰も付いていない → 自由にドリブル
    if (game.shotClock < 4) return false;                    // クロック切れ間近 → 得点を試みねば
    // フィジカル型(ビッグ/post)はゴール下では背中で押し込んで勝負する。ハンドリングが
    // 低くてもシールド/組み立て回避に回さず、ポストアップ(体で押す)へ通す。
    if ((game.isBig(h) || h.has("post")) && dist2D(h.pos, game.attackFloor(h.team)) < 6.5) return false;
    return rate(h.attr.dribbleAcc) < KEEP_DRIBBLE_THRESH;    // 本当に下手なハンドルのみ
  }

  // マークされた下手なハンドラーのキープ専用の選択肢: 渡す/じりじり前進/保持してシールド。
export function keepDribbleDecide(game: Game, h: Player, dHoop: number, dDef: number, rimFloor: Vector3): void {
    // ダブルチーム: ハンドルの低い選手は組み立てに加わらない — 抱え込まず即捌く。
    // 開いた味方へパス → 無ければトラップが空けた味方へキックアウト → それも無ければ
    // 圧から一歩引いて立て直す(リム方向へにじり寄らない)。
    if (doubleTeamed(game, h)) {
      if (pass(game, h)) return;
      if (trapKickOut(game, h)) return;
      retreatFromTrap(game, h);
      return;
    }
    // 僅かな隙間があるリム際 → それでも決める(イージーな一本は決して断らない)
    if (dHoop < 2.0 && dDef > 0.85) { finishAtRim(game, h, dDef); return; }
    // ヘルプが来た → 即座に手放す
    if (pass(game, h)) return;
    // さもなければキープ: ほぼ保持&シールド、時々リムへじりじり寄る
    if (chance(0.3) && dHoop > 1.9) {
      game.setDrive(h, rimFloor, Math.max(1.7, dHoop - 0.5));  // ゆっくり守りながら一歩入る
    } else {
      game.setDrive(h, rimFloor, dHoop);                       // 保持: 目標 ≈ 現在地 → 前進なし
    }
    h.keepShieldT = 0.5;   // ドリブルを這うほどに絞り + 体を斜めに(移動 + 向き)
  }

  // ビッグが相手を押し込む: 背中で守備者を押し下げてリムへ迫る(クロスオーバー/フェイント無し)。
  // ハンドリング非依存 — 接触の強さ=ボディバランス(balance)+postが押し込み・逆押し込みを支配する。
export function postMove(game: Game, h: Player): void {
    const rim = game.attackFloor(h.team);
    const d = game.onBallDefender(h);
    const dRim = dist2D(h.pos, rim);
    // 背負い成立(守備者が自分とリムの間に密着)なら power で背中から押し込む。既存の powerT
    // 前進+壁判定を再利用: 押し込めれば前進しフィニッシュ圏へ、押し負ければ壁で止まり
    // stalledT へ(キック/リトリート)。押し込みの強さ/長さは物理優位(edge)でスケール。
    if (d && dRim > 1.7 && dRim < 6.5 && h.powerT <= 0 && h.stalledT <= 0
        && dist2D(h.pos, d.pos) < 1.5 && dist2D(d.pos, rim) < dRim) {
      const edge = clamp(rate(h.attr.balance) * 0.55 + (h.has("post") ? 0.2 : 0)
        - rate(d.attr.balance) * 0.5 - rate(d.attr.defense) * 0.15, -0.6, 1);
      h.driveSide = game.pickSide(h);
      h.powerT = rand(0.5, 0.85) * (1 + Math.max(0, edge) * 0.5);
      h.postT = h.powerT;   // 背負い(バックダウン)アニメ: 背中をリムへ向けてバックペダル
      game.setDrive(h, rim, Math.max(1.0, dRim - 1.6));   // リムへ一歩押し込む
      return;
    }
    h.driveTarget.set(rim.x, 0, rim.z);   // 背後に守備者無し/至近 → そのままリムへ
  }

  // 運び上げてくるガードへボールを渡す: 射程内で覆われていない時のみ。
export function outletTo(game: Game, h: Player, g: Player): boolean {
    if (dist2D(h.pos, g.pos) > MAX_PASS) return false;
    if (game.nearestDefenderDist(g) < 1.2) return false;   // まだ覆われている — 待つ
    return passToReceiver(game, h, g);
  }

  // まだアウトレットに空いたガードがいない → ビッグはトップオブザキーへ運び続ける。
  // アウトレットは決定tick毎に再チェックし、誰も空かなければ自分で運び上げる。
export function advanceSafely(game: Game, h: Player): void {
    // 結局運び上げるビッグも、中央でなくサイドのレーンを使う
    if (!game.frontT) bringUpLane(game, h);
    else game.setDrive(h, game.attackFloor(h.team), 8);   // フロントコートの、ほぼトップオブザキー
  }

  // トラップをパスで解決する: ダブルチームが空けた本当にオープンな味方へのみ通す。
  // 強制パスは通常のリスクゲートを飛ばすが、覆われた選手/レーン内の体へは強行しない。
export function trapKickOut(game: Game, h: Player): boolean {
    let best: Player | null = null, bestScore = 0;
    let bestVet = false;
    for (const mate of game.teamPlayers(h.team)) {
      if (mate === h) continue;
      if (dist2D(h.pos, mate.pos) > MAX_PASS) continue;
      // フロントコート確立後、まだハーフを越えていない味方へは返さない — オーバー&バック違反。
      // (後方の後追いは誰も見ておらず「最もオープン」に見えるので明示的に除外する)
      if (game.frontT && game.attackSign(h.team) * mate.pos.z < 0.4) continue;
      // トラップから別のトラップへキックしない — ダブルチームされた味方はスキップ
      if (doubleTeamed(game, mate) || mate.trappedT > 0) continue;
      const open = game.nearestDefenderDist(mate);
      if (open < 1.6) continue;                         // 本当にオープンな選手のみ
      // レーンに体が居てもバウンドパスが手の下を通る — 得点で少し損するだけ
      const vet = laneVetoed(game.oppTeam(h), h, mate);
      const score = open - passRisk(game.oppTeam(h), h, mate) * 2 - (vet ? 0.6 : 0);
      if (score > bestScore) { bestScore = score; best = mate; bestVet = vet; }
    }
    if (!best) return false;
    if (bestVet || chance(0.25)) {
      // 頭上が塞がれている(または気まぐれに) → バウンドパス: 手の下を突いて味方へ
      return passToReceiver(game, h, best, true, "bounce");
    }
    // 頭上が使える → 本物のジャンプパス: ダンク級に跳び、最高点から頭上を越す
    h.jump(0.5, 0.6);
    game.pendingPassTo = best;
    game.pendingPassT = 0.22;
    return true;
  }

  // トラップを回避する: オープンなフロアへリトリートドリブルしてダブルチームを破る。
  // 合法な進行方向をサンプリングし、実際に距離を稼げる方向を取る(中央/上方向へ少し偏らせる)。
export function retreatFromTrap(game: Game, h: Player): void {
    const defs = game.teamPlayers(1 - h.team).slice()
      .sort((a, b) => dist2D(a.pos, h.pos) - dist2D(b.pos, h.pos));
    const a = defs[0], b2 = defs[1] ?? defs[0];
    const s = game.attackSign(h.team);
    let bx = 0, bz = game.frontT ? s * 2 : 0;   // フォールバック: フロア中央へ向かう
    let bestScore = -Infinity;
    for (let i = 0; i < 12; i++) {
      const ang = (i / 12) * Math.PI * 2;
      const tx = h.pos.x + Math.cos(ang) * 3.0;
      const tz = h.pos.z + Math.sin(ang) * 3.0;
      if (Math.abs(tx) > COURT.halfW - 0.7 || Math.abs(tz) > COURT.halfL - 0.7) continue;
      if (game.frontT && s * tz < 0.5) continue;   // バックコートバイオレーションへは決して退かない
      const sep = Math.min(dist2DTo(a.pos, tx, tz), dist2DTo(b2.pos, tx, tz));
      let score = sep - Math.abs(tx) * 0.08;       // サイドラインから少し引く
      if (!game.frontT) score += s * (tz - h.pos.z) * 0.10;   // 運び上げ中: 前方への逃げを優先
      if (score > bestScore) { bestScore = score; bx = tx; bz = tz; }
    }
    h.driveTarget.set(bx, 0, bz);
  }

  // 速攻: 守備が整う前にリムへ強く押し込む。ウイングがリム付近でオープンなら
  // そこへ通してレイアップさせる。
export function pushBreak(game: Game, h: Player, dHoop: number): void {
    // ボールより前にいる走者がリムでオープン → 落とす
    const rim = game.attackFloor(h.team);
    let best: Player | null = null, bestGap = 1.6;
    for (const p of game.teamPlayers(h.team)) {
      if (p === h) continue;
      const dRim = dist2D(p.pos, rim);
      const ahead = game.attackSign(h.team) * (p.pos.z - h.pos.z) > 1.5;
      if (ahead && dRim < 4.5) {
        const g = game.nearestDefenderDist(p);
        if (g > bestGap) { bestGap = g; best = p; }
      }
    }
    if (best && dHoop > 3 && passToReceiver(game, h, best)) return;
    // さもなければ自分でリムを攻める(後ろの抜かれた守備者は止められない)
    if (dHoop < 1.9) { finishAtRim(game, h, game.nearestDefenderDist(h)); return; }
    game.setDrive(h, rim, 1.5);
  }

  // ハンドラーがドリブルで相手を抜ける状況にあるか: 近く、フロントコートで、
  // クロックに時間があること。
export function canIso(game: Game, h: Player, dHoop: number): boolean {
    if (dHoop > 9 || dHoop < 1.8) return false;
    if (game.shotClock < 3) return false;
    if (game.frontT && game.attackSign(h.team) * h.pos.z < 0.4) return false; // バックコート
    return true;
  }

  // 1対1の核心: どちらへ攻めるかを選び、フェイクで守備者の体重を誤った方向へ
  // 動かし、開いた隙を攻める。
export function driveDecision(game: Game, h: Player): void {
    const d = game.onBallDefender(h);
    if (!d) {
      // 前に誰もいない — 側を選んで真っ直ぐ入るだけ
      h.comboN = 0;
      h.driveSide = game.pickSide(h);
      h.beatenT = Math.max(h.beatenT, rand(0.4, 0.7));
      game.setDriveSide(h);
      return;
    }
    d.reactT = reactionLag(d);    // どんな move も反応を強いる

    // ドリブルで相手を抜く2通り、有利な方で攻める:
    //  • SPEED — クロスオーバーでコーナーを回る
    //  • POWER — 肩を下げてリムへ力任せに押し戻す
    const speedEdge = rate(h.attr.handling) * 0.45 + rate(h.attr.agility) * 0.35
      + rate(h.attr.dribbleAcc) * 0.2 + (h.has("driver") ? 0.1 : 0)
      - (rate(d.attr.agility) * 0.62 + rate(d.attr.reaction) * 0.4
        + rate(d.attr.defense) * 0.55 + (d.has("manMark") ? 0.12 : 0));
    // POWER は物理的な戦い — 押し込みながらボールを保つにはハンドルも要る。
    // 守備者は主にボディバランスに守判断を加えて抵抗する。
    const powerEdge = rate(h.attr.balance) * 0.55 + rate(h.attr.aggression) * 0.2
      + rate(h.attr.dribbleAcc) * 0.2 + rate(h.attr.handling) * 0.15 + (h.has("post") ? 0.15 : 0)
      - (rate(d.attr.balance) * 1.05 + rate(d.attr.defense) * 0.60);

    // 選手自身のツールがスタイルを決める: フィジカルな選手は力で割り込み、
    // 速くハンドルの高い選手はクロスオーバー。その後マッチアップが微調整する。
    const ownPower = rate(h.attr.balance) + rate(h.attr.aggression) * 0.5 + (h.has("post") ? 0.4 : 0);
    const ownSpeed = rate(h.attr.agility) + rate(h.attr.handling) * 0.7 + (h.has("driver") ? 0.4 : 0);
    // 押し込む間はボールが空いた手に出るので、担当以外が寄っていると狙われる。
    // 技術が低い選手は、目の前の相手しか居ない場面でしか選ばない。
    const helpers = game.defendersWithin(h, 2.4) - 1;
    const powerSafe = helpers <= 0
      || chance(clamp(rate(h.attr.handling) * 1.2 - helpers * 0.4, 0, 0.95));
    // ゴール下ほど、そして体の強い選手ほど押し込みを選ぶ(押し切ってイージーシュートにする)。
    const dRim = dist2D(h.pos, game.attackFloor(h.team));
    const rimPull = clamp((7.0 - dRim) / 5.0, 0, 1) * rate(h.attr.balance);
    const usePower = powerSafe && h.comboN === 0 && chance(clamp(0.62 + (ownPower - ownSpeed) * 0.6
      + (powerEdge - speedEdge) * 0.5 + rimPull * 0.55, 0.08, 0.96));   // コンボ途中はドリブルを続ける

    if (usePower) {
      // POWER: 守備者に肩を入れる。力比べに勝てば相手をリムまで押し戻し、
      // 負ければ壁で止められてリセットするしかない。
      h.driveSide = d.shadeSide !== 0 ? -d.shadeSide : game.pickSide(h);
      const pPower = clamp(0.72 + powerEdge * 1.0, 0.18, 0.94);   // 選んだら大抵は押し込みへ(止まるかは接触側で判定)
      if (chance(pPower)) {
        h.powerT = rand(0.55, 0.9) * (1 + Math.max(0, powerEdge) * 0.4);
        d.lean = clamp(d.lean * 0.4, -1, 1);             // 土台を崩された
      } else {
        h.stalledT = rand(0.35, 0.6);                    // 壁に当たった
      }
      game.setDriveSide(h);
      return;
    }

    // SPEED: ドリブルの move で守備者を揺さぶり、開いた隙を攻める。
    const jukeEdge = jukeDeception(h) - jukeDiscipline(d);
    const rim = game.attackFloor(h.team);
    const { ux, uz, len: rl } = dirTo2D(h.pos.x, h.pos.z, rim.x, rim.z);   // リムへ
    const latx = -uz, latz = ux;                                      // 横方向

    // 新規のアタック → ドリブルを計画: 上手いハンドラーは1..3の move を繋ぐ。
    // 序盤は純粋な揺さぶり、最後の move だけが戻れない側を抜いてバーストする。
    if (h.comboN === 0) {
      h.lastFakeDir = 0;
      let plan = 1;
      const pMore = clamp(0.25 + jukeDeception(h) * 0.55, 0.1, 0.8);
      if (chance(pMore)) plan++;
      if (plan > 1 && chance(pMore * 0.6)) plan++;
      h.comboN = plan;
    }
    const finalShake = h.comboN <= 1;

    // 正面の守備者を揺さぶる: ジャブステップイン or サイドステップ。準備の揺さぶりは
    // 左右交互、最後の move は傾きを読んで戻れない側を抜く。
    const stepIn = h.lastFakeDir === 0 && finalShake && chance(0.35);
    let fakeDir: number;
    if (finalShake) {
      // GO 側 = 手で重み付けした守備者の傾きの読み: 片手の選手は利き側に留まり、
      // 両手使いは傾きが与えるものを取る。
      const strong = h.strongSide();
      const beat = (side: number) => clamp(-d.lean * side, -1, 1);
      // 片手の選手を利き手から引き剥がすのは明確な過剰対応だけ
      const handEdge = (h.strongSideBias() - 0.5) * 3.2;   // 0 (両手) .. 約0.65
      const go = beat(strong) + handEdge >= beat(-strong) ? strong : -strong;
      fakeDir = -go;                       // 逆へ誘い込んでから、そこを攻める
    } else {
      fakeDir = h.lastFakeDir !== 0 ? -h.lastFakeDir : -game.pickSide(h);
    }
    let ox: number, oz: number, leanMag: number;
    if (stepIn) {
      ox = ux * 0.35; oz = uz * 0.35; leanMag = 0.7;               // リムへのジャブ
      d.applyReactLag(); // 彼は躊躇する
    } else {
      ox = latx * fakeDir * 0.45; oz = latz * fakeDir * 0.45; leanMag = 1.1; // サイドステップ
    }
    h.jukeT = rand(0.18, 0.3);
    h.jukeTarget.set(h.pos.x + ox, 0, h.pos.z + oz);
    game.clampCourt(h.jukeTarget);

    // 食いつくか？ 揺さぶり vs 規律が体重の振れ幅を決める
    const bite = clamp(0.3 + jukeEdge * 1.1, 0.03, 0.95);
    if (chance(bite)) {
      // 体重がまだ前のフェイクの反対側にあれば、戻りの振りが行き過ぎる
      const across = Math.max(0, -d.lean * fakeDir);
      d.lean = clamp(d.lean + fakeDir * (rand(0.5, 1.0) * leanMag + across * 0.8), -1, 1);
      d.leanAxisX = latx; d.leanAxisZ = latz;   // このデュエルの軸で仕掛けた
    }

    if (!finalShake) {
      // 準備の揺さぶりのみ — 生きたまま、次の move は逆方向から来る
      h.comboN--;
      h.lastFakeDir = fakeDir;
      return;
    }

    // GO move: 最後のフェイクの逆へ、彼の仕掛けた体重が戻れない側を攻める
    h.comboN = 0;
    const go = -fakeDir;
    h.driveSide = go;
    const wrongWay = clamp(-d.lean * go, 0, 1);
    const pBeat = clamp(0.49 + speedEdge * 1.2 + wrongWay * 0.45, 0.02, 0.95);
    if (chance(pBeat)) {
      // バーストはリムまで運ぶ。時間は詰めるべき距離にスケール。
      h.beatenT = burstTime(rl, speedEdge);
      d.applyReactLag();
      // 勢いが彼をさらに誤った方向へ運ぶ — 追い戻しは這うように始まる
      d.lean = clamp(d.lean + go * 0.3, -1, 1);
      d.leanAxisX = latx; d.leanAxisZ = latz;
    } else {
      h.stalledT = rand(0.3, 0.55);
    }
    game.setDriveSide(h);
  }

  // ステップバック: シュートにコンテストする守備者に対してドリブルから後退する。
  // 彼が前へ過剰反応すれば抜き去り、腰を落として留まればジャンパーの距離を得る。
export function stepBack(game: Game, h: Player, d: Player, dHoop: number): void {
    const rim = game.attackFloor(h.team);
    const away = dirTo2D(rim.x, rim.z, h.pos.x, h.pos.z);   // リムから離れる方向
    h.jukeT = rand(0.2, 0.32);
    h.jukeTarget.set(h.pos.x + away.ux * 0.7, 0, h.pos.z + away.uz * 0.7);
    game.clampCourt(h.jukeTarget);

    const threat = shotThreat(h);
    const edge = jukeDeception(h) - jukeDiscipline(d);
    const bait = clamp(0.2 + edge * 0.5 + threat * 0.25, 0.05, 0.82);
    if (chance(bait)) {
      // 彼が前へ突っ込んだ → ステップバックから抜き去る
      h.beatenT = burstTime(dHoop, edge);
      d.applyReactLag();
      d.lean = clamp(d.lean * 0.5, -1, 1);
      h.driveSide = game.pickSide(h);
      game.setDriveSide(h);                              // バーストはリムへ向かう
    } else {
      // 腰を落として留まった → クッションを保ち、次の判断でジャンパーを放たせる
      d.applyReactLag();
      h.driveTarget.copyFrom(h.jukeTarget);
    }
  }

  // このハンドラーのために今スクリーンを掛けている味方（居なければ null）。
export function activeScreener(game: Game, h: Player): Player | null {
    for (const q of game.teamPlayers(h.team)) if (q !== h && q.screening) return q;
    return null;
  }

  // ピックを使いに行くべきか: 味方がスクリーン中で、まだ近づいていない（連携で寄せる）。
export function usingScreen(game: Game, h: Player): boolean {
    const scr = activeScreener(game, h);
    return !!scr && dist2D(h.pos, scr.pos) > 1.0;
  }

  // 前方約1.2m以内で、ドライブ経路に真っ直ぐ立つ守備者。彼らの体の接触が
  // ボールハンドラーを減速させる。
export function driveImpeder(game: Game, h: Player): Player | null {
    const { ux, uz } = dirTo2D(h.pos.x, h.pos.z, h.driveTarget.x, h.driveTarget.z);
    for (const d of game.teamPlayers(1 - h.team)) {
      const rx = d.pos.x - h.pos.x, rz = d.pos.z - h.pos.z;
      const along = rx * ux + rz * uz;       // ドライブに沿ってどれだけ前方か
      if (along < 0 || along > 1.2) continue;
      const perp = Math.abs(rx * -uz + rz * ux);
      if (perp < 0.7) return d;
    }
    return null;
  }

  // ハンドラーからリムへの経路に守備者がいなければ true。
export function laneClear(game: Game, h: Player, rimFloor: Vector3): boolean {
    for (const d of game.teamPlayers(1 - h.team)) {
      const { t, perp } = segPerp(h.pos.x, h.pos.z, rimFloor.x, rimFloor.z, d.pos.x, d.pos.z);
      if (t <= 0.05 || t >= 1) continue;             // ハンドラーとリムの間ではない
      if (perp < 1.1) return false;                  // レーン内に守備者
    }
    return true;
  }
