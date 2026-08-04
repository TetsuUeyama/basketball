/**
 * rig — 層2: スケルトンの実体化。標準ボーン名で引ける TransformNode の骨組みを作る。
 *
 * メッシュは持たない。見た目は層3（`voxel/` など）が同じ標準名で取り付ける。
 * Babylon の `Skeleton`/`Bone` ではなく `TransformNode` で組むのは、剛体パーツを
 * parent するだけで済み、手続きアニメーションから直接回せるため。スキニングが要る
 * ようになったら、この `RigHandle` の裏を Skeleton 実装に差し替える。
 *
 * 利き手系は**シーンに合わせて自動で揃える**（`scene.useRightHandedSystem`）。
 * 渡す RestPose 側には測定時の利き手系を必ず宣言させる（restPose.ts 参照）。
 */
import { Scene, TransformNode, Vector3 } from "@babylonjs/core";
import { nearestPresentParent, REQUIRED_BONES, type StandardBoneName } from "./standardSkeleton";
import {
  type RestPose, type Vec3Tuple, boneOrder, localOffsets, restDirections, toHandedness, validateRestPose,
} from "./restPose";

export interface RigHandle {
  /** 骨組み全体の親。位置・向きはこれを動かす。 */
  readonly root: TransformNode;
  /** 標準ボーン名 → ノード。無ければ null。 */
  node(bone: StandardBoneName): TransformNode | null;
  /** この骨組みが持つ標準ボーン（根に近い順）。 */
  readonly bones: readonly StandardBoneName[];
  /** 静止時にそのボーンが向いている方向（単位ベクトル）。quatFromTo の第1引数に使う。 */
  restDirection(bone: StandardBoneName): Vector3 | null;
  /** 静止姿勢でのワールド位置（root がの原点にある前提の値）。 */
  restPosition(bone: StandardBoneName): Vector3 | null;
  dispose(): void;
}

/**
 * 既にあるノードに標準ボーン名を与えるだけの版（新しくノードを作らない）。
 *
 * 既存プロジェクトの移行用。ノードの位置も親子関係も一切触らないので、
 * **見た目は変わらない**。上位のアニメーションコードだけを標準名参照へ移せる。
 * 骨組みが humanoid として整っていなくてもよい（例: 胴や頭が原点のツイスト用ノードでも可）。
 *
 * 静止方向は、渡された時点の**実際のワールド位置**から親→子で求める。
 * したがって静止姿勢のまま（アニメーションを当てる前に）呼ぶこと。
 */
export function adoptRig(
  root: TransformNode,
  nodes: Partial<Record<StandardBoneName, TransformNode>>,
  opts: { allowMissing?: boolean } = {},
): RigHandle {
  const map = new Map<StandardBoneName, TransformNode>();
  for (const [k, n] of Object.entries(nodes)) if (n) map.set(k as StandardBoneName, n);

  const missing = REQUIRED_BONES.filter((b) => !map.has(b));
  if (missing.length && !opts.allowMissing) {
    throw new Error(`adoptRig: 必須ボーンが足りない: ${missing.join(", ")}`);
  }

  // 実ノードのワールド位置から静止姿勢を composeし、そこから静止方向を導く
  const positions: Partial<Record<StandardBoneName, Vec3Tuple>> = {};
  for (const [b, n] of map) {
    n.computeWorldMatrix(true);
    const p = n.getAbsolutePosition();
    positions[b] = [p.x, p.y, p.z];
  }
  const rest: RestPose = { handedness: "left", positions };   // 位置は実測なので利き手系は不問
  const dirs = restDirections(rest);
  const order = boneOrder(rest);

  return {
    root,
    bones: order,
    node: (b) => map.get(b) ?? null,
    restDirection: (b) => {
      const d = dirs[b];
      return d ? new Vector3(d[0], d[1], d[2]) : null;
    },
    restPosition: (b) => {
      const p = positions[b];
      return p ? new Vector3(p[0], p[1], p[2]) : null;
    },
    dispose: () => { /* 借りているだけなので破棄しない */ },
  };
}

export interface BuildRigOptions {
  /** ノード名の接頭辞。1シーンに複数体置くときに衝突を避ける。 */
  name?: string;
  /** 骨組みの親。省略時は root を親なしで作る。 */
  parent?: TransformNode | null;
  /** 必須ボーンが欠けていても例外にしない（既定は投げる）。 */
  allowMissing?: boolean;
}

/**
 * 静止姿勢から骨組みを作る。
 *
 * @param rest 標準ボーン名の静止姿勢。利き手系はシーンに合わせて自動変換する。
 */
export function buildRig(scene: Scene, rest: RestPose, opts: BuildRigOptions = {}): RigHandle {
  const want = scene.useRightHandedSystem ? "right" : "left";
  const posed = toHandedness(rest, want);

  const v = validateRestPose(posed);
  if (!v.ok && !opts.allowMissing) {
    throw new Error(`buildRig: 必須ボーンが足りない: ${v.missing.join(", ")}`);
  }

  const prefix = opts.name ?? "rig";
  const root = new TransformNode(`${prefix}_root`, scene);
  if (opts.parent) root.parent = opts.parent;

  const order = boneOrder(posed);
  const offsets = localOffsets(posed);
  const dirs = restDirections(posed);
  const present = new Set(order);

  const nodes = new Map<StandardBoneName, TransformNode>();
  for (const b of order) {
    const n = new TransformNode(`${prefix}_${b}`, scene);
    const parentBone = nearestPresentParent(b, present);
    n.parent = parentBone ? nodes.get(parentBone)! : root;
    const o = offsets[b]!;
    n.position.set(o[0], o[1], o[2]);
    nodes.set(b, n);
  }

  return {
    root,
    bones: order,
    node: (b) => nodes.get(b) ?? null,
    restDirection: (b) => {
      const d = dirs[b];
      return d ? new Vector3(d[0], d[1], d[2]) : null;
    },
    restPosition: (b) => {
      const p = posed.positions[b];
      return p ? new Vector3(p[0], p[1], p[2]) : null;
    },
    dispose: () => {
      for (const n of nodes.values()) n.dispose();
      root.dispose();
    },
  };
}
