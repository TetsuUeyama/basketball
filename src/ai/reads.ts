// 守備プレッシャー/トラップの状況判断（読み取り）。ダブルチーム/タイトトラップの
// 検出と、トラップされたハンドラーの救済役・逃がし所の算出。純粋な読み取り関数。
import { Vector3 } from "@babylonjs/core";
import { Player } from "../objects/player/player";
import { COURT, INBOUNDS_INSET } from "../config";
import { clamp, dist2D } from "../util";
import type { Game } from "../game";

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
