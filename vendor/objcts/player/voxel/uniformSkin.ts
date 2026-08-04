// 素体とユニフォームを、**同じ骨組みで変形する一枚のメッシュ**にする。
//
// ⚠️ 素体を部位ごとの剛体、服をスキニングにすると**変形の規則が違う**ので、関節で地肌が
// 服を突き抜ける（肩・脇・腰・股で顕著）。地肌を削る・描画順を変えるといった対処では
// 消えない（描画順を変えると、奥の服が手前の腕より前に出るという別の破綻が起きる）。
// 服と素体を同じ骨組み・同じウェイトで変形させれば、静止時に服の内側にある地肌は
// 動いても内側に留まる。
//
// ⚠️ ウェイトは**ボクセル単位ではなく頂点位置から**求める。ボクセル単位にすると
// 貪欲メッシュ（複数のボクセルを1枚の面に統合する）が使えなくなり、三角形が数倍になる。
import { Bone, Matrix, Mesh, Scene, Skeleton, Vector3 } from "@babylonjs/core";
import { STANDARD_PARENTS, type StandardBoneName } from "../standardSkeleton";
import type { RigHandle } from "../rig";
import {
  uniformData, bodyData, toVertexData, VOX_SIZE, uniformStretch, partStretch, applyStretch,
  partRestRotation, handCurlSteps, facePaint, hairVoxels, hairColor, PART_BONE, BODY_PARTS, VoxRole,
  type BodyVariant, type Recolor,
} from "./voxelBody";
import type { StandardBoneName as SBN } from "../standardSkeleton";

/** 1頂点に効かせる骨の数（Babylon の上限は4）。 */
const INFLUENCES = 4;
/** 距離の効き。大きいほど近い骨に強く寄る＝関節の変形が硬くなる。 */
const FALLOFF = 4;
/** 一番近い骨の何倍の距離までを混ぜるか。 */
const RANGE = 2.2;
/** さらに絶対値でも制限する(m)。⚠️ これが無いと左足の服が右足のウェイトを拾う。 */
const RANGE_ABS = 0.04;
// ⚠️ ズボンを股下で左右に切り離してはいけない。元データのショーツは**左右が繋がった
// 一枚の形**（中央 x=-6..+6cm まで布がある）なので、切ると太もも内側に穴が開く。

/** データに埋め込まれた関節名 → 標準ボーン名（voxelBody と同じ対応）。 */
const JOINT_TO_BONE: Record<string, StandardBoneName> = {
  root: "Hips", spine: "Spine", neck: "Neck", head: "Head",
  shoulderL: "LeftUpperArm", shoulderR: "RightUpperArm",
  elbowL: "LeftLowerArm", elbowR: "RightLowerArm",
  wristL: "LeftHand", wristR: "RightHand",
  hipL: "LeftUpperLeg", hipR: "RightUpperLeg",
  kneeL: "LeftLowerLeg", kneeR: "RightLowerLeg",
  ankleL: "LeftFoot", ankleR: "RightFoot",
};

const qrot = (q: number[], v: number[]): number[] => {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
};

/**
 * 服を**部位ごとに伸縮させてから**共通の格子へ戻して1つにまとめる。
 *
 * ⚠️ 伸縮を省いて骨まかせにしてはいけない。骨は長さしか伝えないので、高身長で服が体に
 * めり込み、低身長で肩がふくらむ。伸縮量は従来の部位別ユニフォームと同じ uniformStretch。
 */
function mergeUniformFitted(variant: BodyVariant, rig: RigHandle, height: number, we: number): number[][] {
  const cloth = uniformData(variant);
  const body = bodyData(variant);
  const sr = uniformStretch(variant, height, we);
  const ss = uniformStretch(variant, height, we, VoxRole.Shorts);
  const hip = rig.restPosition("LeftUpperLeg");
  const crotchY = (hip ? hip.y : 0.94) - 0.10;
  const cells = new Map<string, number[]>();
  for (const part of BODY_PARTS) {
    const pd = cloth.parts[part];
    if (!pd?.voxels.length) continue;
    const pivot = rig.restPosition(PART_BONE[part] as SBN);
    if (!pivot) continue;
    // ズボンだけ横の効きが違うので、ロールで分けてから別々に伸ばす（従来と同じ）
    const shorts: number[][] = [], other: number[][] = [];
    for (const v of pd.voxels) (cloth.palette[v[3]][3] === VoxRole.Shorts ? shorts : other).push(v);
    const ref = body.parts[part]?.voxels;
    const vox = applyStretch(other, sr[part] ?? { x: 0, y: 0, z: 0 }, ref)
      .concat(applyStretch(shorts, ss[part] ?? { x: 0, y: 0, z: 0 }, ref));
    const q = partRestRotation(part, variant);
    for (const v of vox) {
      const l = qrot(q, [(v[0] + 0.5) * VOX_SIZE, (v[1] + 0.5) * VOX_SIZE, (v[2] + 0.5) * VOX_SIZE]);
      const c = [
        Math.round((pivot.x + l[0]) / VOX_SIZE - 0.5),
        Math.round((pivot.y + l[1]) / VOX_SIZE - 0.5),
        Math.round((pivot.z + l[2]) / VOX_SIZE - 0.5),
      ];
      // ⚠️ 左右の裾が接していると1枚に溶接され、脚を開いても二股の先が繋がって見える。
      //    股下より下の中央**1セルだけ**空けて縁を切る（3cm空けると穴として見えた）。
      if ((c[1] + 0.5) * VOX_SIZE < crotchY && c[0] === 0) continue;
      const k = `${c[0]},${c[1]},${c[2]}`;
      if (!cells.has(k)) cells.set(k, [c[0], c[1], c[2], v[3]]);
    }
  }
  return [...cells.values()];
}

/** 6近傍のうち4方向以上が埋まっている空きセルを埋める（服の小さな穴を閉じる）。 */
function closeHoles(vox: number[][]): number[][] {
  const set = new Map<string, number>();
  for (const v of vox) set.set(`${v[0]},${v[1]},${v[2]}`, v[3]);
  const N6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  const add: number[][] = [];
  const seen = new Set<string>();
  for (const v of vox) {
    for (const d of N6) {
      const c = [v[0] + d[0], v[1] + d[1], v[2] + d[2]];
      const k = `${c[0]},${c[1]},${c[2]}`;
      if (set.has(k) || seen.has(k)) continue;
      seen.add(k);
      let n = 0, ci = v[3];
      for (const e of N6) {
        const kk = `${c[0] + e[0]},${c[1] + e[1]},${c[2] + e[2]}`;
        const hit = set.get(kk);
        if (hit !== undefined) { n++; ci = hit; }
      }
      if (n >= 4) add.push([c[0], c[1], c[2], ci]);
    }
  }
  return add.length ? vox.concat(add) : vox;
}

/**
 * 素体を**部位ごとに伸縮させてから**共通の格子へ繋ぐ。
 * ⚠️ 伸縮量・配置は剛体で描いていたときと同一にすること（変えると指の位置などがずれる）。
 */
function mergeBodyFitted(
  variant: BodyVariant, rig: RigHandle, height: number, we: number, handCurl: number,
  face: FaceStyle, hair: number, hairIdx: number, palette: number[][],
): number[][] {
  const body = bodyData(variant);
  const st = partStretch(variant, height, we);
  const curls = handCurlSteps(variant);
  const cells = new Map<string, number[]>();
  for (const part of BODY_PARTS) {
    let pd = body.parts[part];
    if (part === "handL" || part === "handR") {
      // 握りの段は焼き込み済み。一番近い段を採る
      let best = -1, bd = Math.abs(handCurl);
      curls.forEach((c, i) => { const d = Math.abs(handCurl - c); if (d < bd) { bd = d; best = i; } });
      if (best >= 0) pd = body.hands![part][best];
    }
    if (!pd?.voxels.length) continue;
    const pivot = rig.restPosition(PART_BONE[part] as SBN);
    if (!pivot) continue;
    // ⚠️ 必ず複製する。applyStretch は伸縮量が0のとき**入力の配列をそのまま返す**ので、
    //    そのまま顔を塗ったり髪を push すると読み込んだ JSON の素体データを書き換えてしまう
    //    （実測: 髪を切り替えるたびに元データへ髪が積み上がり、前の髪が消えなかった）。
    const vox = applyStretch(pd.voxels, st[part] ?? { x: 0, y: 0, z: 0 })
      .map((v) => [v[0], v[1], v[2], v[3]]);
    if (part === "head") {
      // 顔の部品は**頭の面に塗る**（列ごとに一番手前のセルの色を差し替える）。
      // ⚠️ ボクセルを重ねる方式だと、動かした先が頭の内側に入って見た目が変わらない。
      // ⚠️ 髪より**先**に塗ること。後だと前髪の表面に目や口を描いてしまう。
      paintFace(vox, variant, face, hairIdx, palette);
      if (hair >= 0) {
        // 髪も頭と同じだけ伸縮させる。⚠️ 伸縮の基準は**頭の箱**（第3引数）。省略すると
        //    髪自身の箱を基準に伸ばしてしまい、身長を変えたときに頭からずれる。
        const hs = st[part] ?? { x: 0, y: 0, z: 0 };
        const hv = hairVoxels(hair).map((c) => [c[0], c[1], c[2], hairIdx]);
        for (const v of applyStretch(hv, hs, pd.voxels)) vox.push(v);
      }
    }
    const q = partRestRotation(part);
    for (const v of vox) {
      const l = qrot(q, [(v[0] + 0.5) * VOX_SIZE, (v[1] + 0.5) * VOX_SIZE, (v[2] + 0.5) * VOX_SIZE]);
      const c = [
        Math.round((pivot.x + l[0]) / VOX_SIZE - 0.5),
        Math.round((pivot.y + l[1]) / VOX_SIZE - 0.5),
        Math.round((pivot.z + l[2]) / VOX_SIZE - 0.5),
      ];
      const k = `${c[0]},${c[1]},${c[2]}`;
      if (!cells.has(k)) cells.set(k, [c[0], c[1], c[2], v[3]]);
    }
  }
  return [...cells.values()];
}

/**
 * 顔の面（列ごとに一番手前のセル）を、選んだ形の色で塗る。
 * 眉は**髪と同じ色**（役割 Hair）で塗るので、髪の色を変えれば眉も一緒に変わる。
 * 目と口は同じ色のまま役割 Face の色として色表に足し、肌の塗り替えの対象から外す。
 */
function paintFace(
  vox: number[][], variant: BodyVariant, face: FaceStyle, hairIdx: number, palette: number[][],
): void {
  // 列 (x, y) ごとに一番手前のセルを引けるようにする
  const front = new Map<string, number[]>();
  for (const v of vox) {
    const k = `${v[0]},${v[1]}`;
    const cur = front.get(k);
    if (!cur || v[2] > cur[2]) front.set(k, v);
  }
  const asFace = new Map<number, number>();          // 元の色index → 役割 Face の色index
  const faceIdx = (i: number): number => {
    const hit = asFace.get(i);
    if (hit !== undefined) return hit;
    const k = palette.length;
    palette.push([palette[i][0], palette[i][1], palette[i][2], VoxRole.Face]);
    asFace.set(i, k);
    return k;
  };
  for (const [feature, style] of [["eye", face.eye], ["brow", face.brow], ["mouth", face.mouth]] as [string, number][]) {
    for (const p of facePaint(variant, feature, style)) {
      const cell = front.get(`${p[0]},${p[1]}`);
      if (cell) cell[3] = feature === "brow" ? hairIdx : faceIdx(p[2]);
    }
  }
}

/** 骨の「線分」。ウェイトはこの線分までの距離で決める（点で測ると胴が痩せて見える）。 */
interface BoneSeg { name: StandardBoneName; a: Vector3; b: Vector3 }

function boneSegments(rig: RigHandle): {
  segs: BoneSeg[]; rest: Map<StandardBoneName, Vector3>;
} {
  // ⚠️ **実行時の静止姿勢**を使う。データの静止姿勢で組むと、身長を変えたときに
  // 服が体に合わない（骨は長さしか伝えず、太さも部位ごとの伸縮も乗らない）。
  const rest = new Map<StandardBoneName, Vector3>();
  for (const bone of Object.values(JOINT_TO_BONE)) {
    const p = rig.restPosition(bone);
    if (p) rest.set(bone, p.clone());
  }
  const parentOf = (b: StandardBoneName): StandardBoneName | null => {
    let p = STANDARD_PARENTS[b];
    while (p && !rest.has(p)) p = STANDARD_PARENTS[p];
    return p ?? null;
  };
  const children = new Map<StandardBoneName, StandardBoneName[]>();
  for (const b of rest.keys()) {
    const p = parentOf(b);
    if (p) children.set(p, [...(children.get(p) ?? []), b]);
  }
  const segs: BoneSeg[] = [];
  for (const [b, a] of rest) {
    const cs = children.get(b);
    if (cs?.length) for (const c of cs) segs.push({ name: b, a, b: rest.get(c)! });
    else {
      const p = parentOf(b);
      const dir = p ? a.subtract(rest.get(p)!).normalize() : new Vector3(0, 1, 0);
      segs.push({ name: b, a, b: a.add(dir.scale(0.09)) });
    }
  }
  return { segs, rest };
}

const _v = new Vector3(), _ab = new Vector3(), _ap = new Vector3();
function distToSeg(p: Vector3, s: BoneSeg): number {
  s.b.subtractToRef(s.a, _ab);
  p.subtractToRef(s.a, _ap);
  const l2 = _ab.lengthSquared();
  const t = l2 > 1e-9 ? Math.max(0, Math.min(1, Vector3.Dot(_ap, _ab) / l2)) : 0;
  s.a.addToRef(_ab.scale(t), _v);
  return Vector3.Distance(p, _v);
}

export interface SkinRig {
  skeleton: Skeleton;
  order: StandardBoneName[];
  index: Map<StandardBoneName, number>;
  segs: BoneSeg[];
}

/**
 * 服と素体で**同じ骨組み**を使う。別々に作ると変形が食い違う。
 *
 * ⚠️ バインド姿勢は「元モデルの静止姿勢」で作り、実行時のリグのノードへリンクする。
 * 身長・体格の差は骨の位置差としてスキニングに乗るので、そのぶん伸びる。
 */
function buildSkinRig(scene: Scene, variant: BodyVariant, rig: RigHandle): SkinRig {
  const { segs, rest } = boneSegments(rig);
  const parentOf = (b: StandardBoneName): StandardBoneName | null => {
    let p = STANDARD_PARENTS[b];
    while (p && !rest.has(p)) p = STANDARD_PARENTS[p];
    return p ?? null;
  };
  const order: StandardBoneName[] = [];
  const visit = (b: StandardBoneName): void => {
    if (order.includes(b)) return;
    const p = parentOf(b);
    if (p) visit(p);
    order.push(b);
  };
  for (const b of rest.keys()) visit(b);

  const skeleton = new Skeleton(`skin_${variant}`, `skin_${variant}`, scene);
  const bones = new Map<StandardBoneName, Bone>();
  const index = new Map<StandardBoneName, number>();
  for (const name of order) {
    const p = parentOf(name);
    const here = rest.get(name)!;
    const off = p ? here.subtract(rest.get(p)!) : here;
    const bone = new Bone(name, skeleton, p ? bones.get(p)! : null, Matrix.Translation(off.x, off.y, off.z));
    const node = rig.node(name);
    if (node) bone.linkTransformNode(node);
    bones.set(name, bone);
    index.set(name, order.indexOf(name));
  }
  return { skeleton, order, index, segs };
}

/** ボクセル一式からスキン付きメッシュを作る（素体・服で共通）。 */
function skinMesh(
  scene: Scene, name: string, vox: number[][], palette: number[][], recolor: Recolor | null,
  sk: SkinRig, rig: RigHandle,
): Mesh | null {
  if (!vox.length) return null;
  // ⚠️ 面の統合を骨ごとに区切る。区切らないと関節をまたぐ長い面ができて裂ける。
  const nb = sk.segs.length;
  const wide: number[][] = [];
  for (let k = 0; k < nb; k++) for (const c of palette) wide.push(c);
  const nearestSeg = (x: number, y: number, z: number): number => {
    const q = new Vector3((x + 0.5) * VOX_SIZE, (y + 0.5) * VOX_SIZE, (z + 0.5) * VOX_SIZE);
    let best = 0, bd = Infinity;
    for (let k = 0; k < nb; k++) {
      const dd = distToSeg(q, sk.segs[k]);
      if (dd < bd) { bd = dd; best = k; }
    }
    return best;
  };
  // ⚠️ 元データの服は脇下に穴が空いている（実測: 肩の2〜4cm下に服のセルが0個）。
  // 6近傍のうち4方向以上が服のセルに囲まれた空きセルを埋めて閉じる。
  const filled = closeHoles(vox);
  const tagged = filled.map((v) => [v[0], v[1], v[2], v[3] + nearestSeg(v[0], v[1], v[2]) * palette.length]);
  const groups: number[] = [];
  const vd = toVertexData(tagged, wide, recolor, groups);
  const pos = vd.positions as number[];
  if (!pos?.length) return null;

  const mi: number[] = [], mw: number[] = [];
  const p = new Vector3();
  const d: { i: number; w: number }[] = [];
  for (let i = 0; i < pos.length; i += 3) {
    p.set(pos[i], pos[i + 1], pos[i + 2]);
    d.length = 0;
    let near = Infinity;
    // ⚠️ 骨ごとに最短を採る。子が複数ある骨は線分を複数持つので、そのままだとウェイト枠を二重に使う。
    const per = new Map<number, number>();
    for (const s of sk.segs) {
      const dist = distToSeg(p, s);
      if (dist < near) near = dist;
      const bi = sk.index.get(s.name)!;
      const cur = per.get(bi);
      if (cur === undefined || dist < cur) per.set(bi, dist);
    }
    for (const [bi, dist] of per) d.push({ i: bi, w: dist });
    // ⚠️ 反対側の手足を混ぜない基準は、頂点の最寄りではなく**その面が属する骨**。
    //    頂点基準だと同じ面の4隅が左右に割れ、面の中で裂ける。
    const faceBone: string = sk.order[Math.floor(groups[i / 3] / palette.length)] ?? "";
    const side = faceBone.startsWith("Left") ? "Right" : faceBone.startsWith("Right") ? "Left" : "";
    const cut = Math.min(near * RANGE, near + RANGE_ABS) + 1e-4;
    const cand = d.filter((e) => e.w <= cut && !(side && sk.order[e.i].startsWith(side)))
      .map((e) => ({ i: e.i, w: Math.pow(1 / (e.w + 1e-3), FALLOFF) }))
      .sort((a, b) => b.w - a.w).slice(0, INFLUENCES);
    let sum = 0;
    for (const e of cand) sum += e.w;
    for (let k = 0; k < INFLUENCES; k++) {
      mi.push(cand[k]?.i ?? 0);
      mw.push(cand[k] ? cand[k].w / sum : 0);
    }
  }
  vd.matricesIndices = mi;
  vd.matricesWeights = mw;

  const mesh = new Mesh(name, scene);
  vd.applyToMesh(mesh, false);
  mesh.skeleton = sk.skeleton;
  mesh.parent = rig.root;
  return mesh;
}

/**
 * 素体をスキン付きの一枚メッシュにする（手も含む）。
 *
 * ⚠️ 服だけスキニングし素体を剛体のままにすると、**変形の規則が違うので関節で地肌が
 * 服からはみ出す**。形は剛体で描いていたときと同一（同じ部位別伸縮・同じ静止姿勢）。
 * 握りの差し替えは、開き用と握り用の2枚を作って表示を切り替える。
 */
/** 顔の部品の選択（それぞれ形の種類の番号）。 */
export interface FaceStyle { eye: number; brow: number; mouth: number }

export function buildSkinnedBody(
  scene: Scene, variant: BodyVariant, rig: RigHandle, recolor: Recolor | null,
  height: number, widthExponent: number, handCurl: number,
  face: FaceStyle = { eye: 0, brow: 0, mouth: 0 }, hair = -1, sk?: SkinRig,
): { mesh: Mesh; skin: SkinRig } | null {
  const s2 = sk ?? buildSkinRig(scene, variant, rig);
  const body = bodyData(variant);
  // 色表は複製して使う（元データを汚さない）。末尾に髪の色を足す。
  // ⚠️ 素体の色は目も口も眉も**全部 Skin 役**で焼いてある。そのまま肌を塗り替えると
  //    目や口まで肌色に染まる。眉は Hair 役、目と口は Face 役に振り直して使う。
  const palette = body.palette.map((c) => c.slice());
  const hairIdx = palette.length;
  palette.push([...hairColor(), VoxRole.Hair]);
  const vox = mergeBodyFitted(variant, rig, height, widthExponent, handCurl, face,
    hair, hairIdx, palette);
  const mesh = skinMesh(scene, `bodySkin_${variant}`, vox, palette, recolor, s2, rig);
  return mesh ? { mesh, skin: s2 } : null;
}

/**
 * ユニフォームをスキン付きの一枚メッシュにする。
 * ⚠️ **素体には手を出さない**。素体をスキニングに変えると身長合わせの規則が変わり、
 * 剛体のままの手（握りの差し替えが要る）と食い違って指の位置がずれる。
 */
export function buildSkinnedUniform(
  scene: Scene, variant: BodyVariant, rig: RigHandle, recolor: Recolor | null,
  height: number, widthExponent: number, sk0?: SkinRig,
): { mesh: Mesh; skeleton: Skeleton } | null {
  const sk = sk0 ?? buildSkinRig(scene, variant, rig);
  const cloth = uniformData(variant);
  const vox = mergeUniformFitted(variant, rig, height, widthExponent);
  const mesh = skinMesh(scene, `uniformSkin_${variant}`, vox, cloth.palette, recolor, sk, rig);
  return mesh ? { mesh, skeleton: sk.skeleton } : null;
}
