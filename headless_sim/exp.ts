import "./stubs";
import { NullEngine, Scene } from "@babylonjs/core";
import { Game } from "../src/game";
import { Player } from "../src/entities";
import { buildCourt } from "../src/court";
import { clubTeam, ROSTER } from "../src/attributes";
import { CLUBS } from "../src/clubdb";

Player.HEADLESS = true;
const engine = new NullEngine();
const scene = new Scene(engine);
const hoops = buildCourt(scene);
const game = new Game(scene) as unknown as {
  applyRoster(): void; reset(): void; update(dt: number): void; attachHoops(h: unknown): void;
  state: string; score: number[]; roster: { stats: Record<string, number> }[][];
};
game.attachHoops(hoops);

const DT = 0.1;
const N = Number(process.env.N ?? 400);
const A = 20, B = 60;   // team A attacks a FIXED offence; team B's DEFENCE we vary

// keys to override on team B; "def" = defence attribute only, "all" = the athletic
// defensive package (defence + reaction + agility + balance)
const MODE = process.env.MODE ?? "def";
const KEYS = MODE === "all" ? ["defense", "reaction", "agility", "balance"] : ["defense"];

function run(val: number): { paA: number; fgA: number; pfB: number } {
  let ptsA = 0, fgmA = 0, fgaA = 0, ptsB = 0;
  for (let k = 0; k < N; k++) {
    clubTeam(0, A); clubTeam(1, B);
    for (const d of ROSTER[1]) for (const key of KEYS) (d.attr as unknown as Record<string, number>)[key] = val;
    game.applyRoster(); game.reset();
    let s = 0;
    while (game.state !== "final" && s++ < 200000) game.update(DT);
    ptsA += game.score[0]; ptsB += game.score[1];
    for (const p of game.roster[0]) { fgmA += p.stats.fgm; fgaA += p.stats.fga; }
  }
  return { paA: ptsA / N, fgA: fgaA ? 100 * fgmA / fgaA : 0, pfB: ptsB / N };
}

console.log(`Offence ${CLUBS[A][0]} vs a FIXED-DEFENCE ${CLUBS[B][0]} — vary B's ${MODE} (N=${N}/level, DT=${DT})`);
const rows: { v: number; paA: number; fgA: number }[] = [];
for (const v of [20, 40, 60, 80, 99]) {
  const r = run(v);
  rows.push({ v, paA: r.paA, fgA: r.fgA });
  console.log(`  ${MODE}=${String(v).padStart(2)} → offence scores ${r.paA.toFixed(1)}/g, FG ${r.fgA.toFixed(1)}%  (B scores ${r.pfB.toFixed(1)})`);
}
const lo = rows[0], hi = rows[rows.length - 1];
console.log(`\nSwing ${MODE} 20→99: opponent scoring ${lo.paA.toFixed(1)} → ${hi.paA.toFixed(1)} /g `
  + `(Δ ${(hi.paA - lo.paA).toFixed(1)}, ${(100 * (hi.paA - lo.paA) / lo.paA).toFixed(0)}%),  FG ${lo.fgA.toFixed(1)}% → ${hi.fgA.toFixed(1)}%`);
