import { Game } from "./game";
import { TEAM_NAMES, TEAM_COLORS, HUD_OPTS, TEAM_CLUB, teamAbbr, teamShort } from "./config";
import { CLUB_ABBR } from "./clubabbr";
import { CLUB_FLAGS } from "./clubflags";
import { ROSTER, ROSTER_SIZE, STARTERS, randomizeRosters, randomizeTeam, clubTeam, applyDbPlayer, makeDefFromDb, ATTR_META, ABILITY_META, scoringPower, type Attributes, type PlayerDef } from "./attributes";
import { CLUBS } from "./clubdb";
import { PLAYER_DB, type DbPlayer } from "./playerdb";
import { playerLook } from "./util";

const colorOf = (team: number): string => {
  const c = TEAM_COLORS[team];
  return `rgb(${c.r * 255},${c.g * 255},${c.b * 255})`;
};

type Phase = "title" | "pregame" | "playing" | "result";

// 選手がスタッツを記録した瞬間に、彼のアイコン上へ浮遊する「＋」バッジをポップ
// させる対象スタッツ（得点 / アシスト / リバウンド / スティール / ブロック / ターンオーバー）。
const POP_STATS: { key: keyof import("./player").Stats; label: string; color: string }[] = [
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
  private root: HTMLDivElement;
  private hud: HTMLDivElement;
  private titlePanel!: HTMLDivElement;
  private chooser: HTMLDivElement | null = null;   // リーグ/チーム選択ウィザードのオーバーレイ
  private pregamePanel!: HTMLDivElement;
  private editorHost!: HTMLDivElement;
  private resultPanel!: HTMLDivElement;
  private resultScore!: HTMLDivElement;
  private resultWinner!: HTMLDivElement;
  private resultStats!: HTMLDivElement;
  // リザルト画面のタブ: チーム比較 ⇄ 各チームのボックススコア
  private resultGame: Game | null = null;
  private resultTab: "team" | "blue" | "red" = "team";
  private resultContent: HTMLDivElement | null = null;
  private resultTabBtns: { key: "team" | "blue" | "red"; el: HTMLButtonElement }[] = [];
  private tooltip!: HTMLDivElement;
  private tipHideT = 0;   // 猶予期間つきの非表示待ち（scheduleHideTip 参照）
  private tipTitle!: HTMLDivElement;
  private tipBody!: HTMLDivElement;

  private scoreA: HTMLSpanElement;
  private scoreB: HTMLSpanElement;
  private nameA!: HTMLElement;       // スコアボードのチームラベル（左）— クラブ選択後は略称
  private nameB!: HTMLElement;       // スコアボードのチームラベル（右）
  private clock: HTMLSpanElement;
  private quarter: HTMLSpanElement;
  private shot: HTMLSpanElement;
  private shotBox!: HTMLDivElement;   // ショットクロックのコンテナ — 残り3秒で点滅する
  private banner: HTMLDivElement;
  private bannerKey = "";           // 現在のバナー内容（毎フレームの再構築を避けるため）
  private subFeed!: HTMLDivElement;
  private speedBtns: HTMLButtonElement[] = [];
  // 下部の選手バー: 各チームの顔アイコン。コート上 ⇄ ベンチを切り替える
  private iconRows: HTMLDivElement[] = [];
  private iconTabs: HTMLButtonElement[][] = [[], []];
  private showBench: boolean[] = [false, false];
  private iconKey: string[] = ["", ""];
  private iconEl = new Map<import("./player").Player, HTMLDivElement>(); // 選手 → 現在のアイコン要素
  private iconStamina = new Map<import("./player").Player, { bar: HTMLDivElement; fill: HTMLDivElement }>(); // 選手 → アイコンの体力バー
  private iconRole = new Map<import("./player").Player, HTMLDivElement>();   // 選手 → オフェンス/守備ロールのピル
  private staminaBtn: HTMLButtonElement | null = null;   // HUD トグル: ゲージを名前タグ上 ⇄ 顔アイコン
  private namesBtn: HTMLButtonElement | null = null;     // HUD トグル: コート上の名前タグ 表示 ⇄ 非表示
  private modelBtn: HTMLButtonElement | null = null;     // HUD トグル: 人型 ⇄ どんぐり体形
  private statSnap = new Map<import("./player").Player, number[]>();     // 最後に確認した POP_STATS の値
  private controls!: HTMLDivElement;      // 速度 / RESTART の行
  private menuBtn!: HTMLButtonElement;    // ☰ ハンバーガー — スコアボードが届くまでは上端に乗る
  private camHint!: HTMLDivElement;       // 「drag: orbit」ヒント — 左側で ☰ と同じ高さに保つ
  private board!: HTMLDivElement;         // 中央寄せのスコアボード（その幅が ☰ の位置を決める）
  private iconPanels: HTMLDivElement[] = []; // 2チームの顔アイコンパネル
  private layoutMode = "";                // "desktop" | "phone" — リサイズ時に再計算

  private phase: Phase = "pregame";
  private playerCard!: HTMLDivElement;  // 試合前の浮遊詳細カード（ヘックスチャート）
  private vsBoard: HTMLDivElement | null = null;  // VS 戦力ボード（重ならないようにする）
  private vsPreviewActive = false;                // 交代/ロールのプレビューがボード上に表示中
  private dragFrom: { team: number; idx: number } | null = null; // 運搬中のバー
  private dragGhost: HTMLDivElement | null = null;               // 運ばれている名前バー
  private dragHl: HTMLElement | null = null;                     // ハイライトされたドロップ先の行
  // 「carry」モード: DB から取り込む選手がカーソルに追従し、彼のチームのロスター
  // 行にドロップして選手を入れ替えるまで続く（ピッカーから開始）。
  private carry: { team: number; dbp: DbPlayer } | null = null;
  private carryGhost: HTMLDivElement | null = null;
  private carryHint: HTMLDivElement | null = null;
  private carryHl: HTMLElement | null = null;
  private carryCleanup: (() => void) | null = null;
  private rolePicker: HTMLDivElement | null = null;              // 開いている評価ロールメニュー
  private rolePickerCloser: ((e: PointerEvent) => void) | null = null;
  private detailModal: HTMLDivElement | null = null;             // 全能力値モーダル
  private playerPicker: HTMLDivElement | null = null;            // 4000+選手データベースからの選手交代モーダル
  private clubPicker: HTMLDivElement | null = null;              // 実クラブでロスターを組むモーダル
  // ビルトインのチーム名。クラブ名への変更前に捕捉しておき、ランダム編成で復元できるようにする
  private static readonly DEFAULT_NAMES = [TEAM_NAMES[0], TEAM_NAMES[1]];
  // データベース全体を OVR 順にソートしたキャッシュビュー（初回オープン時に一度構築）:
  // { p, ovr, lower(name) } なので、キーストロークによる絞り込みは単純な配列走査で済む。
  private dbIndex: { p: DbPlayer; ovr: number; lower: string }[] | null = null;
  private rosterTab = 0;         // モバイル: どちらのチームのロスターカードを表示するか
  private pregameMode = "";      // "phone" | "desktop" — 640px を跨いだら再描画

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
  private buildTooltip(): void {
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
  private showTextTip(title: string, body: string, anchor: HTMLElement): void {
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

  private hideTip(): void {
    if (this.tipHideT) { window.clearTimeout(this.tipHideT); this.tipHideT = 0; }
    this.tooltip.style.display = "none";
    this.tooltip.style.pointerEvents = "none";
  }

  /** 短い猶予期間の後にツールチップを非表示にする — マウスがツールチップ自体
   *  に到達した場合はキャンセルされる（ボタンを持つことがあるため）。 */
  private scheduleHideTip(): void {
    if (this.tipHideT) window.clearTimeout(this.tipHideT);
    this.tipHideT = window.setTimeout(() => { this.tipHideT = 0; this.hideTip(); }, 200);
  }

  // 選手アイコンをホバー → 彼のライブなボックススコアを、アイコンの上に浮かせて
  // 表示する（アイコンは画面下部付近にある）。
  private showStatTip(player: import("./player").Player, anchor: HTMLElement): void {
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

  private panel(): HTMLDivElement {
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

  // ---- タイトル画面 -------------------------------------------------------
  // 一番最初の画面: クラブチーム対戦（リーグ → チームのウィザード）か、
  // ランダム対戦（既存のランダムロスターエディタへ直行）を選ぶ。
  private buildTitle(): void {
    const p = this.panel();
    p.style.gap = "16px";
    p.style.padding = "clamp(22px,4vw,44px)";

    const title = document.createElement("div");
    title.textContent = "バスケットボールシミュレーション";
    Object.assign(title.style, {
      fontSize: "clamp(17px,3.9vw,28px)", fontWeight: "800", letterSpacing: "1px",
    } as Partial<CSSStyleDeclaration>);
    const sub = document.createElement("div");
    sub.textContent = "対戦モードを選択";
    Object.assign(sub.style, { fontSize: "13px", opacity: "0.6", marginBottom: "2px" } as Partial<CSSStyleDeclaration>);

    const bigBtn = (label: string, desc: string, onClick: () => void): HTMLButtonElement => {
      const b = document.createElement("button");
      Object.assign(b.style, {
        display: "flex", flexDirection: "column", alignItems: "center", gap: "3px",
        width: "min(320px,86vw)", padding: "14px 18px", cursor: "pointer",
        background: "rgba(20,24,34,0.9)", color: "#fff", borderRadius: "12px",
        border: "1px solid rgba(255,255,255,0.18)",
      } as Partial<CSSStyleDeclaration>);
      const t = document.createElement("span");
      t.textContent = label;
      Object.assign(t.style, { fontSize: "clamp(15px,3.4vw,19px)", fontWeight: "800" } as Partial<CSSStyleDeclaration>);
      const d = document.createElement("span");
      d.textContent = desc;
      Object.assign(d.style, { fontSize: "11px", opacity: "0.65" } as Partial<CSSStyleDeclaration>);
      b.append(t, d);
      b.onmouseenter = () => { b.style.background = "rgba(70,120,220,0.9)"; };
      b.onmouseleave = () => { b.style.background = "rgba(20,24,34,0.9)"; };
      b.onclick = onClick;
      return b;
    };

    const clubBtn = bigBtn("クラブチーム対戦", "リーグとチームを選んで対戦", () => this.startClubMatchup());
    const randBtn = bigBtn("ランダム対戦", "ランダム編成で対戦（編成は自由に変更可）", () => {
      this.newMatchup();
      this.onSetupLineups();        // 相手を考慮した DEFAULT の5人（エディタ表示前）
      this.setPhase("pregame");
    });

    p.append(title, sub, clubBtn, randBtn);
    this.root.appendChild(p);
    this.titlePanel = p;
  }

  private closeChooser(): void {
    if (this.chooser) { this.chooser.remove(); this.chooser = null; }
  }

  // 重複を除いたリーグ一覧。初出順（clubdb のグルーピングに一致）。
  private leaguesInOrder(): string[] {
    const out: string[] = [];
    for (const [, lg] of CLUBS) if (!out.includes(lg)) out.push(lg);
    return out;
  }

  // 実クラブを1チームに適用する（ロスター + 名前 + ユニフォーム + 自動ライン
  // ナップ/ロール）。エディタの再構築はしない — いつ更新/離脱するかは呼び出し側が決める。
  private assignClub(team: number, idx: number): void {
    clubTeam(team, idx);
    TEAM_NAMES[team] = CLUBS[idx][0];
    TEAM_CLUB[team] = CLUBS[idx][0];   // このチームはクラブ独自のユニフォームを着る
    this.onUniformToggle();
    this.optimizeLineup(team);
    this.autoAssignRoles(team);
    this.autoAssignChoiceRanks(team);
  }

  // ボタンとして表示されるリーグのグループ。上位リーグ（他リーグA まで）は
  // それぞれ独自のグループのまま。それ以下は 南米 と その他B にまとめられる。
  private leagueGroups(): { label: string; leagues: string[] }[] {
    const order = this.leaguesInOrder();
    const cut = order.indexOf("他リーグA");   // そのまま残す最後のリーグ
    // DB 内の南米リーグ（メキシコは CONCACAF → その他B）。
    const SOUTH = new Set([
      "アルゼンチン", "ブラジル", "ウルグアイ", "チリ", "パラグアイ",
      "ペルー", "ボリビア", "コロンビア", "エクアドル", "ベネズエラ",
    ]);
    const groups: { label: string; leagues: string[] }[] = [];
    const south: string[] = [], otherB: string[] = [];
    order.forEach((lg, i) => {
      if (cut < 0 || i <= cut) groups.push({ label: lg, leagues: [lg] });
      else if (SOUTH.has(lg)) south.push(lg);
      else otherB.push(lg);
    });
    if (south.length) groups.push({ label: "南米", leagues: south });
    if (otherB.length) groups.push({ label: "その他B", leagues: otherB });
    return groups;
  }

  // ウィザードの入口: ホーム（team 0）、続いてアウェイ（team 1）のクラブを選ぶ。
  // コートと選手は、マッチアップが確定するまでウィザードの間ずっと不透明な
  // オーバーレイの後ろに隠れたままになる。最初から戦力バーとリーグ/クラブ選択を
  // 表示する — リーグボタンとクラブのフラッグ一覧は同じ領域を占め、その場で
  // 入れ替わる（リーグを選ぶ → そのクラブ群; リーグ選択 → 戻る）。
  private startClubMatchup(): void {
    this.titlePanel.style.display = "none";
    this.openMatchupWizard();
  }

  private openMatchupWizard(): void {
    this.closeChooser();

    const OPAQUE = "#080a0f";
    // オーバーレイ自体は透明。不透明なタイルが、3Dのホーム/アウェイの選手が
    // 描画される2つの透明な「ウィンドウ」を除いて画面全体を覆う（main.ts が
    // onUniformPreview 経由で描画）。タイルは隣接して（重なりも隙間もなく）配置
    // されるため、コートの他の部分が見えることはない。
    const overlay = document.createElement("div");
    Object.assign(overlay.style, {
      position: "absolute", inset: "0", display: "flex", flexDirection: "column",
      pointerEvents: "auto",
    } as Partial<CSSStyleDeclaration>);

    // 1) 上部カバー（不透明）— 戦力バー
    const topCover = document.createElement("div");
    Object.assign(topCover.style, {
      width: "100%", background: OPAQUE, display: "flex", justifyContent: "center", padding: "14px 0 8px",
    } as Partial<CSSStyleDeclaration>);
    const barHost = document.createElement("div");
    Object.assign(barHost.style, { width: "min(560px,94vw)" } as Partial<CSSStyleDeclaration>);
    const renderBar = () => barHost.replaceChildren(this.buildVsBoard());
    topCover.appendChild(barHost);

    // 2) ユニフォーム帯 — 2つの透明なウィンドウ（3Dが透けて見える）、残りは不透明。
    //    ホームのウィンドウは左、アウェイは右。戦力バーと同様に対比させる。
    const WIN_W = 120, WIN_H = 150;
    const cover = (flex: string): HTMLDivElement => {
      const d = document.createElement("div");
      Object.assign(d.style, { background: OPAQUE, flex } as Partial<CSSStyleDeclaration>);
      return d;
    };
    const windowCell = (t: number): { cell: HTMLDivElement; win: HTMLDivElement; lab: HTMLDivElement } => {
      const cell = document.createElement("div");
      Object.assign(cell.style, { width: `${WIN_W}px`, display: "flex", flexDirection: "column" } as Partial<CSSStyleDeclaration>);
      const win = document.createElement("div");   // 透明 — 3Dの選手がここに表示される
      Object.assign(win.style, {
        position: "relative", width: "100%", height: `${WIN_H}px`, background: "transparent",
      } as Partial<CSSStyleDeclaration>);
      // 3Dビューポートは矩形。角を丸くするために、(a) 4隅の三角形を不透明な
      // くさび（radial-gradient マスク）で覆い、(b) その上に丸い色付きの枠線を
      // 描く。どちらのオーバーレイもウィンドウの上に重なる。
      const R = 8;
      const g = (at: string, pos: string) =>
        `radial-gradient(circle ${R}px at ${at}, transparent ${R}px, ${OPAQUE} ${R}px) ${pos} / ${R}px ${R}px no-repeat`;
      const mask = document.createElement("div");
      Object.assign(mask.style, {
        position: "absolute", inset: "0", pointerEvents: "none",
        background: [
          g("bottom right", "0 0"), g("bottom left", "100% 0"),
          g("top right", "0 100%"), g("top left", "100% 100%"),
        ].join(","),
      } as Partial<CSSStyleDeclaration>);
      const frame = document.createElement("div");
      Object.assign(frame.style, {
        position: "absolute", inset: "0", pointerEvents: "none", boxSizing: "border-box",
        border: `2px solid ${colorOf(t)}`, borderRadius: `${R}px`,
      } as Partial<CSSStyleDeclaration>);
      win.append(mask, frame);
      const lab = document.createElement("div");   // その下の不透明なラベル帯
      Object.assign(lab.style, {
        background: OPAQUE, textAlign: "center", padding: "3px 0", fontSize: "11px", fontWeight: "800",
        color: colorOf(t), whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
      } as Partial<CSSStyleDeclaration>);
      cell.append(win, lab);
      return { cell, win, lab };
    };
    const homeCell = windowCell(0);
    const awayCell = windowCell(1);
    const midCover = cover("1 1 auto");
    Object.assign(midCover.style, { display: "flex", alignItems: "center", justifyContent: "center" } as Partial<CSSStyleDeclaration>);
    const midLbl = document.createElement("div");
    midLbl.textContent = "ユニフォーム";
    Object.assign(midLbl.style, { fontSize: "10px", fontWeight: "800", opacity: "0.45", letterSpacing: "2px" } as Partial<CSSStyleDeclaration>);
    midCover.appendChild(midLbl);
    // ウィンドウは、戦力バーとちょうど同じ幅（min(560px,94vw)）の中央寄せ
    // コンテナの両端に位置するため、ホームウィンドウの左端とアウェイウィンドウの
    // 右端がバーの端に揃う。注意: 透明な連鎖の中の要素は背景を持ってはならない —
    // カバーは不透明な兄弟タイル（両側のカバー / midCover / ラベル帯）だけが担う。
    const inner = document.createElement("div");
    Object.assign(inner.style, { width: "min(560px,94vw)", display: "flex", alignItems: "stretch" } as Partial<CSSStyleDeclaration>);
    inner.append(homeCell.cell, midCover, awayCell.cell);
    const band = document.createElement("div");
    Object.assign(band.style, { width: "100%", height: `${WIN_H + 24}px`, display: "flex", alignItems: "stretch", justifyContent: "center" } as Partial<CSSStyleDeclaration>);
    band.append(cover("1 1 auto"), inner, cover("1 1 auto"));

    // 3) フィラー（不透明）がシートまでの残りのスペースを埋める
    const filler = cover("1 1 auto");

    const refreshTop = () => {
      renderBar();
      homeCell.lab.textContent = `ホーム　${teamAbbr(0)}`;
      awayCell.lab.textContent = `アウェイ　${teamAbbr(1)}`;
    };

    // ボトムシート: 表示されるパネルは 1200px で頭打ちにして中央寄せ。その内容も
    // 中央寄せ（alignItems:center + 各行を中央寄せ）。暗いプレビュー背景により、
    // 頭打ちにしたパネルの脇の領域は単に暗いままになる。
    const sheet = document.createElement("div");
    Object.assign(sheet.style, {
      width: "100%", maxWidth: "1200px", alignSelf: "center", boxSizing: "border-box",
      background: OPAQUE, borderTop: "1px solid rgba(255,255,255,0.14)",
      borderRadius: "16px 16px 0 0", padding: "10px 12px",
      display: "flex", flexDirection: "column", alignItems: "center", gap: "8px",
      boxShadow: "0 -8px 30px rgba(0,0,0,0.5)",
    } as Partial<CSSStyleDeclaration>);
    const CAP = { width: "100%", maxWidth: "1200px", boxSizing: "border-box" } as Partial<CSSStyleDeclaration>;
    const header = document.createElement("div");
    Object.assign(header.style, { ...CAP, fontSize: "14px", fontWeight: "800", textAlign: "center" } as Partial<CSSStyleDeclaration>);
    const content = document.createElement("div");
    Object.assign(content.style, CAP);
    const footer = document.createElement("div");
    Object.assign(footer.style, { ...CAP, display: "flex", gap: "10px", justifyContent: "center" } as Partial<CSSStyleDeclaration>);
    sheet.append(header, content, footer);
    overlay.append(topCover, band, filler, sheet);
    this.root.appendChild(overlay);
    this.chooser = overlay;
    refreshTop();

    // ウィンドウが実際の画面上の矩形を持ったら、3D二画面プレビューを開始する
    const sendPreview = () => {
      if (this.chooser !== overlay) return;
      this.onUniformPreview({
        left: homeCell.win.getBoundingClientRect(),
        right: awayCell.win.getBoundingClientRect(),
        leftTeam: 0, rightTeam: 1,
      });
    };
    requestAnimationFrame(sendPreview);
    window.addEventListener("resize", sendPreview);

    let team = 0;
    const picked = [false, false];
    const exitPreview = () => window.removeEventListener("resize", sendPreview);
    const exitToTitle = () => { this.onUniformPreview(null); exitPreview(); this.closeChooser(); this.titlePanel.style.display = "flex"; };

    // リーグの「フラッグ」: 国旗風のデザイン（クラブフラッグと同じ形式/サイズ）。
    // 他リーグA / 南米 / その他B はグループであって国ではない → 中立 / 大陸風。
    const LEAGUE_FLAGS: Record<string, string[]> = {
      "イングランド": ["c", "f2f2f2", "e01414"],            // セントジョージ十字
      "イタリア": ["v", "1f8a3b", "f2f2f2", "e01414"],       // 緑-白-赤
      "スペイン": ["h", "e01414", "f2c11a", "e01414"],       // 赤-黄-赤
      "オランダ": ["h", "e01414", "f2f2f2", "1a4fd0"],       // 赤-白-青
      "フランス": ["v", "1a4fd0", "f2f2f2", "e01414"],       // 青-白-赤
      "他リーグA": ["h", "2a3550", "46557a"],                // 中立（混成リーグ）
      "南米": ["v", "1f8a3b", "f2c11a", "1a9ee0"],           // 大陸風（緑/黄/空色）
      "その他B": ["h", "5a4a34", "7a6a52"],                  // 中立（混成リーグ）
    };

    // リーグ一覧とクラブ一覧が形式・フラッグサイズ・縦の高さで同一になるための
    // 共有ビルダー（maxRows 行まで、それを超えるとスクロール）。
    const IDLE_BORDER = "rgba(255,255,255,0.16)";
    const COL = 100, GAP = 8, ROW_H = 54;
    const makeScroll = (): { scrollArea: HTMLDivElement; grid: HTMLDivElement } => {
      const maxRows = window.innerWidth <= 480 ? 3 : 4;
      const scrollArea = document.createElement("div");
      Object.assign(scrollArea.style, { maxHeight: `${maxRows * ROW_H}px`, overflowY: "auto", width: "100%" } as Partial<CSSStyleDeclaration>);
      // グリッドは固定幅フラッグの flex-wrap 行で左揃え。グリッドのブロック自体は
      // ちょうど N 列の幅で中央寄せ（margin:auto、centerGrid 参照）。よって、
      // 埋まった行はブロックを端から端まで満たし（中央寄せに見える）、最後の
      // 半端な行は最初のフラッグの下で左揃えになる。
      const grid = document.createElement("div");
      Object.assign(grid.style, {
        display: "flex", flexWrap: "wrap", justifyContent: "flex-start", alignContent: "flex-start",
        gap: `${GAP}px`, margin: "0 auto", boxSizing: "border-box",
      } as Partial<CSSStyleDeclaration>);
      scrollArea.append(grid);
      return { scrollArea, grid };
    };
    // グリッドブロックを、収まる整数個の列幅にサイズ調整し、最後の行は左揃えの
    // まま中央寄せする。DOM に入った後で呼ぶこと。
    const centerGrid = (scrollArea: HTMLDivElement, grid: HTMLDivElement): void => {
      const avail = scrollArea.clientWidth || COL;
      const cols = Math.max(1, Math.floor((avail + GAP) / (COL + GAP)));
      grid.style.width = `${cols * (COL + GAP) - GAP}px`;
    };
    const makeFlag = (design: string[] | undefined, overlay: string, label: string): HTMLButtonElement => {
      const btn = document.createElement("button");
      Object.assign(btn.style, {
        // 枠線は INSET の box-shadow で（border ではない）: border-radius +
        // overflow:hidden の実際の border は、丸めた角で子要素の背景が約1px
        // にじむ。inset の shadow なら半径にきれいに沿う。
        display: "flex", flexDirection: "column", cursor: "pointer", padding: "0",
        width: "100px", flex: "0 0 100px",   // 固定サイズの flex アイテム（行によって中央寄せ）
        borderRadius: "8px", overflow: "hidden", color: "#fff", boxSizing: "border-box",
        background: "rgba(255,255,255,0.05)", border: "0", boxShadow: `inset 0 0 0 2px ${IDLE_BORDER}`,
      } as Partial<CSSStyleDeclaration>);
      const flag = document.createElement("div");
      Object.assign(flag.style, {
        position: "relative", width: "100%", height: "26px", flexShrink: "0",
        borderBottom: "1px solid rgba(0,0,0,0.35)", background: UI.flagCss(design),
      } as Partial<CSSStyleDeclaration>);
      if (overlay) {
        const o = document.createElement("span");
        Object.assign(o.style, {
          position: "absolute", inset: "0", display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: "12px", fontWeight: "800", color: "#fff", textShadow: "0 1px 3px rgba(0,0,0,0.95)",
        } as Partial<CSSStyleDeclaration>);
        o.textContent = overlay;
        flag.appendChild(o);
      }
      const nm = document.createElement("span");
      Object.assign(nm.style, {
        width: "100%", boxSizing: "border-box", padding: "3px 4px",
        fontSize: "10px", fontWeight: "700", textAlign: "center",
        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
      } as Partial<CSSStyleDeclaration>);
      nm.textContent = label;
      btn.append(flag, nm);
      return btn;
    };
    const resetContent = () => Object.assign(content.style, {
      display: "block", gridTemplateColumns: "", maxHeight: "none", overflowY: "visible", padding: "0",
    } as Partial<CSSStyleDeclaration>);

    const showLeagues = (): void => {
      header.textContent = team === 0
        ? "ホーム（1チーム目）— リーグを選択"
        : `アウェイ（2チーム目）— リーグを選択　［ホーム: ${TEAM_NAMES[0]}］`;
      content.replaceChildren();
      resetContent();
      const { scrollArea, grid } = makeScroll();
      for (const g of this.leagueGroups()) {
        const btn = makeFlag(LEAGUE_FLAGS[g.label], "", g.label);
        btn.onclick = () => showClubs(g);
        grid.appendChild(btn);
      }
      content.appendChild(scrollArea);
      centerGrid(scrollArea, grid);
      footer.replaceChildren();
      const back = this.button(team === 0 ? "タイトルへ戻る" : "ホームを選び直す");
      Object.assign(back.style, { fontSize: "12px", padding: "7px 20px" } as Partial<CSSStyleDeclaration>);
      back.onclick = team === 0 ? exitToTitle : () => { team = 0; showLeagues(); };
      footer.append(back);
    };

    const showClubs = (group: { label: string; leagues: string[] }): void => {
      header.textContent = team === 0
        ? `${group.label} — ホームをフラッグで選択`
        : `${group.label} — アウェイをフラッグで選択　［ホーム: ${TEAM_NAMES[0]}］`;
      content.replaceChildren();
      resetContent();
      const { scrollArea, grid } = makeScroll();
      let selectedBtn: HTMLButtonElement | null = null;
      CLUBS.forEach((c, idx) => {
        if (!group.leagues.includes(c[1])) return;
        const btn = makeFlag(CLUB_FLAGS[c[0]], CLUB_ABBR[c[0]] ?? "", c[0]);
        btn.onclick = () => {
          if (selectedBtn) selectedBtn.style.boxShadow = `inset 0 0 0 2px ${IDLE_BORDER}`;
          selectedBtn = btn;
          btn.style.boxShadow = `inset 0 0 0 2px ${colorOf(team)}`;
          picked[team] = true;
          this.assignClub(team, idx);   // ロスター + 名前 + ユニフォーム
          refreshTop();                 // 戦力バー + ユニフォームプレビューがそれに切り替わる
          confirm.style.opacity = "1";
          confirm.style.pointerEvents = "auto";
        };
        grid.appendChild(btn);
      });
      content.appendChild(scrollArea);
      centerGrid(scrollArea, grid);

      footer.replaceChildren();
      const back = this.button("リーグ選択");
      Object.assign(back.style, { fontSize: "12px", padding: "7px 20px" } as Partial<CSSStyleDeclaration>);
      back.onclick = () => showLeagues();
      const confirm = this.button("決定");
      Object.assign(confirm.style, {
        fontSize: "13px", fontWeight: "800", padding: "7px 22px",
        background: colorOf(team), color: "#0d1016", border: `1px solid ${colorOf(team)}`,
        opacity: picked[team] ? "1" : "0.4", pointerEvents: picked[team] ? "auto" : "none",
      } as Partial<CSSStyleDeclaration>);
      confirm.onclick = () => {
        if (!picked[team]) return;
        if (team === 0) {
          team = 1;
          showLeagues();
        } else {
          this.onUniformPreview(null);  // 3D二画面プレビューを解体
          exitPreview();
          this.closeChooser();          // オーバーレイを除去 → コート/選手が再び表示される
          this.onSetupLineups();        // 相手を考慮した DEFAULT の5人（エディタ表示前）
          this.refreshEditors();
          this.setPhase("pregame");
        }
      };
      footer.append(back, confirm);
    };

    showLeagues();
  }

  // CLUB_FLAGS のデザイン（[pattern, ...hexColours]）から、クラブ「フラッグ」用の
  // CSS 背景を組み立てる。クラブに定義がなければ中立的なグレーにフォールバックする。
  private static flagCss(def: string[] | undefined): string {
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


  private buildPregame(): void {
    const p = this.panel();

    // 試合前モーダルは内容に密着させる: padding も要素間の gap もなし。ロスターの
    // 上下や脇に空の帯が出ないようにする
    p.style.padding = "0";
    p.style.gap = "0";                  // overflow は auto のまま（背の高いロスターはスクロール）
    // タイトル行なし — モーダルはボタンとロスターに直接開く
    this.editorHost = document.createElement("div");
    Object.assign(this.editorHost.style, {
      width: "100%", display: "flex", flexDirection: "column", alignItems: "stretch", gap: "0",
    } as Partial<CSSStyleDeclaration>);
    p.appendChild(this.editorHost);

    // 浮遊する選手詳細カード（ヘックスチャート + 特殊能力）。行のホバー時に表示
    this.playerCard = document.createElement("div");
    Object.assign(this.playerCard.style, {
      position: "fixed", display: "none", zIndex: "60", pointerEvents: "none",
      width: "260px", boxSizing: "border-box", padding: "10px 12px",
      background: "rgba(12,15,22,0.97)", border: "1px solid rgba(255,255,255,0.25)",
      borderRadius: "12px", boxShadow: "0 12px 36px rgba(0,0,0,0.6)", textAlign: "left",
    } as Partial<CSSStyleDeclaration>);
    document.body.appendChild(this.playerCard);

    // TIP OFF はもう上段の行ではない — 2チームの間に置かれ、refreshEditors の中で
    // 構築されて、カードの間（横並び）またはチームタブの間（狭いトグル表示）に配置される。

    this.root.appendChild(p);
    this.pregamePanel = p;
    // 横並び / タブトグルのブレークポイントを跨ぐとロスターを再レイアウトする
    window.addEventListener("resize", () => {
      if (this.phase !== "pregame") return;
      const mode = this.rostersFitSideBySide() ? "desktop" : "phone";
      if (mode !== this.pregameMode) this.refreshEditors();
    });
    this.newMatchup();   // 最初のマッチアップを即座に描く
  }

  /** データベースから新たなランダムマッチアップを引き、エディタを再構築する。 */
  private newMatchup(): void {
    TEAM_NAMES[0] = UI.DEFAULT_NAMES[0];   // ランダム抽選は再び BLAZE/WAVE
    TEAM_NAMES[1] = UI.DEFAULT_NAMES[1];
    TEAM_CLUB[0] = TEAM_CLUB[1] = "";       // ...そして汎用のチームユニフォームに戻す
    this.onUniformToggle();
    randomizeRosters();
    this.optimizeLineup(0); this.optimizeLineup(1);   // 各ポジションの最強選手が先発
    this.autoAssignRoles();        // 新規抽選に対する妥当なデフォルトの攻守ロール
    this.autoAssignChoiceRanks();  // 得点力によるプライマリ 1..5（先発 + ベンチ）
    this.refreshEditors();
  }

  /** 1チームのロスターだけを引き直し（もう一方のチームはそのまま）、再構築する。 */
  private randomizeOne(team: number): void {
    TEAM_NAMES[team] = UI.DEFAULT_NAMES[team];   // クラブ名から戻す
    TEAM_CLUB[team] = "";                        // ...そして汎用のチームユニフォームに戻す
    this.onUniformToggle();
    randomizeTeam(team);
    this.optimizeLineup(team);         // 各ポジションの最強選手をラインナップに入れる
    this.autoAssignRoles(team);        // このチームの新規抽選に対するデフォルトの攻守ロール
    this.autoAssignChoiceRanks(team);  // このチームだけのプライマリ 1..5
    this.refreshEditors();
  }

  // 抽選したスカッドから先発5人を最適化する: 各ポジション（PG..C）で最も適した
  // 選手が先発し、残りはベンチに落ちる。強い選手が自分のスポットで弱い選手の
  // 後ろに座ることがないようにする。ポジションは保たれる（PG スロットには依然
  // PG が入る）— 変わるのは各ポジション内の先発/ベンチの順序だけ。
  private optimizeLineup(team: number): void {
    const byPos: Record<string, number[]> = {};
    ROSTER[team].forEach((d, i) => { (byPos[d.role] ??= []).push(i); });
    for (const pos of Object.keys(byPos)) {
      const slots = byPos[pos].slice().sort((a, b) => a - b);   // 先発スロット（最小インデックス）が先
      const defs = slots.map((i) => ROSTER[team][i])
        .sort((a, b) => this.posValue(b, pos) - this.posValue(a, pos)); // 最強が先
      slots.forEach((slot, k) => { ROSTER[team][slot] = defs[k]; });
    }
  }

  // 選手がそのポジションにどれだけ適合するか — 彼の6軸ダイジェストを、ポジション
  // の必要性とその身長プレミアムで重み付けしたもの（戦力バーが使うのと同じ重み）。
  private posValue(def: PlayerDef, pos: string): number {
    const w = UI.ROLE_W[pos] ?? UI.ROLE_W.SF;
    const ax = this.axesOf(def);
    let s = 0;
    for (let k = 0; k < ax.length; k++) s += w.ax[k] * ax[k];
    return s + w.ht * UI.heightValue(def.height * 100);
  }

  /** 1チームの攻守ロール + プライマリ順序を、その現在のロスターに対して再最適化
   *  する — 選手の入れ替え後に便利 — チームの構成員は変えずに。 */
  private reassignRoles(team: number): void {
    this.autoAssignRoles(team);
    this.autoAssignChoiceRanks(team);
    this.refreshEditors();
  }

  // 新規抽選から各選手にデフォルトの評価ロールを割り当てる: 彼のポジションが
  // 取れるロールの中で、彼のプロフィールに最も合うもの。5人のエースが決して
  // 起きないようチームバランスのペナルティを付け、ロールをスカッド全体に散らす。
  // 先発が先に割り当てられ（チームの形を決める）、次にベンチ。
  private autoAssignRoles(only?: number): void {
    for (let t = 0; t < 2; t++) {
      if (only !== undefined && t !== only) continue;
      const taken = new Map<string, number>();
      for (let i = 0; i < ROSTER_SIZE; i++) {
        const def = ROSTER[t][i];
        const ax = this.axesOf(def);
        const hs = UI.heightValue(def.height * 100);
        let best = "";
        let bestS = -Infinity;
        for (const [nm, r] of Object.entries(UI.EVAL_ROLES)) {
          if (UI.DEF_ONLY.has(nm)) continue;   // 守備の仕事は今は DEF ロール側にある
          if (r.pos && !r.pos.includes(def.role)) continue;
          let s = r.ht * hs, tot = r.ht;
          for (let k = 0; k < ax.length; k++) { s += r.ax[k] * ax[k]; tot += r.ax[k]; }
          s /= tot;
          s -= (taken.get(nm) ?? 0) * 4;   // バランス: 重複ごとに 4 点のコスト
          if (s > bestS) { bestS = s; best = nm; }
        }
        def.evalRole = best || undefined;
        if (best) taken.set(best, (taken.get(best) ?? 0) + 1);
      }
      this.assignDefRoles(t);   // ユニット全体でバランスの取れた守備ロールのセットをドラフトする
    }
  }

  // 大きな青い「試合開始」ボタン — 2チームの間に置かれる（横並び表示の中央、
  // または狭いときはチームタブの間）。
  private tipOffButton(): HTMLButtonElement {
    const b = this.button("TIP OFF");
    Object.assign(b.style, {
      fontSize: "clamp(13px,3.3vw,17px)", fontWeight: "800", flexShrink: "0",
      padding: "clamp(7px,1.8vw,11px) clamp(14px,3.4vw,24px)",
      // 中立的なシルバー — RED にも BLUE にも属さないので、ティップオフが青側を
      // ひいきするのではなく公平に見える
      background: "rgba(232,235,242,0.96)", color: "#10131a",
      border: "1px solid rgba(255,255,255,0.5)",
    } as Partial<CSSStyleDeclaration>);
    b.onclick = () => { this.setPhase("playing"); this.onStart(); };
    return b;
  }

  // 2枚の 320px カード + TIP OFF 列 + gap ≈ 760px の内容。モーダルは 96vw と
  // padding で頭打ちなので、これが収まるのはビューポートが約 830px 幅になって
  // から。それ未満ではモーダルが両方を保持できないため、カードをあふれさせ/
  // 折り返すのではなく、タブトグルにフォールバックする。
  private rostersFitSideBySide(): boolean {
    return window.innerWidth >= 840;
  }

  /** 現在の ROSTER から VS ボードと両方のロスターカードを再構築する。 */
  private refreshEditors(): void {
    this.hidePlayerCard();
    this.closeRolePicker();
    this.closeDetailModal();
    this.closePlayerPicker();
    this.closeClubPicker();
    const sideBySide = this.rostersFitSideBySide();
    this.pregameMode = sideBySide ? "desktop" : "phone";
    // 横並び: 2列の内容に密着させる; トグル表示: VS ボードと単一カードの両方が
    // 端から端まで満たす、固定の快適な幅
    this.editorHost.style.width = sideBySide ? "auto" : "min(560px, 96vw)";
    this.editorHost.replaceChildren();

    // 戦力ボードの上のトップバー: 戻る（タイトルへ戻る） + TIP OFF（開始）。
    const topBar = document.createElement("div");
    Object.assign(topBar.style, {
      display: "flex", gap: "10px", justifyContent: "center", alignItems: "center",
      width: "100%", boxSizing: "border-box", padding: "10px 10px 8px",
    } as Partial<CSSStyleDeclaration>);
    const backBtn = this.button("戻る");
    Object.assign(backBtn.style, { fontSize: "12px", padding: "8px 20px" } as Partial<CSSStyleDeclaration>);
    backBtn.onclick = () => this.setPhase("title");
    topBar.append(backBtn, this.tipOffButton());
    this.editorHost.appendChild(topBar);

    this.vsBoard = this.buildVsBoard();
    if (sideBySide) {
      // 2列レイアウトの上で全幅のバーは間延びして見える — VS ボードを頭打ちに
      // してロスターの上で中央寄せする
      this.vsBoard.style.width = "min(560px, 100%)";
      this.vsBoard.style.alignSelf = "center";
    }
    this.editorHost.appendChild(this.vsBoard);

    if (!sideBySide) {
      // チームタブの後ろに一度に1つのロスター — 13人カードを2枚重ねるとモバイル
      // では延々とスクロールしてしまう。TIP OFF は2つのチームタブの間に置く。
      const tabs = document.createElement("div");
      Object.assign(tabs.style, { display: "flex", gap: "8px", justifyContent: "center", alignItems: "center", flexWrap: "wrap" } as Partial<CSSStyleDeclaration>);
      const teamTab = (t: number): HTMLButtonElement => {
        const b = this.button(TEAM_NAMES[t]);
        const active = this.rosterTab === t;
        Object.assign(b.style, {
          fontSize: "12px", padding: "5px 18px",
          background: active ? colorOf(t) : "rgba(20,24,34,0.9)",
          color: active ? "#0d1016" : "rgba(255,255,255,0.65)",
          border: `1px solid ${active ? colorOf(t) : "rgba(255,255,255,0.2)"}`,
          fontWeight: "800",
        } as Partial<CSSStyleDeclaration>);
        b.onclick = () => { this.rosterTab = t; this.refreshEditors(); };
        return b;
      };
      tabs.append(teamTab(0), teamTab(1));   // TIP OFF は今はトップバーにある
      this.editorHost.appendChild(tabs);
      const card = this.rosterCard(this.rosterTab);
      card.style.width = "100%";   // モーダルの幅を満たす（VS ボードの下に脇の帯なし）
      this.editorHost.appendChild(card);
      return;
    }

    // 横並び: [team 0 カード] [TIP OFF] [team 1 カード]
    const cols = document.createElement("div");
    Object.assign(cols.style, {
      display: "flex", gap: "12px", flexWrap: "nowrap", justifyContent: "center",
      alignItems: "stretch", width: "100%",
    } as Partial<CSSStyleDeclaration>);
    cols.append(this.rosterCard(0), this.rosterCard(1));   // TIP OFF は今はトップバーにある
    this.editorHost.appendChild(cols);
  }

  // ---- 試合前: VS 戦力ボード + コンパクトなロスターカード ------------------

  // ヘックスチャートおよびチーム戦力比較の6軸 — 25 の能力値の重み付け
  // ダイジェスト（能力値そのものはここでは編集されず、読み取るだけ）。
  private static readonly HEX_AXES: { label: string; calc: (a: Attributes) => number }[] = [
    { label: "シュート", calc: (a) => a.midAcc * 0.45 + a.threeAcc * 0.35 + a.shotTech * 0.2 },
    { label: "ドリブル", calc: (a) => a.handling * 0.4 + a.dribbleAcc * 0.35 + a.dribbleSpd * 0.25 },
    { label: "パス", calc: (a) => a.passAcc * 0.5 + a.passSpd * 0.25 + a.offense * 0.25 },
    { label: "スピード", calc: (a) => a.speed * 0.35 + a.accel * 0.25 + a.agility * 0.4 },
    { label: "フィジカル", calc: (a) => a.balance * 0.45 + a.jump * 0.3 + a.stamina * 0.25 },
    { label: "ディフェンス", calc: (a) => a.defense * 0.6 + a.reaction * 0.2 + a.agility * 0.2 },
  ];
  private axesOf(def: PlayerDef): number[] {
    return UI.HEX_AXES.map((x) => x.calc(def.attr));
  }

  // 各ポジションが実際に必要とするもの、軸ごとに（HEX_AXES と同じ順）、加えて
  // そこで素の身長がどれだけ重要か。単純平均では全選手が同じ評価になってしまう —
  // これはロールの必要性と選手のピークを重み付けする。
  private static readonly ROLE_W: Record<string, { ax: number[]; ht: number }> = {
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
  private static readonly EVAL_ROLES: Record<string, { ax: number[]; ht: number; short: string; pos?: string[]; tip: string }> = {
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
  private static readonly DEF_ONLY = new Set(["ロックダウン", "スイッチディフェンダー", "エナジーガイ"]);

  // ディフェンスロールのカタログ（オフェンスロールと独立に選択）。effort ギアは
  // attributes.ts の DEF_ROLE_BEHAVIOR 側が持つ（守備出力＝スタミナ消費に連動）。
  private static readonly DEF_ROLES: Record<string, { short: string; tip: string }> = {
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
  private static readonly OFF_GROUP_C: Record<string, string> = {
    エース: "rgb(216,58,58)", スポットアップ: "rgb(216,58,58)", "3&D": "rgb(216,58,58)",
    ストレッチ: "rgb(216,58,58)", フロアスペーサー: "rgb(216,58,58)", インサイドフィニッシャー: "rgb(216,58,58)",
    リムランナー: "rgb(216,58,58)", スラッシャー: "rgb(216,58,58)", オフボールカッター: "rgb(216,58,58)",
    メインハンドラー: "rgb(228,180,0)", セカンドハンドラー: "rgb(228,180,0)", フロアジェネラル: "rgb(228,180,0)",
    ポイントフォワード: "rgb(228,180,0)", プレイメイキングビッグ: "rgb(228,180,0)", スクリーナー: "rgb(228,180,0)",
    リバウンダー: "rgb(224,123,30)", エナジーガイ: "rgb(224,123,30)",
  };
  private static readonly DEF_GROUP_C: Record<string, string> = {
    ロックダウン: "rgb(53,104,208)", スイッチディフェンダー: "rgb(53,104,208)", パスカット: "rgb(53,104,208)",
    リムプロテクター: "rgb(47,157,85)", ヘルプディフェンダー: "rgb(47,157,85)", 守備司令塔: "rgb(47,157,85)",
    ハッスルディフェンダー: "rgb(31,166,189)", バランス: "rgb(31,166,189)", 省エネ: "rgb(31,166,189)",
  };

  // オフェンスの選択順位（プライマリ 1..5）を得点力から自動割り当てし、デフォルト
  // ではボールが最良のスコアラーに集まるようにする。先発とベンチは別々に順位
  // 付けされる（それぞれ 1..5）ので、先発の「1」とベンチの「1」が共存できる —
  // それでよい（ユーザーが望まない限り2人の #1 が同時にコートに立つことはない;
  // エンジンは本当のタイを共有の co-primary として扱う）。
  private autoAssignChoiceRanks(only?: number): void {
    for (let t = 0; t < 2; t++) {
      if (only !== undefined && t !== only) continue;
      this.rankGroup(ROSTER[t].slice(0, STARTERS));
      this.rankGroup(ROSTER[t].slice(STARTERS));
    }
  }
  private rankGroup(defs: PlayerDef[]): void {
    defs.map((d) => ({ d, s: scoringPower(d.attr) }))
      .sort((a, b) => b.s - a.s)
      .forEach((o, k) => { o.d.choiceRank = Math.min(k + 1, 5); });
  }
  // 新しく配置された1選手を、彼のユニット内で能力によって順位付けする（交代時に
  // 使うので、チームメイトの手動設定の順位はそのまま）。タイは許容。
  private assignRankFor(def: PlayerDef, team: number, idx: number): void {
    const grp = idx < STARTERS ? ROSTER[team].slice(0, STARTERS) : ROSTER[team].slice(STARTERS);
    const mine = scoringPower(def.attr);
    let higher = 0;
    for (const d of grp) if (d !== def && scoringPower(d.attr) > mine) higher++;
    def.choiceRank = Math.min(higher + 1, 5);
  }

  // 1選手にとって最良のオフェンスロールを、彼の能力軸から求める（チームバランス
  // なし — 単一の交代時に使う; チーム全体でバランスした版は autoAssignRoles）。
  private bestOffRole(def: PlayerDef): string | undefined {
    const ax = this.axesOf(def);
    const hs = UI.heightValue(def.height * 100);
    let best = "", bestS = -Infinity;
    for (const [nm, r] of Object.entries(UI.EVAL_ROLES)) {
      if (UI.DEF_ONLY.has(nm)) continue;
      if (r.pos && !r.pos.includes(def.role)) continue;
      let s = r.ht * hs, tot = r.ht;
      for (let k = 0; k < ax.length; k++) { s += r.ax[k] * ax[k]; tot += r.ax[k]; }
      s /= tot;
      if (s > bestS) { bestS = s; best = nm; }
    }
    return best || undefined;
  }

  // 選手の能力値からデフォルトの守備ロールを自動判定する: 強力なディフェンダーは
  // ロックダウン（本人がスコアラーでもあれば両面）、リムを守るビッグはアンカー、
  // 使用率の高いオフェンス専門家は温存（省エネ）、その他は皆バランス。
  // この選手のポジション・体格・守備の強みから、各守備ロールへの適合スコアを出す
  // — 高いほど適している。assignDefRoles はこれらからバランスの取れたラインナップ
  // をドラフトする; pickDefRole は単一選手の選択。
  private defRoleFits(def: PlayerDef): Record<string, number> {
    const a = def.attr;
    const r = (x: number) => Math.max(0, Math.min(1, x / 100));
    const def_ = r(a.defense), rea = r(a.reaction), agi = r(a.agility);
    const jmp = r(a.jump), dnk = r(a.dunk), bal = r(a.balance);
    const mnt = r(a.mental), tmw = r(a.teamwork);
    const ht = Math.max(0, Math.min(1, (def.height - 1.85) / 0.3));   // 1.85m→0 .. 2.15m→1
    const off = Math.max(r(a.threeAcc), r(a.midAcc)) * 0.55 + r(a.aggression) * 0.45; // 得点負荷
    const big = def.role === "PF" || def.role === "C";
    const guard = def.role === "PG" || def.role === "SG";
    const wing = def.role === "SF";
    const perim = guard || wing;
    return {
      リムプロテクター:       ht * 0.32 + jmp * 0.24 + dnk * 0.24 + def_ * 0.20 + (big ? 0.10 : -0.16),
      ロックダウン:           (def_ * 0.44 + agi * 0.32 + rea * 0.18 + bal * 0.06) * (1 - off * 0.20) + (perim ? 0.06 : -0.10),
      パスカット:             (rea * 0.40 + agi * 0.34 + def_ * 0.26) + (perim ? 0.05 : -0.08) - off * 0.10,
      スイッチディフェンダー:  agi * 0.26 + def_ * 0.26 + bal * 0.18 + ht * 0.22 + ((wing || def.role === "PF") ? 0.11 : -0.05),
      ヘルプディフェンダー:    def_ * 0.32 + mnt * 0.28 + rea * 0.18 + bal * 0.16,
      守備司令塔:             mnt * 0.40 + tmw * 0.36 + def_ * 0.24 + (guard ? 0.06 : -0.08),
      ハッスルディフェンダー:  (def_ + agi + rea) / 3 * 0.48 + off * 0.28 + bal * 0.20,
      省エネ:                 (off - 0.5) * 1.2 + (0.5 - def_) * 0.9 + 0.28,   // 守備ができないスコアラー
      バランス:               0.50,                                            // 安定したベースラインのフォールバック
    };
  }
  private static readonly DEF_ROLE_SPREAD = 0.15;   // ユニット全体にロールを散らす際の、重複ごとのペナルティ

  // 1選手にとって最も適合する守備ロール。任意で重複を散らす（彼のユニットで
  // 既に使われているロールにはペナルティ）。単一選手が配置されたときに使う。
  private pickDefRole(def: PlayerDef, taken?: Map<string, number>): string {
    const fit = this.defRoleFits(def);
    let best = "バランス", bestV = -Infinity;
    for (const role of Object.keys(fit)) {
      const s = fit[role] - (taken ? (taken.get(role) ?? 0) * UI.DEF_ROLE_SPREAD : 0);
      if (s > bestV) { bestV = s; best = role; }
    }
    return best;
  }

  // ユニット全体（先発5人、次にベンチ8人）に守備ロールをドラフトし、ライン
  // ナップがバランスの取れた守備になるようにする: 各ロールはそれに最も適合する
  // 選手に割り当てられ、確信度の高い割り当てから先に、重複を散らすペナルティ
  // つきで — こうしてラインナップには、リムプロテクター、オンボールのロック、
  // レーンの泥棒、フロアジェネラル、ヘルプ役などが、実際に各々に適した者に
  // 合わせて揃う。
  private assignDefRoles(team: number): void {
    for (const unit of [ROSTER[team].slice(0, STARTERS), ROSTER[team].slice(STARTERS)]) {
      const taken = new Map<string, number>();
      const rem = unit.map((_, i) => i);
      const fitsOf = unit.map((d) => this.defRoleFits(d));
      while (rem.length) {
        let bi = rem[0], brole = "バランス", bv = -Infinity;
        for (const pi of rem) {
          for (const role of Object.keys(fitsOf[pi])) {
            const s = fitsOf[pi][role] - (taken.get(role) ?? 0) * UI.DEF_ROLE_SPREAD;
            if (s > bv) { bv = s; bi = pi; brole = role; }
          }
        }
        unit[bi].defRole = brole;
        taken.set(brole, (taken.get(brole) ?? 0) + 1);
        rem.splice(rem.indexOf(bi), 1);
      }
    }
  }

  // 選手に実際に使われる重み: 彼の手動設定の評価ロール、または 自動 のままの
  // 場合は彼のポジションのプロフィール。
  private effWeights(def: PlayerDef): { ax: number[]; ht: number } {
    return (def.evalRole && UI.EVAL_ROLES[def.evalRole])
      || UI.ROLE_W[def.role] || UI.ROLE_W.SF;
  }

  // 一列に並ぶ5つのポジションチップ — この選手がカバーできる全ポジション
  // （自分自身を含む）が同じチームカラーのハイライトで点灯し、残りは暗くなる。
  private positionChips(def: PlayerDef, color: string): HTMLDivElement {
    const covers = new Set(this.coverablePositions(def));
    const row = document.createElement("div");
    Object.assign(row.style, { display: "flex", gap: "4px", justifyContent: "center" } as Partial<CSSStyleDeclaration>);
    for (const r of ["PG", "SG", "SF", "PF", "C"]) {
      const on = covers.has(r);
      const c = document.createElement("span");
      Object.assign(c.style, {
        fontSize: "10px", fontWeight: "800", width: "36px", padding: "2px 0",
        textAlign: "center", borderRadius: "6px", boxSizing: "border-box",
        background: on ? color : "rgba(255,255,255,0.04)",
        color: on ? "#0d1016" : "rgba(255,255,255,0.28)",
        border: on ? `1px solid ${color}` : "1px solid rgba(255,255,255,0.1)",
      } as Partial<CSSStyleDeclaration>);
      c.textContent = r;
      row.appendChild(c);
    }
    return row;
  }

  // 守れるポジション: ゲームの交代隣接関係（game.ts の roleFit）を、選手ごとに
  // ゲートする — 大きいスロットはそれ相応のサイズがあるときだけ、小さいスロット
  // はそれ相応の脚力があるときだけ。表示用のヒューリスティック; 最初の要素 = 自分自身。
  private coverablePositions(def: PlayerDef): string[] {
    const ADJ: Record<string, string[]> = {
      PG: ["SG"], SG: ["PG", "SF"], SF: ["SG", "PF"], PF: ["SF", "C"], C: ["PF"],
    };
    const ORDER = ["PG", "SG", "SF", "PF", "C"];
    const minHt: Record<string, number> = { PG: 0, SG: 183, SF: 192, PF: 198, C: 203 };
    const cm = def.height * 100;
    const quick = (def.attr.agility + def.attr.speed) / 2;
    const res = [def.role];
    for (const t of ADJ[def.role] ?? []) {
      const up = ORDER.indexOf(t) > ORDER.indexOf(def.role);
      if (up ? cm >= (minHt[t] ?? 999) : quick >= 74) res.push(t);
    }
    return res;
  }

  // 「ピーク」走査が考慮する素の能力値 — 専門家の上位2つの単一能力は彼の看板で
  // あり、平均化されたどの軸よりもはるかに際立つ（精神/スタミナ/連携系の能力値は
  // 意図的に除外）。
  private static readonly PEAK_KEYS: (keyof Attributes)[] = [
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
  private static heightValue(cm: number): number {
    return Math.max(0, Math.min(100, 70 + (cm - 180) * 1.5));
  }

  private ovrOf(def: PlayerDef): number {
    const ax = this.axesOf(def);
    const w = this.effWeights(def);   // ポジションのプロフィール、または手動設定の評価ロール
    const htScore = UI.heightValue(def.height * 100);
    let pos = w.ht * htScore, tot = w.ht;
    for (let i = 0; i < ax.length; i++) { pos += w.ax[i] * ax[i]; tot += w.ax[i]; }
    pos /= tot;
    const raw = UI.PEAK_KEYS.map((k) => def.attr[k]).sort((a, b) => b - a);
    const v = pos * 0.5 + ((raw[0] + raw[1]) / 2) * 0.5;
    return Math.round(Math.max(40, Math.min(99, 74 + (v - 74) * 1.4)));
  }
  // 軸ごとのチーム戦力: 単純平均ではない — 各選手は、彼のポジション（または手動
  // 設定の評価ロール）がその軸にどれだけ責任を持つかに比例して軸に寄与する:
  // PG のパスはチームのパスそのものだが、C はその針をほとんど動かさない。
  // 先発が 70%、ベンチのローテーションが 30% を担う。
  private teamAxes(team: number): number[] {
    return this.teamAxesOf(ROSTER[team]);
  }
  // 任意のロスター配列に対する同じ計算（交代のプレビューに使う）。
  private teamAxesOf(r: PlayerDef[]): number[] {
    return UI.HEX_AXES.map((x, i) => {
      const grp = (from: number, to: number): number => {
        let v = 0, w = 0;
        for (let j = from; j < to; j++) {
          const wt = this.effWeights(r[j]).ax[i] + 0.02; // わずかな下限: 誰もが少しは寄与する
          v += x.calc(r[j].attr) * wt;
          w += wt;
        }
        return v / w;
      };
      return grp(0, STARTERS) * 0.7 + grp(STARTERS, ROSTER_SIZE) * 0.3;
    });
  }

  // 直接対決ボード: 2チームの6軸を左右に並べたトルネード型。強い側の数字が
  // 点灯する。
  // ヘッダー用のチームの数値: 選手の OVR、先発 70% ベンチ 30%。
  private teamOvr(team: number): number {
    return this.teamOvrOf(ROSTER[team]);
  }
  private teamOvrOf(r: PlayerDef[]): number {
    let st = 0, bn = 0;
    for (let j = 0; j < STARTERS; j++) st += this.ovrOf(r[j]);
    for (let j = STARTERS; j < ROSTER_SIZE; j++) bn += this.ovrOf(r[j]);
    return Math.round((st / STARTERS) * 0.7 + (bn / (ROSTER_SIZE - STARTERS)) * 0.3);
  }

  // ...そしてそのサイズ: cm 単位の身長を、各人のポジション/ロールにとって身長が
  // どれだけ重要かで重み付け — C のリーチはチームのサイズだが、PG の身長は
  // ほとんど影響しない。
  private teamHeight(team: number): number {
    return this.teamHeightOf(ROSTER[team]);
  }
  private teamHeightOf(r: PlayerDef[]): number {
    const grp = (from: number, to: number): number => {
      let v = 0, w = 0;
      for (let j = from; j < to; j++) {
        const wt = this.effWeights(r[j]).ht + 0.02;
        v += r[j].height * wt;
        w += wt;
      }
      return v / w;
    };
    return (grp(0, STARTERS) * 0.7 + grp(STARTERS, ROSTER_SIZE) * 0.3) * 100;
  }

  // 交代プレビューの増減用の、淡い緑（増加）/ 薄い赤（減少）の色。
  private static readonly GAIN = "rgb(120,225,140)";
  private static readonly LOSS = "rgb(240,140,130)";
  // 各ロールは独自のアクセントカラーを持ち、一目で見分けられるようにする。
  // 自然なペアを成すオフェンスと守備のロールは1つの色を共有する:
  //   フロアジェネラル(攻) = 守備司令塔(守)   … 司令塔 / コート上の指揮官
  //   エース(攻)           = ロックダウン(守)  … スター ↔ スターを止める者
  // 主張しすぎず暗い UI に馴染むよう、彩度を落として抑えてある
  // （オフェンス/守備のロール色は上で定義したグループパレット OFF_GROUP_C /
  //  DEF_GROUP_C — オフェンスは暖色、守備は寒色。試合中のアイコンとエディタの
  //  ロールピル / ピッカーで共有される。）
  private static readonly USE_C = "rgb(198,202,212)";  // 順 プライマリ/使用率順 — 中立的なシルバー

  // `preview`（取り込む DB 選手を対象行の上に運んでいる間に設定される）は、
  // 交代が起きたら1チームの戦力バーがどう変わるかを示す: 各バーの変化した
  // 部分と ±N の数値が淡い緑 / 薄い赤で色付けされる。
  private buildVsBoard(preview?: { team: number; roster: PlayerDef[] }): HTMLDivElement {
    const baseAxes = [this.teamAxes(0), this.teamAxes(1)];
    const dispAxes = [baseAxes[0].slice(), baseAxes[1].slice()];
    if (preview) dispAxes[preview.team] = this.teamAxesOf(preview.roster);
    const colA = colorOf(0), colB = colorOf(1);
    // 指定した側がプレビュー中かどうか
    const prev = (t: number) => (preview && preview.team === t);

    const wrap = document.createElement("div");
    Object.assign(wrap.style, {
      width: "100%", boxSizing: "border-box", padding: "7px 14px",
      background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.14)",
      // gap: 積み重ねた比較行（シュート / ドリブル / …）間の縦の間隔 — バーが
      // 近くに並ぶよう詰めておく
      borderRadius: "12px", display: "flex", flexDirection: "column", gap: "1px",
    } as Partial<CSSStyleDeclaration>);

    // ヘッダー: TEAM A  <OVR>  VS  <OVR>  TEAM B
    const head = document.createElement("div");
    Object.assign(head.style, {
      display: "grid", gridTemplateColumns: "1fr auto auto auto 1fr", gap: "10px",
      alignItems: "baseline", marginBottom: "3px",
    } as Partial<CSSStyleDeclaration>);
    const nameEl = (t: number, align: string): HTMLDivElement => {
      const d = document.createElement("div");
      Object.assign(d.style, { fontSize: "15px", fontWeight: "800", color: colorOf(t), textAlign: align, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" });
      d.textContent = TEAM_NAMES[t];
      return d;
    };
    const ovrEl = (v: number, win: boolean, delta: number | null): HTMLDivElement => {
      const d = document.createElement("div");
      Object.assign(d.style, { display: "flex", alignItems: "baseline", gap: "3px", fontSize: "22px", fontWeight: "800", color: "#fff", opacity: win ? "1" : "0.55" });
      const n = document.createElement("span");
      n.textContent = String(v);
      d.appendChild(n);
      if (delta !== null && delta !== 0) {
        const dl = document.createElement("span");
        Object.assign(dl.style, { fontSize: "12px", fontWeight: "800", color: delta > 0 ? UI.GAIN : UI.LOSS });
        dl.textContent = delta > 0 ? `+${delta}` : `${delta}`;
        d.appendChild(dl);
      }
      return d;
    };
    const vs = document.createElement("div");
    Object.assign(vs.style, { fontSize: "13px", fontWeight: "800", opacity: "0.6", letterSpacing: "2px" });
    vs.textContent = "VS";
    const baseOvr = [this.teamOvr(0), this.teamOvr(1)];
    const dispOvr = baseOvr.slice();
    if (preview) dispOvr[preview.team] = this.teamOvrOf(preview.roster);
    const oa = dispOvr[0], ob = dispOvr[1];
    head.append(
      nameEl(0, "left"),
      ovrEl(oa, oa >= ob, prev(0) ? oa - baseOvr[0] : null),
      vs,
      ovrEl(ob, ob >= oa, prev(1) ? ob - baseOvr[1] : null),
      nameEl(1, "right"),
    );
    wrap.appendChild(head);

    // 比較行: 値 | ←バー | ラベル | バー→ | 値。バーは宣言された帯域を広げる
    // （能力値は圧縮されている）— 正確な数値はその脇に置かれる。
    // `dA`/`dB` はプレビュー中のチームの行ごとの増減（それ以外は null）。
    const addRow = (label: string, a: number, b: number, lo: number, hi: number,
                    oldA: number | null, oldB: number | null) => {
      const row = document.createElement("div");
      Object.assign(row.style, {
        // 値の列は数字だけを保持し、外側の端に寄せる。こうして2本のバーが長く
        // 伸び、詰まった中央ラベルを挟んで近くに並ぶ。プレビューの ±N は浮遊
        // （absolute）するので列幅を消費しない — 増減が現れてもボードは再フロー
        // せず、バーも縮まない。
        display: "grid", gridTemplateColumns: "40px 1fr 54px 1fr 40px", gap: "6px",
        alignItems: "center",
      } as Partial<CSSStyleDeclaration>);
      const scale = (v: number) => Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100));
      // 値のセル: 数字は外側の端に密着する; 色付きの ±N（プレビュー時のみ表示）
      // はバーの空いた端の上に内向きに浮遊し、上に描かれるので決して隠れず、
      // セルを広げることもない。
      const val = (v: number, win: boolean, align: string, old: number | null): HTMLDivElement => {
        const d = document.createElement("div");
        Object.assign(d.style, {
          position: "relative", display: "flex", alignItems: "center", whiteSpace: "nowrap",
          // 外側の端に密着: team A（左列）は左へ、team B は右へ
          justifyContent: align === "right" ? "flex-start" : "flex-end",
        } as Partial<CSSStyleDeclaration>);
        const n = document.createElement("span");
        Object.assign(n.style, { fontSize: "12px", fontWeight: "800", color: "#fff", opacity: win ? "1" : "0.5" });
        n.textContent = v.toFixed(1);   // 0.1 の精度で小さな交代も見えるように
        d.appendChild(n);
        // 小数第1位までの真の変化 — ベンチ / 先発⇄ベンチの交代はチームの値を
        // 1点未満しか動かさないので、整数の増減では消えてしまう。
        const raw = old !== null ? v - old : 0;
        const delta = Math.round(raw * 10) / 10;
        if (delta !== 0) {
          const dl = document.createElement("span");
          Object.assign(dl.style, {
            position: "absolute", top: "50%", fontSize: "10px", fontWeight: "800",
            color: delta > 0 ? UI.GAIN : UI.LOSS, zIndex: "5", pointerEvents: "none",
            // 中央/バーの方へ浮かせ、外側の数字が位置を保つようにする
            ...(align === "right"
              ? { right: "0", transform: "translate(calc(100% + 3px), -50%)" }
              : { left: "0", transform: "translate(calc(-100% - 3px), -50%)" }),
          } as Partial<CSSStyleDeclaration>);
          dl.textContent = delta > 0 ? `+${delta.toFixed(1)}` : delta.toFixed(1);
          d.appendChild(dl);
        }
        return d;
      };
      // バー: チームカラーのベース塗り; プレビュー時は、変化した部分が淡い緑
      // （増加）または薄い赤（減少）で色付けされ、中央から外向きに伸びる。
      const bar = (v: number, color: string, win: boolean, fromRight: boolean, old: number | null): HTMLDivElement => {
        const track = document.createElement("div");
        Object.assign(track.style, {
          height: "8px", background: "rgba(255,255,255,0.08)", borderRadius: "4px",
          overflow: "hidden", display: "flex", justifyContent: fromRight ? "flex-end" : "flex-start",
        } as Partial<CSSStyleDeclaration>);
        const seg = (w: number, bg: string): HTMLDivElement => {
          const s = document.createElement("div");
          Object.assign(s.style, { width: `${w}%`, height: "100%", background: bg, opacity: win ? "1" : "0.55" });
          return s;
        };
        const sNew = scale(v);
        if (old === null) {
          track.appendChild(seg(Math.max(4, sNew), color));
        } else {
          const sOld = scale(old);
          const baseW = Math.min(sOld, sNew), deltaW = Math.abs(sNew - sOld);
          const gain = sNew >= sOld;
          const baseSeg = seg(Math.max(1, baseW), color);
          const deltaSeg = deltaW > 0.15 ? seg(deltaW, gain ? UI.GAIN : UI.LOSS) : null;
          // 外向きの方向: A は左へ伸びる（増減はベースの外側 = flex-end 行では
          // ベースの前）; B は右へ伸びる（増減はベースの後）。
          if (fromRight) { if (deltaSeg) track.appendChild(deltaSeg); track.appendChild(baseSeg); }
          else { track.appendChild(baseSeg); if (deltaSeg) track.appendChild(deltaSeg); }
        }
        return track;
      };
      const lab = document.createElement("div");
      Object.assign(lab.style, { fontSize: "11px", fontWeight: "700", opacity: "0.75", textAlign: "center", whiteSpace: "nowrap" });
      lab.textContent = label;
      row.append(
        val(a, a >= b, "right", oldA),
        bar(a, colA, a >= b, true, oldA),
        lab,
        bar(b, colB, b >= a, false, oldB),
        val(b, b >= a, "left", oldB),
      );
      wrap.appendChild(row);
    };
    for (let i = 0; i < UI.HEX_AXES.length; i++) {
      addRow(UI.HEX_AXES[i].label, dispAxes[0][i], dispAxes[1][i], 40, 99,
        prev(0) ? baseAxes[0][i] : null, prev(1) ? baseAxes[1][i] : null);
    }
    // チームのサイズ — 責任で重み付けした身長を、ユーザーのキャリブレーション
    // （180cm → 70, 200cm → 100）で戦力値に変換。軸と同じ帯域
    const hBase = [UI.heightValue(this.teamHeight(0)), UI.heightValue(this.teamHeight(1))];
    const hDisp = hBase.slice();
    if (preview) hDisp[preview.team] = UI.heightValue(this.teamHeightOf(preview.roster));
    addRow("高さ", hDisp[0], hDisp[1], 40, 100,
      prev(0) ? hBase[0] : null, prev(1) ? hBase[1] : null);
    return wrap;
  }

  // ライブの VS ボード要素を新しく構築したものに差し替える（任意でプレビュー）。
  private replaceVsBoard(next: HTMLDivElement): void {
    if (this.vsBoard?.parentElement) this.vsBoard.parentElement.replaceChild(next, this.vsBoard);
    this.vsBoard = next;
  }
  // 「この交代がチーム戦力に何をするか」のプレビューをボード上に表示/クリアする。
  private showVsPreview(team: number, idx: number, dbp: DbPlayer): void {
    const roster = ROSTER[team].slice();
    roster[idx] = makeDefFromDb(dbp);
    this.vsPreviewActive = true;
    this.replaceVsBoard(this.buildVsBoard({ team, roster }));
  }
  // 評価ロールの変更がこの選手のチームの戦力バーをどう動かすかをプレビューする。
  private previewRole(def: PlayerDef, team: number, role: string): void {
    const idx = ROSTER[team].indexOf(def);
    if (idx < 0) return;
    const roster = ROSTER[team].slice();
    roster[idx] = { ...def, evalRole: role === "自動" ? undefined : role };  // attr は共有（読み取り専用）
    this.vsPreviewActive = true;
    this.replaceVsBoard(this.buildVsBoard({ team, roster }));
  }
  // チームのロスタースロットを2つ交換（先発 ⇄ ベンチ、ドラッグ＆ドロップで）
  // したときに戦力バーがどう動くかをプレビューする — 先発は 70%、ベンチは 30%
  // なので、強い控えを先発5人に入れるとチームが底上げされる。
  private showSwapPreview(team: number, idxA: number, idxB: number): void {
    const roster = ROSTER[team].slice();
    [roster[idxA], roster[idxB]] = [roster[idxB], roster[idxA]];
    this.vsPreviewActive = true;
    this.replaceVsBoard(this.buildVsBoard({ team, roster }));
  }
  private clearVsPreview(): void {
    if (!this.vsPreviewActive) return;
    this.vsPreviewActive = false;
    this.replaceVsBoard(this.buildVsBoard());
  }

  // 1チームのロスター: コンパクトな行（ポジション / 名前 / 身長 / OVR）、先発は
  // ベンチの区切りの上。選手をクリックし、次に別の選手をクリックすると入れ替え —
  // ホバーで詳細カード（ヘックスチャート + 特殊能力）が表示される。
  private rosterCard(team: number): HTMLDivElement {
    const color = colorOf(team);
    const wrap = document.createElement("div");
    Object.assign(wrap.style, {
      width: "min(320px, 96vw)", boxSizing: "border-box", padding: "6px 10px",
      background: "rgba(255,255,255,0.03)", border: `1px solid ${color}`, borderRadius: "10px",
      display: "flex", flexDirection: "column", gap: "1px", textAlign: "left",
    } as Partial<CSSStyleDeclaration>);

    // ヘッダー: チーム名 + 4000人超の DB ピッカーを開く「選手を交代」ボタン
    const head = document.createElement("div");
    Object.assign(head.style, {
      display: "flex", alignItems: "center", justifyContent: "space-between",
      gap: "8px", margin: "0 0 2px",
    } as Partial<CSSStyleDeclaration>);
    const teamName = document.createElement("span");
    Object.assign(teamName.style, { fontSize: "15px", fontWeight: "800", color });
    teamName.textContent = TEAM_NAMES[team];
    // 名前の脇のチームごとのコントロール: このスカッドを引き直す / 現在のライン
    // ナップに合わせてロールを再最適化 / DB から選手を交代。3つがカードに収まる
    // ようコンパクトにし、非常に狭い表示では折り返しを許す。
    const ctrlBtn = (label: string, filled: boolean, onClick: () => void): HTMLButtonElement => {
      const b = this.button(label);
      Object.assign(b.style, {
        fontSize: "10px", fontWeight: "800", padding: "3px 8px",
        background: filled ? color : "rgba(255,255,255,0.06)",
        color: filled ? "#0d1016" : "#dfe4ee", border: `1px solid ${color}`,
      } as Partial<CSSStyleDeclaration>);
      b.onclick = onClick;
      return b;
    };
    const roleBtn = ctrlBtn("役割再設定", false, () => this.reassignRoles(team));
    const swapBtn = ctrlBtn("選手を交代", false, () => this.openPlayerPicker(team));
    // クラブ選択ボタンは廃止（対戦モードはタイトルで決める）。ランダム編成は、この
    // チームがクラブ対戦（TEAM_CLUB が設定済み）のときは不要なので出さない。
    const btns = document.createElement("div");
    Object.assign(btns.style, { display: "flex", gap: "5px", flexWrap: "nowrap", justifyContent: "flex-start", margin: "0 0 3px" } as Partial<CSSStyleDeclaration>);
    if (TEAM_CLUB[team]) {
      btns.append(roleBtn, swapBtn);
    } else {
      const genBtn = ctrlBtn("ランダム編成", false, () => this.randomizeOne(team));
      btns.append(genBtn, roleBtn, swapBtn);
    }
    head.append(teamName);
    wrap.appendChild(head);
    wrap.appendChild(btns);

    const divider = (label: string): HTMLDivElement => {
      const d = document.createElement("div");
      Object.assign(d.style, { fontSize: "10px", fontWeight: "800", letterSpacing: "2px", opacity: "0.55", margin: "2px 2px 0" });
      d.textContent = label;
      return d;
    };
    wrap.appendChild(divider("スタメン"));
    for (let i = 0; i < STARTERS; i++) wrap.appendChild(this.playerRow(team, i));
    wrap.appendChild(divider("ベンチ"));
    for (let i = STARTERS; i < ROSTER_SIZE; i++) wrap.appendChild(this.playerRow(team, i));
    return wrap;
  }

  private playerRow(team: number, i: number): HTMLDivElement {
    const def = ROSTER[team][i];
    const color = colorOf(team);
    const ovr = this.ovrOf(def);

    const row = document.createElement("div");
    row.dataset.dropTeam = String(team);   // ドラッグ＆ドロップのヒットテスト
    row.dataset.dropIdx = String(i);
    Object.assign(row.style, {
      display: "grid", gridTemplateColumns: "26px 30px 30px 22px 1fr 24px 22px 24px", gap: "5px",
      alignItems: "center", padding: "1px 6px", borderRadius: "6px",
      cursor: "grab", pointerEvents: "auto",
      background: "rgba(255,255,255,0.04)",
      border: "1px solid transparent",
    } as Partial<CSSStyleDeclaration>);

    const pos = document.createElement("span");
    Object.assign(pos.style, { fontSize: "10px", fontWeight: "800", color, border: `1px solid ${color}`, borderRadius: "5px", textAlign: "center", padding: "1px 0" });
    pos.textContent = def.role;

    // ポジションチップと同サイズの3つのピル。このロスター行でそのまま編集できる:
    //   攻 = オフェンスロール, 守 = 守備ロール, 順 = オフェンス選択順位（使用率）。
    // 攻/守 のピルは選択したロール自身の色を取る（ペアのオフェンス/守備ロールは
    // 1色を共有）ので、ロールが一目で見分けられる。（フルの名前 / ヒントは
    // ピッカー + 詳細 にある）
    const pill = (text: string, active: boolean, accent: string, title: string, onClick: () => void): HTMLButtonElement => {
      const b = document.createElement("button");
      b.textContent = text; b.title = title;
      Object.assign(b.style, {
        fontSize: "9px", fontWeight: active ? "800" : "600", width: "100%", boxSizing: "border-box",
        padding: "2px 0", borderRadius: "9px", cursor: "pointer", pointerEvents: "auto",
        whiteSpace: "nowrap", overflow: "hidden", textAlign: "center",
        background: active ? accent : "rgba(20,24,34,0.9)",
        color: active ? "#0d1016" : "rgba(255,255,255,0.45)",
        border: active ? `1px solid ${accent}` : "1px solid rgba(255,255,255,0.16)",
      } as Partial<CSSStyleDeclaration>);
      b.onpointerdown = (e) => e.stopPropagation();
      b.onclick = (e) => { e.stopPropagation(); onClick(); };
      return b;
    };
    const offC = (def.evalRole && UI.OFF_GROUP_C[def.evalRole]) || "rgb(150,156,168)";
    const defC = (def.defRole && UI.DEF_GROUP_C[def.defRole]) || "rgb(150,156,168)";
    const roleSel = pill(def.evalRole ? (UI.EVAL_ROLES[def.evalRole]?.short ?? "?") : "-",
      !!def.evalRole, offC, "オフェンスロール", () => this.openRolePicker(def, team, roleSel, undefined, "off"));
    const defSel = pill(def.defRole ? (UI.DEF_ROLES[def.defRole]?.short ?? "?") : "-",
      !!def.defRole, defC, "ディフェンスロール", () => this.openRolePicker(def, team, defSel, undefined, "def"));
    const rankSel = pill(def.choiceRank ? String(def.choiceRank) : "-",
      !!def.choiceRank, UI.USE_C, "オフェンス選択順位（1=最優先。未設定=能力で自動）", () => {
        def.choiceRank = def.choiceRank === undefined ? 1 : def.choiceRank >= 5 ? undefined : def.choiceRank + 1;
        this.refreshEditors();
      });

    const name = document.createElement("span");
    Object.assign(name.style, { fontSize: "12px", fontWeight: "700", color: "#fff", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" });
    name.textContent = def.name;

    const ht = document.createElement("span");
    Object.assign(ht.style, { fontSize: "10px", opacity: "0.55", textAlign: "right" });
    ht.textContent = String(Math.round(def.height * 100));

    const num = document.createElement("span");
    Object.assign(num.style, { fontSize: "13px", fontWeight: "800", color: "#fff", textAlign: "right" });
    num.textContent = String(ovr);

    // 詳細 — 全能力値モーダルを開く（全 25 能力値 + 特殊能力）
    const det = document.createElement("button");
    det.textContent = "詳";
    Object.assign(det.style, {
      fontSize: "10px", fontWeight: "700", padding: "2px 0", width: "100%",
      borderRadius: "6px", cursor: "pointer", pointerEvents: "auto", boxSizing: "border-box",
      background: "rgba(255,255,255,0.07)", color: "rgba(255,255,255,0.75)",
      border: "1px solid rgba(255,255,255,0.18)",
    } as Partial<CSSStyleDeclaration>);
    det.onpointerdown = (e) => e.stopPropagation();
    det.onclick = (e) => { e.stopPropagation(); this.openDetailModal(def, team); };

    row.append(pos, roleSel, defSel, rankSel, name, ht, num, det);
    row.onpointerdown = (e) => this.beginDrag(team, i, e);
    row.onmouseenter = () => { if (!this.dragFrom && !this.carry && !this.rolePicker && !this.detailModal) this.showPlayerCard(def, team, row); };
    row.onmouseleave = () => this.hidePlayerCard();
    return row;
  }

  // ドラッグ＆ドロップの入れ替え: 選手のバーを掴み、運び（カーソルに追従する）、
  // チームメイトの上にドロップする — 先発 ⇄ ベンチも含む — と2つのロスター
  // スロットが交換される。タッチでは長押しでバーが持ち上がる（単なるスワイプは
  // これまで通りリストをスクロールする）。
  private beginDrag(team: number, idx: number, ev: PointerEvent): void {
    if (this.carry) return;   // 取り込む DB 選手を配置中 — 行のドラッグは無視
    if (ev.pointerType === "mouse" && ev.button !== 0) return;
    const ox = ev.clientX, oy = ev.clientY;
    let lifted = false;
    let timer = 0;
    let previewIdx = -1;   // 現在 VS ボード上で交代がプレビューされているロスタースロット
    const lift = (x: number, y: number) => {
      lifted = true;
      this.hidePlayerCard();
      this.dragFrom = { team, idx };
      const def = ROSTER[team][idx];
      const color = colorOf(team);
      const g = document.createElement("div");
      Object.assign(g.style, {
        position: "fixed", zIndex: "70", pointerEvents: "none", whiteSpace: "nowrap",
        transform: "translate(-50%,-50%)", padding: "5px 12px", borderRadius: "7px",
        background: "rgba(15,19,28,0.96)", border: `1px solid ${color}`,
        boxShadow: "0 10px 26px rgba(0,0,0,0.6)", fontSize: "12px", fontWeight: "800",
        color: "#fff",
      } as Partial<CSSStyleDeclaration>);
      g.innerHTML = `<span style="color:${color}">${ROSTER[team][idx].role}</span>　${def.name}　<span style="opacity:.6">⇄</span>`;
      document.body.appendChild(g);
      this.dragGhost = g;
      place(x, y);
    };
    const place = (x: number, y: number) => {
      if (!this.dragGhost) return;
      this.dragGhost.style.left = `${x}px`;
      this.dragGhost.style.top = `${y - 18}px`;   // ポインタのすぐ上に乗せる
      // 入れ替え対象になる行を点灯させる
      const t = this.dropTargetAt(x, y);
      const valid = t && t.team === team && t.idx !== idx ? t : null;
      if (this.dragHl && this.dragHl !== valid?.el) {
        this.dragHl.style.border = "1px solid transparent";
        this.dragHl.style.background = "rgba(255,255,255,0.04)";
        this.dragHl = null;
      }
      if (valid && this.dragHl !== valid.el) {
        valid.el.style.border = "1px dashed rgba(150,195,255,0.95)";
        valid.el.style.background = "rgba(90,140,255,0.22)";
        this.dragHl = valid.el;
      }
      // これら2つのスロットを交換したら戦力がどう動くかをプレビュー
      const wantIdx = valid ? valid.idx : -1;
      if (wantIdx !== previewIdx) {
        previewIdx = wantIdx;
        if (previewIdx >= 0) this.showSwapPreview(team, idx, previewIdx);
        else this.clearVsPreview();
      }
    };
    const blockTouch = (te: TouchEvent) => { if (lifted) te.preventDefault(); };
    const move = (e: PointerEvent) => {
      if (!lifted) {
        // 長押しが発火する前に動いた → ドラッグではなくスクロール
        if (Math.hypot(e.clientX - ox, e.clientY - oy) > 8) teardown();
        return;
      }
      place(e.clientX, e.clientY);
    };
    const teardown = () => {
      window.clearTimeout(timer);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", teardown);
      window.removeEventListener("touchmove", blockTouch);
      if (this.dragGhost) { this.dragGhost.remove(); this.dragGhost = null; }
      if (this.dragHl) {
        this.dragHl.style.border = "1px solid transparent";
        this.dragHl.style.background = "rgba(255,255,255,0.04)";
        this.dragHl = null;
      }
      if (previewIdx >= 0) { previewIdx = -1; this.clearVsPreview(); }   // 交代プレビューを取り下げる
      this.dragFrom = null;
    };
    const up = (e: PointerEvent) => {
      const wasLifted = lifted;
      const t = wasLifted ? this.dropTargetAt(e.clientX, e.clientY) : null;
      teardown();
      if (t && t.team === team && t.idx !== idx) {
        const r = ROSTER[team];
        [r[idx], r[t.idx]] = [r[t.idx], r[idx]];
        this.refreshEditors();   // ロスターと VS ボード（先発が変わった）
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", teardown);
    window.addEventListener("touchmove", blockTouch, { passive: false });
    if (ev.pointerType === "mouse") { ev.preventDefault(); lift(ox, oy); }
    else timer = window.setTimeout(() => lift(ox, oy), 280);
  }

  // ポインタの下のロスター行（あれば）。ゴーストはポインタイベントを無視する
  // ため、elementFromPoint はそれを素通しで見る。
  private dropTargetAt(x: number, y: number): { team: number; idx: number; el: HTMLElement } | null {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    const row = el?.closest("[data-drop-team]") as HTMLElement | null;
    if (!row) return null;
    return { team: Number(row.dataset.dropTeam), idx: Number(row.dataset.dropIdx), el: row };
  }

  // 浮遊するロールピッカーのメニュー: ピルを押す → 一覧から評価ロールを選ぶ
  // （現在のものはチームカラーで点灯）。選択時、または外側を押したときに閉じる。
  private openRolePicker(def: PlayerDef, team: number, anchor: HTMLElement,
                         onPick?: () => void, kind: "off" | "def" = "off"): void {
    this.closeRolePicker();
    this.hidePlayerCard();
    this.hideTip();
    const isDef = kind === "def";
    const menu = document.createElement("div");
    Object.assign(menu.style, {
      position: "fixed", zIndex: "88", display: "flex", flexDirection: "column", gap: "4px",
      background: "rgba(12,15,22,0.98)", border: "1px solid rgba(255,255,255,0.25)",
      borderRadius: "10px", padding: "7px", boxShadow: "0 12px 32px rgba(0,0,0,0.6)",
      pointerEvents: "auto",
    } as Partial<CSSStyleDeclaration>);
    const cur = (isDef ? def.defRole : def.evalRole) ?? "自動";
    const roleColour = (nm: string): string =>
      nm === "自動" ? "rgb(150,156,168)"
        : ((isDef ? UI.DEF_GROUP_C[nm] : UI.OFF_GROUP_C[nm]) ?? "rgb(150,156,168)");
    const mkBtn = (nm: string): HTMLDivElement => {
      const cell = document.createElement("div");
      Object.assign(cell.style, { display: "flex", alignItems: "center", gap: "4px" } as Partial<CSSStyleDeclaration>);
      // 各選択肢はロール自身の色で色付けされ、ピッカーが凡例も兼ねる;
      // 選択されたものは塗りつぶしになる
      const acc = roleColour(nm);
      const dot = document.createElement("span");
      Object.assign(dot.style, { width: "9px", height: "9px", borderRadius: "50%", background: acc, flexShrink: "0" } as Partial<CSSStyleDeclaration>);
      const b = document.createElement("button");
      const on = nm === cur;
      b.textContent = nm;
      Object.assign(b.style, {
        flex: "1", fontSize: "11px", fontWeight: on ? "800" : "600", padding: "4px 10px",
        borderRadius: "8px", cursor: "pointer", whiteSpace: "nowrap", textAlign: "left",
        background: on ? acc : "rgba(255,255,255,0.06)",
        color: on ? "#0d1016" : "#dfe4ee",
        border: `1px solid ${on ? acc : "rgba(255,255,255,0.14)"}`,
      } as Partial<CSSStyleDeclaration>);
      b.onclick = () => {
        if (isDef) def.defRole = nm === "自動" ? undefined : nm;
        else def.evalRole = nm === "自動" ? undefined : nm;
        this.closeRolePicker();
        if (onPick) onPick();
        else this.refreshEditors();   // OVR + チームバーを再評価
      };
      // リアルタイム: オフェンスロールをホバーすると、それがチームのバーをどう
      // 動かすかをプレビュー（試合前のロスターのみ; 守備ロールは OVR バーを変えない）
      if (!this.detailModal && !isDef) {
        b.onmouseenter = () => this.previewRole(def, team, nm);
        b.onmouseleave = () => this.clearVsPreview();
      }
      cell.append(dot, b);
      // ⓘ — 押す（またはホバー）と、そのロールの意味 / 何を評価するかが読める
      const tip = nm === "自動"
        ? (isDef ? "能力から自動でディフェンスロールを選びます。" : "ポジション標準の重みで評価します（ロール未設定）。")
        : (isDef ? UI.DEF_ROLES[nm]?.tip : UI.EVAL_ROLES[nm]?.tip);
      if (tip) {
        const ic = document.createElement("span");
        ic.textContent = "ⓘ";
        Object.assign(ic.style, {
          fontSize: "12px", color: "rgba(150,190,255,0.9)", cursor: "help",
          flexShrink: "0", lineHeight: "1",
        } as Partial<CSSStyleDeclaration>);
        ic.onmouseenter = () => this.showTextTip(nm, tip, ic);
        ic.onmouseleave = () => this.hideTip();
        ic.onclick = (e) => { e.stopPropagation(); this.showTextTip(nm, tip, ic); };
        cell.appendChild(ic);
      }
      return cell;
    };
    const header = (label: string): HTMLDivElement => {
      const h = document.createElement("div");
      Object.assign(h.style, { fontSize: "9px", fontWeight: "800", letterSpacing: "2px", opacity: "0.5", margin: "4px 2px 0" });
      h.textContent = label;
      return h;
    };
    const grid = (): HTMLDivElement => {
      const g = document.createElement("div");
      Object.assign(g.style, { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px" } as Partial<CSSStyleDeclaration>);
      return g;
    };
    menu.appendChild(mkBtn("自動"));
    if (isDef) {
      // 守備ロールの一つのフラットなリスト（エフォートのギア + 専門家）
      const dg = grid();
      for (const nm of Object.keys(UI.DEF_ROLES)) dg.appendChild(mkBtn(nm));
      menu.appendChild(header("ディフェンスロール"));
      menu.appendChild(dg);
    } else {
      // このポジションが取れるオフェンスロール（守備専用の名前は除外）...
      const posGrid = grid();
      for (const [nm, r] of Object.entries(UI.EVAL_ROLES)) {
        if (UI.DEF_ONLY.has(nm)) continue;
        if (r.pos && r.pos.includes(def.role)) posGrid.appendChild(mkBtn(nm));
      }
      if (posGrid.childElementCount > 0) {
        menu.appendChild(header(`${def.role} のロール`));
        menu.appendChild(posGrid);
      }
      // ...そして現代のポジション横断的な仕事。全員に開かれている
      const crossGrid = grid();
      for (const [nm, r] of Object.entries(UI.EVAL_ROLES)) {
        if (!r.pos && !UI.DEF_ONLY.has(nm)) crossGrid.appendChild(mkBtn(nm));
      }
      menu.appendChild(header("全ポジション共通"));
      menu.appendChild(crossGrid);
    }
    document.body.appendChild(menu);
    const r = anchor.getBoundingClientRect();
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - mw - 8));
    let top = r.bottom + 6;
    if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 6);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    this.rolePicker = menu;
    const closer = (e: PointerEvent) => {
      if (menu.contains(e.target as Node)) return;
      this.closeRolePicker();
    };
    this.rolePickerCloser = closer;
    window.addEventListener("pointerdown", closer, true);
  }

  private closeRolePicker(): void {
    if (this.rolePicker) { this.rolePicker.remove(); this.rolePicker = null; }
    if (this.rolePickerCloser) {
      window.removeEventListener("pointerdown", this.rolePickerCloser, true);
      this.rolePickerCloser = null;
    }
    this.clearVsPreview();   // ロールホバーのプレビューを取り下げる（有効なものがなければ何もしない）
  }

  // 全能力値モーダル（詳 ボタン）: 25 の能力値それぞれを値バーつきで、ヘックス
  // ダイジェスト、そして特殊能力 — 暗くした背景の上に。
  private openDetailModal(def: PlayerDef, team: number): void {
    this.closeDetailModal();
    this.hidePlayerCard();
    this.closeRolePicker();
    const color = colorOf(team);

    const overlay = document.createElement("div");
    Object.assign(overlay.style, {
      position: "fixed", inset: "0", zIndex: "85", background: "rgba(0,0,0,0.55)",
      display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "auto",
      fontFamily: "Segoe UI, system-ui, sans-serif", color: "#fff",
    } as Partial<CSSStyleDeclaration>);
    overlay.onclick = (e) => { if (e.target === overlay) this.closeDetailModal(); };

    // モバイル: 画面幅に収まる、縦長の単一列レイアウト;
    // デスクトップ: チャートと能力値を左右に並べる
    const phone = window.innerWidth < 640;
    const panel = document.createElement("div");
    Object.assign(panel.style, {
      background: "rgba(12,15,22,0.98)", border: "1px solid rgba(255,255,255,0.22)",
      borderRadius: "14px", padding: phone ? "12px 10px" : "14px 16px",
      boxShadow: "0 16px 48px rgba(0,0,0,0.65)",
      width: phone ? "96vw" : "540px", maxWidth: "96vw", maxHeight: "92vh",
      overflow: "auto", boxSizing: "border-box",
      display: "flex", flexDirection: "column", gap: "10px", textAlign: "left",
    } as Partial<CSSStyleDeclaration>);

    // ヘッダー: 名前は独立した行に（フルで表示 — パネルが収まるよう広がる。
    // パネル/画面を超える場合のみ省略記号）、続いて身長/OVR/ロール
    const head = document.createElement("div");
    Object.assign(head.style, { display: "flex", flexDirection: "column", gap: "4px" } as Partial<CSSStyleDeclaration>);
    const nm = document.createElement("div");
    Object.assign(nm.style, {
      fontSize: "17px", fontWeight: "800", color,
      whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "100%",
    } as Partial<CSSStyleDeclaration>);
    nm.textContent = `${def.role}  ${def.name}`;
    const sub = document.createElement("div");
    Object.assign(sub.style, { display: "flex", alignItems: "baseline", gap: "10px", flexWrap: "wrap" } as Partial<CSSStyleDeclaration>);
    const meta = document.createElement("div");
    Object.assign(meta.style, { fontSize: "12px", opacity: "0.8", whiteSpace: "nowrap" });
    meta.textContent = `${Math.round(def.height * 100)}cm ${def.hand === "L" ? "左" : "右"}利き  OVR ${this.ovrOf(def)}`;
    // 役割 — ここで切り替える（アイコンピルは表示専用）: 試合前ロスターと同じ
    // ピッカーを開き、その後モーダルが新しいロールで再構築される
    const reopen = () => {
      this.refreshEditors();            // 試合前VSボード / ロスターを再評価
      this.openDetailModal(def, team);  // ...そしてこのモーダルが最新の状態で開き直される
    };
    const pill = (label: string, set: boolean): HTMLButtonElement => {
      const b = document.createElement("button");
      b.textContent = label;
      Object.assign(b.style, {
        fontSize: "11px", fontWeight: "700", padding: "3px 12px", borderRadius: "8px",
        cursor: "pointer", whiteSpace: "nowrap",
        background: set ? color : "rgba(255,255,255,0.07)",
        color: set ? "#0d1016" : "#dfe4ee",
        border: set ? `1px solid ${color}` : "1px solid rgba(255,255,255,0.2)",
      } as Partial<CSSStyleDeclaration>);
      return b;
    };
    // オフェンスロール、守備ロール、選択順位 — 全てここで切り替える。
    const roleBtn = pill(`攻: ${def.evalRole ?? "自動"} ▾`, !!def.evalRole);
    roleBtn.onclick = () => this.openRolePicker(def, team, roleBtn, reopen, "off");
    const defBtn = pill(`守: ${def.defRole ?? "自動"} ▾`, !!def.defRole);
    defBtn.onclick = () => this.openRolePicker(def, team, defBtn, reopen, "def");
    // 選択順位は 自動→1→2→…→5→自動 と循環（1 = 最初の選択肢 / 最も高い使用率）
    const rankBtn = pill(`プライマリ: ${def.choiceRank ?? "自動"}`, !!def.choiceRank);
    rankBtn.onclick = () => {
      const next = def.choiceRank === undefined ? 1 : def.choiceRank >= 5 ? undefined : def.choiceRank + 1;
      def.choiceRank = next;
      reopen();
    };
    // 身長・利き腕 の下のレイアウト: [オフェンスロール | プライマリ] を1行、そして
    // その下の行にディフェンスロールを同じ総幅で。
    const roleBox = document.createElement("div");
    Object.assign(roleBox.style, {
      display: "flex", flexDirection: "column", gap: "6px", marginTop: "4px",
      width: "min(360px, 100%)",
    } as Partial<CSSStyleDeclaration>);
    const roleRow = document.createElement("div");
    Object.assign(roleRow.style, { display: "flex", gap: "6px", alignItems: "center" } as Partial<CSSStyleDeclaration>);
    Object.assign(roleBtn.style, { flex: "1.6", boxSizing: "border-box", textAlign: "center" } as Partial<CSSStyleDeclaration>);
    Object.assign(rankBtn.style, { flex: "1", boxSizing: "border-box", textAlign: "center" } as Partial<CSSStyleDeclaration>);
    // プライマリの説明（ⓘ: ホバー / タップで表示）
    const rankTip = "プライマリ＝オフェンスの選択順位（誰にボールを集めて攻撃をけん引させるか）。1が最優先で、数字が大きいほど使用率が下がる。「自動」はチーム内の得点力で自動割当。同じ番号を複数の選手に付けると2人でボールをシェア（co-primary）。";
    rankBtn.title = rankTip;
    const rankInfo = document.createElement("span");
    rankInfo.textContent = "ⓘ";
    Object.assign(rankInfo.style, {
      fontSize: "13px", color: "rgba(150,190,255,0.9)", cursor: "help", flexShrink: "0",
    } as Partial<CSSStyleDeclaration>);
    rankInfo.onmouseenter = () => this.showTextTip("プライマリ", rankTip, rankInfo);
    rankInfo.onmouseleave = () => this.hideTip();
    rankInfo.onclick = (e) => { e.stopPropagation(); this.showTextTip("プライマリ", rankTip, rankInfo); };
    roleRow.append(roleBtn, rankBtn, rankInfo);
    Object.assign(defBtn.style, { width: "100%", boxSizing: "border-box", textAlign: "center" } as Partial<CSSStyleDeclaration>);
    roleBox.append(roleRow, defBtn);
    sub.append(meta);
    head.append(nm, sub, roleBox);

    // 上段: 左に 名前 / ロール / カバー可能ポジション、右にヘックスチャート
    // （モバイルでは縦積み）。能力値グリッドはその下に全幅で。
    const infoCol = document.createElement("div");
    Object.assign(infoCol.style, {
      display: "flex", flexDirection: "column", gap: "6px",
      flex: "1 1 auto", minWidth: "0", alignItems: phone ? "center" : "stretch",
    } as Partial<CSSStyleDeclaration>);
    infoCol.append(head, this.positionChips(def, color));
    const cv = document.createElement("canvas");
    cv.width = 236; cv.height = 196;
    Object.assign(cv.style, { flex: "0 0 auto" } as Partial<CSSStyleDeclaration>);
    this.drawHexChart(cv, this.axesOf(def), color);
    const topRow = document.createElement("div");
    Object.assign(topRow.style, {
      display: "flex", gap: "12px", width: "100%",
      flexDirection: phone ? "column" : "row",
      alignItems: phone ? "center" : "center", justifyContent: "space-between",
    } as Partial<CSSStyleDeclaration>);
    topRow.append(infoCol, cv);
    panel.appendChild(topRow);

    // ステータス: 下に全幅で 25 の能力値すべて
    const grid = document.createElement("div");
    Object.assign(grid.style, {
      display: "grid", gap: "6px 12px", width: "100%",
      gridTemplateColumns: phone ? "repeat(3, minmax(0, 1fr))" : "repeat(5, minmax(0, 1fr))",
    } as Partial<CSSStyleDeclaration>);
    for (const m of ATTR_META) {
      const v = def.attr[m.key];
      const cell = document.createElement("div");
      const lab = document.createElement("div");
      Object.assign(lab.style, { fontSize: "9px", opacity: "0.6", whiteSpace: "nowrap", cursor: "help" });
      lab.textContent = m.name;
      lab.onmouseenter = () => this.showTextTip(m.name, m.tip, lab);
      lab.onmouseleave = () => this.hideTip();
      const line = document.createElement("div");
      Object.assign(line.style, { display: "flex", alignItems: "center", gap: "5px" } as Partial<CSSStyleDeclaration>);
      const num = document.createElement("span");
      Object.assign(num.style, { fontSize: "12px", fontWeight: "800", width: "20px", textAlign: "right" });
      num.textContent = String(v);
      const track = document.createElement("div");
      Object.assign(track.style, { flex: "1", height: "5px", background: "rgba(255,255,255,0.1)", borderRadius: "3px", overflow: "hidden" } as Partial<CSSStyleDeclaration>);
      const fill = document.createElement("div");
      Object.assign(fill.style, { width: `${Math.max(2, Math.min(100, v))}%`, height: "100%", background: color } as Partial<CSSStyleDeclaration>);
      track.appendChild(fill);
      line.append(num, track);
      cell.append(lab, line);
      grid.appendChild(cell);
    }
    panel.appendChild(grid);

    // 特殊能力 チップ（ホバーで説明つき）
    const chips = document.createElement("div");
    Object.assign(chips.style, { display: "flex", flexWrap: "wrap", gap: "4px" } as Partial<CSSStyleDeclaration>);
    const owned = ABILITY_META.filter((m) => def.abilities?.includes(m.key));
    if (owned.length === 0) {
      const none = document.createElement("span");
      Object.assign(none.style, { fontSize: "10px", opacity: "0.45" });
      none.textContent = "特殊能力 なし";
      chips.appendChild(none);
    }
    for (const m of owned) {
      const chip = document.createElement("span");
      Object.assign(chip.style, {
        fontSize: "10px", fontWeight: "800", padding: "2px 8px", borderRadius: "9px",
        background: color, color: "#0d1016", whiteSpace: "nowrap", cursor: "help",
      } as Partial<CSSStyleDeclaration>);
      chip.textContent = m.label;
      chip.onmouseenter = () => this.showTextTip(m.label, m.tip, chip);
      chip.onmouseleave = () => this.hideTip();
      chips.appendChild(chip);
    }
    panel.appendChild(chips);

    const close = this.button("閉じる");
    Object.assign(close.style, { alignSelf: "center", fontSize: "13px", padding: "7px 26px" } as Partial<CSSStyleDeclaration>);
    close.onclick = () => this.closeDetailModal();
    panel.appendChild(close);

    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    this.detailModal = overlay;
  }

  private closeDetailModal(): void {
    if (this.detailModal) { this.detailModal.remove(); this.detailModal = null; }
    this.hideTip();
  }

  // 4000人超の選手データベース全体を OVR 順にソートしたビューを（一度）構築し、
  // ピッカーのキーストローク絞り込みがキャッシュ済みフィールドの単純な配列走査で済むようにする。
  private ensureDbIndex(): { p: DbPlayer; ovr: number; lower: string }[] {
    if (!this.dbIndex) {
      this.dbIndex = PLAYER_DB
        .map((p) => ({ p, ovr: this.ovrOf(makeDefFromDb(p)), lower: p[0].toLowerCase() }))
        .sort((a, b) => b.ovr - a.ovr);
    }
    return this.dbIndex;
  }

  // 選手を交代: チーム名ヘッダーから開く。4000人超のデータベース選手のいずれかを
  // 選ぶ（検索 / ポジションフィルタ / OVR）; 選択するとモーダルが閉じ、選手が
  // カーソルに「運ばれる」 — 彼のチームのロスター行にドロップして選手を入れ替える
  // （startCarry 参照）。
  private openPlayerPicker(team: number): void {
    this.closeRolePicker();
    this.hidePlayerCard();
    this.closePlayerPicker();
    this.cancelCarry();
    const color = colorOf(team);
    const all = this.ensureDbIndex();
    const phone = window.innerWidth < 640;

    const overlay = document.createElement("div");
    Object.assign(overlay.style, {
      position: "fixed", inset: "0", zIndex: "88", background: "rgba(0,0,0,0.6)",
      display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "auto",
      fontFamily: "Segoe UI, system-ui, sans-serif", color: "#fff",
    } as Partial<CSSStyleDeclaration>);
    overlay.onclick = (e) => { if (e.target === overlay) this.closePlayerPicker(); };

    const panel = document.createElement("div");
    Object.assign(panel.style, {
      background: "rgba(12,15,22,0.98)", border: `1px solid ${color}`,
      borderRadius: "14px", padding: phone ? "12px 10px" : "14px 16px",
      boxShadow: "0 16px 48px rgba(0,0,0,0.65)",
      width: phone ? "96vw" : "560px", maxWidth: "96vw", height: "88vh", maxHeight: "88vh",
      boxSizing: "border-box", display: "flex", flexDirection: "column", gap: "9px", textAlign: "left",
    } as Partial<CSSStyleDeclaration>);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    this.playerPicker = overlay;

    // 選択 → モーダルを閉じ、この選手をカーソルに運び始める
    const onPick = (dbp: DbPlayer): void => {
      this.closePlayerPicker();
      this.startCarry(team, dbp);
    };

    // ---- 検索可能な 4000人超のデータベース一覧 ----
    const CAP = 150;
    let posFilter = "ALL";
    {
      const title = document.createElement("div");
      Object.assign(title.style, { fontSize: "15px", fontWeight: "800", color });
      title.textContent = `選手を選ぶ — ${TEAM_NAMES[team]}（DB ${all.length}名）`;

      const search = document.createElement("input");
      search.type = "text";
      search.placeholder = "選手名で検索…";
      Object.assign(search.style, {
        width: "100%", boxSizing: "border-box", padding: "8px 10px", fontSize: "14px",
        borderRadius: "8px", border: "1px solid rgba(255,255,255,0.25)",
        background: "rgba(255,255,255,0.06)", color: "#fff", outline: "none",
      } as Partial<CSSStyleDeclaration>);

      const posBar = document.createElement("div");
      Object.assign(posBar.style, { display: "flex", gap: "6px", flexWrap: "wrap" } as Partial<CSSStyleDeclaration>);
      const note = document.createElement("div");
      Object.assign(note.style, { fontSize: "10px", opacity: "0.6" });
      const list = document.createElement("div");
      Object.assign(list.style, {
        flex: "1 1 auto", overflowY: "auto", display: "flex", flexDirection: "column", gap: "2px",
        border: "1px solid rgba(255,255,255,0.1)", borderRadius: "8px", padding: "4px", minHeight: "0",
      } as Partial<CSSStyleDeclaration>);

      const rowFor = (e: { p: DbPlayer; ovr: number; lower: string }): HTMLDivElement => {
        const r = document.createElement("div");
        Object.assign(r.style, {
          display: "grid", gridTemplateColumns: "34px 1fr 40px 30px 48px", gap: "8px",
          alignItems: "center", padding: "5px 8px", borderRadius: "6px", cursor: "pointer",
          background: "rgba(255,255,255,0.04)",
        } as Partial<CSSStyleDeclaration>);
        const pos = document.createElement("span");
        Object.assign(pos.style, { fontSize: "10px", fontWeight: "800", color, textAlign: "center", border: `1px solid ${color}`, borderRadius: "5px", padding: "1px 0" });
        pos.textContent = e.p[1];
        const nm = document.createElement("span");
        Object.assign(nm.style, { fontSize: "13px", fontWeight: "700", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" });
        nm.textContent = e.p[0];
        const ht = document.createElement("span");
        Object.assign(ht.style, { fontSize: "11px", opacity: "0.6", textAlign: "right" });
        ht.textContent = `${e.p[2]}`;
        const ovr = document.createElement("span");
        Object.assign(ovr.style, { fontSize: "13px", fontWeight: "800", textAlign: "right" });
        ovr.textContent = `${e.ovr}`;
        const pick = this.button("選ぶ");
        Object.assign(pick.style, { fontSize: "11px", fontWeight: "800", padding: "3px 0", background: color, color: "#0d1016", border: `1px solid ${color}` });
        pick.onclick = (ev) => { ev.stopPropagation(); onPick(e.p); };
        r.onclick = () => onPick(e.p);
        r.onmouseenter = () => { r.style.background = "rgba(90,140,255,0.18)"; };
        r.onmouseleave = () => { r.style.background = "rgba(255,255,255,0.04)"; };
        r.append(pos, nm, ht, ovr, pick);
        return r;
      };

      const render = (): void => {
        const q = search.value.trim().toLowerCase();
        const rows: { p: DbPlayer; ovr: number; lower: string }[] = [];
        for (const e of all) {
          if (posFilter !== "ALL" && e.p[1] !== posFilter) continue;
          if (q && !e.lower.includes(q)) continue;
          rows.push(e);
          if (rows.length >= CAP) break;
        }
        note.textContent = rows.length >= CAP
          ? `OVR上位 ${CAP} 件を表示 — さらに名前で絞り込めます`
          : `${rows.length} 件（OVR順）`;
        list.replaceChildren();
        for (const e of rows) list.appendChild(rowFor(e));
        list.scrollTop = 0;
      };

      const posBtns: Record<string, HTMLButtonElement> = {};
      const setFilter = (f: string): void => {
        posFilter = f;
        for (const [k, b] of Object.entries(posBtns)) {
          const on = k === f;
          b.style.background = on ? color : "rgba(20,24,34,0.9)";
          b.style.color = on ? "#0d1016" : "rgba(255,255,255,0.6)";
          b.style.border = on ? `1px solid ${color}` : "1px solid rgba(255,255,255,0.18)";
        }
        render();
      };
      for (const f of ["ALL", "PG", "SG", "SF", "PF", "C"]) {
        const b = this.button(f === "ALL" ? "全" : f);
        Object.assign(b.style, { fontSize: "11px", fontWeight: "800", padding: "4px 12px" } as Partial<CSSStyleDeclaration>);
        b.onclick = () => setFilter(f);
        posBtns[f] = b;
        posBar.appendChild(b);
      }
      search.oninput = () => render();

      const close = this.button("閉じる");
      Object.assign(close.style, { alignSelf: "center", fontSize: "13px", padding: "6px 24px" } as Partial<CSSStyleDeclaration>);
      close.onclick = () => this.closePlayerPicker();

      panel.append(title, search, posBar, note, list, close);
      setFilter(posFilter);   // 一覧を描画
      if (!phone) search.focus();
    }
  }

  private closePlayerPicker(): void {
    if (this.playerPicker) { this.playerPicker.remove(); this.playerPicker = null; }
    this.hideTip();
  }

  // クラブ編成: 172 の実クラブ（マスターリーグのシートから）のいずれかを選び、
  // このチームの13人をそのクラブとして再構築する — スカッドの各バスケット
  // スロットの最良、スカッドに欠けるロールは最も近いポジションでフォールバック
  // （attributes.clubTeam）。チーム名はクラブのものになる; ランダム編成でビルト
  // インの名前が復元される。
  private openClubPicker(team: number): void {
    this.closeRolePicker();
    this.hidePlayerCard();
    this.closePlayerPicker();
    this.closeClubPicker();
    this.cancelCarry();
    const color = colorOf(team);
    const phone = window.innerWidth < 640;

    const overlay = document.createElement("div");
    Object.assign(overlay.style, {
      position: "fixed", inset: "0", zIndex: "88", background: "rgba(0,0,0,0.6)",
      display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "auto",
      fontFamily: "Segoe UI, system-ui, sans-serif", color: "#fff",
    } as Partial<CSSStyleDeclaration>);
    overlay.onclick = (e) => { if (e.target === overlay) this.closeClubPicker(); };

    const panel = document.createElement("div");
    Object.assign(panel.style, {
      background: "rgba(12,15,22,0.98)", border: `1px solid ${color}`,
      borderRadius: "14px", padding: phone ? "12px 10px" : "14px 16px",
      boxShadow: "0 16px 48px rgba(0,0,0,0.65)",
      width: phone ? "96vw" : "480px", maxWidth: "96vw", height: "82vh", maxHeight: "82vh",
      boxSizing: "border-box", display: "flex", flexDirection: "column", gap: "9px", textAlign: "left",
    } as Partial<CSSStyleDeclaration>);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    this.clubPicker = overlay;

    const title = document.createElement("div");
    Object.assign(title.style, { fontSize: "15px", fontWeight: "800", color });
    title.textContent = `クラブで編成 — ${CLUBS.length}クラブ`;

    const search = document.createElement("input");
    search.type = "text";
    search.placeholder = "クラブ名で検索…";
    Object.assign(search.style, {
      width: "100%", boxSizing: "border-box", padding: "8px 10px", fontSize: "14px",
      borderRadius: "8px", border: "1px solid rgba(255,255,255,0.25)",
      background: "rgba(255,255,255,0.06)", color: "#fff", outline: "none",
    } as Partial<CSSStyleDeclaration>);

    const list = document.createElement("div");
    Object.assign(list.style, {
      flex: "1 1 auto", overflowY: "auto", display: "flex", flexDirection: "column", gap: "2px",
      border: "1px solid rgba(255,255,255,0.1)", borderRadius: "8px", padding: "4px", minHeight: "0",
    } as Partial<CSSStyleDeclaration>);

    const pickClub = (idx: number): void => {
      this.closeClubPicker();
      this.assignClub(team, idx);   // ロスター + 名前 + ユニフォーム + 自動ラインナップ/ロール
      this.refreshEditors();
    };

    const render = (): void => {
      const q = search.value.trim().toLowerCase();
      list.replaceChildren();
      let lastLeague = "";
      CLUBS.forEach(([name, league, members], idx) => {
        if (q && !name.toLowerCase().includes(q) && !league.toLowerCase().includes(q)) return;
        if (league !== lastLeague) {
          lastLeague = league;
          const hd = document.createElement("div");
          hd.textContent = league;
          Object.assign(hd.style, {
            fontSize: "10px", fontWeight: "800", letterSpacing: "2px", color,
            opacity: "0.8", padding: "6px 4px 2px",
          } as Partial<CSSStyleDeclaration>);
          list.appendChild(hd);
        }
        const r = document.createElement("div");
        Object.assign(r.style, {
          display: "grid", gridTemplateColumns: "38px 1fr 44px 48px", gap: "8px",
          alignItems: "center", padding: "6px 8px", borderRadius: "6px", cursor: "pointer",
          background: "rgba(255,255,255,0.04)",
        } as Partial<CSSStyleDeclaration>);
        const code = document.createElement("span");
        Object.assign(code.style, {
          fontSize: "11px", fontWeight: "800", letterSpacing: "0.5px", textAlign: "center",
          color, background: "rgba(255,255,255,0.08)", borderRadius: "4px", padding: "2px 0",
        } as Partial<CSSStyleDeclaration>);
        code.textContent = CLUB_ABBR[name] ?? "";
        const nm = document.createElement("span");
        Object.assign(nm.style, { fontSize: "13px", fontWeight: "700", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" });
        nm.textContent = name;
        const n = document.createElement("span");
        Object.assign(n.style, { fontSize: "11px", opacity: "0.6", textAlign: "right" });
        n.textContent = `${members.length}人`;
        const pick = this.button("選ぶ");
        Object.assign(pick.style, { fontSize: "11px", fontWeight: "800", padding: "3px 0", background: color, color: "#0d1016", border: `1px solid ${color}` });
        pick.onclick = (ev) => { ev.stopPropagation(); pickClub(idx); };
        r.onclick = () => pickClub(idx);
        r.onmouseenter = () => { r.style.background = "rgba(90,140,255,0.18)"; };
        r.onmouseleave = () => { r.style.background = "rgba(255,255,255,0.04)"; };
        r.append(code, nm, n, pick);
        list.appendChild(r);
      });
    };
    search.oninput = render;
    render();

    const close = this.button("閉じる");
    Object.assign(close.style, { fontSize: "12px", padding: "6px 0" });
    close.onclick = () => this.closeClubPicker();
    panel.append(title, search, list, close);
    search.focus();
  }

  private closeClubPicker(): void {
    if (this.clubPicker) { this.clubPicker.remove(); this.clubPicker = null; }
  }

  // ピッカーが閉じた後、取り込む DB 選手をカーソルに運ぶ。彼のチームのロスター
  // 行での単なる pointerdown で彼をそこにドロップ（その選手を置き換える）;
  // それ以外の場所での pointerdown、または Esc でキャンセル。ボタンは押しっぱなし
  // にしない — ピッカーのクリックは既に終わっているので、これはクリックで配置する操作。
  private startCarry(team: number, dbp: DbPlayer): void {
    this.cancelCarry();
    this.carry = { team, dbp };
    const color = colorOf(team);

    // 固定幅のピル（flex）: ポジションチップ + 省略記号でクリップする可変幅の
    // 名前セル + 入れ替えの記号 — 名前が短くても長くてもラベルは同じ幅になる。
    const g = document.createElement("div");
    Object.assign(g.style, {
      position: "fixed", zIndex: "92", pointerEvents: "none",
      transform: "translate(-50%,-50%)", padding: "5px 12px", borderRadius: "7px", boxSizing: "border-box",
      width: "190px", display: "flex", alignItems: "center", gap: "6px",
      background: "rgba(15,19,28,0.96)", border: `1px solid ${color}`,
      boxShadow: "0 10px 26px rgba(0,0,0,0.6)", fontSize: "12px", fontWeight: "800", color: "#fff",
      left: "-999px", top: "-999px",
    } as Partial<CSSStyleDeclaration>);
    const gPos = document.createElement("span");
    Object.assign(gPos.style, { color, flexShrink: "0" } as Partial<CSSStyleDeclaration>);
    gPos.textContent = dbp[1];
    const gName = document.createElement("span");
    Object.assign(gName.style, { flex: "1 1 auto", minWidth: "0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } as Partial<CSSStyleDeclaration>);
    gName.textContent = dbp[0];
    const gArrow = document.createElement("span");
    Object.assign(gArrow.style, { opacity: "0.6", flexShrink: "0" } as Partial<CSSStyleDeclaration>);
    gArrow.textContent = "⇄";
    g.append(gPos, gName, gArrow);
    document.body.appendChild(g);
    this.carryGhost = g;

    const hint = document.createElement("div");
    Object.assign(hint.style, {
      position: "fixed", zIndex: "92", left: "50%", top: "12px", transform: "translateX(-50%)",
      background: "rgba(90,140,255,0.96)", color: "#0d1016", fontWeight: "800", fontSize: "12px",
      padding: "6px 14px", borderRadius: "8px", pointerEvents: "none", boxShadow: "0 6px 20px rgba(0,0,0,0.5)",
      whiteSpace: "nowrap", maxWidth: "94vw", overflow: "hidden", textOverflow: "ellipsis",
    } as Partial<CSSStyleDeclaration>);
    hint.textContent = `「${dbp[0]}」を交代させる選手の上でクリック（Escで取消）`;
    document.body.appendChild(hint);
    this.carryHint = hint;

    let previewIdx = -1;   // 現在 VS ボード上でプレビュー中のロスタースロット（-1 = なし）
    const clearHl = () => {
      if (this.carryHl) {
        this.carryHl.style.border = "1px solid transparent";
        this.carryHl.style.background = "rgba(255,255,255,0.04)";
        this.carryHl = null;
      }
    };
    const setHl = (el: HTMLElement) => {
      if (this.carryHl === el) return;
      clearHl();
      el.style.border = "1px dashed rgba(150,195,255,0.95)";
      el.style.background = "rgba(90,140,255,0.22)";
      this.carryHl = el;
    };
    // 指定したスロットにドロップしたらチーム戦力がどう変わるかをプレビュー
    const preview = (idx: number): void => {
      if (idx === previewIdx) return;
      previewIdx = idx;
      if (previewIdx >= 0) this.showVsPreview(team, previewIdx, dbp);
      else this.clearVsPreview();
    };
    const onMove = (e: PointerEvent) => {
      g.style.left = `${e.clientX}px`;
      g.style.top = `${e.clientY - 18}px`;
      const t = this.dropTargetAt(e.clientX, e.clientY);
      const valid = t && t.team === team ? t : null;
      if (valid) setHl(valid.el); else clearHl();
      preview(valid ? valid.idx : -1);
    };
    const commit = (idx: number): void => {
      const nd = ROSTER[team][idx];
      applyDbPlayer(nd, dbp);
      // 交代で入ってくる選手は妥当なデフォルトロール付きで到着する（ユーザーが
      // ぶつかった「ロールの設定を忘れる」隙間を防ぐ）— オフェンスは軸で、守備は
      // 能力値で; 選択順位は自動に戻す。
      nd.evalRole = this.bestOffRole(nd);
      // 彼の守備ロールは、彼に合いつつ彼のユニットの隙間を埋めるように選ぶ
      // （チームメイトのロールはそのまま — そこで既に取られているものに対して散らす）
      const unit = idx < STARTERS ? ROSTER[team].slice(0, STARTERS) : ROSTER[team].slice(STARTERS);
      const takenDef = new Map<string, number>();
      for (const d of unit) if (d !== nd && d.defRole) takenDef.set(d.defRole, (takenDef.get(d.defRole) ?? 0) + 1);
      nd.defRole = this.pickDefRole(nd, takenDef);
      this.assignRankFor(nd, team, idx);   // 能力によるプライマリ（チームメイトは手を付けない）
      this.cancelCarry();
      this.refreshEditors();
    };
    const onDown = (e: PointerEvent) => {
      const t = this.dropTargetAt(e.clientX, e.clientY);
      if (t && t.team === team) {
        e.preventDefault();
        e.stopPropagation();   // 行自身の長押しドラッグに先んじる
        // タッチにはホバーがないため、戦力プレビューが表示される機会がなかった。
        // スロットへの最初のタップは変化をプレビューする（ハイライト + VS ボード上
        // の ±N）; 同じスロットへの2度目のタップで確定する。別のスロットへの
        // タップはプレビューを移動するだけ。マウスは依然として最初のクリックで
        // 確定する（ホバーで既に変化をプレビュー済み）。
        if (e.pointerType !== "mouse" && previewIdx !== t.idx) {
          setHl(t.el);
          preview(t.idx);
          hint.textContent = "もう一度タップで確定（Escで取消）";
          return;
        }
        commit(t.idx);
      } else {
        this.cancelCarry();    // 彼のロスター行のいずれからも外れてドロップ → キャンセル
      }
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") this.cancelCarry(); };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerdown", onDown, true);   // キャプチャ: 行のハンドラより前に実行
    window.addEventListener("keydown", onKey);
    this.carryCleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
      clearHl();
      if (previewIdx >= 0) { previewIdx = -1; this.clearVsPreview(); }   // 戦力プレビューを取り下げる
    };
  }

  private cancelCarry(): void {
    if (this.carryCleanup) { this.carryCleanup(); this.carryCleanup = null; }
    if (this.carryGhost) { this.carryGhost.remove(); this.carryGhost = null; }
    if (this.carryHint) { this.carryHint.remove(); this.carryHint = null; }
    this.carry = null;
  }

  // ホバー詳細カード: 6ダイジェストのヘックスチャート + 特殊能力チップ。
  private showPlayerCard(def: PlayerDef, team: number, anchor: HTMLElement): void {
    const color = colorOf(team);
    const card = this.playerCard;
    card.replaceChildren();

    // 名前は独立した行に（フルネーム; カードを超える場合のみ省略記号）、その下に
    // メタ情報 — 長い名前が数文字に押し潰されないようにする
    const head = document.createElement("div");
    Object.assign(head.style, { display: "flex", flexDirection: "column", gap: "1px", marginBottom: "2px" } as Partial<CSSStyleDeclaration>);
    const nm = document.createElement("div");
    Object.assign(nm.style, { fontSize: "14px", fontWeight: "800", color, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "100%" });
    nm.textContent = `${def.role}  ${def.name}`;
    const meta = document.createElement("div");
    Object.assign(meta.style, { fontSize: "11px", opacity: "0.75", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" });
    meta.textContent = `${Math.round(def.height * 100)}cm ${def.hand === "L" ? "左" : "右"}利き  OVR ${this.ovrOf(def)}`
      + (def.evalRole ? `  [${def.evalRole}]` : "");
    head.append(nm, meta);
    card.appendChild(head);

    // カバー可能ポジション: 5つのチップのうち彼の分が点灯
    const chipsRow = this.positionChips(def, color);
    chipsRow.style.margin = "1px 0 3px";
    card.appendChild(chipsRow);

    const cv = document.createElement("canvas");
    cv.width = 236; cv.height = 196;
    Object.assign(cv.style, { display: "block", margin: "0 auto" } as Partial<CSSStyleDeclaration>);
    this.drawHexChart(cv, this.axesOf(def), color);
    card.appendChild(cv);

    const chips = document.createElement("div");
    Object.assign(chips.style, { display: "flex", flexWrap: "wrap", gap: "4px", marginTop: "4px", justifyContent: "center" } as Partial<CSSStyleDeclaration>);
    const owned = ABILITY_META.filter((m) => def.abilities?.includes(m.key));
    if (owned.length === 0) {
      const none = document.createElement("span");
      Object.assign(none.style, { fontSize: "10px", opacity: "0.45" });
      none.textContent = "特殊能力 なし";
      chips.appendChild(none);
    }
    for (const m of owned) {
      const chip = document.createElement("span");
      Object.assign(chip.style, {
        fontSize: "10px", fontWeight: "800", padding: "2px 8px", borderRadius: "9px",
        background: color, color: "#0d1016", whiteSpace: "nowrap",
      } as Partial<CSSStyleDeclaration>);
      chip.textContent = m.label;
      chips.appendChild(chip);
    }
    card.appendChild(chips);

    // ホバーした行の上に浮かせる（その下端が名前のすぐ上）ので、行自体 — 名前、
    // ロールピル、詳 — は決して覆われずクリック可能なまま。上に余地がなければ
    // 代わりに行の下に反転する。
    card.style.display = "block";
    const r = anchor.getBoundingClientRect();
    const cw = 260;
    const ch = card.offsetHeight || 320;
    let left = r.left + r.width / 2 - cw / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - cw - 8));
    // デフォルト: 行の上に浮かせる。画面の上端からはみ出す場合、またはロスターの
    // 上の VS（チーム戦力）ボードと重なる場合は下に反転する。
    let top = r.top - ch - 8;
    const vbBottom = this.vsBoard ? this.vsBoard.getBoundingClientRect().bottom : 0;
    if (top < 8 || top < vbBottom) top = Math.min(window.innerHeight - ch - 8, r.bottom + 8);
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
  }

  private hidePlayerCard(): void {
    this.playerCard.style.display = "none";
  }

  // ヘックス（レーダー）チャート: 控えめなグリッドのリング + スポーク、チーム
  // カラーの1つのデータ多角形、軸ラベルと正確な値をプレーンなインクで。
  private drawHexChart(cv: HTMLCanvasElement, axes: number[], color: string): void {
    const ctx = cv.getContext("2d")!;
    const cx = cv.width / 2, cy = cv.height / 2 + 2, R = 60;
    const pt = (i: number, r: number): [number, number] => {
      const a = -Math.PI / 2 + (i * Math.PI) / 3;
      return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
    };
    ctx.clearRect(0, 0, cv.width, cv.height);
    // グリッド: 3つのリング + スポーク。データが先に読めるよう薄めに保つ
    ctx.strokeStyle = "rgba(255,255,255,0.13)";
    ctx.lineWidth = 1;
    for (const f of [1 / 3, 2 / 3, 1]) {
      ctx.beginPath();
      for (let i = 0; i <= 6; i++) {
        const [x, y] = pt(i % 6, R * f);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    for (let i = 0; i < 6; i++) {
      const [x, y] = pt(i, R);
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(x, y); ctx.stroke();
    }
    // データ多角形 — DB の能力値は圧縮された約 40..99 の帯域にあるため、その
    // 帯域を半径いっぱいに広げる（正確な値は下に表示される）
    const rOf = (v: number) => R * Math.max(0.06, Math.min(1, (v - 30) / 69));
    ctx.beginPath();
    for (let i = 0; i <= 6; i++) {
      const [x, y] = pt(i % 6, rOf(axes[i % 6]));
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fillStyle = color.replace("rgb(", "rgba(").replace(")", ",0.30)");
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();
    // ラベル + 値はインクで。決してシリーズの色にはしない
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (let i = 0; i < 6; i++) {
      const [lx, ly] = pt(i, R + 19);
      ctx.fillStyle = "rgba(255,255,255,0.72)";
      ctx.font = "700 10px sans-serif";
      ctx.fillText(UI.HEX_AXES[i].label, lx, ly - 6);
      ctx.fillStyle = "#fff";
      ctx.font = "800 11px sans-serif";
      ctx.fillText(String(Math.round(axes[i % 6])), lx, ly + 6);
    }
  }

  private buildResult(): void {
    const p = this.panel();

    const title = document.createElement("div");
    Object.assign(title.style, { fontSize: "20px", fontWeight: "700", letterSpacing: "3px", opacity: "0.8" });
    title.textContent = "FINAL";

    this.resultScore = document.createElement("div");
    // フォントはビューポート幅に合わせて拡縮し、2つのクラブ略称 + スコアが
    // モバイル幅では1行に収まり（≈17px）、デスクトップでは大きいまま（32px 上限）。
    Object.assign(this.resultScore.style, {
      fontSize: "clamp(15px, 5.4vw, 32px)", fontWeight: "800", whiteSpace: "nowrap",
    } as Partial<CSSStyleDeclaration>);

    this.resultWinner = document.createElement("div");
    Object.assign(this.resultWinner.style, {
      fontSize: "clamp(14px, 3.7vw, 20px)", fontWeight: "800", letterSpacing: "1px", whiteSpace: "nowrap",
    } as Partial<CSSStyleDeclaration>);

    this.resultStats = document.createElement("div");
    // 固定幅 = 完全なボックススコア表（名前 128 + 10 列 + gap ≈ 544）。小さい画面
    // では頭打ち; こうしてモーダルは3つのタブすべてで1つのサイズを保ち、狭い
    // チーム比較表示で縮まない。
    Object.assign(this.resultStats.style, {
      display: "flex", flexDirection: "column", gap: "12px", width: "min(560px, 90vw)",
    } as Partial<CSSStyleDeclaration>);

    const btnRow = document.createElement("div");
    // gap/フォント/padding はビューポートに合わせて縮み、3つのボタンすべてが
    // モバイル幅（≈375px）で2行に折り返さず1行に収まる。
    Object.assign(btnRow.style, {
      display: "flex", gap: "clamp(6px, 2vw, 10px)", flexWrap: "nowrap",
      justifyContent: "center", marginTop: "4px",
    } as Partial<CSSStyleDeclaration>);
    const btnFont = "clamp(12px, 3.4vw, 15px)";

    // BACK → 一番最初の画面（タイトル: クラブ対戦 / ランダム対戦）
    const back = this.button("← BACK");
    Object.assign(back.style, { fontSize: btnFont, padding: "9px clamp(11px, 4vw, 20px)", whiteSpace: "nowrap" } as Partial<CSSStyleDeclaration>);
    back.onclick = () => { this.onBack(); this.setPhase("title"); };

    // もう一試合 → 同じマッチアップを再戦（ロスター/クラブを保持）— エディタへ戻る
    const rematch = this.button("もう一試合");
    Object.assign(rematch.style, {
      fontSize: btnFont, fontWeight: "800", padding: "9px clamp(12px, 4.2vw, 22px)", whiteSpace: "nowrap",
      background: "rgba(232,235,242,0.96)", color: "#10131a", border: "1px solid rgba(255,255,255,0.5)",
    } as Partial<CSSStyleDeclaration>);
    rematch.onclick = () => { this.onBack(); this.refreshEditors(); this.setPhase("pregame"); };

    // チーム選択 → クラブチーム選択ウィザードへ飛ぶ
    const pickTeams = this.button("チーム選択");
    Object.assign(pickTeams.style, { fontSize: btnFont, padding: "9px clamp(11px, 4vw, 20px)", whiteSpace: "nowrap" } as Partial<CSSStyleDeclaration>);
    pickTeams.onclick = () => { this.onBack(); this.setPhase("title"); this.startClubMatchup(); };

    btnRow.append(back, rematch, pickTeams);
    p.append(title, this.resultScore, this.resultWinner, this.resultStats, btnRow);
    this.root.appendChild(p);
    this.resultPanel = p;
  }

  private setPhase(phase: Phase): void {
    this.phase = phase;
    this.hud.style.display = phase === "playing" ? "block" : "none";
    this.titlePanel.style.display = phase === "title" ? "flex" : "none";
    this.pregamePanel.style.display = phase === "pregame" ? "flex" : "none";
    this.resultPanel.style.display = phase === "result" ? "flex" : "none";
    if (phase !== "title") this.closeChooser();
    if (phase === "playing") this.refreshBoardNames();
  }

  // スコアボードは一度だけ構築される（どのクラブも選ばれる前に）ため、そのチーム
  // ラベルは試合が実際に始まる / クラブが変わるたびに読み直す必要がある:
  // 選択されたクラブは3文字コードを、ランダムロスターは BLAZE / WAVE を表示する。
  private refreshBoardNames(): void {
    if (this.nameA) this.nameA.textContent = teamAbbr(0);
    if (this.nameB) this.nameB.textContent = teamAbbr(1);
  }

  private showResult(game: Game): void {
    const [a, b] = game.score;
    this.resultScore.textContent = `${teamShort(0)}  ${a} - ${b}  ${teamShort(1)}`;
    if (a === b) {
      this.resultWinner.textContent = "DRAW";
      this.resultWinner.style.color = "#fff";
    } else {
      const w = a > b ? 0 : 1;
      this.resultWinner.textContent = `${teamShort(w)} WINS`;
      this.resultWinner.style.color = colorOf(w);
    }

    // タブ表示: チームスタッツ / 青チーム / 赤チーム
    this.resultGame = game;
    this.resultTab = "team";                 // デフォルトはチーム比較
    this.resultStats.replaceChildren();
    this.resultStats.appendChild(this.resultTabBar());
    this.resultContent = document.createElement("div");
    // 13人のボックススコアが余裕で収まる min-height。こうして短いチーム比較タブに
    // 切り替えてもモーダルの高さが動かない
    Object.assign(this.resultContent.style, { width: "100%", minHeight: "clamp(230px, 44vh, 360px)" } as Partial<CSSStyleDeclaration>);
    this.resultStats.appendChild(this.resultContent);
    this.renderResultTab();
    this.setPhase("result");
  }

  // 3つのリザルトタブ。青 = team 1（WAVE）、赤 = team 0（BLAZE）; 各タブはその
  // チームカラーで色付けされ、青 / 赤チームとして読める。
  private resultTabBar(): HTMLDivElement {
    const bar = document.createElement("div");
    Object.assign(bar.style, {
      display: "flex", gap: "6px", justifyContent: "center", flexWrap: "wrap", marginBottom: "6px",
    } as Partial<CSSStyleDeclaration>);
    // 3文字の英語ラベルにして、3つのタブが常に1行に収まるようにする（長いクラブ
    // 名は2行に折り返していた）。TOT = チーム合計/比較; チームタブは各側の3文字
    // コードを使う（ARS, BAL, … / BLAZE→ランダムは短い名前を保つ）。
    const tabs: { key: "team" | "blue" | "red"; label: string }[] = [
      { key: "team", label: "TOT" },          // 両チーム比較(チームスタッツ)
      { key: "blue", label: teamAbbr(1) },    // 青チーム
      { key: "red", label: teamAbbr(0) },     // 赤チーム
    ];
    this.resultTabBtns = [];
    for (const t of tabs) {
      const b = this.button(t.label);
      if (t.key === "blue") b.style.color = colorOf(1);
      else if (t.key === "red") b.style.color = colorOf(0);
      b.onclick = () => { this.resultTab = t.key; this.renderResultTab(); };
      this.resultTabBtns.push({ key: t.key, el: b });
      bar.appendChild(b);
    }
    return bar;
  }

  private renderResultTab(): void {
    if (!this.resultGame || !this.resultContent) return;
    for (const { key, el } of this.resultTabBtns) {
      const active = key === this.resultTab;
      el.style.background = active ? "rgba(255,255,255,0.16)" : "rgba(20,24,34,0.9)";
      el.style.borderColor = active ? "rgba(255,255,255,0.55)" : "rgba(255,255,255,0.18)";
      el.style.opacity = active ? "1" : "0.65";
    }
    this.resultContent.replaceChildren();
    if (this.resultTab === "team") this.resultContent.appendChild(this.teamCompare(this.resultGame));
    else if (this.resultTab === "blue") this.resultContent.appendChild(this.statsTable(this.resultGame, 1));
    else this.resultContent.appendChild(this.statsTable(this.resultGame, 0));
  }

  // ボックススコアの列。FG / 3P / FT は 成功 ● / 試投 ● を表示（「3/8」）。
  private static readonly BOX_COLS: { label: string; w: number; get: (s: import("./player").Stats) => string }[] = [
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
  private static readonly NAME_W = 128;

  private statsTable(game: Game, team: number): HTMLDivElement {
    const wrap = document.createElement("div");
    Object.assign(wrap.style, { width: "100%" });

    const head = document.createElement("div");
    Object.assign(head.style, { fontSize: "14px", fontWeight: "800", color: colorOf(team), textAlign: "left", margin: "2px 0" });
    head.textContent = teamShort(team);
    wrap.appendChild(head);

    const scroller = document.createElement("div");
    Object.assign(scroller.style, { width: "100%", overflowX: "auto", paddingBottom: "4px" } as Partial<CSSStyleDeclaration>);
    const table = document.createElement("div");
    Object.assign(table.style, { width: "max-content" } as Partial<CSSStyleDeclaration>);

    const cols = document.createElement("div");
    Object.assign(cols.style, { display: "flex", gap: "4px", fontSize: "10px", opacity: "0.6", margin: "1px 0" });
    const hc = this.stickyCell("", UI.NAME_W); hc.style.opacity = "0.6";
    cols.appendChild(hc);
    for (const c of UI.BOX_COLS) cols.appendChild(this.cell(c.label, c.w, "center"));
    table.appendChild(cols);

    for (const pl of game.allPlayers(team)) {
      const row = document.createElement("div");
      Object.assign(row.style, { display: "flex", gap: "4px", fontSize: "12px", margin: "1px 0" });
      const nm = this.stickyCell(`${pl.role} ${pl.name}`, UI.NAME_W);
      nm.style.opacity = pl.idx < STARTERS ? "0.95" : "0.7"; // ベンチは少し暗く
      row.appendChild(nm);
      for (const c of UI.BOX_COLS) row.appendChild(this.cell(c.get(pl.stats), c.w, "center"));
      table.appendChild(row);
    }
    scroller.appendChild(table);
    wrap.appendChild(scroller);
    return wrap;
  }

  // チーム対チームの比較: 合計を左右に並べる（team0 が左、team1 が右、その間に
  // スタッツ名）ので、2つのスカッドが互いに対比して読める。
  private teamCompare(game: Game): HTMLDivElement {
    type S = import("./player").Stats;
    const total = (t: number): S => {
      const a = { pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, tov: 0, fgm: 0, fga: 0, tpm: 0, tpa: 0, ftm: 0, fta: 0, min: 0 };
      for (const pl of game.allPlayers(t)) for (const k in a) (a as any)[k] += (pl.stats as any)[k];
      return a;
    };
    const t0 = total(0), t1 = total(1);
    const pct = (m: number, at: number) => at ? ` (${Math.round(100 * m / at)}%)` : "";
    const rows: { label: string; a: string; b: string }[] = [
      { label: "PTS", a: `${t0.pts}`, b: `${t1.pts}` },
      { label: "FG", a: `${t0.fgm}/${t0.fga}${pct(t0.fgm, t0.fga)}`, b: `${t1.fgm}/${t1.fga}${pct(t1.fgm, t1.fga)}` },
      { label: "3P", a: `${t0.tpm}/${t0.tpa}${pct(t0.tpm, t0.tpa)}`, b: `${t1.tpm}/${t1.tpa}${pct(t1.tpm, t1.tpa)}` },
      { label: "FT", a: `${t0.ftm}/${t0.fta}${pct(t0.ftm, t0.fta)}`, b: `${t1.ftm}/${t1.fta}${pct(t1.ftm, t1.fta)}` },
      { label: "REB", a: `${t0.reb}`, b: `${t1.reb}` },
      { label: "AST", a: `${t0.ast}`, b: `${t1.ast}` },
      { label: "STL", a: `${t0.stl}`, b: `${t1.stl}` },
      { label: "BLK", a: `${t0.blk}`, b: `${t1.blk}` },
      { label: "TO", a: `${t0.tov}`, b: `${t1.tov}` },
    ];

    const wrap = document.createElement("div");
    Object.assign(wrap.style, {
      width: "100%", background: "rgba(255,255,255,0.04)", borderRadius: "8px",
      padding: "6px 8px", boxSizing: "border-box",
    } as Partial<CSSStyleDeclaration>);
    const title = document.createElement("div");
    Object.assign(title.style, { display: "flex", justifyContent: "space-between", fontSize: "13px", fontWeight: "800", marginBottom: "3px" });
    const n0 = document.createElement("span"); n0.textContent = teamShort(0); n0.style.color = colorOf(0);
    const n1 = document.createElement("span"); n1.textContent = teamShort(1); n1.style.color = colorOf(1);
    title.append(n0, n1);
    wrap.appendChild(title);

    // クォーターごとのラインスコア: 名前 | Q1 Q2 … | T
    const nq = Math.max(game.qLine[0].length, game.qLine[1].length);
    if (nq > 0) {
      const ls = document.createElement("div");
      Object.assign(ls.style, {
        display: "grid", gridTemplateColumns: `minmax(48px,1.4fr) repeat(${nq}, 1fr) 1fr`,
        gap: "1px 6px", fontSize: "11px", alignItems: "center",
        margin: "2px 0 7px", paddingBottom: "5px", borderBottom: "1px solid rgba(255,255,255,0.12)",
      } as Partial<CSSStyleDeclaration>);
      const lsCell = (txt: string, o: { color?: string; bold?: boolean; align?: string; dim?: boolean }): HTMLSpanElement => {
        const s = document.createElement("span");
        Object.assign(s.style, {
          textAlign: o.align ?? "center", color: o.color ?? "#fff",
          fontWeight: o.bold ? "800" : "600", opacity: o.dim ? "0.55" : "1", fontSize: o.dim ? "10px" : "11px",
        } as Partial<CSSStyleDeclaration>);
        s.textContent = txt;
        return s;
      };
      // ヘッダー行: (空白) Q1 Q2 … T
      ls.appendChild(lsCell("", { dim: true, align: "left" }));
      for (let i = 0; i < nq; i++) ls.appendChild(lsCell(`Q${i + 1}`, { dim: true }));
      ls.appendChild(lsCell("T", { dim: true, bold: true }));
      // チームごとに1行
      for (let t = 0; t < 2; t++) {
        ls.appendChild(lsCell(teamShort(t), { color: colorOf(t), bold: true, align: "left" }));
        for (let i = 0; i < nq; i++) ls.appendChild(lsCell(String(game.qLine[t][i] ?? "-"), { color: colorOf(t) }));
        ls.appendChild(lsCell(String(game.score[t]), { color: colorOf(t), bold: true }));
      }
      wrap.appendChild(ls);
    }

    for (const r of rows) {
      const row = document.createElement("div");
      Object.assign(row.style, { display: "flex", alignItems: "center", fontSize: "12px", margin: "1px 0" });
      const a = document.createElement("span");
      Object.assign(a.style, { flex: "1", textAlign: "right", color: colorOf(0), fontWeight: "700" });
      a.textContent = r.a;
      const lab = document.createElement("span");
      Object.assign(lab.style, { width: "44px", textAlign: "center", opacity: "0.6", fontSize: "10px" });
      lab.textContent = r.label;
      const b = document.createElement("span");
      Object.assign(b.style, { flex: "1", textAlign: "left", color: colorOf(1), fontWeight: "700" });
      b.textContent = r.b;
      row.append(a, lab, b);
      wrap.appendChild(row);
    }
    return wrap;
  }

  // ---- 小さなビルダー ----------------------------------------------------

  private cell(text: string, width: number, align: string = "left"): HTMLSpanElement {
    const el = document.createElement("span");
    Object.assign(el.style, {
      width: `${width}px`, flexShrink: "0", textAlign: align, display: "inline-block",
      // 各セルを1行に保つ; 長すぎる名前は省略記号でクリップされる
      whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
    } as Partial<CSSStyleDeclaration>);
    el.textContent = text;
    return el;
  }

  // 左に固定されたセル: スタッツ列が横スクロールしても固定されたままなので、
  // 常に誰の行か分かる。スクロールした数字が透けないよう不透明な背景に、
  // 固定列と分かるよう髪の毛ほどの縁を付ける。
  private stickyCell(text: string, width: number): HTMLSpanElement {
    const el = this.cell(text, width);
    Object.assign(el.style, {
      position: "sticky", left: "0", zIndex: "1", background: "#0c0f16",
      boxShadow: "1px 0 0 rgba(255,255,255,0.12)",
    } as Partial<CSSStyleDeclaration>);
    return el;
  }

  private teamBlock(name: string, color: string, align: string): HTMLElement {
    const el = document.createElement("div");
    Object.assign(el.style, {
      fontSize: "18px", fontWeight: "700", color, minWidth: "70px", textAlign: align,
    } as Partial<CSSStyleDeclaration>);
    el.textContent = name;
    return el;
  }

  private scoreEl(color: string): HTMLSpanElement {
    const el = document.createElement("span");
    Object.assign(el.style, {
      fontSize: "34px", fontWeight: "800", color, minWidth: "48px", textAlign: "center",
    } as Partial<CSSStyleDeclaration>);
    return el;
  }

  private button(label: string): HTMLButtonElement {
    const b = document.createElement("button");
    b.textContent = label;
    Object.assign(b.style, {
      background: "rgba(20,24,34,0.9)", color: "#fff", border: "1px solid rgba(255,255,255,0.18)",
      borderRadius: "8px", padding: "6px 14px", fontSize: "13px", fontWeight: "700", cursor: "pointer",
    } as Partial<CSSStyleDeclaration>);
    return b;
  }

  private refreshSpeed(): void {
    this.speedBtns.forEach((b, i) => {
      const active = [1, 2, 4][i] === this.speed;
      b.style.background = active ? "rgba(70,120,220,0.95)" : "rgba(20,24,34,0.9)";
    });
  }

  // 中央寄せのスコアボードが届かない限り ☰ を上端（スコアボードと揃える）に
  // 保つ; その右端が衝突するようになったときだけボードの下に落とす。構築時と
  // リサイズのたびに再計算する。
  private positionMenu(): void {
    if (!this.menuBtn || !this.board) return;
    const boardW = this.board.getBoundingClientRect().width || 320;
    const boardRight = window.innerWidth / 2 + boardW / 2;
    const btnW = this.menuBtn.getBoundingClientRect().width || 44;
    const btnLeft = window.innerWidth - 14 - btnW;
    const clears = btnLeft > boardRight + 12;   // 触れる前に 12px の余白
    this.menuBtn.style.top = clears ? "14px" : "92px";
    // ドロップダウンは、ボタンが落ち着いた位置のすぐ下にぶら下がる
    this.controls.style.top = clears ? "58px" : "132px";
    // カメラのヒントを ☰ と同じ行の左側に保つ
    if (this.camHint) this.camHint.style.top = clears ? "14px" : "92px";
  }

  // 現在の体力バーの位置をトグルボタンのラベルに反映する。
  private refreshStaminaBtn(): void {
    if (!this.staminaBtn) return;
    this.staminaBtn.textContent = HUD_OPTS.staminaOn === "name"
      ? "体力: 名前の下" : "体力: アイコンの下";
  }

  // コート上の名前タグのオン/オフ状態をトグルボタンに反映する。
  private refreshNamesBtn(): void {
    if (!this.namesBtn) return;
    this.namesBtn.textContent = HUD_OPTS.showNames ? "選手名: 表示" : "選手名: 非表示";
  }

  // 現在の選手モデルのスタイルをトグルボタンに反映する。
  private refreshModelBtn(): void {
    if (!this.modelBtn) return;
    this.modelBtn.textContent = HUD_OPTS.model === "human" ? "モデル: 人型" : "モデル: どんぐり";
  }

  // ---- 下部の選手バー（チームごとの顔アイコン、コート上 ⇄ ベンチのタブ） ----

  private buildPlayerBars(): void {
    // 速度 / RESTART の行を挟む: team 0 のアイコンは中央のすぐ左から左へ伸び、
    // team 1 のアイコンは中央のすぐ右から右へ伸び、コントロール用に固定の中央
    // 間隔を残す — 中央にアンカーされているので、各側が何個のアイコンを表示
    // しても（コート上5 対 ベンチ8）その間隔は保たれる。
    const HALF_GAP = "130px";   // コントロール用に確保した中央間隔の半分
    for (let t = 0; t < 2; t++) {
      const panel = document.createElement("div");
      Object.assign(panel.style, {
        position: "absolute", bottom: "16px",
        ...(t === 0 ? { right: `calc(50% + ${HALF_GAP})` } : { left: `calc(50% + ${HALF_GAP})` }),
        display: "flex", flexDirection: "column", gap: "5px",
        alignItems: t === 0 ? "flex-end" : "flex-start",   // 中央に密着
        pointerEvents: "none",                              // アイコンはカメラのドラッグを妨げない
      } as Partial<CSSStyleDeclaration>);

      // タブ行: ON COURT / BENCH
      const tabs = document.createElement("div");
      Object.assign(tabs.style, { display: "flex", gap: "4px", pointerEvents: "auto" } as Partial<CSSStyleDeclaration>);
      (["ON COURT", "BENCH"] as const).forEach((label, ti) => {
        const b = document.createElement("button");
        b.textContent = label;
        Object.assign(b.style, {
          background: "rgba(20,24,34,0.85)", color: "#fff", border: "1px solid rgba(255,255,255,0.18)",
          borderRadius: "6px", padding: "2px 8px", fontSize: "10px", fontWeight: "700",
          letterSpacing: "0.5px", cursor: "pointer",
        } as Partial<CSSStyleDeclaration>);
        b.onclick = () => { this.showBench[t] = ti === 1; this.iconKey[t] = ""; };
        this.iconTabs[t].push(b);
        tabs.appendChild(b);
      });

      const row = document.createElement("div");
      Object.assign(row.style, { display: "flex", gap: "6px", touchAction: "pan-x" } as Partial<CSSStyleDeclaration>);
      row.classList.add("bball-hscroll");   // スクロールしてもバーは表示されず / 高さも増えない
      // バーは隠れているので、マウスでベンチ行をスライドする手段を与える:
      // ホイールで横スクロール、押しながらのドラッグでパン（タッチはネイティブにスワイプ）
      row.onwheel = (e) => {
        if (row.scrollWidth <= row.clientWidth) return;
        row.scrollLeft += e.deltaY || e.deltaX;
        e.preventDefault();
      };
      let dragX = -1, dragScroll = 0;
      row.onpointerdown = (e) => {
        if (e.pointerType !== "mouse" || row.scrollWidth <= row.clientWidth) return;
        dragX = e.clientX; dragScroll = row.scrollLeft;
        row.setPointerCapture(e.pointerId);
      };
      row.onpointermove = (e) => { if (dragX >= 0) row.scrollLeft = dragScroll - (e.clientX - dragX); };
      row.onpointerup = () => { dragX = -1; };
      row.onpointercancel = () => { dragX = -1; };
      this.iconRows[t] = row;

      // 上にタブ、下にアイコン行（両チーム）
      panel.appendChild(tabs);
      panel.appendChild(row);
      this.iconPanels[t] = panel;
      this.hud.appendChild(panel);
    }
  }

  // 小さな顔アバター: チームカラーの円盤、生成された簡単な頭部、そして背番号。
  // その下に選手名。肖像画のアートは存在しないため、顔は手続き的に描かれ、
  // 番号/名前が選手を識別する。
  private makeFaceIcon(player: import("./player").Player, posText: string): HTMLDivElement {
    const wrap = document.createElement("div");
    Object.assign(wrap.style, {
      position: "relative",   // ポジションバッジが（クリップされた）顔に重ねられるように
      width: "48px", flex: "0 0 auto", display: "flex", flexDirection: "column",
      alignItems: "center", gap: "2px",
      pointerEvents: "auto", cursor: "help",   // ホバーで選手のボックススコアを表示
    } as Partial<CSSStyleDeclaration>);
    wrap.onmouseenter = () => this.showStatTip(player, wrap);
    wrap.onmouseleave = () => this.scheduleHideTip();   // ツールチップのボタンに到達するための猶予

    const face = document.createElement("div");
    Object.assign(face.style, {
      position: "relative", width: "42px", height: "42px", borderRadius: "50%",
      overflow: "hidden", border: `2px solid ${colorOf(player.team)}`,
      boxShadow: "0 2px 6px rgba(0,0,0,0.5)",
    } as Partial<CSSStyleDeclaration>);
    const canvas = document.createElement("canvas");
    canvas.width = 42; canvas.height = 42;
    Object.assign(canvas.style, { width: "42px", height: "42px", display: "block" } as Partial<CSSStyleDeclaration>);
    this.drawFace(canvas, player);
    face.appendChild(canvas);

    wrap.appendChild(face);

    // 背番号 — 右下。WRAP に配置（丸くクリップされた顔ではなく）することで、
    // 2桁の番号が円の端で切れないようにする。顔は 46px の高さ（42 + 2px の枠線）
    // なので、top:32px で顔の右下にぴったり収まる。
    const num = document.createElement("div");
    num.textContent = String(player.idx + 1);
    Object.assign(num.style, {
      position: "absolute", right: "2px", top: "32px", minWidth: "16px", height: "13px",
      lineHeight: "13px", padding: "0 2px", fontSize: "9px", fontWeight: "800",
      textAlign: "center", color: "#fff", background: colorOf(player.team),
      boxSizing: "border-box", borderRadius: "4px", zIndex: "2",
    } as Partial<CSSStyleDeclaration>);
    wrap.appendChild(num);

    // ポジションバッジ — 左上。WRAP に配置（丸くクリップされた顔ではなく）する
    // ことで、円の overflow:hidden がテキストを切り取らないようにし、少しだけ内側に寄せる。
    const pos = document.createElement("div");
    pos.textContent = posText;
    Object.assign(pos.style, {
      position: "absolute", left: "4px", top: "0", height: "13px",
      lineHeight: "13px", padding: "0 2px", fontSize: "8px", fontWeight: "800",
      // 固定の2文字幅にして、1文字の C が PG/SG/… と揃うようにする（中央寄せ）
      minWidth: "16px", boxSizing: "border-box", textAlign: "center",
      color: "#fff", background: "rgba(13,16,22,0.9)",
      borderRadius: "4px", zIndex: "2",
    } as Partial<CSSStyleDeclaration>);
    wrap.appendChild(pos);

    // 顔のすぐ下の体力バー — 「icon」HUD モードのときだけ表示（「name」モードでは
    // ゲージは代わりに浮遊する3Dの名前タグ上にある）。
    const bar = document.createElement("div");
    Object.assign(bar.style, {
      width: "42px", height: "5px", borderRadius: "3px", overflow: "hidden",
      background: "rgba(255,255,255,0.22)",
      display: HUD_OPTS.staminaOn === "icon" ? "block" : "none",
    } as Partial<CSSStyleDeclaration>);
    const fill = document.createElement("div");
    Object.assign(fill.style, { width: "100%", height: "100%", borderRadius: "3px" } as Partial<CSSStyleDeclaration>);
    bar.appendChild(fill);
    wrap.appendChild(bar);
    this.iconStamina.set(player, { bar, fill });

    const name = document.createElement("div");
    name.textContent = player.name;
    Object.assign(name.style, {
      maxWidth: "50px", fontSize: "9px", fontWeight: "600", color: "#e8ecf4",
      whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
      textShadow: "0 1px 3px rgba(0,0,0,0.9)",
    } as Partial<CSSStyleDeclaration>);
    wrap.appendChild(name);

    // 名前の下のロールピル — 彼のチームがボールを持っている間はオフェンスロール、
    // 持っていない間は守備ロールを表示する。テキスト/色は updateIconRoles() が
    // ポゼッションをキーに毎フレーム更新する。
    const rolePill = document.createElement("div");
    Object.assign(rolePill.style, {
      width: "44px", fontSize: "8px", padding: "1px 0", textAlign: "center",
      borderRadius: "6px", boxSizing: "border-box", lineHeight: "1.4",
      color: "#fff", textShadow: "0 1px 2px rgba(0,0,0,0.7)",
    } as Partial<CSSStyleDeclaration>);
    wrap.appendChild(rolePill);
    this.iconRole.set(player, rolePill);
    return wrap;
  }

  // 毎フレーム: この選手のチームがボールを持っているときはオフェンスロール、
  // それ以外は守備ロールを表示 — オフェンスはチームカラー、守備は DEF_ROLE_C の色。
  private updateIconRoles(game: Game): void {
    for (const [p, pill] of this.iconRole) {
      const def = ROSTER[p.team]?.[p.idx];
      if (!def) continue;
      const onDef = p.team !== game.possession;   // 彼のチームは守備中
      const code = onDef ? def.defRole : def.evalRole;
      const short = code
        ? ((onDef ? UI.DEF_ROLES[code]?.short : UI.EVAL_ROLES[code]?.short) ?? "?")
        : "-";
      const col = code
        ? ((onDef ? UI.DEF_GROUP_C[code] : UI.OFF_GROUP_C[code]) || "rgb(150,156,168)")
        : "rgb(150,156,168)";   // グループ化された色: オフェンスは暖色（赤/黄/橙）、守備は寒色（青/緑/シアン）
      const key = (onDef ? "D" : "O") + short;
      if (pill.dataset.k === key) continue;        // 変化なし → DOM への書き込みをスキップ
      pill.dataset.k = key;
      pill.textContent = short;
      pill.style.background = code ? col : "rgba(20,24,34,0.85)";
      pill.style.border = code ? `1px solid ${col}` : "1px solid rgba(255,255,255,0.22)";
      pill.style.fontWeight = code ? "800" : "600";
    }
  }

  private drawFace(canvas: HTMLCanvasElement, player: import("./player").Player): void {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const W = canvas.width, H = canvas.height;
    const tc = TEAM_COLORS[player.team];
    // チームカラーの背景円盤
    ctx.fillStyle = `rgb(${Math.round(tc.r * 120 + 25)},${Math.round(tc.g * 120 + 25)},${Math.round(tc.b * 120 + 25)})`;
    ctx.fillRect(0, 0, W, H);
    // 選手ごとに決定的な多様性を持たせ、顔が全て同一にならないようにする —
    // playerLook 経由で3Dの頭部（entities.ts）と共有され、モデルがアイコンに一致する
    const look = playerLook(player.name);
    const skin = look.skinHex;
    const hair = look.hairHex;
    const style = look.style;   // 0短髪 1丸刈り 2アフロ 3フラットトップ 4ヘッドバンド 5ボブ 6前髪上げ 7モヒカン 8マンバン
    // 頭の後ろの髪 — 頭頂と側面が覆われるようにする完全な下地（禿げた天冠では
    // ない）。モヒカン(7、クレストとして描く)を除く全てで描画; 丸刈り(1)は頭より
    // ほんの少し大きいだけの下地を使う（薄い刈り上げ）。
    if (style !== 7) {
      ctx.fillStyle = hair;
      const hr = style === 2 ? 0.40 : (style === 5 || style === 10) ? 0.37 : style === 1 ? 0.315 : 0.335;   // アフロが最大、ボブ/ロングはふっくら、刈り上げはぴったり
      ctx.beginPath(); ctx.arc(W / 2, H * (style === 2 ? 0.44 : 0.46), W * hr, 0, Math.PI * 2); ctx.fill();
      if (style === 3) ctx.fillRect(W * 0.15, H * 0.14, W * 0.70, H * 0.32);   // フラットトップのブロック
      if (style === 5) ctx.fillRect(W * 0.17, H * 0.46, W * 0.66, H * 0.22);   // ボブ — 長めの側面
      if (style === 10) ctx.fillRect(W * 0.15, H * 0.46, W * 0.70, H * 0.30);  // ロング — 肩まで下りる側面
      if (style === 8) { ctx.beginPath(); ctx.arc(W / 2, H * 0.26, W * 0.10, 0, Math.PI * 2); ctx.fill(); } // マンバンの結び目
    }
    // 下地の上に頭部（肌）→ 髪が頭頂と側面を縁取る
    ctx.fillStyle = skin;
    ctx.beginPath(); ctx.arc(W / 2, H * 0.52, W * 0.30, 0, Math.PI * 2); ctx.fill();
    // 額を横切る前髪の生え際 / 前髪（前面がふっくらした後面と区別して読める）。
    // 前髪上げ(6、額が露出)とモヒカン(7)ではスキップ。
    if (style !== 6 && style !== 7) {
      ctx.fillStyle = hair;
      ctx.beginPath(); ctx.arc(W / 2, H * 0.45, W * 0.305, Math.PI * 1.03, Math.PI * 1.97); ctx.fill();
    }
    // モヒカン(7) — 頭の中央を縦に走るクレストの帯
    if (style === 7) {
      ctx.fillStyle = hair;
      ctx.fillRect(W * 0.42, H * 0.12, W * 0.16, H * 0.42);
    }
    // くせ毛長髪(11) / ドレッド(12) — 側面に垂れ下がるロックで顔を縁取る
    if (style === 11 || style === 12) {
      ctx.fillStyle = hair;
      const dense = style === 12;                      // ドレッド: より多く、細く、長い
      const span = dense ? 5 : 3, gap = dense ? 0.072 : 0.105;
      const wid = dense ? 0.024 : 0.036, len = dense ? 0.34 : 0.26;
      for (let i = -span; i <= span; i++) {
        if (i === 0) continue;                         // 顔の中央は空けておく
        const x = W / 2 + i * W * gap - W * wid / 2;
        ctx.fillRect(x, H * 0.46, W * wid, H * (len + (Math.abs(i) % 2) * 0.05));
      }
    }
    // ヘッドバンド（スタイル 4）— 額を横切るチームカラー
    if (style === 4) {
      ctx.fillStyle = `rgb(${Math.round(tc.r * 255)},${Math.round(tc.g * 255)},${Math.round(tc.b * 255)})`;
      ctx.fillRect(W * 0.20, H * 0.40, W * 0.60, H * 0.07);
    }
    // 目
    ctx.fillStyle = "#26211c";
    ctx.beginPath(); ctx.arc(W * 0.41, H * 0.52, 1.7, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(W * 0.59, H * 0.52, 1.7, 0, Math.PI * 2); ctx.fill();
    // 口
    ctx.strokeStyle = "rgba(80,40,30,0.8)"; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.arc(W / 2, H * 0.60, W * 0.10, 0.15 * Math.PI, 0.85 * Math.PI); ctx.stroke();
  }

  // レスポンシブレイアウト。モバイル幅の画面では両チームの顔アイコンが中央下部で
  // 1行に集まる（収まるよう縮小 — refreshPlayerBars 参照）; 広い画面では中央を
  // 挟む。コントロールはどちらの場合も上部のハンバーガーにあるので、動かない。
  private applyLayout(): void {
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

  private refreshPlayerBars(game: Game): void {
    for (let t = 0; t < 2; t++) {
      // アクティブなタブをハイライト
      this.iconTabs[t].forEach((b, ti) => {
        const active = (ti === 1) === this.showBench[t];
        b.style.background = active ? colorOf(t) : "rgba(20,24,34,0.85)";
        b.style.opacity = active ? "1" : "0.7";
      });
      // どの選手を表示するか: 現在コート上の5人、またはベンチの8人
      const onCourt = game.players.filter((p) => p.team === t);
      const set = new Set(onCourt);
      const list = this.showBench[t] ? game.roster[t].filter((p) => !set.has(p)) : onCourt;
      // モバイル: 1行、2チームを左右に。アイコンは常にフルサイズ — アイコンが
      // 全て収まらないとき、行はチームの半分の中で横スクロール（スワイプ）する
      // だけ。決して拡縮しない。
      const rw = this.iconRows[t];
      const pn = this.iconPanels[t];
      if (rw && pn) {
        if (this.layoutMode === "phone") {
          // 両タブで1つのアイコンサイズ: コート上の5人がチームの半分を満たす
          // 値（48px アイコン + 6px の gap → 自然幅 264px）
          const natural5 = 5 * 48 + 4 * 6;
          const s = Math.min(1, (window.innerWidth * 0.49) / natural5);
          pn.style.transform = `scale(${s})`;
          if (this.showBench[t]) {
            // ベンチ: 同サイズのアイコンがスライドする — スクロールウィンドウは
            // スケール前の単位でサイズ指定され、依然ちょうど半分の幅を表示する
            Object.assign(rw.style, {
              maxWidth: `${Math.round((window.innerWidth * 0.49) / s)}px`,
              overflowX: "auto", pointerEvents: "auto",
            });
          } else {
            Object.assign(rw.style, { maxWidth: "", overflowX: "visible", pointerEvents: "auto" });
          }
        } else {
          pn.style.transform = "none";
          Object.assign(rw.style, { maxWidth: "", overflowX: "visible", pointerEvents: "" });
        }
      }
      // バッジは、コート上の5人には守っているフィールドのポジション（どのスロット
      // でプレーするか）を表示する; ベンチ（フィールドのスポットなし）は代わりに
      // 各人の本来のロールを表示する。
      const SLOT_POS = ["PG", "SG", "SF", "PF", "C"];
      const posOf = (p: import("./player").Player) =>
        this.showBench[t] ? p.role : (SLOT_POS[p.slot] ?? p.role);
      // 表示するセット（または 名前 / タブ / 評価ロール / スロット）が変わったときだけ
      // 再構築する — 名前がキーに含まれるので、ティップオフの applyRoster による
      // 改名で即座に再構築され、スロットも含まれるので、ポジションを守る者を変える
      // 交代でバッジが更新される
      const key = `${this.showBench[t] ? "B" : "C"}:`
        + list.map((p) => {
          const d = ROSTER[t]?.[p.idx];
          return `${p.idx}:${p.name}:${p.slot}:${d?.evalRole ?? ""}:${d?.defRole ?? ""}:${d?.choiceRank ?? ""}`;
        }).join(",");
      if (key === this.iconKey[t]) continue;
      this.iconKey[t] = key;
      const row = this.iconRows[t];
      this.hideTip();   // ホバー中のアイコンが差し替えられる可能性 — そのツールチップを取り下げる
      row.replaceChildren();
      for (const p of list) {
        const el = this.makeFaceIcon(p, posOf(p));
        this.iconEl.set(p, el);   // スタッツのポップがその上にアンカーできるよう覚えておく
        row.appendChild(el);
      }
    }
  }

  // 顔アイコンの体力バーをライブ更新する（「icon」HUD モードでのみ意味がある;
  // それ以外ではバーは隠れている）。選手をキーにするので、彼のために現在画面上に
  // あるどのアイコン要素でも追跡する。
  private updateIconStamina(game: Game): void {
    const show = HUD_OPTS.staminaOn === "icon";
    for (const roster of game.roster) {
      for (const p of roster) {
        const s = this.iconStamina.get(p);
        if (!s || !s.bar.isConnected) continue;
        s.bar.style.display = show ? "block" : "none";
        if (!show) continue;
        const frac = Math.max(0, Math.min(1, 1 - p.fatigue));
        s.fill.style.width = `${frac * 100}%`;
        s.fill.style.background = frac > 0.5 ? "rgb(80,220,110)"
          : frac > 0.25 ? "rgb(240,200,70)" : "rgb(235,80,60)";
      }
    }
  }

  // 浮遊する「＋」バッジ: 各選手のボックススコアを前フレームと比較し、彼が今
  // 記録したもの（得点/アシスト/リバウンド/等）についてアイコン上にバッジをポップする。
  private updateStatPops(game: Game): void {
    if (this.phase !== "playing") return;
    for (const roster of game.roster) {
      for (const p of roster) {
        let snap = this.statSnap.get(p);
        if (!snap) { this.statSnap.set(p, POP_STATS.map((s) => p.stats[s.key])); continue; }
        let stack = 0;
        POP_STATS.forEach((s, i) => {
          const cur = p.stats[s.key];
          const d = cur - snap![i];
          if (d > 0) this.popStat(p, s.label, d, s.color, stack++);
          snap![i] = cur;   // ベースラインを取り直す（リスタートの 0 へのリセットも吸収する）
        });
      }
    }
  }

  private popStat(player: import("./player").Player, label: string, delta: number,
                  color: string, stack: number): void {
    const icon = this.iconEl.get(player);
    if (!icon || !icon.isConnected) return;   // アイコンが実際に画面上にあるときだけ
    const hb = this.hud.getBoundingClientRect();
    const r = icon.getBoundingClientRect();
    if (r.width === 0) return;                 // 隠れている / レイアウトされていない
    const badge = document.createElement("div");
    badge.textContent = `${label}+${delta}`;
    Object.assign(badge.style, {
      position: "absolute", left: `${r.left - hb.left + r.width / 2}px`,
      top: `${r.top - hb.top - 10 - stack * 17}px`, transform: "translate(-50%,0)",
      color, fontSize: "15px", fontWeight: "900", letterSpacing: "0.5px",
      textShadow: "0 1px 3px #000, 0 0 5px rgba(0,0,0,0.9)", pointerEvents: "none",
      zIndex: "45", opacity: "1", transition: "opacity 1.1s ease-out, transform 1.1s ease-out",
    } as Partial<CSSStyleDeclaration>);
    this.hud.appendChild(badge);
    requestAnimationFrame(() => {   // 次フレーム → 上へアニメーションしてフェード、その後除去
      badge.style.opacity = "0";
      badge.style.transform = "translate(-50%,-32px)";
    });
    setTimeout(() => badge.remove(), 1200);
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
