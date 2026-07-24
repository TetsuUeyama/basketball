// UI: 試合中HUD（選手バー・顔アイコン・drawFace・スタミナ・スタッツポップ・各種ボタン）。
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
    refreshSpeed(): void;
    positionMenu(): void;
    refreshStaminaBtn(): void;
    refreshNamesBtn(): void;
    refreshModelBtn(): void;
    buildPlayerBars(): void;
    makeFaceIcon(player: import("../objects/player/player").Player, posText: string): HTMLDivElement;
    updateIconRoles(game: Game): void;
    drawFace(canvas: HTMLCanvasElement, player: import("../objects/player/player").Player): void;
    refreshPlayerBars(game: Game): void;
    updateIconStamina(game: Game): void;
    updateStatPops(game: Game): void;
    popStat(player: import("../objects/player/player").Player, label: string, delta: number,

                  color: string, stack: number): void;
  }
}

UI.prototype.refreshSpeed = function(): void {
    this.speedBtns.forEach((b, i) => {
      const active = [1, 2, 4][i] === this.speed;
      b.style.background = active ? "rgba(70,120,220,0.95)" : "rgba(20,24,34,0.9)";
    });
};

  // 中央寄せのスコアボードが届かない限り ☰ を上端（スコアボードと揃える）に
  // 保つ; その右端が衝突するようになったときだけボードの下に落とす。構築時と
  // リサイズのたびに再計算する。
UI.prototype.positionMenu = function(): void {
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
};

  // 現在の体力バーの位置をトグルボタンのラベルに反映する。
UI.prototype.refreshStaminaBtn = function(): void {
    if (!this.staminaBtn) return;
    this.staminaBtn.textContent = HUD_OPTS.staminaOn === "name"
      ? "体力: 名前の下" : "体力: アイコンの下";
};

  // コート上の名前タグのオン/オフ状態をトグルボタンに反映する。
UI.prototype.refreshNamesBtn = function(): void {
    if (!this.namesBtn) return;
    this.namesBtn.textContent = HUD_OPTS.showNames ? "選手名: 表示" : "選手名: 非表示";
};

  // 現在の選手モデルのスタイルをトグルボタンに反映する。
UI.prototype.refreshModelBtn = function(): void {
    if (!this.modelBtn) return;
    this.modelBtn.textContent = HUD_OPTS.model === "human" ? "モデル: 人型" : "モデル: どんぐり";
};

UI.prototype.buildPlayerBars = function(): void {
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
};

  // 小さな顔アバター: チームカラーの円盤、生成された簡単な頭部、そして背番号。
  // その下に選手名。肖像画のアートは存在しないため、顔は手続き的に描かれ、
  // 番号/名前が選手を識別する。
UI.prototype.makeFaceIcon = function(player: import("../objects/player/player").Player, posText: string): HTMLDivElement {
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
};

  // 毎フレーム: この選手のチームがボールを持っているときはオフェンスロール、
  // それ以外は守備ロールを表示 — オフェンスはチームカラー、守備は DEF_ROLE_C の色。
UI.prototype.updateIconRoles = function(game: Game): void {
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
};

UI.prototype.drawFace = function(canvas: HTMLCanvasElement, player: import("../objects/player/player").Player): void {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const W = canvas.width, H = canvas.height;
    const tc = TEAM_COLORS[player.team];
    // チームカラーの背景円盤
    ctx.fillStyle = `rgb(${Math.round(tc.r * 120 + 25)},${Math.round(tc.g * 120 + 25)},${Math.round(tc.b * 120 + 25)})`;
    ctx.fillRect(0, 0, W, H);
    // 選手ごとに決定的な多様性を持たせ、顔が全て同一にならないようにする —
    // playerLook 経由で3Dの頭部（entities.ts）と共有され、モデルがアイコンに一致する
    const look = player.look ?? playerLook(player.name);   // DB選手はdef.look、無ければ名前フォールバック
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
};

UI.prototype.refreshPlayerBars = function(game: Game): void {
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
      const posOf = (p: import("../objects/player/player").Player) =>
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
};

  // 顔アイコンの体力バーをライブ更新する（「icon」HUD モードでのみ意味がある;
  // それ以外ではバーは隠れている）。選手をキーにするので、彼のために現在画面上に
  // あるどのアイコン要素でも追跡する。
UI.prototype.updateIconStamina = function(game: Game): void {
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
};

  // 浮遊する「＋」バッジ: 各選手のボックススコアを前フレームと比較し、彼が今
  // 記録したもの（得点/アシスト/リバウンド/等）についてアイコン上にバッジをポップする。
UI.prototype.updateStatPops = function(game: Game): void {
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
};

UI.prototype.popStat = function(player: import("../objects/player/player").Player, label: string, delta: number,
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
};
