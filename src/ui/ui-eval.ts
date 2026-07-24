// UI: ロスター評価（ロール/選択順位/OVR/軸/身長の算出・自動割当）。
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

  // 抽選したスカッドから先発5人を最適化する: 各ポジション（PG..C）で最も適した
  // 選手が先発し、残りはベンチに落ちる。強い選手が自分のスポットで弱い選手の
  // 後ろに座ることがないようにする。ポジションは保たれる（PG スロットには依然
  // PG が入る）— 変わるのは各ポジション内の先発/ベンチの順序だけ。
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

  // 選手がそのポジションにどれだけ適合するか — 彼の6軸ダイジェストを、ポジション
  // の必要性とその身長プレミアムで重み付けしたもの（戦力バーが使うのと同じ重み）。
UI.prototype.posValue = function(def: PlayerDef, pos: string): number {
    const w = UI.ROLE_W[pos] ?? UI.ROLE_W.SF;
    const ax = this.axesOf(def);
    let s = 0;
    for (let k = 0; k < ax.length; k++) s += w.ax[k] * ax[k];
    return s + w.ht * UI.heightValue(def.height * 100);
};

  /** 1チームの攻守ロール + プライマリ順序を、その現在のロスターに対して再最適化
   *  する — 選手の入れ替え後に便利 — チームの構成員は変えずに。 */
UI.prototype.reassignRoles = function(team: number): void {
    this.autoAssignRoles(team);
    this.autoAssignChoiceRanks(team);
    this.refreshEditors();
};

  // 新規抽選から各選手にデフォルトの評価ロールを割り当てる: 彼のポジションが
  // 取れるロールの中で、彼のプロフィールに最も合うもの。5人のエースが決して
  // 起きないようチームバランスのペナルティを付け、ロールをスカッド全体に散らす。
  // 先発が先に割り当てられ（チームの形を決める）、次にベンチ。
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
          if (UI.DEF_ONLY.has(nm)) continue;   // 守備の仕事は今は DEF ロール側にある
          if (r.pos && !r.pos.includes(def.role)) continue;
          let s = r.ht * hs, tot = r.ht;
          for (let k = 0; k < ax.length; k++) { s += r.ax[k] * ax[k]; tot += r.ax[k]; }
          s /= tot;
          s -= (taken.get(nm) ?? 0) * 4;   // バランス: 重複ごとに 4 点のコスト
          if (s > bestS) { bestS = s; best = nm; }
        }
        def.evalRole = best || undefined;
        if (best) taken.set(best, (taken.get(best) ?? 0) + 1);
      }
      this.assignDefRoles(t);   // ユニット全体でバランスの取れた守備ロールのセットをドラフトする
    }
};

UI.prototype.axesOf = function(def: PlayerDef): number[] {
    return UI.HEX_AXES.map((x) => x.calc(def.attr));
};

  // オフェンスの選択順位（プライマリ 1..5）を得点力から自動割り当てし、デフォルト
  // ではボールが最良のスコアラーに集まるようにする。先発とベンチは別々に順位
  // 付けされる（それぞれ 1..5）ので、先発の「1」とベンチの「1」が共存できる —
  // それでよい（ユーザーが望まない限り2人の #1 が同時にコートに立つことはない;
  // エンジンは本当のタイを共有の co-primary として扱う）。
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

  // 新しく配置された1選手を、彼のユニット内で能力によって順位付けする（交代時に
  // 使うので、チームメイトの手動設定の順位はそのまま）。タイは許容。
UI.prototype.assignRankFor = function(def: PlayerDef, team: number, idx: number): void {
    const grp = idx < STARTERS ? ROSTER[team].slice(0, STARTERS) : ROSTER[team].slice(STARTERS);
    const mine = scoringPower(def.attr);
    let higher = 0;
    for (const d of grp) if (d !== def && scoringPower(d.attr) > mine) higher++;
    def.choiceRank = Math.min(higher + 1, 5);
};

  // 1選手にとって最良のオフェンスロールを、彼の能力軸から求める（チームバランス
  // なし — 単一の交代時に使う; チーム全体でバランスした版は autoAssignRoles）。
UI.prototype.bestOffRole = function(def: PlayerDef): string | undefined {
    const ax = this.axesOf(def);
    const hs = UI.heightValue(def.height * 100);
    let best = "", bestS = -Infinity;
    for (const [nm, r] of Object.entries(UI.EVAL_ROLES)) {
      if (UI.DEF_ONLY.has(nm)) continue;
      if (r.pos && !r.pos.includes(def.role)) continue;
      let s = r.ht * hs, tot = r.ht;
      for (let k = 0; k < ax.length; k++) { s += r.ax[k] * ax[k]; tot += r.ax[k]; }
      s /= tot;
      if (s > bestS) { bestS = s; best = nm; }
    }
    return best || undefined;
};

  // 選手の能力値からデフォルトの守備ロールを自動判定する: 強力なディフェンダーは
  // ロックダウン（本人がスコアラーでもあれば両面）、リムを守るビッグはアンカー、
  // 使用率の高いオフェンス専門家は温存（省エネ）、その他は皆バランス。
  // この選手のポジション・体格・守備の強みから、各守備ロールへの適合スコアを出す
  // — 高いほど適している。assignDefRoles はこれらからバランスの取れたラインナップ
  // をドラフトする; pickDefRole は単一選手の選択。
UI.prototype.defRoleFits = function(def: PlayerDef): Record<string, number> {
    const a = def.attr;
    const r = (x: number) => Math.max(0, Math.min(1, x / 100));
    const def_ = r(a.defense), rea = r(a.reaction), agi = r(a.agility);
    const jmp = r(a.jump), dnk = r(a.dunk), bal = r(a.balance);
    const mnt = r(a.mental), tmw = r(a.teamwork);
    const ht = Math.max(0, Math.min(1, (def.height - 1.85) / 0.3));   // 1.85m→0 .. 2.15m→1
    const off = Math.max(r(a.threeAcc), r(a.midAcc)) * 0.55 + r(a.aggression) * 0.45; // 得点負荷
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
      バランス:               0.50,                                            // 安定したベースラインのフォールバック
    };
};

  // 1選手にとって最も適合する守備ロール。任意で重複を散らす（彼のユニットで
  // 既に使われているロールにはペナルティ）。単一選手が配置されたときに使う。
UI.prototype.pickDefRole = function(def: PlayerDef, taken?: Map<string, number>): string {
    const fit = this.defRoleFits(def);
    let best = "バランス", bestV = -Infinity;
    for (const role of Object.keys(fit)) {
      const s = fit[role] - (taken ? (taken.get(role) ?? 0) * UI.DEF_ROLE_SPREAD : 0);
      if (s > bestV) { bestV = s; best = role; }
    }
    return best;
};

  // ユニット全体（先発5人、次にベンチ8人）に守備ロールをドラフトし、ライン
  // ナップがバランスの取れた守備になるようにする: 各ロールはそれに最も適合する
  // 選手に割り当てられ、確信度の高い割り当てから先に、重複を散らすペナルティ
  // つきで — こうしてラインナップには、リムプロテクター、オンボールのロック、
  // レーンの泥棒、フロアジェネラル、ヘルプ役などが、実際に各々に適した者に
  // 合わせて揃う。
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

  // 選手に実際に使われる重み: 彼の手動設定の評価ロール、または 自動 のままの
  // 場合は彼のポジションのプロフィール。
UI.prototype.effWeights = function(def: PlayerDef): { ax: number[]; ht: number } {
    return (def.evalRole && UI.EVAL_ROLES[def.evalRole])
      || UI.ROLE_W[def.role] || UI.ROLE_W.SF;
};

  // 一列に並ぶ5つのポジションチップ — この選手がカバーできる全ポジション
  // （自分自身を含む）が同じチームカラーのハイライトで点灯し、残りは暗くなる。
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
        color: on ? "#0d1016" : "rgba(255,255,255,0.28)",
        border: on ? `1px solid ${color}` : "1px solid rgba(255,255,255,0.1)",
      } as Partial<CSSStyleDeclaration>);
      c.textContent = r;
      row.appendChild(c);
    }
    return row;
};

  // 守れるポジション: ゲームの交代隣接関係（game.ts の roleFit）を、選手ごとに
  // ゲートする — 大きいスロットはそれ相応のサイズがあるときだけ、小さいスロット
  // はそれ相応の脚力があるときだけ。表示用のヒューリスティック; 最初の要素 = 自分自身。
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
    let pos = w.ht * htScore, tot = w.ht;
    for (let i = 0; i < ax.length; i++) { pos += w.ax[i] * ax[i]; tot += w.ax[i]; }
    pos /= tot;
    const raw = UI.PEAK_KEYS.map((k) => def.attr[k]).sort((a, b) => b - a);
    const v = pos * 0.5 + ((raw[0] + raw[1]) / 2) * 0.5;
    return Math.round(Math.max(40, Math.min(99, 74 + (v - 74) * 1.4)));
};

  // 軸ごとのチーム戦力: 単純平均ではない — 各選手は、彼のポジション（または手動
  // 設定の評価ロール）がその軸にどれだけ責任を持つかに比例して軸に寄与する:
  // PG のパスはチームのパスそのものだが、C はその針をほとんど動かさない。
  // 先発が 70%、ベンチのローテーションが 30% を担う。
UI.prototype.teamAxes = function(team: number): number[] {
    return this.teamAxesOf(ROSTER[team]);
};

  // 任意のロスター配列に対する同じ計算（交代のプレビューに使う）。
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

  // 直接対決ボード: 2チームの6軸を左右に並べたトルネード型。強い側の数字が
  // 点灯する。
  // ヘッダー用のチームの数値: 選手の OVR、先発 70% ベンチ 30%。
UI.prototype.teamOvr = function(team: number): number {
    return this.teamOvrOf(ROSTER[team]);
};

UI.prototype.teamOvrOf = function(r: PlayerDef[]): number {
    let st = 0, bn = 0;
    for (let j = 0; j < STARTERS; j++) st += this.ovrOf(r[j]);
    for (let j = STARTERS; j < ROSTER_SIZE; j++) bn += this.ovrOf(r[j]);
    return Math.round((st / STARTERS) * 0.7 + (bn / (ROSTER_SIZE - STARTERS)) * 0.3);
};

  // ...そしてそのサイズ: cm 単位の身長を、各人のポジション/ロールにとって身長が
  // どれだけ重要かで重み付け — C のリーチはチームのサイズだが、PG の身長は
  // ほとんど影響しない。
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
