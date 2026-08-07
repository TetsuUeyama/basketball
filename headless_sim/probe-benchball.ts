// ボールがベンチ(座面/背もたれ)を突き抜けないかを実測する。ベンチへ向かう軌道を
// 総当りで飛ばし、箱の内側に入ったフレームを数える。
import "./stubs";
import { Vector3 } from "@babylonjs/core";
import { BENCH } from "../src/config";
import { stepBallFlight, BALL } from "../src/move/basic/ball";

const ball = { pos: new Vector3(), vel: new Vector3() } as unknown as
  Parameters<typeof stepBallFlight>[0];

const x0 = BENCH.x - BENCH.seatD / 2, x1 = BENCH.x + BENCH.seatD / 2 + BENCH.backT;
const zLo = BENCH.zMid - BENCH.len / 2, zHi = BENCH.zMid + BENCH.len / 2;
// 箱の内側(表面ぶん甘くする): ここに入ったら「めり込んだ」
const inside = (p: Vector3): boolean => {
  const az = Math.abs(p.z);
  if (az < zLo || az > zHi) return false;
  const r = BALL.radius * 0.5;
  if (p.y < BENCH.seatTop - r && p.x > x0 + r && p.x < x1 - r) return true;          // 座面の中
  const rb = 0.02;   // 背もたれは厚み0.1なので判定の余白を小さく
  if (p.y < BENCH.backTop - rb && p.x > BENCH.x + BENCH.seatD / 2 + rb && p.x < x1 - rb) return true;  // 背もたれの中
  return false;
};

// 検出器そのものの確認(箱の中の点を「中」と言えるか)
console.log(`検出器チェック 座面の中=${inside(new Vector3(BENCH.x, 0.35, BENCH.zMid))}`
  + ` 背もたれの中=${inside(new Vector3(BENCH.x + BENCH.seatD / 2 + BENCH.backT / 2, 0.6, BENCH.zMid))}`
  + ` 座面の上=${inside(new Vector3(BENCH.x, 0.6, BENCH.zMid))}`);

let worst = 0, hits = 0, trials = 0;
for (let vx = 2; vx <= 9; vx += 1) {
  for (let vy = -3; vy <= 5; vy += 1) {
    for (let y0 = 0.2; y0 <= 1.6; y0 += 0.2) {
      for (let vz = -4; vz <= 4; vz += 2) {
        trials++;
        ball.pos.set(BENCH.x - 2.2, y0, BENCH.zMid);
        ball.vel.set(vx, vy, vz);
        for (let i = 0; i < 200; i++) {
          stepBallFlight(ball, 1 / 60, true);
          if (inside(ball.pos)) { hits++; worst = Math.max(worst, 1); break; }
        }
      }
    }
  }
}
console.log(`ベンチへ向けた軌道 ${trials} 本 / ボールが箱の中へ入った本数: ${hits}`);
