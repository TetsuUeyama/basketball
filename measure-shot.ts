// 一時計測: コンテストの効き(跳んだ守備者 vs 成功率)。使い捨て。
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

type S = {
  three: boolean; gap: number; air: boolean; frozen: number; reach: number;
  pAct: number; pLive: number; made: boolean; airFired: boolean;
};

async function main() {
  const { NullEngine, Scene } = await import("@babylonjs/core");
  const { Game } = await import("./src/game");
  const { randomizeRosters } = await import("./src/roster");
  const { jumpShotMakeProbability } = await import("./src/move/reaction/shot-outcome");
  const { palmRadius } = await import("./src/eval");

  const engine = new NullEngine();
  const GAMES = Number(process.env.GAMES ?? 40);
  const dt = 1 / 60;
  const shots: S[] = [];
  let blocked = 0, pts = 0;

  for (let g = 0; g < GAMES; g++) {
    Math.random = mulberry32(Number(process.env.SEED ?? 9000) + g);
    randomizeRosters();
    const scene = new Scene(engine);
    const game: any = new Game(scene);
    game.applyRoster();
    game.reset();
    let last: Omit<S, "made"> | null = null;
    let wasCharge = false;

    for (let i = 0; i < 60 * 60 * 60 && game.ballMode !== "finale"; i++) {
      if (game.ballMode === "charge" && game.chargeShooter) {
        const h = game.chargeShooter;
        const nd = game.nearestDefender(h);
        const gap = nd ? Math.hypot(nd.pos.x - h.pos.x, nd.pos.z - h.pos.z) : 99;
        const reach = nd ? palmRadius(nd, h) : 1.8;
        const c = {
          nearestDef: nd, helpCount: game.defendersWithin(h, 2.4),
          clutch: game.clutchFactor(h), prepShort: 0, prepExtra: 0, palmHitbox: true,
        };
        const dH = game.chargeDHoop;
        last = {
          three: dH > 6.75, gap, air: !!(nd && nd.airborne), frozen: game.chargeDDef, reach,
          pAct: jumpShotMakeProbability(h, dH, game.chargeDDef, c),
          pLive: jumpShotMakeProbability(h, dH, gap, c),
          airFired: !!(nd && nd.airborne && game.chargeDDef < reach + 0.4),
        };
      }
      const wc = game.ballMode === "charge";
      game.update(dt);
      if (wasCharge && game.ballMode !== "charge" && last) {
        if (game.ballMode === "shot" && !game.shotWasDunk) {
          shots.push({ ...last, made: !!game.shotMade });
        } else blocked++;
        last = null;
      }
      wasCharge = wc;
    }
    pts += game.score[0] + game.score[1];
    scene.dispose();
  }

  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
  const pct = (xs: S[]) => xs.length ? `${(100 * xs.filter((s) => s.made).length / xs.length).toFixed(0)}%/n=${xs.length}` : "n=0";
  const BUCKET: [string, (g: number) => boolean][] = [
    ["密着 <1.0m", (g) => g < 1.0],
    ["1.0-1.6m", (g) => g >= 1.0 && g < 1.6],
    ["1.6-2.5m", (g) => g >= 1.6 && g < 2.5],
    ["2.5m以上", (g) => g >= 2.5],
  ];
  for (const [label, isThree] of [["3P", true], ["ミドル", false]] as [string, boolean][]) {
    const set = shots.filter((s) => s.three === isThree);
    console.log(`\n=== ${label}  n=${set.length}  実成功率 ${(100 * set.filter((s) => s.made).length / (set.length || 1)).toFixed(1)}% ===`);
    console.log(`  ${"リリース時の実距離".padEnd(12)} | 跳: p凍結 / p実距離 / 実測 | 立: p凍結 / p実距離 / 実測`);
    for (const [bl, f] of BUCKET) {
      const air = set.filter((s) => f(s.gap) && s.air), gnd = set.filter((s) => f(s.gap) && !s.air);
      const fmt = (xs: S[]) => xs.length
        ? `${(100 * avg(xs.map((s) => s.pAct))).toFixed(0)}% / ${(100 * avg(xs.map((s) => s.pLive))).toFixed(0)}% / ${pct(xs)}`
        : "—";
      console.log(`  ${bl.padEnd(14)} | ${fmt(air).padEnd(26)} | ${fmt(gnd)}`);
    }
  }
  const drift = shots.map((s) => s.frozen - s.gap);
  console.log(`\n決断時の守備距離(frozen) − リリース時の実距離: 平均 +${avg(drift).toFixed(2)}m / 0.5m以上甘い ${(100 * drift.filter((d) => d > 0.5).length / drift.length).toFixed(0)}%`);
  const airs = shots.filter((s) => s.air);
  console.log(`リリース時に守備者が空中: ${airs.length}本 (${(100 * airs.length / shots.length).toFixed(0)}%)  うち空中ペナルティ発火 ${airs.filter((s) => s.airFired).length}本`);
  console.log(`空中の平均: 実距離 ${avg(airs.map((s) => s.gap)).toFixed(2)}m / frozen ${avg(airs.map((s) => s.frozen)).toFixed(2)}m / palmRadius ${avg(airs.map((s) => s.reach)).toFixed(2)}m`);
  console.log(`想定p ${(100 * avg(shots.map((s) => s.pAct))).toFixed(1)}% → 実距離で計算すると ${(100 * avg(shots.map((s) => s.pLive))).toFixed(1)}%`);
  console.log(`ブロック/はたき ${blocked}本  平均得点 ${(pts / GAMES / 2).toFixed(1)}`);
}
main();
