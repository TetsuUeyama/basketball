// ゲームフロー: クォーター終了処理・ハーフ/試合終了のフィナーレ・クォーター間の
// 退場/入場ウォーク（方式B: GameState 集約）。状態は Game に集約し各関数は第一引数
// game を受け取る。ライブ進行(updateLive)や状況判断とは分離した進行管理レイヤ。
import { Player } from "../objects/player/player";
import { QUARTERS, QUARTER_TIME, SHOT_CLOCK, COURT, teamShort } from "../config";
import { clamp, rand, dist2DTo, moveToward2D } from "../util";
import { festivePose } from "./poses";
import { withSubs } from "../systems/subs";
import type { Game } from "../game";

// フィナーレ(勝利/引き分け)演出の総尺(秒)
const FINALE_DUR = 6.0;

  // ピリオドはブザーで終わるが、唐突ではない: END バナーを出し、両チームの5人が
  // ベンチへ歩いて引き上げ、そこで一拍保持し、（交代があれば済ませた後）次ピリオドの
  // スローインの位置へ歩いて戻る。
export function endQuarter(game: Game, ): void {
    game.coastT = 0;
    game.ballFalling = false;
    const leader = game.score[0] === game.score[1]
      ? game.possession
      : (game.score[0] > game.score[1] ? 0 : 1);
    game.handler = null;
    game.gameClock = 0;
    const ended = game.quarter;
    // 結果画面のライン別スコア用に、このピリオドの得点を記録する（累計スコアから、
    // それ以前のピリオドがすでに計上した分を引く）。再入するブザー経路が同じクォーターを
    // 二度記録しないようガードしている。
    if (game.qLine[0].length < ended) {
      for (let t = 0; t < 2; t++) {
        const prior = game.qLine[t].reduce((s, v) => s + v, 0);
        game.qLine[t].push(game.score[t] - prior);
      }
    }
    game.setEvent(ended === 2 ? "HALFTIME" : `END OF Q${ended}`, leader, 3.0);
    // 休憩そのもので脚がいくらか回復する — ハーフタイムはかなり多く回復する
    if (ended < QUARTERS) {
      const rest = ended === 2 ? 0.15 : 0.06;
      for (let t = 0; t < 2; t++) for (const p of game.roster[t]) p.breakRecover(rest);
    }

    // 最終ブザーは専用の演出になる: 勝者はフロアに群がって沸き、敗者はうなだれる
    // （引き分けは両ベンチが祝う）— 先に歩いて引き上げることはしない
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
        game.applyNumberSides(); // ハーフタイムで両チームはコートを入れ替える — 番号もそれに従う
        // ピリオド開始のポゼッションは開始ティップのルール(NBA)に従う:
        // 開始のジャンプボールに負けたチームが Q2・Q3 を始め、勝ったチームが
        // Q4 を始める（後半はコートが attackSign で入れ替わる）。
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
    game.cheerT = [-9, -9];   // フィナーレは進行中のベンチ歓声を上書きする
    game.setEvent(w >= 0 ? `${teamShort(w)} WINS!` : "DRAW",
      w >= 0 ? w : game.possession, FINALE_DUR);
    // 勝利した5人の中心。ベンチがその周りに扇状に広がれるように
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
            tx: clamp(cx + Math.cos(ang) * 1.8, -COURT.halfW + 1, COURT.halfW - 1),
            tz: clamp(cz + Math.sin(ang) * 1.8, -COURT.halfL + 1, COURT.halfL - 1),
          });
        } else if (w < 0) {
          if (onCourt) continue;   // 引き分け: コート上の選手はその場で祝う
          p.stand();               // ベンチは立ち上がって一緒に拍手する
          p.resetFacing();
        } else if (onCourt) {
          // 敗れた5人は自チームのベンチ前へ、うなだれてとぼとぼ歩いて引き上げる
          // （奥の席はコート一面分離れていることもある — ベンチ前の集合地点なら
          // 到達可能なターゲットになる）
          const dir = t === 0 ? -1 : 1;
          game.finaleTrudge.push({ p, tx: COURT.halfW + 0.6, tz: dir * (8 + p.slot * 0.9) });
        } else if (!p.seated) {
          p.sit();       // 敗れたベンチはすでに座っており、うなだれている
        }
      }
    }
    game.ballMode = "finale";
  }

export function updateFinale(game: Game, dt: number): void {
    game.finaleT += dt;
    const w = game.finaleWinner;
    game.ball.pos.y = Math.max(0.15, game.ball.pos.y - 3 * dt);   // ボールが落ち着く
    for (let t = 0; t < 2; t++) {
      const won = t === w, draw = w < 0;
      for (const p of game.roster[t]) {
        const walker = game.finaleWalkers.find((f) => f.p === p);
        if (walker) {
          // フロアに群がるベンチ: 走り込み、その後グループと一緒に跳ねる
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
          // 敗れた5人はベンチへ歩いて引き上げる。上体をずっと前かがみにしたまま —
          // 着いた後もそこで落胆したまま立ち続ける。彼らは game.players にいるので、
          // メインループが速度を測り／脚の周期を回し／sync する。ここでは操舵と
          // ポーズの保持だけを行う。
          if (dist2DTo(p.pos, trudger.tx, trudger.tz) > 0.4) {
            moveToward2D(p.pos, trudger.tx, trudger.tz, p.runSpeed * 0.6 * dt);   // 重い足取りの歩き
            p.faceToward(trudger.tx, trudger.tz);
          }
          p.dejectedPose();                     // 前かがみ、腕はだらり、最後まで
          continue;
        }
        if (game.onCourt(p)) {
          // コート上の体はメインループで tick/sync される — ここではポーズだけ付ける
          if (won) festivePose(game, p, dt, 1);
          else if (draw) festivePose(game, p, dt, 0.45);
          else p.dejectedPose();
        } else if (draw) {
          // 両ベンチは席で、立ったまま控えめなセレブレーションを共にする
          festivePose(game, p, dt, 0.4);
          p.updateJump(dt);
          p.sync();
        } else {
          p.sync();   // 敗れたベンチはうなだれてじっと座っている
        }
      }
    }
    // 群衆が一列に積み重ならないようにする
    const bodies: Player[] = [...game.players, ...game.finaleWalkers.map((f) => f.p)];
    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) {
        const a = bodies[i], b = bodies[j];
        let dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z;
        let d = Math.hypot(dx, dz);
        if (d >= 0.62) continue;
        if (d < 1e-4) { dx = rand(-1, 1); dz = rand(-1, 1); d = Math.hypot(dx, dz) || 1; }
        const push = (0.62 - d) / 2;
        a.pos.x -= (dx / d) * push; a.pos.z -= (dz / d) * push;
        b.pos.x += (dx / d) * push; b.pos.z += (dz / d) * push;
      }
    }
    if (game.finaleT >= FINALE_DUR) {
      game.state = "final";
      game.setEvent("FINAL", game.score[0] >= game.score[1] ? 0 : 1);
    }
  }

  // フロアの全員が、自チームのベンチ前の集合地点へ歩く。
export function quarterWalkOff(game: Game, next: () => void): void {
    game.subWalkers = [];
    for (const p of game.players) {
      const dir = p.team === 0 ? -1 : 1;      // 各チームのベンチ側ハーフ
      game.subWalkers.push({ p, tx: COURT.halfW + 0.6, tz: dir * (8 + p.slot * 0.9) });
    }
    // ボールはピリオドが終わった場所に転がったままにはならない — 選手がベンチへ
    // 向かう前に、次ピリオドのスローイン地点（センターライン、左サイドライン — 投げ手が
    // 立つ場所）に置かれる。審判が再開のためにセットするように。
    game.ball.pos.set(-(COURT.halfW + 0.3), 0.12, 0);
    game.ball.vel.set(0, 0, 0);
    game.subNext = next;
    game.subT = 0;
    game.ballMode = "subs";
  }

  // （交代された可能性のある）5人がベンチから、クォーターのスローインが使う正確な
  // 位置へ歩き出し、その場でスローインが準備される。
export function quarterWalkOn(game: Game, team: number): void {
    const offense = game.teamPlayers(team);
    const defenders = game.teamPlayers(1 - team);
    const spots = game.formationSpots(team);
    const protect = game.attackFloor(team);
    game.subWalkers = [];
    for (const p of offense) {
      if (p === offense[2]) {                 // スローインの投げ手は外へ向かう
        game.subWalkers.push({ p, tx: -(COURT.halfW + 0.3), tz: 0 });
      } else {
        game.subWalkers.push({ p, tx: spots[p.slot].x, tz: spots[p.slot].z });
      }
    }
    for (const d of defenders) {
      const s = spots[d.slot];                // マークの位置のゴール側
      const dx = protect.x - s.x, dz = protect.z - s.z;
      const len = Math.hypot(dx, dz) || 1;
      game.subWalkers.push({ p: d, tx: s.x + (dx / len) * 1.4, tz: s.z + (dz / len) * 1.4 });
    }
    game.subNext = () => game.startQuarterInbound(team, true);
    game.subT = 0;
    game.ballMode = "subs";
  }

  // 指定クォーターをどちらのチームが始めるか、開始ティップのルールに従って。
export function quarterStartTeam(game: Game, quarter: number): number {
    const loser = 1 - game.tipoff.winner;
    return (quarter === 2 || quarter === 3) ? loser : game.tipoff.winner;
  }
