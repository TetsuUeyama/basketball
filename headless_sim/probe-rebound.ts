// リバウンド確保直後のプットバック/アウトレットを実測する。
// (1) 空中で跳んだ体が1フレームで落ちる「跳び直しスナップ」の有無
// (2) 確保→プットバック/アウトレットの発生数と、片手/両手の内訳
// (3) パスのリリース高さがボールの実位置とどれだけ離れているか
import "./stubs";
import { NullEngine, Scene } from "@babylonjs/core";
import { Game } from "../src/game";
import { Player } from "../src/objects/player/player";
import { buildCourt } from "../src/objects/court";
Player.HEADLESS = true;
import { clubTeam } from "../src/roster";
import { CLUBS } from "../src/data/club/clubdb";

const engine = new NullEngine();
const scene = new Scene(engine);
const hoops = buildCourt(scene);
const game = new Game(scene);
(game as unknown as { attachHoops(h: unknown): void }).attachHoops(hoops);

const DT = 1 / 60;
const GAMES = Number(process.env.GAMES ?? 4);

let snaps = 0, snapWorst = 0, snapWhere = "";
let secures = 0, airSecures = 0, putbacks = 0, outlets = 0, heldOn = 0;
let oneHandGrab = 0, oneHandPass = 0;
let ballGapWorst = 0;    // パス開始時のボール位置とリリース点の乖離(m)
let shotGapWorst = 0;    // プットバック開始時のボール位置とリリース点の乖離(m)

const prevY = new Map<Player, number>();
const prevMode = { m: "" };

for (let g = 0; g < GAMES; g++) {
  clubTeam(0, g % CLUBS.length); clubTeam(1, (g + 1) % CLUBS.length);
  const gg = game as unknown as {
    reset(): void; update(dt: number): void; applyRoster(): void; state: string;
  };
  gg.applyRoster();
  gg.reset();
  let guard = 0;
  while (gg.state !== "final" && guard++ < 400000) {
    // 確保直後(reboundGo が立っている)選手を先に拾う
    const pending = game.players.filter((p) => p.reboundGo);
    for (const p of pending) {
      airSecures++;
      if (!p.grabTwoHand) oneHandGrab++;
    }
    const before = game.ballMode;
    gg.update(DT);
    // 跳び直しスナップ: 空中のまま高さが1フレームで大きく落ちた
    for (const p of game.players) {
      const y = p.jumpY(), pv = prevY.get(p) ?? 0;
      if (p.airborne && pv > 0.15 && pv - y > 0.25) {
        snaps++;
        if (pv - y > snapWorst) { snapWorst = pv - y; snapWhere = `${game.ballMode}`; }
      }
      prevY.set(p, y);
    }
    // 確保 → 次の行動
    if (pending.length) {
      if (game.ballMode === "shot") {
        putbacks++;
        const h = pending[0];
        console.log(`  [putback] air=${h.airborne} shotDur=${game.shotDur.toFixed(2)}`
          + ` 残滞空=${h.jumpRemaining.toFixed(2)} from.y=${game.shotFrom.y.toFixed(2)}`
          + ` ball.y=${game.ball.pos.y.toFixed(2)} dunk=${game.shotWasDunk}`);
        shotGapWorst = Math.max(shotGapWorst, Math.abs(game.shotFrom.y - game.ball.pos.y));
      } else if (game.ballMode === "pass") {
        outlets++;
        if (game.passOneHand) oneHandPass++;
        const gap = Math.abs(game.passFrom.y - game.ball.pos.y);
        if (gap > 0.3) {
          const h = pending[0];
          console.log(`  [pass gap ${gap.toFixed(2)}] style=${game.passStyle} air=${h.airborne}`
            + ` pickupT=${h.pickupT.toFixed(2)} from.y=${game.passFrom.y.toFixed(2)}`
            + ` ball.y=${game.ball.pos.y.toFixed(2)} passT=${game.passT.toFixed(3)}/${game.passDur.toFixed(2)}`);
        }
        ballGapWorst = Math.max(ballGapWorst, gap);
      } else heldOn++;
    }
    if (before === "loose" && game.ballMode === "held") secures++;
    prevMode.m = before;
  }
}

console.log(`games=${GAMES}`);
console.log(`ルーズ確保: ${secures} / 空中リバウンド確保(reboundGo): ${airSecures}`);
console.log(`  → プットバック ${putbacks} / アウトレット ${outlets} / そのまま着地 ${heldOn}`);
console.log(`片手確保 ${oneHandGrab} / 片手パス ${oneHandPass}`);
console.log(`跳び直しスナップ(空中で高さが1フレーム0.25m以上落ちた): ${snaps} 回 最大 ${snapWorst.toFixed(2)}m (${snapWhere})`);
console.log(`リリース点とボールの乖離: パス最大 ${ballGapWorst.toFixed(2)}m / プットバック最大 ${shotGapWorst.toFixed(2)}m`);
