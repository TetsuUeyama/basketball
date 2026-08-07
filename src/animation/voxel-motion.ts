// objcts/player/motion の焼き込みクリップで下半身と体幹を動かす。
//
// 使い分け:
//   脚・体幹 … クリップ（idle / walk / run / backwalk / backdash / sidestep / dribble系）
//   腕      … このプロジェクトの手続きポーズ（ボール・守備の位置に厳密に紐づくため）
// クリップに無い状態（守備の構え・リーチ・ファウル反応・喜び・着席など）は
// 全身とも手続きポーズのまま。
import { Quaternion, Vector3 } from "@babylonjs/core";
import { applyMotion, motionClip, motionDuration, type MotionClip } from "@objcts/player/motion/clip";
import { Player } from "../objects/player/player";
import { syncVoxelArms, syncVoxelHeadTorso, type VoxelBody } from "../objects/player/player-voxel";

declare module "../objects/player/player" {
  interface Player {
    /** このフレームでボールを保持/ドリブルしているか（core/visuals が毎フレーム設定）。 */
    holdingBall: boolean;
    /** クリップ再生の位相(秒)。 */
    clipT: number;
    /** 直前に再生したクリップ名（切り替わりで位相をリセットする）。 */
    clipName: string;
  }
}
Player.prototype.holdingBall = false;
Player.prototype.clipT = 0;
Player.prototype.clipName = "";

// 走り出す速さの割合。これ未満は idle。
const MOVE_MIN = 0.06;
// これ以上でダッシュ系のクリップへ。
const DASH = 0.5;
// 着地の前倒し: 滞空の終盤この割合はもう着地フレームへ入る（落ちながら脚を出す）
const LAND_EARLY = 0.22;
// そのとき着地フレームのどこまで進めるか（残りは接地後に再生）
const LAND_LEAD = 0.35;
// 接地後、着地フレームを振り切るまでの秒数（landT いっぱい引き伸ばさない）
const LAND_PLAY = 0.45;

const CACHE = new Map<string, MotionClip | null>();
function clip(name: string): MotionClip | null {
  let c = CACHE.get(name);
  if (c === undefined) { c = motionClip(name); CACHE.set(name, c); }
  return c;
}

/** 速度と保持状態から再生するクリップ名を選ぶ。無ければ "" （手続きポーズに任せる）。 */
/** クリップの滞空区間（groundLock が 0 の範囲）を秒で返す。無ければ null。 */
const AIR = new Map<string, [number, number] | null>();
function airWindow(c: MotionClip): [number, number] | null {
  let w = AIR.get(c.name);
  if (w !== undefined) return w;
  w = null;
  const g = c.groundLock;
  if (g) {
    let lo = -1, hi = -1;
    for (let i = 0; i < g.length; i++) {
      if (g[i] < 0.5) { if (lo < 0) lo = i; hi = i; }
    }
    if (lo >= 0) w = [lo / c.fps, (hi + 1) / c.fps];
  }
  AIR.set(c.name, w);
  return w;
}

/** ジャンプ: 跳ぶ向き（胸の向き基準）から その場 / 前 / 後 / 左 / 右 を選ぶ。 */
function pickJump(p: Player): string {
  const dx = p.leapX, dz = p.leapZ;
  const l = Math.hypot(dx, dz);
  if (l < 0.15) return "jump";                  // ほぼ真上
  const ns = p.numberSide;
  const th = p.root.rotation.y + p.torsoTwist;
  const fx = -ns * Math.sin(th), fz = -ns * Math.cos(th);
  const along = (dx * fx + dz * fz) / l;
  const side = (dx * fz - dz * fx) / l;         // 前方の左手側が正
  if (Math.abs(side) > Math.abs(along)) return side > 0 ? "jumpL" : "jumpR";
  return along > 0 ? "jumpF" : "jumpB";
}

function pickClip(p: Player): string {
  if (p.seated) return "";
  if (p.airborne) return p.jumpDur > 0 ? pickJump(p) : "";
  // 着地の立て直し中はジャンプのクリップを続ける。⚠️ 滞空区間の最後で切ると、
  // 反った空中姿勢のまま着地して見える（クリップの着地フレームが再生されない）。
  if (p.landT > 0 && p.clipName.startsWith("jump")) return p.clipName;
  // 演出中（ファウル反応・守備成功・落胆）はクリップを当てない
  if (p.foulReactT > 0 || p.defWinT > 0) return "";
  // シュートの溜め: 手続き側が屈んだぶん root を下げているので、クリップで脚を
  // 伸ばし直すと足が床にめり込む。溜めている間は手続きポーズに任せる。
  if (p.shootLoad > 0.003) return "";
  const frac = p.runSpeed > 0 ? Math.min(1, p.curSpd / p.runSpeed) : 0;
  const ball = p.holdingBall;
  if (frac < MOVE_MIN) return ball ? "dribbleIdle" : "idle";
  // 胸の向き（前 = -numberSide·Z）に対する速度成分で、前進 / 後退 / 横滑りを見分ける
  const ns = p.numberSide;
  const th = p.root.rotation.y + p.torsoTwist;
  const fx = -ns * Math.sin(th), fz = -ns * Math.cos(th);
  const along = p.velX * fx + p.velZ * fz;
  const side = p.velX * fz - p.velZ * fx;            // 前方の左手側が正
  const dash = frac >= DASH;
  if (Math.abs(side) > Math.abs(along) * 1.2) {
    return ball ? (dash ? "dribbleSideDash" : "dribbleSide") : (dash ? "sidestepDash" : "sidestep");
  }
  if (along < 0) {
    return ball ? (dash ? "dribbleBackDash" : "dribbleBack") : (dash ? "backdash" : "backwalk");
  }
  return ball ? (dash ? "dribbleRun" : "dribbleWalk") : (dash ? "run" : "walk");
}

const _spineQ = new Quaternion();
const _headQ = new Quaternion();
const _aim = new Vector3();

/**
 * クリップで脚と体幹を動かす。当てたら true（呼び出し側は手続きの全身転写を省く）。
 * 腕はこの後 syncVoxelArms が手続きポーズで上書きする。
 */
export function applyClipPose(vb: VoxelBody, p: Player, dt: number): boolean {
  const name = pickClip(p);
  if (!name) { p.clipName = ""; return false; }
  const c = clip(name);
  if (!c) { p.clipName = ""; return false; }
  if (p.clipName !== name) { p.clipName = name; p.clipT = 0; }

  // 歩調は stridePhase に**同期させる**（別々に進めると腕の振りと脚がずれる）。
  // 1周期 = 2π。速さは locomotion.ts の CADENCE ひとつで決まる。
  const dur = motionDuration(c);
  const win = airWindow(c);
  const air = p.airborne ? win : null;
  // 着地の立て直し: 滞空区間の終わり → クリップの最後（着地フレーム）を再生し、
  // 反った空中姿勢から下半身・脚を進行方向へ伸ばして立て直す形へ戻す。
  if (!air && win && p.landT > 0 && p.landDur > 0 && name.startsWith("jump")) {
    // ⚠️ 立て直しは landT（最大2.6秒）いっぱい使わず、LAND_PLAY 秒で振り切る。
    //    引き伸ばすと脚が戻るのが遅れて、反ったまま突っ立って見える。
    const played = Math.max(0, p.landDur - p.landT);
    const k = Math.min(1, played / LAND_PLAY);
    p.clipT = win[1] + (dur - win[1]) * (LAND_LEAD + (1 - LAND_LEAD) * k);
    applyMotion(vb.rig, c, p.clipT, { rootMotion: "vertical", leanDeg: 0 });
    syncVoxelHeadTorso(vb, p.numberSide, p.torsoNode.rotation.y, p.headNode.rotation.y, _spineQ, _headQ);
    syncVoxelArms(vb, p, null);
    return true;
  }
  if (air) {
    // ジャンプ: 高さはゲームが持っている（jumpY）ので、クリップからは**姿勢だけ**もらう。
    // ⚠️ クリップの滞空区間をゲームの滞空へ重ねる（クリップ全体を割り当てると、
    //    もう上昇しているのに沈み込みの姿勢が出る）。腰の上下・接地合わせは切る
    //    （切らないと jumpY と二重に効いて跳ばない／足が床へ吸われる）。
    // ⚠️ 接地してから脚を伸ばし始めると遅い。滞空の終盤 LAND_EARLY のぶんは
    //    もう着地フレームへ入り、落ちながら脚を進行方向へ出す。
    const k = Math.min(1, Math.max(0, 1 - p.jumpRemaining / p.jumpDur));
    if (k < 1 - LAND_EARLY) {
      p.clipT = air[0] + (air[1] - air[0]) * (k / (1 - LAND_EARLY));
    } else {
      const j = (k - (1 - LAND_EARLY)) / LAND_EARLY;         // 0..1
      p.clipT = air[1] + (dur - air[1]) * LAND_LEAD * j;     // 着地フレームの頭を空中で
    }
  } else if (c.loop) {
    const frac = p.runSpeed > 0 ? Math.min(1, p.curSpd / p.runSpeed) : 0;
    if (frac < MOVE_MIN) p.clipT = (p.clipT + dt) % dur;          // その場のクリップは実時間
    else p.clipT = (((p.stridePhase / (2 * Math.PI)) % 1) + 1) % 1 * dur;
  } else {
    p.clipT = Math.min(dur, p.clipT + dt);
  }

  // 前傾は走る速さで増やす（クリップ側の想定どおり 0°→15°）
  const lean = air ? 0 : 15 * Math.min(1, p.curSpd / Math.max(0.1, p.runSpeed));
  applyMotion(vb.rig, c, p.clipT, air
    ? { rootMotion: "none", groundFeet: false }
    : { rootMotion: "vertical", leanDeg: lean });

  // 胸・頭の向き（プレーを追う）はゲーム側の値をクリップの上に重ねる
  syncVoxelHeadTorso(vb, p.numberSide, p.torsoNode.rotation.y, p.headNode.rotation.y,
    _spineQ, _headQ);
  // 腕はゲーム側（ボール・守備）が持つ。ただしドリブル中は**ボール側の腕だけ**にして、
  // 反対の腕はクリップに焼かれた「空いている方の腕」を残す（両方上書きするとドリブルに見えない）。
  //
  // ⚠️ ドリブルのクリップは全て**右手ドリブル**で焼いてある（`ballHand: "right"`）。
  //    ゲームが左手側でついているときにこれをやると、残った反対の腕がクリップの
  //    「右手ドリブルの腕」になり、ボールと逆側で手が上下する。その場合は両腕とも
  //    ゲーム側で上書きする。
  const ballOnVoxelRight = (p.dribbleArm === "R") !== (p.numberSide > 0);
  const keepClipArm = name.startsWith("dribble") && ballOnVoxelRight;
  syncVoxelArms(vb, p, keepClipArm ? p.dribbleArm : null);
  void _aim;
  return true;
}
