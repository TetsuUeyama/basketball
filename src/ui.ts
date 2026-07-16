import { Game } from "./game";
import { TEAM_NAMES, TEAM_COLORS, HUD_OPTS } from "./config";
import { ROSTER, ROSTER_SIZE, STARTERS, randomizeRosters, randomizeTeam, applyDbPlayer, makeDefFromDb, ATTR_META, ABILITY_META, scoringPower, type Attributes, type PlayerDef } from "./attributes";
import { PLAYER_DB, type DbPlayer } from "./playerdb";
import { playerLook } from "./util";

const colorOf = (team: number): string => {
  const c = TEAM_COLORS[team];
  return `rgb(${c.r * 255},${c.g * 255},${c.b * 255})`;
};

type Phase = "pregame" | "playing" | "result";

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
  // result-screen tabs: team comparison ⇄ each team's box score
  private resultGame: Game | null = null;
  private resultTab: "team" | "blue" | "red" = "team";
  private resultContent: HTMLDivElement | null = null;
  private resultTabBtns: { key: "team" | "blue" | "red"; el: HTMLButtonElement }[] = [];
  private tooltip!: HTMLDivElement;
  private tipHideT = 0;   // pending grace-period hide (see scheduleHideTip)
  private tipTitle!: HTMLDivElement;
  private tipBody!: HTMLDivElement;

  private scoreA: HTMLSpanElement;
  private scoreB: HTMLSpanElement;
  private clock: HTMLSpanElement;
  private quarter: HTMLSpanElement;
  private shot: HTMLSpanElement;
  private shotBox!: HTMLDivElement;   // shot-clock container — flashes in the last 3s
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
  private iconStamina = new Map<import("./entities").Player, { bar: HTMLDivElement; fill: HTMLDivElement }>(); // player → its icon stamina bar
  private staminaBtn: HTMLButtonElement | null = null;   // HUD toggle: gauge on name tag ⇄ face icon
  private namesBtn: HTMLButtonElement | null = null;     // HUD toggle: on-court name tags on ⇄ off
  private modelBtn: HTMLButtonElement | null = null;     // HUD toggle: 人型 ⇄ どんぐり体形
  private statSnap = new Map<import("./entities").Player, number[]>();     // last-seen POP_STATS values
  private controls!: HTMLDivElement;      // speed / RESTART row
  private menuBtn!: HTMLButtonElement;    // ☰ hamburger — rides the top edge until the scoreboard reaches it
  private camHint!: HTMLDivElement;       // "drag: orbit" hint — kept level with the ☰ on the left
  private board!: HTMLDivElement;         // centred scoreboard (its width decides where the ☰ can sit)
  private iconPanels: HTMLDivElement[] = []; // the two team face-icon panels
  private layoutMode = "";                // "desktop" | "phone" — recomputed on resize

  private phase: Phase = "pregame";
  private playerCard!: HTMLDivElement;  // floating pregame detail card (hex chart)
  private vsBoard: HTMLDivElement | null = null;  // VS strength board (avoid overlapping it)
  private vsPreviewActive = false;                // a swap/role preview is currently on the board
  private dragFrom: { team: number; idx: number } | null = null; // bar being carried
  private dragGhost: HTMLDivElement | null = null;               // the carried name bar
  private dragHl: HTMLElement | null = null;                     // highlighted drop row
  // "carry" mode: an incoming DB player follows the cursor until dropped on a
  // roster row of his team to replace that player (started from the picker).
  private carry: { team: number; dbp: DbPlayer } | null = null;
  private carryGhost: HTMLDivElement | null = null;
  private carryHint: HTMLDivElement | null = null;
  private carryHl: HTMLElement | null = null;
  private carryCleanup: (() => void) | null = null;
  private rolePicker: HTMLDivElement | null = null;              // open 評価ロール menu
  private rolePickerCloser: ((e: PointerEvent) => void) | null = null;
  private detailModal: HTMLDivElement | null = null;             // full-ratings modal
  private playerPicker: HTMLDivElement | null = null;            // 4000+選手データベースからの選手交代モーダル
  // Cached, OVR-sorted view of the whole database (built once on first open):
  // { p, ovr, lower(name) } so keystroke filtering is a plain array scan.
  private dbIndex: { p: DbPlayer; ovr: number; lower: string }[] | null = null;
  private rosterTab = 0;         // phone: which team's roster card is shown
  private pregameMode = "";      // "phone" | "desktop" — re-render on crossing 640px

  speed = 1;
  onRestart: () => void = () => {};
  onStart: () => void = () => {};
  onBack: () => void = () => {};
  onModelToggle: () => void = () => {};   // apply HUD_OPTS.model to every player

  get playing(): boolean {
    return this.phase === "playing";
  }

  constructor() {
    const css = (el: HTMLElement, s: Partial<CSSStyleDeclaration>) => Object.assign(el.style, s);

    // scrollable rows that must NOT grow when the scrollbar appears (the icon
    // rows swap between a fitting and an overflowing list) hide the bar itself
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

    // ---- scoreboard ----
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
    this.shotBox = sc;

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

    // ---- controls: a hamburger menu at the right. It rides the top edge (level
    // with the scoreboard) on a wide screen, and only drops below the board when
    // the centred scoreboard grows wide enough to reach it (see positionMenu). ----
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
      HUD_OPTS.rev++;                 // force every name tag to repaint
      this.iconKey = ["", ""];        // force the icon rows to rebuild (bar shows/hides)
      this.refreshStaminaBtn();
    };
    controls.appendChild(staminaBtn);

    // コート上の名前タグの表示オン/オフ
    const namesBtn = this.button("");
    this.namesBtn = namesBtn;
    this.refreshNamesBtn();
    namesBtn.onclick = () => {
      HUD_OPTS.showNames = !HUD_OPTS.showNames;
      HUD_OPTS.rev++;                 // force every name tag to repaint (applies visibility)
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
    // top-LEFT, kept level with the ☰ (positionMenu syncs its top). The bottom
    // is taken by the face-icon HUD and the centred scoreboard overlaps a fixed
    // top:10px, so it rides the same row as the menu, on the opposite side.
    css(hint, {
      position: "absolute", top: "14px", left: "12px", fontSize: "12px",
      opacity: "0.5", pointerEvents: "none",
    });
    hint.textContent = "drag: orbit  ·  wheel: zoom";
    this.hud.appendChild(hint);
    this.camHint = hint;

    this.buildPlayerBars();
    this.buildTooltip();
    this.buildPregame();
    this.buildResult();
    this.refreshSpeed();
    this.setPhase("pregame");
    // rects are only valid after the first layout pass
    requestAnimationFrame(() => this.positionMenu());
    window.addEventListener("resize", () => this.positionMenu());
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
    // the stat tip carries a button, so the tip itself must survive the mouse
    // travelling onto it (hide is scheduled with a grace period instead)
    tip.onmouseenter = () => { if (this.tipHideT) { window.clearTimeout(this.tipHideT); this.tipHideT = 0; } };
    tip.onmouseleave = () => this.hideTip();
    document.body.appendChild(tip);
    this.tooltip = tip;
  }

  // Same floating tooltip, but with free-form title/body (role explanations
  // and the like — anything not registered in INFO).
  private showTextTip(title: string, body: string, anchor: HTMLElement): void {
    // showing a fresh tip cancels any pending grace-period hide left over from
    // the icon/anchor the mouse just left — otherwise that stale timer fires
    // and hides THIS tip (the "appears then vanishes" flicker between icons)
    if (this.tipHideT) { window.clearTimeout(this.tipHideT); this.tipHideT = 0; }
    this.tipTitle.style.color = "#fff";
    this.tipTitle.textContent = title;
    this.tipBody.textContent = body;
    const tip = this.tooltip;
    tip.style.pointerEvents = "none";   // a plain text tip carries no button
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
    if (this.tipHideT) { window.clearTimeout(this.tipHideT); this.tipHideT = 0; }
    this.tooltip.style.display = "none";
    this.tooltip.style.pointerEvents = "none";
  }

  /** Hide the tooltip after a short grace period — cancelled if the mouse
   *  arrives on the tooltip itself (it may hold a button). */
  private scheduleHideTip(): void {
    if (this.tipHideT) window.clearTimeout(this.tipHideT);
    this.tipHideT = window.setTimeout(() => { this.tipHideT = 0; this.hideTip(); }, 200);
  }

  // Hover a player icon → show his live box score, floated ABOVE the icon (the
  // icons sit near the bottom of the screen).
  private showStatTip(player: import("./entities").Player, anchor: HTMLElement): void {
    // cancel a stale grace-period hide from the icon just left (see showTextTip)
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
    // ステータス確認 → the pregame full-ratings modal (25 ratings, hexagon,
    // 特殊能力 and the hand-set 評価ロール) for this player
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
    tip.style.pointerEvents = "auto";   // the button must be clickable
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

    // the pregame modal hugs its content: no padding / no inter-element gap so
    // there is no empty band above, below or beside the rosters
    p.style.padding = "0";
    p.style.gap = "0";                  // overflow stays auto (tall rosters scroll)
    // no title row — the modal opens straight into the buttons and rosters
    this.editorHost = document.createElement("div");
    Object.assign(this.editorHost.style, {
      width: "100%", display: "flex", flexDirection: "column", alignItems: "stretch", gap: "0",
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

    // TIP OFF is no longer a top row — it sits BETWEEN the two teams, built
    // inside refreshEditors so it lands between the cards (side-by-side) or
    // between the team tabs (narrow toggle view).

    this.root.appendChild(p);
    this.pregamePanel = p;
    // crossing the side-by-side / tab-toggle breakpoint re-lays-out the rosters
    window.addEventListener("resize", () => {
      if (this.phase !== "pregame") return;
      const mode = this.rostersFitSideBySide() ? "desktop" : "phone";
      if (mode !== this.pregameMode) this.refreshEditors();
    });
    this.newMatchup();   // the first matchup is drawn at once
  }

  /** Draw a fresh random matchup from the database and rebuild the editors. */
  private newMatchup(): void {
    randomizeRosters();
    this.autoAssignRoles();        // sensible default 攻守ロール for the fresh draw
    this.autoAssignChoiceRanks();  // primary 1..5 by scoring ability (starters + bench)
    this.refreshEditors();
  }

  /** Re-draw ONE team's roster (the other team is left untouched) and rebuild. */
  private randomizeOne(team: number): void {
    randomizeTeam(team);
    this.autoAssignRoles(team);        // default 攻守ロール for this team's fresh draw
    this.autoAssignChoiceRanks(team);  // primary 1..5 for this team only
    this.refreshEditors();
  }

  /** Re-optimise ONE team's 攻守ロール + primary order for its CURRENT roster —
   *  handy after swapping players in/out — without changing who is on the team. */
  private reassignRoles(team: number): void {
    this.autoAssignRoles(team);
    this.autoAssignChoiceRanks(team);
    this.refreshEditors();
  }

  // Hand every player a default 評価ロール from the fresh draw: the role his
  // profile fits best among those his position can take, with a team-balance
  // penalty so five エース never happens — the roles spread across the squad.
  // Starters are assigned first (they define the team's shape), then the bench.
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
          if (UI.DEF_ONLY.has(nm)) continue;   // defence jobs live in the DEF role now
          if (r.pos && !r.pos.includes(def.role)) continue;
          let s = r.ht * hs, tot = r.ht;
          for (let k = 0; k < ax.length; k++) { s += r.ax[k] * ax[k]; tot += r.ax[k]; }
          s /= tot;
          s -= (taken.get(nm) ?? 0) * 4;   // balance: each repeat costs 4 pts
          if (s > bestS) { bestS = s; best = nm; }
        }
        def.evalRole = best || undefined;
        def.defRole = this.pickDefRole(def);   // sensible default DEFENSE role too
        if (best) taken.set(best, (taken.get(best) ?? 0) + 1);
      }
    }
  }

  // The big blue "start the game" button — placed BETWEEN the two teams (in the
  // middle of the side-by-side view, or between the team tabs when narrow).
  private tipOffButton(): HTMLButtonElement {
    const b = this.button("TIP OFF");
    Object.assign(b.style, {
      fontSize: "clamp(13px,3.3vw,17px)", fontWeight: "800", flexShrink: "0",
      padding: "clamp(7px,1.8vw,11px) clamp(14px,3.4vw,24px)",
      // neutral silver — belongs to neither the RED nor the BLUE team, so the
      // tip-off reads as fair rather than favouring the blue side
      background: "rgba(232,235,242,0.96)", color: "#10131a",
      border: "1px solid rgba(255,255,255,0.5)",
    } as Partial<CSSStyleDeclaration>);
    b.onclick = () => { this.setPhase("playing"); this.onStart(); };
    return b;
  }

  // Two 320px cards + the TIP OFF column + gaps ≈ 760px of content; with the
  // modal capped at 96vw plus its padding, that only fits once the viewport is
  // ~830px wide. Below that the modal can't hold both, so we fall back to the
  // tab toggle rather than let the cards overflow / wrap.
  private rostersFitSideBySide(): boolean {
    return window.innerWidth >= 840;
  }

  /** Rebuild the VS board and both roster cards from the current ROSTER. */
  private refreshEditors(): void {
    this.hidePlayerCard();
    this.closeRolePicker();
    this.closeDetailModal();
    this.closePlayerPicker();
    const sideBySide = this.rostersFitSideBySide();
    this.pregameMode = sideBySide ? "desktop" : "phone";
    // side-by-side: hug the two-column content; toggle view: a fixed comfortable
    // width that both the VS board and the single card fill edge-to-edge
    this.editorHost.style.width = sideBySide ? "auto" : "min(560px, 96vw)";
    this.editorHost.replaceChildren();
    this.vsBoard = this.buildVsBoard();
    if (sideBySide) {
      // full-width bars over the two-column layout look stretched — cap the VS
      // board and centre it above the rosters
      this.vsBoard.style.width = "min(560px, 100%)";
      this.vsBoard.style.alignSelf = "center";
    }
    this.editorHost.appendChild(this.vsBoard);

    if (!sideBySide) {
      // one roster at a time behind team tabs — two stacked 13-man cards would
      // scroll forever on a phone. TIP OFF sits between the two team tabs.
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
      tabs.append(teamTab(0), this.tipOffButton(), teamTab(1));
      this.editorHost.appendChild(tabs);
      const card = this.rosterCard(this.rosterTab);
      card.style.width = "100%";   // fill the modal width (no side band under the VS board)
      this.editorHost.appendChild(card);
      return;
    }

    // side by side: [team 0 card] [TIP OFF] [team 1 card]
    const cols = document.createElement("div");
    Object.assign(cols.style, {
      display: "flex", gap: "12px", flexWrap: "nowrap", justifyContent: "center",
      alignItems: "stretch", width: "100%",
    } as Partial<CSSStyleDeclaration>);
    const mid = document.createElement("div");
    Object.assign(mid.style, { display: "flex", alignItems: "center", flexShrink: "0" } as Partial<CSSStyleDeclaration>);
    mid.appendChild(this.tipOffButton());
    cols.append(this.rosterCard(0), mid, this.rosterCard(1));
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
  // player rates differently as an エース than as a 3&D piece. Roles also
  // CHANGE IN-GAME BEHAVIOUR via ROLE_BEHAVIOR in attributes.ts (virtual
  // abilities + priority/playmaking shifts, applied at tip-off in applyDef).
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

  // Roles from EVAL_ROLES that are actually DEFENCE jobs — they now live in the
  // DEFENSE picker (def.defRole), not the offence one, so exclude them from the
  // offence picker and the offence auto-assign.
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

  // Auto-assign the OFFENCE choice order (primary 1..5) from scoring ability, so
  // the ball is funnelled to the best scorers by default. Starters and the bench
  // are ranked SEPARATELY (each 1..5), so a starter's "1" and a bench "1" can
  // coexist — that's fine (they're never on the floor as two #1s unless the user
  // wants it; the engine treats a genuine tie as a shared co-primary).
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
  // Rank ONE freshly-placed player among his unit by ability (used on a swap, so
  // teammates' hand-set ranks are left alone). Ties are allowed.
  private assignRankFor(def: PlayerDef, team: number, idx: number): void {
    const grp = idx < STARTERS ? ROSTER[team].slice(0, STARTERS) : ROSTER[team].slice(STARTERS);
    const mine = scoringPower(def.attr);
    let higher = 0;
    for (const d of grp) if (d !== def && scoringPower(d.attr) > mine) higher++;
    def.choiceRank = Math.min(higher + 1, 5);
  }

  // Best OFFENCE role for one player from his rating axes (no team balancing —
  // used on a single swap; autoAssignRoles does the team-wide balanced version).
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

  // Auto default DEFENSE role from a player's ratings: a strong defender locks
  // down (two-way if he's also a scorer), a rim-protecting big anchors, a high-
  // usage offensive specialist conserves (省エネ), everyone else is バランス.
  private pickDefRole(def: PlayerDef): string {
    const a = def.attr;
    const defSkill = (a.defense + a.reaction + a.agility) / 300;      // 0..1
    const offSkill = (a.aggression + a.threeAcc + a.midAcc) / 300;    // 0..1
    const big = def.role === "PF" || def.role === "C";
    if (big && (a.jump + a.dunk) / 200 > 0.64 && defSkill > 0.58) return "リムプロテクター";
    if (defSkill > 0.68) return offSkill > 0.66 ? "ハッスルディフェンダー" : "ロックダウン";
    if (offSkill > 0.66 && defSkill < 0.55) return "省エネ";
    return "バランス";
  }

  // The weights actually used for a player: his hand-set 評価ロール, or his
  // position's profile when left on 自動.
  private effWeights(def: PlayerDef): { ax: number[]; ht: number } {
    return (def.evalRole && UI.EVAL_ROLES[def.evalRole])
      || UI.ROLE_W[def.role] || UI.ROLE_W.SF;
  }

  // The five position chips in a row — every position this player can cover
  // (his own included) lit in the SAME team-colour highlight, the rest dimmed.
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
    return this.teamAxesOf(ROSTER[team]);
  }
  // Same computation over an arbitrary roster array (used to preview a swap).
  private teamAxesOf(r: PlayerDef[]): number[] {
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
    return this.teamOvrOf(ROSTER[team]);
  }
  private teamOvrOf(r: PlayerDef[]): number {
    let st = 0, bn = 0;
    for (let j = 0; j < STARTERS; j++) st += this.ovrOf(r[j]);
    for (let j = STARTERS; j < ROSTER_SIZE; j++) bn += this.ovrOf(r[j]);
    return Math.round((st / STARTERS) * 0.7 + (bn / (ROSTER_SIZE - STARTERS)) * 0.3);
  }

  // ...and its size: height in cm, weighted by how much height MATTERS for
  // each man's position/role — the C's reach is the team's size, a PG's
  // stature barely registers.
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

  // Pale-green (gain) / light-red (loss) tints for the swap-preview deltas.
  private static readonly GAIN = "rgb(120,225,140)";
  private static readonly LOSS = "rgb(240,140,130)";
  // Each ROLE carries its own accent colour so they are told apart at a glance.
  // Offence and defence roles that form a natural pair share one colour:
  //   フロアジェネラル(攻) = 守備司令塔(守)   … 司令塔 / on-court commander
  //   エース(攻)           = ロックダウン(守)  … the star ↔ the star-stopper
  // muted / desaturated so they sit inside the dark UI rather than shout
  private static readonly OFF_ROLE_C: Record<string, string> = {
    メインハンドラー:      "rgb(113,154,206)",
    セカンドハンドラー:    "rgb(146,174,209)",
    フロアジェネラル:      "rgb(103,131,196)",  // = 守備司令塔
    スラッシャー:          "rgb(206,140,94)",
    エース:                "rgb(201,111,106)",  // = ロックダウン
    スポットアップ:        "rgb(206,177,97)",
    "3&D":                 "rgb(182,191,103)",
    ポイントフォワード:    "rgb(123,177,196)",
    ストレッチ:            "rgb(206,156,113)",
    インサイドフィニッシャー: "rgb(197,129,117)",
    リムランナー:          "rgb(114,179,123)",
    スクリーナー:          "rgb(172,143,114)",
    プレイメイキングビッグ: "rgb(146,154,206)",
    リバウンダー:          "rgb(185,153,118)",
    フロアスペーサー:      "rgb(196,185,113)",
    オフボールカッター:    "rgb(201,136,175)",
  };
  private static readonly DEF_ROLE_C: Record<string, string> = {
    ハッスルディフェンダー: "rgb(201,136,175)",
    バランス:              "rgb(153,156,164)",
    省エネ:                "rgb(126,130,136)",
    ロックダウン:          "rgb(201,111,106)",  // = 攻 エース
    スイッチディフェンダー: "rgb(136,144,206)",
    パスカット:            "rgb(169,141,200)",
    リムプロテクター:      "rgb(92,170,157)",   // defence rim protector (own colour)
    ヘルプディフェンダー:  "rgb(114,179,123)",
    守備司令塔:            "rgb(103,131,196)",  // = 攻 フロアジェネラル
  };
  private static readonly USE_C = "rgb(198,202,212)";  // 順 primary/usage order — neutral silver

  // `preview` (set while carrying an incoming DB player over a target row) shows
  // how one team's strength bars WOULD change if the swap happened: the changed
  // portion of each bar and a ±N number are tinted pale green / light red.
  private buildVsBoard(preview?: { team: number; roster: PlayerDef[] }): HTMLDivElement {
    const baseAxes = [this.teamAxes(0), this.teamAxes(1)];
    const dispAxes = [baseAxes[0].slice(), baseAxes[1].slice()];
    if (preview) dispAxes[preview.team] = this.teamAxesOf(preview.roster);
    const colA = colorOf(0), colB = colorOf(1);
    // whether a given side is being previewed
    const prev = (t: number) => (preview && preview.team === t);

    const wrap = document.createElement("div");
    Object.assign(wrap.style, {
      width: "100%", boxSizing: "border-box", padding: "7px 14px",
      background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.14)",
      // gap: vertical spacing between the stacked comparison rows (shot / dribble
      // / …) — kept tight so the bars sit close together
      borderRadius: "12px", display: "flex", flexDirection: "column", gap: "1px",
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

    // comparison rows: value | ←bar | label | bar→ | value. The bar spreads a
    // declared band (ratings are compressed) — the exact numbers sit beside it.
    // `dA`/`dB` are the previewed team's per-row delta (else null).
    const addRow = (label: string, a: number, b: number, lo: number, hi: number,
                    oldA: number | null, oldB: number | null) => {
      const row = document.createElement("div");
      Object.assign(row.style, {
        // value columns hold just the number, pushed to the outer edges, so the
        // two bars run long and sit close together across a tight centre label.
        // The preview ±N floats (absolute) and so costs no column width — the
        // board never reflows and the bars never shrink when a delta appears.
        display: "grid", gridTemplateColumns: "40px 1fr 54px 1fr 40px", gap: "6px",
        alignItems: "center",
      } as Partial<CSSStyleDeclaration>);
      const scale = (v: number) => Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100));
      // value cell: the number hugs the OUTER edge; the tinted ±N (shown only
      // when previewed) floats inward over the bar's empty end, painted on top so
      // it is never hidden and never widens the cell.
      const val = (v: number, win: boolean, align: string, old: number | null): HTMLDivElement => {
        const d = document.createElement("div");
        Object.assign(d.style, {
          position: "relative", display: "flex", alignItems: "center", whiteSpace: "nowrap",
          // hug the OUTER edge: team A (left col) to the left, team B to the right
          justifyContent: align === "right" ? "flex-start" : "flex-end",
        } as Partial<CSSStyleDeclaration>);
        const n = document.createElement("span");
        Object.assign(n.style, { fontSize: "12px", fontWeight: "800", color: "#fff", opacity: win ? "1" : "0.5" });
        n.textContent = v.toFixed(1);   // 0.1 precision so small swaps are visible
        d.appendChild(n);
        // TRUE change to one decimal — bench / starter⇄bench swaps move the team
        // value by less than a whole point, so an integer delta would vanish.
        const raw = old !== null ? v - old : 0;
        const delta = Math.round(raw * 10) / 10;
        if (delta !== 0) {
          const dl = document.createElement("span");
          Object.assign(dl.style, {
            position: "absolute", top: "50%", fontSize: "10px", fontWeight: "800",
            color: delta > 0 ? UI.GAIN : UI.LOSS, zIndex: "5", pointerEvents: "none",
            // float toward the centre/bar so the outer number keeps its place
            ...(align === "right"
              ? { right: "0", transform: "translate(calc(100% + 3px), -50%)" }
              : { left: "0", transform: "translate(calc(-100% - 3px), -50%)" }),
          } as Partial<CSSStyleDeclaration>);
          dl.textContent = delta > 0 ? `+${delta.toFixed(1)}` : delta.toFixed(1);
          d.appendChild(dl);
        }
        return d;
      };
      // bar: base fill in team colour; if previewed, the changed slice is tinted
      // pale green (gain) or light red (loss), extending outward from centre.
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
          // outward direction: A grows leftward (delta OUTSIDE the base = before it
          // in a flex-end row); B grows rightward (delta AFTER the base).
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
    // team size — responsibility-weighted height converted to a strength value
    // on the user's calibration (180cm → 70, 200cm → 100), same band as the axes
    const hBase = [UI.heightValue(this.teamHeight(0)), UI.heightValue(this.teamHeight(1))];
    const hDisp = hBase.slice();
    if (preview) hDisp[preview.team] = UI.heightValue(this.teamHeightOf(preview.roster));
    addRow("高さ", hDisp[0], hDisp[1], 40, 100,
      prev(0) ? hBase[0] : null, prev(1) ? hBase[1] : null);
    return wrap;
  }

  // Swap the live VS board element for a freshly built one (optionally a preview).
  private replaceVsBoard(next: HTMLDivElement): void {
    if (this.vsBoard?.parentElement) this.vsBoard.parentElement.replaceChild(next, this.vsBoard);
    this.vsBoard = next;
  }
  // Show / clear the "what this swap does to team strength" preview on the board.
  private showVsPreview(team: number, idx: number, dbp: DbPlayer): void {
    const roster = ROSTER[team].slice();
    roster[idx] = makeDefFromDb(dbp);
    this.vsPreviewActive = true;
    this.replaceVsBoard(this.buildVsBoard({ team, roster }));
  }
  // Preview how a 評価ロール change would move this player's team's strength bars.
  private previewRole(def: PlayerDef, team: number, role: string): void {
    const idx = ROSTER[team].indexOf(def);
    if (idx < 0) return;
    const roster = ROSTER[team].slice();
    roster[idx] = { ...def, evalRole: role === "自動" ? undefined : role };  // attr shared (read-only)
    this.vsPreviewActive = true;
    this.replaceVsBoard(this.buildVsBoard({ team, roster }));
  }
  // Preview how EXCHANGING two of a team's roster slots (starter ⇄ bench, via
  // drag & drop) would move its strength bars — starters count 70%, bench 30%,
  // so moving a strong reserve into the starting five lifts the team.
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

    // header: team name + a "選手を交代" button that opens the 4000+ DB picker
    const head = document.createElement("div");
    Object.assign(head.style, {
      display: "flex", alignItems: "center", justifyContent: "space-between",
      gap: "8px", margin: "0 0 2px",
    } as Partial<CSSStyleDeclaration>);
    const teamName = document.createElement("span");
    Object.assign(teamName.style, { fontSize: "15px", fontWeight: "800", color });
    teamName.textContent = TEAM_NAMES[team];
    // per-team controls beside the name: re-draw this squad / re-optimise its
    // roles for the current line-up / swap a player from the DB. Kept compact so
    // all three fit the card, and allowed to wrap on a very narrow view.
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
    const genBtn = ctrlBtn("ランダム編成", false, () => this.randomizeOne(team));
    const roleBtn = ctrlBtn("役割再設定", false, () => this.reassignRoles(team));
    const swapBtn = ctrlBtn("選手を交代", false, () => this.openPlayerPicker(team));
    // the three controls sit on their OWN row so they always stay on ONE line —
    // a slightly longer team name (BLAZE vs WAVE) no longer wraps them to two.
    const btns = document.createElement("div");
    Object.assign(btns.style, { display: "flex", gap: "5px", flexWrap: "nowrap", justifyContent: "space-between", margin: "0 0 3px" } as Partial<CSSStyleDeclaration>);
    btns.append(genBtn, roleBtn, swapBtn);
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
    row.dataset.dropTeam = String(team);   // drag-&-drop hit-testing
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

    // Three POS-chip-sized pills, editable right here in the roster row:
    //   攻 = offence role, 守 = defence role, 順 = offence choice order (usage).
    // The 攻/守 pills take the SELECTED role's own colour (paired offence/defence
    // roles share one), so roles are told apart at a glance. (full names / tips
    // live in the picker + 詳細)
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
    const offC = (def.evalRole && UI.OFF_ROLE_C[def.evalRole]) || "rgb(150,156,168)";
    const defC = (def.defRole && UI.DEF_ROLE_C[def.defRole]) || "rgb(150,156,168)";
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

    row.append(pos, roleSel, defSel, rankSel, name, ht, num, det);
    row.onpointerdown = (e) => this.beginDrag(team, i, e);
    row.onmouseenter = () => { if (!this.dragFrom && !this.carry && !this.rolePicker && !this.detailModal) this.showPlayerCard(def, team, row); };
    row.onmouseleave = () => this.hidePlayerCard();
    return row;
  }

  // DRAG & DROP swap: grab a player's bar, carry it (it follows the cursor),
  // and drop it on a team-mate — starter ⇄ bench included — to exchange the
  // two roster slots. On touch a LONG-PRESS lifts the bar (a plain swipe still
  // scrolls the list).
  private beginDrag(team: number, idx: number, ev: PointerEvent): void {
    if (this.carry) return;   // an incoming DB player is being placed — ignore row drags
    if (ev.pointerType === "mouse" && ev.button !== 0) return;
    const ox = ev.clientX, oy = ev.clientY;
    let lifted = false;
    let timer = 0;
    let previewIdx = -1;   // roster slot whose swap is currently previewed on the VS board
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
      // preview how strength would move if these two slots were exchanged
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
      if (previewIdx >= 0) { previewIdx = -1; this.clearVsPreview(); }   // drop the swap preview
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
        : ((isDef ? UI.DEF_ROLE_C[nm] : UI.OFF_ROLE_C[nm]) ?? "rgb(150,156,168)");
    const mkBtn = (nm: string): HTMLDivElement => {
      const cell = document.createElement("div");
      Object.assign(cell.style, { display: "flex", alignItems: "center", gap: "4px" } as Partial<CSSStyleDeclaration>);
      // each option is tinted with the role's OWN colour so the picker doubles as
      // a legend; the selected one fills solid
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
        else this.refreshEditors();   // OVR + team bars re-evaluate
      };
      // real-time: hovering an OFFENCE role previews how it moves the team's bars
      // (only on the pregame roster; defence roles don't change the OVR bars)
      if (!this.detailModal && !isDef) {
        b.onmouseenter = () => this.previewRole(def, team, nm);
        b.onmouseleave = () => this.clearVsPreview();
      }
      cell.append(dot, b);
      // ⓘ — press (or hover) to read what the role means / what it rewards
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
      // one flat list of DEFENSE roles (effort gears + specialists)
      const dg = grid();
      for (const nm of Object.keys(UI.DEF_ROLES)) dg.appendChild(mkBtn(nm));
      menu.appendChild(header("ディフェンスロール"));
      menu.appendChild(dg);
    } else {
      // OFFENCE roles this POSITION can take (defence-only names excluded)...
      const posGrid = grid();
      for (const [nm, r] of Object.entries(UI.EVAL_ROLES)) {
        if (UI.DEF_ONLY.has(nm)) continue;
        if (r.pos && r.pos.includes(def.role)) posGrid.appendChild(mkBtn(nm));
      }
      if (posGrid.childElementCount > 0) {
        menu.appendChild(header(`${def.role} のロール`));
        menu.appendChild(posGrid);
      }
      // ...and the modern position-crossing jobs, open to everyone
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
    this.clearVsPreview();   // drop any role-hover preview (no-op if none active)
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
      width: phone ? "96vw" : "540px", maxWidth: "96vw", maxHeight: "92vh",
      overflow: "auto", boxSizing: "border-box",
      display: "flex", flexDirection: "column", gap: "10px", textAlign: "left",
    } as Partial<CSSStyleDeclaration>);

    // header: name on its own line (shown in full — the panel widens to fit,
    // ellipsis only if it would exceed the panel/screen), then height/OVR/role
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
    // 役割 — switched HERE (the icon pill is display-only): opens the same
    // picker as the pregame roster, then the modal rebuilds with the new role
    const reopen = () => {
      this.refreshEditors();            // pregame VS board / rosters re-evaluate
      this.openDetailModal(def, team);  // ...and this modal reopens up to date
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
    // OFFENCE role, DEFENCE role and CHOICE ORDER — all switched here.
    const roleBtn = pill(`攻: ${def.evalRole ?? "自動"} ▾`, !!def.evalRole);
    roleBtn.onclick = () => this.openRolePicker(def, team, roleBtn, reopen, "off");
    const defBtn = pill(`守: ${def.defRole ?? "自動"} ▾`, !!def.defRole);
    defBtn.onclick = () => this.openRolePicker(def, team, defBtn, reopen, "def");
    // choice order cycles 自動→1→2→…→5→自動 (1 = first option / most usage)
    const rankBtn = pill(`プライマリ: ${def.choiceRank ?? "自動"}`, !!def.choiceRank);
    rankBtn.onclick = () => {
      const next = def.choiceRank === undefined ? 1 : def.choiceRank >= 5 ? undefined : def.choiceRank + 1;
      def.choiceRank = next;
      reopen();
    };
    // Layout under 身長・利き腕: [オフェンスロール | プライマリ] on one row, and
    // ディフェンスロール on the row below at the SAME total width.
    const roleBox = document.createElement("div");
    Object.assign(roleBox.style, {
      display: "flex", flexDirection: "column", gap: "6px", marginTop: "4px",
      width: "min(360px, 100%)",
    } as Partial<CSSStyleDeclaration>);
    const roleRow = document.createElement("div");
    Object.assign(roleRow.style, { display: "flex", gap: "6px", alignItems: "center" } as Partial<CSSStyleDeclaration>);
    Object.assign(roleBtn.style, { flex: "1.6", boxSizing: "border-box", textAlign: "center" } as Partial<CSSStyleDeclaration>);
    Object.assign(rankBtn.style, { flex: "1", boxSizing: "border-box", textAlign: "center" } as Partial<CSSStyleDeclaration>);
    // プライマリの説明 (ⓘ: hover / tap で表示)
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

    // TOP ROW: name / role / coverable positions on the left, hexagon chart on
    // the right (stacked on the phone). The ratings grid goes FULL WIDTH below.
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

    // STATUS: all 25 ratings across the full width below
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

  // Build (once) an OVR-sorted view of the whole 4000+ player database so the
  // picker's keystroke filtering is a plain array scan over cached fields.
  private ensureDbIndex(): { p: DbPlayer; ovr: number; lower: string }[] {
    if (!this.dbIndex) {
      this.dbIndex = PLAYER_DB
        .map((p) => ({ p, ovr: this.ovrOf(makeDefFromDb(p)), lower: p[0].toLowerCase() }))
        .sort((a, b) => b.ovr - a.ovr);
    }
    return this.dbIndex;
  }

  // 選手を交代: opened from the team-name header. Pick any of the 4000+ database
  // players (search / position filter / OVR); on pick the modal closes and the
  // player is "carried" on the cursor — drop him on a roster row of his team to
  // replace that player (see startCarry).
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

    // pick → close the modal and start carrying this player on the cursor
    const onPick = (dbp: DbPlayer): void => {
      this.closePlayerPicker();
      this.startCarry(team, dbp);
    };

    // ---- the searchable 4000+ database list ----
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
      setFilter(posFilter);   // paint the list
      if (!phone) search.focus();
    }
  }

  private closePlayerPicker(): void {
    if (this.playerPicker) { this.playerPicker.remove(); this.playerPicker = null; }
    this.hideTip();
  }

  // Carry an incoming DB player on the cursor after the picker closes. A plain
  // pointerdown on a roster row of his team drops him there (replacing that
  // player); a pointerdown anywhere else, or Esc, cancels. No button is held —
  // the picker's click already ended, so this is a click-to-place interaction.
  private startCarry(team: number, dbp: DbPlayer): void {
    this.cancelCarry();
    this.carry = { team, dbp };
    const color = colorOf(team);

    const g = document.createElement("div");
    Object.assign(g.style, {
      position: "fixed", zIndex: "92", pointerEvents: "none", whiteSpace: "nowrap",
      transform: "translate(-50%,-50%)", padding: "5px 12px", borderRadius: "7px",
      background: "rgba(15,19,28,0.96)", border: `1px solid ${color}`,
      boxShadow: "0 10px 26px rgba(0,0,0,0.6)", fontSize: "12px", fontWeight: "800", color: "#fff",
      left: "-999px", top: "-999px",
    } as Partial<CSSStyleDeclaration>);
    g.innerHTML = `<span style="color:${color}">${dbp[1]}</span>　${dbp[0]}　<span style="opacity:.6">⇄</span>`;
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

    let previewIdx = -1;   // roster slot currently previewed on the VS board (-1 = none)
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
    // preview how team strength would change if dropped on the given slot
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
      // a swapped-in player arrives WITH sensible default roles (prevents the
      // "forgot to set a role" gap the user hit) — offence by axes, defence by
      // ratings; choice order back to auto.
      nd.evalRole = this.bestOffRole(nd);
      nd.defRole = this.pickDefRole(nd);
      this.assignRankFor(nd, team, idx);   // primary by ability (teammates untouched)
      this.cancelCarry();
      this.refreshEditors();
    };
    const onDown = (e: PointerEvent) => {
      const t = this.dropTargetAt(e.clientX, e.clientY);
      if (t && t.team === team) {
        e.preventDefault();
        e.stopPropagation();   // beat the row's own long-press drag
        // Touch has no hover, so the strength preview never got a chance to show.
        // First tap on a slot PREVIEWS the change (highlight + ±N on the VS board);
        // a second tap on the SAME slot confirms it. A tap on a different slot just
        // moves the preview. Mouse still commits on the first click (its hover
        // already previewed the change).
        if (e.pointerType !== "mouse" && previewIdx !== t.idx) {
          setHl(t.el);
          preview(t.idx);
          hint.textContent = "もう一度タップで確定（Escで取消）";
          return;
        }
        commit(t.idx);
      } else {
        this.cancelCarry();    // dropped away from any of his roster rows → cancel
      }
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") this.cancelCarry(); };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerdown", onDown, true);   // capture: run before row handlers
    window.addEventListener("keydown", onKey);
    this.carryCleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
      clearHl();
      if (previewIdx >= 0) { previewIdx = -1; this.clearVsPreview(); }   // drop the strength preview
    };
  }

  private cancelCarry(): void {
    if (this.carryCleanup) { this.carryCleanup(); this.carryCleanup = null; }
    if (this.carryGhost) { this.carryGhost.remove(); this.carryGhost = null; }
    if (this.carryHint) { this.carryHint.remove(); this.carryHint = null; }
    this.carry = null;
  }

  // The hover detail card: hexagon chart of the six digests + 特殊能力 chips.
  private showPlayerCard(def: PlayerDef, team: number, anchor: HTMLElement): void {
    const color = colorOf(team);
    const card = this.playerCard;
    card.replaceChildren();

    // name on its own line (full name; ellipsis only if it exceeds the card),
    // meta beneath — so a long name isn't squeezed down to a couple of letters
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

    // coverable positions: the five chips with his lit up
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

    // float ABOVE the hovered row (its bottom edge just over the name), so the
    // row itself — name, role pill, 詳 — is never covered and stays clickable.
    // If there's no room above, flip below the row instead.
    card.style.display = "block";
    const r = anchor.getBoundingClientRect();
    const cw = 260;
    const ch = card.offsetHeight || 320;
    let left = r.left + r.width / 2 - cw / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - cw - 8));
    // default: float above the row. Flip BELOW when it would go off the top of
    // the screen OR overlap the VS (team-strength) board above the roster.
    let top = r.top - ch - 8;
    const vbBottom = this.vsBoard ? this.vsBoard.getBoundingClientRect().bottom : 0;
    if (top < 8 || top < vbBottom) top = Math.min(window.innerHeight - ch - 8, r.bottom + 8);
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
    // FIXED width = the full box-score table (name 128 + 10 columns + gaps ≈ 544),
    // capped on small screens; so the modal keeps ONE size across all three tabs
    // instead of shrinking on the narrower team-comparison view.
    Object.assign(this.resultStats.style, {
      display: "flex", flexDirection: "column", gap: "12px", width: "min(560px, 90vw)",
    } as Partial<CSSStyleDeclaration>);

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

    // tabbed view: チームスタッツ / 青チーム / 赤チーム
    this.resultGame = game;
    this.resultTab = "team";                 // default to the team comparison
    this.resultStats.replaceChildren();
    this.resultStats.appendChild(this.resultTabBar());
    this.resultContent = document.createElement("div");
    // a min-height that comfortably fits a 13-man box score, so the modal height
    // stays put when switching to the shorter team-comparison tab too
    Object.assign(this.resultContent.style, { width: "100%", minHeight: "clamp(230px, 44vh, 360px)" } as Partial<CSSStyleDeclaration>);
    this.resultStats.appendChild(this.resultContent);
    this.renderResultTab();
    this.setPhase("result");
  }

  // The three result tabs. Blue = team 1 (WAVE), red = team 0 (BLAZE); each tab
  // is tinted its team colour so it reads as the blue / red team.
  private resultTabBar(): HTMLDivElement {
    const bar = document.createElement("div");
    Object.assign(bar.style, {
      display: "flex", gap: "6px", justifyContent: "center", flexWrap: "wrap", marginBottom: "6px",
    } as Partial<CSSStyleDeclaration>);
    const tabs: { key: "team" | "blue" | "red"; label: string }[] = [
      { key: "team", label: "チームスタッツ" },
      { key: "blue", label: TEAM_NAMES[1] },   // 青チーム
      { key: "red", label: TEAM_NAMES[0] },    // 赤チーム
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

  // The box-score columns. FG / 3P / FT show makes ● of attempts ● ("3/8").
  private static readonly BOX_COLS: { label: string; w: number; get: (s: import("./entities").Stats) => string }[] = [
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
    head.textContent = TEAM_NAMES[team];
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
      nm.style.opacity = pl.idx < STARTERS ? "0.95" : "0.7"; // bench slightly dimmed
      row.appendChild(nm);
      for (const c of UI.BOX_COLS) row.appendChild(this.cell(c.get(pl.stats), c.w, "center"));
      table.appendChild(row);
    }
    scroller.appendChild(table);
    wrap.appendChild(scroller);
    return wrap;
  }

  // Team-vs-team comparison: totals side by side (team0 on the left, team1 on
  // the right, the stat name between) so the two squads read against each other.
  private teamCompare(game: Game): HTMLDivElement {
    type S = import("./entities").Stats;
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
    const n0 = document.createElement("span"); n0.textContent = TEAM_NAMES[0]; n0.style.color = colorOf(0);
    const n1 = document.createElement("span"); n1.textContent = TEAM_NAMES[1]; n1.style.color = colorOf(1);
    title.append(n0, n1);
    wrap.appendChild(title);

    // per-quarter line score: 名前 | Q1 Q2 … | T
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
      // header row: (blank) Q1 Q2 … T
      ls.appendChild(lsCell("", { dim: true, align: "left" }));
      for (let i = 0; i < nq; i++) ls.appendChild(lsCell(`Q${i + 1}`, { dim: true }));
      ls.appendChild(lsCell("T", { dim: true, bold: true }));
      // one row per team
      for (let t = 0; t < 2; t++) {
        ls.appendChild(lsCell(TEAM_NAMES[t], { color: colorOf(t), bold: true, align: "left" }));
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

  // ---- small builders ----------------------------------------------------

  private cell(text: string, width: number, align: string = "left"): HTMLSpanElement {
    const el = document.createElement("span");
    Object.assign(el.style, {
      width: `${width}px`, flexShrink: "0", textAlign: align, display: "inline-block",
      // keep every cell to ONE line; a too-long name is clipped with an ellipsis
      whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
    } as Partial<CSSStyleDeclaration>);
    el.textContent = text;
    return el;
  }

  // A left-frozen cell: it stays pinned while the stat columns scroll sideways,
  // so you can always tell whose row it is. Opaque background so scrolled
  // numbers don't show through, with a hairline edge to read as a frozen column.
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

  // Keep the ☰ on the top edge (aligned with the scoreboard) as long as the
  // centred scoreboard doesn't reach it; drop it below the board only once its
  // right edge would collide. Recomputed on build and on every resize.
  private positionMenu(): void {
    if (!this.menuBtn || !this.board) return;
    const boardW = this.board.getBoundingClientRect().width || 320;
    const boardRight = window.innerWidth / 2 + boardW / 2;
    const btnW = this.menuBtn.getBoundingClientRect().width || 44;
    const btnLeft = window.innerWidth - 14 - btnW;
    const clears = btnLeft > boardRight + 12;   // 12px breathing room before they touch
    this.menuBtn.style.top = clears ? "14px" : "92px";
    // the dropdown hangs just under the button in whichever spot it landed
    this.controls.style.top = clears ? "58px" : "132px";
    // keep the camera hint on the same row as the ☰, on the left
    if (this.camHint) this.camHint.style.top = clears ? "14px" : "92px";
  }

  // Reflect the current 体力バー position on the toggle button's label.
  private refreshStaminaBtn(): void {
    if (!this.staminaBtn) return;
    this.staminaBtn.textContent = HUD_OPTS.staminaOn === "name"
      ? "体力: 名前の下" : "体力: アイコンの下";
  }

  // Reflect the on-court name-tag on/off state on its toggle button.
  private refreshNamesBtn(): void {
    if (!this.namesBtn) return;
    this.namesBtn.textContent = HUD_OPTS.showNames ? "選手名: 表示" : "選手名: 非表示";
  }

  // Reflect the current player-model style on its toggle button.
  private refreshModelBtn(): void {
    if (!this.modelBtn) return;
    this.modelBtn.textContent = HUD_OPTS.model === "human" ? "モデル: 人型" : "モデル: どんぐり";
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
      Object.assign(row.style, { display: "flex", gap: "6px", touchAction: "pan-x" } as Partial<CSSStyleDeclaration>);
      row.classList.add("bball-hscroll");   // scrolling never shows a bar / adds height
      // the bar is hidden, so give the mouse ways to slide the bench row:
      // wheel scrolls it sideways, and press-drag pans it (touch swipes natively)
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
    wrap.onmouseleave = () => this.scheduleHideTip();   // grace to reach the tip's button

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

    // stamina bar directly under the face — shown only in "icon" HUD mode
    // (in "name" mode the gauge lives on the floating 3D name tag instead).
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

    // 評価ロール pill under the name — DISPLAY only (switching happens inside
    // the ステータス確認 modal). The icon bar rebuilds when a role changes,
    // because the role codes are part of the rebuild key.
    const color = colorOf(player.team);
    const cur = ROSTER[player.team]?.[player.idx]?.evalRole;
    const rolePill = document.createElement("div");
    rolePill.textContent = cur ? (UI.EVAL_ROLES[cur]?.short ?? "?") : "-";
    Object.assign(rolePill.style, {
      width: "44px", fontSize: "8px", padding: "1px 0", textAlign: "center",
      borderRadius: "6px", boxSizing: "border-box", lineHeight: "1.4",
      background: cur ? color : "rgba(20,24,34,0.85)",
      color: "#fff", textShadow: "0 1px 2px rgba(0,0,0,0.7)",
      border: cur ? `1px solid ${color}` : "1px solid rgba(255,255,255,0.22)",
      fontWeight: cur ? "800" : "600",
    } as Partial<CSSStyleDeclaration>);
    wrap.appendChild(rolePill);
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
    // deterministic variety per player so faces aren't all identical — SHARED
    // with the 3D head (entities.ts) via playerLook, so the model matches the icon
    const look = playerLook(player.idx);
    const skin = look.skinHex;
    const hair = look.hairHex;
    const style = look.style;   // 0短髪 1坊主 2アフロ 3フラットトップ 4ヘッドバンド
    // hair BEHIND the head — a full backing so the crown & sides are covered
    // (not a balding top-cap). Skipped for 坊主(1).
    if (style !== 1) {
      ctx.fillStyle = hair;
      const hr = style === 2 ? 0.40 : 0.335;                 // afro bigger
      ctx.beginPath(); ctx.arc(W / 2, H * (style === 2 ? 0.44 : 0.46), W * hr, 0, Math.PI * 2); ctx.fill();
      if (style === 3) ctx.fillRect(W * 0.15, H * 0.14, W * 0.70, H * 0.32);   // flat-top block
    }
    // head (skin) on top of the backing → hair frames the crown and sides
    ctx.fillStyle = skin;
    ctx.beginPath(); ctx.arc(W / 2, H * 0.52, W * 0.30, 0, Math.PI * 2); ctx.fill();
    // front hairline / bangs across the forehead (the FRONT reads distinct from
    // the fuller back)
    if (style !== 1) {
      ctx.fillStyle = hair;
      ctx.beginPath(); ctx.arc(W / 2, H * 0.45, W * 0.305, Math.PI * 1.03, Math.PI * 1.97); ctx.fill();
    }
    // headband (style 4) — team colour across the forehead
    if (style === 4) {
      ctx.fillStyle = `rgb(${Math.round(tc.r * 255)},${Math.round(tc.g * 255)},${Math.round(tc.b * 255)})`;
      ctx.fillRect(W * 0.20, H * 0.40, W * 0.60, H * 0.07);
    }
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
      const pn = this.iconPanels[t];
      if (rw && pn) {
        if (this.layoutMode === "phone") {
          // ONE icon size for both tabs: whatever lets the on-court FIVE fill
          // the team's half (48px icons + 6px gaps → 264px natural)
          const natural5 = 5 * 48 + 4 * 6;
          const s = Math.min(1, (window.innerWidth * 0.49) / natural5);
          pn.style.transform = `scale(${s})`;
          if (this.showBench[t]) {
            // BENCH: same-size icons that SLIDE — the scroll window is sized in
            // pre-scale units so it still shows exactly the half width
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
      // rebuild only when the shown set (or a name / tab / 評価ロール) changes —
      // names are in the key so a tip-off applyRoster rename rebuilds at once
      const key = `${this.showBench[t] ? "B" : "C"}:`
        + list.map((p) => {
          const d = ROSTER[t]?.[p.idx];
          return `${p.idx}:${p.name}:${d?.evalRole ?? ""}:${d?.defRole ?? ""}:${d?.choiceRank ?? ""}`;
        }).join(",");
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

  // Live-update the face-icon stamina bars (only meaningful in "icon" HUD mode;
  // the bars are hidden otherwise). Keyed by player, so it tracks whichever icon
  // element is currently on screen for him.
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
    // only while actually playing: during the pregame screen the Players still
    // carry the PREVIOUS draw's names (applyRoster runs at tip-off), so icons
    // built then would show stale names
    if (this.phase === "playing") {
      this.refreshPlayerBars(game);
      this.updateIconStamina(game);
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
    // flashy countdown in the last 3 seconds: the box swells and PUNCHES on each
    // tick, glows, and shifts red → hot yellow as it runs out. Only while the
    // clock is actually running (not frozen on a dead ball).
    const frozen = game.mode === "tipoff" || game.mode === "freethrow"
      || game.mode === "pause" || game.mode === "subs" || game.mode === "finale";
    const box = this.shotBox;
    if (scLeft > 0 && scLeft <= 3 && !frozen) {
      const frac = scLeft - Math.floor(scLeft);                 // 1→0 within each second
      const pop = 1 + 0.55 * frac;                              // punch right after each tick
      const heat = Math.min(1, Math.max(0, (3 - scLeft) / 2.5)); // 0 at 3s .. 1 near 0
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
