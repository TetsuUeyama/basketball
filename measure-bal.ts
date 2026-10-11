// 一時計測: パス改修のバランス影響(BLUE値)とパス球速の分布。使い捨て。
const ctxStub: any = new Proxy({}, { get: () => () => {} });
(globalThis as any).OffscreenCanvas = class {
  width = 1; height = 1;
  constructor(w?: number, h?: number) { this.width = w ?? 1; this.height = h ?? 1; }
  getContext() { return ctxStub; }
};
(globalThis as any).document = (globalThis as any).document ?? {
  createElement: () => ({ getContext: () => ctxStub, width: 1, height: 1, style: {} }),
};
function mulberry32(a: number) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const GAMES = Number(process.env.GAMES ?? 12);

async function main() {
  const { NullEngine, Scene } = await import("@babylonjs/core");
  const { Game } = await import("./src/game");
  const { randomizeRosters } = await import("./src/roster");

  const engine = new NullEngine();

  const tot = { pts: 0, fga: 0, fgm: 0, tpa: 0, tpm: 0, ast: 0, tov: 0, stl: 0, reb: 0 };
  const passes: { attr: number; spd: number; d: number }[] = [];
  let floored = 0, oneHand = 0, airborne = 0;
  const styleN: Record<string, number> = {};

  for (let g = 0; g < GAMES; g++) {
    Math.random = mulberry32(1000 + g);
    randomizeRosters();
    const scene = new Scene(engine);   // 試合ごとに作って破棄する(メッシュのリーク回避)
    const game: any = new Game(scene);
    game.applyRoster();
    game.reset();
    const dt = 1 / 60;
    let prevMode = game.ballMode;
    // 1試合ぶん(4クォーター)が終わるまで回す。安全弁として上限フレーム。
    for (let i = 0; i < 60 * 60 * 60 && game.ballMode !== "finale"; i++) {
      game.update(dt);
      if (game.ballMode === "pass" && prevMode !== "pass" && game.passer && game.passDur > 0) {
        const d = Math.hypot(game.passCatch.x - game.passFrom.x, game.passCatch.z - game.passFrom.z);
        passes.push({ attr: game.passer.attr.passSpd, spd: d / game.passDur, d });
        styleN[game.passStyle] = (styleN[game.passStyle] ?? 0) + 1;
        if (game.passOneHand) oneHand++;
        if (game.passer.airborne) airborne++;
        if (game.passDur <= 0.1501) floored++;
      }
      prevMode = game.ballMode;
    }
    for (const p of game.players) {
      const s = p.stats;
      tot.pts += s.pts; tot.fga += s.fga; tot.fgm += s.fgm; tot.tpa += s.tpa; tot.tpm += s.tpm;
      tot.ast += s.ast; tot.tov += s.tov; tot.stl += s.stl; tot.reb += s.reb;
    }
    scene.dispose();
  }

  const per = (n: number) => (n / GAMES / 2).toFixed(2);   // 1チーム1試合あたり
  console.log(`=== ${GAMES}試合 (1チームあたり/試合) ===`);
  console.log(`得点 ${per(tot.pts)}  FGA ${per(tot.fga)}  FG% ${(100 * tot.fgm / (tot.fga || 1)).toFixed(1)}  3PA ${per(tot.tpa)}  3P% ${(100 * tot.tpm / (tot.tpa || 1)).toFixed(1)}`);
  console.log(`AST ${per(tot.ast)}  TOV ${per(tot.tov)}  STL ${per(tot.stl)}  REB ${per(tot.reb)}`);

  const bands: Record<string, number[]> = {};
  for (const p of passes) {
    const k = p.attr < 70 ? "65-69" : p.attr < 75 ? "70-74" : p.attr < 80 ? "75-79" : "80+";
    (bands[k] ??= []).push(p.spd);
  }
  const avg = (xs: number[]) => (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2);
  console.log(`パス ${passes.length}本  平均球速 ${avg(passes.map((p) => p.spd))} m/s  フロア張り付き ${(100 * floored / passes.length).toFixed(0)}%`);
  console.log(`  種別`, styleN, ` 片手 ${(100*oneHand/passes.length).toFixed(0)}%  空中 ${(100*airborne/passes.length).toFixed(0)}%`);
  for (const k of Object.keys(bands).sort()) console.log(`  passSpd ${k.padEnd(6)} n=${String(bands[k].length).padStart(4)} 平均 ${avg(bands[k])} m/s`);
}
main();
