import {
  Engine, Scene, Color4, Color3, Vector3,
  HemisphericLight, DirectionalLight, ShadowGenerator,
} from "@babylonjs/core";
import { buildCourt } from "./court";
import { BroadcastCamera } from "./camera";
import { Game } from "./game";
import { UI } from "./ui";

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
const engine = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });

const scene = new Scene(engine);
scene.clearColor = new Color4(0.04, 0.05, 0.07, 1);

// lighting
const hemi = new HemisphericLight("hemi", new Vector3(0, 1, 0), scene);
hemi.intensity = 0.75;
hemi.groundColor = new Color3(0.2, 0.18, 0.16);

const sun = new DirectionalLight("sun", new Vector3(-0.4, -1, 0.3), scene);
sun.position = new Vector3(8, 18, -6);
sun.intensity = 0.9;

const camera = new BroadcastCamera(scene, canvas);

const hoops = buildCourt(scene);

// soft shadows for the players and ball
const shadow = new ShadowGenerator(1024, sun);
shadow.useBlurExponentialShadowMap = true;
shadow.blurScale = 2;

const game = new Game(scene);
game.attachHoops(hoops);
for (let t = 0; t < 2; t++) {
  for (const p of game.allPlayers(t)) {
    for (const m of p.meshes) shadow.addShadowCaster(m);
  }
}
shadow.addShadowCaster(game.ball.mesh);

const ui = new UI();
ui.onRestart = () => game.reset();                       // restart the current game
ui.onStart = () => { game.applyRoster(); game.reset(); }; // apply edits, then tip off
ui.onBack = () => game.reset();                          // result → back to a clean pre-game
ui.onModelToggle = () => game.applyModelAll();           // 人型 ⇄ どんぐり体形を全員へ即時反映

engine.runRenderLoop(() => {
  // clamp dt so a stalled/refocused tab can't make the sim jump
  const dt = Math.min(engine.getDeltaTime() / 1000, 0.05);
  // only advance the sim while a game is being played (frozen on pre-game/result)
  if (ui.playing) {
    // run `speed` integer sub-steps so fast-forward stays numerically stable
    for (let i = 0; i < ui.speed; i++) game.update(dt);
  }
  ui.update(game);
  camera.update(dt, game.ball.pos.x, game.ball.pos.z, game.ball.pos.y, game.camFollowBall);
  scene.render();
});

window.addEventListener("resize", () => engine.resize());
