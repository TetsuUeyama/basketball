// 選手同士の衝突解決（方式B: GameState 集約）。重なった選手を押し離す物理と、押し合い
// の重み(holdWeight: ボール保持者やパサーは踏ん張る)。毎フレーム updateLive から呼ぶ。
// 状態は Game に集約し各関数は第一引数 game を受け取る。
import { Player } from "../player";
import { clamp, dist2D, rand } from "../util";
import { rate } from "../attributes";
import type { Game } from "../game";

  // 体は重なれない: 衝突した2選手を押し離す。補正を「踏ん張り」の重みで分配するので、
  // 一方が他方をすり抜けるのでなく、位置取りの押し合いとして見える。毎フレーム、全ての
  // 移動の後に実行する。
export function resolveCollisions(game: Game, ): void {
    const MIN = 0.62; // カプセル半径の約2倍
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
          // 踏ん張りの重みを2乗して、本当の強さの差が出るようにする: 強い者はほとんど
          // 押されず、弱い者は押し戻される（そして強いポストプレイヤーは弱い守備者を
          // 後ろへ押し込む）
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
    // 全員をコート内に保つ — ただしスローインする者はアウトオブバウンズに立つので除く。
    // 交代／引き上げの入れ替え中、選手が正当にサイドラインを越えるときも除く。そして
    // デッドボールのポーズ中も（誰も動かず、クォーター休憩は全員をコート外のベンチに
    // 集めたまま保つ）
    if (game.ballMode === "subs" || game.ballMode === "pause"
        || game.ballMode === "finale") return;   // 敗者はベンチへ歩いて引き上げる
    // スローインする者は投げるためにアウトオブバウンズに立ち、投げたボールが飛ぶ間も
    // そこに留まる（フォロースルーが終わって初めてコート内へ踏み込む）— なので彼を
    // コート内へ引き戻さない。通常のコート内のパサーは影響を受けない。
    const skip = game.ballMode === "inbound" ? game.handler
      : game.ballMode === "pass" ? game.passer : null;
    for (const p of game.players) if (p !== skip) game.clampCourt(p.pos);
  }

  // 衝突時に選手がどれだけ踏ん張るか（高いほど押しが強い）。
  // ボディバランスが体の勝負を制する: 強いポストプレイヤーはマークを押し込み、
  // 押されにくい。弱い者は地面を明け渡す。
export function holdWeight(game: Game, p: Player): number {
    let w = 0.5 + rate(p.attr.balance) * 0.78;                // ~0.6（弱い）.. ~1.28（強い）
    if (p === game.handler) {
      w += 0.5 + (p.has("post") ? 0.3 : 0);                   // ボールを守る／ポストアップする
      if (p.keepShieldT > 0) w += 1.3;                        // 踏ん張るキーパー: トラップでも動かせない広いスタンス
    }
    else if (p.screening) w += 0.6;                           // セットしたスクリーンはしっかり踏ん張る
    else if (p.team === 1 - game.possession) w += 0.25;       // 守備者は位置を保つ
    return w;
  }
