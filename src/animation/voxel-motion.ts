// objcts/player/motion の焼き込みクリップで下半身と体幹を動かす。
//
// 使い分け:
//   脚・体幹 … クリップ（idle / walk / run / backwalk / backdash / sidestep / dribble系）
//   腕      … このプロジェクトの手続きポーズ（ボール・守備の位置に厳密に紐づくため）
// クリップに無い状態（守備の構え・リーチ・ファウル反応・喜び・着席など）は
// 全身とも手続きポーズのまま。
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core";
import { applyMotion, motionClip, motionDuration, type MotionClip } from "@objcts/player/motion/clip";
import { Player } from "../objects/player/player";
import { splayLegs, syncVoxelArms, syncVoxelHeadTorso, type VoxelBody } from "../objects/player/player-voxel";

declare module "../objects/player/player" {
  interface Player {
    /** このフレームでボールを保持/ドリブルしているか（core/visuals が毎フレーム設定）。 */
    holdingBall: boolean;
    /** クリップ再生の位相(秒)。 */
    clipT: number;
    /** 直前に再生したクリップ名（切り替わりで位相をリセットする）。 */
    clipName: string;
    /** 再生中のクリップが焼き込みで体を回している量(rad)。押し込みドリブルの半身など。
     *  chestFront はこれを足す（足さないとボールを胸の前に置いたつもりが背中側へ出る）。 */
    clipChestYaw: number;
  }
}
Player.prototype.holdingBall = false;
Player.prototype.clipT = 0;
Player.prototype.clipName = "";
Player.prototype.clipChestYaw = 0;

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
// ジャンプ/着地で腿を左右へ開く量(rad)。焼き込みのジャンプは両脚が揃いすぎるので少し広げる。
const JUMP_SPLAY = 0.10;
// 左右の開きの差。完全な鏡像だと揃って見えるので、選手ごとに開き方をずらす。
const splayBias = (p: Player): number => ((p.idx % 5) - 2) * 0.16;

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

// --- クリップの脚とゲーム側の腕振りの位相合わせ ---------------------------------
// ⚠️ クリップは焼き込みの位相を持っていて、腕の振り（runArms が stridePhase から作る）
//    とは無関係。stridePhase をそのまま再生時刻にすると**同じ側の手と足が同時に前へ
//    出る**。run クリップは自分の時間軸の 0.00 周期で左脚が最前になるが、手続きの脚は
//    0.25 周期。実測の左足↔左手の相関は +0.27（同じ側が同時に前）だった。
//    クリップ側をずらして手続きの脚に合わせる＝腕とは逆位相になる。
// 手続きの脚(updateLegs)で左脚が最も前へ出る位相。updateLegs は sin(stridePhase) で
// 振るので π/2 = 0.25 周期。実測でも 0.25（背中側は 0.75）。
const PROC_LEG_PEAK = 0.25;
// ⚠️ クリップの脚は numberSide で左右が入れ替わらない（applyMotion はボーンへ素直に
//    書く）が、手続きの腕・脚は入れ替わる。背中側のときは半周期ずらして左右を合わせる。
const BACK_SHIFT = 0.5;
// 前後の振り(m)がこれ未満のクリップは位相合わせをしない。前後に歩くクリップは
// 0.58〜1.07m 振れるが、横移動(sidestep 0.07 / dribbleSide 0.11)や押し込み
// (dribblePower 0.11)はほぼ振れず、測った「最前」が雑音になるため対象外にする。
const SWING_MIN = 0.15;

/** そのクリップで左脚が最も前へ出る位相(0..1)。振りが小さいクリップは null。
 *  リグへ実際に当てて測る（クリップ名ごとに一度だけ）。
 *  ⚠️ 測るのは股関節→**足**。腿(股関節→膝)で測ると、走行中は膝が深く曲がるぶん
 *     脚全体より約0.3周期早く最前を迎えるので、PROC_LEG_PEAK と揃わない。 */
const LEG_PHASE = new Map<string, number | null>();
const _inv = new Matrix();
function legPhase(vb: VoxelBody, c: MotionClip): number | null {
  let v = LEG_PHASE.get(c.name);
  if (v !== undefined) return v;
  v = null;
  const hip = vb.rig.node("LeftUpperLeg"), knee = vb.rig.node("LeftFoot");
  if (hip && knee) {
    const dur = motionDuration(c);
    const N = 24;
    let best = -Infinity, worst = Infinity, bestF = 0;
    for (let i = 0; i < N; i++) {
      applyMotion(vb.rig, c, (i / N) * dur, { rootMotion: "vertical", leanDeg: 15 });
      vb.root.computeWorldMatrix(true);
      hip.computeWorldMatrix(true);
      knee.computeWorldMatrix(true);
      vb.root.getWorldMatrix().invertToRef(_inv);
      const a = Vector3.TransformCoordinates(Vector3.ZeroReadOnly, hip.getWorldMatrix());
      const b = Vector3.TransformCoordinates(Vector3.ZeroReadOnly, knee.getWorldMatrix());
      // 素体ローカルでは前が +Z（vb.root が numberSide のヨーを吸収している）
      const z = Vector3.TransformNormal(b.subtract(a), _inv).z;
      if (z > best) { best = z; bestF = i / N; }
      if (z < worst) worst = z;
    }
    if (best - worst > SWING_MIN) v = bestF;
  }
  LEG_PHASE.set(c.name, v);
  return v;
}

// --- クリップが焼き込んでいる体の向き -------------------------------------------
// ⚠️ dribblePower は「半身（ボールと逆の肩が前）」を**クリップの Hips に焼き込んで**いて、
//    updateFacing はそれを二重に回さないよう胸をひねらない。一方 chestFront は
//    root ヨー＋torsoTwist しか見ないので、ボールを「胸の前」に置いたつもりが実際の
//    胸から 70° ずれる。守備者が近いと横 0.30m のオフセットが乗るため、見た目の胸より
//    約 0.24m 後ろ＝背中側にボールが出ていた。ここで測って chestFront に足す。
const BODY_YAW = new Map<string, number>();
let neutralYaw: number | null = null;
const _iv = new Matrix();

/** そのポーズでの肩線の法線（＝胸の向き, rad）を素体ローカルで測る。 */
function chestYawNow(vb: VoxelBody): number {
  const l = vb.rig.node("LeftUpperArm"), r = vb.rig.node("RightUpperArm");
  if (!l || !r) return 0;
  vb.root.computeWorldMatrix(true);
  l.computeWorldMatrix(true);
  r.computeWorldMatrix(true);
  vb.root.getWorldMatrix().invertToRef(_iv);
  const a = Vector3.TransformCoordinates(Vector3.ZeroReadOnly, l.getWorldMatrix());
  const b = Vector3.TransformCoordinates(Vector3.ZeroReadOnly, r.getWorldMatrix());
  const s = Vector3.TransformNormal(a.subtract(b), _iv);   // 右肩→左肩
  return Math.atan2(-s.z, s.x);
}

/** クリップが焼き込んでいる体のヨー(rad)。中立(idle)との差。クリップ名ごとに一度だけ測る。 */
function clipBodyYaw(vb: VoxelBody, c: MotionClip): number {
  let v = BODY_YAW.get(c.name);
  if (v !== undefined) return v;
  const dur = motionDuration(c);
  if (neutralYaw === null) {
    const idle = clip("idle");
    if (!idle) return 0;
    applyMotion(vb.rig, idle, motionDuration(idle) * 0.5, { rootMotion: "vertical", leanDeg: 0 });
    neutralYaw = chestYawNow(vb);
  }
  // 周期の平均（ベクトルで足して巻き戻りを避ける）
  let vx = 0, vz = 0;
  for (let i = 0; i < 8; i++) {
    applyMotion(vb.rig, c, (i / 8) * dur, { rootMotion: "vertical", leanDeg: 0 });
    const y = chestYawNow(vb) - neutralYaw;
    vx += Math.sin(y); vz += Math.cos(y);
  }
  v = Math.atan2(vx, vz);
  if (Math.abs(v) < 0.15) v = 0;   // 測定誤差はゼロに丸める
  BODY_YAW.set(c.name, v);
  return v;
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
  // 床のルーズボールを拾う: objcts の "pickup" クリップ（沈み込み〜立ち上がり）を当てる。
  if (p.scoopLoad > 0.003) return "pickup";
  // シュートの溜め: 手続き側が屈んだぶん root を下げているので、クリップで脚を
  // 伸ばし直すと足が床にめり込む。溜めている間は手続きポーズに任せる。
  if (p.shootLoad > 0.003) return "";
  const frac = p.runSpeed > 0 ? Math.min(1, p.curSpd / p.runSpeed) : 0;
  const ball = p.holdingBall;
  // 押し込むドリブル: 逆肩を当てて体ごと運ぶ（速さに依らず専用クリップ）
  if (ball && p.powerT > 0) return "dribblePower";
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
  if (!name) { p.clipName = ""; p.clipChestYaw = 0; return false; }
  const c = clip(name);
  if (!c) { p.clipName = ""; p.clipChestYaw = 0; return false; }
  if (p.clipName !== name) { p.clipName = name; p.clipT = 0; }
  // 焼き込みで体が回っているぶんを chestFront（ボールのキャリー位置など）へ伝える
  p.clipChestYaw = clipBodyYaw(vb, c);

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
    splayLegs(vb, JUMP_SPLAY * (1 - k * 0.5), splayBias(p));   // 立て直しにつれて開きを戻す
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
  } else if (name === "pickup") {
    // 拾う: クリップの位相＝拾い進捗（所要時間は技術で伸縮するのでクリップを引き伸ばす）
    p.clipT = dur * (p.pickupDur > 0 ? Math.min(1, Math.max(0, 1 - p.pickupT / p.pickupDur)) : 1);
  } else if (c.loop) {
    const frac = p.runSpeed > 0 ? Math.min(1, p.curSpd / p.runSpeed) : 0;
    if (frac < MOVE_MIN) p.clipT = (p.clipT + dt) % dur;          // その場のクリップは実時間
    else {
      // 焼き込みの脚の位相を手続きの脚へ合わせる（＝腕の振りと逆位相にする）。
      // 再生時刻を shift 進めると、脚が最前になる stridePhase は shift ぶん戻るので
      // 「クリップ側の位相 − 合わせたい位相」を足す。
      const lp = legPhase(vb, c);
      const shift = lp === null ? 0
        : lp - PROC_LEG_PEAK - (p.numberSide > 0 ? BACK_SHIFT : 0);
      p.clipT = (((p.stridePhase / (2 * Math.PI) + shift) % 1) + 1) % 1 * dur;
    }
  } else {
    p.clipT = Math.min(dur, p.clipT + dt);
  }

  // 前傾は走る速さで増やす（クリップ側の想定どおり 0°→15°）
  const lean = air ? 0 : 15 * Math.min(1, p.curSpd / Math.max(0.1, p.runSpeed));
  applyMotion(vb.rig, c, p.clipT, air
    ? { rootMotion: "none", groundFeet: false }
    : { rootMotion: "vertical", leanDeg: lean });
  if (air) splayLegs(vb, JUMP_SPLAY, splayBias(p));   // 滞空はスタンスを広げる

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
