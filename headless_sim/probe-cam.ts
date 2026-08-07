// カメラの追従を実試合で回す: 攻める向きへの先取り量と、ボールが画面内に収まるか。
// main.ts と同じ引数で BroadcastCamera.update を呼び、Babylon の射影で毎フレーム検証する。
import "./stubs";
import { NullEngine, Scene, Vector3, Matrix, Viewport } from "@babylonjs/core";
import { Game } from "../src/game";
import { Player } from "../src/objects/player/player";
import { buildCourt } from "../src/objects/court";
Player.HEADLESS = true;
import { clubTeam } from "../src/roster";
import { BroadcastCamera } from "../src/camera";

const engine = new NullEngine({
  renderWidth: 1280, renderHeight: 720, textureSize: 16,
  deterministicLockstep: false, lockstepMaxSteps: 1,
});
const scene = new Scene(engine);
const hoops = buildCourt(scene);
const game = new Game(scene);
(game as unknown as { attachHoops(h: unknown): void }).attachHoops(hoops);
clubTeam(0, 0); clubTeam(1, 1);
const g = game as unknown as { applyRoster(): void; reset(): void; update(dt: number): void; state: string };
g.applyRoster(); g.reset();

// attachControl は canvas と window のイベント登録を要る。Node には無いので何もしない物を置く
const noopEl = {
  addEventListener: () => {}, removeEventListener: () => {},
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720 }),
};
// stubs.ts が window = globalThis を張るので、イベント登録だけ globalThis へ足す
const gt = globalThis as unknown as { addEventListener?: unknown; removeEventListener?: unknown };
gt.addEventListener ??= () => {};
gt.removeEventListener ??= () => {};
const bc = new BroadcastCamera(scene, noopEl as never);
scene.activeCamera = bc.cam;
const vp = new Viewport(0, 0, 1, 1), I = Matrix.Identity();

const zones = [
  { label: "自陣(残り>18m)", lo: 18, hi: 99, n: 0, sum: 0 },
  { label: "ハーフ付近(10-18m)", lo: 10, hi: 18, n: 0, sum: 0 },
  { label: "フロント(4-10m)", lo: 4, hi: 10, n: 0, sum: 0 },
  { label: "リム至近(<4m)", lo: -99, hi: 4, n: 0, sum: 0 },
];

// ユーザーのズーム相当（既定24 / 目一杯寄せた12）で2本回す
for (const radius of [24, 12]) {
  g.reset();
  bc.cam.radius = radius;
  bc.cam.alpha = -Math.PI; bc.cam.beta = 1.2;   // ティップ後の放送アングル
  let frames = 0, out = 0, worst = 0, leadSum = 0, leadN = 0;
  for (let i = 0; i < 60 * 60 * 5 && g.state !== "final"; i++) {
    g.update(1 / 60);
    bc.cam.radius = radius;   // ユーザーがズームを保持している想定
    bc.update(1 / 60, game.ball.pos.x, game.ball.pos.z, game.ball.pos.y, game.camFollowBall, game.attackGoalZ);
    scene.updateTransformMatrix();
    const s = Vector3.Project(game.ball.pos, I, scene.getTransformMatrix(), vp);
    const d = Math.max(Math.abs(s.x * 2 - 1), Math.abs(s.y * 2 - 1));
    frames++;
    if (d > worst) worst = d;
    if (d > 1) out++;
    if (game.ballMode === "held" || game.ballMode === "pass") {
      const sign = Math.sign(game.attackGoalZ) || 1;
      const lead = (bc.cam.target.z - game.ball.pos.z) * sign;
      leadSum += lead; leadN++;
      const gap = (game.attackGoalZ - game.ball.pos.z) * sign;   // 攻めるリムまでの残り
      const z = zones.find((q) => gap >= q.lo && gap < q.hi);
      if (z) { z.n++; z.sum += lead; }
    }
  }
  console.log(`radius=${radius}: ${frames}フレーム / 画面外 ${out} / 中心からの最大外れ ${worst.toFixed(3)}`
    + `  先取り平均 ${(leadN ? leadSum / leadN : 0).toFixed(2)} m`);
  for (const z of zones) {
    console.log(`    ${z.label.padEnd(20)} ${String(z.n).padStart(5)}フレーム  先取り ${(z.n ? z.sum / z.n : 0).toFixed(2)} m`);
    z.n = 0; z.sum = 0;
  }
}
