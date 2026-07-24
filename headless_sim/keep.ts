import "./stubs";
import { NullEngine, Scene } from "@babylonjs/core";
import { Game } from "../src/game";
import { Player } from "../src/player";
import { buildCourt } from "../src/court";
import { clubTeam } from "../src/attributes";
import { CLUBS } from "../src/clubdb";

Player.HEADLESS = true;
if (process.env.NOKEEP === "1") (globalThis as { __NOKEEP?: boolean }).__NOKEEP = true;
const engine = new NullEngine();
const scene = new Scene(engine);
const hoops = buildCourt(scene);
const game = new Game(scene) as unknown as {
  applyRoster(): void; reset(): void; update(dt: number): void; attachHoops(h: unknown): void;
  state: string; score: number[];
};
game.attachHoops(hoops);

const DT = 0.1;
const N = Number(process.env.N ?? 40);
// a spread of clubs so we sample many handle levels
const PAIRS: [number, number][] = [];
for (let i = 0; i < 30; i++) PAIRS.push([(i * 7) % 150, (i * 13 + 3) % 150]);

let games = 0, totalPts = 0, minPts = 1e9, maxPts = 0;
for (let k = 0; k < N; k++) {
  const [a, b] = PAIRS[k % PAIRS.length];
  if (a === b) continue;
  clubTeam(0, a); clubTeam(1, b);
  game.applyRoster(); game.reset();
  let steps = 0;
  while (game.state !== "final" && steps++ < 200000) game.update(DT);
  const pts = game.score[0] + game.score[1];
  totalPts += pts; games++;
  minPts = Math.min(minPts, pts); maxPts = Math.max(maxPts, pts);
}
console.log(`keep=${process.env.NOKEEP === "1" ? "OFF" : "ON"}  games=${games}  avg combined pts/game=${(totalPts / games).toFixed(1)}  (min ${minPts}, max ${maxPts})`);
