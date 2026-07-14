import {
  Engine, Scene, Color4, Color3, Vector3,
  HemisphericLight, DirectionalLight, ShadowGenerator,
} from "@babylonjs/core";
import { buildCourt } from "./court";
import { BroadcastCamera } from "./camera";
import { Game } from "./game";
import { UI } from "./ui";

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
// NOTE: preserveDrawingBuffer is intentionally OFF — keeping the WebGL drawing
// buffer around between frames disables the browser's compositor optimisations
// and, with antialiasing, makes mobile GPUs occasionally show a stale/uncleared
// frame (a flicker / weak flash). It's only needed for canvas screenshots, which
// this app doesn't do. Re-enable only if a screenshot feature is added.
const engine = new Engine(canvas, true, { stencil: true });

const scene = new Scene(engine);
scene.clearColor = new Color4(0.04, 0.05, 0.07, 1);

// lighting. The sky hemisphere lights up-facing surfaces; groundColor is the
// AMBIENT that reaches DOWN-facing surfaces (the nook under the head, the
// undersides of the shoes) — kept low it leaves those faces near-black, so it's
// lifted here so no surface goes fully dark.
const hemi = new HemisphericLight("hemi", new Vector3(0, 1, 0), scene);
hemi.intensity = 0.8;
hemi.groundColor = new Color3(0.42, 0.4, 0.38);

const sun = new DirectionalLight("sun", new Vector3(-0.4, -1, 0.3), scene);
sun.position = new Vector3(8, 18, -6);
sun.intensity = 0.9;

// a soft FILL light from the low front (no shadows) so faces turned away from
// the sun — and any hand-built model face whose normal points off-axis — still
// catch some light instead of reading as unlit.
const fill = new DirectionalLight("fill", new Vector3(0.3, 0.35, -1), scene);
fill.intensity = 0.35;

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
    // includeDescendants=false: cast from the body meshes only, NOT their new
    // children (hair/eyes) — otherwise the hair dome throws a shadow onto the
    // shoulders/neck (the "shoulders lost light" report).
    for (const m of p.meshes) shadow.addShadowCaster(m, false);
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
