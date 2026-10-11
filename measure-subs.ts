// 一時計測: 交代中にコート上の選手が並行して配置につけているか。使い捨て。
// OLD=1 で従来どおり(交代中は静止)をエミュレートして比較する。
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
  const { Player } = await import("./src/objects/player/player");
  const { randomizeRosters } = await import("./src/roster");
  const { towardPoint } = await import("./src/util");
  Player.HEADLESS = true;

  const engine = new NullEngine();
  const GAMES = Number(process.env.GAMES ?? 6);
  const OLD = process.env.OLD === "1";
  const dt = 1 / 60;

  let subEpisodes = 0, subFrames = 0;
  let movedTotal = 0;          // 交代中にコート上の非歩行者が動いた距離の合計(m)
  let gapAtEnd = 0, gapAtStart = 0, gapSamples = 0;   // 配置までの残り距離(m)
  let timedOut = 0;
  let subSeconds = 0;

  // 「次の配置」までの距離。攻撃側は formationSpots、守備側はマークのゴール側1.4m
  const gapOf = (game: any): number => {
    const off = game.subOffense;
    if (off === null || off === undefined) return NaN;
    const spots = game.formationSpots(off);
    const protect = game.attackFloor(off);
    const offense = game.teamPlayers(off);
    let sum = 0, n = 0;
    for (const p of offense) {
      if (game.subWalkers.some((w: any) => w.p === p)) continue;
      const s = spots[p.spotIdx];
      if (!s) continue;
      sum += Math.hypot(p.pos.x - s.x, p.pos.z - s.z); n++;
    }
    for (const d of game.teamPlayers(1 - off)) {
      if (game.subWalkers.some((w: any) => w.p === d)) continue;
      const man = offense[d.slot];
      const s = spots[man.spotIdx] ?? man.pos;
      const gs = towardPoint(s.x, s.z, protect.x, protect.z, 1.4);
      sum += Math.hypot(d.pos.x - gs.x, d.pos.z - gs.z); n++;
    }
    return n ? sum / n : NaN;
  };

  for (let g = 0; g < GAMES; g++) {
    Math.random = mulberry32(4000 + g);
    randomizeRosters();
    const scene = new Scene(engine);
    const game: any = new Game(scene);
    game.applyRoster();
    game.reset();

    let prevSubs = false;                 // 前フレームの「更新前」の状態
    let episodeStartGap = NaN;
    let realOffense: number | null = null;

    for (let i = 0; i < 60 * 60 * 60 && game.ballMode !== "finale"; i++) {
      const isSubs = game.ballMode === "subs";
      // 交代の開始（従来動作のエミュレートで潰す前に本来の攻撃側を控える）
      if (isSubs && !prevSubs) {
        subEpisodes++;
        realOffense = game.subOffense;
        episodeStartGap = gapOf(game);
      }
      // 従来動作のエミュレート: 配置移動を無効化する
      if (isSubs && OLD) game.subOffense = null;

      const before = isSubs
        ? game.players.map((p: any) => ({ p, x: p.pos.x, z: p.pos.z }))
        : null;
      const walkers = isSubs ? new Set(game.subWalkers.map((w: any) => w.p)) : null;
      const subTBefore = game.subT;

      game.update(dt);

      if (isSubs && before) {
        subFrames++;
        for (const b of before) {
          if (walkers!.has(b.p)) continue;
          movedTotal += Math.hypot(b.p.pos.x - b.x, b.p.pos.z - b.z);
        }
      }
      // 交代が終わった瞬間（残り距離は本来の攻撃側で測る）
      if (isSubs && game.ballMode !== "subs") {
        if (subTBefore >= 9) timedOut++;
        subSeconds += subTBefore;
        const saved = game.subOffense;
        game.subOffense = realOffense;
        const gEnd = gapOf(game);
        game.subOffense = saved;
        if (!Number.isNaN(gEnd) && !Number.isNaN(episodeStartGap)) {
          gapAtStart += episodeStartGap; gapAtEnd += gEnd; gapSamples++;
        }
        realOffense = null;
      }
      prevSubs = isSubs;
    }
    scene.dispose();
  }

  const tag = OLD ? "従来(静止)" : "修正後(並行)";
  console.log(
    `${tag.padEnd(12)} 交代 ${String(subEpisodes).padStart(3)}回 / 平均 ${(subSeconds / Math.max(1, subEpisodes)).toFixed(2)}秒 / 打ち切り ${timedOut}回\n` +
    `             交代中に動いた距離 合計 ${movedTotal.toFixed(1)}m (1回あたり ${(movedTotal / Math.max(1, subEpisodes)).toFixed(2)}m)\n` +
    `             配置までの残り距離 開始 ${(gapAtStart / Math.max(1, gapSamples)).toFixed(2)}m → 終了 ${(gapAtEnd / Math.max(1, gapSamples)).toFixed(2)}m (${gapSamples}件)`,
  );
}
main();
