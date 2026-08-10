// パスの「効果」= レーン妨害・インターセプト確率の算出（判定ルール）。状態は変更
// しない純粋関数。`defenders` には from(パサー)の相手チームを渡す。
import { Player } from "../../objects/player/player";
import { LANE_W } from "../../config";
import type { PassStyle } from "../../config";
import { rate, clamp, dist2D, chance, segPerp } from "../../util";
import { passZip, passHeightAt, passReleaseY, reachFactor } from "../../eval";

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
  style: PassStyle = "chest",
): number {
  // 高さの帯: 守備者の位置でボールが手の届く高さを通らなければ触れない。
  // バウンズは手の下、オーバーヘッドは指先の上を抜ける。
  const reach = reachAt(from, block, style);
  if (reach <= 0) return 0;
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
  return clamp(p, 0, 0.9) * reach;
}

// 守備者が立っている地点でのボール高さから、その守備者の手の届き具合(0..1)を返す。
export function reachAt(
  from: Player, block: { def: Player; perp: number; t: number }, style: PassStyle,
): number {
  const y = passHeightAt(style, block.t, passReleaseY(style), 1.0);
  return reachFactor(block.def, y);
}

// 種別ごとのカット危険度。パサーが「どの投げ方なら通るか」を比べるために使う。
export function styleRisk(
  defenders: Player[], from: Player, to: Player, style: PassStyle,
): number {
  const block = laneBlock(defenders, from, to);
  let r = block ? interceptChance(from, to, block, style) : 0;
  const d = dist2D(from.pos, to.pos);
  if (d > 9) {   // ロングボールの滞空も加味する
    const fade = d > 12 ? clamp(1 - (d - 12) * 0.05, 0.85, 1) : 1;
    const flightT = d / (passZip(from) * fade);
    r += (longBallBest(defenders, from, to, flightT, d)?.p ?? 0) * 0.9;
  }
  return r;
}

// 最も通る投げ方を選ぶ。バウンズは床で減速するので近〜中距離のみ、
// オーバーヘッドは至近の圧下では持ち上げる間に叩かれるので候補から外す。
export function bestPassStyle(
  defenders: Player[], from: Player, to: Player,
): { style: PassStyle; risk: number } {
  const d = dist2D(from.pos, to.pos);
  let nearest = Infinity;
  for (const df of defenders) nearest = Math.min(nearest, dist2D(df.pos, from.pos));
  const cands: PassStyle[] = [];
  if (d > 9 && nearest > 1.4) cands.push("overhead");   // 遠投は頭上から(同リスクなら優先)
  cands.push("chest");
  if (d <= 9) cands.push("bounce");                     // 近〜中距離は床で手の下をくぐらせる
  let best: { style: PassStyle; risk: number } = { style: "chest", risk: Infinity };
  for (const s of cands) {
    const r = styleRisk(defenders, from, to, s);
    if (r < best.risk) best = { style: s, risk: r };
  }
  return best;
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
): { def: Player; at: number; reach: number } | null {
  const best = longBallBest(defenders, from, to, flightT, flightDist);
  // 走り込んで正面で捕るので、手は完全に届いている
  return best && chance(best.p) ? { def: best.def, at: best.at, reach: 1 } : null;
}

// 確率以前の幾何ルール: パスレーンのど真ん中に守備が立っていたらそのパスは通らない。
// ただしその投げ方が守備者の手の届く高さを外すなら(バウンズ/オーバーヘッド)通してよい。
export function laneVetoed(
  defenders: Player[], from: Player, to: Player, style: PassStyle = "chest",
): boolean {
  const block = laneBlock(defenders, from, to);
  return !!block && block.perp < 0.65 && reachAt(from, block, style) > 0;
}

// パサー自身の「このパスは通るか」の見積り。最も通る投げ方で評価する(バウンズで
// 手の下をくぐらせられるなら、そのリスクで判断する)。全パス判断がここを通る。
export function passRisk(defenders: Player[], from: Player, to: Player): number {
  return bestPassStyle(defenders, from, to).risk;
}

// リリース時に一度だけ、選んだパスが実際にカットされたか判定する。
export function evalInterception(
  defenders: Player[], from: Player, to: Player, passStyle: PassStyle,
): { def: Player; at: number; reach: number } | null {
  const block = laneBlock(defenders, from, to);
  if (!block) return null;
  const reach = reachAt(from, block, passStyle);
  if (reach <= 0) return null;   // 手の届く高さを外して通った
  let p = interceptChance(from, to, block, passStyle);
  // スルーパス: カッターへのフィードは彼だけが触れる場所に届く
  if (from.has("throughPass") && to.cutting) p *= 0.75;
  return chance(p) ? { def: block.def, at: block.t, reach } : null;
}
