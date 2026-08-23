// オフェンス側の状況読み取り（純粋な述語/探索）。守備プレッシャーとトラップの検出、
// 逃がし所、パス先候補、レーンの開き。ここから他のオフェンスモジュールを import しない。
import { Vector3 } from "@babylonjs/core";
import { Player } from "../../objects/player/player";
import { COURT, INBOUNDS_INSET, MAX_PASS } from "../../config";
import { clamp, dist2D, dirTo2D, segPerp } from "../../util";
import { laneVetoed, passRisk } from "../../move/reaction/pass-risk";
import type { Game } from "../../game";

// 2人以上の守備者が 2.0m 以内に寄る（ダブルチーム）か。
export function doubleTeamed(game: Game, p: Player): boolean {
  let n = 0;
  for (const d of game.teamPlayers(1 - p.team)) if (dist2D(d.pos, p.pos) < 2.0) { if (++n >= 2) return true; }
  return false;
}

// タイトなトラップ(2守備者が密着、≤1.7m)か。トラップ救済の発動に使う
// （doubleTeamed の 2.0m より厳格）。
export function tightlyTrapped(game: Game, p: Player): boolean {
  let n = 0;
  for (const d of game.teamPlayers(1 - p.team)) if (dist2D(d.pos, p.pos) < 1.7) { if (++n >= 2) return true; }
  return false;
}

// トラップ救済役 — トラップされたハンドラーに逃がし所を与える味方を1人選ぶ。
// 自身がトラップされていない最良の近くのプレイメーカー。該当者がいなければ null。
export function trapReliever(game: Game, team: number): Player | null {
  const h = game.handler;
  if (!h) return null;
  let best: Player | null = null, bestScore = -Infinity;
  for (const p of game.teamPlayers(team)) {
    if (p === h || p.rooted || p.screening || p.frontRunT > 0) continue;
    if (p.justPassedT > 0) continue;   // パス直後の選手はボール(トラップ)へ戻さない — 回避後に再度掛かるのを防ぐ
    if (doubleTeamed(game, p) || p.trappedT > 0) continue;   // トラップされた選手は送らない
    const dd = dist2D(p.pos, h.pos);
    if (dd > 11) continue;                                   // 遠すぎる
    const score = p.playmaking * 2.5 - dd * 0.55;           // 近くのプレイメーカーが理想
    if (score > bestScore) { bestScore = score; best = p; }
  }
  return best;
}

// 救済役がフラッシュする先: 2人のトラッパーから離れた側のオープンな床。
// 中央寄りに寄せ、フロントコート/インバウンズ内に保つ。
export function trapReliefSpot(game: Game, h: Player): Vector3 {
  const opps = game.teamPlayers(1 - h.team)
    .map((d) => ({ d, dd: dist2D(d.pos, h.pos) }))
    .sort((a, b) => a.dd - b.dd).slice(0, 2);
  let tx = 0, tz = 0;
  for (const o of opps) { tx += o.d.pos.x - h.pos.x; tz += o.d.pos.z - h.pos.z; }
  const tl = Math.hypot(tx, tz) || 1;
  tx /= tl; tz /= tl;                                        // 単位ベクトル: ハンドラー→トラップの重心
  const reach = 4.3;
  let sx = h.pos.x - tx * reach;
  let sz = h.pos.z - tz * reach;
  sx += (0 - sx) * 0.18;                                     // 中央寄りにバイアス
  sx = clamp(sx, -(COURT.halfW - INBOUNDS_INSET), COURT.halfW - INBOUNDS_INSET);
  sz = clamp(sz, -(COURT.halfL - INBOUNDS_INSET), COURT.halfL - INBOUNDS_INSET);
  if (game.frontT) {                                        // ハーフウェイより下がらない
    const s = game.attackSign(h.team);
    if (sz * s < 1.0) sz = 1.0 * s;
  }
  return new Vector3(sx, 0, sz);
}

  // より余裕のある側(−1 左 / +1 右) — 味方が少ない側。
export function openSide(game: Game, h: Player): number {
    let l = 0, r = 0;
    for (const p of game.teamPlayers(h.team)) {
      if (p === h) continue;
      if (p.pos.x < -0.5) l++; else if (p.pos.x > 0.5) r++;
    }
    return l <= r ? -1 : 1;
  }

  // 運び上げを支える最良のハンドラー候補: 自分以外の非ビッグの最良プレイメイカー(=ガード)。
export function supportHandler(game: Game, h: Player): Player | null {
    let best: Player | null = null, bs = -Infinity;
    for (const p of game.teamPlayers(h.team)) {
      if (p === h || game.isBig(p)) continue;
      if (p.playmaking > bs) { bs = p.playmaking; best = p; }
    }
    return best;
  }

  // まだ形成中のダブルチーム — 2人目がローテート中でまだ発動していない。
  // 近づいてくるヘルプ守備者を返す。トラップが無ければ null。
export function doubleTeamApproaching(game: Game, h: Player): Player | null {
    const opps = game.teamPlayers(1 - h.team);
    // まずオンボール守備者が実際に圧をかけていること
    let onD = Infinity;
    for (const d of opps) { const dd = dist2D(d.pos, h.pos); if (dd < onD) onD = dd; }
    if (onD > 2.6) return null;
    // ハンドラーへ向かって突っ込んでくる2人目 = 閉じるトラップ
    for (const d of opps) {
      const dx = h.pos.x - d.pos.x, dz = h.pos.z - d.pos.z;
      const dd = Math.hypot(dx, dz) || 1;
      if (dd <= onD + 0.05) continue;             // それはオンボール守備者本人
      if (dd < 1.9 || dd > 4.5) continue;         // 既にトラップ済み(<1.9) / 寄せるには遠すぎる
      const sp = Math.hypot(d.velX, d.velZ);
      if (sp < 0.7) continue;                     // 近くに立っているだけでなく動いていること
      const closing = (dx * d.velX + dz * d.velZ) / (dd * sp); // 1 = 真っ直ぐ彼へ全力疾走
      if (closing > 0.5) return d;
    }
    return null;
  }

export function betterOptionAvailable(game: Game, h: Player): Player | null {
    let best: Player | null = null;
    let bestPrio = h.offPriority + 0.1;          // 意味のあるほど良いオプションであること
    for (const p of game.teamPlayers(h.team)) {
      if (p === h || p.offPriority <= bestPrio) continue;
      if (p === game.assistFrom && game.assistTo === h && !p.cutting) continue; // ピンポン禁止
      if (dist2D(h.pos, p.pos) > MAX_PASS) continue;            // 射程外
      if (game.frontT && game.attackSign(h.team) * p.pos.z < 0.4) continue; // バックコート
      if (game.nearestDefenderDist(p) < 2.0) continue;          // 実際にはオープンでない
      if (doubleTeamed(game, p) || p.trappedT > 0) continue;      // (直近の)トラップへ決して戻さない
      if (p.justPassedT > 0) continue;                           // 彼は今手放した — ピンポン禁止
      if (laneVetoed(game.oppTeam(h), h, p) || passRisk(game.oppTeam(h), h, p) > 0.25) continue; // レーン無し
      bestPrio = p.offPriority;
      best = p;
    }
    return best;
  }

  // このハンドラーのために今スクリーンを掛けている味方（居なければ null）。
export function activeScreener(game: Game, h: Player): Player | null {
    for (const q of game.teamPlayers(h.team)) if (q !== h && q.screening) return q;
    return null;
  }

  // ピックを使いに行くべきか: 味方がスクリーン中で、まだ近づいていない（連携で寄せる）。
export function usingScreen(game: Game, h: Player): boolean {
    const scr = activeScreener(game, h);
    return !!scr && dist2D(h.pos, scr.pos) > 1.0;
  }

  // 前方約1.2m以内で、ドライブ経路に真っ直ぐ立つ守備者。彼らの体の接触が
  // ボールハンドラーを減速させる。
export function driveImpeder(game: Game, h: Player): Player | null {
    const { ux, uz } = dirTo2D(h.pos.x, h.pos.z, h.driveTarget.x, h.driveTarget.z);
    for (const d of game.teamPlayers(1 - h.team)) {
      const rx = d.pos.x - h.pos.x, rz = d.pos.z - h.pos.z;
      const along = rx * ux + rz * uz;       // ドライブに沿ってどれだけ前方か
      if (along < 0 || along > 1.2) continue;
      const perp = Math.abs(rx * -uz + rz * ux);
      if (perp < 0.7) return d;
    }
    return null;
  }

  // ハンドラーからリムへの経路に守備者がいなければ true。
export function laneClear(game: Game, h: Player, rimFloor: Vector3): boolean {
    for (const d of game.teamPlayers(1 - h.team)) {
      const { t, perp } = segPerp(h.pos.x, h.pos.z, rimFloor.x, rimFloor.z, d.pos.x, d.pos.z);
      if (t <= 0.05 || t >= 1) continue;             // ハンドラーとリムの間ではない
      if (perp < 1.1) return false;                  // レーン内に守備者
    }
    return true;
  }
