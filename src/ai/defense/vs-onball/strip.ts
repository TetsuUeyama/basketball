// 対オンボール: ボールへのはたき。キャッチ際のコンテスト(catchStrips/deflectCatch/
// stealLunge)と、密集からのはたき(swarmStrips)。実際の奪取確定は Game.steal。
import { Vector3 } from "@babylonjs/core";
import { Player } from "../../../objects/player/player";
import { rate, clamp, chance, rand, dist2D, moveToward2D } from "../../../util";
import { stripEdge } from "../../../eval";
import { flashBall } from "../../../core/visuals";
import type { Game } from "../../../game";

  // ハンドラーに寄せたオフボール守備者もボールを掘る(オンボール守備者のはたきは ./index 内)。
  // ドリブルの合間、ボールが床近くにある時ほどはたきやすい。
export function swarmStrips(game: Game, dt: number): void {
    const h = game.handler;
    if (!h || game.ballMode !== "held") return;
    const onBall = game.onBallDefender(h);
    const exposed = game.ballInHand(h) ? 0.55 : 1.5;
    for (const d of game.teamPlayers(1 - h.team)) {
      if (d === onBall || d.airborne) continue;
      const gap = dist2D(d.pos, h.pos);
      if (gap > 1.5) continue;
      const close = 1 - gap / 1.5;
      const p = Math.max(0, 0.02 + stripEdge(d, h) * 0.55);
      if (chance(p * close * exposed * dt)) { game.steal(d); return; }
    }
  }

  // 収まる前のスティール: ギャザー(gatherT)中でボールが不安定な間、密着守備者がはじく。
export function catchStrips(game: Game, dt: number): void {
    const h = game.handler;
    if (!h || game.ballMode !== "held" || h.gatherT <= 0) return;
    const bobble = clamp(h.gatherT * 2.4, 0.2, 1.3);       // ボールがまだどれだけ不安定か
    const b = game.ball.pos;
    // 担当守備者が踏み込んでルーズボールを掘る(飛び込むのは主担当のみ)。
    const onBall = game.onBallDefender(h);
    // レシーバーがボールを隠すため体を回した量(0 = 前に露出 .. 1 = 遠い腰に収めた)。
    const shielded = h.gatherDur > 0 ? clamp(1 - h.gatherT / h.gatherDur, 0, 1) : 1;
    const exposed = clamp(1 - shielded, 0, 1);
    for (const d of game.teamPlayers(1 - h.team)) {
      if (d.airborne) continue;
      const gap = dist2D(d.pos, h.pos);
      if (gap > 1.8) continue;
      // ルーズボールを攻めに飛び込む(背中に這い上がらない)
      if (d === onBall && gap > 0.75) moveToward2D(d.pos, b.x, b.z, d.accelSpeed(dt, 1.2) * dt * 0.8);
      // はじき: 露出しているうちに手がボールに届けばはじく(反応/リーチ vs 隠す回転)。
      const toBall = dist2D(d.pos, b);
      if (toBall < 0.5) {
        const reach = 0.35 + rate(d.attr.reaction) * 0.65 - rate(h.attr.handling) * 0.4;
        if (chance(clamp(reach, 0.05, 0.9) * exposed * dt * 18)) { deflectCatch(game, h, d); return; }
      } else if (toBall < 1.15 && d.landT <= 0 && d.plantT <= 0) {
        // 届くか届かないか → 平行ジャンプステップでボールへ横っ飛び。手が届けばはじく。
        const gamble = rate(d.attr.reaction) * 0.5 + rate(d.attr.aggression) * 0.35;
        if (chance(clamp(gamble, 0.05, 0.9) * exposed * dt * 6)) {
          stealLunge(game, d, b.x, b.z);
          if (chance(clamp(0.7 - rate(h.attr.handling) * 0.5, 0.15, 0.8) * exposed)) { deflectCatch(game, h, d); return; }
          continue;   // 飛び込みは仕掛けたが、綺麗に手を掛けられなかった
        }
      }
      const close = 1 - clamp(gap / 1.8, 0, 1);
      const edge = 0.18 + stripEdge(d, h) * 0.65;     // 守備者の手 vs ハンドラーの安全性
      if (chance(Math.max(0, edge) * close * bobble * exposed * dt)) { deflectCatch(game, h, d); return; }
    }
  }

  // キャッチ際に触れた手がボールをはじく — ランダム方向へ飛び散るライブのルーズボール。
  // スティール/ターンオーバーは誰かが確保した時(secureLoose)にのみ記録。
export function deflectCatch(game: Game, h: Player, d: Player): void {
    // はじき方は手がボールのどこを捉えたかで決まる。方向は水平にランダム。
    const ang = rand(0, Math.PI * 2);
    const ballY = clamp(game.ball.pos.y, 0.35, 1.4);   // ボールが実際に在った位置から始める
    const contact = rand(0, 1);
    let vy: number, horiz: number;
    if (contact < 0.34) {                 // 下から捉えた → 上外へ跳ねる
      vy = rand(2.4, 4.6); horiz = rand(1.0, 3.2);
    } else if (contact < 0.67) {          // 側面をかすめた → ほぼ平行に飛ぶ
      vy = rand(-0.4, 0.9); horiz = rand(4.2, 7.5);
    } else {                              // 上から叩いた → 床へ叩き落とす
      vy = rand(-2.6, -0.6); horiz = rand(2.0, 5.0);
    }
    game.ball.pos.set(h.pos.x, ballY, h.pos.z);
    game.ball.vel.set(Math.cos(ang) * horiz, vy, Math.sin(ang) * horiz);
    game.lastTouch = d;
    h.touchCool = 0.5;                             // キャッチをはじかれた — すぐには再確保できない
    d.digReach(new Vector3(game.ball.pos.x, 0.9, game.ball.pos.z));
    flashBall(game, "intercept", d.team);          // はじいた側の色
    game.goLoose(h.team, 1.8, { stealBy: d, victim: h, grabAfter: 0.6 });
  }

  // 平行ジャンプステップ: 届くか届かないかの距離から、守備者がボールへ横っ飛びし手を乗せる。
  // 復帰はクロスオーバーのプラント硬直(0.3秒速い .. 2.5秒遅い)を使う。
export function stealLunge(game: Game, d: Player, tx: number, tz: number): void {
    const dx = tx - d.pos.x, dz = tz - d.pos.z;
    const gap = Math.hypot(dx, dz) || 1;
    const leap = clamp(gap - 0.25, 0, 0.95);       // 手がボールに乗る跳躍
    d.jump(0.16, 0.3, (dx / gap) * leap, (dz / gap) * leap);   // 低い平行ジャンプステップ
    d.setPlant(0.3 + (1 - rate(d.attr.agility)) * 2.2);        // クロスオーバープラント硬直
  }
