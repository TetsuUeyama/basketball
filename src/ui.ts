import { Game } from "./game";
import { TEAM_NAMES, TEAM_COLORS } from "./config";
import { ROSTER, computeOffPriority, type Attributes } from "./attributes";

const colorOf = (team: number): string => {
  const c = TEAM_COLORS[team];
  return `rgb(${c.r * 255},${c.g * 255},${c.b * 255})`;
};

const clamp100 = (v: number): number => Math.max(0, Math.min(100, v));

type Phase = "pregame" | "playing" | "result";

// Editable rating columns shown in the pre-game roster editor.
const ATTR_FIELDS: { key: keyof Attributes; label: string }[] = [
  { key: "speed", label: "SPD" },
  { key: "strength", label: "STR" },
  { key: "finishing", label: "FIN" },
  { key: "midRange", label: "MID" },
  { key: "three", label: "3PT" },
  { key: "defRebound", label: "REB" },
  { key: "steal", label: "STL" },
  { key: "passing", label: "PAS" },
];
// Per-column explanations, shown in a modal when the header is clicked.
const INFO: Record<string, string> = {
  NAME: "選手名。自由に変更できます。",
  POS: "ポジション（PG/SG/SF/PF/C）。役割で動きが変わります。PF/Cはゴール下へのポストアップ（押し込み）でレイアップ/ダンク、PGはボール運び・ゲームメイクを担います。",
  HT: "身長(cm)。リバウンド・ブロック・ゴール下の競り合い(手の届く高さ)に影響します。",
  SPD: "走力。コート上の移動速度。",
  STR: "強さ（フィジカル）。ゴール下やドライブでの押し合い・押し返しの強さ。高いほど押されにくく、相手を押し下げられます。",
  FIN: "フィニッシュ力。リム付近のレイアップ/ダンクの決定力。",
  MID: "ミドルシュート決定力。",
  "3PT": "3ポイントシュート決定力。",
  REB: "リバウンド力。ルーズボール確保の競り合いに影響。",
  STL: "スティール力。ボールへの絡み・パスカットの成功率。",
  PAS: "パス力。パスの通しやすさ／カットされにくさ。",
  PRI: "オフェンス優先度（ファースト/セカンドチョイス）。高いほど第1得点オプションとして優先的にボールが集まり、自分から攻めます。低いほど第2・第3オプションに回ります。",
};
const ROLES = ["PG", "SG", "SF", "PF", "C"];
const STAT_COLS: { key: keyof import("./entities").Stats; label: string }[] = [
  { key: "pts", label: "PTS" },
  { key: "reb", label: "REB" },
  { key: "ast", label: "AST" },
  { key: "stl", label: "STL" },
  { key: "blk", label: "BLK" },
  { key: "tov", label: "TO" },
];

// A DOM overlay with three screens: a pre-game roster editor, the in-game HUD,
// and a final result screen with each player's box score.
export class UI {
  private root: HTMLDivElement;
  private hud: HTMLDivElement;
  private pregamePanel!: HTMLDivElement;
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
  private speedBtns: HTMLButtonElement[] = [];

  private phase: Phase = "pregame";

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

    // ---- event banner ----
    this.banner = document.createElement("div");
    css(this.banner, {
      position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)",
      fontSize: "52px", fontWeight: "800", letterSpacing: "2px", opacity: "0",
      textShadow: "0 4px 20px rgba(0,0,0,0.6)", transition: "opacity 0.2s",
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
    hintRow.textContent = "名前・身長(cm)・ポジション・能力(0–100)を設定して TIP OFF。列見出し(ⓘ)をクリックすると各項目の説明が出ます。";

    p.append(title, hintRow);
    for (let t = 0; t < 2; t++) p.appendChild(this.buildTeamEditor(t));

    const start = this.button("TIP OFF");
    Object.assign(start.style, { fontSize: "17px", padding: "11px 30px", marginTop: "8px", background: "rgba(70,120,220,0.95)" });
    start.onclick = () => { this.setPhase("playing"); this.onStart(); };
    p.appendChild(start);

    this.root.appendChild(p);
    this.pregamePanel = p;
  }

  private buildTeamEditor(team: number): HTMLDivElement {
    const color = colorOf(team);
    const wrap = document.createElement("div");
    Object.assign(wrap.style, {
      width: "100%", margin: "8px 0", padding: "10px 12px", boxSizing: "border-box",
      background: "rgba(255,255,255,0.03)", border: `1px solid ${color}`, borderRadius: "10px",
    } as Partial<CSSStyleDeclaration>);

    const head = document.createElement("div");
    Object.assign(head.style, { fontSize: "16px", fontWeight: "800", color, textAlign: "left", marginBottom: "6px" });
    head.textContent = TEAM_NAMES[team];
    wrap.appendChild(head);

    // the wide table scrolls horizontally inside the box (so it never widens the
    // panel beyond the screen); header + rows scroll together
    const scroller = document.createElement("div");
    Object.assign(scroller.style, { width: "100%", overflowX: "auto", paddingBottom: "4px" } as Partial<CSSStyleDeclaration>);
    const table = document.createElement("div");
    Object.assign(table.style, { width: "max-content" } as Partial<CSSStyleDeclaration>);

    const cols = document.createElement("div");
    Object.assign(cols.style, { display: "flex", gap: "6px", alignItems: "center", fontSize: "11px", fontWeight: "700", opacity: "0.9", margin: "2px 0 4px" });
    cols.appendChild(this.headerCell("NAME", 90));
    cols.appendChild(this.headerCell("POS", 48));
    cols.appendChild(this.headerCell("HT", 46));
    for (const f of ATTR_FIELDS) cols.appendChild(this.headerCell(f.label, 40));
    cols.appendChild(this.headerCell("PRI", 40));
    table.appendChild(cols);

    for (let i = 0; i < 5; i++) table.appendChild(this.editorRow(team, i));
    scroller.appendChild(table);
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
      width: "90px", flexShrink: "0", fontSize: "13px", fontWeight: "700", pointerEvents: "auto", boxSizing: "border-box",
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
    Object.assign(wrap.style, { width: "40px", flexShrink: "0", display: "flex", flexDirection: "column", alignItems: "center", gap: "3px" } as Partial<CSSStyleDeclaration>);

    const inp = document.createElement("input");
    inp.type = "number"; inp.min = "0"; inp.max = "100"; inp.value = String(value);
    Object.assign(inp.style, {
      width: "40px", fontSize: "12px", textAlign: "center", pointerEvents: "auto", boxSizing: "border-box",
      background: "rgba(20,24,34,0.9)", color: "#fff", border: "1px solid rgba(255,255,255,0.2)", borderRadius: "4px",
    } as Partial<CSSStyleDeclaration>);

    const track = document.createElement("div");
    Object.assign(track.style, { width: "40px", height: "5px", background: "rgba(255,255,255,0.12)", borderRadius: "3px", overflow: "hidden" } as Partial<CSSStyleDeclaration>);
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
    back.onclick = () => { this.setPhase("pregame"); this.onBack(); };

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
    cols.appendChild(this.cell("", 70));
    for (const c of STAT_COLS) cols.appendChild(this.cell(c.label, 38, "center"));
    table.appendChild(cols);

    for (let i = 0; i < 5; i++) {
      const pl = game.players[team * 5 + i];
      const row = document.createElement("div");
      Object.assign(row.style, { display: "flex", gap: "4px", fontSize: "12px", margin: "1px 0" });
      const nm = this.cell(`${pl.role} ${pl.name}`, 70);
      nm.style.opacity = "0.95";
      row.appendChild(nm);
      for (const c of STAT_COLS) row.appendChild(this.cell(String(pl.stats[c.key]), 38, "center"));
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

  update(game: Game): void {
    if (this.phase === "playing" && game.state === "final") this.showResult(game);

    this.scoreA.textContent = String(game.score[0]);
    this.scoreB.textContent = String(game.score[1]);
    const t = Math.max(0, game.gameClock);
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    this.clock.textContent = `${m}:${s.toString().padStart(2, "0")}`;
    this.quarter.textContent = game.state === "final" ? "FINAL" : `Q${game.quarter}`;
    this.shot.textContent = String(Math.max(0, Math.ceil(game.shotClock)));

    if (game.lastEvent) {
      const c = TEAM_COLORS[game.lastEvent.team];
      this.banner.textContent = game.lastEvent.text;
      this.banner.style.color = `rgb(${c.r * 255},${c.g * 255},${c.b * 255})`;
      this.banner.style.opacity = "0.95";
    } else {
      this.banner.style.opacity = "0";
    }
  }
}
