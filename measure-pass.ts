// 一時計測: パス球速カーブの実効果(飛行時間/カット率/TO)。使い捨て。
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

async function main() {
  const { NullEngine, Scene } = await import("@babylonjs/core");
  const { Game } = await import("./src/game");
  const { randomizeRosters } = await import("./src/roster");

  const engine = new NullEngine();
  const GAMES = Number(process.env.GAMES ?? 12);
  const dt = 1 / 60;

  const throws: { d: number; dur: number; style: string; cut: boolean }[] = [];
  let tov = 0, pts = 0;

  for (let g = 0; g < GAMES; g++) {
    Math.random = mulberry32(4000 + g);
    randomizeRosters();
    const scene = new Scene(engine);
    const game: any = new Game(scene);
    game.applyRoster();
    game.reset();
    let wasPass = false;

    for (let i = 0; i < 60 * 60 * 60 && game.ballMode !== "finale"; i++) {
      game.update(dt);
      const isPass = game.ballMode === "pass";
      if (isPass && !wasPass) {
        const a = game.passFrom, b = game.passCatch;
        throws.push({
          d: Math.hypot(b.x - a.x, b.z - a.z),
          dur: game.passDur,
          style: game.passOneHand ? game.passStyle + "(片手)" : game.passStyle,
          cut: !!game.passSteal,
        });
      }
      wasPass = isPass;
    }
    for (const p of game.players) { tov += p.stats.tov; }
    pts += game.score[0] + game.score[1];
    scene.dispose();
  }

  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
  console.log(`=== ${GAMES}試合 / パス ${throws.length}本 ===`);
  console.log(`平均距離 ${avg(throws.map((t) => t.d)).toFixed(2)}m  平均飛行 ${avg(throws.map((t) => t.dur)).toFixed(3)}s`);
  console.log(`平均球速 ${avg(throws.map((t) => t.d / t.dur)).toFixed(2)} m/s`);
  console.log(`カット確定率 ${(100 * throws.filter((t) => t.cut).length / throws.length).toFixed(1)}%`);
  const byStyle = new Map<string, typeof throws>();
  for (const t of throws) { (byStyle.get(t.style) ?? byStyle.set(t.style, []).get(t.style)!).push(t); }
  for (const [s, ts] of [...byStyle].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${s.padEnd(16)} ${String(ts.length).padStart(5)}本 ${(100 * ts.length / throws.length).toFixed(0)}%  ` +
      `${avg(ts.map((t) => t.d)).toFixed(1)}m ${avg(ts.map((t) => t.dur)).toFixed(2)}s ` +
      `${avg(ts.map((t) => t.d / t.dur)).toFixed(1)}m/s カット${(100 * ts.filter((t) => t.cut).length / ts.length).toFixed(1)}%`);
  }
  console.log(`TO合計 ${tov} (${(tov / GAMES).toFixed(1)}/試合)  平均得点 ${(pts / GAMES / 2).toFixed(1)}`);
}
main();
