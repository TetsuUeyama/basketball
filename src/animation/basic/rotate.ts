// 関節ルール（JOINT）に従って回転を適用する共通ヘルパ。可動域クランプと速度の
// レート制限をここに集約し、各アニメはこれを通して関節を動かす。
import { TransformNode } from "@babylonjs/core";
import { clamp } from "../../util";
import { Joint } from "./joints";

/** 角度を関節の可動域にクランプして返す。 */
export function clampAngle(j: Joint, v: number): number {
  return clamp(v, j.min, j.max);
}

/** 関節を可動域にクランプして即座にセットする（レート制限なし）。 */
export function setJoint(node: TransformNode, j: Joint, v: number): void {
  node.rotation[j.axis] = clamp(v, j.min, j.max);
}

/** 関節を目標角へ、可動域内で最大 speed*dt だけ回す（レート制限）。 */
export function rotateToward(node: TransformNode, j: Joint, target: number, dt: number): void {
  const t = clamp(target, j.min, j.max);
  const cur = node.rotation[j.axis];
  const step = j.speed * dt;
  node.rotation[j.axis] = cur + clamp(t - cur, -step, step);
}
