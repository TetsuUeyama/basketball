// 手先を目標に正確に届かせる2ボーンIK（肩・肘の両クォータニオンで解く）と、
// FK(方向付け)/IK(接触)を距離で切り替えるハイブリッド reach。
// FKは aimArm（腕を目標方向へ向ける＝パスコースなど遠い目標）、IKは手先を目標へ乗せる
// （近いボール接触）。基本ムーバ(easeArm)経由なので腕の速度規則に従う。
import { TransformNode, Vector3, Quaternion } from "@babylonjs/core";
import { JOINT, MOVE_RATE } from "../basic/joints";
import { clamp, normAngle } from "../../util";
import { Player, aimDownTo } from "../../objects/player/player";

declare module "../../objects/player/player" {
  interface Player {
    reachIK(pivot: TransformNode, elbow: TransformNode, world: Vector3): boolean;
    reachBall(world: Vector3, both?: boolean): void;
  }
}

// ベクトル v をクォータニオン q で回す（v' = q·v·q*）。Vector3/数値のみで実装。
function rotQ(q: Quaternion, x: number, y: number, z: number): { x: number; y: number; z: number } {
  const { x: qx, y: qy, z: qz, w: qw } = q;
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  return {
    x: x + qw * tx + (qy * tz - qz * ty),
    y: y + qw * ty + (qz * tx - qx * tz),
    z: z + qw * tz + (qx * ty - qy * tx),
  };
}

// 2ボーンIKのコア（純粋関数）：肩ワールド(sx,sy,sz)・胴フレーム角 th・目標 world から、
// 手先を world に一致させる肩(root ローカル)・肘(pivot ローカル)のクォータニオンを解く。
// 届かない/近すぎは null。単体検証しやすいよう Player から独立。
export function armIKQuats(sx: number, sy: number, sz: number, th: number, world: Vector3,
    UP: number, FORE: number, outward = 0): { qUp: Quaternion; qElbow: Quaternion } | null {
    const c = Math.cos(th), s = Math.sin(th);
    // ワールド→root ローカルの reach ベクトル
    const wx = world.x - sx, wy = world.y - sy, wz = world.z - sz;
    const rx = c * wx - s * wz, ry = wy, rz = s * wx + c * wz;
    const d = Math.hypot(rx, ry, rz);
    if (d >= (UP + FORE) * 0.99 || d < 1e-3) return null;
    const ux = rx / d, uy = ry / d, uz = rz / d;
    // 肩角 α（上腕と reach 線の間）
    const alpha = Math.acos(Math.min(1, Math.max(-1, (UP * UP + d * d - FORE * FORE) / (2 * UP * d))));
    // 極ベクトル n：肘をどちらへ張り出すか。下(0,-1,0)＋外向き(outward·X)を reach に
    // 直交射影する。⚠️ 真下だけにすると胸の前でボールを持つとき肘が胴の中へ落ちる
    // （実測: 手先が狙いから 0.15m ずれ、表示側の逃がし補正と喧嘩した）。
    // 肘の振り分けは**手先の位置に影響しない**ので、外へ寄せても精度は落ちない。
    const px = outward, py = -1;
    const dDotU = px * ux + py * uy;                       // (outward,-1,0)·û
    let nx = px - dDotU * ux, ny = py - dDotU * uy, nz = 0 - dDotU * uz;
    let nl = Math.hypot(nx, ny, nz);
    if (nl < 1e-4) { nx = 1; ny = 0; nz = 0; nl = 1; }     // û が垂直 → 横へ逃がす
    nx /= nl; ny /= nl; nz /= nl;
    // 上腕方向 = cosα·û + sinα·n
    const ca = Math.cos(alpha), sa = Math.sin(alpha);
    const upx = ca * ux + sa * nx, upy = ca * uy + sa * ny, upz = ca * uz + sa * nz;
    // 前腕方向 = (reach − 肘) 正規化
    let fx = rx - upx * UP, fy = ry - upy * UP, fz = rz - upz * UP;
    const fl = Math.hypot(fx, fy, fz) || 1;
    fx /= fl; fy /= fl; fz /= fl;
    const qUp = aimDownTo(upx, upy, upz);
    const inv = qUp.conjugate();
    const fLocal = rotQ(inv, fx, fy, fz);                  // 前腕方向を pivot ローカルへ
    const qElbow = aimDownTo(fLocal.x, fLocal.y, fLocal.z);
    return { qUp, qElbow };
}

// 肩から届く範囲(UP+FORE)内なら手先を world に一致させる肩・肘の回転を適用し true。
// 範囲外は false（呼び出し側がFKにフォールバック）。計算は root ローカル系（aimArm と同じ）。
Player.prototype.reachIK = function(pivot: TransformNode, elbow: TransformNode, world: Vector3): boolean {
    // 肩ワールド座標（aimArm と同じ：胴のツイストを織り込む）
    const th = this.root.rotation.y + this.torsoTwist;
    const c = Math.cos(th), s = Math.sin(th);
    const px = pivot.position.x, py = pivot.position.y * this.root.scaling.y, pz = pivot.position.z;
    const sx = this.root.position.x + (c * px + s * pz);
    const sy = this.root.position.y + py;
    const sz = this.root.position.z + (-s * px + c * pz);
    // 体より後ろの目標へは手を伸ばさない: 肩からの reach のローカルZ(前後)成分が後ろ(+numberSide)
    // なら、目標を肩の前額面へ投影して真上・真横までに留める(背後への貫通を防ぐ)。
    let tgt = world;
    const rz = s * (world.x - sx) + c * (world.z - sz);
    if (rz * this.numberSide > 0) tgt = new Vector3(world.x - s * rz, world.y, world.z - c * rz);
    // 肘は外へ張り出す（ローカル +X = armPivotR 側）。tan(35°) ぶん外へ寄せると、
    // 胸の前でボールを持っても肘が胴に入らない。
    const outward = (pivot === this.armPivotR ? 1 : -1) * 0.70;
    const r = armIKQuats(sx, sy, sz, th, tgt, this.upperArmLen, this.foreArmLen, outward);
    if (!r) return false;
    this.easeArm(pivot, r.qUp);
    this.easeArm(elbow, r.qElbow);
    // 表示側の「胴から逃がす」補正を掛けない印（IKが既に胴を外しているので、
    // 後から押されると手先が狙いからずれる）。easeArm が毎回クリアする。
    if (pivot === this.armPivotR) this.ikR = true; else this.ikL = true;
    return true;
};

/**
 * 届かない目標への最大リーチ。**片手を目一杯**伸ばし、上体をひねって先行する肩を送る。
 * 反対の腕は目標へ向けず、軽く曲げて引く（カウンターウェイト）。
 *
 * ⚠️ 両手を棒のように伸ばすより片手の方が遠くへ届く（肩の送りぶん）。両手を揃えて
 * 真っ直ぐ突き出す形は、届かない距離ほど不自然に見える。
 */
// 正対からさらにひねって先行する肩を前へ出す量(rad)
const LEAD_TWIST = 0.30;
// 反対の腕: 上腕の前後の振り / 肘の曲げ / 前腕を体の内側へ振る量
const BACK_ARM_SWING = 0.30;
const BACK_ARM_BEND = 1.05;
const BACK_ARM_IN = 0.40;

function stretchOne(p: Player, world: Vector3): void {
  const right = p.dribbleWithRight(world);           // ボールに近い側が先行する
  const lead = right ? p.armPivotR : p.armPivotL;
  const leadElbow = right ? p.elbowR : p.elbowL;
  const back = right ? p.armPivotL : p.armPivotR;
  const backElbow = right ? p.elbowL : p.elbowR;
  // 上体をひねって**先行する肩を前へ送る**（可動域でキャップ）。真上のボールは向きが
  // 退化するので触らない。
  // ⚠️ 正対させるだけだと両肩が同じ位置に来る。正対から左右へ EXTRA ずらした2案のうち、
  //    先行する肩のワールド位置が目標に近い方を採る（左右の符号は numberSide と
  //    利き腕で変わるので、決め打ちせず実際の肩の位置で選ぶ）。
  const fx = world.x - p.pos.x, fz = world.z - p.pos.z;
  if (Math.abs(fx) + Math.abs(fz) > 0.05) {
    const base = normAngle(p.worldYawTo(world.x, world.z) - p.root.rotation.y);
    const px = lead.position.x, pz = lead.position.z;
    const shoulderGap = (tw: number): number => {
      const th = p.root.rotation.y + tw;
      const c = Math.cos(th), s = Math.sin(th);
      const sx = p.root.position.x + (c * px + s * pz);
      const sz = p.root.position.z + (-s * px + c * pz);
      return Math.hypot(world.x - sx, world.z - sz);
    };
    const a = clamp(base + LEAD_TWIST, JOINT.chestTwist.min, JOINT.chestTwist.max);
    const b = clamp(base - LEAD_TWIST, JOINT.chestTwist.min, JOINT.chestTwist.max);
    const twist = shoulderGap(a) <= shoulderGap(b) ? a : b;
    p.torsoTwist = twist;
    p.torsoNode.rotation.y = twist;
  }
  p.aimArm(lead, world);
  p.bendElbow(leadElbow, 0);                          // 先行する腕だけ伸ばし切る
  // 反対の腕: 肘を曲げて体へ寄せ、手のひらを胸の高さまで上げる（真下に垂らさない）
  p.easeArm(back, Quaternion.RotationAxis(new Vector3(1, 0, 0), BACK_ARM_SWING));
  p.bendElbow(backElbow, BACK_ARM_BEND);
  // 前腕を体の内側へ振る。+rot.z は -Y を +X へ振るので、右腕(+X側)は負、左腕は正。
  backElbow.rotation.z = (right ? 1 : -1) * BACK_ARM_IN;
}

/** ハイブリッド reach：手先が届く近い目標はIKで正確に乗せ、遠い目標は片手で伸ばし切る。
 *  守備の手をボール/パスコース点へ向けるのにも使う。 */
Player.prototype.reachBall = function(world: Vector3, both = false): void {
    this.armRateCap = MOVE_RATE.reach;   // ボールへ素早く手を出す（掴む/弾く）
    if (both) {
      const okR = this.reachIK(this.armPivotR, this.elbowR, world);
      const okL = this.reachIK(this.armPivotL, this.elbowL, world);
      // 片手でも届かないなら両手構えは成り立たない → 片手の最大リーチへ切り替える
      if (!okR || !okL) stretchOne(this, world);
      this.armRateCap = 0;
      return;
    }
    if (!this.reachIK(this.armPivotR, this.elbowR, world)) {
      stretchOne(this, world);
      this.armRateCap = 0;
      return;
    }
    this.easeArm(this.armPivotL, Quaternion.Identity());
    this.bendElbow(this.elbowL, 0.28);
    this.armRateCap = 0;
};
