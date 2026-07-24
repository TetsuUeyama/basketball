import {
  Engine, Scene, Color4, Color3, Vector3,
  HemisphericLight, DirectionalLight, ShadowGenerator,
  UniversalCamera, Viewport, MeshBuilder, StandardMaterial,
} from "@babylonjs/core";
import { buildCourt } from "./court";
import { BroadcastCamera } from "./camera";
import { Game } from "./game";
import { optimizeLineups } from "./systems/lineups";
import { Player } from "./player";
import { ROSTER } from "./attributes";
import { UI } from "./ui";
import { TEAM_NAMES, TEAM_COLORS } from "./config";

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
// NOTE: preserveDrawingBuffer は意図的にOFF — WebGLの描画バッファをフレーム間で
// 保持するとブラウザのコンポジタ最適化が無効になり、アンチエイリアスと相まって
// モバイルGPUがときどき古い/クリアされていないフレーム(ちらつき / 弱いフラッシュ)を
// 表示する。これはキャンバスのスクリーンショットにだけ必要で、このアプリはそれを
// しない。スクリーンショット機能を追加する場合のみ再度有効にすること。
const engine = new Engine(canvas, true, { stencil: true });

const scene = new Scene(engine);
scene.clearColor = new Color4(0.04, 0.05, 0.07, 1);

// ライティング。空のヘミスフィアは上向きの面を照らす。groundColor は下向きの面
// (頭の下のくぼみ、シューズの裏側)に届くアンビエント — 低いままだとそれらの面が
// ほぼ黒になるので、ここで持ち上げてどの面も完全に暗くならないようにする。
const hemi = new HemisphericLight("hemi", new Vector3(0, 1, 0), scene);
hemi.intensity = 0.8;
hemi.groundColor = new Color3(0.42, 0.4, 0.38);

const sun = new DirectionalLight("sun", new Vector3(-0.4, -1, 0.3), scene);
sun.position = new Vector3(8, 18, -6);
sun.intensity = 0.9;

// 低い前方からの柔らかいフィルライト(シャドウなし)。太陽から背けた面 — と、法線が
// 軸から外れた手作りモデルの面 — も、無照明に見えず多少の光を受けるようにする。
const fill = new DirectionalLight("fill", new Vector3(0.3, 0.35, -1), scene);
fill.intensity = 0.35;

const camera = new BroadcastCamera(scene, canvas);

const hoops = buildCourt(scene);

// 選手とボール用の柔らかいシャドウ
const shadow = new ShadowGenerator(1024, sun);
shadow.useBlurExponentialShadowMap = true;
shadow.blurScale = 2;

const game = new Game(scene);
game.attachHoops(hoops);
for (let t = 0; t < 2; t++) {
  for (const p of game.allPlayers(t)) {
    // includeDescendants=false: 体のメッシュだけからシャドウを落とし、その新しい子
    // (髪/目)からは落とさない — さもないと髪のドームが肩/首に影を落とす
    // (「肩が光を失った」という報告)。
    for (const m of p.meshes) shadow.addShadowCaster(m, false);
  }
}
shadow.addShadowCaster(game.ball.mesh);

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
// 別個のシーンが、きれいな暗い背景の上に2体の選手モデル(ホーム / アウェイ)だけを
// 持つ — コート、フロア、他の選手はなし。各モデルは自分のビューポートカメラで
// フレーミングされ、固定表示される(1選手、切り替えなし)。クラブウィザードが開いている
// 間はメインシーンの代わりにこれをレンダリングする。
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
  // キャンバスのクリア色は暗色でなければならない(UIオーバーレイに合わせる): さもないと
  // 明るいクリアが選択シートの丸い角から透けて出る。キットが引き立つのに必要な明るい
  // 背景は、代わりに選手の後ろに置いた平面にする — こうすれば明るいのは2つの窓だけで、
  // シートの角は決して明るくならない。
  ps.clearColor = new Color4(0.031, 0.039, 0.059, 1);
  const backdrop = MeshBuilder.CreatePlane("pv_bg", { width: 40, height: 18 }, ps);
  backdrop.position.set(3, 5, -4);
  const bgMat = new StandardMaterial("pv_bgmat", ps);
  bgMat.emissiveColor = new Color3(0.80, 0.83, 0.88);   // 均一な明るさ、ライティングを無視
  bgMat.disableLighting = true;
  bgMat.backFaceCulling = false;
  backdrop.material = bgMat;
  const ph = new HemisphericLight("pv_hemi", new Vector3(0, 1, 0), ps);
  ph.intensity = 0.95;
  ph.groundColor = new Color3(0.45, 0.43, 0.4);
  const pd = new DirectionalLight("pv_dir", new Vector3(0.25, -0.5, -1), ps);
  pd.intensity = 0.7;
  // 片側1体ずつ、数メートル離して立たせる。各モデルは +Z(forward)を向くので、+Z側の
  // カメラはジャージの前面を見る。これらは汎用モデル(ユニフォームプレビュー専用)なので、
  // 浮かぶネームタグは非表示にする。
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

// ---- 試合前の選手紹介カメラツアー -----------------------------------------
// ティップオフ後、試合が走る前: カメラは各先発(RED 5人、続いてBLUE 5人)を、その
// 選手の顔がレンダリングされる側から撮った少し引いたクローズアップで巡り、その後
// 各チームのベンチを、列全体を一度に収める引きの1カットで映す — そして最後に
// ティップオフのため放送のワイドへ切り戻す。コートをクリック/タップすると次の
// ショットへスキップする。
type IntroShot = { kind: "player"; p: ReturnType<typeof game.allPlayers>[number] }
  | { kind: "bench"; team: number };
let introQueue: IntroShot[] = [];
let introT = 0;
const HOLD_PLAYER = 0.9;   // 先発1人のクローズアップあたりの秒数
const HOLD_BENCH = 2.0;    // ベンチ全体の1カットは少しだけ長めに留める
const holdOf = (s: IntroShot): number => (s.kind === "player" ? HOLD_PLAYER : HOLD_BENCH);

// ---- イントロ字幕ボード ----------------------------------------------------
// ツアー中は浮かぶ3Dネームタグを非表示にする。代わりにこのDOMの下部字幕が
// キャプションを担う — フレーミング中の先発はポジション + 名前、ベンチのカットでは
// 8人のベンチ選手全員を1つにまとめたボードで表示する。
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
    setNameTags(true);           // ツアー終了 — 浮かぶタグが戻る
    return;
  }
  if (wasIdle) setNameTags(false);   // ツアー開始 — ボードが名前を担う
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
      // 幅を固定し、ボードがどの選手でも同じサイズになるようにする(短い名前は
      // スロット内で中央寄せ、長い名前は … で切り詰める)。
      whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
      width: "min(64vw, 360px)", textAlign: "center",
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
        // 幅を固定し、ベンチ各行の名前列を同一にする(あふれた分は … で切り詰め)
        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
        width: "min(32vw, 150px)",
      } as Partial<CSSStyleDeclaration>);
      row.append(posBadge(p.role, t, "11px"), nm);
      grid.appendChild(row);
    }
    introBoard.append(teamLine, grid);
  }
}

// カメラは被写体の顔側を狙いたい — だがその線上に立つ別の体(ティップオフサークルで
// 1.4m先から相対する相手センター)がレンズの真ん前に来てしまう。被写体の周りで
// カメラを振る — まず正面、次に±31°、次に±54° — そして、そのカメラのレイの0.65m以内に
// 他の選手がいない最初の角度を採る。
function introDir(p: ReturnType<typeof game.allPlayers>[number]): { x: number; z: number } {
  const f = p.faceDirWorld();
  const others = [...game.allPlayers(0), ...game.allPlayers(1)];
  // 斜め構図の回り込みはチームで逆向き（チーム0=右回り優先 / チーム1=左回り優先）
  // — 両チームとも同じ側を向いた斜め顔が並ぶ単調さを崩す
  const s = p.team === 0 ? 1 : -1;
  for (const a of [0, 0.55 * s, -0.55 * s, 0.95 * s, -0.95 * s]) {
    const d = { x: f.x * Math.cos(a) - f.z * Math.sin(a), z: f.x * Math.sin(a) + f.z * Math.cos(a) };
    const blocked = others.some((q) => {
      if (q === p) return false;
      const rx = q.pos.x - p.pos.x, rz = q.pos.z - p.pos.z;
      const t = rx * d.x + rz * d.z;                 // カメラのレイに沿った成分
      if (t < 0.4 || t > 4.4) return false;          // 被写体とレンズの間にいない
      return Math.abs(rx * d.z - rz * d.x) < 0.65;   // レイに近すぎる = かぶり
    });
    if (!blocked) return d;
  }
  return f;   // 全員が密集している — 正面のショットで妥協する
}

ui.onStart = () => {
  game.applyRoster();
  game.reset();            // 選手はティップオフの位置 / ベンチの座席につく
  introQueue = [];
  for (let t = 0; t < 2; t++) {
    for (const p of game.allPlayers(t).slice(0, 5)) introQueue.push({ kind: "player", p });
    introQueue.push({ kind: "bench", team: t });
  }
  introT = holdOf(introQueue[0]);
};

canvas.addEventListener("pointerdown", () => {
  // イントロ中はタップで即座に次のショットへ進む
  if (introQueue.length > 0) {
    introQueue.shift();
    if (introQueue.length > 0) introT = holdOf(introQueue[0]);
  }
});

engine.runRenderLoop(() => {
  // dt をクランプし、停止/再フォーカスされたタブがシムを飛躍させないようにする
  const dt = Math.min(engine.getDeltaTime() / 1000, 0.05);
  // 試合がプレー中の間だけシムを進める(試合前/結果では凍結)
  if (ui.playing) {
    if (introQueue.length > 0) {
      // カメラが選手を巡る間、試合は息を止める — だがメッシュはやはり論理的な
      // リセット状態に追従しなければならない(game.update が走っていないので、他に
      // 体をティップオフ位置/座席に同期させるものがない)
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
      updateIntroBoard(null);   // ツアーが終わった直後でなければ何もしない
      camera.endIntro();
      // `speed` 個の整数サブステップを走らせ、早送りが数値的に安定するようにする
      for (let i = 0; i < ui.speed; i++) game.update(dt);
    }
  } else if (introQueue.length > 0) {
    // ツアーの途中で試合前へ戻る: イントロを中止してカメラを解放する
    introQueue = [];
    updateIntroBoard(null);
    camera.endIntro();
  }
  ui.update(game);
  camera.update(dt, game.ball.pos.x, game.ball.pos.z, game.ball.pos.y, game.camFollowBall);
  // クラブウィザードのユニフォームプレビューが出ている間は、専用のプレビューシーン
  // (孤立した選手、コートなし)だけをレンダリングする。それ以外はメインシーン。
  if (previewActive && previewScene) previewScene.render();
  else scene.render();
});

window.addEventListener("resize", () => engine.resize());

// ---- 画面を起こしたままにする(モバイル) -----------------------------------
// これは観戦シム — 視聴者はただ見るだけなので、定期的なタッチがないとスマホは試合中に
// 画面を暗くしロックする。Screen Wake Lock はページが表示されている間ディスプレイを
// 点けたままにする。OSはタブが隠れるたびにロックを自動解放するので、可視状態に戻る
// たびに再要求する。一部のブラウザではユーザー操作があるまで request() が拒否される
// ので、最初のポインタダウンでも再試行する。セキュアコンテキスト(https / localhost)が
// 必要。APIが利用できない環境ではこれは単に何もしない(他は何も変わらない)。
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
