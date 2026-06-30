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
  { key: "three", label: "3PT" },
  { key: "midRange", label: "MID" },
  { key: "finishing", label: "FIN" },
  { key: "defRebound", label: "REB" },
  { key: "steal", label: "STL" },
  { key: "passing", label: "PAS" },
];
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

    this.buildPregame();
    this.buildResult();
    this.refreshSpeed();
    this.setPhase("pregame");
  }

  // ---- screens -----------------------------------------------------------

  private panel(): HTMLDivElement {
    const p = document.createElement("div");
    Object.assign(p.style, {
      position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)",
      display: "flex", flexDirection: "column", alignItems: "center", gap: "16px",
      background: "rgba(12,15,22,0.94)", border: "1px solid rgba(255,255,255,0.14)",
      borderRadius: "16px", padding: "26px 34px", boxShadow: "0 12px 44px rgba(0,0,0,0.55)",
      pointerEvents: "auto", textAlign: "center", maxHeight: "92vh", maxWidth: "94vw",
      overflow: "auto",
    } as Partial<CSSStyleDeclaration>);
    return p;
  }

  private buildPregame(): void {
    const p = this.panel();

    const title = document.createElement("div");
    Object.assign(title.style, { fontSize: "26px", fontWeight: "800", letterSpacing: "2px" });
    title.textContent = "BASKETBALL — LINE-UPS";

    const hintRow = document.createElement("div");
    Object.assign(hintRow.style, { fontSize: "12px", opacity: "0.6" });
    hintRow.textContent = "set position / ratings (0–100) / PRI = offensive priority, then tip off";

    p.append(title, hintRow);
    for (let t = 0; t < 2; t++) p.appendChild(this.buildTeamEditor(t));

    const start = this.button("TIP OFF");
    Object.assign(start.style, { fontSize: "16px", padding: "10px 26px", marginTop: "6px", background: "rgba(70,120,220,0.95)" });
    start.onclick = () => { this.setPhase("playing"); this.onStart(); };
    p.appendChild(start);

    this.root.appendChild(p);
    this.pregamePanel = p;
  }

  private buildTeamEditor(team: number): HTMLDivElement {
    const wrap = document.createElement("div");
    Object.assign(wrap.style, { width: "100%", margin: "2px 0" });

    const head = document.createElement("div");
    Object.assign(head.style, { fontSize: "15px", fontWeight: "800", color: colorOf(team), textAlign: "left", margin: "4px 0" });
    head.textContent = TEAM_NAMES[team];
    wrap.appendChild(head);

    // column header row
    const cols = document.createElement("div");
    Object.assign(cols.style, { display: "flex", gap: "4px", alignItems: "center", fontSize: "10px", opacity: "0.6", margin: "2px 0" });
    cols.appendChild(this.cell("", 58));
    cols.appendChild(this.cell("POS", 42));
    for (const f of ATTR_FIELDS) cols.appendChild(this.cell(f.label, 34, "center"));
    cols.appendChild(this.cell("PRI", 34, "center"));
    wrap.appendChild(cols);

    for (let i = 0; i < 5; i++) wrap.appendChild(this.editorRow(team, i));
    return wrap;
  }

  private editorRow(team: number, i: number): HTMLDivElement {
    const def = ROSTER[team][i];
    const row = document.createElement("div");
    Object.assign(row.style, { display: "flex", gap: "4px", alignItems: "center", margin: "2px 0", fontSize: "11px" });

    const name = this.cell(def.name, 58);
    row.appendChild(name);

    const role = document.createElement("select");
    Object.assign(role.style, {
      width: "42px", fontSize: "11px", pointerEvents: "auto",
      background: "rgba(20,24,34,0.9)", color: "#fff", border: "1px solid rgba(255,255,255,0.18)", borderRadius: "4px",
    });
    for (const r of ROLES) {
      const o = document.createElement("option");
      o.value = r; o.textContent = r;
      if (r === def.role) o.selected = true;
      role.appendChild(o);
    }
    role.onchange = () => { def.role = role.value; };
    row.appendChild(role);

    for (const f of ATTR_FIELDS) {
      const inp = this.numInput(def.attr[f.key]);
      inp.onchange = () => { def.attr[f.key] = clamp100(parseInt(inp.value) || 0); inp.value = String(def.attr[f.key]); };
      row.appendChild(inp);
    }

    const pri = this.numInput(Math.round(computeOffPriority(def) * 100));
    pri.onchange = () => {
      const v = clamp100(parseInt(pri.value) || 0);
      def.priority = v / 100;
      pri.value = String(v);
    };
    row.appendChild(pri);

    return row;
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

    const cols = document.createElement("div");
    Object.assign(cols.style, { display: "flex", gap: "4px", fontSize: "10px", opacity: "0.6", margin: "1px 0" });
    cols.appendChild(this.cell("", 70));
    for (const c of STAT_COLS) cols.appendChild(this.cell(c.label, 38, "center"));
    wrap.appendChild(cols);

    for (let i = 0; i < 5; i++) {
      const pl = game.players[team * 5 + i];
      const row = document.createElement("div");
      Object.assign(row.style, { display: "flex", gap: "4px", fontSize: "12px", margin: "1px 0" });
      const nm = this.cell(`${pl.role} ${pl.name}`, 70);
      nm.style.opacity = "0.95";
      row.appendChild(nm);
      for (const c of STAT_COLS) row.appendChild(this.cell(String(pl.stats[c.key]), 38, "center"));
      wrap.appendChild(row);
    }
    return wrap;
  }

  // ---- small builders ----------------------------------------------------

  private cell(text: string, width: number, align: string = "left"): HTMLSpanElement {
    const el = document.createElement("span");
    Object.assign(el.style, { width: `${width}px`, textAlign: align, display: "inline-block" } as Partial<CSSStyleDeclaration>);
    el.textContent = text;
    return el;
  }

  private numInput(val: number): HTMLInputElement {
    const inp = document.createElement("input");
    inp.type = "number"; inp.min = "0"; inp.max = "100"; inp.value = String(val);
    Object.assign(inp.style, {
      width: "34px", fontSize: "11px", textAlign: "center", pointerEvents: "auto",
      background: "rgba(20,24,34,0.9)", color: "#fff", border: "1px solid rgba(255,255,255,0.18)", borderRadius: "4px",
    } as Partial<CSSStyleDeclaration>);
    return inp;
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
