import { Game } from "./game";
import { TEAM_NAMES, TEAM_COLORS } from "./config";
import { ROSTER, ROSTER_SIZE, STARTERS, computeOffPriority, randomizeRosters, ATTR_META, ABILITY_META, type AbilityKey, type PlayerDef } from "./attributes";

const colorOf = (team: number): string => {
  const c = TEAM_COLORS[team];
  return `rgb(${c.r * 255},${c.g * 255},${c.b * 255})`;
};

const clamp100 = (v: number): number => Math.max(0, Math.min(100, v));

type Phase = "pregame" | "playing" | "result";

// Editable rating columns: driven by ATTR_META so the editor always matches the
// Attributes schema. Explanations (shown on header hover) come from the same
// metadata, plus the non-rating columns below.
const ATTR_FIELDS = ATTR_META;
const INFO: Record<string, string> = {
  NAME: "選手名。自由に変更できます。",
  POS: "ポジション（PG/SG/SF/PF/C）。役割で動きが変わります。PF/Cはゴール下へのポストアップ（押し込み）でレイアップ/ダンク、PGはボール運び・ゲームメイクを担います。",
  HT: "身長(cm)。身長の高さ。リバウンド・ブロック・ゴール下の競り合い（手の届く高さ）に影響します。",
  PRI: "オフェンス優先度（ファースト/セカンドチョイス）。高いほど第1得点オプションとして優先的にボールが集まり、自分から攻めます。低いほど第2・第3オプションに回ります。",
  入替: "スタメンとベンチの選手を入れ替えます。相手を選ぶと即座に交換されます（背番号は枠に付きます）。",
};
for (const m of ATTR_META) INFO[m.label] = `【${m.name}】${m.tip}`;
for (const m of ABILITY_META) INFO[m.label] = `【特殊能力】${m.tip}`;
const ROLES = ["PG", "SG", "SF", "PF", "C"];
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

  private phase: Phase = "pregame";
  private benchTab = [false, false];   // which tab each team editor is showing

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
      position: "absolute", top: "58%", left: "50%", transform: "translateX(-50%)",
      display: "flex", flexDirection: "column", gap: "8px", alignItems: "center",
      pointerEvents: "none",
    });
    this.hud.appendChild(this.subFeed);

    // ---- event banner ----
    this.banner = document.createElement("div");
    css(this.banner, {
      position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)",
      fontSize: "52px", fontWeight: "800", letterSpacing: "2px", opacity: "0",
      textAlign: "center", transition: "opacity 0.2s",
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

    // ---- controls ----
    const controls = document.createElement("div");
    css(controls, {
      position: "absolute", bottom: "16px", left: "50%", transform: "translateX(-50%)",
      display: "flex", gap: "8px", pointerEvents: "auto",
    });
    this.hud.appendChild(controls);

    for (const s of [1, 2, 4]) {
      const b = this.button(`${s}x`);
      b.onclick = () => { this.speed = s; this.refreshSpeed(); };
      this.speedBtns.push(b);
      controls.appendChild(b);
    }
    const restart = this.button("RESTART");
    restart.onclick = () => this.onRestart();
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
      position: "absolute", display: "none", maxWidth: "300px",
      background: "rgba(18,22,30,0.98)", border: "1px solid rgba(255,255,255,0.25)",
      borderRadius: "8px", padding: "10px 12px", pointerEvents: "none", zIndex: "30",
      boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
    } as Partial<CSSStyleDeclaration>);

    this.tipTitle = document.createElement("div");
    Object.assign(this.tipTitle.style, { fontSize: "13px", fontWeight: "800", marginBottom: "5px" });
    this.tipBody = document.createElement("div");
    Object.assign(this.tipBody.style, { fontSize: "12px", lineHeight: "1.65", opacity: "0.92" });

    tip.append(this.tipTitle, this.tipBody);
    this.root.appendChild(tip);
    this.tooltip = tip;
  }

  private showTip(label: string, anchor: HTMLElement): void {
    const info = INFO[label];
    if (!info) return;
    this.tipTitle.style.color = "#fff";
    this.tipTitle.textContent = label;
    this.tipBody.textContent = info;
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
      display: "flex", flexDirection: "column", alignItems: "center", gap: "14px",
      background: "rgba(12,15,22,0.94)", border: "1px solid rgba(255,255,255,0.14)",
      borderRadius: "16px", padding: "clamp(14px, 3vw, 26px)", boxShadow: "0 12px 44px rgba(0,0,0,0.55)",
      pointerEvents: "auto", textAlign: "center",
      width: "auto", maxWidth: "96vw", maxHeight: "90vh", boxSizing: "border-box",
      overflow: "auto",
    } as Partial<CSSStyleDeclaration>);
    return p;
  }

  private buildPregame(): void {
    const p = this.panel();

    const title = document.createElement("div");
    Object.assign(title.style, { fontSize: "clamp(18px, 5vw, 26px)", fontWeight: "800", letterSpacing: "1px" });
    title.textContent = "スターティング設定 — LINE-UPS";

    const hintRow = document.createElement("div");
    Object.assign(hintRow.style, { fontSize: "12px", opacity: "0.65" });
    hintRow.textContent = "選手は毎試合ランダム編成（WE2010データベースから抽選）。名前・身長(cm)・ポジション・能力(0–100)・特殊能力（チップをクリックでON/OFF）を編集して TIP OFF。列見出しやチップにカーソルを合わせると説明が出ます。";

    p.append(title, hintRow);
    this.editorHost = document.createElement("div");
    Object.assign(this.editorHost.style, { width: "100%" } as Partial<CSSStyleDeclaration>);
    p.appendChild(this.editorHost);

    const buttons = document.createElement("div");
    Object.assign(buttons.style, { display: "flex", gap: "10px", marginTop: "8px" } as Partial<CSSStyleDeclaration>);
    const reroll = this.button("ランダム編成しなおす");
    Object.assign(reroll.style, { fontSize: "15px", padding: "11px 22px" });
    reroll.onclick = () => this.newMatchup();
    const start = this.button("TIP OFF");
    Object.assign(start.style, { fontSize: "17px", padding: "11px 30px", background: "rgba(70,120,220,0.95)" });
    start.onclick = () => { this.setPhase("playing"); this.onStart(); };
    buttons.append(reroll, start);
    p.appendChild(buttons);

    this.root.appendChild(p);
    this.pregamePanel = p;
    this.newMatchup();   // the first matchup is drawn at once
  }

  /** Draw a fresh random matchup from the database and rebuild the editors. */
  private newMatchup(): void {
    randomizeRosters();
    this.refreshEditors();
  }

  /** Rebuild the editor tables from the current ROSTER (keeps the tab state). */
  private refreshEditors(): void {
    this.editorHost.replaceChildren();
    for (let t = 0; t < 2; t++) this.editorHost.appendChild(this.buildTeamEditor(t));
  }

  private buildTeamEditor(team: number): HTMLDivElement {
    const color = colorOf(team);
    const wrap = document.createElement("div");
    Object.assign(wrap.style, {
      width: "100%", margin: "8px 0", padding: "10px 12px", boxSizing: "border-box",
      background: "rgba(255,255,255,0.03)", border: `1px solid ${color}`, borderRadius: "10px",
    } as Partial<CSSStyleDeclaration>);

    // header line: team name with the STARTERS/BENCH tabs right beside it
    const headRow = document.createElement("div");
    Object.assign(headRow.style, {
      display: "flex", alignItems: "center", gap: "14px", marginBottom: "6px",
    } as Partial<CSSStyleDeclaration>);
    const head = document.createElement("div");
    Object.assign(head.style, { fontSize: "16px", fontWeight: "800", color, textAlign: "left" });
    head.textContent = TEAM_NAMES[team];
    headRow.appendChild(head);

    // one table per group, behind tabs — the header row repeats in each
    const buildTable = (from: number, to: number): HTMLDivElement => {
      const table = document.createElement("div");
      Object.assign(table.style, { width: "max-content" } as Partial<CSSStyleDeclaration>);
      const cols = document.createElement("div");
      Object.assign(cols.style, { display: "flex", gap: "6px", alignItems: "center", fontSize: "11px", fontWeight: "700", opacity: "0.9", margin: "2px 0 4px" });
      cols.appendChild(this.headerCell("NAME", 150));
      cols.appendChild(this.headerCell("POS", 48));
      cols.appendChild(this.headerCell("HT", 46));
      for (const f of ATTR_FIELDS) cols.appendChild(this.headerCell(f.label, 50));
      cols.appendChild(this.headerCell("PRI", 50));
      cols.appendChild(this.headerCell("入替", 130));
      table.appendChild(cols);
      for (let i = from; i < to; i++) table.appendChild(this.editorRow(team, i));
      return table;
    };
    const starterTable = buildTable(0, STARTERS);
    const benchTable = buildTable(STARTERS, ROSTER_SIZE);
    benchTable.style.display = "none";

    // the tabs themselves
    const tabs = document.createElement("div");
    Object.assign(tabs.style, { display: "flex", gap: "6px" } as Partial<CSSStyleDeclaration>);
    const mkTab = (label: string): HTMLButtonElement => {
      const b = this.button(label);
      Object.assign(b.style, { fontSize: "12px", padding: "4px 14px" } as Partial<CSSStyleDeclaration>);
      return b;
    };
    const tabStarters = mkTab("スタメン");
    const tabBench = mkTab(`ベンチ (${ROSTER_SIZE - STARTERS})`);
    const select = (bench: boolean) => {
      this.benchTab[team] = bench;   // survives editor rebuilds (swaps, rerolls)
      starterTable.style.display = bench ? "none" : "block";
      benchTable.style.display = bench ? "block" : "none";
      tabStarters.style.background = bench ? "rgba(20,24,34,0.9)" : "rgba(70,120,220,0.95)";
      tabBench.style.background = bench ? "rgba(70,120,220,0.95)" : "rgba(20,24,34,0.9)";
    };
    tabStarters.onclick = () => select(false);
    tabBench.onclick = () => select(true);
    select(this.benchTab[team]);
    tabs.append(tabStarters, tabBench);
    headRow.appendChild(tabs);
    wrap.appendChild(headRow);

    // the wide table scrolls horizontally inside the box (so it never widens the
    // panel beyond the screen); header + rows scroll together
    const scroller = document.createElement("div");
    Object.assign(scroller.style, { width: "100%", overflowX: "auto", paddingBottom: "4px" } as Partial<CSSStyleDeclaration>);
    scroller.append(starterTable, benchTable);
    wrap.appendChild(scroller);
    return wrap;
  }

  private editorRow(team: number, i: number): HTMLDivElement {
    const def = ROSTER[team][i];
    const color = colorOf(team);
    const row = document.createElement("div");
    Object.assign(row.style, { display: "flex", gap: "6px", alignItems: "center", margin: "3px 0" });

    // editable name
    const name = document.createElement("input");
    name.type = "text"; name.value = def.name;
    Object.assign(name.style, {
      width: "150px", flexShrink: "0", fontSize: "13px", fontWeight: "700", pointerEvents: "auto", boxSizing: "border-box",
      background: "rgba(20,24,34,0.9)", color: "#fff", border: "1px solid rgba(255,255,255,0.2)", borderRadius: "4px",
    } as Partial<CSSStyleDeclaration>);
    name.onchange = () => { def.name = name.value.trim() || def.name; name.value = def.name; };
    row.appendChild(name);

    // position
    const role = document.createElement("select");
    Object.assign(role.style, {
      width: "48px", flexShrink: "0", fontSize: "12px", fontWeight: "700", pointerEvents: "auto", textAlign: "center", boxSizing: "border-box",
      background: "rgba(20,24,34,0.9)", color, border: `1px solid ${color}`, borderRadius: "4px",
    } as Partial<CSSStyleDeclaration>);
    for (const r of ROLES) {
      const o = document.createElement("option");
      o.value = r; o.textContent = r;
      if (r === def.role) o.selected = true;
      role.appendChild(o);
    }
    role.onchange = () => { def.role = role.value; };
    row.appendChild(role);

    // height in cm
    const ht = document.createElement("input");
    ht.type = "number"; ht.min = "150"; ht.max = "240"; ht.value = String(Math.round(def.height * 100));
    Object.assign(ht.style, {
      width: "46px", flexShrink: "0", fontSize: "12px", textAlign: "center", pointerEvents: "auto", boxSizing: "border-box",
      background: "rgba(20,24,34,0.9)", color: "#fff", border: "1px solid rgba(255,255,255,0.2)", borderRadius: "4px",
    } as Partial<CSSStyleDeclaration>);
    ht.onchange = () => {
      const cm = Math.max(150, Math.min(240, parseInt(ht.value) || Math.round(def.height * 100)));
      def.height = cm / 100; ht.value = String(cm);
    };
    row.appendChild(ht);

    // ratings + priority (with live bars)
    for (const f of ATTR_FIELDS) {
      const key = f.key;
      row.appendChild(this.ratingCell(def.attr[key], color, (v) => { def.attr[key] = v; }));
    }
    row.appendChild(this.ratingCell(Math.round(computeOffPriority(def) * 100), "rgba(240,200,90,0.95)", (v) => { def.priority = v / 100; }));

    // swap control: exchange this player with anyone in the other group
    const swap = document.createElement("select");
    Object.assign(swap.style, {
      width: "130px", flexShrink: "0", fontSize: "11px", pointerEvents: "auto", boxSizing: "border-box",
      background: "rgba(20,24,34,0.9)", color: "#fff", border: "1px solid rgba(255,255,255,0.2)", borderRadius: "4px",
    } as Partial<CSSStyleDeclaration>);
    const isStarter = i < STARTERS;
    const head = document.createElement("option");
    head.value = "-1";
    head.textContent = isStarter ? "⇄ ベンチと入替…" : "⇄ スタメンと入替…";
    swap.appendChild(head);
    const from = isStarter ? STARTERS : 0;
    const to = isStarter ? ROSTER_SIZE : STARTERS;
    for (let j = from; j < to; j++) {
      const other = ROSTER[team][j];
      const o = document.createElement("option");
      o.value = String(j);
      o.textContent = `#${j + 1} ${other.name} (${other.role})`;
      swap.appendChild(o);
    }
    swap.onchange = () => {
      const j = parseInt(swap.value);
      if (j < 0) return;
      const r = ROSTER[team];
      [r[i], r[j]] = [r[j], r[i]];
      this.refreshEditors();   // both tabs redraw with the swapped line-ups
    };
    row.appendChild(swap);

    // second line: 特殊能力 toggle chips (click to grant/remove)
    const wrap = document.createElement("div");
    wrap.appendChild(row);
    wrap.appendChild(this.abilityRow(def, color));
    return wrap;
  }

  // A row of toggle chips, one per 特殊能力; lit = the player has it.
  private abilityRow(def: PlayerDef, color: string): HTMLDivElement {
    const row = document.createElement("div");
    Object.assign(row.style, { display: "flex", gap: "4px", alignItems: "center", margin: "0 0 7px" } as Partial<CSSStyleDeclaration>);

    const label = this.cell("特能", 150, "right");
    Object.assign(label.style, { fontSize: "10px", opacity: "0.55", paddingRight: "6px", boxSizing: "border-box" } as Partial<CSSStyleDeclaration>);
    row.appendChild(label);

    for (const m of ABILITY_META) {
      const chip = document.createElement("button");
      chip.textContent = m.label;
      const paint = () => {
        const on = def.abilities?.includes(m.key) ?? false;
        Object.assign(chip.style, {
          background: on ? color : "rgba(20,24,34,0.9)",
          color: on ? "#0d1016" : "rgba(255,255,255,0.55)",
          border: on ? `1px solid ${color}` : "1px solid rgba(255,255,255,0.16)",
          fontWeight: on ? "800" : "600",
        } as Partial<CSSStyleDeclaration>);
      };
      Object.assign(chip.style, {
        fontSize: "10px", padding: "2px 7px", borderRadius: "9px", cursor: "pointer",
        pointerEvents: "auto", whiteSpace: "nowrap", flexShrink: "0",
      } as Partial<CSSStyleDeclaration>);
      paint();
      chip.onclick = () => {
        const list = def.abilities ?? (def.abilities = []);
        const i = list.indexOf(m.key as AbilityKey);
        if (i >= 0) list.splice(i, 1); else list.push(m.key);
        paint();
      };
      chip.onmouseenter = () => this.showTip(m.label, chip);
      chip.onmouseleave = () => this.hideTip();
      row.appendChild(chip);
    }
    return row;
  }

  // A column header that reveals its explanation on hover, anchored beneath it.
  private headerCell(label: string, width: number): HTMLSpanElement {
    const el = this.cell(INFO[label] ? `${label} ⓘ` : label, width, "center");
    if (INFO[label]) {
      Object.assign(el.style, { cursor: "help", pointerEvents: "auto", color: "rgba(150,190,255,0.95)" } as Partial<CSSStyleDeclaration>);
      el.onmouseenter = () => this.showTip(label, el);
      el.onmouseleave = () => this.hideTip();
    }
    return el;
  }

  // A rating editor: a number input with a coloured bar underneath that shows
  // the 0–100 value at a glance and updates live as you type.
  private ratingCell(value: number, color: string, onSet: (v: number) => void): HTMLDivElement {
    const wrap = document.createElement("div");
    Object.assign(wrap.style, { width: "50px", flexShrink: "0", display: "flex", flexDirection: "column", alignItems: "center", gap: "3px" } as Partial<CSSStyleDeclaration>);

    const inp = document.createElement("input");
    inp.type = "number"; inp.min = "0"; inp.max = "100"; inp.value = String(value);
    Object.assign(inp.style, {
      width: "46px", fontSize: "12px", textAlign: "center", pointerEvents: "auto", boxSizing: "border-box",
      background: "rgba(20,24,34,0.9)", color: "#fff", border: "1px solid rgba(255,255,255,0.2)", borderRadius: "4px",
    } as Partial<CSSStyleDeclaration>);

    const track = document.createElement("div");
    Object.assign(track.style, { width: "46px", height: "5px", background: "rgba(255,255,255,0.12)", borderRadius: "3px", overflow: "hidden" } as Partial<CSSStyleDeclaration>);
    const fill = document.createElement("div");
    Object.assign(fill.style, { width: `${value}%`, height: "100%", background: color } as Partial<CSSStyleDeclaration>);
    track.appendChild(fill);

    inp.oninput = () => { fill.style.width = `${clamp100(parseInt(inp.value) || 0)}%`; };
    inp.onchange = () => { const v = clamp100(parseInt(inp.value) || 0); inp.value = String(v); fill.style.width = `${v}%`; onSet(v); };

    wrap.append(inp, track);
    return wrap;
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
      this.hud.appendChild(panel);
    }
  }

  // A small face avatar: team-coloured disc, a simple generated head, and the
  // jersey number, with the player's name beneath. No portrait art exists, so
  // the face is drawn procedurally and the number/name identify the player.
  private makeFaceIcon(player: import("./entities").Player): HTMLDivElement {
    const wrap = document.createElement("div");
    Object.assign(wrap.style, {
      width: "48px", display: "flex", flexDirection: "column", alignItems: "center", gap: "2px",
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
          Object.assign(sc.style, { fontSize: "26px", fontWeight: "700", letterSpacing: "1px", marginTop: "8px" });
          sc.textContent = ev.scorer;
          this.banner.appendChild(sc);
        }
        if (ev.assist) {
          const as = document.createElement("div");
          Object.assign(as.style, { fontSize: "19px", fontWeight: "600", letterSpacing: "1px", marginTop: "3px", opacity: "0.85" });
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

    // substitution feed: one chip per swap, centred like the event banner,
    // fading out at the end of its life
    this.subFeed.replaceChildren();
    for (const e of game.subEvents) {
      const color = colorOf(e.team);
      const chip = document.createElement("div");
      Object.assign(chip.style, {
        background: "rgba(12,15,22,0.86)", border: `1px solid ${color}`,
        borderRadius: "10px", padding: "8px 22px", textAlign: "center",
        opacity: String(Math.min(1, e.ttl / 0.8)),
        boxShadow: "0 6px 20px rgba(0,0,0,0.45)",
      } as Partial<CSSStyleDeclaration>);
      const title = document.createElement("div");
      Object.assign(title.style, { fontSize: "13px", opacity: "0.7", letterSpacing: "3px", fontWeight: "700" });
      title.textContent = "メンバーチェンジ";
      const line = document.createElement("div");
      Object.assign(line.style, {
        fontSize: "26px", fontWeight: "800", color, letterSpacing: "1px",
        textShadow: "0 3px 12px rgba(0,0,0,0.5)",
      });
      line.textContent = e.text;
      chip.append(title, line);
      this.subFeed.appendChild(chip);
    }
  }
}
