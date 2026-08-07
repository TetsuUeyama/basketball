// objcts/player のボクセル素体で選手を描く（このプロジェクト唯一の見た目）。
//
// 既存の関節ノード（armPivot / elbow / hip / knee / torsoNode / headNode）はそのまま
// 「仮想の骨組み」として残し、その回転を毎フレーム標準ボーンへ転写する（syncVoxelPose）。
// アニメ側（animation/ 一式）は変更しない。
//
// 前後の規約:
//   既存モデル … 前方 = ローカル -numberSide·Z（Zオフセットの反転で前後を入れ替える）
//   ボクセル   … 前方 = +Z（objcts/player/voxel の規約）
// numberSide が +1 のときだけ骨組み全体を Y に 180° 回し、流し込む回転を Ry(π) で
// 共役変換して左右の腕・脚を入れ替える。
import {
  Scene, Mesh, TransformNode, Quaternion, Vector3, Color3, DynamicTexture, VertexData, StandardMaterial,
  Skeleton, Bone, Matrix,
} from "@babylonjs/core";
import { buildRig, type RigHandle } from "@objcts/player/rig";
import type { RestPose } from "@objcts/player/restPose";
import type { StandardBoneName } from "@objcts/player/standardSkeleton";
import {
  bodyRestPose, partStretch, buildPartMesh, buildUniformMesh, variantFor, bodyData,
  uniformVoxels, uniformData, skinData,
  applyStretch, toVertexData, facePaint, hairVoxels, hairStyles, skinBaseColor, partRestRotation,
  PART_BONE, BODY_PARTS, VoxRole, VOX_SIZE,
  DEFAULT_WIDTH_EXPONENT, DEFAULT_HEAD_EXPONENT,
  type BodyVariant, type PartStretch, type Recolor,
} from "@objcts/player/voxel/voxelBody";
import { makeMat } from "../materials";
import type { RGB } from "../../config";

/** 髪型No（hair.json の元番号 1..140 / 0 = 髪なし）→ hairVoxels() のindex。
 *  元番号は連番ではない（18 と 80 が欠番）ので、名前から引いた表で解決する。
 *  ⚠️ 欠番や範囲外を渡されたら髪なしにせず、番号から決まる実在の髪型へ回す
 *     （データ側の1件のズレで坊主が混じるのを防ぐ）。 */
const HAIR_INDEX = new Map<number, number>();
export function voxHairIndex(hairNo: number): number {
  if (!(hairNo > 0)) return -1;                 // 0 / 未設定 = 髪なし
  if (!HAIR_INDEX.size) {
    const names = hairStyles();                 // "髪型 N" （N = 元番号）
    for (let i = 0; i < names.length; i++) {
      const n = Number(names[i].replace(/[^0-9]/g, ""));
      if (n > 0) HAIR_INDEX.set(n, i);
    }
  }
  const hit = HAIR_INDEX.get(hairNo);
  return hit ?? (hairNo - 1) % HAIR_INDEX.size;
}

/** 腕を胴へ埋めないための外向き角の下限(rad)。ボクセル素体は肩の関節が胴の内側
 *  （x=±0.12、胴の半幅は 0.21）にあるので、真下へ垂らすと腕が胴に埋まる。 */
const MIN_ARM_SPLAY = 0.61;   // ≈35°

export interface VoxelKit { top: RGB; bottom: RGB; shoes: RGB }

/** ボーン1本ぶんの回転の読み替え。
 *  ボクセルは部位を「骨が -Y」の骨ローカルで持ち、焼き込みの回転 restRot で元の角度へ戻す。
 *  一方リグの子関節のオフセットは**元の静止姿勢のまま**なので、ノードの回転は
 *  「静止姿勢からの差分」でなければ関節とメッシュが食い違う。
 *  アニメ側が作る回転 V（(0,-1,0) を目標方向へ向ける）から
 *    ノードの回転 = restRot(親) ⊗ V ⊗ restRot(自分)⁻¹
 *  へ変換する。メッシュ側は restRot を自分で持つので、両者が同じ向きに揃う。 */
interface BoneMap {
  bone: StandardBoneName;
  pre: Quaternion;    // restRot(親の部位)
  post: Quaternion;   // restRot(自分の部位)の逆
}

// ───────────────────────── スキニング ─────────────────────────
//
// 服は部位ごとの剛体ではなく、リグ全体に**スキンで**貼る。肩・股の境目で
// 2本のボーンが混ざるので、腕を上げても袖ぐりが胴に取り残されない。
// 姿勢は今までどおり TransformNode のリグが決め、Skeleton は linkTransformNode で
// それに追従するだけ（アニメ側は一切変えない）。

/** リグのノード階層をなぞる Skeleton。各ボーンはノードへリンクする。 */
function buildSkeleton(scene: Scene, rig: RigHandle, name: string):
    { skel: Skeleton; index: Map<string, number> } {
  const skel = new Skeleton(`skel_${name}`, `skel_${name}`, scene);
  const index = new Map<string, number>();
  const made = new Map<string, Bone>();
  const nodeBone = new Map<TransformNode, string>();
  for (const b of rig.bones) { const n = rig.node(b); if (n) nodeBone.set(n, b); }
  // 親ボーン = ノードの祖先をたどって最初に見つかるリグのボーン
  const parentBoneOf = (b: string): string | null => {
    let p = rig.node(b as StandardBoneName)?.parent as TransformNode | null;
    while (p) {
      const hit = nodeBone.get(p);
      if (hit) return hit;
      p = p.parent as TransformNode | null;
    }
    return null;
  };
  const make = (b: string): Bone | null => {
    const hit = made.get(b);
    if (hit) return hit;
    const n = rig.node(b as StandardBoneName);
    if (!n) return null;
    const pb = parentBoneOf(b);
    // ⚠️ バインド姿勢は「静止時のローカル位置・回転なし」。剛体で付けていたときの
    //    「ボーンの位置 ＋ 部位の restRot」と同じ空間に合わせるため。
    const bone = new Bone(b, skel, pb ? make(pb) : null,
      Matrix.Translation(n.position.x, n.position.y, n.position.z));
    bone.linkTransformNode(n);
    made.set(b, bone);
    index.set(b, bone.getIndex());
    return bone;
  };
  for (const b of rig.bones) make(b);
  return { skel, index };
}

/**
 * 服の全部位を、静止姿勢のワールドへ並べた1枚のメッシュにまとめる。
 * 部位ごとのボクセルは「骨が -Y」の骨ローカルなので、restRot で元の角度へ戻し、
 * その骨の**静止位置**へ寄せる（＝剛体で骨に付けていたときと同じ置き方）。
 */
function mergeSkinnedCloth(
  scene: Scene, variant: BodyVariant, height: number, we: number,
  recolor: Recolor, skin: { table: number[]; remap: number[] }, rig: RigHandle,
): Mesh | null {
  const pal = uniformData(variant).palette;
  const P: number[] = [], N: number[] = [], C: number[] = [], I: number[] = [];
  const MI: number[] = [], MW: number[] = [];
  const q = new Quaternion(), v = new Vector3();
  for (const part of BODY_PARTS) {
    const vox = uniformVoxels(variant, part, height, we);
    if (!vox.length) continue;
    const rest = rig.restPosition(PART_BONE[part] as StandardBoneName);
    if (!rest) continue;
    const vd = toVertexData(vox, pal, recolor, undefined, skin);
    const pos = vd.positions as number[] | null;
    if (!pos?.length) continue;
    const nor = vd.normals as number[], col = vd.colors as number[], idx = vd.indices as number[];
    const r = partRestRotation(part);
    q.copyFromFloats(r[0], r[1], r[2], r[3]);
    const base = P.length / 3;
    for (let i = 0; i < pos.length; i += 3) {
      v.copyFromFloats(pos[i], pos[i + 1], pos[i + 2]).applyRotationQuaternionInPlace(q);
      P.push(v.x + rest.x, v.y + rest.y, v.z + rest.z);
      v.copyFromFloats(nor[i], nor[i + 1], nor[i + 2]).applyRotationQuaternionInPlace(q);
      N.push(v.x, v.y, v.z);
    }
    C.push(...col);
    for (const n of idx) I.push(base + n);
    MI.push(...(vd.matricesIndices as number[]));
    MW.push(...(vd.matricesWeights as number[]));
  }
  if (!P.length) return null;
  const out = new VertexData();
  out.positions = P; out.normals = N; out.colors = C; out.indices = I;
  out.matricesIndices = MI; out.matricesWeights = MW;
  const m = new Mesh("voxClothProto", scene);
  out.applyToMesh(m, false);
  return m;
}

/** 影キャスターの登録先。scene-setup が差し込む（作り直しでも拾えるようにフックで持つ）。 */
let shadowHook: ((meshes: Mesh[]) => void) | null = null;
export function setVoxelShadowHook(f: ((meshes: Mesh[]) => void) | null): void { shadowHook = f; }

export interface VoxelBody {
  /** numberSide のヨーを持つ入れ物。Player.root の子。 */
  readonly root: TransformNode;
  readonly rig: RigHandle;
  /** 服のスキニング用。ノードのリグに linkTransformNode で追従する。毎フレーム prepare()。 */
  readonly skel: Skeleton;
  /** 体のメッシュ（素体＋ユニフォーム＋髪）。作り直しで中身が入れ替わる。 */
  readonly meshes: Mesh[];
  /** 影キャスターに登録するぶん。⚠️ 全部入れると4百万三角形をもう一度描くことになるので、
   *  床のシルエットをほぼ決めるユニフォーム（ジャージ・ショーツ・シューズ）だけにする。 */
  readonly shadowMeshes: Mesh[];
  /** 標準ボーン名 → 回転の読み替え。 */
  readonly map: Map<string, BoneMap>;
  /** Spine ノードの静止時のローカル位置（腰ヒンジのオフセットを足す基準）。 */
  readonly spineRest: Vector3;
  /** Hips ノードの静止時のローカル位置（クリップの接地合わせが動かすので戻す基準）。 */
  readonly hipsRest: Vector3;
  readonly variant: BodyVariant;
  readonly height: number;
  /** root ローカルの肩の位置（aimArm / reachIK が使う）。 */
  readonly shoulder: { x: number; y: number; z: number };
  /** 股関節の高さ（着席時に root を下げる量）。 */
  readonly hipY: number;
  /** IK 用の実効長。前腕は手のひらの中心まで（手首ボーンより先に手が出るため）。 */
  readonly upperArm: number;
  readonly foreArm: number;
  setSkinColor(c: RGB): void;
  setHairColor(c: RGB): void;
  setHairStyle(hairNo: number): void;
  setKit(kit: VoxelKit): void;
  setJerseyText(text: string, color: string): void;
  setNumberVisible(v: boolean): void;
  dispose(): void;
}

// ───────────────────────── プロトタイプ共有 ─────────────────────────
// 26人ぶん個別に組むと生成に数秒かかるので、形が同じものは1本だけ作って clone する。
// 伸縮量（整数層）が同じなら形も同じなので、身長ではなく伸縮量をキーにする。
//
// ⚠️ **プロトタイプはシーンごとに持つ**。Babylon の clone は元メッシュのシーンに作られるので、
//    シーンをまたいで使い回すと「別シーンに実体があるメッシュ」を親付けすることになり、
//    そのシーンでは何も描かれない（試合前のクラブ選択プレビューが別シーンなので実際に起きた。
//    症状: 一部の選手が出ない・腕だけ出る）。objcts 側（`meshFrom`）も同じ作りなので、
//    返ってきたメッシュが別シーンなら頂点データを取り出して作り直す。

const PROTO = new WeakMap<Scene, Map<string, Mesh | null>>();

/** ユニフォーム用マテリアル（色は頂点色なので全選手で共有できる）。 */
const KIT_MAT = new WeakMap<Scene, StandardMaterial>();
function sharedKitMat(scene: Scene): StandardMaterial {
  let m = KIT_MAT.get(scene);
  if (!m) {
    m = makeMat(scene, "voxkit", { diffuse: new Color3(1, 1, 1), spec: new Color3(0.06, 0.06, 0.06) });
    m.freeze();
    KIT_MAT.set(scene, m);
  }
  return m;
}

/** 別シーンのメッシュなら、頂点データを取り出してこのシーンで作り直す。 */
function adopt(scene: Scene, m: Mesh | null): Mesh | null {
  if (!m || m.getScene() === scene) return m;
  const vd = VertexData.ExtractFromMesh(m);
  const out = new Mesh(m.name, scene);
  vd.applyToMesh(out, false);
  m.dispose();
  return out;
}

function instanceOf(scene: Scene, key: string, name: string, make: () => Mesh | null): Mesh | null {
  let store = PROTO.get(scene);
  if (!store) { store = new Map(); PROTO.set(scene, store); }
  let p = store.get(key);
  if (p === undefined) {
    p = adopt(scene, make());
    if (p) { p.setEnabled(false); p.isPickable = false; }
    store.set(key, p);
  }
  if (!p) return null;
  const m = p.clone(name, null, true);   // ジオメトリ共有
  m.setEnabled(true);
  m.isPickable = false;
  return m;
}

// bodyRestPose / partStretch は身長から関節位置と伸縮層数を反復で解く。26人ぶん
// 2回ずつ呼ぶと無視できない時間になるので、体型と身長(1cm刻み)で覚えておく。
const SHAPE = new Map<string, { rest: RestPose; stretch: Record<string, PartStretch> }>();
function shapeOf(variant: BodyVariant, height: number, we: number, he: number) {
  const key = `${variant}|${Math.round(height * 100)}`;
  let s = SHAPE.get(key);
  if (!s) {
    s = {
      rest: bodyRestPose(variant, height, we, he) as unknown as RestPose,
      stretch: partStretch(variant, height, we, he),
    };
    SHAPE.set(key, s);
  }
  return s;
}

const sig = (s: PartStretch): string => `${s.x},${s.y},${s.z}`;
const hex2 = (c: RGB): string =>
  [c.r, c.g, c.b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("");

// ───────────────────────── 頭（顔）と髪 ─────────────────────────

/** 顔の部品を頭の表面（列ごとに一番手前のセル）へ塗る。uniformSkin の paintFace と同じ規約。 */
function paintFaceOn(vox: number[][], variant: BodyVariant): void {
  const front = new Map<string, number[]>();
  for (const v of vox) {
    const k = `${v[0]},${v[1]}`;
    const cur = front.get(k);
    if (!cur || v[2] > cur[2]) front.set(k, v);
  }
  for (const feature of ["eye", "brow", "mouth"]) {
    for (const p of facePaint(variant, feature, 0)) {
      const cell = front.get(`${p[0]},${p[1]}`);
      if (cell) cell[3] = p[2];
    }
  }
}

/** 頭のメッシュ。⚠️ **髪が占めるセルは頭側から削る**。同じ位置に両方の面が立つと
 *  Z ファイティングでちらつくため（髪を優先する）。 */
function makeHeadMesh(scene: Scene, variant: BodyVariant, st: PartStretch, hairStyle: number): Mesh | null {
  const body = bodyData(variant);
  const pd = body.parts.head;
  if (!pd?.voxels.length) return null;
  // ⚠️ applyStretch は伸縮0のとき入力の配列をそのまま返す。顔を塗る前に必ず複製する。
  const vox = applyStretch(pd.voxels, st).map((v) => [v[0], v[1], v[2], v[3]]);
  paintFaceOn(vox, variant);
  if (hairStyle >= 0) {
    const hs = new Set(applyStretch(hairVoxels(hairStyle).map((c) => [c[0], c[1], c[2], 0]), st, pd.voxels)
      .map((c) => `${c[0]},${c[1]},${c[2]}`));
    if (hs.size) {
      const kept = vox.filter((v) => !hs.has(`${v[0]},${v[1]},${v[2]}`));
      if (kept.length) vox.length = 0, vox.push(...kept);
    }
  }
  const vd = toVertexData(vox, body.palette, null);
  if (!vd.positions?.length) return null;
  const m = new Mesh("voxHeadProto", scene);
  vd.applyToMesh(m, false);
  return m;
}

function makeHairMesh(scene: Scene, variant: BodyVariant, st: PartStretch, style: number): Mesh | null {
  const hv = hairVoxels(style);
  if (!hv.length) return null;
  // 伸縮の基準は頭の箱。髪自身の箱で伸ばすと身長を変えたとき頭からずれる。
  const ref = bodyData(variant).parts.head?.voxels ?? [];
  const vox = applyStretch(hv.map((c) => [c[0], c[1], c[2], 0]), st, ref);
  const vd = toVertexData(vox, [[255, 255, 255, VoxRole.Hair]], null);
  if (!vd.positions?.length) return null;
  const m = new Mesh("voxHairProto", scene);
  vd.applyToMesh(m, false);
  return m;
}

// ───────────────────────── 背番号 ─────────────────────────

/** 胴の背面（ボクセル空間の -Z 側）に沿う薄い曲面シェル。既存モデルと同じ作り方。 */
function makeNumberShell(scene: Scene, name: string, r: number, yTop: number, yBot: number): Mesh {
  const SEG = 12, span = Math.PI * 0.44;
  const positions: number[] = [], indices: number[] = [], uvs: number[] = [], normals: number[] = [];
  for (const [y, v] of [[yBot, 0], [yTop, 1]] as [number, number][]) {
    for (let i = 0; i <= SEG; i++) {
      const a = (i / SEG - 0.5) * span;
      positions.push(Math.sin(a) * r, y, -Math.cos(a) * r);
      // -Z から見て数字が左から右へ読めるようにUを反転
      uvs.push(1 - i / SEG, v);
      normals.push(Math.sin(a), 0, -Math.cos(a));
    }
  }
  for (let i = 0; i < SEG; i++) {
    const a = i, b = i + 1, c = i + SEG + 1, d = i + SEG + 2;
    indices.push(a, c, b, b, c, d);
  }
  const vd = new VertexData();
  vd.positions = positions; vd.indices = indices; vd.uvs = uvs; vd.normals = normals;
  const m = new Mesh(name, scene);
  vd.applyToMesh(m, false);
  m.isPickable = false;
  return m;
}

// ───────────────────────── 本体 ─────────────────────────

export interface VoxelBodyOptions {
  name: string;
  balance: number;      // ボディバランス能力値 → 体型3種
  height: number;       // m
  skin: RGB;
  hair: RGB;
  hairNo: number;       // 髪型No（hair.json の元番号 1..140 / 0 = 髪なし）
  kit: VoxelKit;
  jerseyText: string;   // 背番号（審判は "R"）
}

export function buildVoxelBody(scene: Scene, parent: TransformNode, o: VoxelBodyOptions): VoxelBody {
  const variant = variantFor(o.balance);
  const height = o.height;
  const we = DEFAULT_WIDTH_EXPONENT, he = DEFAULT_HEAD_EXPONENT;

  const root = new TransformNode(`vox_${o.name}`, scene);
  root.parent = parent;
  const shape = shapeOf(variant, height, we, he);
  const rig = buildRig(scene, shape.rest, { name: `vox_${o.name}`, parent: root, allowMissing: true });

  const st = shape.stretch;
  const zero: PartStretch = { x: 0, y: 0, z: 0 };
  const headSt = st.head ?? zero;

  // 素体は焼き込みの色そのまま（＝プロトタイプを全選手で共有）。肌の色味はマテリアルの
  // diffuse で頂点色に乗算して入れる。単色で潰すと陰影が消えて板になる。
  const skinMat = makeMat(scene, `voxskin_${o.name}`, {
    diffuse: new Color3(1, 1, 1), spec: new Color3(0.04, 0.04, 0.04),
  });
  const hairMat = makeMat(scene, `voxhair_${o.name}`, {
    diffuse: new Color3(1, 1, 1), spec: new Color3(0.03, 0.03, 0.03),
  });
  // キット色は頂点色へ焼くので、マテリアルは全選手で1本を共有できる（描画状態の切替を減らす）
  const kitMat = sharedKitMat(scene);

  // 部位の焼き込み回転。メッシュはこれを自分で持ち、ボーンの回転は「静止姿勢からの差分」にする。
  const rr = (part: string): Quaternion => {
    const q = partRestRotation(part);
    return new Quaternion(q[0], q[1], q[2], q[3]);
  };
  const skin: Mesh[] = [];
  const bone = (part: string): TransformNode | null => rig.node(PART_BONE[part] as StandardBoneName);
  const setRestRot = (m: Mesh, part: string): void => { m.rotationQuaternion = rr(part); };

  // --- 素体（服の下の地肌は落とす。剛体パーツ同士なので残すと服を突き抜ける） ---
  for (const part of BODY_PARTS) {
    const s = st[part] ?? zero;
    if (part === "head") continue;   // 頭は髪型に合わせて削るので buildHair が作る
    const m = instanceOf(scene, `b|${variant}|${part}|${sig(s)}`, `voxb_${part}_${o.name}`,
      () => buildPartMesh(scene, variant, part, s, "bake", null, 0, true));
    const n = bone(part);
    if (!m) continue;
    if (!n) { m.dispose(); continue; }
    m.material = skinMat;
    m.parent = n;
    setRestRot(m, part);
    skin.push(m);
  }

  // --- スケルトン（服のスキニング用。姿勢はノードのリグが決める） ---
  const { skel, index: boneIndex } = buildSkeleton(scene, rig, o.name);

  // --- ユニフォーム（キット色は焼き込み。着替えは作り直し） ---
  //
  // 服は部位ごとに骨へ付けず、**静止姿勢のワールドへ並べた1枚のスキンメッシュ**にする。
  // 剛体だと肩・股の継ぎ目で布が割れる（実測: 腕を前へ出すと袖ぐりの布508ボクセルが
  // 胴に取り残された）。焼き込みのウェイトが無い体型ではこれまでどおり剛体で組む。
  let uniform: Mesh[] = [];
  const sd = skinData(variant, true);
  const skinned = sd.bones.length > 0 && sd.table.length > 0;
  const buildUniform = (kit: VoxelKit): void => {
    for (const m of uniform) m.dispose();
    uniform = [];
    const ck = `${hex2(kit.top)}-${hex2(kit.bottom)}-${hex2(kit.shoes)}`;
    const recolor: Recolor = (role) =>
      role === VoxRole.Jersey ? [kit.top.r, kit.top.g, kit.top.b]
        : role === VoxRole.Shorts ? [kit.bottom.r, kit.bottom.g, kit.bottom.b]
          : role === VoxRole.Shoes ? [kit.shoes.r, kit.shoes.g, kit.shoes.b] : null;
    if (skinned) {
      const remap = sd.bones.map((n) => boneIndex.get(n) ?? 0);
      const m = instanceOf(scene, `us|${variant}|${Math.round(height * 100)}|${ck}`, `voxu_${o.name}`,
        () => mergeSkinnedCloth(scene, variant, height, we, recolor, { table: sd.table, remap }, rig));
      if (m) {
        m.material = kitMat;
        m.parent = rig.root;
        m.skeleton = skel;
        m.numBoneInfluencers = 4;
        uniform.push(m);
      }
      return;
    }
    for (const part of BODY_PARTS) {
      const s = st[part] ?? zero;
      const m = instanceOf(scene, `u|${variant}|${part}|${sig(s)}|${ck}`, `voxu_${part}_${o.name}`,
        () => buildUniformMesh(scene, variant, part, height, we, ck, recolor));
      if (!m) continue;
      const n = bone(part);
      if (!n) { m.dispose(); continue; }
      m.material = kitMat;
      m.parent = n;
      setRestRot(m, part);
      uniform.push(m);
    }
  };
  buildUniform(o.kit);

  // --- 頭と髪（⚠️ 頭は髪が占めるセルを削って作るので、必ずセットで組み直す）---
  let hair: Mesh | null = null;
  let headMesh: Mesh | null = null;
  const buildHair = (hairNo: number): void => {
    hair?.dispose(); hair = null;
    if (headMesh) { const i = skin.indexOf(headMesh); if (i >= 0) skin.splice(i, 1); headMesh.dispose(); headMesh = null; }
    const node = rig.node("Head");
    if (!node) return;
    const vs = voxHairIndex(hairNo);
    headMesh = instanceOf(scene, `h|${variant}|${sig(headSt)}|${vs}`, `voxhead_${o.name}`,
      () => makeHeadMesh(scene, variant, headSt, vs));
    if (headMesh) {
      headMesh.material = skinMat;
      headMesh.parent = node;
      setRestRot(headMesh, "head");
      skin.push(headMesh);
    }
    if (vs < 0) return;
    hair = instanceOf(scene, `hair|${variant}|${sig(headSt)}|${vs}`, `voxhair_${o.name}`,
      () => makeHairMesh(scene, variant, headSt, vs));
    if (!hair) return;
    hair.material = hairMat;
    hair.parent = node;
    setRestRot(hair, "head");   // 髪は頭のボクセルと同じ格子
  };
  buildHair(o.hairNo);

  // --- 背番号（胴の背面 = ボクセル空間の -Z 側。骨組みごとヨーするので1枚でよい） ---
  let zBack = 0.13, yLo = 0.12, yHi = 0.36;
  const torso = bodyData(variant).parts.torso;
  if (torso?.voxels.length) {
    const tv = applyStretch(torso.voxels, st.torso ?? zero);
    let zmax = -Infinity, ymin = Infinity, ymax = -Infinity;
    for (const v of tv) {
      if (v[2] > zmax) zmax = v[2];
      if (v[1] < ymin) ymin = v[1];
      if (v[1] > ymax) ymax = v[1];
    }
    zBack = (zmax + 1) * VOX_SIZE * 0.66;              // 背中側の曲率半径（胴の奥行きの内側）
    yLo = (ymin + (ymax - ymin) * 0.40) * VOX_SIZE;
    yHi = (ymin + (ymax - ymin) * 0.84) * VOX_SIZE;
  }
  const numTex = new DynamicTexture(`voxnum_${o.name}`, { width: 128, height: 128 }, scene, false);
  numTex.hasAlpha = true;
  const numMat = makeMat(scene, `voxnummat_${o.name}`, {
    emissive: new Color3(1, 1, 1), unlit: true, cull: false,
  });
  numMat.diffuseTexture = numTex;
  numMat.opacityTexture = numTex;
  const drawNumber = (text: string, color: string): void => {
    const ctx = numTex.getContext() as unknown as CanvasRenderingContext2D;
    ctx.clearRect(0, 0, 128, 128);
    ctx.fillStyle = color;
    ctx.font = "bold 88px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, 64, 68);
    numTex.update();
  };
  drawNumber(o.jerseyText, "white");
  const numShell = makeNumberShell(scene, `voxnumshell_${o.name}`, zBack + 0.012, yHi, yLo);
  numShell.material = numMat;
  numShell.isVisible = false;   // Game が背中側を選ぶ（setNumberSide）まで出さない
  const spine = rig.node("Spine");
  if (spine) numShell.parent = spine;

  // --- 寸法の実測（IK・着席・肩の位置に使う） ---
  const sh = rig.restPosition("LeftUpperArm") ?? new Vector3(-0.12, 1.4, 0);
  const el = rig.restPosition("LeftLowerArm") ?? sh;
  const wr = rig.restPosition("LeftHand") ?? el;
  const hip = rig.restPosition("LeftUpperLeg") ?? new Vector3(0, 0.95, 0);

  // ⚠️ 手首ボーンは前腕の中ほどに立っていて、手のボクセルはそこから外へ 0.14〜0.32m
  //    はみ出す（objcts 側の既知のズレ）。IK が手のひらをボールに乗せられるよう、
  //    「肘 → 手のひらの中心」を前腕の実効長とし、その向きが前腕の軸（-Y）に乗るよう
  //    前腕へ補正回転を掛ける。
  const foreLen = Vector3.Distance(el, wr);
  const palmFix = (side: "L" | "R"): { len: number; k: Quaternion } => {
    const pd = bodyData(variant).parts[`hand${side}`];
    if (!pd?.voxels.length) return { len: foreLen, k: Quaternion.Identity() };
    let cx = 0, cy = 0, cz = 0;
    for (const v of pd.voxels) { cx += v[0]; cy += v[1]; cz += v[2]; }
    const n = pd.voxels.length;
    // 手のボクセルは手ローカル。前腕ローカルへ持ち替える（手ノードは回転しない＝親に付く）
    const conv = rr(`foreArm${side}`).conjugate().multiply(rr(`hand${side}`));
    const c = new Vector3((cx / n + 0.5) * VOX_SIZE, (cy / n + 0.5) * VOX_SIZE, (cz / n + 0.5) * VOX_SIZE)
      .applyRotationQuaternion(conv);
    const eff = new Vector3(0, -foreLen, 0).add(c);
    const len = eff.length();
    if (len < 1e-4) return { len: foreLen, k: Quaternion.Identity() };
    const d = eff.scale(1 / len);
    // d → (0,-1,0) の最短回転
    const dot = -d.y;
    if (dot > 0.9999) return { len, k: Quaternion.Identity() };
    const ax = new Vector3(d.z, 0, -d.x);          // cross(d, (0,-1,0))
    const al = ax.length() || 1;
    return { len, k: Quaternion.RotationAxis(ax.scale(1 / al), Math.acos(Math.max(-1, Math.min(1, dot)))) };
  };
  const fixL = palmFix("L"), fixR = palmFix("R");

  // --- ボーンごとの回転の読み替え（部位 / 親の部位）---
  const CHAIN: [string, string, string | null][] = [
    ["Hips", "hips", null],
    ["Spine", "torso", "hips"],
    ["Head", "head", "torso"],
    ["LeftUpperArm", "upperArmL", "torso"], ["RightUpperArm", "upperArmR", "torso"],
    ["LeftLowerArm", "foreArmL", "upperArmL"], ["RightLowerArm", "foreArmR", "upperArmR"],
    ["LeftHand", "handL", "foreArmL"], ["RightHand", "handR", "foreArmR"],
    ["LeftUpperLeg", "thighL", "hips"], ["RightUpperLeg", "thighR", "hips"],
    ["LeftLowerLeg", "shinL", "thighL"], ["RightLowerLeg", "shinR", "thighR"],
    ["LeftFoot", "footL", "shinL"], ["RightFoot", "footR", "shinR"],
  ];
  const map = new Map<string, BoneMap>();
  for (const [b, part, parent] of CHAIN) {
    // 前腕だけは「手のひらを前腕の軸に乗せる」補正を後段へ挟む
    const k = b === "LeftLowerArm" ? fixL.k : b === "RightLowerArm" ? fixR.k : null;
    const post = rr(part).conjugate();
    map.set(b, {
      bone: b as StandardBoneName,
      pre: parent ? rr(parent) : Quaternion.Identity(),
      post: k ? k.multiply(post) : post,
    });
  }
  // 仮想側に対応するノードが無いボーン（腰・手・足）は親にそのまま付いていくのが正しい
  // （回転を入れると、その部位の焼き込み向きが二重に効いてズレる）。
  for (const b of ["Hips", "LeftHand", "RightHand", "LeftFoot", "RightFoot"]) {
    const n = rig.node(b as StandardBoneName);
    if (n) n.rotationQuaternion = Quaternion.Identity();
  }
  const spineNode = rig.node("Spine");
  const spineRest = spineNode ? spineNode.position.clone() : Vector3.Zero();
  const hipsNode = rig.node("Hips");
  const hipsRest = hipsNode ? hipsNode.position.clone() : Vector3.Zero();

  // 素体＋ユニフォーム＋髪をひとつの配列で持ち、作り直したら中身を入れ替える
  const meshes: Mesh[] = [];
  const shadowMeshes: Mesh[] = [];
  const refreshMeshList = (): void => {
    meshes.length = 0;
    meshes.push(...skin, ...uniform);
    if (hair) meshes.push(hair);
    shadowMeshes.length = 0;
    shadowMeshes.push(...uniform);
    shadowHook?.(shadowMeshes);
  };

  const body: VoxelBody = {
    root, rig, skel, map, spineRest, hipsRest, meshes, shadowMeshes,
    variant, height,
    shoulder: { x: sh.x, y: sh.y, z: sh.z },
    hipY: hip.y,
    upperArm: Vector3.Distance(sh, el),
    foreArm: (fixL.len + fixR.len) / 2,
    setSkinColor: (c) => {
      const b = skinBaseColor(variant);
      skinMat.unfreeze();
      skinMat.diffuseColor = new Color3(
        b[0] ? c.r / (b[0] / 255) : 1, b[1] ? c.g / (b[1] / 255) : 1, b[2] ? c.b / (b[2] / 255) : 1);
      skinMat.freeze();
    },
    setHairColor: (c) => { hairMat.unfreeze(); hairMat.diffuseColor = new Color3(c.r, c.g, c.b); hairMat.freeze(); },
    setHairStyle: (s) => { buildHair(s); refreshMeshList(); },
    setKit: (k) => { buildUniform(k); refreshMeshList(); },
    setJerseyText: drawNumber,
    setNumberVisible: (v) => { numShell.isVisible = v; },
    dispose: () => {
      for (const m of skin) m.dispose();
      for (const m of uniform) m.dispose();
      hair?.dispose();
      numShell.dispose();
      numTex.dispose();
      skel.dispose();
      rig.dispose();
      root.dispose();
    },
  };
  body.setSkinColor(o.skin);
  body.setHairColor(o.hair);
  refreshMeshList();
  return body;
}

// ───────────────────────── 姿勢の転写 ─────────────────────────

const _q = new Quaternion();
const _d = new Vector3();
const _axis = new Vector3();
const DOWN = new Vector3(0, -1, 0);
const UP = new Vector3(0, 1, 0);

/** ノードの実効ローカル回転（rotationQuaternion 優先、無ければ Euler）。 */
function localQuat(n: TransformNode, out: Quaternion): Quaternion {
  if (n.rotationQuaternion) return out.copyFrom(n.rotationQuaternion);
  return Quaternion.FromEulerAnglesToRef(n.rotation.x, n.rotation.y, n.rotation.z, out);
}

/** Ry(π) による共役変換（軸の X/Z を反転）。前方が -Z 側のときの読み替え。 */
function flipQ(q: Quaternion): Quaternion {
  q.x = -q.x; q.z = -q.z;
  return q;
}

const _old = new Quaternion();

/**
 * 腕が胴へ埋まらないよう、上腕の外向き角に下限を掛ける。
 *
 * ⚠️ **上腕だけを外へ振り、前腕は元の向き（休めなら鉛直）のまま残す。** そのために
 * 「前腕へ掛ける打ち消し回転」`cancel = 上腕の新しい向き⁻¹ ⊗ 元の向き` を返す。
 * 打ち消さないと前腕も一緒に外へ流れ、脇を開いて手が体から離れた形になる。
 */
function splayArm(q: Quaternion, side: number, cancel: Quaternion): void {
  _old.copyFrom(q);
  DOWN.rotateByQuaternionToRef(q, _d);
  if (_d.y < 0) {
    // ⚠️ 判定は「外向き成分」ではなく**水平方向の離れ量**。前へ伸ばした腕（走りの
    //    腕振り・ボールへのリーチ）は既に胴から外れているので触ってはいけない。
    //    外向きだけで見ると IK が解いた手先を後から外へ押し出してしまう
    //    （実測: 手のひらが狙いから 0.15m 外れ、両手の間隔が 0.57m に開いた）。
    const horiz = Math.hypot(_d.x, _d.z);
    const need = Math.tan(MIN_ARM_SPLAY) * -_d.y;
    if (horiz < need) {
      // 前後(z)はそのまま、外向き(x)だけ足して水平量を need にする
      _d.x = side * Math.sqrt(Math.max(0, need * need - _d.z * _d.z));
      _d.normalize();
      // (0,-1,0) → _d の最短回転
      const dot = -_d.y;
      if (dot > 0.9999) q.copyFromFloats(0, 0, 0, 1);
      else {
        const ax = -_d.z, az = _d.x;               // cross((0,-1,0), _d)
        const al = Math.hypot(ax, az) || 1;
        _axis.set(ax / al, 0, az / al);
        Quaternion.RotationAxisToRef(_axis, Math.acos(Math.max(-1, Math.min(1, dot))), q);
      }
    }
  }
  cancel.copyFrom(q);
  cancel.conjugateInPlace();
  cancel.multiplyInPlace(_old);
}

export interface VirtualPose {
  numberSide: number;
  torsoYaw: number; torsoPitch: number; torsoOffsetY: number; torsoOffsetZ: number;
  headYaw: number; headPitch: number;
  armL: TransformNode; armR: TransformNode;
  elbowL: TransformNode; elbowR: TransformNode;
  ikL: boolean; ikR: boolean;
  hipL: TransformNode; hipR: TransformNode;
  kneeL: TransformNode; kneeR: TransformNode;
}

const _out = new Quaternion();

/** 仮想の回転 V を、そのボーンのノード回転へ変換して書き込む。 */
function put(vb: VoxelBody, bone: string, v: Quaternion): void {
  const n = vb.rig.node(bone as StandardBoneName);
  const m = vb.map.get(bone);
  if (!n || !m) return;
  m.pre.multiplyToRef(v, _out);
  _out.multiplyToRef(m.post, _out);
  if (n.rotationQuaternion) n.rotationQuaternion.copyFrom(_out);
  else n.rotationQuaternion = _out.clone();
  n.markAsDirty("rotationQuaternion");
}

const _cancelL = new Quaternion(), _cancelR = new Quaternion();

/** 腕（上腕2本＋前腕2本）を転写する。上腕の外向き補正は前腕で打ち消す。 */
function putArms(vb: VoxelBody, back: boolean, armL: TransformNode, armR: TransformNode,
                 elbowL: TransformNode, elbowR: TransformNode, ikL = false, ikR = false,
                 only: "L" | "R" | null = null): void {
  // ボクセル側の Left は、numberSide が +1（骨組みを180°回している）のとき仮想の R。
  // only を渡すと、その仮想側の腕だけを上書きする（反対はクリップの腕を残す）。
  const doLeftBone = !only || only === (back ? "R" : "L");
  const doRightBone = !only || only === (back ? "L" : "R");
  if (doLeftBone) {
  localQuat(back ? armR : armL, _q);
  if (back) flipQ(_q);
  if (back ? ikR : ikL) _cancelL.copyFromFloats(0, 0, 0, 1); else splayArm(_q, -1, _cancelL);
  put(vb, "LeftUpperArm", _q);
  }

  if (doRightBone) {
  localQuat(back ? armL : armR, _q);
  if (back) flipQ(_q);
  if (back ? ikL : ikR) _cancelR.copyFromFloats(0, 0, 0, 1); else splayArm(_q, 1, _cancelR);
  put(vb, "RightUpperArm", _q);
  }

  if (doLeftBone) {
  localQuat(back ? elbowR : elbowL, _q);
  if (back) flipQ(_q);
  _cancelL.multiplyToRef(_q, _q);
  put(vb, "LeftLowerArm", _q);
  }

  if (doRightBone) {
  localQuat(back ? elbowL : elbowR, _q);
  if (back) flipQ(_q);
  _cancelR.multiplyToRef(_q, _q);
  put(vb, "RightLowerArm", _q);
  }
}

/** 腕だけを転写する（クリップで脚・体幹を動かした後に上書きする用）。 */
export function syncVoxelArms(vb: VoxelBody, p: {
  numberSide: number; armPivotL: TransformNode; armPivotR: TransformNode;
  elbowL: TransformNode; elbowR: TransformNode; ikL: boolean; ikR: boolean;
}, only: "L" | "R" | null = null): void {
  putArms(vb, p.numberSide > 0, p.armPivotL, p.armPivotR, p.elbowL, p.elbowR, p.ikL, p.ikR, only);
}

/** 胸・頭のヨーを、いま入っている回転（クリップのツイスト等）の上に重ねる。 */
export function syncVoxelHeadTorso(
  vb: VoxelBody, numberSide: number, torsoYaw: number, headYaw: number,
  tmpA: Quaternion, tmpB: Quaternion,
): void {
  vb.root.rotation.y = numberSide > 0 ? Math.PI : 0;
  const spine = vb.rig.node("Spine");
  // ⚠️ クリップ再生は Spine の位置を触らない。手続きポーズ（溜め・落胆）が入れた
  //    腰ヒンジのオフセットが残ると、上半身が腰からずれたまま固まる。
  if (spine) spine.position.copyFrom(vb.spineRest);
  if (spine?.rotationQuaternion) {
    Quaternion.RotationAxisToRef(UP, torsoYaw, tmpA);
    tmpA.multiplyToRef(spine.rotationQuaternion, spine.rotationQuaternion);
  }
  const head = vb.rig.node("Head");
  if (head?.rotationQuaternion) {
    Quaternion.RotationAxisToRef(UP, headYaw, tmpB);
    tmpB.multiplyToRef(head.rotationQuaternion, head.rotationQuaternion);
  }
}

/** 仮想の関節ノードの姿勢を、ボクセルの標準ボーンへ流し込む（毎フレーム）。 */
export function syncVoxelPose(vb: VoxelBody, p: VirtualPose): void {
  const back = p.numberSide > 0;          // 前方が -Z → 骨組みを180°回して読み替える
  vb.root.rotation.y = back ? Math.PI : 0;
  const s = back ? -1 : 1;

  Quaternion.FromEulerAnglesToRef(p.torsoPitch * s, p.torsoYaw, 0, _q);
  put(vb, "Spine", _q);
  const spine = vb.rig.node("Spine");
  if (spine) {
    spine.position.set(vb.spineRest.x, vb.spineRest.y + p.torsoOffsetY,
      vb.spineRest.z + p.torsoOffsetZ * s);
  }
  // クリップの接地合わせが Hips を上下させるので、手続きポーズへ戻すときは静止位置へ復帰
  const hips = vb.rig.node("Hips");
  if (hips) hips.position.copyFrom(vb.hipsRest);
  Quaternion.FromEulerAnglesToRef(p.headPitch * s, p.headYaw, 0, _q);
  put(vb, "Head", _q);

  // 腕・脚。numberSide が +1 のときは骨組みを180°回しているので、左右を入れ替えて
  // 回転も Ry(π) で共役変換する。
  putArms(vb, back, p.armL, p.armR, p.elbowL, p.elbowR, p.ikL, p.ikR);
  const legs: [string, TransformNode][] = [
    ["LeftUpperLeg", back ? p.hipR : p.hipL],
    ["RightUpperLeg", back ? p.hipL : p.hipR],
    ["LeftLowerLeg", back ? p.kneeR : p.kneeL],
    ["RightLowerLeg", back ? p.kneeL : p.kneeR],
  ];
  for (const [name, src] of legs) {
    localQuat(src, _q);
    if (back) flipQ(_q);
    put(vb, name, _q);
  }
}
