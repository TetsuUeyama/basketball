// 得点時の歓声ポーズの実測: 「両手上げ」で本当に両手が上がるか、片手上げのとき
// 逆腕がどれだけ曲がっているかを骨のワールド位置で見る。
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

function at(p: Player, bone: string): Vector3 {
  const n = p.vox!.rig.node(bone as never)!;
  n.computeWorldMatrix(true);
  return n.getAbsolutePosition();
}
// ポーズをイーズが収束するまで当て続ける(腕はレート制限で目標へ寄る)
function settle(p: Player, pose: () => void): void {
  for (let i = 0; i < 240; i++) { pose(); p.sync(); }
  p.root.computeWorldMatrix(true);
}
function report(label: string, p: Player): void {
  const head = at(p, "Head").y;
  const L = at(p, "LeftHand"), R = at(p, "RightHand");
  const up = (v: Vector3) => (v.y > head ? "頭より上" : "頭より下");
  console.log(`${label.padEnd(22)} 頭 ${head.toFixed(2)} | 左手 ${L.y.toFixed(2)}(${up(L)})`
    + ` 右手 ${R.y.toFixed(2)}(${up(R)})`
    + ` | 肘の曲げ L=${p.elbowL.rotation.x.toFixed(2)} R=${p.elbowR.rotation.x.toFixed(2)}`);
}

const p = game.roster[0][8];
p.stand(); p.resetFacing(); p.pos.set(9.0, 0, -6.6);

console.log(`身長 ${p.height.toFixed(2)}`);
// 旧: 頭上の点へ reach(両手指定)
settle(p, () => p.reach(new Vector3(p.pos.x, 3.15, p.pos.z), true));
report("旧 reach(頭上,両手)", p);
// 新: FKで両腕を上げる
settle(p, () => p.handsUp(0, 0.14, 0.06));
report("新 handsUp", p);
// 片手を高く（逆腕の曲げを見る）
settle(p, () => p.reach(new Vector3(p.pos.x + 0.45, 3.3, p.pos.z)));
report("片手を高く", p);
