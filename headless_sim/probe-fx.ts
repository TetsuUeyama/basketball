// ボール発光の集計: 1試合ぶんの種類×チームの発火数と、実際に入る発光色。
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
const g = game as unknown as { applyRoster(): void; reset(): void; update(dt: number): void; state: string };
g.applyRoster(); g.reset();

// 種類が切り替わった/再点火したフレームを数える（kind と残り時間の立ち上がりで検出）
const count = new Map<string, number>();
const color = new Map<string, string>();
let prevKind = "", prevT = 0;
const DT = 1 / 60;
for (let i = 0; i < 60 * 60 * 12 && g.state !== "final"; i++) {
  g.update(DT);
  const k = game.ballFxKind, t = game.ballFxT;
  if (k && t > 0 && (k !== prevKind || t > prevT)) {
    const c = game.ballFxColor;
    // 色から発火チームを逆引き（R>B=ホーム赤系 / B>R=ビジター青系）
    const side = Math.abs(c.r - c.b) < 1e-6 ? "白" : c.r > c.b ? "ホーム" : "ビジター";
    const key = `${k} / ${side}`;
    count.set(key, (count.get(key) ?? 0) + 1);
    color.set(key, `(${c.r.toFixed(2)}, ${c.g.toFixed(2)}, ${c.b.toFixed(2)})`);
  }
  prevKind = k; prevT = t;
}
console.log(`最終スコア ${game.score[0]}-${game.score[1]} (state=${g.state})`);
for (const [k, n] of [...count.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(20)} ${String(n).padStart(5)} 回   色 ${color.get(k)}`);
}
