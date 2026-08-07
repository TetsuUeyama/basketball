// 押し込みドリブルの半身: 左右の肩が進行方向(+Z)にどれだけ前後しているか。
import "./stubs";
import { NullEngine, Scene } from "@babylonjs/core";
import { Game } from "../src/game";
import { Player } from "../src/objects/player/player";
import { buildCourt } from "../src/objects/court";
Player.HEADLESS = false;
import { clubTeam } from "../src/roster";
const engine = new NullEngine(); const scene = new Scene(engine);
const hoops = buildCourt(scene); const game = new Game(scene);
(game as unknown as { attachHoops(h: unknown): void }).attachHoops(hoops);
clubTeam(0, 0); clubTeam(1, 1);
const g = game as unknown as { applyRoster(): void; reset(): void }; g.applyRoster(); g.reset();
const p = game.roster[0][0];
const z = (b: string): number => {
  const n = p.vox!.rig.node(b as never)!; n.computeWorldMatrix(true);
  return n.getAbsolutePosition().z - p.pos.z;
};
p.stand(); p.resetFacing(); p.pos.set(0, 0, 0); p.holdingBall = true; p.curSpd = 1.5;
for (const [label, pw] of [["通常ドリブル", 0], ["押し込み", 1]] as [string, number][]) {
  p.powerT = pw; p.clipName = ""; p.lastDt = 1 / 60;
  for (let i = 0; i < 20; i++) { p.stridePhase += 0.2; p.sync(); }
  p.root.computeWorldMatrix(true);
  console.log(`${label}: 左肩Z ${z("LeftUpperArm").toFixed(3)} / 右肩Z ${z("RightUpperArm").toFixed(3)}`
    + `  → 左肩が前に ${(z("LeftUpperArm") - z("RightUpperArm")).toFixed(3)} m  (clip=${p.clipName})`);
}

// 足と顔の向き(進行方向 +Z との差、度)
{
  const q = game.roster[0][1];
  q.stand(); q.resetFacing(); q.pos.set(0, 0, 0); q.holdingBall = true; q.curSpd = 1.5;
  q.powerT = 1; q.clipName = ""; q.lastDt = 1 / 60;
  for (let i = 0; i < 20; i++) { q.stridePhase += 0.2; q.sync(); }
  q.root.computeWorldMatrix(true);
  const fwd = (b: string): number => {
    const n = q.vox!.rig.node(b as never)!; n.computeWorldMatrix(true);
    const m = n.getWorldMatrix();
    return Math.atan2(m.m[8], m.m[10]) * 180 / Math.PI;   // ローカル+Zのワールド方位
  };
  console.log(`腰 ${fwd("Hips").toFixed(0)}° / 頭 ${fwd("Head").toFixed(0)}° / 左足 ${fwd("LeftFoot").toFixed(0)}°`);
}
