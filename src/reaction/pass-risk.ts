// パスの「効果」= レーン妨害・インターセプト確率の算出（判定ルール）。状態は変更
// しない純粋関数。`defenders` には from(パサー)の相手チームを渡す。
import { Player } from "../objects/player/player";
import { LANE_W, PASS_SPEED } from "../config";
import { rate, clamp, dist2D, chance, segPerp } from "../util";

// パスレーンに最も入り込んでいる守備者（レーン中央付近、両端に寄っていない者）を返す。
export function laneBlock(
  defenders: Player[], from: Player, to: Player,
): { def: Player; perp: number; t: number } | null {
  let best: { def: Player; perp: number; t: number } | null = null;
  for (const d of defenders) {
    const { t, perp } = segPerp(from.pos.x, from.pos.z, to.pos.x, to.pos.z, d.pos.x, d.pos.z);
    if (t <= 0.12 || t >= 0.92) continue;             // パサー/受け手の真横
    if (perp > LANE_W) continue;                      // レーン外
    if (!best || perp < best.perp) best = { def: d, perp, t };
  }
  return best;
}

// レーンの最脅威守備者にパスがカットされる確率。守備がどれだけレーン中央に座るか、
// パス距離(遠いほど滞空)、守備のボールへの嗅覚(反応/守判断)、パサーの精度(P精度は
// 同じ隙間により細い窓を通す)、パス速度(P速度=速い球ほど跳びづらい)を合成。
export function interceptChance(
  from: Player, to: Player, block: { def: Player; perp: number; t: number },
): number {
  const d = dist2D(from.pos, to.pos);
  const inLane = 1 - block.perp / LANE_W;                       // 0 レーン端 .. 1 ど真ん中
  const distFactor = clamp(d / 11, 0.45, 1.25);
  const hawk = rate(block.def.attr.reaction) * 0.45 + rate(block.def.attr.defense) * 0.35
    + rate(block.def.attr.agility) * 0.2
    + (block.def.has("interceptor") ? 0.18 : 0);                // スライディング
  const skill = rate(from.attr.passAcc);
  const zip = 1.18 - rate(from.attr.passSpd) * 0.45;            // 速いパスは切りづらい
  const angle = from.has("outside") ? 0.8 : 1;                  // アウトサイド: 変な角度
  let p = inLane * (0.45 + hawk * 0.6) * distFactor * zip * angle - skill * 0.3;
  p += Math.max(0, d - 10) * 0.06;   // 遠投は滞空する — 誰でも跳べる
  return clamp(p, 0, 0.9);
}

// ロングボールの読み: ~9m 超のパスは滞空し、飛行経路上の点にボールより先に走り込める
// 守備者はカットのチャンスを持つ。スライディング持ちは早く抜け出す。
export function longBallBest(
  defenders: Player[], from: Player, to: Player, flightT: number, flightDist: number,
): { def: Player; at: number; p: number } | null {
  const hang = clamp((flightDist - 9) / 6, 0, 1);   // 9m→0, 15m→1
  let best: { def: Player; at: number; p: number } | null = null;
  for (const df of defenders) {
    const { t, perp } = segPerp(from.pos.x, from.pos.z, to.pos.x, to.pos.z, df.pos.x, df.pos.z);
    if (t <= 0.15 || t >= 0.88) continue;
    // ボールが自分の点を横切る前に稼げる距離（スライディング持ちは先手）
    const cover = df.runSpeed * 0.85 * (flightT * t) * (df.has("interceptor") ? 1.35 : 1);
    if (perp > cover + 0.4) continue;               // 単純に届かない
    let p = 0.35 + hang * 0.3 + rate(df.attr.reaction) * 0.2
      - rate(from.attr.passAcc) * 0.2;
    if (df.has("interceptor")) p += 0.2;
    p = clamp(p, 0.05, 0.85);
    if (!best || p > best.p) best = { def: df, at: t, p };
  }
  return best;
}

// ロングボールが実際に読まれてカットされたか（一度だけ抽選）。
export function longBallRead(
  defenders: Player[], from: Player, to: Player, flightT: number, flightDist: number,
): { def: Player; at: number } | null {
  const best = longBallBest(defenders, from, to, flightT, flightDist);
  return best && chance(best.p) ? { def: best.def, at: best.at } : null;
}

// 確率以前の幾何ルール: パスレーンのど真ん中に守備が立っていたらそのパスは通らない。
export function laneVetoed(defenders: Player[], from: Player, to: Player): boolean {
  const block = laneBlock(defenders, from, to);
  return !!block && block.perp < 0.65;
}

// パサー自身の「このパスは通るか」の見積り — 実際の飛行と同じ危険
// (レーン守備＋滞空＋ロングボールに走り込める者)を評価する。全パス判断がここを通る。
export function passRisk(defenders: Player[], from: Player, to: Player): number {
  const d = dist2D(from.pos, to.pos);
  const block = laneBlock(defenders, from, to);
  let r = block ? interceptChance(from, to, block) : 0;
  if (d > 9) {   // ロングボールの滞空も加味する
    const fade = d > 12 ? clamp(1 - (d - 12) * 0.05, 0.85, 1) : 1;
    const flightT = d / (PASS_SPEED * (0.6 + rate(from.attr.passSpd) * 0.95) * fade);
    r += (longBallBest(defenders, from, to, flightT, d)?.p ?? 0) * 0.9;
  }
  return r;
}

// リリース時に一度だけ、選んだパスが実際にカットされたか判定する。
export function evalInterception(
  defenders: Player[], from: Player, to: Player, passStyle: "chest" | "bounce" | "jump",
): { def: Player; at: number } | null {
  const block = laneBlock(defenders, from, to);
  if (!block) return null;
  let p = interceptChance(from, to, block);
  // スルーパス: カッターへのフィードは彼だけが触れる場所に届く
  if (from.has("throughPass") && to.cutting) p *= 0.75;
  // バウンド=手の下をくぐる / ジャンプ=頭上を越える — どちらもレーン守備の届く高さを外す
  if (passStyle === "bounce") p *= 0.45;
  else if (passStyle === "jump") p *= 0.6;
  return chance(p) ? { def: block.def, at: block.t } : null;
}
