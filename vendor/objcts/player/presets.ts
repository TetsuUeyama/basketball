/**
 * presets — 既知リグの標準名マッピング。
 *
 * 出典: battle-game `src/fighting/avatar/presets/*.json`（実プロジェクトで使用中の実データ）。
 * JSON ではなく TS の const で持つ（resolveJsonModule の設定に依存させないため）。
 */
import type { BoneMapping } from "./boneMapping";

/** Mixamo（"mixamorig:" 接頭辞つき）。指まで対応。 */
export const MIXAMO: BoneMapping = {
  id: "mixamo",
  rigType: "mixamo",
  bones: {
    Hips: "mixamorig:Hips",
    Spine: "mixamorig:Spine",
    Chest: "mixamorig:Spine1",
    UpperChest: "mixamorig:Spine2",
    Neck: "mixamorig:Neck",
    Head: "mixamorig:Head",

    LeftShoulder: "mixamorig:LeftShoulder",
    LeftUpperArm: "mixamorig:LeftArm",
    LeftLowerArm: "mixamorig:LeftForeArm",
    LeftHand: "mixamorig:LeftHand",

    RightShoulder: "mixamorig:RightShoulder",
    RightUpperArm: "mixamorig:RightArm",
    RightLowerArm: "mixamorig:RightForeArm",
    RightHand: "mixamorig:RightHand",

    LeftUpperLeg: "mixamorig:LeftUpLeg",
    LeftLowerLeg: "mixamorig:LeftLeg",
    LeftFoot: "mixamorig:LeftFoot",
    LeftToes: "mixamorig:LeftToeBase",

    RightUpperLeg: "mixamorig:RightUpLeg",
    RightLowerLeg: "mixamorig:RightLeg",
    RightFoot: "mixamorig:RightFoot",
    RightToes: "mixamorig:RightToeBase",

    LeftThumbProximal: "mixamorig:LeftHandThumb1",
    LeftThumbIntermediate: "mixamorig:LeftHandThumb2",
    LeftThumbDistal: "mixamorig:LeftHandThumb3",
    LeftIndexProximal: "mixamorig:LeftHandIndex1",
    LeftIndexIntermediate: "mixamorig:LeftHandIndex2",
    LeftIndexDistal: "mixamorig:LeftHandIndex3",
    LeftMiddleProximal: "mixamorig:LeftHandMiddle1",
    LeftMiddleIntermediate: "mixamorig:LeftHandMiddle2",
    LeftMiddleDistal: "mixamorig:LeftHandMiddle3",
    LeftRingProximal: "mixamorig:LeftHandRing1",
    LeftRingIntermediate: "mixamorig:LeftHandRing2",
    LeftRingDistal: "mixamorig:LeftHandRing3",
    LeftLittleProximal: "mixamorig:LeftHandPinky1",
    LeftLittleIntermediate: "mixamorig:LeftHandPinky2",
    LeftLittleDistal: "mixamorig:LeftHandPinky3",

    RightThumbProximal: "mixamorig:RightHandThumb1",
    RightThumbIntermediate: "mixamorig:RightHandThumb2",
    RightThumbDistal: "mixamorig:RightHandThumb3",
    RightIndexProximal: "mixamorig:RightHandIndex1",
    RightIndexIntermediate: "mixamorig:RightHandIndex2",
    RightIndexDistal: "mixamorig:RightHandIndex3",
    RightMiddleProximal: "mixamorig:RightHandMiddle1",
    RightMiddleIntermediate: "mixamorig:RightHandMiddle2",
    RightMiddleDistal: "mixamorig:RightHandMiddle3",
    RightRingProximal: "mixamorig:RightHandRing1",
    RightRingIntermediate: "mixamorig:RightHandRing2",
    RightRingDistal: "mixamorig:RightHandRing3",
    RightLittleProximal: "mixamorig:RightHandPinky1",
    RightLittleIntermediate: "mixamorig:RightHandPinky2",
    RightLittleDistal: "mixamorig:RightHandPinky3",
  },
};

/** 接頭辞なしの Mixamo（glTF 書き出しで "mixamorig:" が落ちた場合）。 */
export const MIXAMO_NO_PREFIX: BoneMapping = {
  id: "mixamo-noprefix",
  rigType: "mixamo",
  bones: Object.fromEntries(
    Object.entries(MIXAMO.bones).map(([std, src]) => [std, (src as string).replace(/^mixamorig:/, "")]),
  ) as BoneMapping["bones"],
};

/** 標準名がそのままボーン名になっているリグ（恒等）。 */
export const UNITY_HUMANOID: BoneMapping = {
  id: "unity-humanoid",
  rigType: "unity-humanoid",
  bones: {
    Hips: "Hips",
    Spine: "Spine",
    Chest: "Chest",
    UpperChest: "UpperChest",
    Neck: "Neck",
    Head: "Head",

    LeftShoulder: "LeftShoulder",
    LeftUpperArm: "LeftUpperArm",
    LeftLowerArm: "LeftLowerArm",
    LeftHand: "LeftHand",

    RightShoulder: "RightShoulder",
    RightUpperArm: "RightUpperArm",
    RightLowerArm: "RightLowerArm",
    RightHand: "RightHand",

    LeftUpperLeg: "LeftUpperLeg",
    LeftLowerLeg: "LeftLowerLeg",
    LeftFoot: "LeftFoot",
    LeftToes: "LeftToes",

    RightUpperLeg: "RightUpperLeg",
    RightLowerLeg: "RightLowerLeg",
    RightFoot: "RightFoot",
    RightToes: "RightToes",

    LeftEye: "LeftEye",
    RightEye: "RightEye",
    Jaw: "Jaw",
  },
};

/**
 * SportsAvatar 3（Maya リグ）。接頭辞を除くと Mixamo 命名そのもの。
 * リグ内に Bind_ / AnimData_ / FK_ / IK_ / IK_Dummy_ の並行チェーンがあるため、
 * どれを使うかを prefix で指定する。
 *
 * 実測: `SportsAvatar_03_Rig.ma` の Bind_ チェーン66本に対し、標準ボーン52本が解決し
 * 必須欠落0。未対応14本は Root と末端(Toe_End / HeadTop_End / 各指の第4関節)のみ。
 * ⚠️ FBX→glTF 変換後もこの接頭辞が残るかは未確認。実ファイルで要検証。
 */
export function sportsAvatar3(prefix = "Bind_"): BoneMapping {
  return {
    id: `sportsavatar3-${prefix.replace(/_$/, "").toLowerCase()}`,
    rigType: "sportsavatar3",
    bones: Object.fromEntries(
      Object.entries(MIXAMO.bones).map(([std, src]) => [
        std,
        (src as string).replace(/^mixamorig:/, prefix),
      ]),
    ) as BoneMapping["bones"],
  };
}

export const PRESETS: readonly BoneMapping[] = [MIXAMO, MIXAMO_NO_PREFIX, UNITY_HUMANOID];

/**
 * 実在するボーン名の集合に最も多く一致するプリセットを選ぶ。
 * ロードしたモデルのリグ種別が分からないときの当たり付けに使う（**推測なので要検証**）。
 */
export function guessPreset(
  presentSourceNames: Iterable<string>,
  candidates: readonly BoneMapping[] = PRESETS,
): { mapping: BoneMapping; hits: number } | null {
  const present = new Set(presentSourceNames);
  let best: { mapping: BoneMapping; hits: number } | null = null;
  for (const m of candidates) {
    let hits = 0;
    for (const src of Object.values(m.bones)) if (src && present.has(src)) hits++;
    if (!best || hits > best.hits) best = { mapping: m, hits };
  }
  return best && best.hits > 0 ? best : null;
}
