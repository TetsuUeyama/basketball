// 一時計測: 押し込みドリブル(powerT)の実効果。使い捨て。
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
  const { rate } = await import("./src/util");

  const engine = new NullEngine();
  const GAMES = Number(process.env.GAMES ?? 10);
  const dt = 1 / 60;

  // 1回の押し込み(powerT開始〜終了)ごとに記録
  const bouts: { edge: number; pushed: number; gained: number; dRim0: number; stolen: boolean; stalled: boolean }[] = [];
  let stealsDuringShove = 0, contestDuringShove = 0;

  for (let g = 0; g < GAMES; g++) {
    Math.random = mulberry32(2000 + g);
    randomizeRosters();
    const scene = new Scene(engine);
    const game: any = new Game(scene);
    game.applyRoster();
    game.reset();
    const live = new Map<any, any>();

    for (let i = 0; i < 60 * 60 * 60 && game.ballMode !== "finale"; i++) {
      const before = new Map<any, { hz: number; hx: number; dz: number; dx: number }>();
      for (const p of game.players) {
        if (p.powerT > 0) {
          const d = game.onBallDefender(p);
          if (d) before.set(p, { hx: p.pos.x, hz: p.pos.z, dx: d.pos.x, dz: d.pos.z });
        }
      }
      const possBefore = game.possession;
      game.update(dt);

      for (const p of game.players) {
        if (p.powerT > 0 && !live.has(p)) {
          const d = game.onBallDefender(p);
          const rim = game.attackFloor(p.team);
          live.set(p, {
            edge: d ? rate(p.attr.balance) - rate(d.attr.balance) : 0,
            pushed: 0, gained: 0,
            dRim0: Math.hypot(p.pos.x - rim.x, p.pos.z - rim.z),
            stolen: false, stalled: false,
          });
        }
        const e = live.get(p);
        if (!e) continue;
        const b = before.get(p);
        if (b) {
          // リムまでの距離が縮んだ量＝正味の押し込み(横の守備移動に汚染されない)
          const rim = game.attackFloor(p.team);
          const d = game.onBallDefender(p);
          if (d) {
            e.pushed += Math.hypot(b.dx - rim.x, b.dz - rim.z)
              - Math.hypot(d.pos.x - rim.x, d.pos.z - rim.z);
          }
          e.gained += Math.hypot(b.hx - rim.x, b.hz - rim.z)
            - Math.hypot(p.pos.x - rim.x, p.pos.z - rim.z);
        }
        if (p.powerT <= 0) {
          if (game.possession !== possBefore) { e.stolen = true; stealsDuringShove++; }
          if (p.stalledT > 0) e.stalled = true;
          bouts.push(e);
          live.delete(p);
        }
      }
      // 押されている最中に守備側が仕掛けたか
      for (const p of game.players) {
        if (p.powerT <= 0) continue;
        const d = game.onBallDefender(p);
        if (d && (d.actKind === "steal" && d.actPhase !== "")) contestDuringShove++;
      }
    }
    scene.dispose();
  }

  const st = (xs: number[]) => {
    if (!xs.length) return "n=0";
    const s = [...xs].sort((a, b) => a - b);
    return `平均${(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(3)} 中央${s[s.length >> 1].toFixed(3)} 最大${s[s.length - 1].toFixed(3)}`;
  };
  console.log(`=== ${GAMES}試合 / 押し込み ${bouts.length}回 ===`);
  console.log(`ボディバランス差(edge): ${st(bouts.map((b) => b.edge))}`);
  console.log(`  edge>0(押せる側)の割合: ${(100 * bouts.filter((b) => b.edge > 0).length / bouts.length).toFixed(0)}%`);
  console.log(`守備者をリム方向へ押し込んだ正味(m): ${st(bouts.map((b) => b.pushed))}`);
  console.log(`  edge>0 のみ: ${st(bouts.filter((b) => b.edge > 0).map((b) => b.pushed))}`);
  console.log(`  edge<=0 のみ: ${st(bouts.filter((b) => b.edge <= 0).map((b) => b.pushed))}`);
  console.log(`ハンドラーのリム接近(m): ${st(bouts.map((b) => b.gained))}`);
  console.log(`開始時のリムまでの距離(m): ${st(bouts.map((b) => b.dRim0))}`);
  console.log(`  リム5m以内で始めた割合: ${(100 * bouts.filter((b) => b.dRim0 <= 5).length / bouts.length).toFixed(0)}%`);
  console.log(`押し込み中に奪われた: ${bouts.filter((b) => b.stolen).length}回 / 壁で止められた: ${bouts.filter((b) => b.stalled).length}回`);
  console.log(`押し込み中に担当守備者がスティール動作に入ったフレーム: ${contestDuringShove}`);
}
main();
