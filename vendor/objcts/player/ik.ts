/**
 * ik — 2ボーンIK（肩→肘→手 / 股→膝→足）の解析解。Babylon 非依存の層1。
 *
 * FK（humanRig の関節ルールで角度を指定 → 手先の位置は結果）に対し、IK は
 * **手先の目標位置から角度を逆算**する。ボールを掴む・床に足を着けるなど
 * 「接触が要る」動作はこちらでないと合わない。
 *
 * リグ規約を焼き込まない方針は humanRig と同じ:
 *   - 骨の静止方向は `restDir` で受け取る（「腕は -Y に垂れている」を前提にしない）
 *   - 回転は `quatFromTo(restDir, 目標方向)` の差分で作る
 *
 * 出典: basketball-sim `src/animation/action/reach-ik.ts` の `armIKQuats`
 * （実プロジェクトで稼働中の調整済み実装）を、リグ非依存へ一般化したもの。
 *
 * 座標系: 右手系・Y が鉛直上向き・単位はメートル。
 */
import { quatFromTo, quatMul, quatRotate, type Quat, type Vec3 } from "./humanRig";

/** 骨が静止姿勢で向いている既定方向。腕が体側へ垂れているリグの想定。 */
export const DEFAULT_REST_DIR: Vec3 = { x: 0, y: -1, z: 0 };

/** 伸ばし切る手前で止める割合。1.0 に近づけると肘が一直線になり棒に見える。 */
export const DEFAULT_MAX_EXTEND = 0.97;

export interface TwoBoneOptions {
  /** 根元（肩・股関節）の位置。target と同じ空間で渡す。 */
  root: Vec3;
  /** 手先（手首・足首）を置きたい位置。root と同じ空間。 */
  target: Vec3;
  /** 上の骨の長さ（肩→肘）。 */
  upperLen: number;
  /**
   * 下の骨の長さ（肘→手首）。
   *
   * 終端を手首より先（手のひら・指先・道具の先端）にしたいときは、その距離を足す。
   * ⚠️ **手が前腕と一直線であることが前提**。ybot リグでは前腕と手首→中指付け根の
   * 角度差が 0.00° なので厳密に成立する。解いた後は手の回転を単位にして、前腕の
   * 延長のままにすること。
   */
  lowerLen: number;
  /**
   * root/target の空間から、上の骨の**親ローカル**へ変換する Y 軸まわりの角度(rad)。
   * キャラクタの向き（＋胴のひねり）を渡す。既定 0 ＝ 同じ空間。
   *
   * ⚠️ **Y 軸回転しか吸収しない**。鎖骨や胸など祖先の骨が任意の3D回転をしていると
   * ワールドと親ローカルがずれ、手先が目標から外れる（実測 239mm）。その場合は
   * `root`/`target` を呼び出し側で親ローカルへ変換して渡し、`frameYaw` は 0 にする
   * （`restDir` は静止姿勢のローカル値のままでよい）。
   */
  frameYaw?: number;
  /** 上の骨の静止方向（親ローカル）。既定 -Y。 */
  restDir?: Vec3;
  /**
   * 下の骨の静止方向（**上の骨のローカル**）。既定は `restDir` と同じ。
   * 腕・脚は上下の骨が同じ向きに伸びているので通常は省略でよい。
   */
  restDirLower?: Vec3;
  /**
   * 極ベクトル。肘/膝をどちらへ張り出すかを決める（親ローカル）。既定 -Y ＝ 真下。
   * ⚠️ 真下だけにすると胸の前で手を合わせるとき肘が胴へ食い込む。外向き成分
   * （腕なら体の外側 ±X）を混ぜる。**肘の振り分けは手先の位置に影響しない**ので、
   * 外へ寄せても精度は落ちない。
   * ⚠️ 腕は**後ろ成分**も要る。「外側 + 下」だけだと肘が体の前へ回り込み、前腕の
   * 曲がりが逆に見える（実測: 56回中39回が肩→手の線より前）。`(±0.7, -1, -1.2)`
   * で前が 13% まで下がる。
   */
  pole?: Vec3;
  /** 伸ばし切る手前で止める割合。既定 {@link DEFAULT_MAX_EXTEND}。 */
  maxExtend?: number;
}

export interface TwoBoneSolution {
  /** 上の骨の回転（親ローカル）。 */
  upper: Quat;
  /** 下の骨の回転（上の骨のローカル）。 */
  lower: Quat;
  /** 解いた中間関節（肘・膝）の位置。root/target と同じ空間。表示・検証用。 */
  joint: Vec3;
}

/** この骨長で手先が届く最大距離。 */
export function reachLimit(upperLen: number, lowerLen: number, maxExtend = DEFAULT_MAX_EXTEND): number {
  return (upperLen + lowerLen) * maxExtend;
}

/** root から target が {@link reachLimit} 内か。 */
export function isWithinReach(o: TwoBoneOptions): boolean {
  const dx = o.target.x - o.root.x, dy = o.target.y - o.root.y, dz = o.target.z - o.root.z;
  const d = Math.hypot(dx, dy, dz);
  return d >= 1e-3 && d < reachLimit(o.upperLen, o.lowerLen, o.maxExtend ?? DEFAULT_MAX_EXTEND);
}

/**
 * 2ボーンIKを解く。手先が target に一致する上下2つの骨の回転を返す。
 *
 * 届かない（{@link reachLimit} 超え）／近すぎる（1mm 未満）場合は `null`。
 * 呼び出し側は FK（腕を目標方向へ向けるだけ）へフォールバックする。
 */
export function solveTwoBone(o: TwoBoneOptions): TwoBoneSolution | null {
  const UP = o.upperLen, LOW = o.lowerLen;
  const restDir = o.restDir ?? DEFAULT_REST_DIR;
  const pole = o.pole ?? DEFAULT_REST_DIR;
  const th = o.frameYaw ?? 0;
  const c = Math.cos(th), s = Math.sin(th);

  // root→target を親ローカルへ
  const wx = o.target.x - o.root.x, wy = o.target.y - o.root.y, wz = o.target.z - o.root.z;
  const rx = c * wx - s * wz, ry = wy, rz = s * wx + c * wz;
  const d = Math.hypot(rx, ry, rz);
  if (d >= reachLimit(UP, LOW, o.maxExtend ?? DEFAULT_MAX_EXTEND) || d < 1e-3) return null;
  const ux = rx / d, uy = ry / d, uz = rz / d;

  // 上の骨と root→target 線がなす角（余弦定理）
  const cosA = (UP * UP + d * d - LOW * LOW) / (2 * UP * d);
  const alpha = Math.acos(cosA < -1 ? -1 : cosA > 1 ? 1 : cosA);

  // 極ベクトルを root→target 線に直交射影して、肘の張り出し方向 n を得る
  const pd = pole.x * ux + pole.y * uy + pole.z * uz;
  let nx = pole.x - pd * ux, ny = pole.y - pd * uy, nz = pole.z - pd * uz;
  let nl = Math.hypot(nx, ny, nz);
  if (nl < 1e-4) { nx = 1; ny = 0; nz = 0; nl = 1; }   // 極が reach 線と平行 → 横へ逃がす
  nx /= nl; ny /= nl; nz /= nl;

  // 上の骨の方向 = cosα·û + sinα·n
  const ca = Math.cos(alpha), sa = Math.sin(alpha);
  const upDir: Vec3 = { x: ca * ux + sa * nx, y: ca * uy + sa * ny, z: ca * uz + sa * nz };
  // 下の骨の方向 = (target − 中間関節) を正規化
  const jx = upDir.x * UP, jy = upDir.y * UP, jz = upDir.z * UP;   // 親ローカルの中間関節
  const lowDir: Vec3 = { x: rx - jx, y: ry - jy, z: rz - jz };

  const upper = quatFromTo(restDir, upDir);
  // 下の骨は上の骨のローカル系で解く: 目標方向を upper の逆回転で持ち込む
  const inv: Quat = { x: -upper.x, y: -upper.y, z: -upper.z, w: upper.w };
  const lower = quatFromTo(o.restDirLower ?? restDir, quatRotate(inv, lowDir));

  return {
    upper, lower,
    joint: { x: o.root.x + (c * jx + s * jz), y: o.root.y + jy, z: o.root.z + (-s * jx + c * jz) },
  };
}

/**
 * 解から手先の位置を順運動学で組み直す（検証・デバッグ用）。
 * `solveTwoBone` が正しければ target と一致する。
 */
export function endEffectorOf(sol: TwoBoneSolution, o: TwoBoneOptions): Vec3 {
  const restDir = o.restDir ?? DEFAULT_REST_DIR;
  const th = o.frameYaw ?? 0;
  const c = Math.cos(th), s = Math.sin(th);
  const up = quatRotate(sol.upper, restDir);
  const low = quatRotate(quatMul(sol.upper, sol.lower), o.restDirLower ?? restDir);
  const lx = up.x * o.upperLen + low.x * o.lowerLen;
  const ly = up.y * o.upperLen + low.y * o.lowerLen;
  const lz = up.z * o.upperLen + low.z * o.lowerLen;
  return { x: o.root.x + (c * lx + s * lz), y: o.root.y + ly, z: o.root.z + (-s * lx + c * lz) };
}
