/**
 * boneMapping — 任意リグのボーン名を標準名へ変換する辞書と、その検証・合成。
 *
 * リグの命名（Mixamo / 自作）はここで吸収し、上位のモーションコードは
 * 標準名だけを見る。リグが変わってもモーション側は影響を受けない。
 *
 * 出典: battle-game `src/fighting/avatar/BoneMapping.ts` から移植し、
 * resolve 系ヘルパを追加。
 */
import {
  REQUIRED_BONES,
  STANDARD_BONE_SET,
  type StandardBoneName,
} from "./standardSkeleton";

export interface BoneMapping {
  /** 一意な ID（マニフェストとの突合用） */
  id: string;
  /** 元のリグ種別ラベル（"mixamo" / "unity-humanoid" / "custom" 等） */
  rigType: string;
  /** Standard → Source name */
  bones: Partial<Record<StandardBoneName, string>>;
}

export type BoneMappingPreset = BoneMapping;

/** Unity Editor 拡張などが吐く entries 配列形式。 */
export interface BoneMappingJson {
  id: string;
  rigType: string;
  entries: { standardName: string; sourceName: string }[];
}

export interface BoneMappingValidationIssue {
  bone: StandardBoneName | string;
  reason: "missing" | "unknown-standard-bone";
}

/** 必須ボーンの欠落と、標準名でないキーを検出する。 */
export function validateBoneMapping(mapping: BoneMapping): {
  ok: boolean;
  issues: BoneMappingValidationIssue[];
} {
  const issues: BoneMappingValidationIssue[] = [];
  for (const required of REQUIRED_BONES) {
    if (!mapping.bones[required]) issues.push({ bone: required, reason: "missing" });
  }
  for (const key of Object.keys(mapping.bones)) {
    if (!STANDARD_BONE_SET.has(key as StandardBoneName)) {
      issues.push({ bone: key, reason: "unknown-standard-bone" });
    }
  }
  return { ok: issues.length === 0, issues };
}

/** Source name → Standard name の逆引き。GLB の実ボーン名を標準名へ直す用途。 */
export function buildReverseLookup(
  mapping: BoneMapping,
): ReadonlyMap<string, StandardBoneName> {
  const reverse = new Map<string, StandardBoneName>();
  for (const [standard, source] of Object.entries(mapping.bones)) {
    if (source) reverse.set(source, standard as StandardBoneName);
  }
  return reverse;
}

/** base のキーを override で上書きする。プリセットの部分カスタムに使う。 */
export function mergeMapping(
  base: BoneMapping,
  override: Partial<BoneMapping["bones"]>,
  id = base.id,
): BoneMapping {
  return { ...base, id, bones: { ...base.bones, ...override } };
}

/** entries 配列形式 → オブジェクト形式。標準名でないエントリは捨てる。 */
export function fromJsonEntries(json: BoneMappingJson): BoneMapping {
  const bones: Partial<Record<StandardBoneName, string>> = {};
  for (const e of json.entries) {
    if (STANDARD_BONE_SET.has(e.standardName as StandardBoneName)) {
      bones[e.standardName as StandardBoneName] = e.sourceName;
    }
  }
  return { id: json.id, rigType: json.rigType, bones };
}

/** オブジェクト形式 → entries 配列形式（書き出し用）。 */
export function toJsonEntries(mapping: BoneMapping): BoneMappingJson {
  const entries: { standardName: string; sourceName: string }[] = [];
  for (const [standardName, sourceName] of Object.entries(mapping.bones)) {
    if (sourceName) entries.push({ standardName, sourceName });
  }
  return { id: mapping.id, rigType: mapping.rigType, entries };
}

/** 接頭辞を付け替えた派生を作る（"mixamorig:" を外す等）。 */
export function reprefix(mapping: BoneMapping, from: string, to: string, id = mapping.id): BoneMapping {
  const bones: Partial<Record<StandardBoneName, string>> = {};
  for (const [std, src] of Object.entries(mapping.bones)) {
    if (!src) continue;
    bones[std as StandardBoneName] = src.startsWith(from) ? to + src.slice(from.length) : src;
  }
  return { ...mapping, id, bones };
}

/**
 * 実際に存在するボーン名の集合と突き合わせ、解決できた標準ボーンを返す。
 * モデルをロードした直後に「このリグで何が使えるか」を確定させる用途。
 */
export function resolveAgainst(
  mapping: BoneMapping,
  presentSourceNames: Iterable<string>,
): {
  resolved: Map<StandardBoneName, string>;
  missing: StandardBoneName[];
  unmatchedSources: string[];
} {
  const present = new Set(presentSourceNames);
  const resolved = new Map<StandardBoneName, string>();
  const used = new Set<string>();
  for (const [std, src] of Object.entries(mapping.bones)) {
    if (src && present.has(src)) {
      resolved.set(std as StandardBoneName, src);
      used.add(src);
    }
  }
  const missing = REQUIRED_BONES.filter((b) => !resolved.has(b));
  const unmatchedSources = [...present].filter((s) => !used.has(s));
  return { resolved, missing, unmatchedSources };
}

/**
 * 2つのマッピングから「ソース側リグ名 → ターゲット側リグ名」の対応を作る。
 * 標準名を経由するので、命名の違うリグ同士でも橋渡しできる（リターゲット用）。
 */
export function bridgeNames(
  source: BoneMapping,
  target: BoneMapping,
): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const [std, srcName] of Object.entries(source.bones)) {
    const tgtName = target.bones[std as StandardBoneName];
    if (srcName && tgtName) out.set(srcName, tgtName);
  }
  return out;
}
