import {
  Engine, Scene, Color4, Color3, Vector3,
  HemisphericLight, DirectionalLight,
  UniversalCamera, Viewport, MeshBuilder,
} from "@babylonjs/core";
import { buildCourt } from "./objects/court";
import { makeMat } from "./objects/materials";
import { addLights, addShadows } from "./scene-setup";
import { BroadcastCamera } from "./camera";
import { Game } from "./game";
import { optimizeLineups } from "./ai/lineups";
import { Player } from "./objects/player/player";
import { ROSTER } from "./roster";
import { UI } from "./ui/ui";
import { IntroTour } from "./intro";
import "./ui/ui-title";
import "./ui/ui-eval";
import "./ui/ui-pregame";
import "./ui/ui-pickers";
import "./ui/ui-result";
import "./ui/ui-hud";

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
// preserveDrawingBuffer は意図的にOFF（モバイルGPUのちらつき防止。スクショ時のみ有効化）。
const engine = new Engine(canvas, true, { stencil: true });

const scene = new Scene(engine);
scene.clearColor = new Color4(0.04, 0.05, 0.07, 1);

const { sun } = addLights(scene);

const camera = new BroadcastCamera(scene, canvas);

const hoops = buildCourt(scene);

const game = new Game(scene);
game.attachHoops(hoops);
addShadows(sun, game);   // 影は選手/ボールのメッシュに依存するので game 生成後

const ui = new UI();
ui.onRestart = () => game.reset();                       // 現在の試合を再スタート
ui.onBack = () => game.reset();                          // 結果 → きれいな試合前へ戻る
ui.onSetupLineups = () => optimizeLineups(game);         // マッチアップ確定時、相手を考慮したデフォルト5人
ui.onModelToggle = () => game.applyModelAll();           // 人型 ⇄ どんぐり体形を全員へ即時反映
ui.onUniformToggle = () => {                             // ホーム ⇄ アウェイのユニフォームを全員へ即時反映
  game.applyUniforms();
  if (previewPlayers) { previewPlayers[0].applyUniform(); previewPlayers[1].applyUniform(); }
};
// クラブ選択中、選んでいるチームの先発5人をコート上で大写しにする（null=通常の広角へ戻す）
ui.onShowcaseTeam = (team) => {
  if (team === null) camera.endShowcase();
  else camera.showcaseTeam(game.allPlayers(team).slice(0, 5));
};

// ---- 専用の3Dユニフォームプレビュー(クラブ選択) -------------------------
// 2体の選手モデル(ホーム/アウェイ)だけの別シーン。各自ビューポートカメラで固定表示。
// クラブウィザード表示中はメインシーンの代わりにこれをレンダリングする。
let previewScene: Scene | null = null;
let previewPlayers: [Player, Player] | null = null;
let previewCams: [UniversalCamera, UniversalCamera] | null = null;
let previewActive = false;

function rectToViewport(r: DOMRect): Viewport {
  const cr = canvas.getBoundingClientRect();
  const x = (r.left - cr.left) / cr.width;
  const w = r.width / cr.width;
  const h = r.height / cr.height;
  const y = 1 - (r.top - cr.top + r.height) / cr.height;   // Babylonのビューポート: 原点は左下
  return new Viewport(x, y, w, h);
}
function buildPreviewScene(): void {
  const ps = new Scene(engine);
  // クリア色は暗色（UIオーバーレイに合わせる）。明るい背景は選手の後ろの平面で作る。
  ps.clearColor = new Color4(0.031, 0.039, 0.059, 1);
  const backdrop = MeshBuilder.CreatePlane("pv_bg", { width: 40, height: 18 }, ps);
  backdrop.position.set(3, 5, -4);
  backdrop.material = makeMat(ps, "pv_bgmat",
    { emissive: new Color3(0.80, 0.83, 0.88), unlit: true, cull: false });   // 均一な明るさ、ライティングを無視
  const ph = new HemisphericLight("pv_hemi", new Vector3(0, 1, 0), ps);
  ph.intensity = 0.95;
  ph.groundColor = new Color3(0.45, 0.43, 0.4);
  const pd = new DirectionalLight("pv_dir", new Vector3(0.25, -0.5, -1), ps);
  pd.intensity = 0.7;
  // 2体を離して立たせる。各モデルは +Z(forward)を向くので +Z 側カメラが前面を見る。
  const home = new Player(ps, 0, 0, ROSTER[0][0]);
  const away = new Player(ps, 1, 0, ROSTER[1][0]);
  home.setNameTagVisible(false);
  away.setNameTagVisible(false);
  home.root.position.set(0, 0, 0);
  away.root.position.set(6, 0, 0);
  const camL = new UniversalCamera("pv_L", new Vector3(0, 1.3, 3.1), ps);
  const camR = new UniversalCamera("pv_R", new Vector3(6, 1.3, 3.1), ps);
  for (const c of [camL, camR]) { c.fov = 0.85; c.inputs.clear(); }
  camL.setTarget(new Vector3(0, 1.0, 0));
  camR.setTarget(new Vector3(6, 1.0, 0));
  ps.activeCameras = [camL, camR];
  previewScene = ps;
  previewPlayers = [home, away];
  previewCams = [camL, camR];
}
ui.onUniformPreview = (cfg) => {
  if (!cfg) { previewActive = false; return; }   // 停止 → メインシーンを再びレンダリング
  if (!previewScene) buildPreviewScene();
  previewCams![0].viewport = rectToViewport(cfg.left);
  previewCams![1].viewport = rectToViewport(cfg.right);
  previewPlayers![0].applyUniform();             // 現在選択中のキットを反映
  previewPlayers![1].applyUniform();
  previewActive = true;
};

const intro = new IntroTour(game, camera);

// ティップオフ後の放送アングル自動回転(一度きり)。camTipDone=済み / camTipArmT=ティップ終了後の経過
let camTipDone = true;
let camTipArmT = -1;

ui.onStart = () => {
  game.applyRoster();
  game.reset();            // 選手はティップオフの位置 / ベンチの座席につく
  intro.begin();
  camera.cancelAutoAngle();
  camTipDone = false; camTipArmT = -1;   // 新しい試合 → ティップオフ後の自動アングルを予約
};

canvas.addEventListener("pointerdown", () => {
  intro.skip();            // イントロ中はタップで即座に次のショットへ進む
  camera.cancelAutoAngle(); // ユーザーが触れたら自動アングル回転を止める(好みの角度を保持)
});
canvas.addEventListener("wheel", () => camera.cancelAutoAngle());

engine.runRenderLoop(() => {
  // dt をクランプし、停止/再フォーカスされたタブがシムを飛躍させないようにする
  const dt = Math.min(engine.getDeltaTime() / 1000, 0.05);
  // 試合がプレー中の間だけシムを進める(試合前/結果では凍結)
  if (ui.playing) {
    if (intro.active()) {
      intro.step(dt);           // イントロツアー中はカメラ・字幕を進め、試合は止める
    } else {
      intro.clear();            // ツアーが終わった直後でなければ何もしない
      // `speed` 個の整数サブステップを走らせ、早送りが数値的に安定するようにする
      for (let i = 0; i < ui.speed; i++) game.update(dt);
    }
  } else if (intro.active()) {
    intro.abort();              // ツアーの途中で試合前へ戻る: 中止してカメラを解放
  }
  ui.update(game);
  // ティップオフでボールが投げられ、しばらくしたら放送アングルを90°回す(ベンチを奥・やや見下ろし)。
  // ティップオフが終わってライブになってから一定時間で一度だけ発火。
  if (ui.playing && !intro.active() && !camTipDone) {
    if (camTipArmT < 0) { if (game.mode !== "tipoff") camTipArmT = 0; }
    else { camTipArmT += dt; if (camTipArmT >= 1.0) { camera.orientBroadcast(); camTipDone = true; } }
  }
  camera.update(dt, game.ball.pos.x, game.ball.pos.z, game.ball.pos.y, game.camFollowBall);
  // クラブウィザードのユニフォームプレビューが出ている間は、専用のプレビューシーン
  // (孤立した選手、コートなし)だけをレンダリングする。それ以外はメインシーン。
  if (previewActive && previewScene) previewScene.render();
  else scene.render();
});

window.addEventListener("resize", () => engine.resize());

// ---- 画面を起こしたままにする(モバイル) -----------------------------------
// Screen Wake Lock で表示中はディスプレイを点けたままにする。タブが隠れると解放される
// ので可視化・ポインタダウンで再要求。非対応環境では何もしない。
type WakeSentinel = { release: () => Promise<void>; addEventListener: (t: "release", cb: () => void) => void };
let wakeLock: WakeSentinel | null = null;
async function requestWakeLock(): Promise<void> {
  const wl = (navigator as unknown as { wakeLock?: { request: (t: "screen") => Promise<WakeSentinel> } }).wakeLock;
  if (!wl || wakeLock || document.visibilityState !== "visible") return;
  try {
    wakeLock = await wl.request("screen");
    wakeLock.addEventListener("release", () => { wakeLock = null; });
  } catch {
    wakeLock = null;   // まだ操作なし / 非対応 — タップか可視状態の変化で再試行する
  }
}
void requestWakeLock();
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void requestWakeLock();
});
window.addEventListener("pointerdown", () => { void requestWakeLock(); }, { passive: true });
