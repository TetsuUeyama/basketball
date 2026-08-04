import "./stubs";
import { NullEngine, Scene } from "@babylonjs/core";
import { Game } from "../src/game";
import { Player } from "../src/objects/player/player";
import { buildCourt } from "../src/objects/court";
import { clubTeam } from "../src/roster";
import { outOfCourt } from "../src/move/action/save";
import { COURT } from "../src/config";
Player.HEADLESS = true;
const engine = new NullEngine();
const scene = new Scene(engine);
const hoops = buildCourt(scene);
const game = new Game(scene);
game.attachHoops(hoops);
let throwaway = 0, chased = 0, dove = 0, saved = 0, savedPass = 0, tov = 0, stuck = 0;
const overs: number[] = [], depths: number[] = [];
const DT = 1 / 30;
const N = Number(process.env.N ?? 40);
for (let k = 0; k < N; k++) {
  clubTeam(0, (k * 7) % 150); clubTeam(1, (k * 13 + 3) % 150);
  game.applyRoster(); game.reset();
  let steps = 0, watching = false, sawAir = false;
  while (game.state !== "final" && steps++ < 400000) {
    const wasPass = game.ballMode === "pass";
    const catchOOB = wasPass && outOfCourt(game.passCatch.x, game.passCatch.z);
    if (catchOOB && !watching) {
      throwaway++; watching = true; sawAir = false;
      overs.push(Math.max(Math.abs(game.passCatch.x) - COURT.halfW, Math.abs(game.passCatch.z) - COURT.halfL));
      if (game.saveBy === game.passTo) chased++;
    }
    if (catchOOB && game.saveBy && game.saveBy === game.passTo && game.saveBy.airborne) sawAir = true;
    if (!wasPass) watching = false;
    const passerBefore = game.passer, modeBefore = game.ballMode;
    game.update(DT);
    if (catchOOB && game.ballMode === "pass" && game.passer !== passerBefore) { saved++; savedPass++; if (sawAir) dove++; }
    else if (catchOOB && modeBefore === "pass" && game.ballMode === "loose") { saved++; if (sawAir) dove++; }
    const s = game.saveBy;
    if (s) {
      const d = Math.max(Math.abs(s.pos.x) - COURT.halfW, Math.abs(s.pos.z) - COURT.halfL);
      if (d > 0) depths.push(d);
      if (game.saveT <= 0.02) stuck++;   // 時間切れで戻りきれなかった
    }
  }
  for (const p of game.players) tov += p.stats.tov;
}
const q = (a: number[], f: number) => a.length ? a.slice().sort((x, y) => x - y)[Math.floor((a.length - 1) * f)].toFixed(2) : "-";
console.log(`${N}試合  外れ着弾のパス ${throwaway}  追走 ${chased} (${(chased / Math.max(1, throwaway) * 100).toFixed(0)}%)  ラインからの深さ 中央値${q(overs, .5)}m 最大${q(overs, 1)}m`);
console.log(`セーブ成立 ${saved} (${(saved / Math.max(1, chased) * 100).toFixed(0)}%)  横っ飛び中に掴んだ ${dove}  味方へパス ${savedPass} / 投げ捨て ${saved - savedPass}`);
console.log(`セーブ中のライン外の深さ 中央値${q(depths, .5)}m 90%${q(depths, .9)}m 最大${q(depths, 1)}m  時間切れ復帰 ${stuck}フレーム`);
console.log(`TO合計(全${N}試合・両チーム) ${tov} = 1試合 ${(tov / N).toFixed(1)}`);
