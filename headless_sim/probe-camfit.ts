// カメラの画角保証: fitTargetToBall が返す注視点で、ボールが本当に画面内に入るかを
// Babylon の実射影行列(Vector3.Project)で独立に検証する。
import "./stubs";
import { NullEngine, Scene, ArcRotateCamera, Vector3, Matrix, Viewport } from "@babylonjs/core";
import { fitTargetToBall } from "../src/camera";

const engine = new NullEngine({
  renderWidth: 1280, renderHeight: 720, textureSize: 16,
  deterministicLockstep: false, lockstepMaxSteps: 1,
});
const scene = new Scene(engine);
const cam = new ArcRotateCamera("c", -Math.PI / 2, 0.95, 24, new Vector3(0, 1.2, 0), scene);
scene.activeCamera = cam;
const vp = new Viewport(0, 0, 1, 1);
const I = Matrix.Identity();

// 疑似乱数（固定シードで再現可能に）
let seed = 12345;
const rnd = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

let worst = 0, out = 0, corrected = 0, n = 0;
for (let i = 0; i < 20000; i++) {
  // ユーザーのドラッグ/ズームの全域を振る（main.ts の制限と同じ範囲）
  cam.alpha = (rnd() * 2 - 1) * Math.PI;
  cam.beta = 0.3 + rnd() * (1.45 - 0.3);
  cam.radius = 12 + rnd() * (48 - 12);
  // ボールはコート内＋高さ。注視点は最大12mずれた任意の点（先取り＋追従の遅れの最悪ケース）
  const bx = (rnd() * 2 - 1) * 7.5, bz = (rnd() * 2 - 1) * 14, by = 0.2 + rnd() * 6;
  const tx = bx + (rnd() * 2 - 1) * 12, tz = bz + (rnd() * 2 - 1) * 12, ty = 1.2;

  const fit = fitTargetToBall(cam, tx, ty, tz, bx, by, bz);
  if (Math.hypot(fit.x - tx, fit.y - ty, fit.z - tz) > 1e-9) corrected++;
  cam.target.set(fit.x, fit.y, fit.z);
  scene.updateTransformMatrix();
  const s = Vector3.Project(new Vector3(bx, by, bz), I, scene.getTransformMatrix(), vp);
  n++;
  // Viewport(0,0,1,1) なので s は 0..1。中心からの外れ具合を 0(中心)..1(縁) で測る
  const d = Math.max(Math.abs(s.x * 2 - 1), Math.abs(s.y * 2 - 1));
  if (d > worst) worst = d;
  if (d > 1) out++;
}
console.log(`${n} ケース: 画面外 ${out} / 補正が働いた ${corrected}`);
console.log(`中心からの最大外れ ${worst.toFixed(3)}  (1.0 = 画面の縁, 設計値 KEEP_IN=0.72)`);
