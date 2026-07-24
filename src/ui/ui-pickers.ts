// UI: 各種モーダル（ロール/詳細/選手/クラブピッカー・キャリー・選手カード・ヘックス図）。
// プロトタイプ拡張で UI に紐づけ。本体は ui.ts から逐語移動（this は UI のまま）。
// 呼び出し側は不変。main.ts が副作用 import する。
import { Game } from "../game";
import { TEAM_NAMES, TEAM_COLORS, HUD_OPTS, TEAM_CLUB, teamAbbr, teamShort } from "../config";
import { CLUB_ABBR } from "../clubabbr";
import { CLUB_FLAGS } from "../clubflags";
import { ROSTER, ROSTER_SIZE, STARTERS, randomizeRosters, randomizeTeam, clubTeam, applyDbPlayer, makeDefFromDb, ATTR_META, ABILITY_META, scoringPower, type Attributes, type PlayerDef } from "../attributes";
import { CLUBS } from "../clubdb";
import { PLAYER_DB, type DbPlayer } from "../playerdb";
import { playerLook } from "../objects/player/player-look";
import { UI, colorOf, POP_STATS, type Phase } from "./ui";

declare module "./ui" {
  interface UI {
    openRolePicker(def: PlayerDef, team: number, anchor: HTMLElement,
                   onPick?: () => void, kind?: "off" | "def"): void;
    closeRolePicker(): void;
    openDetailModal(def: PlayerDef, team: number): void;
    closeDetailModal(): void;
    ensureDbIndex(): { p: DbPlayer; ovr: number; lower: string }[];
    openPlayerPicker(team: number): void;
    closePlayerPicker(): void;
    closeClubPicker(): void;
    startCarry(team: number, dbp: DbPlayer): void;
    cancelCarry(): void;
    showPlayerCard(def: PlayerDef, team: number, anchor: HTMLElement): void;
    hidePlayerCard(): void;
    drawHexChart(cv: HTMLCanvasElement, axes: number[], color: string): void;
  }
}

  // 浮遊するロールピッカーのメニュー: ピルを押す → 一覧から評価ロールを選ぶ
  // （現在のものはチームカラーで点灯）。選択時、または外側を押したときに閉じる。
UI.prototype.openRolePicker = function(def: PlayerDef, team: number, anchor: HTMLElement,
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
};

UI.prototype.closeRolePicker = function(): void {
    if (this.rolePicker) { this.rolePicker.remove(); this.rolePicker = null; }
    if (this.rolePickerCloser) {
      window.removeEventListener("pointerdown", this.rolePickerCloser, true);
      this.rolePickerCloser = null;
    }
    this.clearVsPreview();   // ロールホバーのプレビューを取り下げる（有効なものがなければ何もしない）
};

  // 全能力値モーダル（詳 ボタン）: 25 の能力値それぞれを値バーつきで、ヘックス
  // ダイジェスト、そして特殊能力 — 暗くした背景の上に。
UI.prototype.openDetailModal = function(def: PlayerDef, team: number): void {
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
};

UI.prototype.closeDetailModal = function(): void {
    if (this.detailModal) { this.detailModal.remove(); this.detailModal = null; }
    this.hideTip();
};

  // 4000人超の選手データベース全体を OVR 順にソートしたビューを（一度）構築し、
  // ピッカーのキーストローク絞り込みがキャッシュ済みフィールドの単純な配列走査で済むようにする。
UI.prototype.ensureDbIndex = function(): { p: DbPlayer; ovr: number; lower: string }[] {
    if (!this.dbIndex) {
      this.dbIndex = PLAYER_DB
        .map((p) => ({ p, ovr: this.ovrOf(makeDefFromDb(p)), lower: p[0].toLowerCase() }))
        .sort((a, b) => b.ovr - a.ovr);
    }
    return this.dbIndex;
};

  // 選手を交代: チーム名ヘッダーから開く。4000人超のデータベース選手のいずれかを
  // 選ぶ（検索 / ポジションフィルタ / OVR）; 選択するとモーダルが閉じ、選手が
  // カーソルに「運ばれる」 — 彼のチームのロスター行にドロップして選手を入れ替える
  // （startCarry 参照）。
UI.prototype.openPlayerPicker = function(team: number): void {
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
};

UI.prototype.closePlayerPicker = function(): void {
    if (this.playerPicker) { this.playerPicker.remove(); this.playerPicker = null; }
    this.hideTip();
};

UI.prototype.closeClubPicker = function(): void {
    if (this.clubPicker) { this.clubPicker.remove(); this.clubPicker = null; }
};

  // ピッカーが閉じた後、取り込む DB 選手をカーソルに運ぶ。彼のチームのロスター
  // 行での単なる pointerdown で彼をそこにドロップ（その選手を置き換える）;
  // それ以外の場所での pointerdown、または Esc でキャンセル。ボタンは押しっぱなし
  // にしない — ピッカーのクリックは既に終わっているので、これはクリックで配置する操作。
UI.prototype.startCarry = function(team: number, dbp: DbPlayer): void {
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
};

UI.prototype.cancelCarry = function(): void {
    if (this.carryCleanup) { this.carryCleanup(); this.carryCleanup = null; }
    if (this.carryGhost) { this.carryGhost.remove(); this.carryGhost = null; }
    if (this.carryHint) { this.carryHint.remove(); this.carryHint = null; }
    this.carry = null;
};

  // ホバー詳細カード: 6ダイジェストのヘックスチャート + 特殊能力チップ。
UI.prototype.showPlayerCard = function(def: PlayerDef, team: number, anchor: HTMLElement): void {
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
};

UI.prototype.hidePlayerCard = function(): void {
    this.playerCard.style.display = "none";
};

  // ヘックス（レーダー）チャート: 控えめなグリッドのリング + スポーク、チーム
  // カラーの1つのデータ多角形、軸ラベルと正確な値をプレーンなインクで。
UI.prototype.drawHexChart = function(cv: HTMLCanvasElement, axes: number[], color: string): void {
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
};
