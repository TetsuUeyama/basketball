// 審判の上半身のひねり(torsoTwist)が投げ渡しの後に戻るかを実測する。
import "./stubs";
import { NullEngine, Scene } from "@babylonjs/core";
import { Game } from "../src/game";
import { Player } from "../src/objects/player/player";
import { buildCourt } from "../src/objects/court";
Player.HEADLESS = true;
import { clubTeam } from "../src/roster";

const engine = new NullEngine();
const scene = new Scene(engine);
const hoops = buildCourt(scene);
const game = new Game(scene);
(game as unknown as { attachHoops(h: unknown): void }).attachHoops(hoops);
clubTeam(0, 0); clubTeam(1, 1);
const g = game as unknown as { applyRoster(): void; reset(): void; update(dt: number): void };
g.applyRoster();
g.reset();

const refs = game.referees.refs;
let maxTwist = 0, passes = 0;
let sawPass = [false, false];
const after: number[] = [];   // 「pass」シグナルが終わってから1秒後のひねり
const pending: { i: number; at: number }[] = [];
let t = 0;

for (let i = 0; i < 60 * 120; i++) {
  g.update(1 / 60);
  t += 1 / 60;
  for (let k = 0; k < 2; k++) {
    const r = refs[k];
    maxTwist = Math.max(maxTwist, Math.abs(r.body.torsoTwist));
    const isPass = r.sigKind === "pass";
    if (isPass && !sawPass[k]) { passes++; }
    if (!isPass && sawPass[k]) pending.push({ i: k, at: t + 1.0 });   // 投げ終わり
    sawPass[k] = isPass;
  }
  for (let j = pending.length - 1; j >= 0; j--) {
    if (t >= pending[j].at) { after.push(Math.abs(refs[pending[j].i].body.torsoTwist)); pending.splice(j, 1); }
  }
}
const fmt = (v: number) => v.toFixed(3);
console.log(`投げ渡し ${passes} 回 / ひねりの最大 ${fmt(maxTwist)} rad`);
console.log(`投げ終わり1秒後のひねり(${after.length}件): `
  + (after.length ? `最大 ${fmt(Math.max(...after))} / 平均 ${fmt(after.reduce((a, b) => a + b, 0) / after.length)}` : "なし"));
console.log(`現在のひねり: ${refs.map((r) => fmt(r.body.torsoTwist)).join(" / ")}`);
