/**
 * humanRig — 関節ルールとモーションを組むための純ロジック。Babylon 非依存。
 *
 * 方針: ボーンの静止姿勢での向きをモデルから読み取り、**現在の向きと目標の向きの
 * 差分**から回転を作る。特定のリグ規約や「腕は -Y に垂れている」といった前提を
 * コードに焼き込まない。ボーン名は standardSkeleton.ts の標準名を使う。
 *
 * 座標系: 右手系・Y が鉛直上向き。
 */
import type { StandardBoneName } from "./standardSkeleton";

export interface Vec3 { x: number; y: number; z: number; }
export interface Quat { x: number; y: number; z: number; w: number; }

// --- 関節ルール --------------------------------------------------------------
// 可動域(rad)と最大回転速度(rad/s)。アニメはこの範囲・速度の中でモーションを作る。
// 出典: basketball-sim `src/animation/basic/joints.ts` の調整値（人体計測ではない）。

export interface Hinge { axis: "x" | "y" | "z"; min: number; max: number; speed: number; }

/** 概念ごとの関節ルール。 */
export const JOINT_RULES = {
  twist:  { axis: "y", min: -1.15, max: 1.15, speed: 10 },   // 胴のひねり
  look:   { axis: "y", min: -0.95, max: 0.95, speed: 11 },   // 首・頭の向き
  elbow:  { axis: "x", min: -2.8, max: 2.8, speed: 14 },
  hip:    { axis: "x", min: -1.6, max: 1.6, speed: 12 },
  knee:   { axis: "x", min: -1.7, max: 1.7, speed: 14 },
  ankle:  { axis: "x", min: -0.8, max: 0.8, speed: 22 },
} satisfies Record<string, Hinge>;

/** 標準ボーン → 関節ルール。表に無いボーンは制限なしとして扱う。 */
export const BONE_JOINTS: Partial<Record<StandardBoneName, Hinge>> = {
  Chest: JOINT_RULES.twist,
  UpperChest: JOINT_RULES.twist,
  Neck: JOINT_RULES.look,
  Head: JOINT_RULES.look,
  LeftLowerArm: JOINT_RULES.elbow,
  RightLowerArm: JOINT_RULES.elbow,
  LeftUpperLeg: JOINT_RULES.hip,
  RightUpperLeg: JOINT_RULES.hip,
  LeftLowerLeg: JOINT_RULES.knee,
  RightLowerLeg: JOINT_RULES.knee,
  LeftFoot: JOINT_RULES.ankle,
  RightFoot: JOINT_RULES.ankle,
};

/** 瞬間切替（スナップ）は禁止。速度指定が無い呼び出しはこの既定レートでイーズする。
 *  値は指数イーズの収束速度(1/s)。10 ≈ 大きな振りでも到達に約0.3秒。 */
export const MOVE_RATE = {
  arm: 10,     // 肩の向け直し・肘の曲げ
  reach: 30,   // ボールへ手を伸ばす/掴む/弾く
  leg: 12,     // 脚の振り
  spine: 8,    // 胴のひねり
};

export function clampHinge(j: Hinge, v: number): number {
  return v < j.min ? j.min : v > j.max ? j.max : v;
}

/** 指数イーズ。dt に依存せず一定割合で target へ近づく。rate は収束速度(1/s)。 */
export function expEase(cur: number, target: number, rate: number, dt: number): number {
  return cur + (target - cur) * (1 - Math.exp(-rate * dt));
}

/** 関節を目標角へ、可動域内で最大 speed*dt だけ回した値を返す（レート制限）。 */
export function rotateToward(cur: number, j: Hinge, target: number, dt: number): number {
  const t = clampHinge(j, target);
  const step = j.speed * dt;
  const d = t - cur;
  return cur + (d < -step ? -step : d > step ? step : d);
}

// --- ベクトル / クォータニオン ------------------------------------------------

export function normalize(v: Vec3): Vec3 {
  const l = Math.hypot(v.x, v.y, v.z);
  return l < 1e-9 ? { x: 0, y: 0, z: 0 } : { x: v.x / l, y: v.y / l, z: v.z / l };
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export const IDENTITY_QUAT: Quat = { x: 0, y: 0, z: 0, w: 1 };

export function quatNormalize(q: Quat): Quat {
  const l = Math.hypot(q.x, q.y, q.z, q.w);
  return l < 1e-9 ? { ...IDENTITY_QUAT } : { x: q.x / l, y: q.y / l, z: q.z / l, w: q.w / l };
}

export function quatFromAxisAngle(axis: Vec3, angle: number): Quat {
  const a = normalize(axis);
  const s = Math.sin(angle / 2);
  return { x: a.x * s, y: a.y * s, z: a.z * s, w: Math.cos(angle / 2) };
}

export function quatMul(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

export function quatRotate(q: Quat, v: Vec3): Vec3 {
  const cx = q.y * v.z - q.z * v.y;
  const cy = q.z * v.x - q.x * v.z;
  const cz = q.x * v.y - q.y * v.x;
  const ccx = q.y * cz - q.z * cy;
  const ccy = q.z * cx - q.x * cz;
  const ccz = q.x * cy - q.y * cx;
  return {
    x: v.x + 2 * (q.w * cx + ccx),
    y: v.y + 2 * (q.w * cy + ccy),
    z: v.z + 2 * (q.w * cz + ccz),
  };
}

export function quatSlerp(a: Quat, b: Quat, t: number): Quat {
  let d = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  let bx = b.x, by = b.y, bz = b.z, bw = b.w;
  if (d < 0) { d = -d; bx = -bx; by = -by; bz = -bz; bw = -bw; }   // 近い側の弧を通る
  if (d > 0.9995) {
    return quatNormalize({
      x: a.x + (bx - a.x) * t, y: a.y + (by - a.y) * t,
      z: a.z + (bz - a.z) * t, w: a.w + (bw - a.w) * t,
    });
  }
  const th = Math.acos(d);
  const s = Math.sin(th);
  const k0 = Math.sin((1 - t) * th) / s;
  const k1 = Math.sin(t * th) / s;
  return { x: a.x * k0 + bx * k1, y: a.y * k0 + by * k1, z: a.z * k0 + bz * k1, w: a.w * k0 + bw * k1 };
}

/**
 * 単位ベクトル from を to へ重ねる最短回転。
 *
 * **これがリグ非依存の要**。「腕は -Y に垂れている」といった前提を置かず、
 * from にモデルの静止姿勢から読み取った実際の向きを渡す。
 */
export function quatFromTo(from: Vec3, to: Vec3): Quat {
  const a = normalize(from);
  const b = normalize(to);
  const d = dot(a, b);
  if (d > 0.999999) return { ...IDENTITY_QUAT };
  if (d < -0.999999) {
    // 反平行: a に垂直な任意の軸で180°回す
    let axis = cross(a, { x: 1, y: 0, z: 0 });
    if (Math.hypot(axis.x, axis.y, axis.z) < 1e-6) axis = cross(a, { x: 0, y: 0, z: 1 });
    return quatFromAxisAngle(axis, Math.PI);
  }
  const c = cross(a, b);
  return quatNormalize({ x: c.x, y: c.y, z: c.z, w: 1 + d });
}

/** レート制限つきで現在の回転を目標へ近づける（指数イーズの slerp 版）。 */
export function easeQuat(cur: Quat, target: Quat, rate: number, dt: number): Quat {
  return quatSlerp(cur, target, 1 - Math.exp(-rate * dt));
}

// --- 向き --------------------------------------------------------------------

/** 角度を -π..π に畳む。 */
export function wrapAngle(a: number): number {
  let v = a;
  while (v > Math.PI) v -= Math.PI * 2;
  while (v < -Math.PI) v += Math.PI * 2;
  return v;
}

/**
 * 目標方向へ向くための「今の向きからの差分ヨー角」を返す。
 * 回転をハードコードせず、モデルの現在 forward と目標 forward の差だけを扱う。
 * currentForward はモデルから実測した値を渡すこと（+Z 前提を置かない）。
 */
export function yawDeltaTo(currentForward: Vec3, targetDir: Vec3): number {
  const cur = Math.atan2(currentForward.x, currentForward.z);
  const tgt = Math.atan2(targetDir.x, targetDir.z);
  return wrapAngle(tgt - cur);
}

// --- 歩行サイクル -------------------------------------------------------------

export interface GaitPose {
  LeftUpperLeg: number; LeftLowerLeg: number;
  RightUpperLeg: number; RightLowerLeg: number;
}

export interface GaitOptions {
  stride?: number;     // 1ストライドあたりの進行距離(m)
  swing?: number;      // 股関節の前後振り幅(rad)
  kneeBend?: number;   // 遊脚時の膝の最大曲げ(rad)
}

/**
 * 歩行/走行サイクルの位相を進める。位相は呼び出し側が保持する。
 *
 * ⚠️ basketball-sim の調整済みサイクルを移植したものではなく、汎用の素朴な実装。
 * 実モデルに当てて見た目を合わせる前提の出発点。
 */
export function advanceGait(phase: number, speed: number, dt: number, opts: GaitOptions = {}): number {
  const stride = opts.stride ?? 1.5;
  return phase + (speed / Math.max(0.01, stride)) * Math.PI * 2 * dt;
}

export function gaitPose(phase: number, speed: number, opts: GaitOptions = {}): GaitPose {
  const swing = (opts.swing ?? 0.55) * Math.min(1, speed / 4);
  const kneeBend = (opts.kneeBend ?? 1.1) * Math.min(1, speed / 4);
  // 膝は遊脚（脚が前へ出る半周）でだけ曲げる
  const flex = (p: number): number => Math.max(0, Math.sin(p - Math.PI * 0.5)) * kneeBend;
  return {
    LeftUpperLeg: clampHinge(JOINT_RULES.hip, Math.sin(phase) * swing),
    LeftLowerLeg: clampHinge(JOINT_RULES.knee, flex(phase)),
    RightUpperLeg: clampHinge(JOINT_RULES.hip, Math.sin(phase + Math.PI) * swing),
    RightLowerLeg: clampHinge(JOINT_RULES.knee, flex(phase + Math.PI)),
  };
}
