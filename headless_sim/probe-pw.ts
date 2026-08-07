import "./stubs";
import { NullEngine, Scene } from "@babylonjs/core";
import { Game } from "../src/game";
import { Player } from "../src/objects/player/player";
import { buildCourt } from "../src/objects/court";
Player.HEADLESS = true;
import { clubTeam } from "../src/roster";
const engine = new NullEngine(); const scene = new Scene(engine);
const game = new Game(scene);
(game as unknown as { attachHoops(h: unknown): void }).attachHoops(buildCourt(scene));
const g = game as unknown as { applyRoster(): void; reset(): void; update(dt: number): void; state: string };
let power = 0, stalled = 0, games = 0;
const wasP = new Map<Player, boolean>(), wasS = new Map<Player, boolean>();
for (let n = 0; n < 6; n++) {
  clubTeam(0, n % 20); clubTeam(1, (n + 3) % 20); g.applyRoster(); g.reset(); games++;
  let s = 0;
  while (g.state !== "final" && s++ < 200000) {
    g.update(1 / 30);
    for (const p of game.players) {
      const np = p.powerT > 0, ns = p.stalledT > 0;
      if (np && !wasP.get(p)) power++;
      if (ns && !wasS.get(p)) stalled++;
      wasP.set(p, np); wasS.set(p, ns);
    }
  }
}
console.log(`${games}試合: 押し込み開始 ${power}回 (${(power / games).toFixed(1)}/試合) / 壁で止まった ${stalled}回`);
