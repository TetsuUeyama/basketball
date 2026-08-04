// スローイン保持中の上腕(=袖)の向きを、修正前後で実測する。
// 修正前: ボールを投げ手自身の座標に置き reach(b,true)
// 修正後: ボールを胸の前 0.32m に置き holdBallHands(b)
import "./stubs";
import { NullEngine, Scene, TransformNode, Vector3 } from "@babylonjs/core";
import { buildVoxelBody } from "../src/objects/player/player-voxel";
import { armIKQuats } from "../src/animation/action/reach-ik";
import { BALL_HOLD } from "../src/systems/inbound";

const engine = new NullEngine();
const scene = new Scene(engine);
const vb = buildVoxelBody(scene, new TransformNode("p", scene), {
  name: "probe", balance: 50, height: 1.95,
  skin: { r: 0.7, g: 0.5, b: 0.4 }, hair: { r: 0.1, g: 0.1, b: 0.1 }, hairStyle: 0,
  kit: { top: { r: 1, g: 0.3, b: 0.1 }, bottom: { r: 0.8, g: 0.2, b: 0.1 }, shoes: { r: 1, g: 1, b: 1 } },
  jerseyText: "7",
});
const UP = vb.upperArm, FORE = vb.foreArm, SX = Math.abs(vb.shoulder.x), SY = vb.shoulder.y;
console.log(`上腕長 ${UP.toFixed(3)} 前腕(実効) ${FORE.toFixed(3)} 到達 ${(UP + FORE).toFixed(3)}m`);

// 選手は原点、正面(+Z)を向いている
function armAngle(side: "L" | "R", target: Vector3): string {
  const sx = side === "R" ? SX : -SX;
  const r = armIKQuats(sx, SY, vb.shoulder.z, 0, target, UP, FORE, (side === "R" ? 1 : -1) * 0.7);
  if (!r) {
    const d = target.subtract(new Vector3(sx, SY, vb.shoulder.z)).normalize();
    return `FK 向き(${d.x.toFixed(2)},${d.y.toFixed(2)},${d.z.toFixed(2)}) ${(Math.acos(-d.y) * 180 / Math.PI).toFixed(0)}°`;
  }
  const d = new Vector3(0, -1, 0).applyRotationQuaternion(r.qUp);
  return `IK 向き(${d.x.toFixed(2)},${d.y.toFixed(2)},${d.z.toFixed(2)}) ${(Math.acos(Math.max(-1, Math.min(1, -d.y))) * 180 / Math.PI).toFixed(0)}°`;
}

console.log("\n[修正前] ボール = 投げ手自身の座標 (0,1.3,0) / reach(b,true) は両腕とも同じ点へ");
console.log("  L:", armAngle("L", new Vector3(0, 1.3, 0)));
console.log("  R:", armAngle("R", new Vector3(0, 1.3, 0)));

// holdBallHands: 保持点の左右へ sep=0.13 ずらした点を各手が狙う
const hold = new Vector3(0, 1.3, BALL_HOLD);
console.log(`\n[修正後] ボール = 胸の前 ${BALL_HOLD}m (0,1.3,${BALL_HOLD}) / holdBallHands は左右に 0.13 分けて狙う`);
console.log("  L:", armAngle("L", new Vector3(hold.x - 0.13, hold.y, hold.z)));
console.log("  R:", armAngle("R", new Vector3(hold.x + 0.13, hold.y, hold.z)));

console.log("\n[参考] リリース: 進行方向1.2m先 (case \"pass\" — 既に正常)");
console.log("  L:", armAngle("L", new Vector3(0, 1.3, 1.2)));
console.log("  R:", armAngle("R", new Vector3(0, 1.3, 1.2)));
