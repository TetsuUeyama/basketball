// 守備プレッシャー/トラップの状況判断（読み取り）。ダブルチーム/タイトトラップの
// 検出と、トラップされたハンドラーの救済役・逃がし所の算出。方式A: game を受け取る
// 純粋な読み取り関数。passing/offense/offball が game 経由で使う。game.ts から分離
// （workPlan.md の cognition 層 / [[game-split-optionb]] 参照）。
import { Vector3 } from "@babylonjs/core";
import { Player } from "../player";
import { COURT } from "../config";
import { clamp, dist2D } from "../util";
import type { Game } from "../game";

// 明らかに上位の得点オプションで、オープンで、そこそこ安全なパスで届く味方 —
// 「エースへ回す」読み。
// 2人以上の守備者が 2.0m 以内に寄る — 本物のダブルチーム。トラップされた選手へ
// 出すのは、攻撃側が逃れようとしているトラップを再開するだけ。
export function doubleTeamed(game: Game, p: Player): boolean {
  let n = 0;
  for (const d of game.teamPlayers(1 - p.team)) if (dist2D(d.pos, p.pos) < 2.0) { if (++n >= 2) return true; }
  return false;
}

// 本物のタイトなトラップ(2守備者が密着、≤1.7m) — doubleTeamed() の 2.0m
// 「ここへ出すな」ヒューリスティックよりずっと厳格。後者は密集したハーフコートでは
// 単なる混雑(オンボールの選手+ヘルプ守備者)。トラップ救済を発動するために使い、
// サポート役が本物のトラップの時だけハンドラーを助ける — ヘルパーが近づく度では
// ない(それだとフロアのスペーシングが壊れる)。
export function tightlyTrapped(game: Game, p: Player): boolean {
  let n = 0;
  for (const d of game.teamPlayers(1 - p.team)) if (dist2D(d.pos, p.pos) < 1.7) { if (++n >= 2) return true; }
  return false;
}

// トラップ救済 — スペーシングを崩してトラップされたボールハンドラーに安全で近い
// 逃がし所を与える唯一の味方。自身がトラップされていない最良の近くのプレイメーカー
// が選ばれるので、(ポストのビッグでなく)ガードが助けに落ちてくる。
// 毎フレーム再計算。位置が保たれる間は安定。該当者がいなければ null。
export function trapReliever(game: Game, team: number): Player | null {
  const h = game.handler;
  if (!h) return null;
  let best: Player | null = null, bestScore = -Infinity;
  for (const p of game.teamPlayers(team)) {
    if (p === h || p.rooted || p.screening) continue;
    if (doubleTeamed(game, p) || p.trappedT > 0) continue;   // 別のトラップされた選手は送らない
    const dd = dist2D(p.pos, h.pos);
    if (dd > 11) continue;                                   // 逃がし所になるには遠すぎる
    const score = p.playmaking * 2.5 - dd * 0.55;           // 近くのボールハンドラーが理想
    if (score > bestScore) { bestScore = score; best = p; }
  }
  return best;
}

// 救済役がフラッシュする先: 2人のトラッパーから離れた側のオープンな床、
// ハンドラーから短く安全なパス、受けやすい角度のため中央寄りに寄せる —
// そしてフロントコート/インバウンズ内に保つ。
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
  sx = clamp(sx, -(COURT.halfW - 1), COURT.halfW - 1);
  sz = clamp(sz, -(COURT.halfL - 1), COURT.halfL - 1);
  if (game.frontT) {                                        // ハーフウェイを越えて下がらない
    const s = game.attackSign(h.team);
    if (sz * s < 1.0) sz = 1.0 * s;
  }
  return new Vector3(sx, 0, sz);
}
