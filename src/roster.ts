// ロスターの状態と生成。DBエントリ→PlayerDef 変換（makeDefFromDb / applyDbPlayer）、
// ランダム編成（randomizeTeam / randomizeRosters）、実在クラブ編成（clubTeam）、
// 初期ダミーの ROSTER（テスト用 MIN/MAX チーム）を集約。
import { clamp } from "./util";
import { ATTR_META, ABILITY_META, type Attributes, type PlayerDef } from "./attributes";
import { PLAYER_DB, type DbPlayer } from "./data/player-data";
import { CLUBS } from "./data/club/clubdb";
import { resolveLook, playerLook } from "./objects/player/player-look";
// ロスターテーブルを読みやすく保つための短縮関数 — 引数は ATTR_META の順に従う。
const A = (
  offense: number, defense: number, balance: number, stamina: number,
  speed: number, accel: number, reaction: number, agility: number,
  dribbleAcc: number, dribbleSpd: number, passAcc: number, passSpd: number,
  threeAcc: number, threeRange: number, midAcc: number, shotStrength: number,
  shotTech: number, freeThrow: number, bank: number, dunk: number,
  jump: number, handling: number, aggression: number, mental: number, teamwork: number,
): Attributes => ({
  offense, defense, balance, stamina, speed, accel, reaction, agility,
  dribbleAcc, dribbleSpd, passAcc, passSpd, threeAcc, threeRange, midAcc,
  shotStrength, shotTech, freeThrow, bank, dunk, jump, handling, aggression,
  mental, teamwork,
});

const MIN = A(10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10);
const MAX = A(99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99);

// ---------------------------------------------------------------------------
// インポートした選手データベースからのランダムなマッチアップ: 毎試合チームごとに新しい
// 13人ロスターを引く(同じ試合に同じ選手は出ない)。
// ---------------------------------------------------------------------------
// データベースのエントリから、新しい独立した PlayerDef を構築する。試合前の選手ピッカーが
// ロスタースロットに触れずに任意の選手をプレビューするのに使う。
export function makeDefFromDb(p: DbPlayer): PlayerDef {
  const [name, role, hcm, ratings, mask, extras, hand, look] = p;
  const attr = {} as Attributes;
  ATTR_META.forEach((m, k) => { attr[m.key] = clamp(ratings[k] ?? 50, 0, 100); });
  return {
    name, role, height: hcm / 100, attr,
    abilities: ABILITY_META.filter((_, b) => mask & (1 << b)).map((m) => m.key),
    hand: hand === "L" ? "L" : "R",
    future: { stability: extras[0] ?? 0, offhandAcc: extras[1] ?? 0, offhandFreq: extras[2] ?? 0 },
    look: look ? resolveLook(look) : playerLook(name),   // DBのlook番号→見た目（無ければ名前フォールバック）
  };
}

// データベースのエントリを既存のロスタースロットへ、その場でコピーする。フィールド
// ごとの attr 代入は意図的: Player.attr は def.attr へのライブ参照を保持するので、
// オブジェクトを差し替えるのではなくフィールドを書き換えるとコート上のエンティティも更新される。
export function applyDbPlayer(def: PlayerDef, p: DbPlayer): void {
  const src = makeDefFromDb(p);
  def.name = src.name;
  def.role = src.role;
  def.height = src.height;
  def.priority = undefined;
  ATTR_META.forEach((m) => { def.attr[m.key] = src.attr[m.key]; });
  def.abilities = src.abilities;
  def.hand = src.hand;
  def.future = src.future;
  def.look = src.look;   // 見た目もDB選手のものへ更新（交代/入替でコート上の頭・HUDが追随）
}

// データベースから1チーム分の新しい13人ロスターを引く。相手チームにすでにいる選手を
// 避けることで、2つのラインナップが選手を共有することはない。
export function randomizeTeam(team: number): void {
  const pools: Record<string, DbPlayer[]> = { PG: [], SG: [], SF: [], PF: [], C: [] };
  for (const p of PLAYER_DB) pools[p[1]]?.push(p);
  const used = new Set<DbPlayer>();
  // 相手チームの現在の選手(名前で照合)を予約しておき、このチームへ重複させないようにする
  const otherNames = new Set(ROSTER[1 - team].map((p) => p.name));
  for (const p of PLAYER_DB) if (otherNames.has(p[0])) used.add(p);
  const draw = (role: string): DbPlayer => {
    const pool = pools[role] ?? PLAYER_DB;
    for (let tries = 0; tries < 60; tries++) {
      const cand = pool[Math.floor(Math.random() * pool.length)];
      if (!used.has(cand)) { used.add(cand); return cand; }
    }
    const fallback = pool.find((c) => !used.has(c)) ?? pool[0];
    used.add(fallback);
    return fallback;
  };
  const roles = ["PG", "SG", "SF", "PF", "C", ...BENCH_ROLES];
  for (let i = 0; i < ROSTER_SIZE; i++) {
    applyDbPlayer(ROSTER[team][i], draw(roles[i]));
    ROSTER[team][i].role = roles[i];   // スロットのポジションに固定(フォールバック抽選だと異なり得る)
  }
}

export function randomizeRosters(): void {
  randomizeTeam(0);
  randomizeTeam(1);   // team 1 は team 0 の新規抽選を避ける → 共有選手なし
}

// ---- クラブ再現 ------------------------------------------------------------
// 実在クラブのスカッド(clubdb)から1チーム分の13人ロスターを構築する。各スロットには、
// 変換後のロールが一致する残りのスカッドメンバーの中で最良の者を入れる。欠けるロールは
// 最も近いバスケのポジション(PF↔C, SG↔SF …)へフォールバックする。
const ROLE_FALLBACK: Record<string, string[]> = {
  PG: ["SG", "SF", "PF", "C"],
  SG: ["SF", "PG", "PF", "C"],
  SF: ["SG", "PF", "PG", "C"],
  PF: ["C", "SF", "SG", "PG"],
  C:  ["PF", "SF", "SG", "PG"],
};
// 各バスケスロットが重視するもの(25能力値配列へのインデックス、ATTR_META順)。
// スロット値は半分が総合、半分がそのスロットの主要能力値。
const ROLE_KEY_ATTRS: Record<string, number[]> = {
  PG: [10, 11, 0, 21, 7],        // P精度 P速度 オフェンス 技術 敏捷性
  SG: [14, 12, 0, 4, 7, 21],     // S精度 L精度 オフェンス 速度 敏捷性 技術
  SF: [14, 0, 20, 2, 21],        // S精度 オフェンス ジャンプ バランス 技術
  PF: [1, 2, 20, 19, 15],        // ディフェンス バランス ジャンプ ヘッド S威力
  C:  [1, 2, 20, 19, 15],
};
const slotValue = (p: DbPlayer, role: string): number => {
  const r = p[3];
  const avg = r.reduce((a, b) => a + b, 0) / r.length;
  const keys = ROLE_KEY_ATTRS[role] ?? [];
  const key = keys.length ? keys.reduce((a, k) => a + (r[k] ?? 50), 0) / keys.length : avg;
  return avg * 0.5 + key * 0.5;
};

export function clubTeam(team: number, clubIdx: number): void {
  const club = CLUBS[clubIdx];
  if (!club) return;
  const squad = club[2].map((i) => PLAYER_DB[i]).filter(Boolean);
  const used = new Set<DbPlayer>();
  const pick = (role: string): DbPlayer => {
    for (const r of [role, ...ROLE_FALLBACK[role]]) {
      const cands = squad.filter((p) => !used.has(p) && p[1] === r);
      if (cands.length) {
        const best = cands.reduce((a, b) => (slotValue(b, role) > slotValue(a, role) ? b : a));
        used.add(best);
        return best;
      }
    }
    const rest = squad.filter((p) => !used.has(p));
    const best = rest.reduce((a, b) => (slotValue(b, role) > slotValue(a, role) ? b : a));
    used.add(best);
    return best;
  };
  const roles = ["PG", "SG", "SF", "PF", "C", ...BENCH_ROLES];
  for (let i = 0; i < ROSTER_SIZE; i++) {
    applyDbPlayer(ROSTER[team][i], pick(roles[i]));
    ROSTER[team][i].role = roles[i];   // その選手はスロットのポジションでプレーする
  }
}

// [team][idx] でインデックスするNBA式の13人ロスター: idx 0..4 = 先発
// (PG, SG, SF, PF, C)、idx 5..12 = 8人のベンチ(完全なセカンドユニット
// PG/SG/SF/PF/C に加えて3人目のガード、ウイング、ビッグ)。
// NOTE: テスト設定 — RED (BLAZE) は全能力値が下限、BLUE (WAVE) が上限なので、
// 能力値の効果が明白になる。実際のゲーム向けには再調整すること。
export const STARTERS = 5;
export const ROSTER_SIZE = 13;

// 記載ポジション以外でも起用可能な選手。キー = 名前(playerdb と完全一致が必要)。
// 値 = 自分のロールに加えて起用できる追加ポジション。それ以外は自分のロールでのみプレー可。
export const EXTRA_POSITIONS: Record<string, string[]> = {
  "クリスティアーノ・ロナウド": ["SG"],   // SF に加えて SG も可
};
const BENCH_ROLES = ["PG", "SG", "SF", "PF", "C", "SG", "SF", "PF"];

const mk = (name: string, role: string, height: number, attr: Attributes): PlayerDef =>
  ({ name, role, height, attr });

export const ROSTER: PlayerDef[][] = [
  [ // Team 0 — BLAZE (RED) — すべて最小値
    mk("Vega",  "PG", 1.85, { ...MIN }),
    mk("Knox",  "SG", 1.85, { ...MIN }),
    mk("Reed",  "SF", 1.85, { ...MIN }),
    mk("Boone", "PF", 1.85, { ...MIN }),
    mk("Sato",  "C",  1.85, { ...MIN }),
    ...["Cole", "Duke", "Finn", "Gray", "Hale", "Iker", "Judd", "Kane"]
      .map((n, i) => mk(n, BENCH_ROLES[i], 1.85, { ...MIN })),
  ],
  [ // Team 1 — WAVE (BLUE) — すべて最大値
    mk("Ito",    "PG", 2.10, { ...MAX }),
    mk("Lang",   "SG", 2.10, { ...MAX }),
    mk("Cruz",   "SF", 2.10, { ...MAX }),
    mk("Diaz",   "PF", 2.10, { ...MAX }),
    mk("Okafor", "C",  2.10, { ...MAX }),
    ...["Pena", "Quon", "Ross", "Silva", "Tate", "Umar", "Vidal", "Webb"]
      .map((n, i) => mk(n, BENCH_ROLES[i], 2.10, { ...MAX })),
  ],
];
