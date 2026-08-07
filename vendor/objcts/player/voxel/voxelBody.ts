// リグ付きボクセルアバター（game-assets/vox-model）から作った部位別ボクセルを、
// ゲームのメッシュに組み立てる。データは tools/build-voxel-parts.mjs が生成した
// src/data/voxel/body-*.json（3cmボクセル・部位ごと・回転中心からの相対座標）。
//
// 体格はベイク済みの3体型（skinny/normal/muscle）から選び、身長はボクセル層の
// 挿入/削除で出す（スケールで潰すと立方体でなくなるため）。
import { Mesh, VertexData, Scene } from "@babylonjs/core";
import bodySkinny from "./data/body-skinny.json";
import bodyNormal from "./data/body-normal.json";
import bodyMuscle from "./data/body-muscle.json";
import clothSkinny from "./data/cloth-skinny.json";
import clothNormal from "./data/cloth-normal.json";
import clothMuscle from "./data/cloth-muscle.json";
import hairData from "./data/hair.json";

export type BodyVariant = "skinny" | "normal" | "muscle";
/** 握り具合 0..1（0 = 指を広げた状態 / 1 = 握った状態）。handL / handR にのみ効く。
 *  段階は焼き込んであるので、一番近い段へ丸められる（既定 4 段）。 */
export type HandCurl = number;
/** パレットの色の役割。チームカラー・肌・髪で塗り替えるために使う。
 *  const enum にすると isolatedModules の利用側から参照できないので、通常の定数で持つ。 */
export const VoxRole = { Skin: 0, Hair: 1, Jersey: 2, Shorts: 3, Shoes: 4, Face: 5 } as const;
export type VoxRole = (typeof VoxRole)[keyof typeof VoxRole];

type PartData = { pivot: number[]; restRot?: number[]; voxels: number[][] };
type BodyData = {
  voxelSize: number; source: string; height: number;
  /** 握り具合ごとの手（handL / handR のみ）。handCurls と同じ並び。開き(0)は parts 側。 */
  hands?: Record<string, PartData[]>;
  handCurls?: number[];
  /** 顔の部品（目・眉・口）。形ごとに「顔の面に塗る (x, y, 色index)」の並びを持つ。 */
  face?: Record<string, { styles: string[]; paint: number[][][] }>;
  joints: Record<string, number[]>;
  palette: number[][];              // [r, g, b, role]
  parts: Record<string, PartData>;
};

const DATA: Record<BodyVariant, BodyData> = {
  skinny: bodySkinny as BodyData,
  normal: bodyNormal as BodyData,
  muscle: bodyMuscle as BodyData,
};

/** ボディバランス(0..100) → 体型。現行の胴の厚み（65以下は一律細い）と同じ刻み。 */
export function variantFor(balance: number): BodyVariant {
  if (balance <= 55) return "skinny";
  if (balance >= 80) return "muscle";
  return "normal";
}

export function bodyData(v: BodyVariant): BodyData { return DATA[v]; }
export const VOX_SIZE = DATA.normal.voxelSize;

// ───────────────────────── ユニフォーム ─────────────────────────
//
// 服は**着る人の体に合わせて作る**。元アセットはその体型に着せた状態で作られているので、
// 同じ体型の服を素体と同じだけ伸縮させれば、元の着こなしのまま身長・体格に追従する。
//
// ⚠️ 以前は「規格サイズ（SS〜3L）を選んで着せる」方式だったが、サイズの基準体が別体型
// （2L/3L は muscle）なので、細い高身長の選手が筋肉質用の服を着てぶかぶかになった
// （実測: skinny 2.10m が 3L で、胴の半径が 0.136m 余る＝直径で27cm）。
// サイズは**表示用のラベル**として残してあるだけで、見た目の寸法には効かない。

const CLOTH: Record<BodyVariant, BodyData> = {
  skinny: clothSkinny as BodyData,
  normal: clothNormal as BodyData,
  muscle: clothMuscle as BodyData,
};

/** その体型に着せてある服。 */
export function uniformData(v: BodyVariant): BodyData { return CLOTH[v]; }

/**
 * ズボンの幅の効き。1 = 体と同じだけ太くなる / 0 = 幅は変えない。
 * バスケのショーツは元から余裕のある作りなので、体と同じ比率で太らせると
 * 大柄なときに極端に大きく見える。丈（縦）はこの係数を掛けず、脚の長さに
 * ついていかせる（裾の位置を保つため）。
 */
export const SHORTS_WIDTH_SCALE = 0.45;

/**
 * 体の「太さ」の倍率（身長と幅指数から解いた値）。
 * ⚠️ スキニングは骨の**長さ**しか伝えないので、スキン付きの服はこれを別途掛けないと
 * 体が太くなったときに服からはみ出す（実測: 身長2.10mで素体の胴 0.400m に対し
 * 服は 0.370m 相当のままだった）。
 */
export function bodyWidthFactor(
  v: BodyVariant, height: number, widthExponent = DEFAULT_WIDTH_EXPONENT,
): number {
  return solveShape(v, height, widthExponent, DEFAULT_HEAD_EXPONENT).kh;
}

/**
 * 服に掛ける伸縮。**素体と同じ体型・身長・幅指数**で解くので、そのまま重ねれば合う。
 *
 * 縦は素体と同じ層数（関節の間隔から出るので服も体も同じ）。
 * 横は**服そのものの幅**から出す（素体の幅で出すと服の伸び方がずれる）。
 * ズボンだけは横の効きを `SHORTS_WIDTH_SCALE` で緩める。
 */
const UNIFORM_STRETCH = new Map<string, Record<string, PartStretch>>();
export function uniformStretch(
  v: BodyVariant, height: number, widthExponent = DEFAULT_WIDTH_EXPONENT,
  role: VoxRole | null = null,
): Record<string, PartStretch> {
  const key = `${v}|${height.toFixed(3)}|${widthExponent}|${role ?? ""}`;
  let out = UNIFORM_STRETCH.get(key);
  if (!out) {
    const cloth = CLOTH[v];
    const wide = role === VoxRole.Shorts ? SHORTS_WIDTH_SCALE : 1;
    const { stretch, kh, khead } = solveShape(v, height, widthExponent, DEFAULT_HEAD_EXPONENT);
    out = {};
    for (const part of BODY_PARTS) {
      const e = partExtent(v, part, cloth);
      const k = part === "head" ? khead : kh;
      out[part] = {
        x: Math.round(e.x * (k - 1) * wide),
        y: SEGMENTS[part] ? stretch[part].y : Math.round(e.y * (k - 1)),
        z: Math.round(e.z * (k - 1) * wide),
      };
    }
    UNIFORM_STRETCH.set(key, out);
  }
  return out;
}

// ───────────────────── 規格サイズ（表示用のラベル） ─────────────────────

export type UniformSize = "SS" | "S" | "M" | "L" | "2L" | "3L";

/**
 * 規格サイズの基準体。`uniformSizeFor` が「この選手はどのサイズ相当か」を答えるための
 * 目盛りで、**見た目の寸法には効かない**（服は体に合わせて作る）。
 * SS / M / 3L は指定された基準（一番細い体 / 中間 / 一番大きい体）、S / L / 2L はその補間。
 */
export const SIZE_SPEC: Record<UniformSize, {
  variant: BodyVariant; height: number; widthExponent: number;
}> = {
  SS: { variant: "skinny", height: 1.50, widthExponent: 0 },
  S: { variant: "skinny", height: 1.60, widthExponent: 0.25 },
  M: { variant: "normal", height: 1.70, widthExponent: 0.5 },
  L: { variant: "normal", height: 1.90, widthExponent: 0.67 },
  "2L": { variant: "muscle", height: 2.10, widthExponent: 0.83 },
  "3L": { variant: "muscle", height: 2.30, widthExponent: 1 },
};
/** 小さい順。 */
export const UNIFORM_SIZES: UniformSize[] = ["SS", "S", "M", "L", "2L", "3L"];

/** その体の「大きさ」。サイズのラベル付けのために比べる寸法（m）を並べたもの。 */
function bodyEnvelope(v: BodyVariant, height: number, widthExponent: number): number[] {
  const { joints, stretch } = solveShape(v, height, widthExponent, DEFAULT_HEAD_EXPONENT);
  const dim = (part: string, axis: "x" | "z"): number =>
    (partExtent(v, part)[axis] + stretch[part][axis]) * VOX_SIZE;
  const dist = (a: string, b: string): number => {
    const p = joints[a], q = joints[b];
    return p && q ? Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) : 0;
  };
  return [
    dim("torso", "x"), dim("torso", "z"),          // 胸まわり
    dim("hips", "x"), dim("hips", "z"),            // 腰まわり
    dim("thighL", "x"), dim("upperArmL", "x"),     // 腿・上腕の太さ
    dist("spine", "neck"),                          // 着丈
    dist("hipL", "kneeL"), dist("shoulderL", "elbowL"),
  ];
}

/**
 * その体が相当する規格サイズの**ラベル**。小さい順に見て、全ての寸法で体を上回る
 * 最初のサイズを返す。どれも足りなければ一番大きいサイズ。
 * ⚠️ 表示用。実際の服の寸法は `uniformStretch` が体に合わせて決める。
 */
export function uniformSizeFor(
  v: BodyVariant, height: number, widthExponent = DEFAULT_WIDTH_EXPONENT,
): UniformSize {
  const body = bodyEnvelope(v, height, widthExponent);
  for (const size of UNIFORM_SIZES) {
    const spec = SIZE_SPEC[size];
    const ref = bodyEnvelope(spec.variant, spec.height, spec.widthExponent);
    if (body.every((b, i) => ref[i] >= b - VOX_SIZE * 0.5)) return size;
  }
  return UNIFORM_SIZES[UNIFORM_SIZES.length - 1];
}

/**
 * 部位メッシュの静止回転 [x, y, z, w]。
 *
 * ボクセルは「骨が -Y」の骨ローカルで持っている（伸縮を骨方向へ正しく効かせるため）。
 * 表示するときはこの回転を掛けて、**元モデルの角度**へ戻す。
 * 掛け忘れると腕が真下を向き、肩の回転中心が体の内側にあるせいで胴と腰を貫く。
 *
 * ⚠️ **身長に依存しない**。3体型は同じスケルトンから焼いているので値も共通
 * （実測: 体型間の差は最大0.18°＝丸め誤差）。だから `solveOnce` で関節の向きを
 * 身長で曲げてはいけない（曲げると部位がずれる）。
 */
export function partRestRotation(part: string, cloth?: BodyVariant): [number, number, number, number] {
  const src = cloth ? CLOTH[cloth] : DATA.normal;
  const r = src.parts[part]?.restRot;
  return r ? [r[0], r[1], r[2], r[3]] : [0, 0, 0, 1];
}

// ───────────────── このボクセルが焼かれたときの静止姿勢 ─────────────────
//
// ⚠️ 部位の形は「元モデルの静止姿勢」を基準に切り出してある。標準ボーン名が決めるのは
// **どの骨に付くか**だけで、**その骨がどこにあり・どちらを向くか**は決めない。
// 別の静止姿勢のリグ（例: 厳密なTポーズの Mixamo ybot）へそのまま付けると、姿勢差の
// ぶんだけズレる（実測: 元モデルは腕が斜め下、ybot は水平で、手首が 0.387m ずれた）。
// 正しく合わせるには、この静止姿勢で骨組みを作るか、リターゲットが要る。

/** データに埋め込まれた関節名 → 標準ボーン名。 */
const JOINT_TO_BONE: Record<string, string> = {
  root: "Hips", spine: "Spine", neck: "Neck", head: "Head",
  shoulderL: "LeftUpperArm", shoulderR: "RightUpperArm",
  elbowL: "LeftLowerArm", elbowR: "RightLowerArm",
  wristL: "LeftHand", wristR: "RightHand",
  hipL: "LeftUpperLeg", hipR: "RightUpperLeg",
  kneeL: "LeftLowerLeg", kneeR: "RightLowerLeg",
  ankleL: "LeftFoot", ankleR: "RightFoot",
};

/**
 * この体型のボクセルが前提としている静止姿勢（標準ボーン名・左手系・メートル）。
 * `rig.ts` の `buildRig` にそのまま渡せば、部位が関節どおりに繋がる。
 */
export function voxelRestPose(v: BodyVariant): {
  handedness: "left"; height: number; positions: Record<string, [number, number, number]>;
} {
  const d = DATA[v];
  const positions: Record<string, [number, number, number]> = {};
  for (const [j, bone] of Object.entries(JOINT_TO_BONE)) {
    const p = d.joints[j];
    if (p) positions[bone] = [p[0], p[1], p[2]];
  }
  return { handedness: "left", height: d.height, positions };
}

/**
 * 身長に対する体の幅（X/Z）の効かせ方。
 * 1 = 身長に完全比例（等身を保つ）。0 = 幅は変えない。
 * 既定 0.5 は「高身長ほど相対的に細身」という実際の選手の傾向に寄せた控えめな値。
 */
export const DEFAULT_WIDTH_EXPONENT = 0.5;

/**
 * 頭だけに使う倍率の指数。頭は身長ほど変わらない（背が高い人でも頭の実寸はほぼ同じ）。
 * 胴や手足と同じ指数にすると、身長を上げたとき頭まで一緒に大きくなって頭身が変わらない。
 * 1 = 身長に完全比例 / 0 = 頭の大きさを固定。
 */
export const DEFAULT_HEAD_EXPONENT = 0.25;

/** 身長 → 縦(ky)・幅(kh)・頭(khead)の倍率。骨組みとパーツが同じ数字を使うための唯一の出所。 */
function scaleFactors(v: BodyVariant, targetHeight: number, widthExponent: number, headExponent: number) {
  const ky = targetHeight / DATA[v].height;
  return { ky, kh: Math.pow(ky, widthExponent), khead: Math.pow(ky, headExponent) };
}

// 部位 → その部位が繋ぐ2関節（親→子）。標準姿勢では子は親の真下にある。
const SEGMENTS: Record<string, [string, string]> = {
  hips: ["root", "spine"], torso: ["spine", "neck"],
  upperArmL: ["shoulderL", "elbowL"], upperArmR: ["shoulderR", "elbowR"],
  foreArmL: ["elbowL", "wristL"], foreArmR: ["elbowR", "wristR"],
  thighL: ["hipL", "kneeL"], thighR: ["hipR", "kneeR"],
  shinL: ["kneeL", "ankleL"], shinR: ["kneeR", "ankleR"],
};
// 親の関節から順に降ろす連鎖（この順で解く）
const CHAINS: string[][] = [
  ["root", "spine", "neck", "head"],
  ["shoulderL", "elbowL", "wristL"], ["shoulderR", "elbowR", "wristR"],
  ["hipL", "kneeL", "ankleL"], ["hipR", "kneeR", "ankleR"],
];
const SEG_OF = new Map<string, string>();
for (const [part, [a, b]] of Object.entries(SEGMENTS)) SEG_OF.set(`${a}>${b}`, part);

/**
 * 身長・体格から「関節位置」と「部位ごとの伸縮層数」を**同時に**解く。
 *
 * 肝は、骨の間隔を連続スケールではなく**整数層から決める**こと。
 * こうすると「部位が伸びた量」と「関節が離れた量」が必ず一致するので、
 * サイズを変えても継ぎ目の重なり具合が変わらない＝隙間が開かない。
 *
 */
function solveShape(v: BodyVariant, targetHeight: number, widthExponent: number, headExponent: number): {
  joints: Record<string, [number, number, number]>;
  stretch: Record<string, PartStretch>;
  kh: number; khead: number;
} {
  // 頭と足は骨で挟まれていないので縦に伸びない。そのぶん全高が指定値からずれるため、
  // 「解いて → 実際の全高を測って → 倍率を補正」を数回繰り返して合わせ込む。
  // 層数は整数に丸まるので必ずしも収束しない。最後の試行ではなく**最も近い試行**を返す。
  let want = targetHeight;
  let out = solveOnce(v, want, widthExponent, headExponent);
  let best = out, bestErr = Math.abs(solvedHeight(v, out) - targetHeight);
  for (let i = 0; i < 6; i++) {
    const got = solvedHeight(v, out);
    if (!isFinite(got)) break;
    const err = Math.abs(got - targetHeight);
    if (err < bestErr) { bestErr = err; best = out; }
    if (err < VOX_SIZE * 0.5) break;
    want += targetHeight - got;
    out = solveOnce(v, want, widthExponent, headExponent);
  }
  return best;
}

/** 解いた結果の実際の全高（頭のてっぺん − 靴の底）。 */
function solvedHeight(
  v: BodyVariant, s: { joints: Record<string, [number, number, number]>; stretch: Record<string, PartStretch> },
): number {
  const head = partExtent(v, "head"), foot = partExtent(v, "footL");
  const hj = s.joints.head, aj = s.joints.ankleL;
  if (!hj || !aj) return NaN;
  // 頭は上へ、足は下へ伸びる（applyStretch と同じ判定）。縮むときも符号どおりに効く。
  const headTop = head.top + (s.stretch.head?.y ?? 0) * VOX_SIZE;
  // 床は素足の裏ではなく**靴の底**。素足の裏は靴の中にあり 0.02m 浮いているので、
  // それを床にすると身長が毎回そのぶん低く出て、合わせ込みが収束しない。
  // 靴はサイズごとに伸縮するが、基準としては元の服の靴底（体型によらず −0.006m）で足りる
  const shoe = partExtent(v, "footL", CLOTH[v]);
  const footBottom = Math.min(foot.bottom, shoe.bottom) - (s.stretch.footL?.y ?? 0) * VOX_SIZE;
  return (hj[1] + headTop) - (aj[1] + footBottom);
}

function solveOnce(v: BodyVariant, targetHeight: number, widthExponent: number, headExponent: number): {
  joints: Record<string, [number, number, number]>;
  stretch: Record<string, PartStretch>;
  kh: number; khead: number;
} {
  const d = DATA[v];
  const { ky, kh, khead } = scaleFactors(v, targetHeight, widthExponent, headExponent);
  const j0 = d.joints;

  // 各セグメントの伸縮層数（整数）と、伸ばしたあとの長さ
  const segLayers: Record<string, number> = {};
  const segLen: Record<string, number> = {};
  for (const [part, [a, b]] of Object.entries(SEGMENTS)) {
    const pa = j0[a], pb = j0[b];
    if (!pa || !pb) continue;
    const len0 = Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]);
    const n = Math.round((len0 * ky - len0) / VOX_SIZE);
    segLayers[part] = n;
    segLen[part] = len0 + n * VOX_SIZE;          // 連続スケールではなく整数層で決める
  }

  // 関節位置: 連鎖の根だけ倍率で置き、あとは整数長ぶん真下へ降ろす
  const joints: Record<string, [number, number, number]> = {};
  const put = (k: string): void => {
    const p = j0[k];
    if (p) joints[k] = [p[0] * kh, p[1] * ky, p[2] * kh];
  };
  for (const k of ["root", "shoulderL", "shoulderR", "hipL", "hipR"]) put(k);
  for (const chain of CHAINS) {
    for (let i = 1; i < chain.length; i++) {
      const prev = joints[chain[i - 1]];
      if (!prev) { put(chain[i]); continue; }
      const a0 = j0[chain[i - 1]], b0 = j0[chain[i]];
      if (!a0 || !b0) { put(chain[i]); continue; }
      const part = SEG_OF.get(`${chain[i - 1]}>${chain[i]}`);
      // 向きも長さも**元モデルのまま**にする（真下に揃えると腕が胴と腰を貫く）。
      // ⚠️ 軸ごとの倍率(kh/ky)で向きを曲げてはいけない。部位メッシュの静止回転
      // restRot は焼き込み済みで身長に依存しないので、関節だけ傾くと食い違う。
      // 実測: 身長2.25mで上腕の骨の向きが3.22°ずれ、肘が0.019m・手首が0.034m下へ。
      // 部位を持たない区間(首→頭)は長さも変えない。伸ばすと頭のメッシュの下端が
      // 胴の上端から離れて首に隙間が開く（部位の伸縮は中央で切るため下端が動かない）。
      const d = [b0[0] - a0[0], b0[1] - a0[1], b0[2] - a0[2]];
      const dl = Math.hypot(d[0], d[1], d[2]) || 1;
      const len = part && segLen[part] !== undefined ? segLen[part] : dl;
      joints[chain[i]] = [
        prev[0] + (d[0] / dl) * len,
        prev[1] + (d[1] / dl) * len,
        prev[2] + (d[2] / dl) * len,
      ];
    }
  }
  for (const k of Object.keys(j0)) if (!joints[k]) put(k);

  // 伸縮層数。X/Z は部位自身の幅から。Y は骨に挟まれた部位は骨の長さから、
  // 頭・足のように骨で挟まれていない部位は幅と同じ倍率で（横だけ広がるのを防ぐ）。
  // 頭だけは別の指数（khead）。身長に比例させると頭身が変わらず、背が高いほど
  // 頭も大きい違和感が出る。
  const stretch: Record<string, PartStretch> = {};
  for (const part of BODY_PARTS) {
    const e = partExtent(v, part);
    const k = part === "head" ? khead : kh;
    stretch[part] = {
      x: Math.round(e.x * (k - 1)),
      y: segLayers[part] ?? Math.round(e.y * (k - 1)),
      z: Math.round(e.z * (k - 1)),
    };
  }
  return { joints, stretch, kh, khead };
}

/**
 * この体型・身長の骨組みを組むための静止姿勢。
 * 縦は身長どおり、幅は `widthExponent` で効かせる。`partStretch` と同じ倍率を使うので、
 * 骨の間隔とボクセルの寸法が食い違わない。
 */
export function bodyRestPose(
  v: BodyVariant, targetHeight: number, widthExponent = DEFAULT_WIDTH_EXPONENT,
  headExponent = DEFAULT_HEAD_EXPONENT,
): ReturnType<typeof voxelRestPose> {
  const { joints } = solveShape(v, targetHeight, widthExponent, headExponent);
  const positions: Record<string, [number, number, number]> = {};
  for (const [j, bone] of Object.entries(JOINT_TO_BONE)) {
    const p = joints[j];
    if (p) positions[bone] = p;
  }
  return { handedness: "left", height: targetHeight, positions };
}

/** 部位の占有範囲（ボクセル数と、ピボットからの上下の伸び）。伸縮量と全高の計算に使う。 */
function partExtent(v: BodyVariant, part: string, from?: BodyData): {
  x: number; z: number; y: number; top: number; bottom: number;
} {
  const vox = (from ?? DATA[v]).parts[part]?.voxels;
  if (!vox || !vox.length) return { x: 0, z: 0, y: 0, top: 0, bottom: 0 };
  let lox = Infinity, hix = -Infinity, loz = Infinity, hiz = -Infinity, loy = Infinity, hiy = -Infinity;
  for (const p of vox) {
    if (p[0] < lox) lox = p[0]; if (p[0] > hix) hix = p[0];
    if (p[1] < loy) loy = p[1]; if (p[1] > hiy) hiy = p[1];
    if (p[2] < loz) loz = p[2]; if (p[2] > hiz) hiz = p[2];
  }
  return {
    x: hix - lox + 1, z: hiz - loz + 1, y: hiy - loy + 1,
    top: (hiy + 1) * VOX_SIZE, bottom: loy * VOX_SIZE,
  };
}

/**
 * 身長を変えたときに各部位を何層伸縮させるか（3軸）。
 *
 * Y は「その部位が繋ぐ2関節の距離の変化」から、X/Z は「部位自身の幅 × (幅の倍率-1)」から
 * 出す。倍率は `bodyRestPose` と共通なので、骨の間隔と部位の寸法が揃う。
 */
export function partStretch(
  v: BodyVariant, targetHeight: number, widthExponent = DEFAULT_WIDTH_EXPONENT,
  headExponent = DEFAULT_HEAD_EXPONENT,
): Record<string, PartStretch> {
  return solveShape(v, targetHeight, widthExponent, headExponent).stretch;
}

/** 色の差し替え。role ごとに RGB(0..1) を返す。null なら元の色のまま。 */
export type Recolor = (role: VoxRole, r: number, g: number, b: number) => [number, number, number] | null;

// ───────────────────────── 身長ぶんの層の伸縮 ─────────────────────────

/** 部位ごとの伸縮量（ボクセル層数）。正で伸ばす / 負で縮める。 */
export interface PartStretch { x: number; y: number; z: number }

/**
 * 指定軸に層を挿入(k>0)/削除(k<0)する。
 *
 * ⚠️ 挿す層は**端から端へ均等に配る**（＝量子化した拡大縮小）。1か所にまとめて挿すと、
 * その面より外側のセルが距離に関係なく同じ量だけ動く。部位ごとに面の位置も動く量も
 * 違うので、隣り合う部位が食い違い、**薄い服は継ぎ目で裂ける**
 * （実測: 3Lのショーツが53個の破片に割れていた）。
 *
 * keep はどちらの端を据え置くか。Y は関節側（手足なら上端、胴・腰なら下端）を据え置く。
 * X / Z は骨を中心に左右・前後へ均等に広げる。
 *
 * @param lo,hi 配分の基準にする占有範囲。**素体と服で必ず同じ値**を渡すこと。
 */
function stretchAxis(
  voxels: number[][], k: number, axis: 0 | 1 | 2, keep: "min" | "max" | "center",
  lo: number, hi: number,
): number[][] {
  if (k === 0 || hi < lo) return voxels;
  const span = hi - lo;
  const kk = Math.max(k, -span);           // 消え去らない範囲に縮小量を抑える
  if (kk === 0) return voxels;
  const shiftAt = (c: number): number => {
    const t = span === 0 ? 0 : Math.min(1, Math.max(0, (c - lo) / span));
    if (keep === "max") return -Math.round((1 - t) * kk);
    if (keep === "min") return Math.round(t * kk);
    return Math.round((t - 0.5) * kk);
  };
  const out: number[][] = [];
  for (const v of voxels) {
    const c = v[axis];
    const a = c + shiftAt(c);
    const n = Math.max(1, (c + 1 + shiftAt(c + 1)) - a);   // 空く層は複製で埋める
    for (let i = 0; i < n; i++) {
      const o = v.slice();
      o[axis] = a + i;
      out.push(o);
    }
  }
  return out;
}

/**
 * 3軸の伸縮をまとめて適用する。
 *
 * Y は「ピボット側の端を据え置いて、反対の端＝子関節側を動かす」。
 * 手足はピボット（付け根）から下へ伸びるので下端を動かし、胴と腰は上へ伸びるので上端を動かす。
 * これを取り違えると、伸ばすほど部位の端が子関節から離れて継ぎ目が開く。
 * X/Z は骨を中心に左右・前後へ均等に広げる。
 *
 * @param ref 伸ばす向きと切る位置を決める基準のボクセル。**服には素体を渡す**。
 *   服自身の占有範囲で決めると、服と素体で切る位置がずれて服が滑る
 *   （実測: 3Lで袖が腕に対して最大0.25m ずれ、素体が服から飛び出していた）。
 */
export function applyStretch(voxels: number[][], s: PartStretch, ref: number[][] = voxels): number[][] {
  const range = (axis: 0 | 1 | 2): [number, number] => {
    let lo = Infinity, hi = -Infinity;
    for (const v of ref) { if (v[axis] < lo) lo = v[axis]; if (v[axis] > hi) hi = v[axis]; }
    return hi < lo ? [0, 0] : [lo, hi];
  };
  const [ylo, yhi] = range(1);
  const hangsDown = Math.abs(ylo) > Math.abs(yhi);   // ピボットより下に伸びる部位か
  let out = voxels;
  out = stretchAxis(out, s.y, 1, hangsDown ? "max" : "min", ylo, yhi);
  out = stretchAxis(out, s.x, 0, "center", ...range(0));
  out = stretchAxis(out, s.z, 2, "center", ...range(2));
  return out;
}

// ───────────────────────── グリーディメッシュ化 ─────────────────────────

/** 占有(色付き)ボクセル → 露出面だけのメッシュ。同じ色・同じ向きの面を矩形へ結合する。 */
/** @param groups 省略可。頂点ごとに「その面の色index」を書き出す（スキニングで面の所属を知るため）。 */
/** スキニングの指定。table は buildParts が焼いた skinWeights（8個ずつ）、
 *  remap は「焼いたボーンindex → 使う側のボーンindex」。 */
export interface SkinBind { table: number[]; remap: number[] }

export function toVertexData(
  voxels: number[][], palette: number[][], recolor: Recolor | null, groups?: number[],
  skin?: SkinBind,
): VertexData {
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const v of voxels) for (let d = 0; d < 3; d++) {
    if (v[d] < lo[d]) lo[d] = v[d];
    if (v[d] > hi[d]) hi[d] = v[d];
  }
  const dims = [hi[0] - lo[0] + 1, hi[1] - lo[1] + 1, hi[2] - lo[2] + 1];
  // 0 = 空、それ以外は色index+1
  const cell = new Int32Array(dims[0] * dims[1] * dims[2]);
  const at = (x: number, y: number, z: number): number =>
    x < 0 || y < 0 || z < 0 || x >= dims[0] || y >= dims[1] || z >= dims[2]
      ? 0 : cell[(x * dims[1] + y) * dims[2] + z];
  for (const v of voxels) {
    cell[((v[0] - lo[0]) * dims[1] + (v[1] - lo[1])) * dims[2] + (v[2] - lo[2])] = v[3] + 1;
  }
  // 色index → RGB(0..1)
  const rgb = palette.map((p) => {
    const c = recolor?.(p[3] as VoxRole, p[0] / 255, p[1] / 255, p[2] / 255);
    return c ?? [p[0] / 255, p[1] / 255, p[2] / 255];
  });

  // --- スキニング: ボクセルの5番目 = ウェイト表のindex ---
  // ⚠️ 面はグリーディに結合されるので、面ではなく**頂点ごと**に、その角に接する
  //    最大8セルのウェイトを平均する。面単位にすると1枚の大きな面が肩から腰まで
  //    またいで剛体になり、結合を切ると三角形が数倍に増える。
  const wcell = skin ? new Int32Array(dims[0] * dims[1] * dims[2]).fill(-1) : null;
  if (wcell) {
    for (const v of voxels) {
      wcell[((v[0] - lo[0]) * dims[1] + (v[1] - lo[1])) * dims[2] + (v[2] - lo[2])] = v[4] ?? -1;
    }
  }
  const wAt = (x: number, y: number, z: number): number =>
    x < 0 || y < 0 || z < 0 || x >= dims[0] || y >= dims[1] || z >= dims[2]
      ? -1 : wcell![(x * dims[1] + y) * dims[2] + z];
  const acc = new Map<number, number>();
  const mIdx: number[] = [], mWgt: number[] = [];
  /** 格子の角 (cx,cy,cz)（lo 相対）に接するセルのウェイトを平均して積む。 */
  const pushWeights = (cx: number, cy: number, cz: number): void => {
    acc.clear();
    for (let dx = -1; dx <= 0; dx++) for (let dy = -1; dy <= 0; dy++) for (let dz = -1; dz <= 0; dz++) {
      const wi = wAt(cx + dx, cy + dy, cz + dz);
      if (wi < 0) continue;
      for (let s = 0; s < 4; s++) {
        const wt = skin!.table[wi * 8 + 4 + s];
        if (wt > 0) {
          const b = skin!.remap[skin!.table[wi * 8 + s]] ?? 0;
          acc.set(b, (acc.get(b) ?? 0) + wt);
        }
      }
    }
    const top = [...acc].sort((a, b) => b[1] - a[1]).slice(0, 4);
    const sum = top.reduce((t, e) => t + e[1], 0) || 1;
    for (let s = 0; s < 4; s++) mIdx.push(top[s]?.[0] ?? 0);
    for (let s = 0; s < 4; s++) mWgt.push(top[s] ? top[s][1] / sum : 0);
  };

  const positions: number[] = [], normals: number[] = [], colors: number[] = [], indices: number[] = [];
  for (let d = 0; d < 3; d++) {
    const u = (d + 1) % 3, w = (d + 2) % 3;
    const x = [0, 0, 0], q = [0, 0, 0];
    q[d] = 1;
    const mask = new Int32Array(dims[u] * dims[w]);
    for (x[d] = -1; x[d] < dims[d];) {
      let n = 0;
      for (x[w] = 0; x[w] < dims[w]; x[w]++)
        for (x[u] = 0; x[u] < dims[u]; x[u]++) {
          const a = at(x[0], x[1], x[2]);
          const b = at(x[0] + q[0], x[1] + q[1], x[2] + q[2]);
          // 表向き = +a、裏向き = -b。色が違う面は結合しない
          mask[n++] = a && !b ? a : !a && b ? -b : 0;
        }
      x[d]++;
      n = 0;
      for (let j = 0; j < dims[w]; j++) {
        for (let i = 0; i < dims[u];) {
          const c = mask[n];
          if (!c) { i++; n++; continue; }
          let qw = 1;
          while (i + qw < dims[u] && mask[n + qw] === c) qw++;
          let qh = 1;
          grow: while (j + qh < dims[w]) {
            for (let s = 0; s < qw; s++) if (mask[n + qh * dims[u] + s] !== c) break grow;
            qh++;
          }
          x[u] = i; x[w] = j;
          const du = [0, 0, 0], dw = [0, 0, 0];
          du[u] = qw; dw[w] = qh;
          const pt = (a: number[], b: number[]): number[] => [
            (lo[0] + x[0] + a[0] + b[0]) * VOX_SIZE,
            (lo[1] + x[1] + a[1] + b[1]) * VOX_SIZE,
            (lo[2] + x[2] + a[2] + b[2]) * VOX_SIZE];
          const Z = [0, 0, 0];
          // Babylonは左手系。表面は cross(e1,e2) が法線と逆を向く巻き方（透け防止）
          const corners = c > 0
            ? [pt(Z, Z), pt(Z, dw), pt(du, dw), pt(du, Z)]
            : [pt(Z, Z), pt(du, Z), pt(du, dw), pt(Z, dw)];
          const base = positions.length / 3;
          for (const v of corners) positions.push(v[0], v[1], v[2]);
          if (skin) {
            const cn = c > 0
              ? [[Z, Z], [Z, dw], [du, dw], [du, Z]]
              : [[Z, Z], [du, Z], [du, dw], [Z, dw]];
            for (const [a, b] of cn) {
              pushWeights(x[0] + a[0] + b[0], x[1] + a[1] + b[1], x[2] + a[2] + b[2]);
            }
          }
          const nrm = [0, 0, 0];
          nrm[d] = c > 0 ? 1 : -1;
          const col = rgb[Math.abs(c) - 1];
          for (let s = 0; s < 4; s++) {
            normals.push(nrm[0], nrm[1], nrm[2]);
            colors.push(col[0], col[1], col[2], 1);
            groups?.push(Math.abs(c) - 1);
          }
          indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
          for (let l = 0; l < qh; l++) for (let s = 0; s < qw; s++) mask[n + l * dims[u] + s] = 0;
          i += qw; n += qw;
        }
      }
    }
  }
  const vd = new VertexData();
  vd.positions = positions; vd.normals = normals; vd.colors = colors; vd.indices = indices;
  if (skin) { vd.matricesIndices = mIdx; vd.matricesWeights = mWgt; }
  return vd;
}

/**
 * ユニフォームの部位ボクセル（伸縮を当てたあと）。メッシュにせず配列で返す。
 * スキニングでは部位ごとにボーンへ付けず、静止姿勢のワールドへ並べて1つのメッシュに
 * まとめるので、呼び出し側が座標変換する。
 */
export function uniformVoxels(
  variant: BodyVariant, part: string, height: number, widthExponent: number,
): number[][] {
  const data = CLOTH[variant];
  const pd = data.parts[part];
  if (!pd || !pd.voxels.length) return [];
  const ref = DATA[variant].parts[part]?.voxels;
  const shorts: number[][] = [], rest: number[][] = [];
  for (const v of pd.voxels) (data.palette[v[3]][3] === VoxRole.Shorts ? shorts : rest).push(v);
  const sr = uniformStretch(variant, height, widthExponent)[part] ?? { x: 0, y: 0, z: 0 };
  const ss = uniformStretch(variant, height, widthExponent, VoxRole.Shorts)[part] ?? { x: 0, y: 0, z: 0 };
  return applyStretch(rest, sr, ref).concat(applyStretch(shorts, ss, ref));
}

/** 焼き込んだスキニングの表（ボーン名とウェイト）。 */
export function skinData(variant: BodyVariant, cloth = true): { bones: string[]; table: number[] } {
  const d = (cloth ? CLOTH : DATA)[variant] as unknown as { skinBones?: string[]; skinWeights?: number[] };
  return { bones: d.skinBones ?? [], table: d.skinWeights ?? [] };
}

// ───────────────────────── プロトタイプ共有 ─────────────────────────

const PROTO = new Map<string, Mesh>();
let protoTris = 0;
let buildMs = 0;

/** 実測用: プロトタイプ本数 / 三角形数 / 生成にかかった合計時間。 */
export function voxelBodyStats(): { count: number; tris: number; ms: number } {
  return { count: PROTO.size, tris: protoTris, ms: buildMs };
}

/** 作り置きを全部捨てる（色の定義を変えたときなど）。 */
export function clearVoxelBodyCache(): void {
  for (const m of PROTO.values()) m.dispose();
  PROTO.clear();
  protoTris = 0;
  buildMs = 0;
}

/** 握り具合を焼き込んである段へ丸める。開き(= parts 側)なら -1。 */
function handCurlStep(variant: BodyVariant, part: string, curl: HandCurl): number {
  const list = DATA[variant].hands?.[part];
  const curls = DATA[variant].handCurls;
  if (!list || !curls || !(curl > 0)) return -1;
  let best = -1, bd = Math.abs(curl);            // 開き(0)との差を初期値に
  for (let i = 0; i < curls.length; i++) {
    const d = Math.abs(curl - curls[i]);
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

/** 顔の部品の名前（"eye" / "brow" / "mouth"）。 */
export function faceFeatures(v: BodyVariant): string[] {
  return Object.keys(DATA[v].face ?? {});
}
/** その部品の形の種類の名前。 */
export function faceStyles(v: BodyVariant, feature: string): string[] {
  return DATA[v].face?.[feature]?.styles ?? [];
}
/** その部品・その形の「塗る点」（[x, y, 色index]。頭のボクセルと同じ格子）。 */
export function facePaint(v: BodyVariant, feature: string, style: number): number[][] {
  const f = DATA[v].face?.[feature];
  if (!f) return [];
  return f.paint[Math.max(0, Math.min(f.paint.length - 1, style))] ?? [];
}

/** 焼き込んである握り具合の段（0 = 開き は含まない）。 */
export function handCurlSteps(variant: BodyVariant): number[] {
  return DATA[variant].handCurls ?? [];
}

// ---------------------------------------------------------------- 髪型

interface HairStyle { name: string; n: number; o: number[]; d: number[]; b: string }
const HAIR = hairData as { size: number; color: number[]; styles: HairStyle[] };
const hairCache = new Map<number, number[][]>();

/** 髪型の名前（表示用）。番号は元データ（Man_Hair_NNN）のもの。 */
export function hairStyles(): string[] {
  return HAIR.styles.map((s) => `髪型 ${s.n}`);
}
/** 髪の色 [r, g, b]（0..255）。 */
export function hairColor(): number[] { return HAIR.color; }

/** 素体の基準になる肌の色 [r, g, b]（一番多く使われている肌色）。肌の塗り替えの基準に使う。 */
export function skinBaseColor(v: BodyVariant): number[] {
  const d = DATA[v];
  const n = new Map<number, number>();
  for (const p of Object.values(d.parts)) {
    for (const c of p.voxels) if (d.palette[c[3]][3] === VoxRole.Skin) n.set(c[3], (n.get(c[3]) ?? 0) + 1);
  }
  let best = 0, m = -1;
  for (const [i, c] of n) if (c > m) { m = c; best = i; }
  return d.palette[best].slice(0, 3);
}

/**
 * その髪型のボクセル（[x, y, z]。**頭のボクセルと同じ骨ローカル格子**）。
 * ⚠️ 髪は専用ツール(`tools/buildHair.mjs`)が 1cm 固定で焼くので、素体を別の辺長で
 *    焼き直したときはここで格子を合わせる。合わせないと髪だけ倍の大きさ・別位置になる。
 * ⚠️ 素直に並びで持つと 8.6MB になるので、箱の中のビットマスク(base64)で持っている。
 */
export function hairVoxels(style: number): number[][] {
  if (style < 0 || style >= HAIR.styles.length) return [];
  const hit = hairCache.get(style);
  if (hit) return hit;
  const s = HAIR.styles[style];
  const bin = atob(s.b);
  const [dx, dy, dz] = s.d;
  const out: number[][] = [];
  for (let i = 0, n = dx * dy * dz; i < n; i++) {
    if (!(bin.charCodeAt(i >> 3) & (1 << (i & 7)))) continue;
    const z = i % dz, y = ((i - z) / dz) % dy, x = (i - z - y * dz) / (dz * dy);
    out.push([s.o[0] + x, s.o[1] + y, s.o[2] + z]);
  }
  const k = HAIR.size / VOX_SIZE;
  const fit = k === 1 ? out : [...new Set(out.map((c) =>
    `${Math.round(c[0] * k)},${Math.round(c[1] * k)},${Math.round(c[2] * k)}`))]
    .map((s2) => s2.split(",").map(Number));
  hairCache.set(style, fit);
  return fit;
}

/**
 * 部位1つのメッシュを作る（ジオメトリはプロトタイプを clone で共有）。
 * 原点は部位の回転中心なので、対応するリグのノードへそのまま parent すればよい。
 * @param stretch Y方向に足す(正)/引く(負)ボクセル層数
 * @param colorKey 色の差し替えを識別する文字列（プロトタイプの共有単位になる）
 */
export function buildPartMesh(
  scene: Scene, variant: BodyVariant, part: string,
  stretch: PartStretch, colorKey: string, recolor: Recolor | null,
  handCurl: HandCurl = 0, hideUnderCloth = false,
): Mesh | null {
  const step = handCurlStep(variant, part, handCurl);
  const pd = step >= 0 ? DATA[variant].hands![part][step] : DATA[variant].parts[part];
  if (!pd || !pd.voxels.length) return null;
  const vox = hideUnderCloth ? uncoveredVoxels(variant, part, pd) : pd.voxels;
  if (!vox.length) return null;
  const tag = step >= 0 ? `${variant}|${part}#curl${step}` : `${variant}|${part}`;
  const bare = hideUnderCloth ? "#bare" : "";
  return meshFrom(scene, `${tag}${bare}|${stretch.x},${stretch.y},${stretch.z}|${colorKey}`,
    applyStretch(vox, stretch), DATA[variant].palette, recolor);
}

// ───────────────── 服の下の地肌を消す ─────────────────
//
// 素体は部位ごとの剛体、服はスキニングで別々に動くので、服の下に地肌を残すと
// 関節で地肌が服を突き抜ける。
// ⚠️ 描画順（renderingGroupId）で服を手前に出す方法は使えない。グループ間で深度が
// 消えるため、**奥の服が手前の腕より前に来てしまう**。

const qrotArr = (q: number[], v: number[]): number[] => {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
};

const CLOTH_CELLS = new Map<BodyVariant, Set<string>>();
/** 服が占めるセル（共通の格子・元モデルの静止姿勢）。 */
export function clothWorldCells(variant: BodyVariant): Set<string> {
  let set = CLOTH_CELLS.get(variant);
  if (set) return set;
  set = new Set<string>();
  for (const pd of Object.values(CLOTH[variant].parts)) {
    const q = pd.restRot ?? [0, 0, 0, 1];
    for (const v of pd.voxels) {
      const l = qrotArr(q, [(v[0] + 0.5) * VOX_SIZE, (v[1] + 0.5) * VOX_SIZE, (v[2] + 0.5) * VOX_SIZE]);
      const c = [0, 1, 2].map((i) => Math.round((pd.pivot[i] + l[i]) / VOX_SIZE - 0.5));
      set.add(`${c[0]},${c[1]},${c[2]}`);
    }
  }
  CLOTH_CELLS.set(variant, set);
  return set;
}

const DIRS6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const UNCOVERED = new Map<string, number[][]>();
/** その部位の、服に覆われていないボクセルだけ。 */
function uncoveredVoxels(variant: BodyVariant, part: string, pd: PartData): number[][] {
  const key = `${variant}|${part}`;
  const hit = UNCOVERED.get(key);
  if (hit) return hit;
  const cloth = clothWorldCells(variant);
  const q = pd.restRot ?? [0, 0, 0, 1];
  const out = pd.voxels.filter((v) => {
    const l = qrotArr(q, [(v[0] + 0.5) * VOX_SIZE, (v[1] + 0.5) * VOX_SIZE, (v[2] + 0.5) * VOX_SIZE]);
    const c = [0, 1, 2].map((i) => Math.round((pd.pivot[i] + l[i]) / VOX_SIZE - 0.5));
    // 6方向のうち3方向以上に、5セル以内で服があるものを「覆われている」とみなす。
    // ⚠️ 「服が隣接していたら消す」だと、袖口や襟の縁の地肌まで消えて穴が開く。
    let n = 0;
    for (const d of DIRS6) {
      for (let k = 1; k <= 5; k++) {
        if (cloth.has(`${c[0] + d[0] * k},${c[1] + d[1] * k},${c[2] + d[2] * k}`)) { n++; break; }
      }
    }
    return n < 3;
  });
  UNCOVERED.set(key, out);
  return out;
}

/**
 * ユニフォームの部位メッシュ。**素体と同じ体型・身長・幅指数**で作るので、
 * 同じ標準ボーン名へ取り付ければそのまま重なり、体格が変わっても余り方は変わらない。
 */
export function buildUniformMesh(
  scene: Scene, variant: BodyVariant, part: string, height: number,
  widthExponent: number, colorKey: string, recolor: Recolor | null,
): Mesh | null {
  const data = CLOTH[variant];
  const pd = data.parts[part];
  if (!pd || !pd.voxels.length) return null;
  // 伸縮の基準は素体。服自身で決めると素体に対して滑る
  const ref = DATA[variant].parts[part]?.voxels;
  // ズボンだけ横の効きが違うので、ロールで分けてから別々に伸ばす
  const shorts: number[][] = [], rest: number[][] = [];
  for (const v of pd.voxels) (data.palette[v[3]][3] === VoxRole.Shorts ? shorts : rest).push(v);
  const sr = uniformStretch(variant, height, widthExponent)[part] ?? { x: 0, y: 0, z: 0 };
  const ss = uniformStretch(variant, height, widthExponent, VoxRole.Shorts)[part] ?? { x: 0, y: 0, z: 0 };
  const vox = applyStretch(rest, sr, ref).concat(applyStretch(shorts, ss, ref));
  const key = `u${variant}|${part}|${sr.x},${sr.y},${sr.z}|${ss.x},${ss.z}|${colorKey}`;
  return meshFrom(scene, key, vox, data.palette, recolor);
}

function meshFrom(
  scene: Scene, key: string, voxels: number[][], palette: number[][], recolor: Recolor | null,
): Mesh | null {
  if (voxels.length === 0) return null;
  let proto = PROTO.get(key);
  if (!proto) {
    const t0 = performance.now();
    const vd = toVertexData(voxels, palette, recolor);
    buildMs += performance.now() - t0;
    if (!vd.positions || vd.positions.length === 0) return null;
    proto = new Mesh(`voxbody_${PROTO.size}`, scene);
    vd.applyToMesh(proto, false);
    proto.setEnabled(false);
    PROTO.set(key, proto);
    protoTris += (vd.indices as number[]).length / 3;
  }
  const m = proto.clone(`voxpart_${key.split("|")[1]}`, null, true);   // ジオメトリ共有
  m.setEnabled(true);
  return m;
}

/** 部位 → 取り付け先の**標準ボーン名**（standardSkeleton.ts の命名）。
 *  リグ固有の名前は持たない。実リグ名への解決は boneMapping の resolveAgainst に任せる。 */
export const PART_BONE: Record<string, string> = {
  head: "Head",
  torso: "Spine",
  hips: "Hips",
  upperArmL: "LeftUpperArm", upperArmR: "RightUpperArm",
  foreArmL: "LeftLowerArm", foreArmR: "RightLowerArm",
  thighL: "LeftUpperLeg", thighR: "RightUpperLeg",
  shinL: "LeftLowerLeg", shinR: "RightLowerLeg",
  footL: "LeftFoot", footR: "RightFoot",
  handL: "LeftHand", handR: "RightHand",
};

export const BODY_PARTS = Object.keys(PART_BONE);
