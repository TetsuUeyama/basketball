// ベンチ演出。ベンチ選手の着席位置(benchSeat/seatOnBench)と、
// 得点/勝利時の歓声アニメ(benchCheer/updateBenchCheer)。
import { Vector3 } from "@babylonjs/core";
import { Player } from "../objects/player/player";
import { COURT, INBOUNDS_INSET } from "../config";
import { rand, chance } from "../util";
import type { Game } from "../game";

  // チームのベンチ側ハーフのZ符号。
export function benchSideSign(team: number): number {
    return team === 0 ? -1 : 1;
  }

  // ベンチ前の集合地点(slot でずらす)。
export function benchGatherSpot(team: number, slot: number): { tx: number; tz: number } {
    return { tx: COURT.halfW + 0.6, tz: benchSideSign(team) * (8 + slot * 0.9) };
  }

export function benchSeat(game: Game, p: Player): { x: number; z: number } {
    const x = COURT.halfW + 2.3;                  // 遠い(+X)サイドライン、コートから後方に下げて
    const zEnd = COURT.halfL - INBOUNDS_INSET;    // 最初の席はベースラインのすぐ内側
    const z = benchSideSign(p.team) * (zEnd - p.idx * 0.8);
    return { x, z };
  }

export function seatOnBench(game: Game, p: Player): void {
    const s = benchSeat(game, p);
    p.pos.set(s.x, 0, s.z);
    p.cutting = false;
    p.screening = false;
    p.sit();          // 座った見た目にする
    p.sync();
  }

export function benchCheer(game: Game, team: number, duration = 1.8, amp = 0.5): void {
    const fresh = game.cheerT[team] <= 0;   // 前の歓声は終了済み
    game.cheerT[team] = Math.max(game.cheerT[team], duration);
    game.cheerAmp[team] = fresh ? amp : Math.max(game.cheerAmp[team], amp);
  }

  // 歓声が続く間ベンチ全員が両腕を上げて跳ね、収まると座り直す。
  // ベンチ選手は他所で毎フレーム更新を受けないので jump/sync をここで tick する。
export function updateBenchCheer(game: Game, dt: number): void {
    for (let t = 0; t < 2; t++) {
      if (game.cheerT[t] <= -1.6) continue;     // 完全に落ち着いた（この時点で全員着席済み）
      game.cheerT[t] -= dt;
      const amp = game.cheerAmp[t];   // セレブレーションの強さ（ダンク／スリー → 1.0）
      for (const p of game.roster[t]) {
        if (game.onCourt(p)) continue;
        if (game.subWalkers.some((w) => w.p === p)) continue; // 歩行中 — 歓声には参加しない
        p.updateJump(dt);
        const seat = benchSeat(game, p);
        const frontX = seat.x - (0.8 + amp * 0.7);   // 前へ踏み出す量
        // 各自の一拍だけ残してから戻る（一斉着席を避ける）
        const windOff = ((p.idx * 37) % 10) * 0.08;   // 0 .. 約0.72秒
        const winding = game.cheerT[t] <= -windOff;
        if (!winding) {
          p.stand();   // 席から立ち上がって祝う
          // ベンチの前へ踏み出す
          p.pos.x += (frontX - p.pos.x) * Math.min(1, dt * 5);
          p.pos.z = seat.z;
          // ダンク／スリーではより大きく、より頻繁に跳ぶ
          if (!p.airborne && chance((1.6 + amp * 2.4) * dt)) {
            p.jump(rand(0.2, 0.38) + amp * 0.4, rand(0.35, 0.55));
          }
          // 腕を頭上へ。選手ごとに角度を変える。大きなプレイでは高く突き上げる
          const ox = ((p.idx * 37) % 11 - 5) * 0.06;
          const oy = ((p.idx * 13) % 7) * 0.08;
          p.reach(new Vector3(p.pos.x + ox, 2.9 + oy + amp * 0.5, p.pos.z), true);
        } else {
          // 収束: 席へ歩いて戻り、着いたら座る
          p.pos.x += (seat.x - p.pos.x) * Math.min(1, dt * 5);
          if (!p.airborne && Math.abs(p.pos.x - seat.x) < 0.12) p.sit();
        }
        p.sync();
      }
    }
  }
