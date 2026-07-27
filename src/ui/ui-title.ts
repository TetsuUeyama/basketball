// UI: タイトル画面・クラブ対戦ウィザード。
import { TEAM_NAMES, TEAM_CLUB, teamAbbr } from "../config";
import { CLUB_ABBR } from "../data/club/clubabbr";
import { CLUB_FLAGS } from "../data/club/clubflags";
import { clubTeam } from "../roster";
import { CLUBS } from "../data/club/clubdb";
import { UI, colorOf, BTN_BG, INK, ELLIPSIS } from "./ui";

declare module "./ui" {
  interface UI {
    buildTitle(): void;
    closeChooser(): void;
    leaguesInOrder(): string[];
    assignClub(team: number, idx: number): void;
    leagueGroups(): { label: string; leagues: string[] }[];
    startClubMatchup(): void;
    openMatchupWizard(): void;
  }
}

  // ---- タイトル画面 -------------------------------------------------------
  // 最初の画面: クラブチーム対戦かランダム対戦を選ぶ。
UI.prototype.buildTitle = function(): void {
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
        background: BTN_BG, color: "#fff", borderRadius: "12px",
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
      b.onmouseleave = () => { b.style.background = BTN_BG; };
      b.onclick = onClick;
      return b;
    };

    const clubBtn = bigBtn("クラブチーム対戦", "リーグとチームを選んで対戦", () => this.startClubMatchup());
    const randClubBtn = bigBtn("ランダムクラブ", "実クラブをランダムに選んで対戦", () => {
      // 実クラブから重複しない2つをランダムに選ぶ
      const a = Math.floor(Math.random() * CLUBS.length);
      let b = Math.floor(Math.random() * CLUBS.length);
      if (CLUBS.length > 1) { while (b === a) b = Math.floor(Math.random() * CLUBS.length); }
      this.assignClub(0, a);        // ロスター + 名前 + ユニフォーム + 自動ラインナップ/ロール
      this.assignClub(1, b);
      this.onSetupLineups();        // 相手を考慮した DEFAULT の5人（エディタ表示前）
      this.refreshEditors();
      this.setPhase("pregame");
    });
    const randBtn = bigBtn("ランダム対戦", "ランダム編成で対戦（編成は自由に変更可）", () => {
      this.newMatchup();
      this.onSetupLineups();        // 相手を考慮した DEFAULT の5人（エディタ表示前）
      this.setPhase("pregame");
    });

    p.append(title, sub, clubBtn, randClubBtn, randBtn);
    this.root.appendChild(p);
    this.titlePanel = p;
};

UI.prototype.closeChooser = function(): void {
    if (this.chooser) { this.chooser.remove(); this.chooser = null; }
};

  // 重複を除いたリーグ一覧。初出順（clubdb のグルーピングに一致）。
UI.prototype.leaguesInOrder = function(): string[] {
    const out: string[] = [];
    for (const [, lg] of CLUBS) if (!out.includes(lg)) out.push(lg);
    return out;
};

  // 実クラブを1チームに適用する（ロスター + 名前 + ユニフォーム + 自動ラインナップ/ロール）。エディタの再構築はしない。
UI.prototype.assignClub = function(team: number, idx: number): void {
    clubTeam(team, idx);
    TEAM_NAMES[team] = CLUBS[idx][0];
    TEAM_CLUB[team] = CLUBS[idx][0];   // このチームはクラブ独自のユニフォームを着る
    this.onUniformToggle();
    this.optimizeLineup(team);
    this.autoAssignRoles(team);
    this.autoAssignChoiceRanks(team);
};

  // リーグのグループ。他リーグA までは独自グループ、それ以下は 南米 と その他B にまとめる。
UI.prototype.leagueGroups = function(): { label: string; leagues: string[] }[] {
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
};

  // ウィザードの入口: ホーム（team 0）、続いてアウェイ（team 1）のクラブを選ぶ。
UI.prototype.startClubMatchup = function(): void {
    this.titlePanel.style.display = "none";
    this.openMatchupWizard();
};

UI.prototype.openMatchupWizard = function(): void {
    this.closeChooser();

    const OPAQUE = "#080a0f";
    // オーバーレイ自体は透明。不透明なタイルが、3Dの選手を描画する2つの透明な
    // 「ウィンドウ」を除いて画面全体を覆う（main.ts が onUniformPreview で描画）。
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

    // 2) ユニフォーム帯 — 2つの透明なウィンドウ（左=ホーム、右=アウェイ）、残りは不透明。
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
      // 矩形の3Dビューポートの角を丸める: (a) 4隅を不透明なくさび（radial-gradient
      // マスク）で覆い、(b) その上に丸い色付きの枠線を描く。
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
        color: colorOf(t), ...ELLIPSIS,
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
    // ウィンドウは戦力バーと同じ幅（min(560px,94vw)）のコンテナの両端に置き、バーの端に揃える。
    // 透明な連鎖の中の要素は背景を持たせず、不透明な兄弟タイルだけがカバーを担う。
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

    // ボトムシート: パネルは 1200px で頭打ちにして中央寄せ、内容も中央寄せ。
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

    // リーグの「フラッグ」: 国旗風のデザイン。グループ（他リーグA / 南米 / その他B）は中立 / 大陸風。
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

    // リーグ一覧とクラブ一覧の共有ビルダー（maxRows 行まで、超えるとスクロール）。
    const IDLE_BORDER = "rgba(255,255,255,0.16)";
    const COL = 100, GAP = 8, ROW_H = 54;
    const makeScroll = (): { scrollArea: HTMLDivElement; grid: HTMLDivElement } => {
      const maxRows = window.innerWidth <= 480 ? 3 : 4;
      const scrollArea = document.createElement("div");
      Object.assign(scrollArea.style, { maxHeight: `${maxRows * ROW_H}px`, overflowY: "auto", width: "100%" } as Partial<CSSStyleDeclaration>);
      // 固定幅フラッグの flex-wrap 行で左揃え。ブロックは N 列幅で中央寄せ（centerGrid 参照）。
      const grid = document.createElement("div");
      Object.assign(grid.style, {
        display: "flex", flexWrap: "wrap", justifyContent: "flex-start", alignContent: "flex-start",
        gap: `${GAP}px`, margin: "0 auto", boxSizing: "border-box",
      } as Partial<CSSStyleDeclaration>);
      scrollArea.append(grid);
      return { scrollArea, grid };
    };
    // グリッドブロックを収まる整数個の列幅にサイズ調整する。DOM に入った後で呼ぶこと。
    const centerGrid = (scrollArea: HTMLDivElement, grid: HTMLDivElement): void => {
      const avail = scrollArea.clientWidth || COL;
      const cols = Math.max(1, Math.floor((avail + GAP) / (COL + GAP)));
      grid.style.width = `${cols * (COL + GAP) - GAP}px`;
    };
    const makeFlag = (design: string[] | undefined, overlay: string, label: string): HTMLButtonElement => {
      const btn = document.createElement("button");
      Object.assign(btn.style, {
        // 枠線は border ではなく INSET の box-shadow で描く（丸めた角にきれいに沿う）。
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
        ...ELLIPSIS,
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
        background: colorOf(team), color: INK, border: `1px solid ${colorOf(team)}`,
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
};
