// motion — 層4: 標準ボーン名の骨組みにモーションを流す。
//
// クリップは `tools/authorClips.mjs` が関節角の式から作った
// 「ボーンごとの局所回転」の列。局所回転は静止姿勢からの相対量なので、
// 体型・身長の違う骨組みへそのまま載せられる（実測: 骨の長さのぶれ 1.9e-6〜7.0e-6m）。
import { Quaternion, Vector3 } from "@babylonjs/core";
import type { RigHandle } from "../rig";
import type { StandardBoneName } from "../standardSkeleton";
import idleJson from "./data/idle.json";
import walkJson from "./data/walk.json";
import runJson from "./data/run.json";
import sidestepJson from "./data/sidestep.json";
import cutJson from "./data/cut.json";
import jumpJson from "./data/jump.json";
import backwalkJson from "./data/backwalk.json";
import backdashJson from "./data/backdash.json";
import sidestepDashJson from "./data/sidestepDash.json";
import jumpFJson from "./data/jumpF.json";
import jumpBJson from "./data/jumpB.json";
import jumpLJson from "./data/jumpL.json";
import jumpRJson from "./data/jumpR.json";
import passChestJson from "./data/passChest.json";
import passOverheadJson from "./data/passOverhead.json";
import passBounceJson from "./data/passBounce.json";
import passChestOneJson from "./data/passChestOne.json";
import passOverheadOneJson from "./data/passOverheadOne.json";
import passBounceOneJson from "./data/passBounceOne.json";
import passLobJson from "./data/passLob.json";
import passLobOneJson from "./data/passLobOne.json";
import dribbleIdleJson from "./data/dribbleIdle.json";
import dribbleWalkJson from "./data/dribbleWalk.json";
import dribbleRunJson from "./data/dribbleRun.json";
import dribbleBackJson from "./data/dribbleBack.json";
import dribbleBackDashJson from "./data/dribbleBackDash.json";
import dribbleSideJson from "./data/dribbleSide.json";
import dribbleSideDashJson from "./data/dribbleSideDash.json";
import shootMidJson from "./data/shootMid.json";
import shootMidJumpJson from "./data/shootMidJump.json";
import shoot3Json from "./data/shoot3.json";
import layupJson from "./data/layup.json";
import dunkJson from "./data/dunk.json";
import doubleClutchJson from "./data/doubleClutch.json";
import pickupJson from "./data/pickup.json";
import dribblePowerJson from "./data/dribblePower.json";

export interface MotionClip {
  name: string;
  fps: number;
  frameCount: number;
  loop: boolean;
  /** rot の並び順（1フレームぶんがこの順で4要素ずつ）。 */
  bones: string[];
  /** 局所回転 [x,y,z,w] × ボーン数 × フレーム数。 */
  rot: number[];
  /** 腰の移動（静止位置からの差）。**腰の高さで正規化**してあるので身長を掛けて使う。 */
  rootPos: number[];
  /**
   * フレームごとの接地の強さ 0..1（省略時は全フレーム 1）。
   * 0 = 滞空。`groundFeet` の補正をこの割合で効かせる。
   * ⚠️ 0 の区間は `rootPos` が腰の高さを決める。離地の瞬間の rootPos は、その姿勢で
   * `groundFeet` が入れていた量と一致させてある（authorClips が FK で出す）。合っていないと跳ぶ。
   */
  groundLock?: number[];
  /** クリップ全体で体の向きが変わる量（度・Y軸）。向き自体は Hips の回転に入っている。 */
  turnDeg?: number;
  /** 跳ぶ向き（度・0=前/+Z, 90=右/+X）。その場ジャンプは無し。 */
  travelDeg?: number;
  /** 滞空中に進む距離(m)。移動は rootPos に入っている（rootMotion: "full" で効く）。 */
  travelDist?: number;
  /** ボールが手を離れる位相 0..1（パス・シュートのみ）。 */
  releaseAt?: number;
  /** ボールをどう持つか（パス・シュートのみ）。"both" = 両手で挟む / "right" = 右手。 */
  ballHand?: "both" | "right";
  /** ボールの位置（肩の中点からの相対・**肩の高さで正規化**）× フレーム数。腕はこれに合わせてIKで解いてある。 */
  ballPos?: number[];
  /**
   * リリース時のボールの速度 [x, y, z] (m/s・体の向き基準)。
   * ⚠️ 軌道から微分しても出ない（キーフレーム上は補間の傾きが 0 で、実測 0.2m/s しか出なかった）。
   */
  releaseVel?: number[];
  /** 足幅の既定補正(度)。素材ごとの足幅の違いを埋める。 */
  hipSplayDeg?: number;
  source?: string;
}

const CLIPS: Record<string, MotionClip> = {
  idle: idleJson as MotionClip,
  walk: walkJson as MotionClip,
  run: runJson as MotionClip,
  sidestep: sidestepJson as MotionClip,
  cut: cutJson as MotionClip,
  jump: jumpJson as MotionClip,
  backwalk: backwalkJson as MotionClip,
  backdash: backdashJson as MotionClip,
  sidestepDash: sidestepDashJson as MotionClip,
  jumpF: jumpFJson as MotionClip,
  jumpB: jumpBJson as MotionClip,
  jumpL: jumpLJson as MotionClip,
  jumpR: jumpRJson as MotionClip,
  passChest: passChestJson as MotionClip,
  passOverhead: passOverheadJson as MotionClip,
  passBounce: passBounceJson as MotionClip,
  passChestOne: passChestOneJson as MotionClip,
  passOverheadOne: passOverheadOneJson as MotionClip,
  passBounceOne: passBounceOneJson as MotionClip,
  passLob: passLobJson as MotionClip,
  passLobOne: passLobOneJson as MotionClip,
  dribbleIdle: dribbleIdleJson as MotionClip,
  dribbleWalk: dribbleWalkJson as MotionClip,
  dribbleRun: dribbleRunJson as MotionClip,
  dribbleBack: dribbleBackJson as MotionClip,
  dribbleBackDash: dribbleBackDashJson as MotionClip,
  dribbleSide: dribbleSideJson as MotionClip,
  dribbleSideDash: dribbleSideDashJson as MotionClip,
  shootMid: shootMidJson as MotionClip,
  shootMidJump: shootMidJumpJson as MotionClip,
  shoot3: shoot3Json as MotionClip,
  layup: layupJson as MotionClip,
  dunk: dunkJson as MotionClip,
  doubleClutch: doubleClutchJson as MotionClip,
  pickup: pickupJson as MotionClip,
  dribblePower: dribblePowerJson as MotionClip,
};

/** 使えるクリップ名。 */
export const MOTION_NAMES = Object.keys(CLIPS);
export function motionClip(name: string): MotionClip | null { return CLIPS[name] ?? null; }
/** クリップの長さ（秒）。 */
export function motionDuration(c: MotionClip): number { return c.frameCount / c.fps; }

/** 腰の移動の扱い。歩行をその場で回すなら "vertical"（上下の揺れだけ残す）。 */
export type RootMotion = "none" | "vertical" | "full";

export interface ApplyMotionOptions {
  /** 既定 "vertical"。 */
  rootMotion?: RootMotion;
  /** 0..1 で静止姿勢と混ぜる（1 = クリップそのまま）。 */
  weight?: number;
  /**
   * 低い方の足が静止時の足の高さに来るよう腰を上下させる（既定 true）。
   * クリップ側の腰の上下だけでは体格差や元データの違いで浮き沈みが出るので、
   * 支持足を基準に合わせ直す。腰の移動が無いクリップでも接地する。
   * ⚠️ 骨組みの root は Y軸まわりの回転と平行移動のみを想定（傾けると高さがずれる）。
   */
  groundFeet?: boolean;
  /**
   * 足幅の補正（度）。正で外へ広げ、負で内へ寄せる。腿の付け根を体の前後軸まわりに回す。
   * 元モーションの足幅は素材によって大きく違う（実測・normal 1.81m の接地時の左右の間隔:
   * 補正なしで walk 0.330m / walk_narrow 0.055m。静止の足幅は 0.233m）。
   * 省略時はクリップの `hipSplayDeg`（自然な歩行になる値を実測して入れてある）。
   */
  hipSplayDeg?: number;
  /**
   * 前傾（度）。正で前へ倒れる。**走る速さに応じて増やす**想定
   * （例: 歩き 0° → 全力疾走 15°）。胴（Spine）だけを倒す。
   * ⚠️ 腰から倒すと脚ごと傾いて足が滑るので、上体だけにしてある。
   */
  leanDeg?: number;
  /**
   * 腕を目標（ボール・リング等のワールド座標）へ自動で向ける。
   * 省略すればクリップの腕のまま（ジャンプは目標が無くても上へ伸ばしてある）。
   */
  armAim?: ArmAim | null;
}

export interface ArmAim {
  /** 目標のワールド座標。 */
  target: Vector3;
  /** どの腕を向けるか。既定 "both"。 */
  hand?: "both" | "left" | "right";
  /** 0..1 の効き具合。既定 1。 */
  weight?: number;
}

const _a = new Quaternion(), _b = new Quaternion(), _q = new Quaternion(), _s = new Quaternion();
const FORWARD = new Vector3(0, 0, 1);
const RIGHT = new Vector3(1, 0, 0);

/**
 * クリップの時刻 `timeSec` の姿勢を骨組みへ適用する。
 * フレーム間は球面補間。ループするクリップは末尾から先頭へも繋ぐ。
 */
export function applyMotion(
  rig: RigHandle, clip: MotionClip, timeSec: number, opts: ApplyMotionOptions = {},
): void {
  const rootMotion = opts.rootMotion ?? "vertical";
  const weight = opts.weight ?? 1;
  const n = clip.frameCount;
  const nb = clip.bones.length;

  let t = timeSec * clip.fps;
  if (clip.loop) t = ((t % n) + n) % n;
  else t = Math.max(0, Math.min(n - 1, t));
  const f0 = Math.floor(t);
  const f1 = clip.loop ? (f0 + 1) % n : Math.min(n - 1, f0 + 1);
  const s = t - f0;

  const splay = ((opts.hipSplayDeg ?? clip.hipSplayDeg ?? 0) * Math.PI) / 180;
  for (let i = 0; i < nb; i++) {
    const bone = clip.bones[i];
    const node = rig.node(bone as StandardBoneName);
    if (!node) continue;
    const o0 = (f0 * nb + i) * 4, o1 = (f1 * nb + i) * 4;
    _a.set(clip.rot[o0], clip.rot[o0 + 1], clip.rot[o0 + 2], clip.rot[o0 + 3]);
    _b.set(clip.rot[o1], clip.rot[o1 + 1], clip.rot[o1 + 2], clip.rot[o1 + 3]);
    Quaternion.SlerpToRef(_a, _b, s, _q);
    if (weight < 1) Quaternion.SlerpToRef(Quaternion.Identity(), _q, weight, _q);
    // 足幅の補正: 腿の付け根を前後軸(+Z)まわりに回す。左脚は -X 側なので符号が逆。
    if (splay !== 0 && (bone === "LeftUpperLeg" || bone === "RightUpperLeg")) {
      Quaternion.RotationAxisToRef(FORWARD, bone === "LeftUpperLeg" ? -splay : splay, _s);
      _s.multiplyToRef(_q, _q);
    }
    if (!node.rotationQuaternion) node.rotationQuaternion = _q.clone();
    else node.rotationQuaternion.copyFrom(_q);
  }

  // 前傾（走る速さに応じて上体を倒す）
  const lean = opts.leanDeg ?? 0;
  if (lean !== 0) {
    const spine = rig.node("Spine");
    if (spine?.rotationQuaternion) {
      Quaternion.RotationAxisToRef(RIGHT, (lean * Math.PI) / 180, _s);
      _s.multiplyToRef(spine.rotationQuaternion, spine.rotationQuaternion);
    }
  }

  const hips = rig.node("Hips");
  const rest = rig.restPosition("Hips");
  if (!hips || !rest) return;
  if (rootMotion === "none") hips.position.copyFrom(rest);
  else {
    const g = (f: number, k: number): number => clip.rootPos[f * 3 + k];
    const d = [0, 1, 2].map((k) => (g(f0, k) + (g(f1, k) - g(f0, k)) * s) * rest.y * weight);
    hips.position.set(
      rest.x + (rootMotion === "full" ? d[0] : 0),
      rest.y + d[1],
      rest.z + (rootMotion === "full" ? d[2] : 0),
    );
  }

  if (opts.groundFeet ?? true) {
    const gl = clip.groundLock;
    const lock = gl ? gl[f0] + (gl[f1] - gl[f0]) * s : 1;
    if (lock > 0) groundFeet(rig, lock * weight);
  }

  // 腕を目標へ向けるのは最後（腰の位置が決まってからでないと肩の位置が出ない）
  if (opts.armAim) aimArms(rig, opts.armAim, weight);
}

const _cur = new Vector3(), _want = new Vector3(), _axis = new Vector3();
const _pw = new Quaternion(), _delta = new Quaternion();

/**
 * 腕を目標へ向ける。肘を伸ばしてから、**今の腕の向きと目標の向きの差分**で上腕を回す。
 * ⚠️ 回転をハードコードしないこと。静止姿勢の腕の向きはモデルによって違うので、
 * 「肩→手」の実測ベクトルを目標ベクトルへ重ねる最小回転を毎回作る。
 */
export function aimArms(rig: RigHandle, aim: ArmAim, weight = 1): void {
  const w = (aim.weight ?? 1) * weight;
  if (w <= 0) return;
  const which = aim.hand ?? "both";
  if (which !== "right") aimArm(rig, "Left", aim.target, w);
  if (which !== "left") aimArm(rig, "Right", aim.target, w);
}

function aimArm(rig: RigHandle, side: "Left" | "Right", target: Vector3, w: number): void {
  const up = rig.node(`${side}UpperArm` as StandardBoneName);
  const lo = rig.node(`${side}LowerArm` as StandardBoneName);
  const hd = rig.node(`${side}Hand` as StandardBoneName);
  if (!up || !lo || !hd) return;
  up.computeWorldMatrix(true); lo.computeWorldMatrix(true); hd.computeWorldMatrix(true);
  const sh = up.getAbsolutePosition();
  const el = lo.getAbsolutePosition();
  const armLen = Vector3.Distance(sh, el) + Vector3.Distance(el, hd.getAbsolutePosition());
  // 遠いほど肘を伸ばす（腕の長さ以上なら伸ばし切る）
  const straight = Math.min(1, Vector3.Distance(sh, target) / Math.max(1e-6, armLen));
  if (lo.rotationQuaternion) {
    Quaternion.SlerpToRef(lo.rotationQuaternion, Quaternion.Identity(), straight * w, lo.rotationQuaternion);
    lo.computeWorldMatrix(true); hd.computeWorldMatrix(true);
  }
  hd.getAbsolutePosition().subtractToRef(sh, _cur);
  target.subtractToRef(sh, _want);
  if (_cur.lengthSquared() < 1e-12 || _want.lengthSquared() < 1e-12) return;
  _cur.normalize(); _want.normalize();
  Vector3.CrossToRef(_cur, _want, _axis);
  const sin = _axis.length(), cos = Vector3.Dot(_cur, _want);
  if (sin < 1e-6) return;                       // 既に同じ向き（真逆はジャンプ中に起きない）
  _axis.scaleInPlace(1 / sin);
  Quaternion.RotationAxisToRef(_axis, Math.atan2(sin, cos) * w, _delta);
  // ワールドの差分回転を上腕の親の空間へ移す: local' = inv(親) * 差分 * 親 * local
  const parent = up.parent as { absoluteRotationQuaternion?: Quaternion } | null;
  if (parent?.absoluteRotationQuaternion) _pw.copyFrom(parent.absoluteRotationQuaternion);
  else _pw.copyFromFloats(0, 0, 0, 1);
  const q = up.rotationQuaternion ?? (up.rotationQuaternion = Quaternion.Identity());
  Quaternion.InverseToRef(_pw, _s);
  q.copyFrom(_s.multiply(_delta).multiply(_pw).multiply(q));
}

/** 低い方の足が静止時の足の高さに来るよう腰を上下させる。`amount` で効き具合を絞れる。 */
export function groundFeet(rig: RigHandle, amount = 1): void {
  const hips = rig.node("Hips");
  const lf = rig.node("LeftFoot"), rf = rig.node("RightFoot");
  const restFoot = rig.restPosition("LeftFoot") ?? rig.restPosition("RightFoot");
  if (!hips || !lf || !rf || !restFoot) return;
  lf.computeWorldMatrix(true);
  rf.computeWorldMatrix(true);
  const y = Math.min(lf.getAbsolutePosition().y, rf.getAbsolutePosition().y);
  const base = rig.root.getAbsolutePosition().y;
  hips.position.y += (restFoot.y - (y - base)) * amount;
}

/** ボールの半径(m)。`objcts/ball` の既定と同じ。 */
export const BALL_RADIUS = 0.12;

const _p = new Vector3(), _pl = new Vector3();

/**
 * そのクリップ・その時刻でボールがある位置（ワールド座標）。`applyMotion` の後に呼ぶ。
 *
 * ⚠️ 手からボールの位置を割り出してはいけない。腕の方が**ボールに合わせて**IKで解いてある
 * （authorClips）。逆算すると、手が開く局面でボールが宙に浮く。
 * クリップの `ballPos`（肩の中点からの相対）をそのまま使うこと。
 */
export function ballPosition(rig: RigHandle, clip: MotionClip, timeSec: number, out?: Vector3): Vector3 | null {
  const dst = out ?? new Vector3();
  const bp = clip.ballPos;
  if (!bp) return null;
  const l = rig.node("LeftUpperArm");
  const r = rig.node("RightUpperArm");
  if (!l || !r) return null;
  l.computeWorldMatrix(true); r.computeWorldMatrix(true);
  l.getAbsolutePosition().addToRef(r.getAbsolutePosition(), _p);
  _p.scaleInPlace(0.5);
  const n = clip.frameCount;
  let t = timeSec * clip.fps;
  t = clip.loop ? ((t % n) + n) % n : Math.max(0, Math.min(n - 1, t));
  const f0 = Math.floor(t), f1 = Math.min(n - 1, f0 + 1), s = t - f0;
  _pl.set(bp[f0 * 3] + (bp[f1 * 3] - bp[f0 * 3]) * s,
    bp[f0 * 3 + 1] + (bp[f1 * 3 + 1] - bp[f0 * 3 + 1]) * s,
    bp[f0 * 3 + 2] + (bp[f1 * 3 + 2] - bp[f0 * 3 + 2]) * s);
  // 正規化してあるので肩の高さを掛ける（体格が変わっても比率が保たれる）
  _pl.scaleInPlace(_p.y);
  _p.addToRef(_pl, dst);
  return dst;
}

/** 骨組みを静止姿勢へ戻す。 */
export function resetPose(rig: RigHandle): void {
  for (const b of rig.bones) {
    const n = rig.node(b);
    if (n?.rotationQuaternion) n.rotationQuaternion.copyFromFloats(0, 0, 0, 1);
  }
  const hips = rig.node("Hips");
  const rest = rig.restPosition("Hips");
  if (hips && rest) hips.position.copyFrom(rest as Vector3);
}
