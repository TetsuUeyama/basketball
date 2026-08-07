// ベンチ着席の実測: 骨のワールド位置を出し、ベンチ(座面/背もたれ)の箱と突き合わせる。
import "./stubs";
import { NullEngine, Scene, Vector3 } from "@babylonjs/core";
import { Game } from "../src/game";
import { Player } from "../src/objects/player/player";
import { buildCourt } from "../src/objects/court";
Player.HEADLESS = false;   // ボクセル素体が要る(骨のワールド位置を測る)
import { clubTeam } from "../src/roster";
import { seatOnBench, benchSeat } from "../src/core/bench";

const engine = new NullEngine();
const scene = new Scene(engine);
const hoops = buildCourt(scene);
const game = new Game(scene);
(game as unknown as { attachHoops(h: unknown): void }).attachHoops(hoops);
clubTeam(0, 0); clubTeam(1, 1);
const g = game as unknown as { applyRoster(): void; reset(): void; update(dt: number): void };
g.applyRoster();
g.reset();

// ベンチの箱(objects/court.ts の buildBenches と同じ値)
const BX = 7.5 + 2.3;
const BENCH = {
  seat: { x0: BX - 0.225, x1: BX + 0.225, y0: 0.30, y1: 0.42 },
  back: { x0: BX + 0.225, x1: BX + 0.325, y0: 0.325, y1: 0.875 },
};
const inBox = (b: { x0: number; x1: number; y0: number; y1: number }, w: Vector3) =>
  w.x >= b.x0 && w.x <= b.x1 && w.y >= b.y0 && w.y <= b.y1;

function nodeAt(p: Player, bone: string): Vector3 | null {
  const n = p.vox?.rig.node(bone as never);
  if (!n) return null;
  n.computeWorldMatrix(true);
  return n.getAbsolutePosition();
}

// --- 1) 立位の基準値と、着席時の足の沈み ---
console.log("身長  hipY  腿    脛   立位足首Y | 着席: 股Y 膝Y 足首Y  沈み");
for (const p of game.roster[0]) {
  p.stand(); p.resetFacing(); p.pos.set(0, 0, 0); p.sync();
  p.root.computeWorldMatrix(true);
  const hipS = nodeAt(p, "LeftUpperLeg")!, kneeS = nodeAt(p, "LeftLowerLeg")!, ankS = nodeAt(p, "LeftFoot")!;
  const thigh = Vector3.Distance(hipS, kneeS), shin = Vector3.Distance(kneeS, ankS);
  const standAnk = ankS.y;
  seatOnBench(game, p);
  p.faceToward(0, p.pos.z);   // コートを向いて座る
  p.sync();
  p.root.computeWorldMatrix(true);
  const hip = nodeAt(p, "LeftUpperLeg")!, knee = nodeAt(p, "LeftLowerLeg")!, ank = nodeAt(p, "LeftFoot")!;
  console.log(`${p.height.toFixed(2)} ${(p.vox?.hipY ?? 0).toFixed(3)} ${thigh.toFixed(3)} ${shin.toFixed(3)}`
    + `  ${standAnk.toFixed(3)}    |  ${hip.y.toFixed(3)} ${knee.y.toFixed(3)} ${ank.y.toFixed(3)}`
    + `  ${(ank.y - standAnk).toFixed(3)}`);
}

// --- 2) 実試合を走らせ、ベンチの体がベンチの箱に埋まるフレームを数える ---
const BONES = ["Hips", "LeftLowerLeg", "RightLowerLeg", "LeftFoot", "RightFoot",
  "LeftLowerArm", "RightLowerArm", "LeftHand", "RightHand"];
const hits = new Map<string, number>();
let frames = 0, standInSeat = 0, offSeat = 0, standing = 0, offMin = 99, offMax = -99, offZ = 0, farSeat = 0;
for (let i = 0; i < 60 * 90; i++) {
  g.update(1 / 60);
  if (i % 3) continue;                        // 3フレームに1回サンプリング
  if (game.ballMode === "finale" || game.state === "final") continue;   // 試合後は全員を別管理
  frames++;
  for (let t = 0; t < 2; t++) {
    for (const p of game.roster[t]) {
      if (game.onCourt(p) || !p.vox) continue;
      const seat = benchSeat(game, p);
      if (!p.seated && Math.abs(p.pos.x - seat.x) < 0.30) standInSeat++;   // 立ったまま座面の中
      if (p.seated && Math.abs(p.pos.x - seat.x) > 0.05) {
        offSeat++;
        if (Math.abs(p.pos.x - seat.x) > 1 && farSeat++ < 3) {
          console.log(`   [席ズレ] ${p.name} team=${p.team} idx=${p.idx} mode=${game.ballMode}`
            + ` pos=(${p.pos.x.toFixed(2)},${p.pos.z.toFixed(2)}) 席=(${seat.x.toFixed(2)},${seat.z.toFixed(2)})`
            + ` walker=${game.subWalkers.some((w) => w.p === p)}`);
        }
        offMin = Math.min(offMin, p.pos.x); offMax = Math.max(offMax, p.pos.x);
        offZ = Math.max(offZ, Math.abs(p.pos.z - seat.z));
      }
      if (!p.seated) standing++;                                           // 座っていないベンチ選手
      p.root.computeWorldMatrix(true);
      for (const b of BONES) {
        const w = nodeAt(p, b);
        if (!w) continue;
        if (inBox(BENCH.seat, w) || inBox(BENCH.back, w)) {
          hits.set(b, (hits.get(b) ?? 0) + 1);
          if ((hits.get(b) ?? 0) <= 2) {
            console.log(`   [${b}] seated=${p.seated} armT=${p.benchArmT.toFixed(2)}`
              + ` clapT=${p.benchClapT.toFixed(2)} air=${p.airborne}`
              + ` x=${w.x.toFixed(3)} y=${w.y.toFixed(3)} 席x=${seat.x.toFixed(2)} 体x=${p.pos.x.toFixed(2)}`);
          }
        }
      }
    }
  }
}
console.log(`\nサンプル ${frames} フレーム / ベンチ26人ぶん`);
console.log("ベンチの箱に埋まった骨(のべ回数):");
for (const [b, n] of [...hits.entries()].sort((a, b2) => b2[1] - a[1])) console.log(`  ${b.padEnd(14)} ${n}`);
if (!hits.size) console.log("  なし");
console.log(`立ったまま座面の中: ${standInSeat} / 席からズレて着席: ${offSeat} (x ${offMin.toFixed(2)}..${offMax.toFixed(2)}, zズレ最大 ${offZ.toFixed(2)}) / 未着席: ${standing}`);
