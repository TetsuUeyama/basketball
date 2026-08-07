// 押し込むドリブルの実測: パワー差でどれだけ押し戻せるか / 技術と周りの敵で
// はたかれる頻度と使用頻度がどう変わるか。
import "./stubs";
import { NullEngine, Scene } from "@babylonjs/core";
import { Game } from "../src/game";
import { Player } from "../src/objects/player/player";
import { buildCourt } from "../src/objects/court";
Player.HEADLESS = true;
import { clubTeam } from "../src/roster";
import { powerShove } from "../src/ai/offense";

const engine = new NullEngine();
const scene = new Scene(engine);
const hoops = buildCourt(scene);
const game = new Game(scene);
(game as unknown as { attachHoops(h: unknown): void }).attachHoops(hoops);
clubTeam(0, 0); clubTeam(1, 1);
const g = game as unknown as { applyRoster(): void; reset(): void; update(dt: number): void };
g.applyRoster(); g.reset();

const h = game.players[0], d = game.players[5];
const setBal = (p: Player, v: number) => { (p.attr as { balance: number }).balance = v; };
const setHnd = (p: Player, v: number) => { (p.attr as { handling: number }).handling = v; };

// --- 1) パワー差 → 1秒あたりに押し戻せる距離 ---
console.log("攻バランス 守バランス  1秒で押し戻した距離(m)");
for (const [ob, db] of [[50, 50], [70, 50], [90, 50], [99, 30], [30, 90]]) {
  setBal(h, ob); setBal(d, db);
  h.pos.set(0, 0, 0); d.pos.set(0, 0, 0.8);
  h.driveTarget.set(0, 0, 6);   // +Z へ押し込む
  h.powerT = 9; game.handler = h; game.ballMode = "held";
  const z0 = d.pos.z;
  for (let i = 0; i < 60; i++) { d.pos.set(0, 0, h.pos.z + 0.8); powerShove(game, h, 1 / 60); }
  console.log(`  ${String(ob).padStart(3)}      ${String(db).padStart(3)}       ${(d.pos.z - z0).toFixed(3)}`);
}

// --- 2) 技術・寄せの人数 → はたかれるまでの時間 ---
console.log("\n技術  寄せ  はたかれるまで(秒, 3秒で無事なら-)");
for (const hnd of [20, 50, 80, 99]) {
  for (const helpers of [1, 2]) {
    setHnd(h, hnd); setBal(h, 60); setBal(d, 60);
    let sum = 0, n = 0;
    for (let trial = 0; trial < 40; trial++) {
      h.pos.set(0, 0, 0); h.driveTarget.set(0, 0, 6);
      game.handler = h; game.ballMode = "held"; h.powerT = 9;
      for (let k = 0; k < 5; k++) game.players[5 + k].pos.set(20, 0, 20);
      d.pos.set(0, 0, 0.8);
      for (let k = 1; k <= helpers; k++) game.players[5 + k].pos.set(0.7 * k, 0, 0.4);
      let t = 0;
      for (let i = 0; i < 180; i++) {
        t += 1 / 60;
        powerShove(game, h, 1 / 60);
        if (game.ballMode !== "held") break;
      }
      if (game.ballMode !== "held") { sum += t; n++; }
      game.ballMode = "held"; game.handler = h;
    }
    console.log(`  ${String(hnd).padStart(2)}    ${helpers}     ${n ? (sum / n).toFixed(2) + ` (${n}/40回)` : "- (0/40回)"}`);
  }
}
