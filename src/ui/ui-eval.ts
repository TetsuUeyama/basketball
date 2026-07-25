// UI: ロスター評価（ロール/選択順位/OVR/軸/身長の算出・自動割当）。
import { ROSTER, ROSTER_SIZE, STARTERS } from "../roster";
import type { PlayerDef } from "../attributes";
import { scoringPower } from "../roles";
import { rate, clamp } from "../util";
import { UI, INK } from "./ui";

declare module "./ui" {
  interface UI {
    optimizeLineup(team: number): void;
    posValue(def: PlayerDef, pos: string): number;
    reassignRoles(team: number): void;
    autoAssignRoles(only?: number): void;
    axesOf(def: PlayerDef): number[];
    autoAssignChoiceRanks(only?: number): void;
    rankGroup(defs: PlayerDef[]): void;
    assignRankFor(def: PlayerDef, team: number, idx: number): void;
    bestOffRole(def: PlayerDef): string | undefined;
    defRoleFits(def: PlayerDef): Record<string, number>;
    pickDefRole(def: PlayerDef, taken?: Map<string, number>): string;
    assignDefRoles(team: number): void;
    effWeights(def: PlayerDef): { ax: number[]; ht: number };
    positionChips(def: PlayerDef, color: string): HTMLDivElement;
    coverablePositions(def: PlayerDef): string[];
    ovrOf(def: PlayerDef): number;
    teamAxes(team: number): number[];
    teamAxesOf(r: PlayerDef[]): number[];
    teamOvr(team: number): number;
    teamOvrOf(r: PlayerDef[]): number;
    teamHeight(team: number): number;
    teamHeightOf(r: PlayerDef[]): number;
  }
}

// 6軸スコアと身長スコアの重み付き平均。
function weightedScore(ax: number[], w: { ax: number[]; ht: number }, htScore: number): number {
  let s = w.ht * htScore, tot = w.ht;
  for (let k = 0; k < ax.length; k++) { s += w.ax[k] * ax[k]; tot += w.ax[k]; }
  return s / tot;
}

  // 各ポジション（PG..C）で最も適した選手を先発にし、ポジション内の先発/ベンチ順序を最適化する。
UI.prototype.optimizeLineup = function(team: number): void {
    const byPos: Record<string, number[]> = {};
    ROSTER[team].forEach((d, i) => { (byPos[d.role] ??= []).push(i); });
    for (const pos of Object.keys(byPos)) {
      const slots = byPos[pos].slice().sort((a, b) => a - b);   // 先発スロット（最小インデックス）が先
      const defs = slots.map((i) => ROSTER[team][i])
        .sort((a, b) => this.posValue(b, pos) - this.posValue(a, pos)); // 最強が先
      slots.forEach((slot, k) => { ROSTER[team][slot] = defs[k]; });
    }
};

  // 選手のポジション適合度: 6軸をポジション重みと身長で重み付けした値。
UI.prototype.posValue = function(def: PlayerDef, pos: string): number {
    const w = UI.ROLE_W[pos] ?? UI.ROLE_W.SF;
    const ax = this.axesOf(def);
    let s = 0;
    for (let k = 0; k < ax.length; k++) s += w.ax[k] * ax[k];
    return s + w.ht * UI.heightValue(def.height * 100);
};

  /** 1チームの攻守ロール + プライマリ順序を現在のロスターに対して再最適化する。 */
UI.prototype.reassignRoles = function(team: number): void {
    this.autoAssignRoles(team);
    this.autoAssignChoiceRanks(team);
    this.refreshEditors();
};

  // 各選手にデフォルトの評価ロールを割り当てる: ポジションが取れるロールのうち
  // プロフィールに最も合うもの。重複にはバランスのペナルティを付ける。
UI.prototype.autoAssignRoles = function(only?: number): void {
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
          if (UI.DEF_ONLY.has(nm)) continue;   // 守備ロールは DEF 側で扱う
          if (r.pos && !r.pos.includes(def.role)) continue;
          let s = weightedScore(ax, r, hs);
          s -= (taken.get(nm) ?? 0) * 4;   // 重複ごとのバランスコスト
          if (s > bestS) { bestS = s; best = nm; }
        }
        def.evalRole = best || undefined;
        if (best) taken.set(best, (taken.get(best) ?? 0) + 1);
      }
      this.assignDefRoles(t);   // ユニットの守備ロールをドラフトする
    }
};

UI.prototype.axesOf = function(def: PlayerDef): number[] {
    return UI.HEX_AXES.map((x) => x.calc(def.attr));
};

  // オフェンス選択順位（プライマリ 1..5）を得点力から自動割り当てする。
  // 先発とベンチは別々に順位付けする（それぞれ 1..5）。
UI.prototype.autoAssignChoiceRanks = function(only?: number): void {
    for (let t = 0; t < 2; t++) {
      if (only !== undefined && t !== only) continue;
      this.rankGroup(ROSTER[t].slice(0, STARTERS));
      this.rankGroup(ROSTER[t].slice(STARTERS));
    }
};

UI.prototype.rankGroup = function(defs: PlayerDef[]): void {
    defs.map((d) => ({ d, s: scoringPower(d.attr) }))
      .sort((a, b) => b.s - a.s)
      .forEach((o, k) => { o.d.choiceRank = Math.min(k + 1, 5); });
};

  // 新しく配置された1選手を、ユニット内で能力によって順位付けする。タイは許容。
UI.prototype.assignRankFor = function(def: PlayerDef, team: number, idx: number): void {
    const grp = idx < STARTERS ? ROSTER[team].slice(0, STARTERS) : ROSTER[team].slice(STARTERS);
    const mine = scoringPower(def.attr);
    let higher = 0;
    for (const d of grp) if (d !== def && scoringPower(d.attr) > mine) higher++;
    def.choiceRank = Math.min(higher + 1, 5);
};

  // 1選手にとって最良のオフェンスロールを能力軸から求める（チームバランスなし）。
UI.prototype.bestOffRole = function(def: PlayerDef): string | undefined {
    const ax = this.axesOf(def);
    const hs = UI.heightValue(def.height * 100);
    let best = "", bestS = -Infinity;
    for (const [nm, r] of Object.entries(UI.EVAL_ROLES)) {
      if (UI.DEF_ONLY.has(nm)) continue;
      if (r.pos && !r.pos.includes(def.role)) continue;
      const s = weightedScore(ax, r, hs);
      if (s > bestS) { bestS = s; best = nm; }
    }
    return best || undefined;
};

  // 選手のポジション・体格・守備の強みから、各守備ロールへの適合スコアを返す（高いほど適合）。
UI.prototype.defRoleFits = function(def: PlayerDef): Record<string, number> {
    const a = def.attr;
    const def_ = rate(a.defense), rea = rate(a.reaction), agi = rate(a.agility);
    const jmp = rate(a.jump), dnk = rate(a.dunk), bal = rate(a.balance);
    const mnt = rate(a.mental), tmw = rate(a.teamwork);
    const ht = clamp((def.height - 1.85) / 0.3, 0, 1);   // 1.85m→0 .. 2.15m→1
    const off = Math.max(rate(a.threeAcc), rate(a.midAcc)) * 0.55 + rate(a.aggression) * 0.45; // 得点負荷
    const big = def.role === "PF" || def.role === "C";
    const guard = def.role === "PG" || def.role === "SG";
    const wing = def.role === "SF";
    const perim = guard || wing;
    return {
      リムプロテクター:       ht * 0.32 + jmp * 0.24 + dnk * 0.24 + def_ * 0.20 + (big ? 0.10 : -0.16),
      ロックダウン:           (def_ * 0.44 + agi * 0.32 + rea * 0.18 + bal * 0.06) * (1 - off * 0.20) + (perim ? 0.06 : -0.10),
      パスカット:             (rea * 0.40 + agi * 0.34 + def_ * 0.26) + (perim ? 0.05 : -0.08) - off * 0.10,
      スイッチディフェンダー:  agi * 0.26 + def_ * 0.26 + bal * 0.18 + ht * 0.22 + ((wing || def.role === "PF") ? 0.11 : -0.05),
      ヘルプディフェンダー:    def_ * 0.32 + mnt * 0.28 + rea * 0.18 + bal * 0.16,
      守備司令塔:             mnt * 0.40 + tmw * 0.36 + def_ * 0.24 + (guard ? 0.06 : -0.08),
      ハッスルディフェンダー:  (def_ + agi + rea) / 3 * 0.48 + off * 0.28 + bal * 0.20,
      省エネ:                 (off - 0.5) * 1.2 + (0.5 - def_) * 0.9 + 0.28,   // 守備ができないスコアラー
      バランス:               0.50,                                            // フォールバック
    };
};

  // 1選手にとって最も適合する守備ロール。任意で重複ロールにペナルティを付けて散らす。
UI.prototype.pickDefRole = function(def: PlayerDef, taken?: Map<string, number>): string {
    const fit = this.defRoleFits(def);
    let best = "バランス", bestV = -Infinity;
    for (const role of Object.keys(fit)) {
      const s = fit[role] - (taken ? (taken.get(role) ?? 0) * UI.DEF_ROLE_SPREAD : 0);
      if (s > bestV) { bestV = s; best = role; }
    }
    return best;
};

  // ユニット全体（先発5人、次にベンチ8人）に守備ロールをドラフトする: 各ロールを
  // 最も適合する選手に、確信度の高い割り当てから先に、重複ペナルティつきで割り当てる。
UI.prototype.assignDefRoles = function(team: number): void {
    for (const unit of [ROSTER[team].slice(0, STARTERS), ROSTER[team].slice(STARTERS)]) {
      const taken = new Map<string, number>();
      const rem = unit.map((_, i) => i);
      const fitsOf = unit.map((d) => this.defRoleFits(d));
      while (rem.length) {
        let bi = rem[0], brole = "バランス", bv = -Infinity;
        for (const pi of rem) {
          for (const role of Object.keys(fitsOf[pi])) {
            const s = fitsOf[pi][role] - (taken.get(role) ?? 0) * UI.DEF_ROLE_SPREAD;
            if (s > bv) { bv = s; bi = pi; brole = role; }
          }
        }
        unit[bi].defRole = brole;
        taken.set(brole, (taken.get(brole) ?? 0) + 1);
        rem.splice(rem.indexOf(bi), 1);
      }
    }
};

  // 選手に使われる重み: 手動設定の評価ロール、または自動時はポジションのプロフィール。
UI.prototype.effWeights = function(def: PlayerDef): { ax: number[]; ht: number } {
    return (def.evalRole && UI.EVAL_ROLES[def.evalRole])
      || UI.ROLE_W[def.role] || UI.ROLE_W.SF;
};

  // 一列の5つのポジションチップ: カバーできるポジション（自分含む）が点灯し、残りは暗くなる。
UI.prototype.positionChips = function(def: PlayerDef, color: string): HTMLDivElement {
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
        color: on ? INK : "rgba(255,255,255,0.28)",
        border: on ? `1px solid ${color}` : "1px solid rgba(255,255,255,0.1)",
      } as Partial<CSSStyleDeclaration>);
      c.textContent = r;
      row.appendChild(c);
    }
    return row;
};

  // 守れるポジション: 隣接ポジションを身長/脚力でゲートする。最初の要素 = 自分自身。
UI.prototype.coverablePositions = function(def: PlayerDef): string[] {
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
};

UI.prototype.ovrOf = function(def: PlayerDef): number {
    const ax = this.axesOf(def);
    const w = this.effWeights(def);   // ポジションのプロフィール、または手動設定の評価ロール
    const htScore = UI.heightValue(def.height * 100);
    const pos = weightedScore(ax, w, htScore);
    const raw = UI.PEAK_KEYS.map((k) => def.attr[k]).sort((a, b) => b - a);
    const v = pos * 0.5 + ((raw[0] + raw[1]) / 2) * 0.5;
    return Math.round(Math.max(40, Math.min(99, 74 + (v - 74) * 1.4)));
};

  // 軸ごとのチーム戦力: 各選手はポジション（または評価ロール）の軸責任に比例して寄与する。
  // 先発 70%、ベンチ 30%。
UI.prototype.teamAxes = function(team: number): number[] {
    return this.teamAxesOf(ROSTER[team]);
};

  // 任意のロスター配列に対する同じ計算。
UI.prototype.teamAxesOf = function(r: PlayerDef[]): number[] {
    return UI.HEX_AXES.map((x, i) => {
      const grp = (from: number, to: number): number => {
        let v = 0, w = 0;
        for (let j = from; j < to; j++) {
          const wt = this.effWeights(r[j]).ax[i] + 0.02; // わずかな下限: 誰もが少しは寄与する
          v += x.calc(r[j].attr) * wt;
          w += wt;
        }
        return v / w;
      };
      return grp(0, STARTERS) * 0.7 + grp(STARTERS, ROSTER_SIZE) * 0.3;
    });
};

  // チームの OVR 数値: 選手の OVR を先発 70% ベンチ 30% で合成。
UI.prototype.teamOvr = function(team: number): number {
    return this.teamOvrOf(ROSTER[team]);
};

UI.prototype.teamOvrOf = function(r: PlayerDef[]): number {
    let st = 0, bn = 0;
    for (let j = 0; j < STARTERS; j++) st += this.ovrOf(r[j]);
    for (let j = STARTERS; j < ROSTER_SIZE; j++) bn += this.ovrOf(r[j]);
    return Math.round((st / STARTERS) * 0.7 + (bn / (ROSTER_SIZE - STARTERS)) * 0.3);
};

  // チームのサイズ: cm 単位の身長を、ポジション/ロールの身長重要度で重み付けする。
UI.prototype.teamHeight = function(team: number): number {
    return this.teamHeightOf(ROSTER[team]);
};

UI.prototype.teamHeightOf = function(r: PlayerDef[]): number {
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
};
