// オンボールの入口。ハンドラーの1フレーム: 判断tick(./decide)を回し、仕掛けた move の
// 展開（抜き去り/押し込み/ピック使い/探りドリブル）を進める。
import { rate, clamp, chance, rand, dist2D, moveToward2D, dirTo2D } from "../../../util";
import { PALM_HITBOX } from "../../../config";
import { palmRadius } from "../../../eval";
import { Player } from "../../../objects/player/player";
import { finishAtRim } from "../../../move/action/shooting";
import { passToReceiver, chooseReceiver } from "../../../move/action/passing";
import { updateOffBallMotion } from "../offball";
import { activeScreener, usingScreen, driveImpeder } from "../reads";
import { decide } from "./decide";
import type { Game } from "../../../game";

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
