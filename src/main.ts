import {
  Engine, Scene, Color4, Color3, Vector3,
  HemisphericLight, DirectionalLight, ShadowGenerator,
} from "@babylonjs/core";
import { buildCourt } from "./court";
import { BroadcastCamera } from "./camera";
import { Game } from "./game";
import { UI } from "./ui";
import { TEAM_NAMES, TEAM_COLORS } from "./config";

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
ui.onBack = () => game.reset();                          // result → back to a clean pre-game
ui.onModelToggle = () => game.applyModelAll();           // 人型 ⇄ どんぐり体形を全員へ即時反映

// ---- pregame player-introduction camera tour ------------------------------
// After TIP OFF, before the game runs: the camera visits each STARTER (RED 5
// then BLUE 5) in a slightly-wide close-up filmed from the side his face
// renders, then each team's BENCH in ONE pulled-back cut that frames the whole
// row at once — and finally cuts back to the broadcast wide for the tip-off.
// A click/tap on the court skips to the next shot.
type IntroShot = { kind: "player"; p: ReturnType<typeof game.allPlayers>[number] }
  | { kind: "bench"; team: number };
let introQueue: IntroShot[] = [];
let introT = 0;
const HOLD_PLAYER = 0.9;   // seconds per starter close-up
const HOLD_BENCH = 2.0;    // the single whole-bench cut lingers a touch longer
const holdOf = (s: IntroShot): number => (s.kind === "player" ? HOLD_PLAYER : HOLD_BENCH);

// ---- intro caption board ---------------------------------------------------
// During the tour the floating 3D name tags are hidden; this DOM lower-third
// carries the caption instead — POSITION + NAME for the framed starter, and
// ONE combined board listing all eight bench players on the bench cut.
const introBoard = document.createElement("div");
Object.assign(introBoard.style, {
  position: "fixed", left: "50%", bottom: "14%", transform: "translateX(-50%)",
  display: "none", zIndex: "40", pointerEvents: "none",
  background: "rgba(8,11,18,0.9)", border: "1px solid rgba(255,255,255,0.18)",
  borderRadius: "10px", padding: "10px 22px", color: "#fff",
  fontFamily: "'Segoe UI',sans-serif", textAlign: "center",
  boxShadow: "0 6px 24px rgba(0,0,0,0.6)",
} as Partial<CSSStyleDeclaration>);
document.body.appendChild(introBoard);

function teamHex(t: number): string {
  const c = TEAM_COLORS[t];
  return `rgb(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)})`;
}
function posBadge(role: string, t: number, size: string): HTMLSpanElement {
  const s = document.createElement("span");
  s.textContent = role;
  Object.assign(s.style, {
    background: teamHex(t), color: "#0d1016", fontWeight: "900",
    borderRadius: "6px", padding: "1px 8px", fontSize: size, flexShrink: "0",
  } as Partial<CSSStyleDeclaration>);
  return s;
}
function setNameTags(visible: boolean): void {
  for (let t = 0; t < 2; t++) for (const p of game.allPlayers(t)) p.setNameTagVisible(visible);
}

let introShown: IntroShot | null = null;
function updateIntroBoard(s: IntroShot | null): void {
  if (s === introShown) return;
  const wasIdle = introShown === null;
  introShown = s;
  if (!s) {
    introBoard.style.display = "none";
    setNameTags(true);           // the tour is over — floating tags come back
    return;
  }
  if (wasIdle) setNameTags(false);   // tour begins — the board carries the names
  introBoard.style.display = "block";
  introBoard.replaceChildren();
  if (s.kind === "player") {
    const t = s.p.team;
    const teamLine = document.createElement("div");
    teamLine.textContent = TEAM_NAMES[t];
    Object.assign(teamLine.style, {
      fontSize: "11px", fontWeight: "800", letterSpacing: "2px",
      color: teamHex(t), marginBottom: "3px",
    } as Partial<CSSStyleDeclaration>);
    const line = document.createElement("div");
    Object.assign(line.style, {
      display: "flex", gap: "10px", alignItems: "center", justifyContent: "center",
      flexWrap: "nowrap",
    } as Partial<CSSStyleDeclaration>);
    const nm = document.createElement("span");
    nm.textContent = s.p.name;
    Object.assign(nm.style, {
      fontSize: "clamp(20px,5vw,28px)", fontWeight: "900",
      textShadow: "0 2px 6px rgba(0,0,0,0.7)",
      // a long name must NOT wrap the board to two lines — clip it with an …
      whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
      maxWidth: "min(64vw, 440px)",
    } as Partial<CSSStyleDeclaration>);
    line.append(posBadge(s.p.role, t, "clamp(14px,3vw,18px)"), nm);
    introBoard.append(teamLine, line);
  } else {
    const t = s.team;
    const teamLine = document.createElement("div");
    teamLine.textContent = `${TEAM_NAMES[t]} ベンチ`;
    Object.assign(teamLine.style, {
      fontSize: "12px", fontWeight: "800", letterSpacing: "2px",
      color: teamHex(t), marginBottom: "6px",
    } as Partial<CSSStyleDeclaration>);
    const grid = document.createElement("div");
    Object.assign(grid.style, {
      display: "grid", gridTemplateColumns: "auto auto", columnGap: "26px", rowGap: "4px",
    } as Partial<CSSStyleDeclaration>);
    for (const p of game.allPlayers(t).slice(5)) {
      const row = document.createElement("div");
      Object.assign(row.style, {
        display: "flex", gap: "8px", alignItems: "center", textAlign: "left",
      } as Partial<CSSStyleDeclaration>);
      const nm = document.createElement("span");
      nm.textContent = p.name;
      Object.assign(nm.style, {
        fontSize: "clamp(13px,3vw,16px)", fontWeight: "700",
        // keep every bench row to ONE line — clip long names with an …
        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
        maxWidth: "min(32vw, 170px)",
      } as Partial<CSSStyleDeclaration>);
      row.append(posBadge(p.role, t, "11px"), nm);
      grid.appendChild(row);
    }
    introBoard.append(teamLine, grid);
  }
}

// The camera wants the subject's FACE side — but another body standing in that
// line (the OPPOSING CENTRE faces him 1.4 m away at the tip-off circle) would
// sit right in front of the lens. Swing the camera around the subject —
// straight-on first, then ±31°, then ±54° — and take the first angle whose
// camera ray has no other player within 0.65 m of it.
function introDir(p: ReturnType<typeof game.allPlayers>[number]): { x: number; z: number } {
  const f = p.faceDirWorld();
  const others = [...game.allPlayers(0), ...game.allPlayers(1)];
  for (const a of [0, 0.55, -0.55, 0.95, -0.95]) {
    const d = { x: f.x * Math.cos(a) - f.z * Math.sin(a), z: f.x * Math.sin(a) + f.z * Math.cos(a) };
    const blocked = others.some((q) => {
      if (q === p) return false;
      const rx = q.pos.x - p.pos.x, rz = q.pos.z - p.pos.z;
      const t = rx * d.x + rz * d.z;                 // along the camera ray
      if (t < 0.4 || t > 4.4) return false;          // not between subject and lens
      return Math.abs(rx * d.z - rz * d.x) < 0.65;   // too close to the ray = かぶり
    });
    if (!blocked) return d;
  }
  return f;   // everyone is crowded in — accept the straight-on shot
}

ui.onStart = () => {
  game.applyRoster();
  game.reset();            // players take their tip-off spots / bench seats
  introQueue = [];
  for (let t = 0; t < 2; t++) {
    for (const p of game.allPlayers(t).slice(0, 5)) introQueue.push({ kind: "player", p });
    introQueue.push({ kind: "bench", team: t });
  }
  introT = holdOf(introQueue[0]);
};

canvas.addEventListener("pointerdown", () => {
  // during the intro a tap advances to the next shot immediately
  if (introQueue.length > 0) {
    introQueue.shift();
    if (introQueue.length > 0) introT = holdOf(introQueue[0]);
  }
});

engine.runRenderLoop(() => {
  // clamp dt so a stalled/refocused tab can't make the sim jump
  const dt = Math.min(engine.getDeltaTime() / 1000, 0.05);
  // only advance the sim while a game is being played (frozen on pre-game/result)
  if (ui.playing) {
    if (introQueue.length > 0) {
      // the game holds its breath while the camera tours the players — but the
      // meshes still have to FOLLOW the logical reset state (game.update isn't
      // running, so nothing else syncs bodies to their tip-off spots/seats)
      introT -= dt;
      if (introT <= 0) {
        introQueue.shift();
        if (introQueue.length > 0) introT = holdOf(introQueue[0]);
      }
      const s = introQueue[0];
      updateIntroBoard(s ?? null);
      if (s) {
        game.syncVisuals();
        const k = 1 - Math.max(0, introT) / holdOf(s);
        if (s.kind === "player") camera.introShot(s.p, k, introDir(s.p));
        else camera.benchShot(game.allPlayers(s.team).slice(5), k);
      } else {
        camera.endIntro();
      }
    } else {
      updateIntroBoard(null);   // no-op unless the tour just finished
      camera.endIntro();
      // run `speed` integer sub-steps so fast-forward stays numerically stable
      for (let i = 0; i < ui.speed; i++) game.update(dt);
    }
  } else if (introQueue.length > 0) {
    // BACK to the pregame mid-tour: abandon the intro and free the camera
    introQueue = [];
    updateIntroBoard(null);
    camera.endIntro();
  }
  ui.update(game);
  camera.update(dt, game.ball.pos.x, game.ball.pos.z, game.ball.pos.y, game.camFollowBall);
  scene.render();
});

window.addEventListener("resize", () => engine.resize());
