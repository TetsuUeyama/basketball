import { Game } from "./game";
import { TEAM_NAMES, TEAM_COLORS } from "./config";
import { ROSTER, ROSTER_SIZE, STARTERS, randomizeRosters, ATTR_META, ABILITY_META, type Attributes, type PlayerDef } from "./attributes";

const colorOf = (team: number): string => {
  const c = TEAM_COLORS[team];
  return `rgb(${c.r * 255},${c.g * 255},${c.b * 255})`;
};

type Phase = "pregame" | "playing" | "result";

// Hover explanations (shared floating tooltip) — kept for the ability chips
// and any labelled UI that wants a definition on hover.
const INFO: Record<string, string> = {
  操作方法: "選手は毎試合ランダム編成（WE2010データベースから抽選）。"
    + "選手バーをつかんでドラッグし、入れ替えたい選手の上でドロップするとスタメン⇄ベンチ交代"
    + "（タッチは長押しでつかむ）。選手にカーソルを合わせると詳細（6角チャート＋特殊能力）が出ます。",
};
for (const m of ATTR_META) INFO[m.label] = `【${m.name}】${m.tip}`;
for (const m of ABILITY_META) INFO[m.label] = `【特殊能力】${m.tip}`;
const STAT_COLS: { key: keyof import("./entities").Stats; label: string }[] = [
  { key: "min", label: "MIN" },
  { key: "pts", label: "PTS" },
  { key: "reb", label: "REB" },
  { key: "ast", label: "AST" },
  { key: "stl", label: "STL" },
  { key: "blk", label: "BLK" },
  { key: "tov", label: "TO" },
];
// `min` is stored in game-clock seconds — show it as minutes with one decimal.
const fmtStat = (key: string, v: number): string =>
  key === "min" ? (v / 60).toFixed(1) : String(v);

// Stats that pop a floating "＋" badge over a player's icon the moment he earns
// them (score / assist / rebound / steal / block / turnover).
const POP_STATS: { key: keyof import("./entities").Stats; label: string; color: string }[] = [
  { key: "pts", label: "P", color: "#63e08c" },
  { key: "ast", label: "A", color: "#5ec8ff" },
  { key: "reb", label: "R", color: "#ffd85e" },
  { key: "stl", label: "S", color: "#ff9d43" },
  { key: "blk", label: "B", color: "#c98cff" },
  { key: "tov", label: "TO", color: "#ff6b6b" },
];

// A DOM overlay with three screens: a pre-game roster editor, the in-game HUD,
// and a final result screen with each player's box score.
export class UI {
  private root: HTMLDivElement;
  private hud: HTMLDivElement;
  private pregamePanel!: HTMLDivElement;
  private editorHost!: HTMLDivElement;
  private resultPanel!: HTMLDivElement;
  private resultScore!: HTMLDivElement;
  private resultWinner!: HTMLDivElement;
  private resultStats!: HTMLDivElement;
  private tooltip!: HTMLDivElement;
  private tipTitle!: HTMLDivElement;
  private tipBody!: HTMLDivElement;

  private scoreA: HTMLSpanElement;
  private scoreB: HTMLSpanElement;
  private clock: HTMLSpanElement;
  private quarter: HTMLSpanElement;
  private shot: HTMLSpanElement;
  private banner: HTMLDivElement;
  private bannerKey = "";           // current banner content, to avoid rebuilding each frame
  private subFeed!: HTMLDivElement;
  private speedBtns: HTMLButtonElement[] = [];
  // bottom player bars: face icons for each team, toggling on-court ⇄ bench
  private iconRows: HTMLDivElement[] = [];
  private iconTabs: HTMLButtonElement[][] = [[], []];
  private showBench: boolean[] = [false, false];
  private iconKey: string[] = ["", ""];
  private iconEl = new Map<import("./entities").Player, HTMLDivElement>(); // player → its current icon element
  private statSnap = new Map<import("./entities").Player, number[]>();     // last-seen POP_STATS values
  private controls!: HTMLDivElement;      // speed / RESTART row
  private iconPanels: HTMLDivElement[] = []; // the two team face-icon panels
  private layoutMode = "";                // "desktop" | "phone" — recomputed on resize

  private phase: Phase = "pregame";
  private playerCard!: HTMLDivElement;  // floating pregame detail card (hex chart)
  private dragFrom: { team: number; idx: number } | null = null; // bar being carried
  private dragGhost: HTMLDivElement | null = null;               // the carried name bar
  private dragHl: HTMLElement | null = null;                     // highlighted drop row
  private rolePicker: HTMLDivElement | null = null;              // open 評価ロール menu
  private rolePickerCloser: ((e: PointerEvent) => void) | null = null;
  private detailModal: HTMLDivElement | null = null;             // full-ratings modal
  private rosterTab = 0;         // phone: which team's roster card is shown
  private pregameMode = "";      // "phone" | "desktop" — re-render on crossing 640px

  speed = 1;
  onRestart: () => void = () => {};
  onStart: () => void = () => {};
  onBack: () => void = () => {};

  get playing(): boolean {
    return this.phase === "playing";
  }

  constructor() {
    const css = (el: HTMLElement, s: Partial<CSSStyleDeclaration>) => Object.assign(el.style, s);

    this.root = document.createElement("div");
    css(this.root, {
      position: "fixed", inset: "0", pointerEvents: "none",
      fontFamily: "Segoe UI, system-ui, sans-serif", color: "#fff", userSelect: "none",
    });
    document.body.appendChild(this.root);

    this.hud = document.createElement("div");
    css(this.hud, { position: "absolute", inset: "0", pointerEvents: "none" });
    this.root.appendChild(this.hud);

    // ---- scoreboard ----
    const board = document.createElement("div");
    css(board, {
      position: "absolute", top: "14px", left: "50%", transform: "translateX(-50%)",
      display: "flex", alignItems: "center", gap: "18px",
      background: "rgba(12,15,22,0.82)", border: "1px solid rgba(255,255,255,0.12)",
      borderRadius: "12px", padding: "10px 20px", boxShadow: "0 6px 24px rgba(0,0,0,0.4)",
    });
    this.hud.appendChild(board);

    const colA = colorOf(0), colB = colorOf(1);
    board.appendChild(this.teamBlock(TEAM_NAMES[0], colA, "right"));
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
    board.appendChild(this.teamBlock(TEAM_NAMES[1], colB, "left"));

    // ---- shot clock ----
    const sc = document.createElement("div");
    css(sc, {
      position: "absolute", top: "92px", left: "50%", transform: "translateX(-50%)",
      background: "rgba(180,40,20,0.9)", borderRadius: "8px", padding: "2px 12px",
      fontSize: "16px", fontWeight: "700", minWidth: "34px", textAlign: "center",
    });
    this.shot = document.createElement("span");
    sc.appendChild(this.shot);
    this.hud.appendChild(sc);

    // ---- substitution feed (メンバーチェンジ) ----
    // centre of the screen, just below the main event banner (FOUL etc.), so a
    // foul banner and the resulting substitutions can show together
    this.subFeed = document.createElement("div");
    css(this.subFeed, {
      position: "absolute", top: "33%", left: "50%", transform: "translateX(-50%)",
      display: "flex", flexDirection: "column", gap: "8px", alignItems: "center",
      pointerEvents: "none", width: "max-content", maxWidth: "94vw",
    });
    this.hud.appendChild(this.subFeed);

    // ---- event banner ----
    this.banner = document.createElement("div");
    css(this.banner, {
      position: "absolute", top: "27%", left: "50%", transform: "translate(-50%,-50%)",
      // responsive: full size on a wide view, shrinks as the window narrows
      fontSize: "clamp(28px,6.5vw,52px)", fontWeight: "800", letterSpacing: "2px", opacity: "0",
      textAlign: "center", transition: "opacity 0.2s", whiteSpace: "nowrap", maxWidth: "96vw",
      // crisp dark outline (8-way) + a soft drop shadow, so the team-coloured text
      // reads sharply against the court instead of blurring into it. text-shadow
      // is inherited, so the scorer/assist sub-lines get the same outline.
      textShadow: [
        "1px 1px 0 #000", "-1px 1px 0 #000", "1px -1px 0 #000", "-1px -1px 0 #000",
        "0 2px 0 #000", "0 -2px 0 #000", "2px 0 0 #000", "-2px 0 0 #000",
        "0 5px 18px rgba(0,0,0,0.7)",
      ].join(", "),
    });
    this.hud.appendChild(this.banner);

    // ---- controls: a hamburger menu at the top-right (speed + RESTART) ----
    const menuBtn = this.button("☰");
    Object.assign(menuBtn.style, {
      position: "absolute", top: "14px", right: "14px", pointerEvents: "auto",
      fontSize: "18px", lineHeight: "1", padding: "7px 12px", zIndex: "20",
    } as Partial<CSSStyleDeclaration>);
    this.hud.appendChild(menuBtn);

    const controls = document.createElement("div");
    this.controls = controls;
    css(controls, {
      position: "absolute", top: "54px", right: "14px", display: "none",
      flexDirection: "column", gap: "6px", pointerEvents: "auto", zIndex: "20",
      background: "rgba(12,15,22,0.94)", border: "1px solid rgba(255,255,255,0.15)",
      borderRadius: "10px", padding: "8px", boxShadow: "0 8px 24px rgba(0,0,0,0.55)",
    });
    this.hud.appendChild(controls);
    menuBtn.onclick = () => { controls.style.display = controls.style.display === "none" ? "flex" : "none"; };

    const speedRow = document.createElement("div");
    Object.assign(speedRow.style, { display: "flex", gap: "6px" } as Partial<CSSStyleDeclaration>);
    for (const s of [1, 2, 4]) {
      const b = this.button(`${s}x`);
      b.onclick = () => { this.speed = s; this.refreshSpeed(); };
      this.speedBtns.push(b);
      speedRow.appendChild(b);
    }
    controls.appendChild(speedRow);
    const restart = this.button("RESTART");
    restart.onclick = () => { this.onRestart(); controls.style.display = "none"; };
    controls.appendChild(restart);

    const hint = document.createElement("div");
    css(hint, {
      position: "absolute", bottom: "16px", right: "16px", fontSize: "12px",
      opacity: "0.5", pointerEvents: "none",
    });
    hint.textContent = "drag: orbit  ·  wheel: zoom";
    this.hud.appendChild(hint);

    this.buildPlayerBars();
    this.buildTooltip();
    this.buildPregame();
    this.buildResult();
    this.refreshSpeed();
    this.setPhase("pregame");
  }

  // A small floating explanation shown on hover, anchored under the header.
  private buildTooltip(): void {
    const tip = document.createElement("div");
    Object.assign(tip.style, {
      // fixed on <body> (NOT inside root): root is a fixed-position stacking
      // context, so a tooltip inside it could never rise above the body-level
      // pop-ups (role picker z80, drag ghost z70) it has to annotate
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
    document.body.appendChild(tip);
    this.tooltip = tip;
  }

  private showTip(label: string, anchor: HTMLElement): void {
    const info = INFO[label];
    if (!info) return;
    this.showTextTip(label, info, anchor);
  }

  // Same floating tooltip, but with free-form title/body (role explanations
  // and the like — anything not registered in INFO).
  private showTextTip(title: string, body: string, anchor: HTMLElement): void {
    this.tipTitle.style.color = "#fff";
    this.tipTitle.textContent = title;
    this.tipBody.textContent = body;
    const tip = this.tooltip;
    tip.style.display = "block";
    // anchor under the header, clamped to the viewport once its width is known
    const r = anchor.getBoundingClientRect();
    let left = r.left;
    const tw = tip.offsetWidth;
    if (left + tw > window.innerWidth - 8) left = window.innerWidth - 8 - tw;
    if (left < 8) left = 8;
    tip.style.left = `${left}px`;
    tip.style.top = `${r.bottom + 6}px`;
  }

  private hideTip(): void {
    this.tooltip.style.display = "none";
  }

  // Hover a player icon → show his live box score, floated ABOVE the icon (the
  // icons sit near the bottom of the screen).
  private showStatTip(player: import("./entities").Player, anchor: HTMLElement): void {
    this.tipTitle.style.color = colorOf(player.team);
    this.tipTitle.textContent = `#${player.idx + 1}  ${player.name}`;
    const s = player.stats;
    const cell = (label: string, v: number | string): string =>
      `<span style="display:inline-block;min-width:66px"><b style="opacity:.6">${label}</b> ${v}</span>`;
    this.tipBody.innerHTML =
      `<div>${cell("PTS", s.pts)}${cell("REB", s.reb)}${cell("AST", s.ast)}</div>` +
      `<div>${cell("STL", s.stl)}${cell("BLK", s.blk)}${cell("TO", s.tov)}</div>` +
      `<div style="margin-top:3px;opacity:.8">FG ${s.fgm}/${s.fga}　MIN ${(s.min / 60).toFixed(1)}</div>`;
    const tip = this.tooltip;
    tip.style.display = "block";
    const r = anchor.getBoundingClientRect();
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let left = r.left + r.width / 2 - tw / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - 8 - tw));
    tip.style.left = `${left}px`;
    tip.style.top = `${Math.max(8, r.top - th - 8)}px`;   // above the icon
  }

  // ---- screens -----------------------------------------------------------

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

  private buildPregame(): void {
    const p = this.panel();

    // title + a small ⓘ — the how-to text lives behind a hover (tap on touch)
    const titleRow = document.createElement("div");
    Object.assign(titleRow.style, { display: "flex", alignItems: "center", gap: "9px", justifyContent: "center" } as Partial<CSSStyleDeclaration>);
    const title = document.createElement("div");
    Object.assign(title.style, { fontSize: "clamp(18px, 5vw, 26px)", fontWeight: "800", letterSpacing: "1px" });
    title.textContent = "スターティング設定 — LINE-UPS";
    const info = document.createElement("span");
    info.textContent = "ⓘ";
    Object.assign(info.style, {
      fontSize: "17px", color: "rgba(150,190,255,0.95)", cursor: "help",
      pointerEvents: "auto", lineHeight: "1",
    } as Partial<CSSStyleDeclaration>);
    info.onmouseenter = () => this.showTip("操作方法", info);
    info.onmouseleave = () => this.hideTip();
    info.onclick = () => this.showTip("操作方法", info);   // touch: tap to read
    titleRow.append(title, info);

    p.append(titleRow);
    this.editorHost = document.createElement("div");
    Object.assign(this.editorHost.style, {
      width: "100%", display: "flex", flexDirection: "column", alignItems: "center", gap: "8px",
    } as Partial<CSSStyleDeclaration>);
    p.appendChild(this.editorHost);

    // the floating player-detail card (hexagon + 特殊能力), shown on row hover
    this.playerCard = document.createElement("div");
    Object.assign(this.playerCard.style, {
      position: "fixed", display: "none", zIndex: "60", pointerEvents: "none",
      width: "260px", boxSizing: "border-box", padding: "10px 12px",
      background: "rgba(12,15,22,0.97)", border: "1px solid rgba(255,255,255,0.25)",
      borderRadius: "12px", boxShadow: "0 12px 36px rgba(0,0,0,0.6)", textAlign: "left",
    } as Partial<CSSStyleDeclaration>);
    document.body.appendChild(this.playerCard);

    const buttons = document.createElement("div");
    Object.assign(buttons.style, { display: "flex", gap: "10px", marginTop: "2px" } as Partial<CSSStyleDeclaration>);
    // responsive: full size on a wide view, shrinks as the window narrows
    const reroll = this.button("ランダム編成しなおす");
    Object.assign(reroll.style, { fontSize: "clamp(11px,2.9vw,15px)", padding: "clamp(7px,1.8vw,11px) clamp(12px,3vw,22px)" });
    reroll.onclick = () => this.newMatchup();
    const start = this.button("TIP OFF");
    Object.assign(start.style, { fontSize: "clamp(13px,3.3vw,17px)", padding: "clamp(7px,1.8vw,11px) clamp(16px,4vw,30px)", background: "rgba(70,120,220,0.95)" });
    start.onclick = () => { this.setPhase("playing"); this.onStart(); };
    buttons.append(reroll, start);
    p.appendChild(buttons);

    this.root.appendChild(p);
    this.pregamePanel = p;
    // crossing the phone/desktop breakpoint re-lays-out the roster area
    window.addEventListener("resize", () => {
      if (this.phase !== "pregame") return;
      const mode = window.innerWidth < 640 ? "phone" : "desktop";
      if (mode !== this.pregameMode) this.refreshEditors();
    });
    this.newMatchup();   // the first matchup is drawn at once
  }

  /** Draw a fresh random matchup from the database and rebuild the editors. */
  private newMatchup(): void {
    randomizeRosters();
    this.refreshEditors();
  }

  /** Rebuild the VS board and both roster cards from the current ROSTER. */
  private refreshEditors(): void {
    this.hidePlayerCard();
    this.closeRolePicker();
    this.closeDetailModal();
    const phone = window.innerWidth < 640;
    this.pregameMode = phone ? "phone" : "desktop";
    this.editorHost.replaceChildren();
    this.editorHost.appendChild(this.buildVsBoard());

    if (phone) {
      // one roster at a time behind team tabs — two stacked 13-man cards would
      // scroll forever on a phone
      const tabs = document.createElement("div");
      Object.assign(tabs.style, { display: "flex", gap: "6px", justifyContent: "center" } as Partial<CSSStyleDeclaration>);
      for (let t = 0; t < 2; t++) {
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
        tabs.appendChild(b);
      }
      this.editorHost.appendChild(tabs);
      this.editorHost.appendChild(this.rosterCard(this.rosterTab));
      return;
    }

    const cols = document.createElement("div");
    Object.assign(cols.style, {
      display: "flex", gap: "12px", flexWrap: "wrap", justifyContent: "center",
      alignItems: "flex-start", width: "100%",
    } as Partial<CSSStyleDeclaration>);
    for (let t = 0; t < 2; t++) cols.appendChild(this.rosterCard(t));
    this.editorHost.appendChild(cols);
  }

  // ---- pregame: VS strength board + compact roster cards ------------------

  // The six axes of the hexagon chart AND the team-strength comparison —
  // weighted digests of the 25 ratings (ratings themselves are no longer
  // edited here, only read).
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

  // What each position actually needs, axis by axis (same order as HEX_AXES),
  // plus how much raw HEIGHT matters there. A flat average made every player
  // rate the same — this weights the role's needs and the player's peaks.
  private static readonly ROLE_W: Record<string, { ax: number[]; ht: number }> = {
    //        シュート ドリブル  パス  スピード フィジカル 守備     身長
    PG: { ax: [0.16, 0.24, 0.28, 0.20, 0.03, 0.09], ht: 0.00 },
    SG: { ax: [0.30, 0.18, 0.10, 0.20, 0.07, 0.15], ht: 0.00 },
    SF: { ax: [0.22, 0.13, 0.10, 0.17, 0.18, 0.20], ht: 0.05 },
    PF: { ax: [0.14, 0.06, 0.06, 0.10, 0.32, 0.20], ht: 0.12 },
    C:  { ax: [0.10, 0.04, 0.05, 0.08, 0.35, 0.23], ht: 0.15 },
  };

  // 評価ロール: a hand-set role overrides the position weights — the same
  // player rates differently as an エース than as a 3&D piece. Display /
  // team-strength evaluation only; the in-game AI is untouched.
  // `pos` = which positions can take the role; undefined = 全ポジション共通
  // (the modern position-crossing jobs). `short` = the code shown on the pill.
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
    リムプロテクター:      { ax: [0.04, 0.02, 0.04, 0.08, 0.30, 0.34], ht: 0.18, short: "RIM", pos: ["PF", "C"],
      tip: "ゴール下で相手のシュートをブロックする守護神。高さと守備を評価。" },
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

  // The weights actually used for a player: his hand-set 評価ロール, or his
  // position's profile when left on 自動.
  private effWeights(def: PlayerDef): { ax: number[]; ht: number } {
    return (def.evalRole && UI.EVAL_ROLES[def.evalRole])
      || UI.ROLE_W[def.role] || UI.ROLE_W.SF;
  }

  // 守れるポジション: the game's substitution adjacency (roleFit in game.ts),
  // gated per player — the BIGGER slot only with the size for it, the SMALLER
  // slot only with the feet for it. Display heuristic; first entry = his own.
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

  // The raw ratings the "peak" scan considers — a specialist's two best single
  // abilities are his calling card, and they are far sharper than any averaged
  // axis (mental/stamina/teamwork type ratings are deliberately left out).
  private static readonly PEAK_KEYS: (keyof Attributes)[] = [
    "offense", "defense", "balance", "speed", "accel", "reaction", "agility",
    "dribbleAcc", "dribbleSpd", "passAcc", "passSpd", "threeAcc", "threeRange",
    "midAcc", "shotStrength", "shotTech", "bank", "dunk", "jump", "handling", "aggression",
  ];

  // OVR = 50% "what his position needs" (incl. height for bigs) + 50% his two
  // best RAW abilities, then stretched around the league median — a flat
  // average made everyone rate ~70-76; this spreads the field (measured on the
  // real DB: sd 2.2 → 4.4, band ≈ 68..96).
  // 身長→戦力値: 180cm = 70, 200cm = 100 (linear, clamped — the user's
  // calibration for how much size is worth on this scale).
  private static heightValue(cm: number): number {
    return Math.max(0, Math.min(100, 70 + (cm - 180) * 1.5));
  }

  private ovrOf(def: PlayerDef): number {
    const ax = this.axesOf(def);
    const w = this.effWeights(def);   // position profile, or the hand-set 評価ロール
    const htScore = UI.heightValue(def.height * 100);
    let pos = w.ht * htScore, tot = w.ht;
    for (let i = 0; i < ax.length; i++) { pos += w.ax[i] * ax[i]; tot += w.ax[i]; }
    pos /= tot;
    const raw = UI.PEAK_KEYS.map((k) => def.attr[k]).sort((a, b) => b - a);
    const v = pos * 0.5 + ((raw[0] + raw[1]) / 2) * 0.5;
    return Math.round(Math.max(40, Math.min(99, 74 + (v - 74) * 1.4)));
  }
  // Team strength per axis: NOT a flat average — each player counts toward an
  // axis in proportion to how responsible his position (or hand-set 評価ロール)
  // is for it: the PG's passing IS the team's passing, while the C barely
  // moves that needle. Starters carry 70%, the bench rotation 30%.
  private teamAxes(team: number): number[] {
    const r = ROSTER[team];
    return UI.HEX_AXES.map((x, i) => {
      const grp = (from: number, to: number): number => {
        let v = 0, w = 0;
        for (let j = from; j < to; j++) {
          const wt = this.effWeights(r[j]).ax[i] + 0.02; // tiny floor: everyone counts a little
          v += x.calc(r[j].attr) * wt;
          w += wt;
        }
        return v / w;
      };
      return grp(0, STARTERS) * 0.7 + grp(STARTERS, ROSTER_SIZE) * 0.3;
    });
  }

  // Head-to-head board: the two teams' six axes side by side, tornado-style,
  // with the stronger side's number lit up.
  // A team's number for the header: the players' OVRs, starters 70% bench 30%.
  private teamOvr(team: number): number {
    const r = ROSTER[team];
    let st = 0, bn = 0;
    for (let j = 0; j < STARTERS; j++) st += this.ovrOf(r[j]);
    for (let j = STARTERS; j < ROSTER_SIZE; j++) bn += this.ovrOf(r[j]);
    return Math.round((st / STARTERS) * 0.7 + (bn / (ROSTER_SIZE - STARTERS)) * 0.3);
  }

  // ...and its size: height in cm, weighted by how much height MATTERS for
  // each man's position/role — the C's reach is the team's size, a PG's
  // stature barely registers.
  private teamHeight(team: number): number {
    const r = ROSTER[team];
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

  private buildVsBoard(): HTMLDivElement {
    const axA = this.teamAxes(0), axB = this.teamAxes(1);
    const colA = colorOf(0), colB = colorOf(1);

    const wrap = document.createElement("div");
    Object.assign(wrap.style, {
      width: "min(560px, 100%)", boxSizing: "border-box", padding: "7px 14px",
      background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.14)",
      borderRadius: "12px", display: "flex", flexDirection: "column", gap: "3px",
    } as Partial<CSSStyleDeclaration>);

    // header: TEAM A  <OVR>  VS  <OVR>  TEAM B
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
    const ovrEl = (v: number, win: boolean): HTMLDivElement => {
      const d = document.createElement("div");
      Object.assign(d.style, { fontSize: "22px", fontWeight: "800", color: "#fff", opacity: win ? "1" : "0.55" });
      d.textContent = String(v);
      return d;
    };
    const vs = document.createElement("div");
    Object.assign(vs.style, { fontSize: "13px", fontWeight: "800", opacity: "0.6", letterSpacing: "2px" });
    vs.textContent = "VS";
    const oa = this.teamOvr(0), ob = this.teamOvr(1);
    head.append(nameEl(0, "left"), ovrEl(oa, oa >= ob), vs, ovrEl(ob, ob >= oa), nameEl(1, "right"));
    wrap.appendChild(head);

    // comparison rows: value | ←bar | label | bar→ | value. The bar spreads a
    // declared band (ratings are compressed) — the exact numbers sit beside it.
    const addRow = (label: string, a: number, b: number, lo: number, hi: number) => {
      const row = document.createElement("div");
      Object.assign(row.style, {
        display: "grid", gridTemplateColumns: "26px 1fr 88px 1fr 26px", gap: "8px",
        alignItems: "center",
      } as Partial<CSSStyleDeclaration>);
      const val = (v: number, win: boolean, align: string): HTMLDivElement => {
        const d = document.createElement("div");
        Object.assign(d.style, { fontSize: "12px", fontWeight: "800", color: "#fff", opacity: win ? "1" : "0.5", textAlign: align });
        d.textContent = String(Math.round(v));
        return d;
      };
      const bar = (v: number, color: string, win: boolean, fromRight: boolean): HTMLDivElement => {
        const track = document.createElement("div");
        Object.assign(track.style, {
          height: "8px", background: "rgba(255,255,255,0.08)", borderRadius: "4px",
          overflow: "hidden", display: "flex", justifyContent: fromRight ? "flex-end" : "flex-start",
        } as Partial<CSSStyleDeclaration>);
        const fill = document.createElement("div");
        const w = Math.max(4, Math.min(100, ((v - lo) / (hi - lo)) * 100));
        Object.assign(fill.style, { width: `${w}%`, height: "100%", background: color, borderRadius: "4px", opacity: win ? "1" : "0.55" });
        track.appendChild(fill);
        return track;
      };
      const lab = document.createElement("div");
      Object.assign(lab.style, { fontSize: "11px", fontWeight: "700", opacity: "0.75", textAlign: "center", whiteSpace: "nowrap" });
      lab.textContent = label;
      row.append(val(a, a >= b, "right"), bar(a, colA, a >= b, true), lab, bar(b, colB, b >= a, false), val(b, b >= a, "left"));
      wrap.appendChild(row);
    };
    for (let i = 0; i < UI.HEX_AXES.length; i++) addRow(UI.HEX_AXES[i].label, axA[i], axB[i], 40, 99);
    // team size — responsibility-weighted height converted to a strength value
    // on the user's calibration (180cm → 70, 200cm → 100), same band as the axes
    addRow("高さ", UI.heightValue(this.teamHeight(0)), UI.heightValue(this.teamHeight(1)), 40, 100);
    return wrap;
  }

  // One team's roster: compact rows (position / name / height / OVR), starters
  // above the bench divider. Click a player, then click another to swap them —
  // hover shows the detail card (hexagon chart + 特殊能力).
  private rosterCard(team: number): HTMLDivElement {
    const color = colorOf(team);
    const wrap = document.createElement("div");
    Object.assign(wrap.style, {
      width: "min(320px, 96vw)", boxSizing: "border-box", padding: "6px 10px",
      background: "rgba(255,255,255,0.03)", border: `1px solid ${color}`, borderRadius: "10px",
      display: "flex", flexDirection: "column", gap: "1px", textAlign: "left",
    } as Partial<CSSStyleDeclaration>);

    const head = document.createElement("div");
    Object.assign(head.style, { fontSize: "15px", fontWeight: "800", color, margin: "0 0 2px" });
    head.textContent = TEAM_NAMES[team];
    wrap.appendChild(head);

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
    row.dataset.dropTeam = String(team);   // drag-&-drop hit-testing
    row.dataset.dropIdx = String(i);
    Object.assign(row.style, {
      display: "grid", gridTemplateColumns: "28px 30px 1fr 30px 24px 40px 26px", gap: "6px",
      alignItems: "center", padding: "2px 6px", borderRadius: "6px",
      cursor: "grab", pointerEvents: "auto",
      background: "rgba(255,255,255,0.04)",
      border: "1px solid transparent",
    } as Partial<CSSStyleDeclaration>);

    const pos = document.createElement("span");
    Object.assign(pos.style, { fontSize: "10px", fontWeight: "800", color, border: `1px solid ${color}`, borderRadius: "5px", textAlign: "center", padding: "1px 0" });
    pos.textContent = def.role;

    // 評価ロール — a POS-chip-sized pill showing the current role as a short
    // code (full names live in the picker menu / hover card); pressing it
    // opens the picker. Switching re-evaluates OVR and the team bars.
    const curRole = def.evalRole ?? "自動";
    const roleSel = document.createElement("button");
    roleSel.textContent = curRole === "自動" ? "-" : (UI.EVAL_ROLES[curRole]?.short ?? "?");
    const on = curRole !== "自動";
    Object.assign(roleSel.style, {
      fontSize: "9px", fontWeight: on ? "800" : "600", width: "100%", boxSizing: "border-box",
      padding: "2px 0", borderRadius: "9px", cursor: "pointer", pointerEvents: "auto",
      whiteSpace: "nowrap", overflow: "hidden",
      background: on ? color : "rgba(20,24,34,0.9)",
      color: on ? "#0d1016" : "rgba(255,255,255,0.45)",
      border: on ? `1px solid ${color}` : "1px solid rgba(255,255,255,0.16)",
    } as Partial<CSSStyleDeclaration>);
    roleSel.onpointerdown = (e) => e.stopPropagation();
    roleSel.onclick = () => this.openRolePicker(def, team, roleSel);

    const name = document.createElement("span");
    Object.assign(name.style, { fontSize: "12px", fontWeight: "700", color: "#fff", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" });
    name.textContent = def.name;

    const ht = document.createElement("span");
    Object.assign(ht.style, { fontSize: "10px", opacity: "0.55", textAlign: "right" });
    ht.textContent = String(Math.round(def.height * 100));

    const num = document.createElement("span");
    Object.assign(num.style, { fontSize: "13px", fontWeight: "800", color: "#fff", textAlign: "right" });
    num.textContent = String(ovr);

    const track = document.createElement("div");
    Object.assign(track.style, { height: "6px", background: "rgba(255,255,255,0.1)", borderRadius: "3px", overflow: "hidden" } as Partial<CSSStyleDeclaration>);
    const fill = document.createElement("div");
    Object.assign(fill.style, { width: `${Math.max(4, Math.min(100, ((ovr - 40) / 59) * 100))}%`, height: "100%", background: color } as Partial<CSSStyleDeclaration>);
    track.appendChild(fill);

    // 詳細 — opens the full-ratings modal (all 25 ratings + 特殊能力)
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

    row.append(pos, roleSel, name, ht, num, track, det);
    row.onpointerdown = (e) => this.beginDrag(team, i, e);
    row.onmouseenter = () => { if (!this.dragFrom && !this.rolePicker && !this.detailModal) this.showPlayerCard(def, team, row); };
    row.onmouseleave = () => this.hidePlayerCard();
    return row;
  }

  // DRAG & DROP swap: grab a player's bar, carry it (it follows the cursor),
  // and drop it on a team-mate — starter ⇄ bench included — to exchange the
  // two roster slots. On touch a LONG-PRESS lifts the bar (a plain swipe still
  // scrolls the list).
  private beginDrag(team: number, idx: number, ev: PointerEvent): void {
    if (ev.pointerType === "mouse" && ev.button !== 0) return;
    const ox = ev.clientX, oy = ev.clientY;
    let lifted = false;
    let timer = 0;
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
      this.dragGhost.style.top = `${y - 18}px`;   // ride just above the pointer
      // light up the row it would swap with
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
    };
    const blockTouch = (te: TouchEvent) => { if (lifted) te.preventDefault(); };
    const move = (e: PointerEvent) => {
      if (!lifted) {
        // moved before the long-press fired → it's a scroll, not a drag
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
      this.dragFrom = null;
    };
    const up = (e: PointerEvent) => {
      const wasLifted = lifted;
      const t = wasLifted ? this.dropTargetAt(e.clientX, e.clientY) : null;
      teardown();
      if (t && t.team === team && t.idx !== idx) {
        const r = ROSTER[team];
        [r[idx], r[t.idx]] = [r[t.idx], r[idx]];
        this.refreshEditors();   // rosters AND the VS board (starters changed)
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", teardown);
    window.addEventListener("touchmove", blockTouch, { passive: false });
    if (ev.pointerType === "mouse") { ev.preventDefault(); lift(ox, oy); }
    else timer = window.setTimeout(() => lift(ox, oy), 280);
  }

  // The roster row under the pointer, if any (the ghost ignores pointer events,
  // so elementFromPoint sees straight through it).
  private dropTargetAt(x: number, y: number): { team: number; idx: number; el: HTMLElement } | null {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    const row = el?.closest("[data-drop-team]") as HTMLElement | null;
    if (!row) return null;
    return { team: Number(row.dataset.dropTeam), idx: Number(row.dataset.dropIdx), el: row };
  }

  // Floating role-picker menu: press the pill → choose the 評価ロール from a
  // list (the current one is lit in the team colour). Closes on pick or on any
  // press outside.
  private openRolePicker(def: PlayerDef, team: number, anchor: HTMLElement): void {
    this.closeRolePicker();
    this.hidePlayerCard();
    const color = colorOf(team);
    const menu = document.createElement("div");
    Object.assign(menu.style, {
      position: "fixed", zIndex: "80", display: "flex", flexDirection: "column", gap: "4px",
      background: "rgba(12,15,22,0.98)", border: "1px solid rgba(255,255,255,0.25)",
      borderRadius: "10px", padding: "7px", boxShadow: "0 12px 32px rgba(0,0,0,0.6)",
      pointerEvents: "auto",
    } as Partial<CSSStyleDeclaration>);
    const cur = def.evalRole ?? "自動";
    const mkBtn = (nm: string): HTMLDivElement => {
      const cell = document.createElement("div");
      Object.assign(cell.style, { display: "flex", alignItems: "center", gap: "4px" } as Partial<CSSStyleDeclaration>);
      const b = document.createElement("button");
      const on = nm === cur;
      b.textContent = nm;
      Object.assign(b.style, {
        flex: "1", fontSize: "11px", fontWeight: on ? "800" : "600", padding: "4px 10px",
        borderRadius: "8px", cursor: "pointer", whiteSpace: "nowrap", textAlign: "left",
        background: on ? color : "rgba(255,255,255,0.06)",
        color: on ? "#0d1016" : "#dfe4ee",
        border: on ? `1px solid ${color}` : "1px solid rgba(255,255,255,0.14)",
      } as Partial<CSSStyleDeclaration>);
      b.onclick = () => {
        def.evalRole = nm === "自動" ? undefined : nm;
        this.closeRolePicker();
        this.refreshEditors();   // OVR + team bars re-evaluate
      };
      cell.appendChild(b);
      // ⓘ — press (or hover) to read what the role means / what it rewards
      const tip = nm === "自動"
        ? "ポジション標準の重みで評価します（ロール未設定）。"
        : UI.EVAL_ROLES[nm]?.tip;
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
    // roles this POSITION can take...
    const posGrid = grid();
    for (const [nm, r] of Object.entries(UI.EVAL_ROLES)) {
      if (r.pos && r.pos.includes(def.role)) posGrid.appendChild(mkBtn(nm));
    }
    if (posGrid.childElementCount > 0) {
      menu.appendChild(header(`${def.role} のロール`));
      menu.appendChild(posGrid);
    }
    // ...and the modern position-crossing jobs, open to everyone
    const crossGrid = grid();
    for (const [nm, r] of Object.entries(UI.EVAL_ROLES)) {
      if (!r.pos) crossGrid.appendChild(mkBtn(nm));
    }
    menu.appendChild(header("全ポジション共通"));
    menu.appendChild(crossGrid);
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
  }

  // Full-ratings modal (the 詳 button): every one of the 25 ratings with a
  // value bar, the hexagon digest, and the 特殊能力 — over a dimmed backdrop.
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

    // phone: a tall single-column layout that stays inside the screen width;
    // desktop: chart and ratings side by side
    const phone = window.innerWidth < 640;
    const panel = document.createElement("div");
    Object.assign(panel.style, {
      background: "rgba(12,15,22,0.98)", border: "1px solid rgba(255,255,255,0.22)",
      borderRadius: "14px", padding: phone ? "12px 10px" : "14px 16px",
      boxShadow: "0 16px 48px rgba(0,0,0,0.65)",
      width: phone ? "96vw" : "auto", maxWidth: "96vw", maxHeight: "92vh",
      overflow: "auto", boxSizing: "border-box",
      display: "flex", flexDirection: "column", gap: "10px", textAlign: "left",
    } as Partial<CSSStyleDeclaration>);

    // header: POS name — height / OVR / role
    const head = document.createElement("div");
    Object.assign(head.style, { display: "flex", alignItems: "baseline", gap: "10px" } as Partial<CSSStyleDeclaration>);
    const nm = document.createElement("div");
    Object.assign(nm.style, { fontSize: "17px", fontWeight: "800", color, flex: "1" });
    nm.textContent = `${def.role}  ${def.name}`;
    const meta = document.createElement("div");
    Object.assign(meta.style, { fontSize: "12px", opacity: "0.8", whiteSpace: "nowrap" });
    const covers = this.coverablePositions(def);
    meta.textContent = `${Math.round(def.height * 100)}cm  OVR ${this.ovrOf(def)}`
      + (covers.length > 1 ? `  守れる: ${covers.join("/")}` : "")
      + (def.evalRole ? `  [${def.evalRole}]` : "");
    head.append(nm, meta);
    panel.appendChild(head);

    // hexagon digest + all 25 ratings: side by side on desktop, stacked into a
    // tall column on the phone (chart on top, ratings below, full width)
    const body = document.createElement("div");
    Object.assign(body.style, {
      display: "flex", gap: "12px", alignItems: phone ? "center" : "flex-start",
      flexDirection: phone ? "column" : "row", flexWrap: phone ? "nowrap" : "wrap",
      justifyContent: "center",
    } as Partial<CSSStyleDeclaration>);
    const cv = document.createElement("canvas");
    cv.width = 236; cv.height = 196;
    this.drawHexChart(cv, this.axesOf(def), color);
    body.appendChild(cv);

    const grid = document.createElement("div");
    Object.assign(grid.style, {
      display: "grid", gap: "6px 10px", width: phone ? "100%" : "auto",
      gridTemplateColumns: phone ? "repeat(3, minmax(0, 1fr))" : "repeat(5, minmax(84px, 1fr))",
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
    body.appendChild(grid);
    panel.appendChild(body);

    // 特殊能力 chips (with their explanations on hover)
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

  // The hover detail card: hexagon chart of the six digests + 特殊能力 chips.
  private showPlayerCard(def: PlayerDef, team: number, anchor: HTMLElement): void {
    const color = colorOf(team);
    const card = this.playerCard;
    card.replaceChildren();

    const head = document.createElement("div");
    Object.assign(head.style, { display: "flex", alignItems: "baseline", gap: "8px", marginBottom: "2px" } as Partial<CSSStyleDeclaration>);
    const nm = document.createElement("div");
    Object.assign(nm.style, { fontSize: "14px", fontWeight: "800", color, flex: "1", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" });
    nm.textContent = `${def.role}  ${def.name}`;
    const meta = document.createElement("div");
    Object.assign(meta.style, { fontSize: "11px", opacity: "0.75", whiteSpace: "nowrap" });
    meta.textContent = `${Math.round(def.height * 100)}cm  OVR ${this.ovrOf(def)}`
      + (def.evalRole ? `  [${def.evalRole}]` : "");
    head.append(nm, meta);
    card.appendChild(head);

    // multi-position defenders wear it proudly
    const covers = this.coverablePositions(def);
    if (covers.length > 1) {
      const cv2 = document.createElement("div");
      Object.assign(cv2.style, { fontSize: "10px", opacity: "0.7", margin: "0 0 2px" });
      cv2.textContent = `守れるポジション: ${covers.join(" / ")}`;
      card.appendChild(cv2);
    }

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

    // float ABOVE the hovered row (its bottom edge just over the name), so the
    // row itself — name, role pill, 詳 — is never covered and stays clickable.
    // If there's no room above, flip below the row instead.
    card.style.display = "block";
    const r = anchor.getBoundingClientRect();
    const cw = 260;
    const ch = card.offsetHeight || 320;
    let left = r.left + r.width / 2 - cw / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - cw - 8));
    let top = r.top - ch - 8;
    if (top < 8) top = Math.min(window.innerHeight - ch - 8, r.bottom + 8);
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
  }

  private hidePlayerCard(): void {
    this.playerCard.style.display = "none";
  }

  // The hexagon (radar) chart: recessive grid rings + spokes, one data polygon
  // in the team colour, axis labels and exact values in plain ink.
  private drawHexChart(cv: HTMLCanvasElement, axes: number[], color: string): void {
    const ctx = cv.getContext("2d")!;
    const cx = cv.width / 2, cy = cv.height / 2 + 2, R = 60;
    const pt = (i: number, r: number): [number, number] => {
      const a = -Math.PI / 2 + (i * Math.PI) / 3;
      return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
    };
    ctx.clearRect(0, 0, cv.width, cv.height);
    // grid: three rings + spokes, kept faint so the data reads first
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
    // data polygon — the DB's ratings live in a compressed ~40..99 band, so
    // that band is spread over the radius (exact values are printed below)
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
    // labels + values in ink, never the series colour
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
    Object.assign(this.resultScore.style, { fontSize: "32px", fontWeight: "800" });

    this.resultWinner = document.createElement("div");
    Object.assign(this.resultWinner.style, { fontSize: "20px", fontWeight: "800", letterSpacing: "1px" });

    this.resultStats = document.createElement("div");
    Object.assign(this.resultStats.style, { display: "flex", flexDirection: "column", gap: "12px", width: "100%" });

    const back = this.button("← BACK");
    Object.assign(back.style, { fontSize: "16px", padding: "10px 26px", marginTop: "4px" });
    back.onclick = () => {
      this.setPhase("pregame");
      this.newMatchup();   // 毎試合ランダム編成 — a fresh draw for the next game
      this.onBack();
    };

    p.append(title, this.resultScore, this.resultWinner, this.resultStats, back);
    this.root.appendChild(p);
    this.resultPanel = p;
  }

  private setPhase(phase: Phase): void {
    this.phase = phase;
    this.hud.style.display = phase === "playing" ? "block" : "none";
    this.pregamePanel.style.display = phase === "pregame" ? "flex" : "none";
    this.resultPanel.style.display = phase === "result" ? "flex" : "none";
  }

  private showResult(game: Game): void {
    const [a, b] = game.score;
    this.resultScore.textContent = `${TEAM_NAMES[0]}  ${a} - ${b}  ${TEAM_NAMES[1]}`;
    if (a === b) {
      this.resultWinner.textContent = "DRAW";
      this.resultWinner.style.color = "#fff";
    } else {
      const w = a > b ? 0 : 1;
      this.resultWinner.textContent = `${TEAM_NAMES[w]} WINS`;
      this.resultWinner.style.color = colorOf(w);
    }

    this.resultStats.replaceChildren();
    for (let t = 0; t < 2; t++) this.resultStats.appendChild(this.statsTable(game, t));
    this.setPhase("result");
  }

  private statsTable(game: Game, team: number): HTMLDivElement {
    const wrap = document.createElement("div");
    Object.assign(wrap.style, { width: "100%" });

    const head = document.createElement("div");
    Object.assign(head.style, { fontSize: "14px", fontWeight: "800", color: colorOf(team), textAlign: "left", margin: "2px 0" });
    head.textContent = TEAM_NAMES[team];
    wrap.appendChild(head);

    const scroller = document.createElement("div");
    Object.assign(scroller.style, { width: "100%", overflowX: "auto", paddingBottom: "4px" } as Partial<CSSStyleDeclaration>);
    const table = document.createElement("div");
    Object.assign(table.style, { width: "max-content" } as Partial<CSSStyleDeclaration>);

    const cols = document.createElement("div");
    Object.assign(cols.style, { display: "flex", gap: "4px", fontSize: "10px", opacity: "0.6", margin: "1px 0" });
    cols.appendChild(this.cell("", 130));   // must match the name-cell width below
    for (const c of STAT_COLS) cols.appendChild(this.cell(c.label, 38, "center"));
    table.appendChild(cols);

    for (const pl of game.allPlayers(team)) {
      const row = document.createElement("div");
      Object.assign(row.style, { display: "flex", gap: "4px", fontSize: "12px", margin: "1px 0" });
      const nm = this.cell(`${pl.role} ${pl.name}`, 130);
      nm.style.opacity = pl.idx < STARTERS ? "0.95" : "0.7"; // bench slightly dimmed
      row.appendChild(nm);
      for (const c of STAT_COLS) {
        row.appendChild(this.cell(fmtStat(c.key, pl.stats[c.key]), 38, "center"));
      }
      table.appendChild(row);
    }
    scroller.appendChild(table);
    wrap.appendChild(scroller);
    return wrap;
  }

  // ---- small builders ----------------------------------------------------

  private cell(text: string, width: number, align: string = "left"): HTMLSpanElement {
    const el = document.createElement("span");
    Object.assign(el.style, { width: `${width}px`, flexShrink: "0", textAlign: align, display: "inline-block" } as Partial<CSSStyleDeclaration>);
    el.textContent = text;
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

  // ---- bottom player bars (face icons per team, on-court ⇄ bench tabs) ----

  private buildPlayerBars(): void {
    // flank the speed / RESTART row: team 0's icons grow leftward from just left
    // of centre, team 1's grow rightward from just right of centre, leaving a
    // fixed central gap for the controls — anchored to centre so the gap stays
    // put no matter how many icons each side shows (on-court 5 vs bench 8).
    const HALF_GAP = "130px";   // half the central gap reserved for the controls
    for (let t = 0; t < 2; t++) {
      const panel = document.createElement("div");
      Object.assign(panel.style, {
        position: "absolute", bottom: "16px",
        ...(t === 0 ? { right: `calc(50% + ${HALF_GAP})` } : { left: `calc(50% + ${HALF_GAP})` }),
        display: "flex", flexDirection: "column", gap: "5px",
        alignItems: t === 0 ? "flex-end" : "flex-start",   // hug the centre
        pointerEvents: "none",                              // icons don't block the camera drag
      } as Partial<CSSStyleDeclaration>);

      // tab row: ON COURT / BENCH
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
      Object.assign(row.style, { display: "flex", gap: "6px" } as Partial<CSSStyleDeclaration>);
      this.iconRows[t] = row;

      // tabs on top, icon row beneath (both teams)
      panel.appendChild(tabs);
      panel.appendChild(row);
      this.iconPanels[t] = panel;
      this.hud.appendChild(panel);
    }
  }

  // A small face avatar: team-coloured disc, a simple generated head, and the
  // jersey number, with the player's name beneath. No portrait art exists, so
  // the face is drawn procedurally and the number/name identify the player.
  private makeFaceIcon(player: import("./entities").Player): HTMLDivElement {
    const wrap = document.createElement("div");
    Object.assign(wrap.style, {
      width: "48px", flex: "0 0 auto", display: "flex", flexDirection: "column",
      alignItems: "center", gap: "2px",
      pointerEvents: "auto", cursor: "help",   // hover shows the player's box score
    } as Partial<CSSStyleDeclaration>);
    wrap.onmouseenter = () => this.showStatTip(player, wrap);
    wrap.onmouseleave = () => this.hideTip();

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

    const num = document.createElement("div");
    num.textContent = String(player.idx + 1);
    Object.assign(num.style, {
      position: "absolute", right: "0", bottom: "0", minWidth: "15px", height: "15px",
      lineHeight: "15px", padding: "0 2px", fontSize: "10px", fontWeight: "800",
      textAlign: "center", color: "#fff", background: colorOf(player.team),
      borderTopLeftRadius: "6px",
    } as Partial<CSSStyleDeclaration>);
    face.appendChild(num);
    wrap.appendChild(face);

    const name = document.createElement("div");
    name.textContent = player.name;
    Object.assign(name.style, {
      maxWidth: "50px", fontSize: "9px", fontWeight: "600", color: "#e8ecf4",
      whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
      textShadow: "0 1px 3px rgba(0,0,0,0.9)",
    } as Partial<CSSStyleDeclaration>);
    wrap.appendChild(name);
    return wrap;
  }

  private drawFace(canvas: HTMLCanvasElement, player: import("./entities").Player): void {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const W = canvas.width, H = canvas.height;
    const tc = TEAM_COLORS[player.team];
    // team-tinted background disc
    ctx.fillStyle = `rgb(${Math.round(tc.r * 120 + 25)},${Math.round(tc.g * 120 + 25)},${Math.round(tc.b * 120 + 25)})`;
    ctx.fillRect(0, 0, W, H);
    // deterministic variety per player so faces aren't all identical
    const h = (player.idx * 2654435761) >>> 0;
    const skins = ["#f2cfa8", "#e6b48c", "#cf9a6a", "#a9713f", "#8a5a2b"];
    const hairs = ["#20140a", "#3a2413", "#0e0e0e", "#5a3a1c", "#7a5230"];
    const skin = skins[h % skins.length];
    const hair = hairs[(h >> 3) % hairs.length];
    // head
    ctx.fillStyle = skin;
    ctx.beginPath(); ctx.arc(W / 2, H * 0.52, W * 0.30, 0, Math.PI * 2); ctx.fill();
    // hair cap
    ctx.fillStyle = hair;
    ctx.beginPath(); ctx.arc(W / 2, H * 0.46, W * 0.31, Math.PI * 1.05, Math.PI * 1.95); ctx.fill();
    // eyes
    ctx.fillStyle = "#26211c";
    ctx.beginPath(); ctx.arc(W * 0.41, H * 0.52, 1.7, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(W * 0.59, H * 0.52, 1.7, 0, Math.PI * 2); ctx.fill();
    // mouth
    ctx.strokeStyle = "rgba(80,40,30,0.8)"; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.arc(W / 2, H * 0.60, W * 0.10, 0.15 * Math.PI, 0.85 * Math.PI); ctx.stroke();
  }

  // Responsive layout. On a phone-width screen both teams' face icons meet at the
  // centre-bottom in one row (shrunk to fit — see refreshPlayerBars); on a wide
  // screen they flank the centre. The controls live in the top hamburger either
  // way, so they don't move.
  private applyLayout(): void {
    const mode = window.innerWidth < 640 ? "phone" : "desktop";
    if (mode === this.layoutMode) return;
    this.layoutMode = mode;
    const [p0, p1] = this.iconPanels;
    const [r0, r1] = this.iconRows;
    if (mode === "phone") {
      // ONE row: the two teams meet at the centre-bottom. Per-team sizing (fit
      // the on-court 5 by shrinking / scroll the full-size bench) is done every
      // frame in refreshPlayerBars, since it depends on the active tab.
      if (p0) Object.assign(p0.style, { right: "50%", left: "auto", bottom: "6px", transformOrigin: "bottom right", alignItems: "flex-end", maxWidth: "" });
      if (p1) Object.assign(p1.style, { left: "50%", right: "auto", bottom: "6px", transformOrigin: "bottom left", alignItems: "flex-start", maxWidth: "" });
      for (const r of [r0, r1]) if (r) Object.assign(r.style, { overflowY: "hidden", scrollbarWidth: "thin", paddingBottom: "2px" } as Partial<CSSStyleDeclaration>);
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
      // highlight the active tab
      this.iconTabs[t].forEach((b, ti) => {
        const active = (ti === 1) === this.showBench[t];
        b.style.background = active ? colorOf(t) : "rgba(20,24,34,0.85)";
        b.style.opacity = active ? "1" : "0.7";
      });
      // which players to show: the current on-court five, or the eight on the bench
      const onCourt = game.players.filter((p) => p.team === t);
      const set = new Set(onCourt);
      const list = this.showBench[t] ? game.roster[t].filter((p) => !set.has(p)) : onCourt;
      // phone: ONE row, two teams side by side. Icons are ALWAYS full size — the
      // row just scrolls horizontally (swipe) within the team's half when the
      // icons don't all fit. Never scaled.
      const rw = this.iconRows[t];
      if (rw) {
        if (this.layoutMode === "phone") {
          Object.assign(rw.style, { maxWidth: "49vw", overflowX: "auto", pointerEvents: "auto" });
        } else {
          Object.assign(rw.style, { maxWidth: "", overflowX: "visible", pointerEvents: "" });
        }
      }
      // rebuild only when the shown set (or tab) changes — subs swap the five
      const key = `${this.showBench[t] ? "B" : "C"}:${list.map((p) => p.idx).join(",")}`;
      if (key === this.iconKey[t]) continue;
      this.iconKey[t] = key;
      const row = this.iconRows[t];
      this.hideTip();   // a hovered icon may be getting replaced — drop its tip
      row.replaceChildren();
      for (const p of list) {
        const el = this.makeFaceIcon(p);
        this.iconEl.set(p, el);   // remember it so stat pops can anchor above it
        row.appendChild(el);
      }
    }
  }

  // Floating "＋" badges: compare each player's box score to last frame and pop a
  // badge over his icon for anything he just earned (score/assist/rebound/etc.).
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
          snap![i] = cur;   // re-baseline (also absorbs a restart's reset to 0)
        });
      }
    }
  }

  private popStat(player: import("./entities").Player, label: string, delta: number,
                  color: string, stack: number): void {
    const icon = this.iconEl.get(player);
    if (!icon || !icon.isConnected) return;   // only when the icon is actually on screen
    const hb = this.hud.getBoundingClientRect();
    const r = icon.getBoundingClientRect();
    if (r.width === 0) return;                 // hidden / not laid out
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
    requestAnimationFrame(() => {   // next frame → animate up and fade, then remove
      badge.style.opacity = "0";
      badge.style.transform = "translate(-50%,-32px)";
    });
    setTimeout(() => badge.remove(), 1200);
  }

  update(game: Game): void {
    if (this.phase === "playing" && game.state === "final") this.showResult(game);

    this.applyLayout();
    this.refreshPlayerBars(game);
    this.updateStatPops(game);
    this.scoreA.textContent = String(game.score[0]);
    this.scoreB.textContent = String(game.score[1]);
    const t = Math.max(0, game.gameClock);
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    this.clock.textContent = `${m}:${s.toString().padStart(2, "0")}`;
    this.quarter.textContent = game.state === "final" ? "FINAL" : `Q${game.quarter}`;
    this.shot.textContent = String(Math.max(0, Math.ceil(game.shotClock)));

    if (game.lastEvent) {
      const ev = game.lastEvent;
      const c = TEAM_COLORS[ev.team];
      // rebuild the banner only when the event changes, so it doesn't churn the
      // DOM every frame while a banner is up
      const key = `${ev.text}|${ev.scorer ?? ""}|${ev.assist ?? ""}`;
      if (key !== this.bannerKey) {
        this.bannerKey = key;
        this.banner.replaceChildren();
        const main = document.createElement("div");
        main.textContent = ev.text;
        this.banner.appendChild(main);
        // on a made basket, credit who scored (and who assisted) underneath
        if (ev.scorer) {
          const sc = document.createElement("div");
          Object.assign(sc.style, { fontSize: "clamp(16px,3.4vw,26px)", fontWeight: "700", letterSpacing: "1px", marginTop: "8px" });
          sc.textContent = ev.scorer;
          this.banner.appendChild(sc);
        }
        if (ev.assist) {
          const as = document.createElement("div");
          Object.assign(as.style, { fontSize: "clamp(13px,2.5vw,19px)", fontWeight: "600", letterSpacing: "1px", marginTop: "3px", opacity: "0.85" });
          as.textContent = `アシスト  ${ev.assist}`;
          this.banner.appendChild(as);
        }
      }
      this.banner.style.color = `rgb(${c.r * 255},${c.g * 255},${c.b * 255})`;
      this.banner.style.opacity = "0.95";
    } else {
      this.banner.style.opacity = "0";
      this.bannerKey = "";
    }

    // substitution feed: one chip per swap, at most the 3 most recent. When more
    // pile up, the oldest shown one fades out and the rest shift up to take its
    // place (a scrolling notification stack).
    this.subFeed.replaceChildren();
    const shownSubs = game.subEvents.slice(-3);
    const subOverflow = game.subEvents.length > 3;
    for (let si = 0; si < shownSubs.length; si++) {
      const e = shownSubs[si];
      const color = colorOf(e.team);
      // the top (oldest shown) chip fades as it is pushed out by newer swaps
      let op = Math.min(1, e.ttl / 0.8);
      if (subOverflow && si === 0) op = Math.min(op, 0.35);
      const chip = document.createElement("div");
      Object.assign(chip.style, {
        background: "rgba(12,15,22,0.86)", border: `1px solid ${color}`,
        borderRadius: "10px", padding: "clamp(5px,1vw,8px) clamp(12px,2.8vw,22px)",
        textAlign: "center", opacity: String(op),
        boxShadow: "0 6px 20px rgba(0,0,0,0.45)", maxWidth: "94vw",
      } as Partial<CSSStyleDeclaration>);
      const title = document.createElement("div");
      // responsive: full size on a wide view, shrinks as the window narrows
      Object.assign(title.style, { fontSize: "clamp(9px,1.7vw,13px)", opacity: "0.7", letterSpacing: "3px", fontWeight: "700" });
      title.textContent = "メンバーチェンジ";
      const line = document.createElement("div");
      Object.assign(line.style, {
        fontSize: "clamp(15px,3.4vw,26px)", fontWeight: "800", color, letterSpacing: "1px",
        textShadow: "0 3px 12px rgba(0,0,0,0.5)", whiteSpace: "nowrap",
      });
      line.textContent = e.text;
      chip.append(title, line);
      this.subFeed.appendChild(chip);
    }
  }
}
