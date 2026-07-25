// 試合前の選手紹介ツアー。先発→ベンチのショット列・タイミング・スキップと下部字幕
// ボードを持つ。カメラ操作は BroadcastCamera（introShot/benchShot/endIntro）へ委譲。
import { Game } from "./game";
import { BroadcastCamera } from "./camera";
import { Player } from "./objects/player/player";
import { TEAM_NAMES, TEAM_COLORS } from "./config";

type IntroShot = { kind: "player"; p: Player } | { kind: "bench"; team: number };

const HOLD_PLAYER = 0.9;   // 先発1人のクローズアップの秒数
const HOLD_BENCH = 2.0;    // ベンチ1カットの秒数
const holdOf = (s: IntroShot): number => (s.kind === "player" ? HOLD_PLAYER : HOLD_BENCH);

export class IntroTour {
  private queue: IntroShot[] = [];
  private t = 0;
  // 下部字幕ボード。ツアー中は3Dネームタグを隠し、これが名前を担う。
  private readonly board: HTMLDivElement;
  private shown: IntroShot | null = null;

  constructor(private game: Game, private camera: BroadcastCamera) {
    const board = document.createElement("div");
    Object.assign(board.style, {
      position: "fixed", left: "50%", bottom: "14%", transform: "translateX(-50%)",
      display: "none", zIndex: "40", pointerEvents: "none",
      background: "rgba(8,11,18,0.9)", border: "1px solid rgba(255,255,255,0.18)",
      borderRadius: "10px", padding: "10px 22px", color: "#fff",
      fontFamily: "'Segoe UI',sans-serif", textAlign: "center",
      boxShadow: "0 6px 24px rgba(0,0,0,0.6)",
    } as Partial<CSSStyleDeclaration>);
    document.body.appendChild(board);
    this.board = board;
  }

  /** ツアー開始: 先発→ベンチのショット列を組む。 */
  begin(): void {
    this.queue = [];
    for (let t = 0; t < 2; t++) {
      for (const p of this.game.allPlayers(t).slice(0, 5)) this.queue.push({ kind: "player", p });
      this.queue.push({ kind: "bench", team: t });
    }
    this.t = holdOf(this.queue[0]);
  }

  /** ツアー進行中か。 */
  active(): boolean {
    return this.queue.length > 0;
  }

  /** タップで次のショットへ進む。 */
  skip(): void {
    if (this.queue.length > 0) {
      this.queue.shift();
      if (this.queue.length > 0) this.t = holdOf(this.queue[0]);
    }
  }

  /** ツアー中の1フレーム: タイマー・字幕・カメラを更新。列が尽きたら放送へ戻す。 */
  step(dt: number): void {
    this.t -= dt;
    if (this.t <= 0) {
      this.queue.shift();
      if (this.queue.length > 0) this.t = holdOf(this.queue[0]);
    }
    const s = this.queue[0];
    this.updateBoard(s ?? null);
    if (s) {
      // 試合は止まっているので、メッシュをリセット状態へ同期する
      this.game.syncVisuals();
      const k = 1 - Math.max(0, this.t) / holdOf(s);
      if (s.kind === "player") this.camera.introShot(s.p, k, this.subjects());
      else this.camera.benchShot(this.game.allPlayers(s.team).slice(5), k);
    } else {
      this.camera.endIntro();
    }
  }

  /** 非ツアー時に呼ぶ（字幕を消しカメラを放送へ戻す。冪等）。 */
  clear(): void {
    this.updateBoard(null);
    this.camera.endIntro();
  }

  /** ツアー途中で試合前へ戻ったとき: 中止してカメラを解放。 */
  abort(): void {
    this.queue = [];
    this.updateBoard(null);
    this.camera.endIntro();
  }

  private subjects(): Player[] {
    return [...this.game.allPlayers(0), ...this.game.allPlayers(1)];
  }

  private teamHex(t: number): string {
    const c = TEAM_COLORS[t];
    return `rgb(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)})`;
  }

  private posBadge(role: string, t: number, size: string): HTMLSpanElement {
    const s = document.createElement("span");
    s.textContent = role;
    Object.assign(s.style, {
      background: this.teamHex(t), color: "#0d1016", fontWeight: "900",
      borderRadius: "6px", padding: "1px 8px", fontSize: size, flexShrink: "0",
    } as Partial<CSSStyleDeclaration>);
    return s;
  }

  private setNameTags(visible: boolean): void {
    for (let t = 0; t < 2; t++) for (const p of this.game.allPlayers(t)) p.setNameTagVisible(visible);
  }

  // s に対応する字幕（先発=ポジション+名前 / ベンチ=控え全員）を描く。null で消す。
  private updateBoard(s: IntroShot | null): void {
    if (s === this.shown) return;
    const wasIdle = this.shown === null;
    this.shown = s;
    if (!s) {
      this.board.style.display = "none";
      this.setNameTags(true);           // ツアー終了 — 3Dタグを戻す
      return;
    }
    if (wasIdle) this.setNameTags(false);   // ツアー開始 — ボードが名前を担う
    this.board.style.display = "block";
    this.board.replaceChildren();
    if (s.kind === "player") {
      const t = s.p.team;
      const teamLine = document.createElement("div");
      teamLine.textContent = TEAM_NAMES[t];
      Object.assign(teamLine.style, {
        fontSize: "11px", fontWeight: "800", letterSpacing: "2px",
        color: this.teamHex(t), marginBottom: "3px",
      } as Partial<CSSStyleDeclaration>);
      const line = document.createElement("div");
      Object.assign(line.style, {
        display: "flex", gap: "10px", alignItems: "center", justifyContent: "center",
        flexWrap: "nowrap",
      } as Partial<CSSStyleDeclaration>);
      const nm = document.createElement("span");
      nm.textContent = s.p.name;
      Object.assign(nm.style, {
        fontSize: "clamp(20px,5vw,28px)", fontWeight: "900",
        textShadow: "0 2px 6px rgba(0,0,0,0.7)",
        // 幅を固定（長い名前は … で切り詰め）
        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
        width: "min(64vw, 360px)", textAlign: "center",
      } as Partial<CSSStyleDeclaration>);
      line.append(this.posBadge(s.p.role, t, "clamp(14px,3vw,18px)"), nm);
      this.board.append(teamLine, line);
    } else {
      const t = s.team;
      const teamLine = document.createElement("div");
      teamLine.textContent = `${TEAM_NAMES[t]} ベンチ`;
      Object.assign(teamLine.style, {
        fontSize: "12px", fontWeight: "800", letterSpacing: "2px",
        color: this.teamHex(t), marginBottom: "6px",
      } as Partial<CSSStyleDeclaration>);
      const grid = document.createElement("div");
      Object.assign(grid.style, {
        display: "grid", gridTemplateColumns: "auto auto", columnGap: "26px", rowGap: "4px",
      } as Partial<CSSStyleDeclaration>);
      for (const p of this.game.allPlayers(t).slice(5)) {
        const row = document.createElement("div");
        Object.assign(row.style, {
          display: "flex", gap: "8px", alignItems: "center", textAlign: "left",
        } as Partial<CSSStyleDeclaration>);
        const nm = document.createElement("span");
        nm.textContent = p.name;
        Object.assign(nm.style, {
          fontSize: "clamp(13px,3vw,16px)", fontWeight: "700",
          // 幅を固定（あふれは … で切り詰め）
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
          width: "min(32vw, 150px)",
        } as Partial<CSSStyleDeclaration>);
        row.append(this.posBadge(p.role, t, "11px"), nm);
        grid.appendChild(row);
      }
      this.board.append(teamLine, grid);
    }
  }
}
