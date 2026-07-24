import { Game } from "../game";
import { TEAM_NAMES, TEAM_COLORS, HUD_OPTS, TEAM_CLUB, teamAbbr, teamShort } from "../config";
import { CLUB_ABBR } from "../clubabbr";
import { CLUB_FLAGS } from "../clubflags";
import { ROSTER, ROSTER_SIZE, STARTERS, randomizeRosters, randomizeTeam, clubTeam, applyDbPlayer, makeDefFromDb, ATTR_META, ABILITY_META, scoringPower, type Attributes, type PlayerDef } from "../attributes";
import { CLUBS } from "../clubdb";
import { PLAYER_DB, type DbPlayer } from "../playerdb";
import { playerLook } from "../objects/player/player-look";

export const colorOf = (team: number): string => {
  const c = TEAM_COLORS[team];
  return `rgb(${c.r * 255},${c.g * 255},${c.b * 255})`;
};

export type Phase = "title" | "pregame" | "playing" | "result";

// 選手がスタッツを記録した瞬間に、彼のアイコン上へ浮遊する「＋」バッジをポップ
// させる対象スタッツ（得点 / アシスト / リバウンド / スティール / ブロック / ターンオーバー）。
export const POP_STATS: { key: keyof import("../objects/player/stats").Stats; label: string; color: string }[] = [
  { key: "pts", label: "P", color: "#63e08c" },
  { key: "ast", label: "A", color: "#5ec8ff" },
  { key: "reb", label: "R", color: "#ffd85e" },
  { key: "stl", label: "S", color: "#ff9d43" },
  { key: "blk", label: "B", color: "#c98cff" },
  { key: "tov", label: "TO", color: "#ff6b6b" },
];

// 3画面を持つ DOM オーバーレイ: 試合前のロスターエディタ、試合中の HUD、
// そして各選手のボックススコアを表示する最終リザルト画面。
export class UI {
  root: HTMLDivElement;
  hud: HTMLDivElement;
  titlePanel!: HTMLDivElement;
  chooser: HTMLDivElement | null = null;   // リーグ/チーム選択ウィザードのオーバーレイ
  pregamePanel!: HTMLDivElement;
  editorHost!: HTMLDivElement;
  resultPanel!: HTMLDivElement;
  resultScore!: HTMLDivElement;
  resultWinner!: HTMLDivElement;
  resultStats!: HTMLDivElement;
  // リザルト画面のタブ: チーム比較 ⇄ 各チームのボックススコア
  resultGame: Game | null = null;
  resultTab: "team" | "blue" | "red" = "team";
  resultContent: HTMLDivElement | null = null;
  resultTabBtns: { key: "team" | "blue" | "red"; el: HTMLButtonElement }[] = [];
  tooltip!: HTMLDivElement;
  tipHideT = 0;   // 猶予期間つきの非表示待ち（scheduleHideTip 参照）
  tipTitle!: HTMLDivElement;
  tipBody!: HTMLDivElement;

  scoreA: HTMLSpanElement;
  scoreB: HTMLSpanElement;
  nameA!: HTMLElement;       // スコアボードのチームラベル（左）— クラブ選択後は略称
  nameB!: HTMLElement;       // スコアボードのチームラベル（右）
  clock: HTMLSpanElement;
  quarter: HTMLSpanElement;
  shot: HTMLSpanElement;
  shotBox!: HTMLDivElement;   // ショットクロックのコンテナ — 残り3秒で点滅する
  banner: HTMLDivElement;
  bannerKey = "";           // 現在のバナー内容（毎フレームの再構築を避けるため）
  subFeed!: HTMLDivElement;
  speedBtns: HTMLButtonElement[] = [];
  // 下部の選手バー: 各チームの顔アイコン。コート上 ⇄ ベンチを切り替える
  iconRows: HTMLDivElement[] = [];
  iconTabs: HTMLButtonElement[][] = [[], []];
  showBench: boolean[] = [false, false];
  iconKey: string[] = ["", ""];
  iconEl = new Map<import("../objects/player/player").Player, HTMLDivElement>(); // 選手 → 現在のアイコン要素
  iconStamina = new Map<import("../objects/player/player").Player, { bar: HTMLDivElement; fill: HTMLDivElement }>(); // 選手 → アイコンの体力バー
  iconRole = new Map<import("../objects/player/player").Player, HTMLDivElement>();   // 選手 → オフェンス/守備ロールのピル
  staminaBtn: HTMLButtonElement | null = null;   // HUD トグル: ゲージを名前タグ上 ⇄ 顔アイコン
  namesBtn: HTMLButtonElement | null = null;     // HUD トグル: コート上の名前タグ 表示 ⇄ 非表示
  modelBtn: HTMLButtonElement | null = null;     // HUD トグル: 人型 ⇄ どんぐり体形
  statSnap = new Map<import("../objects/player/player").Player, number[]>();     // 最後に確認した POP_STATS の値
  controls!: HTMLDivElement;      // 速度 / RESTART の行
  menuBtn!: HTMLButtonElement;    // ☰ ハンバーガー — スコアボードが届くまでは上端に乗る
  camHint!: HTMLDivElement;       // 「drag: orbit」ヒント — 左側で ☰ と同じ高さに保つ
  board!: HTMLDivElement;         // 中央寄せのスコアボード（その幅が ☰ の位置を決める）
  iconPanels: HTMLDivElement[] = []; // 2チームの顔アイコンパネル
  layoutMode = "";                // "desktop" | "phone" — リサイズ時に再計算

  phase: Phase = "pregame";
  playerCard!: HTMLDivElement;  // 試合前の浮遊詳細カード（ヘックスチャート）
  vsBoard: HTMLDivElement | null = null;  // VS 戦力ボード（重ならないようにする）
  vsPreviewActive = false;                // 交代/ロールのプレビューがボード上に表示中
  dragFrom: { team: number; idx: number } | null = null; // 運搬中のバー
  dragGhost: HTMLDivElement | null = null;               // 運ばれている名前バー
  dragHl: HTMLElement | null = null;                     // ハイライトされたドロップ先の行
  // 「carry」モード: DB から取り込む選手がカーソルに追従し、彼のチームのロスター
  // 行にドロップして選手を入れ替えるまで続く（ピッカーから開始）。
  carry: { team: number; dbp: DbPlayer } | null = null;
  carryGhost: HTMLDivElement | null = null;
  carryHint: HTMLDivElement | null = null;
  carryHl: HTMLElement | null = null;
  carryCleanup: (() => void) | null = null;
  rolePicker: HTMLDivElement | null = null;              // 開いている評価ロールメニュー
  rolePickerCloser: ((e: PointerEvent) => void) | null = null;
  detailModal: HTMLDivElement | null = null;             // 全能力値モーダル
  playerPicker: HTMLDivElement | null = null;            // 4000+選手データベースからの選手交代モーダル
  clubPicker: HTMLDivElement | null = null;              // 実クラブでロスターを組むモーダル
  // ビルトインのチーム名。クラブ名への変更前に捕捉しておき、ランダム編成で復元できるようにする
  static readonly DEFAULT_NAMES = [TEAM_NAMES[0], TEAM_NAMES[1]];
  // データベース全体を OVR 順にソートしたキャッシュビュー（初回オープン時に一度構築）:
  // { p, ovr, lower(name) } なので、キーストロークによる絞り込みは単純な配列走査で済む。
  dbIndex: { p: DbPlayer; ovr: number; lower: string }[] | null = null;
  rosterTab = 0;         // モバイル: どちらのチームのロスターカードを表示するか
  pregameMode = "";      // "phone" | "desktop" — 640px を跨いだら再描画

  speed = 1;
  onRestart: () => void = () => {};
  onStart: () => void = () => {};
  onBack: () => void = () => {};
  onSetupLineups: () => void = () => {};   // マッチアップが最初に決まったときの、相手を考慮した DEFAULT の5人
  onModelToggle: () => void = () => {};   // HUD_OPTS.model を全選手に適用
  onUniformToggle: () => void = () => {};  // TEAM_UNIFORM（ホーム/アウェイ）を全選手に適用
  // クラブ選択中に3Dコート上の1チームだけをフレーミング（null = 全景に戻す）
  onShowcaseTeam: (team: number | null) => void = () => {};
  // クラブ選択中の3Dユニフォーム二画面プレビュー: ホームチームの選手を `left` の
  // ウィンドウ矩形に、アウェイチームの選手を `right` に描画する（1人ずつ巡回）。
  // null にするとプレビューを解体し、通常のカメラに戻す。
  onUniformPreview: (cfg: { left: DOMRect; right: DOMRect; leftTeam: number; rightTeam: number } | null) => void = () => {};

  get playing(): boolean {
    return this.phase === "playing";
  }

  constructor() {
    const css = (el: HTMLElement, s: Partial<CSSStyleDeclaration>) => Object.assign(el.style, s);

    // スクロールバーが現れても伸びてはいけないスクロール行（アイコン行は収まる
    // リストとあふれるリストを切り替える）。バー自体を隠す
    const st = document.createElement("style");
    st.textContent =
      ".bball-hscroll{scrollbar-width:none;-ms-overflow-style:none}"
      + ".bball-hscroll::-webkit-scrollbar{display:none}";
    document.head.appendChild(st);

    this.root = document.createElement("div");
    css(this.root, {
      position: "fixed", inset: "0", pointerEvents: "none",
      fontFamily: "Segoe UI, system-ui, sans-serif", color: "#fff", userSelect: "none",
    });
    document.body.appendChild(this.root);

    this.hud = document.createElement("div");
    css(this.hud, { position: "absolute", inset: "0", pointerEvents: "none" });
    this.root.appendChild(this.hud);

    // ---- スコアボード ----
    const board = document.createElement("div");
    css(board, {
      position: "absolute", top: "14px", left: "50%", transform: "translateX(-50%)",
      display: "flex", alignItems: "center", gap: "18px",
      background: "rgba(12,15,22,0.82)", border: "1px solid rgba(255,255,255,0.12)",
      borderRadius: "12px", padding: "10px 20px", boxShadow: "0 6px 24px rgba(0,0,0,0.4)",
    });
    this.hud.appendChild(board);
    this.board = board;

    const colA = colorOf(0), colB = colorOf(1);
    this.nameA = this.teamBlock(teamAbbr(0), colA, "right"); board.appendChild(this.nameA);
    this.scoreA = this.scoreEl(colA); board.appendChild(this.scoreA);

    const mid = document.createElement("div");
    css(mid, { textAlign: "center", minWidth: "92px" });
    this.clock = document.createElement("span");
    css(this.clock, { fontSize: "22px", fontWeight: "700", letterSpacing: "1px", display: "block" });
    this.quarter = document.createElement("span");
    css(this.quarter, { fontSize: "12px", opacity: "0.7", display: "block" });
    mid.appendChild(this.clock); mid.appendChild(this.quarter);
    board.appendChild(mid);

    this.scoreB = this.scoreEl(colB); board.appendChild(this.scoreB);
    this.nameB = this.teamBlock(teamAbbr(1), colB, "left"); board.appendChild(this.nameB);

    // ---- ショットクロック ----
    const sc = document.createElement("div");
    css(sc, {
      position: "absolute", top: "92px", left: "50%", transform: "translateX(-50%)",
      background: "rgba(180,40,20,0.9)", borderRadius: "8px", padding: "2px 12px",
      fontSize: "16px", fontWeight: "700", minWidth: "34px", textAlign: "center",
    });
    this.shot = document.createElement("span");
    sc.appendChild(this.shot);
    this.hud.appendChild(sc);
    this.shotBox = sc;

    // ---- 交代フィード（メンバーチェンジ） ----
    // 画面中央、メインのイベントバナー（FOUL 等）のすぐ下。ファウルのバナーと
    // それに伴う交代を一緒に表示できるようにする
    this.subFeed = document.createElement("div");
    css(this.subFeed, {
      position: "absolute", top: "33%", left: "50%", transform: "translateX(-50%)",
      display: "flex", flexDirection: "column", gap: "8px", alignItems: "center",
      pointerEvents: "none", width: "max-content", maxWidth: "94vw",
    });
    this.hud.appendChild(this.subFeed);

    // ---- イベントバナー ----
    this.banner = document.createElement("div");
    css(this.banner, {
      position: "absolute", top: "27%", left: "50%", transform: "translate(-50%,-50%)",
      // レスポンシブ: 広い画面ではフルサイズ、ウィンドウが狭まると縮小
      fontSize: "clamp(28px,6.5vw,52px)", fontWeight: "800", letterSpacing: "2px", opacity: "0",
      textAlign: "center", transition: "opacity 0.2s", whiteSpace: "nowrap", maxWidth: "96vw",
      // くっきりした暗い縁取り（8方向）+ 柔らかいドロップシャドウ。チームカラーの
      // 文字がコートに溶け込まず鮮明に読めるようにする。text-shadow は継承される
      // ため、得点者/アシストのサブ行も同じ縁取りになる。
      textShadow: [
        "1px 1px 0 #000", "-1px 1px 0 #000", "1px -1px 0 #000", "-1px -1px 0 #000",
        "0 2px 0 #000", "0 -2px 0 #000", "2px 0 0 #000", "-2px 0 0 #000",
        "0 5px 18px rgba(0,0,0,0.7)",
      ].join(", "),
    });
    this.hud.appendChild(this.banner);

    // ---- コントロール: 右側のハンバーガーメニュー。広い画面では上端（スコア
    // ボードと同じ高さ）に乗り、中央寄せのスコアボードが届くほど広がったときだけ
    // ボードの下に落ちる（positionMenu 参照）。 ----
    const menuBtn = this.button("☰");
    this.menuBtn = menuBtn;
    Object.assign(menuBtn.style, {
      position: "absolute", top: "14px", right: "14px", pointerEvents: "auto",
      fontSize: "18px", lineHeight: "1", padding: "7px 12px", zIndex: "20",
    } as Partial<CSSStyleDeclaration>);
    this.hud.appendChild(menuBtn);

    const controls = document.createElement("div");
    this.controls = controls;
    css(controls, {
      position: "absolute", top: "132px", right: "14px", display: "none",
      flexDirection: "column", gap: "6px", pointerEvents: "auto", zIndex: "20",
      background: "rgba(12,15,22,0.94)", border: "1px solid rgba(255,255,255,0.15)",
      borderRadius: "10px", padding: "8px", boxShadow: "0 8px 24px rgba(0,0,0,0.55)",
    });
    this.hud.appendChild(controls);
    menuBtn.onclick = () => { controls.style.display = controls.style.display === "none" ? "flex" : "none"; };
    // クリックがドロップダウン本体/☰ボタンの外なら閉じる（開いたまま固まる問題の解消）。
    // ☰自体は除外 — 除外しないと pointerdown で閉じた直後に click トグルで再び開いてしまう
    window.addEventListener("pointerdown", (e) => {
      if (this.controls.style.display === "none") return;
      const t = e.target as Node;
      if (this.controls.contains(t) || this.menuBtn.contains(t)) return;
      this.controls.style.display = "none";
    });

    const speedRow = document.createElement("div");
    Object.assign(speedRow.style, { display: "flex", gap: "6px" } as Partial<CSSStyleDeclaration>);
    for (const s of [1, 2, 4]) {
      const b = this.button(`${s}x`);
      b.onclick = () => { this.speed = s; this.refreshSpeed(); };
      this.speedBtns.push(b);
      speedRow.appendChild(b);
    }
    controls.appendChild(speedRow);

    // 体力バーの表示位置トグル: 名前タグの下 ⇄ 顔アイコンの下
    const staminaBtn = this.button("");
    this.staminaBtn = staminaBtn;
    this.refreshStaminaBtn();
    staminaBtn.onclick = () => {
      HUD_OPTS.staminaOn = HUD_OPTS.staminaOn === "name" ? "icon" : "name";
      HUD_OPTS.rev++;                 // 全ての名前タグを再描画させる
      this.iconKey = ["", ""];        // アイコン行を再構築させる（バーの表示/非表示）
      this.refreshStaminaBtn();
    };
    controls.appendChild(staminaBtn);

    // コート上の名前タグの表示オン/オフ
    const namesBtn = this.button("");
    this.namesBtn = namesBtn;
    this.refreshNamesBtn();
    namesBtn.onclick = () => {
      HUD_OPTS.showNames = !HUD_OPTS.showNames;
      HUD_OPTS.rev++;                 // 全ての名前タグを再描画させる（表示状態を反映）
      this.refreshNamesBtn();
    };
    controls.appendChild(namesBtn);

    // 選手モデルの切替: 人型（関節脚つき） ⇄ どんぐり体形（カプセル）
    const modelBtn = this.button("");
    this.modelBtn = modelBtn;
    this.refreshModelBtn();
    modelBtn.onclick = () => {
      HUD_OPTS.model = HUD_OPTS.model === "human" ? "acorn" : "human";
      this.onModelToggle();
      this.refreshModelBtn();
    };
    controls.appendChild(modelBtn);

    const restart = this.button("RESTART");
    restart.onclick = () => { this.onRestart(); controls.style.display = "none"; };
    controls.appendChild(restart);

    const hint = document.createElement("div");
    // 左上。☰ と同じ高さに保つ（positionMenu が top を同期させる）。下部は顔
    // アイコン HUD に取られ、中央寄せのスコアボードは固定の top:10px と重なる
    // ため、メニューと同じ行の反対側に乗せる。
    css(hint, {
      position: "absolute", top: "14px", left: "12px", fontSize: "12px",
      opacity: "0.5", pointerEvents: "none",
    });
    hint.textContent = "drag: orbit  ·  wheel: zoom";
    this.hud.appendChild(hint);
    this.camHint = hint;

    this.buildPlayerBars();
    this.buildTooltip();
    this.buildTitle();
    this.buildPregame();
    this.buildResult();
    this.refreshSpeed();
    this.setPhase("title");
    // 矩形は最初のレイアウトパスの後でのみ有効
    requestAnimationFrame(() => this.positionMenu());
    window.addEventListener("resize", () => this.positionMenu());
  }

  // ホバー時に表示される小さな浮遊説明。ヘッダーの下にアンカーされる。
  buildTooltip(): void {
    const tip = document.createElement("div");
    Object.assign(tip.style, {
      // <body> に fixed で配置（root の内側ではない）: root は fixed-position の
      // スタッキングコンテキストなので、その内側のツールチップは、注釈すべき
      // body レベルのポップアップ（ロールピッカー z80、ドラッグゴースト z70）より上に出られない
      position: "fixed", display: "none", maxWidth: "300px",
      background: "rgba(18,22,30,0.98)", border: "1px solid rgba(255,255,255,0.25)",
      borderRadius: "8px", padding: "10px 12px", pointerEvents: "none", zIndex: "90",
      boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
      fontFamily: "Segoe UI, system-ui, sans-serif", color: "#fff",
    } as Partial<CSSStyleDeclaration>);

    this.tipTitle = document.createElement("div");
    Object.assign(this.tipTitle.style, { fontSize: "13px", fontWeight: "800", marginBottom: "5px" });
    this.tipBody = document.createElement("div");
    Object.assign(this.tipBody.style, { fontSize: "12px", lineHeight: "1.65", opacity: "0.92" });

    tip.append(this.tipTitle, this.tipBody);
    // スタッツのツールチップはボタンを含むため、マウスがツールチップ上に移動
    // しても消えてはならない（代わりに猶予期間つきで非表示をスケジュールする）
    tip.onmouseenter = () => { if (this.tipHideT) { window.clearTimeout(this.tipHideT); this.tipHideT = 0; } };
    tip.onmouseleave = () => this.hideTip();
    document.body.appendChild(tip);
    this.tooltip = tip;
  }

  // 同じ浮遊ツールチップだが、自由形式のタイトル/本文（ロールの説明など —
  // INFO に登録されていないもの全般）。
  showTextTip(title: string, body: string, anchor: HTMLElement): void {
    // 新しいツールチップを表示するときは、マウスが直前に離れたアイコン/アンカー
    // に残っている猶予期間つきの非表示待ちをキャンセルする — さもないと古い
    // タイマーが発火してこのツールチップを消してしまう（アイコン間で「出てすぐ消える」ちらつき）
    if (this.tipHideT) { window.clearTimeout(this.tipHideT); this.tipHideT = 0; }
    this.tipTitle.style.color = "#fff";
    this.tipTitle.textContent = title;
    this.tipBody.textContent = body;
    const tip = this.tooltip;
    tip.style.pointerEvents = "none";   // 単なるテキストのツールチップはボタンを持たない
    tip.style.display = "block";
    // ヘッダーの下にアンカーし、幅が判明したらビューポート内に収める
    const r = anchor.getBoundingClientRect();
    let left = r.left;
    const tw = tip.offsetWidth;
    if (left + tw > window.innerWidth - 8) left = window.innerWidth - 8 - tw;
    if (left < 8) left = 8;
    tip.style.left = `${left}px`;
    tip.style.top = `${r.bottom + 6}px`;
  }

  hideTip(): void {
    if (this.tipHideT) { window.clearTimeout(this.tipHideT); this.tipHideT = 0; }
    this.tooltip.style.display = "none";
    this.tooltip.style.pointerEvents = "none";
  }

  /** 短い猶予期間の後にツールチップを非表示にする — マウスがツールチップ自体
   *  に到達した場合はキャンセルされる（ボタンを持つことがあるため）。 */
  scheduleHideTip(): void {
    if (this.tipHideT) window.clearTimeout(this.tipHideT);
    this.tipHideT = window.setTimeout(() => { this.tipHideT = 0; this.hideTip(); }, 200);
  }

  // 選手アイコンをホバー → 彼のライブなボックススコアを、アイコンの上に浮かせて
  // 表示する（アイコンは画面下部付近にある）。
  showStatTip(player: import("../objects/player/player").Player, anchor: HTMLElement): void {
    // 直前に離れたアイコンからの古い猶予期間つき非表示をキャンセル（showTextTip 参照）
    if (this.tipHideT) { window.clearTimeout(this.tipHideT); this.tipHideT = 0; }
    this.tipTitle.style.color = colorOf(player.team);
    this.tipTitle.textContent = `#${player.idx + 1}  ${player.name}`;
    const s = player.stats;
    const cell = (label: string, v: number | string): string =>
      `<span style="display:inline-block;min-width:66px"><b style="opacity:.6">${label}</b> ${v}</span>`;
    this.tipBody.innerHTML =
      `<div>${cell("PTS", s.pts)}${cell("REB", s.reb)}${cell("AST", s.ast)}</div>` +
      `<div>${cell("STL", s.stl)}${cell("BLK", s.blk)}${cell("TO", s.tov)}</div>` +
      `<div style="margin-top:3px;opacity:.8">FG ${s.fgm}/${s.fga}　MIN ${(s.min / 60).toFixed(1)}</div>`;
    // ステータス確認 → この選手の試合前の全能力値モーダル（25 の能力値、
    // ヘックスチャート、特殊能力、手動設定の評価ロール）
    const btn = this.button("ステータス確認");
    Object.assign(btn.style, {
      display: "block", width: "100%", marginTop: "7px", fontSize: "11px",
      padding: "5px 0", boxSizing: "border-box",
    } as Partial<CSSStyleDeclaration>);
    btn.onclick = () => {
      this.hideTip();
      const def = ROSTER[player.team]?.[player.idx];
      if (def) this.openDetailModal(def, player.team);
    };
    this.tipBody.appendChild(btn);
    const tip = this.tooltip;
    tip.style.pointerEvents = "auto";   // ボタンをクリック可能にする必要がある
    tip.style.display = "block";
    const r = anchor.getBoundingClientRect();
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let left = r.left + r.width / 2 - tw / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - 8 - tw));
    tip.style.left = `${left}px`;
    tip.style.top = `${Math.max(8, r.top - th - 8)}px`;   // アイコンの上
  }

  // ---- 画面 -----------------------------------------------------------

  panel(): HTMLDivElement {
    const p = document.createElement("div");
    Object.assign(p.style, {
      position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)",
      display: "flex", flexDirection: "column", alignItems: "center", gap: "10px",
      background: "rgba(12,15,22,0.94)", border: "1px solid rgba(255,255,255,0.14)",
      borderRadius: "16px", padding: "clamp(12px, 2vw, 18px)", boxShadow: "0 12px 44px rgba(0,0,0,0.55)",
      pointerEvents: "auto", textAlign: "center",
      width: "auto", maxWidth: "96vw", maxHeight: "96vh", boxSizing: "border-box",
      overflow: "auto",
    } as Partial<CSSStyleDeclaration>);
    return p;
  }

  // CLUB_FLAGS のデザイン（[pattern, ...hexColours]）から、クラブ「フラッグ」用の
  // CSS 背景を組み立てる。クラブに定義がなければ中立的なグレーにフォールバックする。
  static flagCss(def: string[] | undefined): string {
    if (!def || def.length < 2) return "rgba(255,255,255,0.12)";
    const [pat, ...cols] = def;
    const c = (i: number) => `#${cols[Math.min(i, cols.length - 1)]}`;
    const bands = (deg: number) => {
      const step = 100 / cols.length;
      const stops = cols.map((h, i) => `#${h} ${(i * step).toFixed(2)}% ${((i + 1) * step).toFixed(2)}%`).join(",");
      return `linear-gradient(${deg}deg, ${stops})`;
    };
    switch (pat) {
      case ".": return c(0);
      case "v": return bands(90);          // 縦縞 / 左右分割
      case "h": return bands(180);         // 横帯
      case "s": return `linear-gradient(180deg, ${c(0)} 0 34%, ${c(1)} 34% 66%, ${c(0)} 66% 100%)`;  // 中央の帯（サッシュ）
      case "b": return `linear-gradient(90deg, ${c(0)} 0 33%, ${c(1)} 33% 67%, ${c(0)} 67% 100%)`;   // 縦の中央帯
      case "d": return `linear-gradient(120deg, ${c(0)} 0 40%, ${c(1)} 40% 60%, ${c(0)} 60% 100%)`;  // 斜めの帯（サッシュ）
      case "o": return `repeating-linear-gradient(180deg, ${c(0)} 0 18%, ${c(1)} 18% 36%)`;          // 横縞（フープ）
      case "dh": return `linear-gradient(135deg, ${c(0)} 0 50%, ${c(1)} 50% 100%)`;                  // 斜め二分割
      case "q": return `conic-gradient(${c(0)} 0 25%, ${c(1)} 25% 50%, ${c(0)} 50% 75%, ${c(1)} 75% 100%)`; // 四分割
      case "c": // 十字: base[0] の上に縦 + 横の band[1]
        return `linear-gradient(90deg, transparent 38%, ${c(1)} 38% 62%, transparent 62%),`
          + `linear-gradient(180deg, transparent 34%, ${c(1)} 34% 66%, transparent 66%), ${c(0)}`;
      default: return c(0);
    }
  }


  // ---- 試合前: VS 戦力ボード + コンパクトなロスターカード ------------------

  // ヘックスチャートおよびチーム戦力比較の6軸 — 25 の能力値の重み付け
  // ダイジェスト（能力値そのものはここでは編集されず、読み取るだけ）。
  static readonly HEX_AXES: { label: string; calc: (a: Attributes) => number }[] = [
    { label: "シュート", calc: (a) => a.midAcc * 0.45 + a.threeAcc * 0.35 + a.shotTech * 0.2 },
    { label: "ドリブル", calc: (a) => a.handling * 0.4 + a.dribbleAcc * 0.35 + a.dribbleSpd * 0.25 },
    { label: "パス", calc: (a) => a.passAcc * 0.5 + a.passSpd * 0.25 + a.offense * 0.25 },
    { label: "スピード", calc: (a) => a.speed * 0.35 + a.accel * 0.25 + a.agility * 0.4 },
    { label: "フィジカル", calc: (a) => a.balance * 0.45 + a.jump * 0.3 + a.stamina * 0.25 },
    { label: "ディフェンス", calc: (a) => a.defense * 0.6 + a.reaction * 0.2 + a.agility * 0.2 },
  ];
  // 各ポジションが実際に必要とするもの、軸ごとに（HEX_AXES と同じ順）、加えて
  // そこで素の身長がどれだけ重要か。単純平均では全選手が同じ評価になってしまう —
  // これはロールの必要性と選手のピークを重み付けする。
  static readonly ROLE_W: Record<string, { ax: number[]; ht: number }> = {
    //        シュート ドリブル  パス  スピード フィジカル 守備     身長
    PG: { ax: [0.16, 0.24, 0.28, 0.20, 0.03, 0.09], ht: 0.00 },
    SG: { ax: [0.30, 0.18, 0.10, 0.20, 0.07, 0.15], ht: 0.00 },
    SF: { ax: [0.22, 0.13, 0.10, 0.17, 0.18, 0.20], ht: 0.05 },
    PF: { ax: [0.14, 0.06, 0.06, 0.10, 0.32, 0.20], ht: 0.12 },
    C:  { ax: [0.10, 0.04, 0.05, 0.08, 0.35, 0.23], ht: 0.15 },
  };

  // 評価ロール: 手動設定したロールはポジションの重みを上書きする — 同じ選手でも
  // エースとしてと 3&D 要員としてとでは評価が変わる。ロールは attributes.ts の
  // ROLE_BEHAVIOR 経由で試合中の挙動も変える（仮想の特殊能力 + 優先度/プレイ
  // メイキングのシフト。applyDef 内でティップオフ時に適用）。
  // `pos` = そのロールを取れるポジション; undefined = 全ポジション共通
  // （現代のポジション横断的な仕事）。`short` = ピルに表示されるコード。
  static readonly EVAL_ROLES: Record<string, { ax: number[]; ht: number; short: string; pos?: string[]; tip: string }> = {
    //                       シュート ドリブル  パス  スピード フィジカル 守備      身長
    // --- ガード/ハンドラー系 ---
    メインハンドラー:      { ax: [0.10, 0.26, 0.30, 0.22, 0.03, 0.09], ht: 0.00, short: "HDL", pos: ["PG", "SG", "SF"],
      tip: "常にボールを持ちオフェンスを組み立てる第1の起点。パスとドリブルを最重視。" },
    セカンドハンドラー:    { ax: [0.18, 0.22, 0.24, 0.18, 0.06, 0.12], ht: 0.00, short: "2ND", pos: ["PG", "SG", "SF"],
      tip: "メインハンドラーが抑えられた時や逆サイド展開時の第2の組み立て役。" },
    フロアジェネラル:      { ax: [0.08, 0.16, 0.40, 0.14, 0.06, 0.16], ht: 0.00, short: "GEN", pos: ["PG"],
      tip: "コート全体を把握しチームを統率する真の司令塔。パス能力を圧倒的に重視。" },
    スラッシャー:          { ax: [0.16, 0.28, 0.08, 0.28, 0.12, 0.08], ht: 0.00, short: "SLA", pos: ["PG", "SG", "SF"],
      tip: "ドリブル突破で守備を切り裂きゴールへアタックする役割。敏捷性とドリブルを評価。" },
    // --- シューター/ウイング系 ---
    エース:                { ax: [0.34, 0.24, 0.08, 0.18, 0.08, 0.08], ht: 0.00, short: "ACE", pos: ["PG", "SG", "SF", "PF"],
      tip: "あらゆるエリアから自力で得点を奪う絶対的な点取り屋。得点技術全般を評価。" },
    スポットアップ:        { ax: [0.46, 0.04, 0.06, 0.12, 0.10, 0.22], ht: 0.00, short: "SPU", pos: ["SG", "SF", "PF"],
      tip: "外で待ち構えキャッチ＆シュートで3Pを射抜く役割。シュート精度を最重視。" },
    "3&D":                 { ax: [0.38, 0.04, 0.06, 0.12, 0.10, 0.30], ht: 0.00, short: "3&D", pos: ["SG", "SF", "PF", "C"],
      tip: "3Pシュートとハードな守備に特化した、現代バスケで最も重宝される仕事人。" },
    ポイントフォワード:    { ax: [0.14, 0.20, 0.30, 0.14, 0.12, 0.10], ht: 0.04, short: "PTF", pos: ["SF", "PF"],
      tip: "フォワードの体格を持ちながらPGのようにボールを運び組み立てる役割。" },
    // --- ビッグマン系 ---
    ストレッチ:            { ax: [0.40, 0.04, 0.06, 0.08, 0.16, 0.16], ht: 0.10, short: "STR", pos: ["PF", "C"],
      tip: "ビッグマンながら外角シュートで相手守備を外へ広げる（ストレッチ4/5）。" },
    インサイドフィニッシャー: { ax: [0.18, 0.04, 0.06, 0.14, 0.40, 0.00], ht: 0.18, short: "FIN", pos: ["PF", "C"],
      tip: "ゴール下で合わせ・ポストアップから確実に沈める大型フィニッシャー。高さとフィジカルを評価。" },
    リムランナー:          { ax: [0.10, 0.04, 0.04, 0.28, 0.26, 0.10], ht: 0.18, short: "RUN", pos: ["PF", "C"],
      tip: "速攻で誰よりも早くリムへ走り込むビッグマン。走力と高さを評価。" },
    スクリーナー:          { ax: [0.06, 0.02, 0.08, 0.06, 0.44, 0.16], ht: 0.18, short: "SCR", pos: ["PF", "C"],
      tip: "味方の壁となりディフェンスにズレを作る役割。体の強さを最重視。" },
    プレイメイキングビッグ: { ax: [0.10, 0.06, 0.36, 0.06, 0.20, 0.12], ht: 0.10, short: "PMB", pos: ["PF", "C"],
      tip: "ゴール下やトップからパスを捌くセンター（ヨキッチ型）。パスと強さを評価。" },
    リバウンダー:          { ax: [0.02, 0.02, 0.02, 0.08, 0.44, 0.18], ht: 0.24, short: "REB", pos: ["SF", "PF", "C"],
      tip: "スクリーンアウトを徹底しリバウンドをむしり取る職人。フィジカルと高さを評価。" },
    // --- 全ポジション共通（現代のポジション横断ロール） ---
    フロアスペーサー:      { ax: [0.42, 0.02, 0.04, 0.10, 0.10, 0.20], ht: 0.00, short: "SPC",
      tip: "コーナー等に広がり守備を引きつけてスペースを作る（全ポジション共通）。" },
    オフボールカッター:    { ax: [0.18, 0.06, 0.04, 0.34, 0.20, 0.10], ht: 0.08, short: "CUT",
      tip: "味方に合わせて隙を突きゴールへ走り込む「合わせ」の名手（全ポジション共通）。" },
    ロックダウン:          { ax: [0.04, 0.04, 0.04, 0.22, 0.20, 0.46], ht: 0.00, short: "LCK",
      tip: "相手エースをマンマークで封じ込めるストッパー（全ポジション共通）。" },
    スイッチディフェンダー: { ax: [0.04, 0.06, 0.04, 0.26, 0.24, 0.36], ht: 0.00, short: "SWD",
      tip: "スイッチで誰がマークになっても守り切る万能守備（全ポジション共通）。" },
    エナジーガイ:          { ax: [0.06, 0.06, 0.08, 0.24, 0.30, 0.26], ht: 0.06, short: "ENG",
      tip: "ハッスルプレイとルーズボールで試合の流れを変える仕事人（全ポジション共通）。" },
  };

  // EVAL_ROLES のうち実際には守備の仕事であるロール — それらは今はオフェンス
  // ではなく守備のピッカー（def.defRole）にあるため、オフェンスのピッカーと
  // オフェンスの自動割り当てからは除外する。
  static readonly DEF_ONLY = new Set(["ロックダウン", "スイッチディフェンダー", "エナジーガイ"]);

  // ディフェンスロールのカタログ（オフェンスロールと独立に選択）。effort ギアは
  // attributes.ts の DEF_ROLE_BEHAVIOR 側が持つ（守備出力＝スタミナ消費に連動）。
  static readonly DEF_ROLES: Record<string, { short: string; tip: string }> = {
    ハッスルディフェンダー: { short: "HUS", tip: "常に全力で体を張る堅実な守備。特別な奪取補正はないが、攻撃の主軸でも守備で手を抜かない（スタミナ消費は大きい）。" },
    バランス:              { short: "BAL", tip: "標準的な守備エフォート。" },
    省エネ:                { short: "ECO", tip: "攻撃に専念し守備は省エネ。脚を温存しスタミナ消費が小さい（その分、守備の強度は緩め）。" },
    ロックダウン:          { short: "LCK", tip: "相手エースをマンマークで封じるストッパー。常時全力で接近して守る。" },
    スイッチディフェンダー: { short: "SWD", tip: "スイッチで誰についても守り切る万能守備。常時全力。" },
    パスカット:            { short: "STL", tip: "パスコースを読んで奪う。パスカット／リーチイン／飛び出しが上手い。常時全力。" },
    リムプロテクター:      { short: "RIM", tip: "ゴール下を封鎖しカバーへ先回りする守護神。" },
    ヘルプディフェンダー:  { short: "HLP", tip: "抜かれた味方のカバーが上手い。" },
    守備司令塔:            { short: "CMD", tip: "味方全体の守備位置を指示し補正する。" },
  };

  // アイコンピルの色グループ。オフェンスが1つの系統（暖色）、守備が別の系統
  // （寒色）として読めるように、仕事の種類で分ける。フルのロール名がキー。
  //   オフェンス: 得点=赤、サポート/パス=黄、その他=橙
  //   守備: オンボール/スティール=青、インテリア/ヘルプ=緑、エフォート=シアン
  static readonly OFF_GROUP_C: Record<string, string> = {
    エース: "rgb(216,58,58)", スポットアップ: "rgb(216,58,58)", "3&D": "rgb(216,58,58)",
    ストレッチ: "rgb(216,58,58)", フロアスペーサー: "rgb(216,58,58)", インサイドフィニッシャー: "rgb(216,58,58)",
    リムランナー: "rgb(216,58,58)", スラッシャー: "rgb(216,58,58)", オフボールカッター: "rgb(216,58,58)",
    メインハンドラー: "rgb(228,180,0)", セカンドハンドラー: "rgb(228,180,0)", フロアジェネラル: "rgb(228,180,0)",
    ポイントフォワード: "rgb(228,180,0)", プレイメイキングビッグ: "rgb(228,180,0)", スクリーナー: "rgb(228,180,0)",
    リバウンダー: "rgb(224,123,30)", エナジーガイ: "rgb(224,123,30)",
  };
  static readonly DEF_GROUP_C: Record<string, string> = {
    ロックダウン: "rgb(53,104,208)", スイッチディフェンダー: "rgb(53,104,208)", パスカット: "rgb(53,104,208)",
    リムプロテクター: "rgb(47,157,85)", ヘルプディフェンダー: "rgb(47,157,85)", 守備司令塔: "rgb(47,157,85)",
    ハッスルディフェンダー: "rgb(31,166,189)", バランス: "rgb(31,166,189)", 省エネ: "rgb(31,166,189)",
  };

  static readonly DEF_ROLE_SPREAD = 0.15;   // ユニット全体にロールを散らす際の、重複ごとのペナルティ

  // 「ピーク」走査が考慮する素の能力値 — 専門家の上位2つの単一能力は彼の看板で
  // あり、平均化されたどの軸よりもはるかに際立つ（精神/スタミナ/連携系の能力値は
  // 意図的に除外）。
  static readonly PEAK_KEYS: (keyof Attributes)[] = [
    "offense", "defense", "balance", "speed", "accel", "reaction", "agility",
    "dribbleAcc", "dribbleSpd", "passAcc", "passSpd", "threeAcc", "threeRange",
    "midAcc", "shotStrength", "shotTech", "bank", "dunk", "jump", "handling", "aggression",
  ];

  // OVR = 50%「彼のポジションが必要とするもの」（ビッグは身長を含む） + 50% 彼の
  // 上位2つの素の能力、そしてリーグ中央値の周りに引き伸ばす — 単純平均では全員
  // が約 70-76 になってしまう; これがフィールドを広げる（実際の DB で計測: sd 2.2
  // → 4.4、帯域 ≈ 68..96）。
  // 身長→戦力値: 180cm = 70, 200cm = 100（線形、クランプ — このスケールで
  // サイズがどれだけの価値かのユーザーのキャリブレーション）。
  static heightValue(cm: number): number {
    return Math.max(0, Math.min(100, 70 + (cm - 180) * 1.5));
  }

  // 交代プレビューの増減用の、淡い緑（増加）/ 薄い赤（減少）の色。
  static readonly GAIN = "rgb(120,225,140)";
  static readonly LOSS = "rgb(240,140,130)";
  // 各ロールは独自のアクセントカラーを持ち、一目で見分けられるようにする。
  // 自然なペアを成すオフェンスと守備のロールは1つの色を共有する:
  //   フロアジェネラル(攻) = 守備司令塔(守)   … 司令塔 / コート上の指揮官
  //   エース(攻)           = ロックダウン(守)  … スター ↔ スターを止める者
  // 主張しすぎず暗い UI に馴染むよう、彩度を落として抑えてある
  // （オフェンス/守備のロール色は上で定義したグループパレット OFF_GROUP_C /
  //  DEF_GROUP_C — オフェンスは暖色、守備は寒色。試合中のアイコンとエディタの
  //  ロールピル / ピッカーで共有される。）
  static readonly USE_C = "rgb(198,202,212)";  // 順 プライマリ/使用率順 — 中立的なシルバー

  setPhase(phase: Phase): void {
    this.phase = phase;
    this.hud.style.display = phase === "playing" ? "block" : "none";
    this.titlePanel.style.display = phase === "title" ? "flex" : "none";
    this.pregamePanel.style.display = phase === "pregame" ? "flex" : "none";
    this.resultPanel.style.display = phase === "result" ? "flex" : "none";
    if (phase !== "title") this.closeChooser();
    if (phase === "playing") this.refreshBoardNames();
  }

  // ボックススコアの列。FG / 3P / FT は 成功 ● / 試投 ● を表示（「3/8」）。
  static readonly BOX_COLS: { label: string; w: number; get: (s: import("../objects/player/stats").Stats) => string }[] = [
    { label: "MIN", w: 40, get: (s) => (s.min / 60).toFixed(1) },
    { label: "PTS", w: 34, get: (s) => String(s.pts) },
    { label: "FG", w: 48, get: (s) => `${s.fgm}/${s.fga}` },
    { label: "3P", w: 44, get: (s) => `${s.tpm}/${s.tpa}` },
    { label: "FT", w: 44, get: (s) => `${s.ftm}/${s.fta}` },
    { label: "REB", w: 34, get: (s) => String(s.reb) },
    { label: "AST", w: 34, get: (s) => String(s.ast) },
    { label: "STL", w: 34, get: (s) => String(s.stl) },
    { label: "BLK", w: 34, get: (s) => String(s.blk) },
    { label: "TO", w: 30, get: (s) => String(s.tov) },
  ];
  static readonly NAME_W = 128;

  // ---- 小さなビルダー ----------------------------------------------------

  // ---- 下部の選手バー（チームごとの顔アイコン、コート上 ⇄ ベンチのタブ） ----

  // レスポンシブレイアウト。モバイル幅の画面では両チームの顔アイコンが中央下部で
  // 1行に集まる（収まるよう縮小 — refreshPlayerBars 参照）; 広い画面では中央を
  // 挟む。コントロールはどちらの場合も上部のハンバーガーにあるので、動かない。
  applyLayout(): void {
    const mode = window.innerWidth < 640 ? "phone" : "desktop";
    if (mode === this.layoutMode) return;
    this.layoutMode = mode;
    const [p0, p1] = this.iconPanels;
    const [r0, r1] = this.iconRows;
    if (mode === "phone") {
      // 1行: 2チームが中央下部で集まる。チームごとのサイズ調整（コート上の5人を
      // 縮小して収める / フルサイズのベンチをスクロール）は、アクティブなタブに
      // 依存するため refreshPlayerBars で毎フレーム行う。
      if (p0) Object.assign(p0.style, { right: "50%", left: "auto", bottom: "6px", transformOrigin: "bottom right", alignItems: "flex-end", maxWidth: "" });
      if (p1) Object.assign(p1.style, { left: "50%", right: "auto", bottom: "6px", transformOrigin: "bottom left", alignItems: "flex-start", maxWidth: "" });
      for (const r of [r0, r1]) if (r) Object.assign(r.style, { overflowY: "hidden", paddingBottom: "" } as Partial<CSSStyleDeclaration>);
    } else {
      if (p0) Object.assign(p0.style, { right: "calc(50% + 130px)", left: "auto", bottom: "16px", transform: "none", transformOrigin: "", maxWidth: "", alignItems: "flex-end" });
      if (p1) Object.assign(p1.style, { left: "calc(50% + 130px)", right: "auto", bottom: "16px", transform: "none", transformOrigin: "", maxWidth: "", alignItems: "flex-start" });
      for (const r of [r0, r1]) if (r) Object.assign(r.style, {
        maxWidth: "", overflowX: "visible", overflowY: "visible",
        pointerEvents: "", scrollbarWidth: "", paddingBottom: "",
      } as Partial<CSSStyleDeclaration>);
    }
  }

  update(game: Game): void {
    if (this.phase === "playing" && game.state === "final") this.showResult(game);

    this.applyLayout();
    // 実際にプレー中のときだけ: 試合前画面の間、Player は依然として前回の抽選の
    // 名前を持っている（applyRoster はティップオフで走る）ため、そのとき構築した
    // アイコンは古い名前を表示してしまう
    if (this.phase === "playing") {
      this.refreshPlayerBars(game);
      this.updateIconStamina(game);
      this.updateIconRoles(game);
      this.updateStatPops(game);
    }
    this.scoreA.textContent = String(game.score[0]);
    this.scoreB.textContent = String(game.score[1]);
    const t = Math.max(0, game.gameClock);
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    this.clock.textContent = `${m}:${s.toString().padStart(2, "0")}`;
    this.quarter.textContent = game.state === "final" ? "FINAL" : `Q${game.quarter}`;
    const scLeft = Math.max(0, game.shotClock);
    this.shot.textContent = String(Math.ceil(scLeft));
    // 残り3秒の派手なカウントダウン: ボックスは各ティックで膨らんでパンチし、
    // 光り、なくなるにつれ赤 → 熱い黄へ移る。クロックが実際に動いている間だけ
    // （デッドボールで止まっているときではない）。
    const frozen = game.mode === "tipoff" || game.mode === "freethrow"
      || game.mode === "pause" || game.mode === "subs" || game.mode === "finale";
    const box = this.shotBox;
    if (scLeft > 0 && scLeft <= 3 && !frozen) {
      const frac = scLeft - Math.floor(scLeft);                 // 各秒の中で 1→0
      const pop = 1 + 0.55 * frac;                              // 各ティックの直後にパンチ
      const heat = Math.min(1, Math.max(0, (3 - scLeft) / 2.5)); // 3秒で 0 .. 0付近で 1
      box.style.transform = `translateX(-50%) scale(${(1.15 + 0.4 * heat) * pop})`;
      box.style.fontSize = "20px";
      box.style.fontWeight = "900";
      box.style.background = `rgba(230,${Math.round(40 + 150 * heat)},20,0.95)`;
      box.style.color = heat > 0.5 ? "#fff2a8" : "#ffffff";
      box.style.boxShadow = `0 0 ${Math.round(8 + 20 * heat * frac)}px rgba(255,${Math.round(120 + 100 * heat)},40,${(0.55 + 0.45 * frac).toFixed(2)})`;
    } else {
      box.style.transform = "translateX(-50%) scale(1)";
      box.style.fontSize = "16px";
      box.style.fontWeight = "700";
      box.style.background = "rgba(180,40,20,0.9)";
      box.style.color = "";
      box.style.boxShadow = "";
    }

    if (game.lastEvent) {
      const ev = game.lastEvent;
      const c = TEAM_COLORS[ev.team];
      // イベントが変わったときだけバナーを再構築し、バナーが出ている間に毎フレーム
      // DOM をかき回さないようにする
      const key = `${ev.text}|${ev.scorer ?? ""}|${ev.assist ?? ""}`;
      if (key !== this.bannerKey) {
        this.bannerKey = key;
        this.banner.replaceChildren();
        const main = document.createElement("div");
        main.style.whiteSpace = "pre-line";   // 「\n」を尊重し、長いコールが折り返せるようにする
        main.textContent = ev.text;
        this.banner.appendChild(main);
        // シュート成功時、下に誰が得点したか（と誰がアシストしたか）を記す
        if (ev.scorer) {
          const sc = document.createElement("div");
          Object.assign(sc.style, { fontSize: "clamp(16px,3.4vw,26px)", fontWeight: "700", letterSpacing: "1px", marginTop: "8px" });
          sc.textContent = ev.scorer;
          this.banner.appendChild(sc);
        }
        if (ev.assist) {
          const as = document.createElement("div");
          Object.assign(as.style, { fontSize: "clamp(13px,2.5vw,19px)", fontWeight: "600", letterSpacing: "1px", marginTop: "3px", opacity: "0.85" });
          as.textContent = `ASSIST  ${ev.assist}`;
          this.banner.appendChild(as);
        }
      }
      this.banner.style.color = `rgb(${c.r * 255},${c.g * 255},${c.b * 255})`;
      this.banner.style.opacity = "0.95";
    } else {
      this.banner.style.opacity = "0";
      this.bannerKey = "";
    }

    // 交代フィード: 交代1つにつきチップ1枚、最大5枚。ホームのチップが先に表示
    // される; ホームのチップがどれか1枚でもまだ生きている間、アウェイのチップは
    // 隠される（game.ts で保持される）— こうしてフィードはホームの交代を全て
    // 再生し、クリアしてから、アウェイのものを最初から再生する。
    this.subFeed.replaceChildren();
    const showTeam = game.subEvents.some((e) => e.team === 0) ? 0 : 1;
    const shownSubs = game.subEvents.filter((e) => e.team === showTeam).slice(-5);
    for (let si = 0; si < shownSubs.length; si++) {
      const e = shownSubs[si];
      const color = colorOf(e.team);
      const op = Math.min(1, e.ttl / 0.8);   // 各チップは自身のタイマーでフェードする
      const chip = document.createElement("div");
      Object.assign(chip.style, {
        background: "rgba(12,15,22,0.86)", border: `1px solid ${color}`,
        borderRadius: "10px", padding: "clamp(5px,1vw,8px) clamp(12px,2.8vw,22px)",
        textAlign: "center", opacity: String(op),
        boxShadow: "0 6px 20px rgba(0,0,0,0.45)", maxWidth: "94vw",
      } as Partial<CSSStyleDeclaration>);
      const title = document.createElement("div");
      // レスポンシブ: 広い画面ではフルサイズ、ウィンドウが狭まると縮小
      Object.assign(title.style, { fontSize: "clamp(9px,1.7vw,13px)", opacity: "0.7", letterSpacing: "3px", fontWeight: "700" });
      title.textContent = "SUBSTITUTION";
      const line = document.createElement("div");
      Object.assign(line.style, {
        fontSize: "clamp(15px,3.4vw,26px)", fontWeight: "800", color, letterSpacing: "1px",
        textShadow: "0 3px 12px rgba(0,0,0,0.5)", whiteSpace: "nowrap",
        display: "flex", alignItems: "center", justifyContent: "center", gap: "6px",
      });
      // 各選手の名前は固定幅のスロットに収まるので、名前の長さが何であれチップは
      // 同じ幅になる（あふれた分は … でクリップ）。
      const nameSlot = (name: string): HTMLSpanElement => {
        const s = document.createElement("span");
        Object.assign(s.style, {
          flex: "0 0 auto", width: "clamp(84px,20vw,150px)", textAlign: "left",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        } as Partial<CSSStyleDeclaration>);
        s.textContent = name;
        return s;
      };
      const tag = (t: string, op = "0.85"): HTMLSpanElement => {
        const s = document.createElement("span");
        Object.assign(s.style, { flex: "0 0 auto", opacity: op, fontWeight: "800" } as Partial<CSSStyleDeclaration>);
        s.textContent = t;
        return s;
      };
      line.append(
        tag(`#${e.inNum}`, "0.95"), nameSlot(e.inName), tag("IN"),
        tag("/", "0.45"),
        tag(`#${e.outNum}`, "0.95"), nameSlot(e.outName), tag("OUT"),
      );
      chip.append(title, line);
      this.subFeed.appendChild(chip);
    }
  }
}
