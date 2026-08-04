/**
 * player — 公開 API まとめ。
 *
 *   import { STANDARD_BONES, MIXAMO, validateBoneMapping } from '<このフォルダ>/index';
 *
 * ボーン定義とモーションの純ロジックは Babylon 非依存。
 * `appearance.ts` だけ Babylon の型に依存する（型契約のみ、実体なし）。
 * スケルトンの実体化（glTF ロードとボーン結線）は未着手 — README 参照。
 */
export * from "./standardSkeleton";
export * from "./boneMapping";
export * from "./humanRig";
export * from "./restPose";
// 層2の実体化（rig.ts）と層3のボクセル（voxel/）は Babylon を**値として**使うので、
// ここからは再エクスポートしない。必要な側が直接 import する:
//   import { buildRig, adoptRig } from '<このフォルダ>/rig';
//   import { buildPartMesh } from '<このフォルダ>/voxel/voxelBody';
export { MIXAMO, MIXAMO_NO_PREFIX, UNITY_HUMANOID, sportsAvatar3, PRESETS, guessPreset } from "./presets";
export type {
  SkeletonHandle, AppearanceHandle, AppearanceProvider,
} from "./appearance";
export { AppearanceSwitcher } from "./appearance";
