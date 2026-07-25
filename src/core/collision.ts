// 選手同士の衝突解決。重なった選手を押し離す物理と、押し合いの重み
// (holdWeight: ボール保持者やパサーは踏ん張る)。毎フレーム updateLive から呼ぶ。
import { Player } from "../objects/player/player";
import { BODY_MIN_DIST } from "../config";
import { rate, rand } from "../util";
import type { Game } from "../game";

  // 重なった体を等分に押し離す（重みなしの単純版）。d≈0 はランダム方向へずらす。
export function pushApart(bodies: Player[], min = BODY_MIN_DIST): void {
    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) {
        const a = bodies[i], b = bodies[j];
        let dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z;
        let d = Math.hypot(dx, dz);
        if (d >= min) continue;
        if (d < 1e-4) { dx = rand(-1, 1); dz = rand(-1, 1); d = Math.hypot(dx, dz) || 1; }
        const push = (min - d) / 2;
        a.pos.x -= (dx / d) * push; a.pos.z -= (dz / d) * push;
        b.pos.x += (dx / d) * push; b.pos.z += (dz / d) * push;
      }
    }
  }

  // 衝突した2選手を押し離す。補正を「踏ん張り」の重みで分配する。
  // 毎フレーム、全ての移動の後に実行する。
export function resolveCollisions(game: Game, ): void {
    const MIN = BODY_MIN_DIST; // カプセル半径の約2倍
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
          // 踏ん張りの重みを2乗して強さ差を強調する（強い者はほとんど押されない）
          const wa2 = wa * wa, wb2 = wb * wb;
          const total = wa2 + wb2;
          a.pos.x -= nx * overlap * (wb2 / total); a.pos.z -= nz * overlap * (wb2 / total);
          b.pos.x += nx * overlap * (wa2 / total); b.pos.z += nz * overlap * (wa2 / total);

          // 空中での衝突: 強い体が相手を弾き飛ばす
          if (a.airborne && b.airborne) {
            const diff = rate(a.attr.balance) - rate(b.attr.balance);
            const knock = Math.abs(diff) * 0.6;
            if (diff > 0) { b.pos.x += nx * knock; b.pos.z += nz * knock; }
            else { a.pos.x -= nx * knock; a.pos.z -= nz * knock; }
          }
        }
      }
    }
    // 全員をコート内に保つ。ただし subs/pause/finale 中はクランプしない
    // （スローイン・交代・引き上げで選手が正当にコート外へ出る）。
    if (game.ballMode === "subs" || game.ballMode === "pause"
        || game.ballMode === "finale") return;
    // スローインする者／パサーはコート外に立つのでクランプ対象から除く。
    const skip = game.ballMode === "inbound" ? game.handler
      : game.ballMode === "pass" ? game.passer : null;
    for (const p of game.players) if (p !== skip) game.clampCourt(p.pos);
  }

  // 衝突時に選手がどれだけ踏ん張るか（高いほど押しが強い）。ボディバランスが効く。
export function holdWeight(game: Game, p: Player): number {
    let w = 0.5 + rate(p.attr.balance) * 0.78;                // ~0.6（弱い）.. ~1.28（強い）
    if (p === game.handler) {
      w += 0.5 + (p.has("post") ? 0.3 : 0);                   // ボールを守る／ポストアップする
      if (p.keepShieldT > 0) w += 1.3;                        // 踏ん張るキーパー: 広いスタンスで動かせない
    }
    else if (p.screening) w += 0.6;                           // セットしたスクリーンはしっかり踏ん張る
    else if (p.team === 1 - game.possession) w += 0.25;       // 守備者は位置を保つ
    return w;
  }
