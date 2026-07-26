// ゲームフロー: クォーター終了処理・ハーフ/試合終了のフィナーレ・クォーター間の
// 退場/入場ウォーク。ライブ進行(updateLive)とは分離した進行管理レイヤ。
import { QUARTERS, QUARTER_TIME, SHOT_CLOCK, COURT, OOB_OUTSET, INBOUNDS_INSET, teamShort } from "../config";
import { clamp, dist2DTo, moveToward2D, towardPoint } from "../util";
import { festivePose } from "./poses";
import { pushApart } from "./collision";
import { benchGatherSpot } from "./bench";
import { withSubs } from "../systems/subs";
import type { Game } from "../game";

// フィナーレ(勝利/引き分け)演出の総尺(秒)
const FINALE_DUR = 6.0;

  // ピリオド終了処理: END バナーを出し、両チーム5人がベンチへ引き上げ、一拍保持し、
  // （交代を済ませた後）次ピリオドのスローイン位置へ歩いて戻る。
export function endQuarter(game: Game, ): void {
    game.coastT = 0;
    game.ballFalling = false;
    const leader = game.score[0] === game.score[1]
      ? game.possession
      : (game.score[0] > game.score[1] ? 0 : 1);
    game.handler = null;
    game.gameClock = 0;
    const ended = game.quarter;
    // ライン別スコア用にこのピリオドの得点を記録する（累計から既計上分を引く）。
    // 同じクォーターを二度記録しないようガードする。
    if (game.qLine[0].length < ended) {
      for (let t = 0; t < 2; t++) {
        const prior = game.qLine[t].reduce((s, v) => s + v, 0);
        game.qLine[t].push(game.score[t] - prior);
      }
    }
    game.setEvent(ended === 2 ? "HALFTIME" : `END OF Q${ended}`, leader, 3.0);
    // 休憩で脚が回復する（ハーフタイムは多め）
    if (ended < QUARTERS) {
      const rest = ended === 2 ? 0.15 : 0.06;
      for (let t = 0; t < 2; t++) for (const p of game.roster[t]) p.breakRecover(rest);
    }

    // 最終ブザーは専用のフィナーレ演出（勝者は沸き、敗者はうなだれる）
    if (ended >= QUARTERS) {
      game.pauseThen(1.2, () => startFinale(game));
      return;
    }

    game.pauseThen(1.2, () => quarterWalkOff(game, () => {
      // ベンチで短いハドル、その後に次のピリオド
      game.pauseThen(1.0, () => {
        game.quarter = ended + 1;
        game.gameClock = QUARTER_TIME;
        game.shotClock = SHOT_CLOCK;
        game.applyNumberSides(); // コート入れ替えに番号も従う
        // 開始ティップのルール(NBA): ティップに負けたチームが Q2・Q3、勝ったチームが Q4 を始める
        const team = quarterStartTeam(game, game.quarter);
        withSubs(game, () => quarterWalkOn(game, team));
      });
    }));
  }

export function startFinale(game: Game, ): void {
    const w = game.score[0] === game.score[1] ? -1 : (game.score[0] > game.score[1] ? 0 : 1);
    game.finaleWinner = w;
    game.finaleT = 0;
    game.finaleWalkers = [];
    game.finaleTrudge = [];
    game.handler = null;
    game.cheerT = [-9, -9];   // 進行中のベンチ歓声を上書きする
    game.setEvent(w >= 0 ? `${teamShort(w)} WINS!` : "DRAW",
      w >= 0 ? w : game.possession, FINALE_DUR);
    // 勝利した5人の中心（ベンチが周りに扇状に広がる基準）
    const winFive = w >= 0 ? game.teamPlayers(w) : [];
    const cx = winFive.length ? winFive.reduce((s, q) => s + q.pos.x, 0) / winFive.length : 0;
    const cz = winFive.length ? winFive.reduce((s, q) => s + q.pos.z, 0) / winFive.length : 0;
    for (let t = 0; t < 2; t++) {
      for (const p of game.roster[t]) {
        const onCourt = game.onCourt(p);
        if (t === w) {
          if (onCourt) continue;   // コート上の勝者はその場で祝う(updateFinale)
          // 勝利したベンチはフロアに駆け込み、5人の周りに扇状に広がる
          p.stand();
          p.resetFacing();
          const ang = (game.finaleWalkers.length / 8) * Math.PI * 2;
          game.finaleWalkers.push({
            p,
            tx: clamp(cx + Math.cos(ang) * 1.8, -COURT.halfW + INBOUNDS_INSET, COURT.halfW - INBOUNDS_INSET),
            tz: clamp(cz + Math.sin(ang) * 1.8, -COURT.halfL + INBOUNDS_INSET, COURT.halfL - INBOUNDS_INSET),
          });
        } else if (w < 0) {
          if (onCourt) continue;   // 引き分け: コート上の選手はその場で祝う
          p.stand();               // ベンチは立ち上がって一緒に拍手する
          p.resetFacing();
        } else if (onCourt) {
          // 敗れた5人は自チームのベンチ前へうなだれて歩いて引き上げる
          game.finaleTrudge.push({ p, ...benchGatherSpot(p.team, p.slot) });
        } else if (!p.seated) {
          p.sit();       // 敗れたベンチは座ってうなだれる
        }
      }
    }
    game.ballMode = "finale";
  }

export function updateFinale(game: Game, dt: number): void {
    game.finaleT += dt;
    const w = game.finaleWinner;
    game.ball.pos.y = Math.max(0.15, game.ball.pos.y - 3 * dt);   // ボールが床に落ちる
    for (let t = 0; t < 2; t++) {
      const won = t === w, draw = w < 0;
      for (const p of game.roster[t]) {
        const walker = game.finaleWalkers.find((f) => f.p === p);
        if (walker) {
          // フロアに群がるベンチ: 走り込み、着いたら一緒に跳ねる
          if (dist2DTo(p.pos, walker.tx, walker.tz) > 0.6) {
            const jog = p.runSpeed * 0.9;
            moveToward2D(p.pos, walker.tx, walker.tz, jog * dt);
            p.faceToward(walker.tx, walker.tz);
            p.twistToward(walker.tx, walker.tz, dt);
            p.curSpd = jog;
            p.updateLegs(dt);
            p.runArms();
          } else {
            festivePose(game, p, dt, 1);
          }
          p.updateJump(dt);
          p.sync();
          continue;
        }
        const trudger = game.finaleTrudge.find((f) => f.p === p);
        if (trudger) {
          // 敗れた5人はベンチへ前かがみで引き上げる。game.players にいるので速度計測／
          // 脚周期／sync はメインループが行い、ここでは操舵とポーズ保持だけ。
          if (dist2DTo(p.pos, trudger.tx, trudger.tz) > 0.4) {
            moveToward2D(p.pos, trudger.tx, trudger.tz, p.runSpeed * 0.6 * dt);   // 重い足取り
            p.faceToward(trudger.tx, trudger.tz);
          }
          p.dejectedPose();                     // 前かがみ、腕はだらり
          continue;
        }
        if (game.onCourt(p)) {
          // コート上の体はメインループで tick/sync される — ここではポーズだけ付ける
          if (won) festivePose(game, p, dt, 1);
          else if (draw) festivePose(game, p, dt, 0.45);
          else p.dejectedPose();
        } else if (draw) {
          // 両ベンチは立ったまま控えめに祝う
          festivePose(game, p, dt, 0.4);
          p.updateJump(dt);
          p.sync();
        } else {
          p.sync();   // 敗れたベンチは座ったまま
        }
      }
    }
    // 群衆の重なりを押し離す
    pushApart([...game.players, ...game.finaleWalkers.map((f) => f.p)]);
    if (game.finaleT >= FINALE_DUR) {
      game.state = "final";
      game.setEvent("FINAL", game.score[0] >= game.score[1] ? 0 : 1);
    }
  }

  // フロアの全員が、自チームのベンチ前の集合地点へ歩く。
export function quarterWalkOff(game: Game, next: () => void): void {
    game.subWalkers = [];
    for (const p of game.players) {
      game.subWalkers.push({ p, ...benchGatherSpot(p.team, p.slot) });
    }
    // ボールはワープさせない。その場(コート上)から近くの選手が審判へ投げ渡し、審判は次
    // ピリオドのスローイン投げ渡し位置(センターライン左サイド)に立って受け、開始まで保持する。
    const qx = -(COURT.halfW + OOB_OUTSET);
    const ballX = game.ball.pos.x, ballZ = game.ball.pos.z;
    game.ball.vel.set(0, 0, 0);
    game.referees.acquireBall(ballX, ballZ, qx, 0, "auto");
    game.subNext = next;
    game.subT = 0;
    game.ballMode = "subs";
  }

  // 5人がベンチから、クォーターのスローインが使う位置へ歩き、スローインを準備する。
export function quarterWalkOn(game: Game, team: number): void {
    const offense = game.teamPlayers(team);
    const defenders = game.teamPlayers(1 - team);
    const spots = game.formationSpots(team);
    const protect = game.attackFloor(team);
    game.subWalkers = [];
    for (const p of offense) {
      if (p === offense[2]) {                 // スローインの投げ手は外へ向かう
        game.subWalkers.push({ p, tx: -(COURT.halfW + OOB_OUTSET), tz: 0 });
      } else {
        game.subWalkers.push({ p, tx: spots[p.slot].x, tz: spots[p.slot].z });
      }
    }
    for (const d of defenders) {
      const s = spots[d.slot];                // マーク位置のゴール側に立つ
      const gs = towardPoint(s.x, s.z, protect.x, protect.z, 1.4);
      game.subWalkers.push({ p: d, tx: gs.x, tz: gs.z });
    }
    game.subNext = () => game.startQuarterInbound(team, true);
    game.subT = 0;
    game.ballMode = "subs";
  }

  // 指定クォーターをどちらのチームが始めるか（開始ティップのルール）。
export function quarterStartTeam(game: Game, quarter: number): number {
    const loser = 1 - game.tipoff.winner;
    return (quarter === 2 || quarter === 3) ? loser : game.tipoff.winner;
  }
