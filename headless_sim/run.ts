import "./stubs";
import { writeFileSync } from "node:fs";
import { NullEngine, Scene } from "@babylonjs/core";
import { Game } from "../src/game";
import { Player } from "../src/entities";
import { buildCourt } from "../src/court";

Player.HEADLESS = true;   // skip per-swap hair/name-tag rebuilds (no rendering → no leak)
import { clubTeam } from "../src/attributes";
import { CLUBS } from "../src/clubdb";

const engine = new NullEngine();
const scene = new Scene(engine);
const hoops = buildCourt(scene);
type Stats = Record<string, number>;
const game = new Game(scene) as unknown as {
  applyRoster(): void; reset(): void; update(dt: number): void; attachHoops(h: unknown): void;
  state: string; score: number[]; roster: { name: string; role: string; stats: Stats }[][];
};
game.attachHoops(hoops);

const DT = Number(process.env.DT ?? 0.1);

// ---- accumulators ----
type Team = { name: string; g: number; w: number; l: number; d: number; pf: number; pa: number };
type Play = { name: string; club: string; role: string; g: number } & Stats;
const teams: Team[] = CLUBS.map((c) => ({ name: c[0], g: 0, w: 0, l: 0, d: 0, pf: 0, pa: 0 }));
const players = new Map<string, Play>();
const STAT_KEYS = ["pts", "reb", "ast", "stl", "blk", "tov", "fgm", "fga", "tpm", "tpa", "ftm", "fta", "min"];

function accumPlayer(clubName: string, roster: { name: string; role: string; stats: Stats }[]): void {
  for (const p of roster) {
    if ((p.stats.min ?? 0) <= 0) continue;                 // didn't play this game
    const key = `${clubName}|${p.name}`;
    let acc = players.get(key);
    if (!acc) { acc = { name: p.name, club: clubName, role: p.role, g: 0 }; for (const k of STAT_KEYS) acc[k] = 0; players.set(key, acc); }
    acc.g++;
    for (const k of STAT_KEYS) acc[k] += p.stats[k] ?? 0;
  }
}

const LIMIT = Number(process.env.LIMIT ?? 0);   // >0 = cap games (for a quick memory/speed test)
const total = LIMIT || CLUBS.length * (CLUBS.length - 1);
const t0 = Date.now();
let done = 0;
outer:
for (let a = 0; a < CLUBS.length; a++) {
  for (let b = 0; b < CLUBS.length; b++) {
    if (a === b) continue;
    if (LIMIT && done >= LIMIT) break outer;
    clubTeam(0, a); clubTeam(1, b);
    game.applyRoster(); game.reset();
    let steps = 0;
    while (game.state !== "final" && steps++ < 200000) game.update(DT);
    const [sa, sb] = [game.score[0], game.score[1]];
    const TA = teams[a], TB = teams[b];
    TA.g++; TB.g++; TA.pf += sa; TA.pa += sb; TB.pf += sb; TB.pa += sa;
    if (sa > sb) { TA.w++; TB.l++; } else if (sb > sa) { TB.w++; TA.l++; } else { TA.d++; TB.d++; }
    accumPlayer(CLUBS[a][0], game.roster[0]);
    accumPlayer(CLUBS[b][0], game.roster[1]);
    if (++done % 2000 === 0) {
      const el = (Date.now() - t0) / 1000;
      console.log(`${done}/${total}  ${el.toFixed(0)}s  eta ${((el / done) * (total - done)).toFixed(0)}s`);
    }
  }
}
const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
console.log(`ALL DONE ${done} games in ${elapsed}s`);

// ---- rankings ----
teams.sort((x, y) => (y.w - x.w) || ((y.pf - y.pa) - (x.pf - x.pa)));
const standings = teams.map((t, i) =>
  `${String(i + 1).padStart(3)}. ${t.name.padEnd(18)} ${t.w}-${t.l}${t.d ? "-" + t.d : ""}  diff ${(t.pf - t.pa >= 0 ? "+" : "") + (t.pf - t.pa)}  (PF ${t.pf} / PA ${t.pa}, ${t.g}g)`
).join("\n");

const all = [...players.values()];
const MING = 150;   // qualify: at least this many games played
const qualified = all.filter((p) => p.g >= MING);
const avg = (p: Play, k: string) => p[k] / p.g;
const leaderboard = (label: string, k: string, per: boolean) => {
  const rows = [...(per ? qualified : all)].sort((x, y) => (per ? avg(y, k) - avg(x, k) : (y[k] as number) - (x[k] as number))).slice(0, 30);
  return `== ${label} ==\n` + rows.map((p, i) =>
    `${String(i + 1).padStart(2)}. ${p.name.padEnd(16)} ${p.club.padEnd(16)} ${(per ? avg(p, k).toFixed(1) : p[k]).toString().padStart(6)}${per ? "/g" : ""}  (${p.g}g)`
  ).join("\n");
};

const out = [
  `# 総当り(H&A) 全${CLUBS.length}クラブ / ${done}試合 / DT=${DT} / ${elapsed}s`,
  ``,
  `## チーム順位 (勝-敗[-分], 得失点差)`,
  standings,
  ``,
  `## 個人スタッツ・リーダー (per game は ${MING}試合以上)`,
  leaderboard("得点/試合 (PPG)", "pts", true),
  leaderboard("リバウンド/試合 (RPG)", "reb", true),
  leaderboard("アシスト/試合 (APG)", "ast", true),
  leaderboard("スティール/試合 (SPG)", "stl", true),
  leaderboard("ブロック/試合 (BPG)", "blk", true),
  leaderboard("通算得点 (total PTS)", "pts", false),
].join("\n");

writeFileSync("headless_sim/results.txt", out, "utf8");
writeFileSync("headless_sim/results.json", JSON.stringify({ teams, players: all }, null, 0), "utf8");
console.log("\n" + standings.split("\n").slice(0, 12).join("\n"));
console.log("\nwrote headless_sim/results.txt and results.json");
