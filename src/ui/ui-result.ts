// UI: 結果画面・スタッツ表・チーム比較。
// プロトタイプ拡張で UI に紐づけ（main.ts が副作用 import）。
import type { Game } from "../game";
import { teamAbbr, teamShort } from "../config";
import { STARTERS } from "../roster";
import { UI, colorOf, BTN_BG, ELLIPSIS } from "./ui";

declare module "./ui" {
  interface UI {
    buildResult(): void;
    refreshBoardNames(): void;
    showResult(game: Game): void;
    resultTabBar(): HTMLDivElement;
    renderResultTab(): void;
    statsTable(game: Game, team: number): HTMLDivElement;
    teamCompare(game: Game): HTMLDivElement;
    cell(text: string, width: number, align?: string): HTMLSpanElement;
    stickyCell(text: string, width: number): HTMLSpanElement;
    teamBlock(name: string, color: string, align: string): HTMLElement;
    scoreEl(color: string): HTMLSpanElement;
    button(label: string): HTMLButtonElement;
  }
}

UI.prototype.buildResult = function(): void {
    const p = this.panel();

    const title = document.createElement("div");
    Object.assign(title.style, { fontSize: "20px", fontWeight: "700", letterSpacing: "3px", opacity: "0.8" });
    title.textContent = "FINAL";

    this.resultScore = document.createElement("div");
    // フォントはビューポート幅に合わせて拡縮（モバイルで1行に収める）。
    Object.assign(this.resultScore.style, {
      fontSize: "clamp(15px, 5.4vw, 32px)", fontWeight: "800", whiteSpace: "nowrap",
    } as Partial<CSSStyleDeclaration>);

    this.resultWinner = document.createElement("div");
    Object.assign(this.resultWinner.style, {
      fontSize: "clamp(14px, 3.7vw, 20px)", fontWeight: "800", letterSpacing: "1px", whiteSpace: "nowrap",
    } as Partial<CSSStyleDeclaration>);

    this.resultStats = document.createElement("div");
    // 固定幅 = 完全なボックススコア表（小さい画面では頭打ち）。3つのタブで同じ幅を保つ。
    Object.assign(this.resultStats.style, {
      display: "flex", flexDirection: "column", gap: "12px", width: "min(560px, 90vw)",
    } as Partial<CSSStyleDeclaration>);

    const btnRow = document.createElement("div");
    // gap/フォント/padding をビューポートに合わせて縮め、3ボタンを1行に収める。
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
};

  // スコアボードのチームラベルを読み直す（クラブは3文字コード、ランダムは BLAZE / WAVE）。
UI.prototype.refreshBoardNames = function(): void {
    if (this.nameA) this.nameA.textContent = teamAbbr(0);
    if (this.nameB) this.nameB.textContent = teamAbbr(1);
};

UI.prototype.showResult = function(game: Game): void {
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
    // ボックススコアが収まる min-height（タブ切替でモーダルの高さを固定）
    Object.assign(this.resultContent.style, { width: "100%", minHeight: "clamp(230px, 44vh, 360px)" } as Partial<CSSStyleDeclaration>);
    this.resultStats.appendChild(this.resultContent);
    this.renderResultTab();
    this.setPhase("result");
};

  // 3つのリザルトタブ。青 = team 1、赤 = team 0; 各タブはチームカラーで色付け。
UI.prototype.resultTabBar = function(): HTMLDivElement {
    const bar = document.createElement("div");
    Object.assign(bar.style, {
      display: "flex", gap: "6px", justifyContent: "center", flexWrap: "wrap", marginBottom: "6px",
    } as Partial<CSSStyleDeclaration>);
    // 3文字ラベルで3タブを1行に収める。TOT = チーム合計/比較; チームタブは各側の
    // 3文字コード。
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
};

UI.prototype.renderResultTab = function(): void {
    if (!this.resultGame || !this.resultContent) return;
    for (const { key, el } of this.resultTabBtns) {
      const active = key === this.resultTab;
      el.style.background = active ? "rgba(255,255,255,0.16)" : BTN_BG;
      el.style.borderColor = active ? "rgba(255,255,255,0.55)" : "rgba(255,255,255,0.18)";
      el.style.opacity = active ? "1" : "0.65";
    }
    this.resultContent.replaceChildren();
    if (this.resultTab === "team") this.resultContent.appendChild(this.teamCompare(this.resultGame));
    else if (this.resultTab === "blue") this.resultContent.appendChild(this.statsTable(this.resultGame, 1));
    else this.resultContent.appendChild(this.statsTable(this.resultGame, 0));
};

UI.prototype.statsTable = function(game: Game, team: number): HTMLDivElement {
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
};

  // チーム対チームの比較: 合計を左右に並べる（team0 が左、team1 が右、間にスタッツ名）。
UI.prototype.teamCompare = function(game: Game): HTMLDivElement {
    type S = import("../objects/player/stats").Stats;
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
};

UI.prototype.cell = function(text: string, width: number, align: string = "left"): HTMLSpanElement {
    const el = document.createElement("span");
    Object.assign(el.style, {
      width: `${width}px`, flexShrink: "0", textAlign: align, display: "inline-block",
      // 各セルを1行に保つ（長い名前は … でクリップ）
      ...ELLIPSIS,
    } as Partial<CSSStyleDeclaration>);
    el.textContent = text;
    return el;
};

  // 左に固定されたセル: スタッツ列が横スクロールしても固定される。不透明な背景と縁付き。
UI.prototype.stickyCell = function(text: string, width: number): HTMLSpanElement {
    const el = this.cell(text, width);
    Object.assign(el.style, {
      position: "sticky", left: "0", zIndex: "1", background: "#0c0f16",
      boxShadow: "1px 0 0 rgba(255,255,255,0.12)",
    } as Partial<CSSStyleDeclaration>);
    return el;
};

UI.prototype.teamBlock = function(name: string, color: string, align: string): HTMLElement {
    const el = document.createElement("div");
    Object.assign(el.style, {
      fontSize: "18px", fontWeight: "700", color, minWidth: "70px", textAlign: align,
    } as Partial<CSSStyleDeclaration>);
    el.textContent = name;
    return el;
};

UI.prototype.scoreEl = function(color: string): HTMLSpanElement {
    const el = document.createElement("span");
    Object.assign(el.style, {
      fontSize: "34px", fontWeight: "800", color, minWidth: "48px", textAlign: "center",
    } as Partial<CSSStyleDeclaration>);
    return el;
};

UI.prototype.button = function(label: string): HTMLButtonElement {
    const b = document.createElement("button");
    b.textContent = label;
    Object.assign(b.style, {
      background: BTN_BG, color: "#fff", border: "1px solid rgba(255,255,255,0.18)",
      borderRadius: "8px", padding: "6px 14px", fontSize: "13px", fontWeight: "700", cursor: "pointer",
    } as Partial<CSSStyleDeclaration>);
    return b;
};
