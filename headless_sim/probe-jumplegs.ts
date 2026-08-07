// ジャンプ中/着地中の足の開き(左右方向の間隔)を実測する。
import "./stubs";
import { NullEngine, Scene, Vector3 } from "@babylonjs/core";
import { Game } from "../src/game";
import { Player } from "../src/objects/player/player";
import { buildCourt } from "../src/objects/court";
Player.HEADLESS = false;
import { clubTeam } from "../src/roster";

const engine = new NullEngine();
const scene = new Scene(engine);
const hoops = buildCourt(scene);
const game = new Game(scene);
(game as unknown as { attachHoops(h: unknown): void }).attachHoops(hoops);
clubTeam(0, 0); clubTeam(1, 1);
const g = game as unknown as { applyRoster(): void; reset(): void };
g.applyRoster();
g.reset();

const p = game.roster[0][0];
p.stand(); p.resetFacing(); p.pos.set(0, 0, 0);

function foot(bone: string): Vector3 {
  const n = p.vox!.rig.node(bone as never)!;
  n.computeWorldMatrix(true);
  return n.getAbsolutePosition();
}
// 体の左右方向(ローカル+X)のワールド向き
function lateral(): { x: number; z: number } {
  const th = p.root.rotation.y;
  return { x: Math.cos(th), z: -Math.sin(th) };
}
function gap(): { side: number; fore: number } {
  const L = foot("LeftFoot"), R = foot("RightFoot");
  const l = lateral();
  const dx = L.x - R.x, dz = L.z - R.z;
  return { side: Math.abs(dx * l.x + dz * l.z), fore: Math.abs(dx * -l.z + dz * l.x) };
}

console.log("局面           左右の足の間隔  前後のズレ  足のY(L/R)");
const show = (label: string): void => {
  p.root.computeWorldMatrix(true);
  const { side, fore } = gap();
  const L = foot("LeftFoot"), R = foot("RightFoot");
  console.log(`${label.padEnd(16)} ${side.toFixed(3)}          ${fore.toFixed(3)}      ${L.y.toFixed(2)}/${R.y.toFixed(2)}`);
};

// 立位
p.lastDt = 1 / 60; p.sync(); show("立位(idle)");

// 真上ジャンプ: 上昇中 / 頂点 / 落下中 / 接地直後 / 着地の終盤
p.jump(0.6, 0.7);
const steps = [
  { n: 6, label: "上昇中" }, { n: 15, label: "頂点付近" }, { n: 12, label: "落下中" },
];
let done = 0;
for (const s of steps) {
  for (let i = 0; i < s.n; i++) { p.lastDt = 1 / 60; p.updateJump(1 / 60); p.sync(); done++; }
  show(s.label);
}
// 残りの滞空を消化して着地へ
while (p.airborne) { p.lastDt = 1 / 60; p.updateJump(1 / 60); p.sync(); }
p.sync(); show("接地直後");
for (let i = 0; i < 15; i++) { p.lastDt = 1 / 60; p.landT = Math.max(0, p.landT - 1 / 60); p.sync(); }
show("着地の途中");
for (let i = 0; i < 30; i++) { p.lastDt = 1 / 60; p.landT = Math.max(0, p.landT - 1 / 60); p.sync(); }
show("着地の終盤");

// 選手ごとの開き方の差(左右それぞれの体中心からの横オフセット)
console.log("\nidx  左足の横  右足の横  合計");
for (const q of game.roster[0].slice(0, 5)) {
  q.stand(); q.resetFacing(); q.pos.set(0, 0, 0); q.lastDt = 1 / 60;
  q.jump(0.6, 0.7);
  for (let i = 0; i < 20; i++) { q.updateJump(1 / 60); q.sync(); }
  q.root.computeWorldMatrix(true);
  const nL = q.vox!.rig.node("LeftFoot" as never)!, nR = q.vox!.rig.node("RightFoot" as never)!;
  nL.computeWorldMatrix(true); nR.computeWorldMatrix(true);
  const L = nL.getAbsolutePosition(), R = nR.getAbsolutePosition();
  const th = q.root.rotation.y, lx = Math.cos(th), lz = -Math.sin(th);
  const lo = (L.x - q.pos.x) * lx + (L.z - q.pos.z) * lz;
  const ro = (R.x - q.pos.x) * lx + (R.z - q.pos.z) * lz;
  console.log(`${q.idx}    ${lo.toFixed(3)}     ${ro.toFixed(3)}    ${Math.abs(lo - ro).toFixed(3)}`);
}
