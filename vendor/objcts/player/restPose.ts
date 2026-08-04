/**
 * restPose — 標準ボーン名で表した「静止姿勢」。Babylon 非依存。
 *
 * 層2（スケルトンの実体化）の入力になる。位置はワールド座標（原点は足元、Y が上）。
 * どのモデルから採るかは呼び出し側の自由で、既存プロジェクトの寸法をそのまま渡せば
 * 見た目を変えずに名前だけ標準化できる。
 *
 * ⚠️ 利き手系を必ず宣言すること。「forward = +Z」を保ったまま右手系と左手系を行き来すると
 * **X が反転する**（右手系では左手が +X、左手系では左手が -X）。実測値:
 *   Mixamo ybot.glb（右手系・glTF）… LeftHand x = +0.738 / forward +Z
 *   basketball-sim（左手系・Babylon既定）… armPivotL x = -0.28 / forward +Z
 * どちらも自己矛盾は無く、違いは利き手系だけ。`toHandedness` で揃える。
 */
import {
  STANDARD_BONES, STANDARD_PARENTS, REQUIRED_BONES, nearestPresentParent,
  type StandardBoneName,
} from "./standardSkeleton";
import type { BoneMapping } from "./boneMapping";

export type Vec3Tuple = readonly [number, number, number];
export type Handedness = "left" | "right";

export interface RestPose {
  /** positions がどちらの利き手系で測られたか。forward は常に +Z、up は +Y。 */
  handedness: Handedness;
  /** 身長(m)。分かっていれば入れる（scaleToHeight で使う）。 */
  height?: number;
  /** 標準ボーン名 → ワールド位置。足りないボーンは省略してよい。 */
  positions: Partial<Record<StandardBoneName, Vec3Tuple>>;
}

const sub = (a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a: Vec3Tuple): number => Math.hypot(a[0], a[1], a[2]);

/**
 * 実リグのボーン名→ワールド位置の表から RestPose を作る。
 * `mapping` は presets.ts の MIXAMO などを渡す（標準名への読み替えに使う）。
 */
export function restPoseFrom(
  sourcePositions: Readonly<Record<string, Vec3Tuple>>,
  mapping: BoneMapping,
  handedness: Handedness,
  height?: number,
): RestPose {
  const positions: Partial<Record<StandardBoneName, Vec3Tuple>> = {};
  for (const [std, src] of Object.entries(mapping.bones)) {
    if (!src) continue;
    const p = sourcePositions[src];
    if (p) positions[std as StandardBoneName] = [p[0], p[1], p[2]];
  }
  return { handedness, height, positions };
}

/** 利き手系を揃える。forward(+Z) と up(+Y) は保ち、X だけ反転する。 */
export function toHandedness(rest: RestPose, want: Handedness): RestPose {
  if (rest.handedness === want) return rest;
  const positions: Partial<Record<StandardBoneName, Vec3Tuple>> = {};
  for (const [k, v] of Object.entries(rest.positions)) {
    if (v) positions[k as StandardBoneName] = [-v[0], v[1], v[2]];
  }
  return { handedness: want, height: rest.height, positions };
}

/** 必須ボーンが揃っているかを確かめる。 */
export function validateRestPose(rest: RestPose): {
  ok: boolean; missing: StandardBoneName[]; present: StandardBoneName[];
} {
  const present = STANDARD_BONES.filter((b) => rest.positions[b]);
  const missing = REQUIRED_BONES.filter((b) => !rest.positions[b]);
  return { ok: missing.length === 0, missing, present };
}

/**
 * 軸ごとに違う倍率で拡大する（原点＝足元を保つ）。
 * 身長（Y）と体の幅（X/Z）を別々に効かせたいときに使う。
 * height は Y の倍率で更新する。
 */
export function scaleRestPoseXYZ(rest: RestPose, kx: number, ky: number, kz: number): RestPose {
  const positions: Partial<Record<StandardBoneName, Vec3Tuple>> = {};
  for (const [k, v] of Object.entries(rest.positions)) {
    if (v) positions[k as StandardBoneName] = [v[0] * kx, v[1] * ky, v[2] * kz];
  }
  return {
    handedness: rest.handedness,
    height: rest.height === undefined ? undefined : rest.height * ky,
    positions,
  };
}

/** 全体を等倍する（原点＝足元を保つ）。 */
export function scaleRestPose(rest: RestPose, factor: number): RestPose {
  return scaleRestPoseXYZ(rest, factor, factor, factor);
}

/** 目標身長に合わせて等倍する。rest.height が無ければ何もしない。 */
export function scaleToHeight(rest: RestPose, targetHeight: number): RestPose {
  if (!rest.height) return rest;
  return scaleRestPose(rest, targetHeight / rest.height);
}

/**
 * 親からの相対位置（＝ノードの position に入れる値）。
 * 途中のボーンが欠けているリグでは、実在する最も近い祖先からの相対にする。
 */
export function localOffsets(rest: RestPose): Partial<Record<StandardBoneName, Vec3Tuple>> {
  const present = new Set(STANDARD_BONES.filter((b) => rest.positions[b]));
  const out: Partial<Record<StandardBoneName, Vec3Tuple>> = {};
  for (const b of present) {
    const p = rest.positions[b]!;
    const parent = nearestPresentParent(b, present);
    const pp = parent ? rest.positions[parent] : undefined;
    out[b] = pp ? sub(p, pp) : [p[0], p[1], p[2]];
  }
  return out;
}

/**
 * 各ボーンの静止時の向き（親→自分）。単位ベクトル。
 * 「腕は -Y に垂れている」等をコードに焼き込まないために、`quatFromTo` の第1引数に使う。
 * 末端で親が無い場合や長さ0の場合は入れない。
 */
export function restDirections(rest: RestPose): Partial<Record<StandardBoneName, Vec3Tuple>> {
  const present = new Set(STANDARD_BONES.filter((b) => rest.positions[b]));
  const out: Partial<Record<StandardBoneName, Vec3Tuple>> = {};
  for (const b of present) {
    const parent = nearestPresentParent(b, present);
    if (!parent) continue;
    const d = sub(rest.positions[b]!, rest.positions[parent]!);
    const l = len(d);
    if (l < 1e-9) continue;
    out[parent] = [d[0] / l, d[1] / l, d[2] / l];   // 親ボーンが向いている先
  }
  return out;
}

/** 親子関係のうち、この静止姿勢に実在するものだけを根に近い順で返す。 */
export function boneOrder(rest: RestPose): StandardBoneName[] {
  const present = new Set(STANDARD_BONES.filter((b) => rest.positions[b]));
  const depth = (b: StandardBoneName): number => {
    let d = 0;
    let p = STANDARD_PARENTS[b];
    while (p) { d++; p = STANDARD_PARENTS[p]; }
    return d;
  };
  return [...present].sort((a, b) => depth(a) - depth(b));
}
