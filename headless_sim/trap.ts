import "./stubs";
import { NullEngine, Scene } from "@babylonjs/core";
import { Game } from "../src/game";
import { Player } from "../src/entities";
import { buildCourt } from "../src/court";
import { clubTeam } from "../src/attributes";

Player.HEADLESS = true;
if (process.env.NORELIEF === "1") (globalThis as { __NORELIEF?: boolean }).__NORELIEF = true;
const engine = new NullEngine();
const scene = new Scene(engine);
const hoops = buildCourt(scene);
const game = new Game(scene) as unknown as {
  applyRoster(): void; reset(): void; update(dt: number): void; attachHoops(h: unknown): void;
  state: string; handler: Player | null; roster: Player[][];
};
game.attachHoops(hoops);

const DT = 0.05;
const N = Number(process.env.N ?? 60);

const R = Number(process.env.R ?? 1.7);   // genuine tight trap radius (matches tightlyTrapped)
function trapped(p: Player, roster: Player[][]): boolean {
  const opp = roster[1 - p.team];
  let n = 0;
  for (const d of opp) {
    const dx = d.pos.x - p.pos.x, dz = d.pos.z - p.pos.z;
    if (dx * dx + dz * dz < R * R) { if (++n >= 2) return true; }
  }
  return false;
}

// The user's exact complaint: a player is trapped WHILE HOLDING the ball, escapes
// by passing out, then gets the ball back and is trapped AGAIN within a few
// seconds — "脱出したはずが戻されてまた身動きが取れない". Measure that loop.
let trapHolds = 0;        // distinct spells of "handler is trapped while holding"
let escapes = 0;          // trapped handler gave the ball up (passed out)
let reTrapLoops = 0;      // ...and the SAME man was re-trapped as handler within 3.0 s
let totalScore = 0;

for (let k = 0; k < 60 && k < N; k++) {
  clubTeam(0, 10); clubTeam(1, 40);
  game.applyRoster(); game.reset();
  let steps = 0, t = 0;
  let curH: Player | null = null;
  let curHTrapped = false;                       // is the current holder in a trap right now?
  const escapedAt = new Map<Player, number>();   // player -> time he escaped a trap by passing
  while (game.state !== "final" && steps++ < 200000) {
    game.update(DT); t += DT;
    const h = game.handler;
    if (h) {
      const tr = trapped(h, game.roster);
      if (h !== curH) {
        // possession of the ball changed hands (pass/steal/rebound secured)
        // did the PREVIOUS holder escape a trap by giving it up?
        if (curH && curHTrapped && h.team === curH.team) {
          escapes++;
          escapedAt.set(curH, t);
        }
        curH = h; curHTrapped = false;
        // is THIS new holder a man who escaped a trap moments ago, now trapped again?
        const esc = escapedAt.get(h);
        if (tr && esc !== undefined && t - esc <= 3.0) { reTrapLoops++; escapedAt.delete(h); }
      }
      if (tr && !curHTrapped) { trapHolds++; curHTrapped = true; }
      if (!tr) curHTrapped = false;
    }
  }
  totalScore += game.roster ? 0 : 0;
}

const G = Math.min(N, 60);
console.log(`relief=${process.env.NORELIEF === "1" ? "OFF" : "ON"}  games=${G}`);
console.log(`trapped-while-holding spells: ${trapHolds}  (${(trapHolds / G).toFixed(1)}/g)`);
console.log(`escapes (trapped holder passed out): ${escapes}`);
console.log(`RE-TRAP LOOPS (same man re-trapped ≤3s after escaping): ${reTrapLoops}  (${(reTrapLoops / G).toFixed(2)}/g, ${escapes ? (100 * reTrapLoops / escapes).toFixed(1) : "0"}% of escapes)`);
void totalScore;
