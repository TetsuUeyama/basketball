// ネームタグの表示範囲: 既定(オンボール+マークのみ / ベンチ非表示)と、全員表示・ベンチ表示。
import "./stubs";
import { NullEngine, Scene } from "@babylonjs/core";
import { Game } from "../src/game";
import { Player } from "../src/objects/player/player";
import { buildCourt } from "../src/objects/court";
Player.HEADLESS = true;
import { clubTeam } from "../src/roster";
import { HUD_OPTS } from "../src/config";

const engine = new NullEngine();
const scene = new Scene(engine);
const hoops = buildCourt(scene);
const game = new Game(scene);
(game as unknown as { attachHoops(h: unknown): void }).attachHoops(hoops);
clubTeam(0, 0); clubTeam(1, 1);
const g = game as unknown as { applyRoster(): void; reset(): void; update(dt: number): void; state: string };
g.applyRoster(); g.reset();

console.log(`既定: courtNames=${HUD_OPTS.courtNames} / benchNames=${HUD_OPTS.benchNames}`);

const DT = 1 / 60;
type Tally = { frames: number; court: number; bench: number; onlyBallSide: number; modes: Map<string, number> };
function run(label: string): void {
  const t: Tally = { frames: 0, court: 0, bench: 0, onlyBallSide: 0, modes: new Map() };
  for (let i = 0; i < 60 * 60 * 3; i++) {
    g.update(DT);
    t.frames++;
    let court = 0, bench = 0, wrong = 0;
    const h = game.handler;
    const mark = h ? game.onBallDefender(h) : undefined;
    for (let team = 0; team < 2; team++) {
      for (const p of game.roster[team]) {
        if (!p.namePlane.isVisible) continue;
        if (game.onCourt(p)) {
          court++;
          if (HUD_OPTS.courtNames === "ball" && game.ballMode === "held" && p !== h && p !== mark) wrong++;
        } else bench++;
      }
    }
    t.court += court; t.bench += bench; t.onlyBallSide += wrong;
    if (game.ballMode === "held") {
      const k = `held:${court}人`;
      t.modes.set(k, (t.modes.get(k) ?? 0) + 1);
    }
  }
  console.log(`\n[${label}] ${t.frames}フレーム`);
  console.log(`  コート上の表示 平均 ${(t.court / t.frames).toFixed(2)}人 / ベンチ 平均 ${(t.bench / t.frames).toFixed(2)}人`);
  console.log(`  ドリブル中(held)にオンボール・マーク以外が出たフレーム: ${t.onlyBallSide}`);
  console.log(`  held の内訳: ${[...t.modes.entries()].sort().map(([k, v]) => `${k}×${v}`).join(" / ")}`);
}

run("既定 (ball / bench off)");
HUD_OPTS.courtNames = "all"; HUD_OPTS.benchNames = true;
run("全員表示 + ベンチ表示");
