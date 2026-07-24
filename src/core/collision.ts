// 選手同士の衝突解決（方式B: GameState 集約）。重なった選手を押し離す物理と、押し合い
// の重み(holdWeight: ボール保持者やパサーは踏ん張る)。毎フレーム updateLive から呼ぶ。
// 状態は Game に集約し各関数は第一引数 game を受け取る。
import { Player } from "../player";
import { clamp, dist2D, rand } from "../util";
import { rate } from "../attributes";
import type { Game } from "../game";

  // Bodies can't overlap: push any two players who collide apart, splitting the
  // correction by "hold" weight so it reads as jostling for position rather than
  // one player phasing through another. Run after all movement each frame.
export function resolveCollisions(game: Game, ): void {
    const MIN = 0.62; // ~2x capsule radius
    for (let iter = 0; iter < 2; iter++) {
      for (let i = 0; i < game.players.length; i++) {
        for (let j = i + 1; j < game.players.length; j++) {
          const a = game.players[i], b = game.players[j];
          let dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z;
          let d = Math.hypot(dx, dz);
          if (d >= MIN) continue;
          if (d < 1e-4) { dx = rand(-1, 1); dz = rand(-1, 1); d = Math.hypot(dx, dz) || 1; }
          const overlap = MIN - d;
          const nx = dx / d, nz = dz / d;
          const wa = holdWeight(game, a), wb = holdWeight(game, b);
          // square the hold weights so a real strength gap shows: the stronger
          // man barely gives ground while the weaker one is shoved back (and a
          // strong post player bulls a weak defender backwards)
          const wa2 = wa * wa, wb2 = wb * wb;
          const total = wa2 + wb2;
          a.pos.x -= nx * overlap * (wb2 / total); a.pos.z -= nz * overlap * (wb2 / total);
          b.pos.x += nx * overlap * (wa2 / total); b.pos.z += nz * overlap * (wa2 / total);

          // mid-air collision: the stronger body knocks the other away
          if (a.airborne && b.airborne) {
            const diff = rate(a.attr.balance) - rate(b.attr.balance);
            const knock = Math.abs(diff) * 0.6;
            if (diff > 0) { b.pos.x += nx * knock; b.pos.z += nz * knock; }
            else { a.pos.x -= nx * knock; a.pos.z -= nz * knock; }
          }
        }
      }
    }
    // keep everyone in bounds — except an inbounder, who stands out of bounds;
    // during a substitution/walk-off exchange, when players legitimately cross
    // the sideline; and during dead-ball pauses (nobody moves, and the quarter
    // break holds everyone gathered at the bench, outside the court)
    if (game.ballMode === "subs" || game.ballMode === "pause"
        || game.ballMode === "finale") return;   // losers walk off to the bench
    // the inbounder stands out of bounds to throw, and stays there through the
    // throw's flight (he steps in only once his follow-through is done) — so
    // don't yank him onto the court. Normal in-bounds passers are unaffected.
    const skip = game.ballMode === "inbound" ? game.handler
      : game.ballMode === "pass" ? game.passer : null;
    for (const p of game.players) if (p !== skip) game.clampCourt(p.pos);
  }

  // How hard a player holds their ground in a collision (higher = shoves more).
  // ボディバランス wins the body battle: a strong post player backs his man down
  // and is pushed around less; a weak one yields ground.
export function holdWeight(game: Game, p: Player): number {
    let w = 0.5 + rate(p.attr.balance) * 0.78;                // ~0.6 (weak) .. ~1.28 (strong)
    if (p === game.handler) {
      w += 0.5 + (p.has("post") ? 0.3 : 0);                   // protects the ball / posts up
      if (p.keepShieldT > 0) w += 1.3;                        // braced keeper: a wide base the trap can't budge
    }
    else if (p.screening) w += 0.6;                           // a set screen holds firm
    else if (p.team === 1 - game.possession) w += 0.25;       // defenders hold position
    return w;
  }
