/**
 * standardSkeleton — Unity Humanoid Avatar 準拠の標準スケルトン定義。
 *
 * Mixamo / 自作モデルなど命名の異なるリグは、この標準名へリマップしてから扱う。
 * **ボーンの定義のみでメッシュを持たない**。見た目は appearance.ts の
 * AppearanceProvider が後から与える（通常メッシュ / ボクセルを差し替え可能）。
 *
 * 出典: battle-game `src/fighting/avatar/StandardSkeleton.ts` から移植。
 */

export const STANDARD_BONES = [
  "Hips",
  "Spine",
  "Chest",
  "UpperChest",
  "Neck",
  "Head",

  "LeftShoulder",
  "LeftUpperArm",
  "LeftLowerArm",
  "LeftHand",

  "RightShoulder",
  "RightUpperArm",
  "RightLowerArm",
  "RightHand",

  "LeftUpperLeg",
  "LeftLowerLeg",
  "LeftFoot",
  "LeftToes",

  "RightUpperLeg",
  "RightLowerLeg",
  "RightFoot",
  "RightToes",

  "LeftEye",
  "RightEye",
  "Jaw",

  "LeftThumbProximal",
  "LeftThumbIntermediate",
  "LeftThumbDistal",
  "LeftIndexProximal",
  "LeftIndexIntermediate",
  "LeftIndexDistal",
  "LeftMiddleProximal",
  "LeftMiddleIntermediate",
  "LeftMiddleDistal",
  "LeftRingProximal",
  "LeftRingIntermediate",
  "LeftRingDistal",
  "LeftLittleProximal",
  "LeftLittleIntermediate",
  "LeftLittleDistal",

  "RightThumbProximal",
  "RightThumbIntermediate",
  "RightThumbDistal",
  "RightIndexProximal",
  "RightIndexIntermediate",
  "RightIndexDistal",
  "RightMiddleProximal",
  "RightMiddleIntermediate",
  "RightMiddleDistal",
  "RightRingProximal",
  "RightRingIntermediate",
  "RightRingDistal",
  "RightLittleProximal",
  "RightLittleIntermediate",
  "RightLittleDistal",
] as const;

export type StandardBoneName = (typeof STANDARD_BONES)[number];

export const STANDARD_BONE_SET: ReadonlySet<StandardBoneName> = new Set(STANDARD_BONES);

/** これが欠けていると人体として動かせない、という最小集合。 */
export const REQUIRED_BONES: readonly StandardBoneName[] = [
  "Hips",
  "Spine",
  "Head",
  "LeftUpperArm",
  "LeftLowerArm",
  "LeftHand",
  "RightUpperArm",
  "RightLowerArm",
  "RightHand",
  "LeftUpperLeg",
  "LeftLowerLeg",
  "LeftFoot",
  "RightUpperLeg",
  "RightLowerLeg",
  "RightFoot",
];

/**
 * 親ボーン関係。null はルート（= Hips の親）。
 * オプショナルなボーンが省略されたリグでは親が実在しないことがあるので、
 * 解決時は `nearestPresentParent` で祖先方向を辿ること。
 */
export const STANDARD_PARENTS: Record<StandardBoneName, StandardBoneName | null> = {
  Hips: null,
  Spine: "Hips",
  Chest: "Spine",
  UpperChest: "Chest",
  Neck: "UpperChest",
  Head: "Neck",

  LeftShoulder: "UpperChest",
  LeftUpperArm: "LeftShoulder",
  LeftLowerArm: "LeftUpperArm",
  LeftHand: "LeftLowerArm",

  RightShoulder: "UpperChest",
  RightUpperArm: "RightShoulder",
  RightLowerArm: "RightUpperArm",
  RightHand: "RightLowerArm",

  LeftUpperLeg: "Hips",
  LeftLowerLeg: "LeftUpperLeg",
  LeftFoot: "LeftLowerLeg",
  LeftToes: "LeftFoot",

  RightUpperLeg: "Hips",
  RightLowerLeg: "RightUpperLeg",
  RightFoot: "RightLowerLeg",
  RightToes: "RightFoot",

  LeftEye: "Head",
  RightEye: "Head",
  Jaw: "Head",

  LeftThumbProximal: "LeftHand",
  LeftThumbIntermediate: "LeftThumbProximal",
  LeftThumbDistal: "LeftThumbIntermediate",
  LeftIndexProximal: "LeftHand",
  LeftIndexIntermediate: "LeftIndexProximal",
  LeftIndexDistal: "LeftIndexIntermediate",
  LeftMiddleProximal: "LeftHand",
  LeftMiddleIntermediate: "LeftMiddleProximal",
  LeftMiddleDistal: "LeftMiddleIntermediate",
  LeftRingProximal: "LeftHand",
  LeftRingIntermediate: "LeftRingProximal",
  LeftRingDistal: "LeftRingIntermediate",
  LeftLittleProximal: "LeftHand",
  LeftLittleIntermediate: "LeftLittleProximal",
  LeftLittleDistal: "LeftLittleIntermediate",

  RightThumbProximal: "RightHand",
  RightThumbIntermediate: "RightThumbProximal",
  RightThumbDistal: "RightThumbIntermediate",
  RightIndexProximal: "RightHand",
  RightIndexIntermediate: "RightIndexProximal",
  RightIndexDistal: "RightIndexIntermediate",
  RightMiddleProximal: "RightHand",
  RightMiddleIntermediate: "RightMiddleProximal",
  RightMiddleDistal: "RightMiddleIntermediate",
  RightRingProximal: "RightHand",
  RightRingIntermediate: "RightRingProximal",
  RightRingDistal: "RightRingIntermediate",
  RightLittleProximal: "RightHand",
  RightLittleIntermediate: "RightLittleProximal",
  RightLittleDistal: "RightLittleIntermediate",
};

/** 左右の対。ミラーリングやスワップに使う。 */
export const MIRROR_PAIRS: readonly (readonly [StandardBoneName, StandardBoneName])[] =
  STANDARD_BONES
    .filter((b): b is StandardBoneName => b.startsWith("Left"))
    .map((l) => [l, ("Right" + l.slice(4)) as StandardBoneName] as const)
    .filter(([, r]) => STANDARD_BONE_SET.has(r));

/**
 * 実在するボーンだけを辿って最も近い祖先を返す。
 * present に含まれない親（省略された UpperChest など）を飛ばす。
 */
export function nearestPresentParent(
  bone: StandardBoneName,
  present: ReadonlySet<StandardBoneName>,
): StandardBoneName | null {
  let p = STANDARD_PARENTS[bone];
  while (p && !present.has(p)) p = STANDARD_PARENTS[p];
  return p;
}

/** bone から Hips までの祖先チェーン（自身は含まない、根に近い順）。 */
export function ancestorChain(bone: StandardBoneName): StandardBoneName[] {
  const out: StandardBoneName[] = [];
  let p = STANDARD_PARENTS[bone];
  while (p) { out.unshift(p); p = STANDARD_PARENTS[p]; }
  return out;
}
