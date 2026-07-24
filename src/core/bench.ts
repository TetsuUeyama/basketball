// ベンチ演出（方式B: GameState 集約）。ベンチ選手の着席位置(benchSeat/seatOnBench)と、
// 得点/勝利時の歓声アニメ(benchCheer/updateBenchCheer)。状態は Game に集約し game を受け取る。
import { Vector3 } from "@babylonjs/core";
import { Player } from "../player";
import { COURT } from "../config";
import { clamp, rand, chance } from "../util";
import type { Game } from "../game";

export function benchSeat(game: Game, p: Player): { x: number; z: number } {
    const x = COURT.halfW + 2.3;                  // 遠い(+X)サイドライン、コートから後方に下げて
    const zEnd = COURT.halfL - 1;                 // 最初の席はベースラインのすぐ内側
    const z = (p.team === 0 ? -1 : 1) * (zEnd - p.idx * 0.8);
    return { x, z };
  }

export function seatOnBench(game: Game, p: Player): void {
    const s = benchSeat(game, p);
    p.pos.set(s.x, 0, s.z);
    p.cutting = false;
    p.screening = false;
    p.sit();          // 縮めてベンチの席へ落とす（座った見た目）
    p.sync();
  }

export function benchCheer(game: Game, team: number, duration = 1.8, amp = 0.5): void {
    const fresh = game.cheerT[team] <= 0;   // 前の歓声はすでに終了 → 新たに開始する
    game.cheerT[team] = Math.max(game.cheerT[team], duration);
    game.cheerAmp[team] = fresh ? amp : Math.max(game.cheerAmp[team], amp);
  }

  // 歓声が続く間、そのベンチの全員が両腕を上げて跳ねる。歓声が収まると着地し、
  // 腕を下ろして試合に向けて座り直す。ベンチ選手は他の場所で毎フレームの更新を
  // 受けないので、jump/sync はここで tick する。
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
        const frontX = seat.x - (0.8 + amp * 0.7);   // 大きなセレブレーションほど前へ踏み出す
        // 各控え選手は戻る前に各自の一拍だけ残る — だからベンチが一斉に
        // そろって座ることがない
        const windOff = ((p.idx * 37) % 10) * 0.08;   // 0 .. 約0.72秒の追加セレブレーション
        const winding = game.cheerT[t] <= -windOff;
        if (!winding) {
          p.stand();   // 席から立ち上がって祝う
          // ベンチの前へ踏み出し、ベンチをすり抜けて跳ばないようにする
          p.pos.x += (frontX - p.pos.x) * Math.min(1, dt * 5);
          p.pos.z = seat.z;
          // ダンク／スリーではより大きく、より頻繁に跳ぶ
          if (!p.airborne && chance((1.6 + amp * 2.4) * dt)) {
            p.jump(rand(0.2, 0.38) + amp * 0.4, rand(0.35, 0.55));
          }
          // 腕を頭上へ。選手ごとにわずかに角度を変え、ベンチがそろって同じように
          // 祝わないようにする。大きなプレイでは高く突き上げる
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
