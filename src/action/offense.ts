// オフェンスの状況判断エンジン（方式B: GameState 集約）。ボールを持った選手の
// 意思決定（decide）とドライブ実行（driveDecision）、およびその補助を関数として集約。
// 状態は Game に集約し、各関数は第一引数 game を受け取る。循環回避のため
// pickSide/setDriveSide/setDrive は Game 側に残置し game.X 経由で呼ぶ。
import { Vector3 } from "@babylonjs/core";
import { Player } from "../player";
import { COURT, THREE_DIST, SHOT_CLOCK, PALM_HITBOX, MAX_PASS } from "../config";
import { clamp, dist2D, dist2DTo, moveToward2D, chance, rand } from "../util";
import { twWeight, gatherFor, effShootRange, wontLoadUp, reactionLag, palmRadius, jukeDeception, jukeDiscipline } from "../eval";
import { rate } from "../attributes";
import { denySmother } from "./defense";
import { pass, passToReceiver } from "./passing";
import { updateOffBallMotion } from "./offball";
import { shoot, finishAtRim } from "./shooting";
import { laneVetoed, passRisk } from "../reaction/pass-risk";
import { doubleTeamed } from "../core/reads";
import type { Game } from "../game";

// ダブルチーム記憶: 直近でトラップに遭った選手を no-feed 対象に保つ秒数
const TRAP_MEMORY = 2.5;
// この D精度未満のハンドラーはドリブルで抜け（クロスオーバー/ブロウバイ/ポスト）を
// 仕掛けられず、キープ（シールド/にじり寄り/味方へ渡す）のみ
const KEEP_DRIBBLE_THRESH = 0.55;

export function runOffense(game: Game, dt: number, h: Player): void {
    const team = h.team;
    const rimFloor = game.attackFloor(team);
    const dHoop = dist2D(h.pos, rimFloor);
    const dDef = game.nearestDefenderDist(h);

    // オフボールの選手はモーションを走る(カット/ギブ&ゴー/ペリメーターの動き)
    updateOffBallMotion(game, dt, team, h);

    // ハンドラーの意思決定 — 高い攻判断ほどフロアを速く読む
    h.decisionT -= dt;
    if (h.decisionT <= 0) {
      // 次の行動はボールが手に戻った時にのみ START できる。下手なハンドラーの
      // 遅いドリブル(dribblePhase のリズム参照)はボールを長く床に残すので、彼は
      // 待つ — 速いハンドラーには決して無い一拍のもたつき。(仕掛け中の move /
      // デッドクロックは対象外 — ボールは既に手にある。)
      const committed = h.beatenT > 0 || h.powerT > 0 || h.jukeT > 0;
      if (!committed && !game.ballInHand(h) && game.shotClock > 1) {
        h.decisionT = 0.02;   // 保留 — ほぼ即座に再チェックし、手に戻ったら動く
      } else {
        h.decisionT = rand(0.25, 0.45) * (1.35 - rate(h.attr.offense) * 0.7);
        decide(game, h, dHoop, dDef, rimFloor);
      }
    }

    // 移動: 仕掛けた1対1の move がどう展開するか。D速度 がドリブル中に最高速の
    // どれだけを保てるかを決める。前に押し出したボールは少し加える(腰に収めた
    // ボールは何も加えない)。
    let mult = 0.84 + rate(h.attr.dribbleSpd) * 0.18;
    if (dHoop > 0.5) {
      const frontness = (h.carryX * (rimFloor.x - h.pos.x) + h.carryZ * (rimFloor.z - h.pos.z)) / dHoop;
      mult *= 1 + clamp(frontness, 0, 0.6) * 0.1;
    }
    if (h.jukeT > 0) {
      // ドリブルの move を実行中 — ドライブが決まる前に守備者を揺さぶる見える
      // フットワーク(ジャブステップイン、サイドステップ、ステップバック)
      h.jukeT = Math.max(0, h.jukeT - dt);
      moveToward2D(h.pos, h.jukeTarget.x, h.jukeTarget.z, h.accelToward(dt, h.jukeTarget.x, h.jukeTarget.z, 0.95) * dt);
    } else if (h.beatenT > 0) {
      // SPEED 抜き去り: 抜かれた守備者を突き抜けてリムへバースト
      h.beatenT = Math.max(0, h.beatenT - dt);
      mult *= 1.12 + rate(h.attr.agility) * 0.14;        // 速いハンドラーほど強くバースト
      // バーストは復帰中の守備者の、抜いた側の肩を抜いていく — 決して胸を通らない
      // (リムへ真っ直ぐ走ると、以前は体の衝突ステップで抜き去りが止まってしまった)
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
      // POWER ドライブ: 守備者に向かってリムへ真っ直ぐ押し込む。前進は遅いが、
      // 衝突ステップ(holdWeight²)が弱い相手を押し戻すので、強いハンドラーはゴールへ
      // 力で割り込み、弱い者は行き詰まる。
      h.powerT = Math.max(0, h.powerT - dt);
      mult *= 0.5 + rate(h.attr.balance) * 0.35;         // 強い = 接触を通しても押し進み続ける
      moveToward2D(h.pos, h.driveTarget.x, h.driveTarget.z, h.accelToward(dt, h.driveTarget.x, h.driveTarget.z, mult) * dt);
      // 物理的な壁: ボディアップした守備者が実際に力比べに勝つ(高い holdWeight —
      // 主にボディバランス)と、リムまで運ばれる代わりにドライブを完全に止める。
      // 弱い者は依然として力でこじ開けられる。
      const dm = game.onBallDefender(h);
      // 押し戻しゾーン: ドライブを壁で止められる距離 = 彼の手のひらヒットゾーン
      // (def − off でサイズ決定)。だから良い守備者ほど前進をより遠く、より固く
      // 押し戻す。無効時は従来の 0.95m 接触にフォールバック。
      const wallR = PALM_HITBOX && dm ? clamp(palmRadius(dm, h) * 0.62, 0.6, 1.5) : 0.95;
      if (dm && dist2D(h.pos, dm.pos) < wallR) {
        const overlap = PALM_HITBOX ? clamp(1 - dist2D(h.pos, dm.pos) / wallR, 0, 1) : 1;
        // 構えた強靭な守備者(ボディバランス, + 若干の守判断)は、仕掛けた力任せの
        // ドライブを完全に止められる。ハンドラー自身の強さ(とポストのフットワーク)は
        // 止めにくくする — 弱い守備者は力でこじ開けられるだけ
        const stop = rate(dm.attr.balance) * 0.85 + rate(dm.attr.defense) * 0.2
          - rate(h.attr.balance) * 0.75 - (h.has("post") ? 0.15 : 0);
        if (chance(clamp(stop, 0, 0.85) * dt * 2.5 * (0.55 + overlap * 0.9))) {
          h.powerT = 0;
          h.stalledT = rand(0.3, 0.5);                   // 動かせなかった — 壁で止められた
          dm.defWin("stop");                             // 踏ん張った — 構え/主張
        }
      }
    } else if (h.stalledT > 0) {
      // 壁で止められた: 守備者が踏ん張った — ハンドラーは抑え込まれ、ボールを
      // 引き戻さねばならず、テンポを一歩失う。
      h.stalledT = Math.max(0, h.stalledT - dt);
      game.setDrive(h, rimFloor, dist2D(h.pos, rimFloor) + 0.5); // リトリートドリブル
      moveToward2D(h.pos, h.driveTarget.x, h.driveTarget.z, h.accelToward(dt, h.driveTarget.x, h.driveTarget.z, 0.5) * dt);
    } else {
      // move の合間の探るドリブル。相手を押し込むビッグは押し合いを続ける
      // (バランス勝負がポストアップの肝)。それ以外はレーン内の体を読み、
      // 押し合いに真っ直ぐ突っ込んで衝突任せに処理させるのでなく、それを回り込む。
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
      // キープドリブル: マークされた下手なハンドラーはじりじりとしか進めない —
      // ドリブルが這うので押し進めない(ポストのゴリゴリ押しもこれで抑える)
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

    // ブザービーター: ゲーム/ショットクロックがほぼ無く、良い形を作る余地も無い —
    // どこからでも、どれだけ崩れていても放り上げる。shoot() は捨て身の距離に対し
    // 既に make% を下限化しているので、これは本当の神頼み。
    // ゲームブザー → 常に放る。ショットクロックブザー → 強い deny に完全に覆われて
    // いない限り放る(覆われていれば打てず、クロックが切れる = バイオレーション)。
    const gameBuzzer = game.gameClock > 0 && game.gameClock < 0.9;
    const shotBuzzer = game.shotClock < 0.45;
    // 深い一発は、それをギャザーするクロックが残っている時のみ放てる — 低い
    // L速度 の選手がアークのはるか後ろから放るにはワインドアップ時間が要るが
    // それが無いので、醜い深い神頼みの代わりにショットクロックが切れる(バイオ
    // レーション)。(クォーター終わりのゲームブザーは対象外: どんな捨て身も放り上げる。)
    const canGather = game.shotClock >= gatherFor(h, dHoop);
    if ((gameBuzzer || (shotBuzzer && canGather && !denySmother(game, h, dDef))) && dHoop > 1.8) {
      shoot(game, h, dHoop, dDef); return;
    }

    // ゴール至近でフリーで受けた: 迷わずフィニッシュ。ここから外へ持ち出して
    // ゴールに向き直る「時間をかける攻め」は不要 — マークが居ないなら即アタック。
    if (dDef > 1.0 && game.frontT) {
      if (dHoop <= 2.3) { finishAtRim(game, h, dDef); return; }
      if (dHoop <= 4.0 && laneClear(game, h, rimFloor)) { game.setDrive(h, rimFloor, 1.2); return; }
    }

    // ポゼッション交代: ボールは運び上げねばならず、それはガードの仕事。
    // フロントコートが整う前にボールを持ったPF/Cは、まずポイントガード、次に
    // シューティングガードを探し、自分でドリブルして運ぶのでなく渡す。
    // (オフェンスリバウンドは frontT を保つので、そこではビッグも依然リムで
    // フィニッシュする — これは運び上げ中のみ発動。)
    // (プレイメイキングビッグは対象外 — 自分で運び上げてオフェンスを回す、
    // ヨキッチ流)
    if (!game.frontT && game.isBig(h) && h.evalRole !== "プレイメイキングビッグ" && dHoop > 10) {
      // 最良のプレイメイカー2人が最初の候補(通常PG→SG — ただし指定された
      // メインハンドラーはどこでプレーしていても彼らを上回る)
      const guards = game.teamPlayers(h.team).filter((g) => g !== h)
        .sort((a, b) => b.playmaking - a.playmaking);
      for (const g of guards.slice(0, 2)) {
        if (outletTo(game, h, g)) return;
      }
      advanceSafely(game, h);                     // まだフリーのガード無し — 保持/流す、攻めない
      return;
    }

    // 速攻: ボールを持ったガード/ウイングとオープンなフロアなら、守備が整う前に
    // リムへ強く押し込む(ビッグは上で既にアウトレット済み)。
    if (game.pushT > 0) { pushBreak(game, h, dHoop); return; }

    // リム際 → フィニッシュ、ショットクロック切れ間近 → 一本放つ
    // リム際 → フィニッシュ。全力バーストで到達したハンドラーは早めに踏み切る —
    // ドライビングレイアップ/フローターは一歩外から放たれる
    if (dHoop < (h.beatenT > 0 ? 2.3 : 1.8)) { finishAtRim(game, h, dDef); return; }

    // 形成中のダブルチーム → 早めに手放す: ヘルプ守備者がトラップへローテート中で
    // まだ発動していない — 嵌まるのを待たず、今すぐ味方へボールを動かして打開する。
    // ハンドル(D精度)が悪いほど早く手放す(球離れ) — 下手なドリブラーはトラップの
    // 気配でほぼ毎回逃がし、確かなハンドラーは一拍長く割って出る自信を持つ。
    // (既に仕掛けた move はそのまま続行。安全なアウトレットが無ければ下へ抜ける。)
    const committing = h.beatenT > 0 || h.powerT > 0 || h.jukeT > 0;
    if (!committing && game.shotClock > 1 && doubleTeamApproaching(game, h)) {
      const bail = clamp(0.15 + (1 - rate(h.attr.dribbleAcc)) * 1.0
        + (1 - rate(h.attr.handling)) * 0.15, 0.12, 0.96);
      if (chance(bail) && pass(game, h)) return;
    }

    // 低 D精度、マークされている: 下手なボールハンドラーはドリブルで相手を抜けず、
    // ポストで押し込めもしない — キープしかできない。体を斜めに、ボールを後ろに
    // 隠し、彼の唯一の選択肢は: ヘルプに来た味方へ渡す、じりじり前進、保持。
    // クロスオーバー無し、抜き去り無し、ゴリゴリのポスト押し込み無し。
    if (mustKeepDribble(game, h, dDef)) { keepDribbleDecide(game, h, dHoop, dDef, rimFloor); return; }

    // 仕掛けた1対1の move が既に進行中 — 毎tick再決定するのでなく最後まで見届ける
    // (バースト/力任せのドライブが彼を運び、上のフィニッシュ判定がリムで終える)。
    // 毎tick再決定していたのが、以前ドライブが締まりなく見えた原因
    if (h.beatenT > 0 || h.powerT > 0 || h.jukeT > 0) return;
    // 壁で止められた: この局面は抑え込まれた — より良い形へキックアウトし、
    // さもなければ引き戻し続け(移動がリトリートを処理)、スタールが解けたら
    // 再アタックする
    if (h.stalledT > 0) { if (chance(0.5) && pass(game, h)) return; return; }

    // コンボ途中: 直前の揺さぶりで抜けなかったが守備者は揺れている —
    // 逆方向の次の move ですぐデュエルへ戻る
    if (h.comboN > 0) {
      if (canIso(game, h, dHoop)) { driveDecision(game, h); return; }
      h.comboN = 0;                        //状況が変わった — コンボを打ち切る
    }

    // 担当守備者が足を離した(早仕掛けのギャンブル、または食いついたフェイク) —
    // ボールを床に置いてフローターの脇を抜けていく。速く鋭いハンドラーはほぼ毎回
    // 罰し、遅い者は時に躊躇して機を逃す。(ドリブルからこれを突くのはショット
    // クリエイターだけ — スポットアップ/ディストリビューターが急にアイソはしない。)
    if (canCreate) {
      const od = game.onBallDefender(h);
      if (od && od.airborne && dDef < 2.2 && canIso(game, h, dHoop)
          && chance(0.45 + rate(h.attr.reaction) * 0.3 + rate(h.attr.handling) * 0.15)) {
        h.driveSide = game.pickSide(h);
        h.beatenT = rand(0.6, 0.9);
        od.reactT = Math.max(od.reactT, reactionLag(od));
        game.setDriveSide(h);
        return;
      }
      // クローズアウトを攻める: 制御を失った勢い(高い接近速度)でまだ飛び込んで
      // くる守備者は、真っ直ぐ抜き去れる — ハンドル(技術)とクイックネス(敏捷性)が
      // 上回り、彼のボディバランスこそが抜かれずに止まって腰を落とせる要素。
      // 遅くバランスの取れたクローズアウトは罰せられない。
      if (od && !od.airborne && dDef < 2.4 && od.curSpd > od.runSpeed * 0.55
          && canIso(game, h, dHoop)) {
        const edge = rate(h.attr.handling) * 0.4 + rate(h.attr.agility) * 0.35
          + rate(h.attr.dribbleAcc) * 0.25 - rate(od.attr.balance) * 0.5;
        if (chance(clamp(0.3 + edge, 0.08, 0.75))) {
          h.driveSide = game.pickSide(h);
          h.beatenT = rand(0.55, 0.85);
          od.reactT = Math.max(od.reactT, reactionLag(od));
          game.setDriveSide(h);
          return;
        }
      }
    }

    // 目の前の守備を抜けない（直前のドライブが止められた）: 単騎の壁でも
    // キックアウトの引き出し（ジャンプパス/バウンドパス）で打開を試みる
    if (h.stalledT > 0 && dDef < 1.6 && trapKickOut(game, h)) return;

    // ダブルチーム/トラップ: 本物のトラップはボールに2人とも密着して寄せた状態
    // (ハーフコートで常に起きる、区域内にゆるく2人いるだけ、ではない)。その時
    // だけトラップの読みが引き継ぐ。さもなければ通常の判断へ抜ける。正しい読みは
    // キックアウト(ダブルチームは味方をフリーにする)か、保持してリセット — 壁へ
    // 力任せに突っ込むのではない。
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
      // トラップを人に紐づけて記憶する。だから一時的に緩んだ後でもボールが
      // すぐそこへ戻されない(A→B→A のラリーを潰す)
      if (tight >= 2) h.trappedT = TRAP_MEMORY;
      // 本物のトラップ: 1.6m以内に2人、かつ実際のオンボール圧(dDef が密着)
      if (tight >= 2 && dDef < 1.4) {
        // ドリブルからトラップを割る。指定スラッシャー — スラッシャー特殊能力
        // ("driver") または スラッシャーのオフェンスロール(offAction "slash") —
        // は進んで行う。それ以外は稀にしか強行しない(読みがロボット的にならない
        // よう、低いが非ゼロの下限)。これは単なる能力チェックではない: 2人の
        // トラッパーの間に本物の隙間が存在せねばならず、味方がその一方に体を
        // 当てればさらに開く。成功はトラップに対して相対的。
        if (canIso(game, h, dHoop)) {
          // リムへのレーンに沿って測る隙間: 両側に割れている → 真ん中に隙間、
          // 一方に偏っている → 外側が開き口、ボールに重なっている → レーン無し。
          let seam = 0;
          if (d1 && d2) {
            let ux = rimFloor.x - h.pos.x, uz = rimFloor.z - h.pos.z;
            const ul = Math.hypot(ux, uz) || 1; ux /= ul; uz /= ul;
            const px = -uz, pz = ux;                                    // 横軸
            const lat1 = (d1.pos.x - h.pos.x) * px + (d1.pos.z - h.pos.z) * pz;
            const lat2 = (d2.pos.x - h.pos.x) * px + (d2.pos.z - h.pos.z) * pz;
            seam = lat1 * lat2 < 0 ? Math.min(Math.abs(lat1), Math.abs(lat2)) : 0.8;
          }
          const seamScore = clamp((seam - 0.4) / 1.2, 0, 1);           // 密着..完全にオープン
          // 味方がトラッパーの一方に体を当てる/スクリーンすると彼を釘付けにするので、
          // トラップは実質人手不足になり、ハンドラーはマークをすり抜ける
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
        // 割れない → パスで解決する: トラップが空けた選手へキックアウト(上手い
        // パサーは2人の間にバウンド/ジャンプパスを通す)。まだ誰も空いていなければ
        // 回避する — その場でボールをダブルチームに留めておくのでなく、リトリート
        // ドリブルでトラップから抜けてリセットする。
        if (trapKickOut(game, h)) return;
        retreatFromTrap(game, h);
        return;
      }
    }

    // ロール駆動の行動 — ボールが彼に届いた。今何をするかはオフェンスロールに従う。
    // だからディストリビューター/ビッグ/スペーサーに使用機会を集めても、彼が
    // 乱射屋や無謀なドリブラーになるわけではない。
    if (passFirst) {
      // ハンドラー/フロアジェネラル/ハブビッグ: まず配球。ただし「打たずにパス回し
      // だけ」にならないよう、空いた球は打ち、レーンが開けば仕掛けてギャップを作る。
      if (!game.frontT) { bringUpLane(game, h); return; }
      if (game.shotClock < SHOT_CLOCK * 0.3 && dHoop > 1.8 && canGather && !wontLoadUp(h, dHoop, dDef) && !denySmother(game, h, dDef)) {
        // ヒーブを投げ捨てる前に: まだ1秒以上あるなら、まずラインまで急いで寄る
        // （深い3は効き射程外＝確率を捨てるだけ）。1秒を切ったら腹を括って打つ。
        if (dHoop > effShootRange(h) + 0.6 && game.shotClock > 1.0) { game.setDrive(h, rimFloor, THREE_DIST + 0.2); return; }
        shoot(game, h, dHoop, dDef);
        return;
      }
      const inRange = dHoop <= effShootRange(h) + 0.3;
      const clockPush = clamp((SHOT_CLOCK * 0.5 - game.shotClock) / (SHOT_CLOCK * 0.5), 0, 1);   // 遅いほど打つ(残半分から)
      // 綺麗なレーン → 守備を歪ませに攻める(ビッグはドリブルでなくポスト)
      if (laneClear(game, h, rimFloor) && dHoop <= 8 && canIso(game, h, dHoop)
          && chance(clamp(0.2 + rate(h.attr.handling) * 0.25 + clockPush * 0.3, 0, 0.6))) {
        if (game.isBig(h)) postMove(game, h); else driveDecision(game, h);
        return;
      }
      const open = dDef > 1.7;
      const pS = clamp(0.16 + rate(h.attr.threeAcc) * 0.28 + (dDef - 1.7) * 0.2 + clockPush * 0.5, 0.04, 0.9);
      if (inRange && open && chance(pS)) { shoot(game, h, dHoop, dDef); return; }
      if (pass(game, h)) return;
      game.setDrive(h, rimFloor, Math.min(4.5, Math.max(dHoop, 1.2)));   // 探り/リセット — 選手をペイントの外へ後退させない
      return;
    }
    if (noCreate) {
      // スポット/カッター/ランナー/スクリーナー/リバウンダー: キャッチ&シュートが
      // 基本。無理な単独クリエイトはしないが、「クローズアウトには仕掛ける」ことで
      // ギャップを作り、開いた球はしっかり打つ（打たずに回すだけにしない）。
      if (!game.frontT) { bringUpLane(game, h); return; }
      if (game.shotClock < SHOT_CLOCK * 0.3 && dHoop > 1.8 && canGather && !wontLoadUp(h, dHoop, dDef) && !denySmother(game, h, dDef)) {
        // ヒーブを投げ捨てる前に: まだ1秒以上あるなら、まずラインまで急いで寄る
        // （深い3は効き射程外＝確率を捨てるだけ）。1秒を切ったら腹を括って打つ。
        if (dHoop > effShootRange(h) + 0.6 && game.shotClock > 1.0) { game.setDrive(h, rimFloor, THREE_DIST + 0.2); return; }
        shoot(game, h, dHoop, dDef);
        return;
      }
      const inRange = dHoop <= effShootRange(h) + 0.3;
      const clockPush = clamp((SHOT_CLOCK * 0.5 - game.shotClock) / (SHOT_CLOCK * 0.5), 0, 1);
      // クローズアウトを攻める: 生きたハンドルを持つシューターは飛び込んでくる
      // 守備者を抜き去る — オフボールのスコアラーがギャップを作る主な手段。
      const od = game.onBallDefender(h);
      if (od && !od.airborne && dDef < 2.3 && od.curSpd > od.runSpeed * 0.5
          && canIso(game, h, dHoop) && rate(h.attr.handling) > 0.45
          && chance(clamp(0.28 + rate(h.attr.handling) * 0.4 + rate(h.attr.agility) * 0.3
              - rate(od.attr.balance) * 0.4, 0.1, 0.7))) {
        h.driveSide = game.pickSide(h); h.beatenT = rand(0.5, 0.8);
        od.reactT = Math.max(od.reactT, reactionLag(od));
        game.setDriveSide(h); return;
      }
      const isThreeL = dHoop > THREE_DIST;
      const open = dDef > (h.has("isoShooter") ? 1.3 : 1.5);
      const pS = clamp(0.42 + rate(h.attr.aggression) * 0.2 + (dDef - 1.5) * 0.22
        + (isThreeL ? tac.threeBias * 0.2 * twWeight(h) : 0.12) + clockPush * 0.4, 0.06, 0.95);
      if (inRange && open && chance(pS)) { shoot(game, h, dHoop, dDef); return; }
      if (pass(game, h)) return;
      game.setDrive(h, rimFloor, Math.min(4.5, Math.max(dHoop, 1.2)));
      return;
    }

    // ビッグ(PF/C) — およびポスト能力を持つ者は誰でも — ポストで勝負する:
    // ジャンパーで妥協するのでなく、守備者をリムまで押し込んでレイアップ/ダンク。
    // 強くボディアップされたら、または明らかに良い形が空いたらキックアウト。
    if (game.isBig(h) || h.has("post")) {
      if (dDef < 1.1 && chance(0.3)) {
        const better = betterOptionAvailable(game, h);
        if (better && passToReceiver(game, h, better)) return;
      }
      if (dHoop > 6 && chance(dHoop > 10 ? 0.85 : 0.45) && pass(game, h)) return;
      postMove(game, h);
      return;
    }

    // 残クロックに対する相対しきい値(SHOT_CLOCK 依存)。7秒クロックでは ~2.5秒前後で
    // 初めて「打ち急ぎ」に入る（up-tempo は少し早い）。絶対秒だと短クロックで早過ぎた。
    const urgent = game.shotClock < SHOT_CLOCK * (0.42 + tac.pace * 0.14 * twWeight(h));
    // 打ち急ぎ圏でギャザーが間に合わない（深すぎる）: 外で持て余さず、ワインド
    // アップの要らないレイアップを狙ってリムへ切り込む
    if (urgent && game.shotClock > 0.8 && wontLoadUp(h, dHoop, dDef)) {
      driveDecision(game, h);
      return;
    }
    if (urgent && canGather && !wontLoadUp(h, dHoop, dDef) && !denySmother(game, h, dDef)) {
      // 打ち急ぎでも深い3は投げ捨てない: 効き射程の外に居てまだ1秒以上あるなら、
      // まずラインへ寄る（1秒を切ったらどこからでも打つ）
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

    // ペイント内で持った場合、連携が低い選手ほどチーム戦術やパスより「自分で決める」
    // ことを優先する: ドライブ/フィニッシュ意欲を上げ、キックアウト意欲を下げる。連携が
    // 高い選手はここでも設計どおりボールを動かす。(オープンなリム至近は上流で即フィニッシュ
    // 済みなので、ここが効くのは競り合った状態のペイント。)
    if (dHoop <= 4.3 && Math.abs(h.pos.x) <= 2.6) {
      const selfish = (1 - rate(h.attr.teamwork)) * 0.4;   // 連携100→+0, 連携0→+0.4
      driveDesire += selfish;
      shootDesire += selfish;
      passDesire = Math.max(0, passDesire - selfish * 1.2);
    }

    const laneOpen = laneClear(game, h, rimFloor);
    const beaten = h.beatenT > 0;
    const isThree = dHoop > THREE_DIST;

    // 射程内でリムへの道が開けている → 通常は攻める(レイアップはジャンパーに勝る)。
    // ただしパスファーストの選手がキックする、またはエリートシューターに完全な
    // オープンがある場合を除く
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

    // 綺麗なレーン無し: オープンな形は打つ(第一オプションほど進んで)。
    // 難しくコンテストされた形は、より高い得点オプションが空いていればそちらへ回す。
    // L速度(射程)がこの選手がどこまで進んで打つシューターかを決める。
    if (dHoop <= effShootRange(h) + 0.3) {
      // 1対1シュート: 単独の守備者の上からなら喜んで打つ
      const open = dDef > (h.has("isoShooter") ? 1.4 : 1.7);
      // クロック連動の撃ち急ぎ: 残クロックが減るほどオープンな射程内の球は打つ。
      // (この主判断ルートには従来 clockPush が無く、開いていても回してしまい
      //  ショットクロック違反を量産していた。)
      const clockPush = clamp((SHOT_CLOCK * 0.6 - game.shotClock) / (SHOT_CLOCK * 0.6), 0, 1);
      let pShoot = 0.20 + shootDesire * 0.55 - (dHoop - 2) * 0.04 + (dDef - 1) * 0.3 + clockPush * 0.5;
      if (isThree) pShoot += tac.threeBias * 0.22 * tw - 0.05;
      pShoot = clamp(pShoot, 0.03, 0.96);
      if (open && chance(pShoot)) { shoot(game, h, dHoop, dDef); return; }

      // ハンドルを持つシューターにクローズアウトしてくる守備者はステップバックで
      // 罰せられる: クローズアウトを誘い、抜き去るか綺麗な空間へ上がって打つ
      if (!open && dDef < 1.5 && canIso(game, h, dHoop) && h.jukeT <= 0
          && (rate(h.attr.midAcc) > 0.55 || rate(h.attr.threeAcc) > 0.6)
          && chance(clamp(0.05 + rate(h.attr.dribbleAcc) * 0.14 + rate(h.attr.agility) * 0.1, 0, 0.32))) {
        const d = game.onBallDefender(h);
        if (d) { stepBack(game, h, d, dHoop); return; }
      }

      // 綺麗な形でない → ここでスコアラーはドリブルから相手を攻める(本物の
      // アイソレーション)。妥協やリセットでなく、スピードかパワーで抜こうとする。
      // これがハーフコートでの侵入の主な源。
      if (canIso(game, h, dHoop) && chance(clamp(0.2 + driveDesire * 0.5, 0.08, 0.7))) {
        driveDecision(game, h); return;
      }

      // 難しいシュート → より良い(オープンな)得点オプションへ回すことを探す
      const better = betterOptionAvailable(game, h);
      if (better && passToReceiver(game, h, better)) return;

      if (chance(pShoot)) { shoot(game, h, dHoop, dDef); return; } // でなければ自分を信じて打つ
    }
    // 射程外(または打つのを見送った): ドリブルから攻めて勢いよく下る、さもなければ
    // ボールを動かす、さもなければ探ってリセット。クロックが減るとオフェンスはぐずぐず
    // するのをやめる — ドライブ欲が上がり「回してリセット」欲が下がるので、ポゼッションが
    // だらだらとバイオレーションに陥らない。
    const clockCommit = clamp((SHOT_CLOCK * 0.6 - game.shotClock) / (SHOT_CLOCK * 0.6), 0, 1); // 序盤0 .. 終盤1
    if (canIso(game, h, dHoop) && chance(clamp(driveDesire * 0.45 + clockCommit * 0.75, 0, 0.95))) {
      driveDecision(game, h); return;
    }
    const passUrge = clamp((passDesire * 0.6 + (dDef < 1.3 ? 0.2 : 0)) * (1 - clockCommit * 0.85), 0, 0.85);
    if (chance(passUrge) && pass(game, h)) return;
    // クロックが逃げているのにまだ仕掛けていない → リセットをやめて行く
    if (game.shotClock < SHOT_CLOCK * 0.5 && canIso(game, h, dHoop)) { driveDecision(game, h); return; }
    // まだ運び上げ中(バックコート) → 中央でなくサイドのレーンを運ぶ。
    // フロントコートではリムへ向けた単なるリセットの探り
    if (!game.frontT) bringUpLane(game, h);
    else game.setDrive(h, rimFloor, Math.min(4.5, Math.max(dHoop, 1.2)));
  }

  // より余裕のある側(−1 左 / +1 右) — 味方が少ない側 — なので、ボールは
  // 混雑を避けて上がり、フロアはスペーシングを保つ。
export function openSide(game: Game, h: Player): number {
    let l = 0, r = 0;
    for (const p of game.teamPlayers(h.team)) {
      if (p === h) continue;
      if (p.pos.x < -0.5) l++; else if (p.pos.x > 0.5) r++;
    }
    return l <= r ? -1 : 1;
  }

  // ボールを中央を真っ直ぐ(ペイントを詰まらせパスの角度を潰す)でなく、ウイングの
  // レーンでフロントコートへ運び上げる。中央から外れていればその側を保ち、
  // ど真ん中からは空いた側を選ぶ。
export function bringUpLane(game: Game, h: Player): void {
    const s = game.attackSign(h.team);
    const side = Math.abs(h.pos.x) > 1.5 ? Math.sign(h.pos.x) : openSide(game, h);
    // まだ中央にいる間にサイドラインへ break し(ほぼ横方向)、その後その側に
    // 寄せて運び上げる — 中央を空けたまま保ち、中央を真っ直ぐ詰まらせる代わりに
    // 左右のパスの角度を開く。
    const ahead = Math.abs(h.pos.x) < 4 ? 1.8 : 5.0;
    h.driveTarget.set(side * 5.5, 0, h.pos.z + s * ahead);
  }

  // まだ形成中のダブルチーム — オンボールの守備者がハンドラーに詰め、2人目の
  // 守備者がローテートして速く寄せているが、2人はまだトラップを発動していない。
  // 2人が到着して嵌まる(ダブルチームに嵌まる往復)のを待つのでなく、ボールを
  // 手放して打開する瞬間。近づいてくるヘルプ守備者を返す。トラップが発生して
  // いなければ null。
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

  // マークされた下手なボールハンドラー(低 D精度)はドリブルで前進できない —
  // キープするしかない。フロントコートで、守備者が付いていて、ギャンブルを強い
  // られないだけのクロックがある時に真。(運び上げとクロック切れ間近は対象外。
  // 綺麗なハンドルも同様。)
export function mustKeepDribble(game: Game, h: Player, dDef: number): boolean {
    if (!game.frontT) return false;                          // 運び上げは別所で処理
    if (dDef > 1.8) return false;                            // 誰も付いていない → 自由にドリブル
    if (game.shotClock < 4) return false;                    // クロック切れ間近 → 得点を試みねば
    return rate(h.attr.dribbleAcc) < KEEP_DRIBBLE_THRESH;    // 本当に下手なハンドルのみ
  }

  // マークされた下手なハンドラーのキープ専用の選択肢: ヘルプに来た味方へ渡す、
  // じりじり前進、あるいはただ保持してシールド。クロスオーバー/抜き去り/ポスト押し込み無し。
export function keepDribbleDecide(game: Game, h: Player, dHoop: number, dDef: number, rimFloor: Vector3): void {
    // 僅かな隙間があるリム際 → それでも決める(イージーな一本は決して断らない)
    if (dHoop < 2.0 && dDef > 0.85) { finishAtRim(game, h, dDef); return; }
    // ヘルプが来た → 即座に手放す(オフェンスが望む逃がし弁)
    if (pass(game, h)) return;
    // さもなければキープ: ほぼ保持&シールド、時々リムへじりじり寄る
    if (chance(0.3) && dHoop > 1.9) {
      game.setDrive(h, rimFloor, Math.max(1.7, dHoop - 0.5));  // ゆっくり守りながら一歩入る
    } else {
      game.setDrive(h, rimFloor, dHoop);                       // 保持: 目標 ≈ 現在地 → 前進なし
    }
    h.keepShieldT = 0.5;   // ドリブルを這うほどに絞り + 体を斜めに(移動 + 向き)
  }

  // ビッグが相手を押し込む: リムへ真っ直ぐドライブ(クロスオーバー/フェイント無し)。
  // どれだけ速く到達するか — そして守備者を後ろへ押し込むか — は、runOffense と
  // 衝突ステップで解決される力比べ。
export function postMove(game: Game, h: Player): void {
    const rim = game.attackFloor(h.team);
    h.driveTarget.set(rim.x, 0, rim.z);
  }

  // 運び上げてくるガードへボールを渡す: 彼が現実的なアウトレット(射程内で覆われて
  // いない — ボールの方へ戻ってきているので、トランジションで守備が前方にいる状況では
  // 通常成功)である時のみ。
export function outletTo(game: Game, h: Player, g: Player): boolean {
    if (dist2D(h.pos, g.pos) > MAX_PASS) return false;
    if (game.nearestDefenderDist(g) < 1.2) return false;   // まだ覆われている — 待つ
    return passToReceiver(game, h, g);
  }

  // まだアウトレットに空いたガードがいない — ビッグはハーフウェイ手前で止まる
  // (以前はセンターライン際で固まっていた)のでなく、トップオブザキーへ向けて運び
  // 続ける。アウトレットは決定tick毎に再チェックされるので、ガードが空いた瞬間に
  // 渡す。誰も空かなければ、嵌まるのでなく自分で運び上げる。
export function advanceSafely(game: Game, h: Player): void {
    // 結局運び上げるビッグも、中央でなくサイドのレーンを使う
    if (!game.frontT) bringUpLane(game, h);
    else game.setDrive(h, game.attackFloor(h.team), 8);   // フロントコートの、ほぼトップオブザキー
  }

  // トラップをパスで解決する: ダブルチームは選手をフリーにする — そこへ通す。
  // 完全に塞がれていないレーンを通して、本当にオープンな味方へのみ強行する
  // (投げ捨てに見えるカバレッジへの無茶なキックアウトはしない)。強制パスは
  // 通常のリスクゲートを飛ばすので、上手いパサーはややタイトなレーンを通すが、
  // 覆われた選手/レーン内の体へは決して強行しない。
export function trapKickOut(game: Game, h: Player): boolean {
    let best: Player | null = null, bestScore = 0;
    let bestVet = false;
    for (const mate of game.teamPlayers(h.team)) {
      if (mate === h) continue;
      if (dist2D(h.pos, mate.pos) > MAX_PASS) continue;
      // 一つのトラップから別のトラップへキックしない — 自身が(または今しがた)
      // ダブルチームされた味方はスキップ
      if (doubleTeamed(game, mate) || mate.trappedT > 0) continue;
      const open = game.nearestDefenderDist(mate);
      if (open < 1.6) continue;                         // 本当にオープンな選手のみ
      // レーンに体が居ても、もうこのオプションは潰れない — バウンドパスが
      // 手の下を通る — 得点で少し損するだけ
      const vet = laneVetoed(game.oppTeam(h), h, mate);
      const score = open - passRisk(game.oppTeam(h), h, mate) * 2 - (vet ? 0.6 : 0);
      if (score > bestScore) { bestScore = score; best = mate; bestVet = vet; }
    }
    if (!best) return false;
    if (bestVet || chance(0.25)) {
      // 頭上のレーンが塞がれている(または気まぐれに) → バウンドパス:
      // トラッパーの手の下を突き、床で一つ跳ねて味方の手元へ
      return passToReceiver(game, h, best, true, "bounce");
    }
    // 頭上が使える → 本物のジャンプパス: ダンク級に跳び、最高点から頭上を越す
    h.jump(0.5, 0.6);
    game.pendingPassTo = best;
    game.pendingPassT = 0.22;
    return true;
  }

  // トラップを回避する: その中に立っているのでなく、オープンなフロアへリトリート
  // ドリブルしてダブルチームを破り、パスの角度を開く。単に「守備者から離れる」では
  // ない: コーナーへ追い込まれたハンドラーにとってその方向はコート外を指し、コート
  // クランプが彼をコーナーに、まさにトラップの狙い通りに固定してしまう — 典型的な
  // 角で固められる。代わりに合法な進行方向をサンプリングし、フロア上に留まりつつ
  // 実際に距離を稼げる方向を取る(彼のアウトレットがある中央/上方向へ少し偏らせる)。
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

  // 速攻: ハンドラーが守備が整う前にリムへボールを強く押し込む。ウイングが相手を
  // 走り抜いてリム付近でオープンなら、代わりにそこへ通してレイアップさせる。
  // SPEED / 加速力(ハンドラーがどれだけ速く距離を詰め、走者がレーンを埋めるか)が
  // 成否を決める。
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

  // ハンドラーがドリブルで相手を抜ける状況にあるか: ドライブを仕掛けられるほど近く、
  // フロントコートで、クロックに時間があること。20フィート先からや、ショットクロックが
  // 切れかけている時にアイソする意味はない。
export function canIso(game: Game, h: Player, dHoop: number): boolean {
    if (dHoop > 9 || dHoop < 1.8) return false;
    if (game.shotClock < 3) return false;
    if (game.frontT && game.attackSign(h.team) * h.pos.z < 0.4) return false; // バックコート
    return true;
  }

  // 1対1の核心: どちらへ攻めるかを選び、時折クロスオーバーを混ぜ、守備者が誤った
  // 方向へ傾いた隙に抜き去る。
  // 1対1の読み: フェイクで守備者の体重(重心)を誤った方向へ動かそうとするドリブル
  // move、そして開いた隙を攻める。ハンドルが高く速いクリエイターは move を効かせ、
  // はるかに多くコーナーを回る。規律正しく足の速い守備者は食いつきにくく前に留まる。
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

    // ドリブルで相手を抜くには2通りあり、選手は自分のツール(とマッチアップ)が
    // 有利な方で攻める:
    //  • SPEED — 守備者の体重を動かすクロスオーバー、そしてコーナーを回る
    //  • POWER — 肩を下げてリムへ力任せに押し戻す
    // 注: 守備者の抑え込みはハンドラーのクリエイトより重く効くので、速く守判断の
    // 高い守備者は五分のマッチアップで勝つ — 良いオンボール守備は、あらゆるドライブが
    // コイン投げになるのでなく、実際に侵入を止める。
    // 守備者の抑え込みはハンドラーのクリエイトより重く効く(下記参照)。良い
    // オンボール守備者は本当に侵入を止めるべき。
    const speedEdge = rate(h.attr.handling) * 0.45 + rate(h.attr.agility) * 0.35
      + rate(h.attr.dribbleAcc) * 0.2 + (h.has("driver") ? 0.1 : 0)
      - (rate(d.attr.agility) * 0.62 + rate(d.attr.reaction) * 0.4
        + rate(d.attr.defense) * 0.55 + (d.has("manMark") ? 0.12 : 0));   // 守判断を増強(基準は pBeat 側で再センタ)
    // POWER は物理的な戦い — だが押し込みながらボールを紐で保つにはハンドルも要る。
    // 強いが不器用な選手(技術/D精度 が低い守備型ビッグ)はリムまで力押しできない。
    // 守備者は主にボディバランス(純粋な強さ)に守判断を加えて抵抗する。
    const powerEdge = rate(h.attr.balance) * 0.55 + rate(h.attr.aggression) * 0.2
      + rate(h.attr.dribbleAcc) * 0.2 + rate(h.attr.handling) * 0.15 + (h.has("post") ? 0.15 : 0)
      - (rate(d.attr.balance) * 1.05 + rate(d.attr.defense) * 0.60);   // 守判断を増強(基準は pPower 側で再センタ)

    // 選手自身のツールがまずスタイルを決める: 強くフィジカルな選手(高い
    // ボディバランス, 攻撃的)は力で割り込み、速くハンドルの高い選手(敏捷性/技術)は
    // クロスオーバーする。その後マッチアップが微調整する — 守備者が弱い方を攻める。
    const ownPower = rate(h.attr.balance) + rate(h.attr.aggression) * 0.5 + (h.has("post") ? 0.4 : 0);
    const ownSpeed = rate(h.attr.agility) + rate(h.attr.handling) * 0.7 + (h.has("driver") ? 0.4 : 0);
    const usePower = h.comboN === 0 && chance(clamp(0.5 + (ownPower - ownSpeed) * 0.6
      + (powerEdge - speedEdge) * 0.5, 0.08, 0.92));   // コンボ途中はドリブルを続ける

    if (usePower) {
      // POWER: 守備者に肩を入れる。力比べに勝てば相手をリムまで押し戻し、
      // 負ければ壁で止められてリセットするしかない。
      h.driveSide = d.shadeSide !== 0 ? -d.shadeSide : game.pickSide(h);
      const pPower = clamp(0.53 + powerEdge * 1.25, 0.03, 0.9);   // +0.13 = 守判断重み増のフラット70補償
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
    // 敏捷性(クイックネス) + D精度(ドリブル制御)が揺さぶりを生み、守備者は
    // 守判断(守備) + クイックネス/反応(バースト)で抵抗する。使う move は守備者の
    // 守り方次第。
    const jukeEdge = jukeDeception(h) - jukeDiscipline(d);
    const rim = game.attackFloor(h.team);
    const rl = Math.hypot(rim.x - h.pos.x, rim.z - h.pos.z) || 1;
    const ux = (rim.x - h.pos.x) / rl, uz = (rim.z - h.pos.z) / rl;   // リムへ
    const latx = -uz, latz = ux;                                      // 横方向

    // 新規のアタック → ドリブルを計画する: 上手いハンドラーは1..3の move を繋ぐ。
    // 序盤の揺さぶりは純粋な揺さぶり — 守備者の体重を振るだけ — 最後の move だけが
    // 攻め、彼がもう戻れない側を抜いてバーストする。速い守備者は揺さぶりの間に
    // 立て直し、遅い者は振られる度にさらにバランスを崩す。
    if (h.comboN === 0) {
      h.lastFakeDir = 0;
      let plan = 1;
      const pMore = clamp(0.25 + jukeDeception(h) * 0.55, 0.1, 0.8);
      if (chance(pMore)) plan++;
      if (plan > 1 && chance(pMore * 0.6)) plan++;
      h.comboN = plan;
    }
    const finalShake = h.comboN <= 1;

    // 正面の守備者を揺さぶる: 固めるためのジャブステップイン、または一方へ
    // 引きつけて逆を攻める強いサイドステップ。準備の揺さぶりは体重を振るため
    // 左右交互に行う。最後の move は彼の実際の傾きを読む — もう一度そこへ誘い込み、
    // 彼が戻れない側を抜いてバーストする。
    const stepIn = h.lastFakeDir === 0 && finalShake && chance(0.35);
    let fakeDir: number;
    if (finalShake) {
      // GO 側 = 手で重み付けした守備者の傾きの読み: 片手の選手(低逆手頻度)は、
      // 逆手側のレーンが明らかに良い読みでない限り、利き側に留まる。両手使いの
      // ハンドラーは傾きが与えるものをそのまま取る
      const strong = h.strongSide();
      const beat = (side: number) => clamp(-d.lean * side, -1, 1);
      // 普通のシェード(lean ≈0.3)が片手の選手を利き手から引き剥がさないよう
      // スケール — 明確な過剰対応だけがそうする
      const handEdge = (h.strongSideBias() - 0.5) * 3.2;   // 0 (両手) .. 約0.65
      const go = beat(strong) + handEdge >= beat(-strong) ? strong : -strong;
      fakeDir = -go;                       // 逆へ誘い込んでから、そこを攻める
    } else {
      fakeDir = h.lastFakeDir !== 0 ? -h.lastFakeDir : -game.pickSide(h);
    }
    let ox: number, oz: number, leanMag: number;
    if (stepIn) {
      ox = ux * 0.35; oz = uz * 0.35; leanMag = 0.7;               // リムへのジャブ
      d.reactT = Math.max(d.reactT, reactionLag(d)); // 彼は躊躇する
    } else {
      ox = latx * fakeDir * 0.45; oz = latz * fakeDir * 0.45; leanMag = 1.1; // サイドステップ
    }
    h.jukeT = rand(0.18, 0.3);
    h.jukeTarget.set(h.pos.x + ox, 0, h.pos.z + oz);
    game.clampCourt(h.jukeTarget);

    // 食いつくか？ 揺さぶり vs 規律が体重の振れ幅を決める
    const bite = clamp(0.3 + jukeEdge * 1.1, 0.03, 0.95);
    if (chance(bite)) {
      // 体重がまだ前のフェイクの反対側にあれば、戻りの振りが行き過ぎる —
      // これが、戻りの遅い守備者では傾きを積み上げ、速い者は各 move が決まる前に
      // 再び正対する仕組み
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
    // (GO move が傾きを読むようになった時にベースを下げた — 全体の抜き去り率を
    // 従来調整した水準に保つ)
    const wrongWay = clamp(-d.lean * go, 0, 1);
    const pBeat = clamp(0.49 + speedEdge * 1.2 + wrongWay * 0.45, 0.02, 0.95);   // +0.11 = 守判断重み増のフラット70補償
    if (chance(pBeat)) {
      // バーストはリムまで最後まで運ぶ — フリースローラインで死ぬ抜き去りは
      // 抜き去りではない。時間はハンドラーが実際に詰めるべき距離に
      // スケールする(≈7.5 m/s のバーストペース)。
      h.beatenT = clamp(rl / 7.5, 0.5, 1.3) * rand(0.95, 1.15)
        * (1 + Math.max(0, speedEdge) * 0.2);
      d.reactT = Math.max(d.reactT, reactionLag(d));
      // 勢いが彼をさらに誤った方向へ運ぶ — 体重を誤った側へ仕掛けているので、
      // 追い戻し(leanFactor)は這うように始まる
      d.lean = clamp(d.lean + go * 0.3, -1, 1);
      d.leanAxisX = latx; d.leanAxisZ = latz;
    } else {
      h.stalledT = rand(0.3, 0.55);
    }
    game.setDriveSide(h);
  }

  // ハンドラーがドリブル move をどれだけ効かせるか — クイックネス + ドリブル制御が主。
  // ステップバック: シュートにコンテストする守備者に対してドリブルから後退する。
  // 彼が前へ過剰に反応すれば(シュートフェイクに食いつけば)ハンドラーはそのステップから
  // 抜き去る。彼が腰を落として留まれば、ハンドラーはジャンパーのための綺麗な距離を得る。
  // クローズアウトの誘いはハンドラーのシュート脅威 + 揺さぶりに比例し、守備者は
  // 規律で抵抗する。
export function stepBack(game: Game, h: Player, d: Player, dHoop: number): void {
    const rim = game.attackFloor(h.team);
    const bx = h.pos.x - rim.x, bz = h.pos.z - rim.z;     // リムから離れる方向
    const bl = Math.hypot(bx, bz) || 1;
    h.jukeT = rand(0.2, 0.32);
    h.jukeTarget.set(h.pos.x + (bx / bl) * 0.7, 0, h.pos.z + (bz / bl) * 0.7);
    game.clampCourt(h.jukeTarget);

    const shotThreat = Math.max(rate(h.attr.threeAcc), rate(h.attr.midAcc));
    const edge = jukeDeception(h) - jukeDiscipline(d);
    const bait = clamp(0.2 + edge * 0.5 + shotThreat * 0.25, 0.05, 0.82);
    if (chance(bait)) {
      // 彼が前へ突っ込んだ → ステップバックから抜き去る(バーストは他の抜き去りと
      // 同様リムまで運ぶ)
      h.beatenT = clamp(dHoop / 7.5, 0.5, 1.3) * rand(0.95, 1.15)
        * (1 + Math.max(0, edge) * 0.2);
      d.reactT = Math.max(d.reactT, reactionLag(d));
      d.lean = clamp(d.lean * 0.5, -1, 1);
      h.driveSide = game.pickSide(h);
      game.setDriveSide(h);                              // バーストはリムへ向かう
    } else {
      // 腰を落として留まった → ステップバックがクッションを稼いだ。ジャンパーのため
      // それを保ち、次の判断で(今はオープンな)形を放たせる
      d.reactT = Math.max(d.reactT, reactionLag(d));
      h.driveTarget.copyFrom(h.jukeTarget);
    }
  }

  // 前方約1.2m以内で、ドライブ経路に真っ直ぐ立つ守備者。彼らの体の接触が
  // ボールハンドラーを減速させる。
export function driveImpeder(game: Game, h: Player): Player | null {
    const tx = h.driveTarget.x - h.pos.x, tz = h.driveTarget.z - h.pos.z;
    const len = Math.hypot(tx, tz) || 1;
    const ux = tx / len, uz = tz / len;
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
    const ax = h.pos.x, az = h.pos.z;
    const dx = rimFloor.x - ax, dz = rimFloor.z - az;
    const len2 = dx * dx + dz * dz || 1;
    for (const d of game.teamPlayers(1 - h.team)) {
      const t = ((d.pos.x - ax) * dx + (d.pos.z - az) * dz) / len2;
      if (t <= 0.05 || t >= 1) continue;             // ハンドラーとリムの間ではない
      const px = ax + dx * t, pz = az + dz * t;
      if (Math.hypot(d.pos.x - px, d.pos.z - pz) < 1.1) return false; // レーン内に守備者
    }
    return true;
  }
