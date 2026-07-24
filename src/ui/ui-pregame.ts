// UI: 試合前エディタ・VSボード・ロスターカード・ドラッグ入替。
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
    buildPregame(): void;
    newMatchup(): void;
    randomizeOne(team: number): void;
    tipOffButton(): HTMLButtonElement;
    rostersFitSideBySide(): boolean;
    refreshEditors(): void;
    buildVsBoard(preview?: { team: number; roster: PlayerDef[] }): HTMLDivElement;
    replaceVsBoard(next: HTMLDivElement): void;
    showVsPreview(team: number, idx: number, dbp: DbPlayer): void;
    previewRole(def: PlayerDef, team: number, role: string): void;
    showSwapPreview(team: number, idxA: number, idxB: number): void;
    clearVsPreview(): void;
    rosterCard(team: number): HTMLDivElement;
    playerRow(team: number, i: number): HTMLDivElement;
    beginDrag(team: number, idx: number, ev: PointerEvent): void;
    dropTargetAt(x: number, y: number): { team: number; idx: number; el: HTMLElement } | null;
  }
}

UI.prototype.buildPregame = function(): void {
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
};

  /** データベースから新たなランダムマッチアップを引き、エディタを再構築する。 */
UI.prototype.newMatchup = function(): void {
    TEAM_NAMES[0] = UI.DEFAULT_NAMES[0];   // ランダム抽選は再び BLAZE/WAVE
    TEAM_NAMES[1] = UI.DEFAULT_NAMES[1];
    TEAM_CLUB[0] = TEAM_CLUB[1] = "";       // ...そして汎用のチームユニフォームに戻す
    this.onUniformToggle();
    randomizeRosters();
    this.optimizeLineup(0); this.optimizeLineup(1);   // 各ポジションの最強選手が先発
    this.autoAssignRoles();        // 新規抽選に対する妥当なデフォルトの攻守ロール
    this.autoAssignChoiceRanks();  // 得点力によるプライマリ 1..5（先発 + ベンチ）
    this.refreshEditors();
};

  /** 1チームのロスターだけを引き直し（もう一方のチームはそのまま）、再構築する。 */
UI.prototype.randomizeOne = function(team: number): void {
    TEAM_NAMES[team] = UI.DEFAULT_NAMES[team];   // クラブ名から戻す
    TEAM_CLUB[team] = "";                        // ...そして汎用のチームユニフォームに戻す
    this.onUniformToggle();
    randomizeTeam(team);
    this.optimizeLineup(team);         // 各ポジションの最強選手をラインナップに入れる
    this.autoAssignRoles(team);        // このチームの新規抽選に対するデフォルトの攻守ロール
    this.autoAssignChoiceRanks(team);  // このチームだけのプライマリ 1..5
    this.refreshEditors();
};

  // 大きな青い「試合開始」ボタン — 2チームの間に置かれる（横並び表示の中央、
  // または狭いときはチームタブの間）。
UI.prototype.tipOffButton = function(): HTMLButtonElement {
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
};

  // 2枚の 320px カード + TIP OFF 列 + gap ≈ 760px の内容。モーダルは 96vw と
  // padding で頭打ちなので、これが収まるのはビューポートが約 830px 幅になって
  // から。それ未満ではモーダルが両方を保持できないため、カードをあふれさせ/
  // 折り返すのではなく、タブトグルにフォールバックする。
UI.prototype.rostersFitSideBySide = function(): boolean {
    return window.innerWidth >= 840;
};

  /** 現在の ROSTER から VS ボードと両方のロスターカードを再構築する。 */
UI.prototype.refreshEditors = function(): void {
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
};

  // `preview`（取り込む DB 選手を対象行の上に運んでいる間に設定される）は、
  // 交代が起きたら1チームの戦力バーがどう変わるかを示す: 各バーの変化した
  // 部分と ±N の数値が淡い緑 / 薄い赤で色付けされる。
UI.prototype.buildVsBoard = function(preview?: { team: number; roster: PlayerDef[] }): HTMLDivElement {
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
};

  // ライブの VS ボード要素を新しく構築したものに差し替える（任意でプレビュー）。
UI.prototype.replaceVsBoard = function(next: HTMLDivElement): void {
    if (this.vsBoard?.parentElement) this.vsBoard.parentElement.replaceChild(next, this.vsBoard);
    this.vsBoard = next;
};

  // 「この交代がチーム戦力に何をするか」のプレビューをボード上に表示/クリアする。
UI.prototype.showVsPreview = function(team: number, idx: number, dbp: DbPlayer): void {
    const roster = ROSTER[team].slice();
    roster[idx] = makeDefFromDb(dbp);
    this.vsPreviewActive = true;
    this.replaceVsBoard(this.buildVsBoard({ team, roster }));
};

  // 評価ロールの変更がこの選手のチームの戦力バーをどう動かすかをプレビューする。
UI.prototype.previewRole = function(def: PlayerDef, team: number, role: string): void {
    const idx = ROSTER[team].indexOf(def);
    if (idx < 0) return;
    const roster = ROSTER[team].slice();
    roster[idx] = { ...def, evalRole: role === "自動" ? undefined : role };  // attr は共有（読み取り専用）
    this.vsPreviewActive = true;
    this.replaceVsBoard(this.buildVsBoard({ team, roster }));
};

  // チームのロスタースロットを2つ交換（先発 ⇄ ベンチ、ドラッグ＆ドロップで）
  // したときに戦力バーがどう動くかをプレビューする — 先発は 70%、ベンチは 30%
  // なので、強い控えを先発5人に入れるとチームが底上げされる。
UI.prototype.showSwapPreview = function(team: number, idxA: number, idxB: number): void {
    const roster = ROSTER[team].slice();
    [roster[idxA], roster[idxB]] = [roster[idxB], roster[idxA]];
    this.vsPreviewActive = true;
    this.replaceVsBoard(this.buildVsBoard({ team, roster }));
};

UI.prototype.clearVsPreview = function(): void {
    if (!this.vsPreviewActive) return;
    this.vsPreviewActive = false;
    this.replaceVsBoard(this.buildVsBoard());
};

  // 1チームのロスター: コンパクトな行（ポジション / 名前 / 身長 / OVR）、先発は
  // ベンチの区切りの上。選手をクリックし、次に別の選手をクリックすると入れ替え —
  // ホバーで詳細カード（ヘックスチャート + 特殊能力）が表示される。
UI.prototype.rosterCard = function(team: number): HTMLDivElement {
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
};

UI.prototype.playerRow = function(team: number, i: number): HTMLDivElement {
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
};

  // ドラッグ＆ドロップの入れ替え: 選手のバーを掴み、運び（カーソルに追従する）、
  // チームメイトの上にドロップする — 先発 ⇄ ベンチも含む — と2つのロスター
  // スロットが交換される。タッチでは長押しでバーが持ち上がる（単なるスワイプは
  // これまで通りリストをスクロールする）。
UI.prototype.beginDrag = function(team: number, idx: number, ev: PointerEvent): void {
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
};

  // ポインタの下のロスター行（あれば）。ゴーストはポインタイベントを無視する
  // ため、elementFromPoint はそれを素通しで見る。
UI.prototype.dropTargetAt = function(x: number, y: number): { team: number; idx: number; el: HTMLElement } | null {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    const row = el?.closest("[data-drop-team]") as HTMLElement | null;
    if (!row) return null;
    return { team: Number(row.dataset.dropTeam), idx: Number(row.dataset.dropIdx), el: row };
};
