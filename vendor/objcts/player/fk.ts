/**
 * fk — 順運動学（角度を指定して姿勢を作る）側の道具。Babylon 非依存の層1。
 *
 * `ik.ts` が「手先の位置から角度を逆算する」のに対し、こちらは角度を直接決める。
 * 接触が要らない動作（目標方向へ腕を向ける・首を回す・体をひねる）はこちらが軽くて安定。
 *
 * 基本演算（quatFromTo / 可動域 / レート制限）は `humanRig.ts` にあるので、
 * ここはその上に載る3つだけを持つ:
 *   1. `aimBoneAt`    … ワールドの目標へ骨を向ける（`solveTwoBone` と同じ引数の形）
 *   2. `distributeAngle` … 1つの向きを複数関節へ可動域内で配る（胸→首→頭）
 *   3. `LagChain`     … 末端遅延。根元から先端へ数フレームずつ遅らせて力の伝わりを出す
 *
 * 座標系: 右手系・Y が鉛直上向き・単位はメートル。
 */
import {
  clampHinge, easeQuat, expEase, quatFromAxisAngle, quatFromTo, quatMul, quatSlerp,
  IDENTITY_QUAT, type Hinge, type Quat, type Vec3,
} from "./humanRig";
import { DEFAULT_REST_DIR } from "./ik";

// --- 1. 目標へ向ける -----------------------------------------------------------

export interface AimOptions {
  /** 骨の根元の位置。target と同じ空間。 */
  root: Vec3;
  /** 向けたい先。root と同じ空間。 */
  target: Vec3;
  /** root/target の空間から骨の親ローカルへの Y 軸回転(rad)。既定 0。 */
  frameYaw?: number;
  /** 骨の静止方向（親ローカル）。既定 -Y。 */
  restDir?: Vec3;
}

/**
 * 骨を目標の**方向**へ向ける回転（親ローカル）。届く／届かないを問わない。
 *
 * `solveTwoBone` と引数の形を揃えてあるので、IKが `null` を返したときの
 * フォールバックとしてそのまま差し替えられる。
 */
export function aimBoneAt(o: AimOptions): Quat {
  const th = o.frameYaw ?? 0;
  const c = Math.cos(th), s = Math.sin(th);
  const wx = o.target.x - o.root.x, wy = o.target.y - o.root.y, wz = o.target.z - o.root.z;
  const dir: Vec3 = { x: c * wx - s * wz, y: wy, z: s * wx + c * wz };
  if (Math.hypot(dir.x, dir.y, dir.z) < 1e-9) return { x: 0, y: 0, z: 0, w: 1 };
  return quatFromTo(o.restDir ?? DEFAULT_REST_DIR, dir);
}

/**
 * **ワールド空間で骨を向ける**。親の回転を打ち消して、その骨に入れるべき
 * ローカル回転を返す。
 *
 * ラグドールや外部ソルバが「この骨はワールドでこの向き」とだけ教えてくる場合に使う。
 * `restDirWorld` は全ボーンが無回転のときの向き（`RigHandle.restDirection`）、
 * `parentWorldQuat` は親ボーンのワールド回転。根元のボーンには単位クォータニオンを渡す。
 *
 * 根元から順に呼び、返った `world` を次の骨の `parentWorldQuat` に使う。
 *
 * ⚠️ `restDirWorld` は「その骨から**どの子へ**向かうか」で決まる。子が複数あるボーン
 * （Hips / UpperChest / Hand）では `RigHandle.restDirection()` が**最後の子**を向くので、
 * 別の子を基準にセグメントを作ると骨があらぬ方向を向く。基準にする子の静止位置から
 * 自分で `normalize(restPosition(child) - restPosition(bone))` を作ること。
 *
 * ⚠️ 分岐のあるボーンは回転を1つしか持てないので、外部ソルバ（ラグドール等）が
 * 各枝をばらばらに動かした結果を剛体リグで厳密には再現できない。実測では骨盤の
 * 分岐で脚の付け根が最大 0.24m ずれる（`function-lab` の `npm run check:rig`）。
 * 骨長と向きは保たれるので見た目は崩れないが、質点と厳密一致はしない。
 */
export function aimWorld(
  restDirWorld: Vec3, targetDirWorld: Vec3, parentWorldQuat: Quat,
): { local: Quat; world: Quat } {
  const world = quatFromTo(restDirWorld, targetDirWorld);
  const inv: Quat = { x: -parentWorldQuat.x, y: -parentWorldQuat.y, z: -parentWorldQuat.z, w: parentWorldQuat.w };
  return { local: quatMul(inv, world), world };
}

/**
 * ワールドで骨を目標へ**部分的に**向ける。`aimWorld` の弱い版。
 *
 * 腕を伸ばすとき、肩甲帯（鎖骨）や上胸もわずかに目標側へ送ると、腕だけが
 * 生えて動くのを避けられて届く距離も伸びる。全部向けると肩が外れて見えるので、
 * `weight`(0..1) で寄与を絞り、`maxAngle` で頭打ちにする。
 *
 * 使う順序: この関数で根元側（鎖骨・上胸）を先に動かす → **動いたあとの肩の
 * ワールド位置を取り直して** `solveTwoBone` を解く。順序を逆にすると手先がずれる。
 */
export function aimWorldPartial(
  restDirWorld: Vec3, targetDirWorld: Vec3, parentWorldQuat: Quat,
  weight: number, maxAngle: number,
): { local: Quat; world: Quat } {
  const full = aimWorld(restDirWorld, targetDirWorld, parentWorldQuat);
  const w = weight < 0 ? 0 : weight > 1 ? 1 : weight;
  const local = limitRotation(quatSlerp(IDENTITY_QUAT, full.local, w), maxAngle);
  return { local, world: quatMul(parentWorldQuat, local) };
}

/**
 * 回転量を `maxAngle`(rad) までに抑える。軸は変えず、角度だけ縮める。
 *
 * 外部ソルバ（ラグドール等）が返した回転をそのまま骨へ入れると、関節が可動域を
 * 超えて曲がる（実測: 首が 3.14 rad ＝ ほぼ180°）。`BONE_JOINTS` の可動域の
 * 大きさを渡して最後に通す。
 *
 * ⚠️ これは「曲がる**量**」の制限で、ヒンジの**向き**（膝が前に折れない等）は
 * 制限しない。向きの制限は関節ごとの軸が要るので別の仕組みになる。
 */
export function limitRotation(q: Quat, maxAngle: number): Quat {
  // w >= 0 に揃える（同じ回転の短い側の表現にする）
  const s = q.w < 0 ? -1 : 1;
  const x = q.x * s, y = q.y * s, z = q.z * s, w = Math.min(1, q.w * s);
  const angle = 2 * Math.acos(w);
  if (angle <= maxAngle) return { x, y, z, w };
  const len = Math.hypot(x, y, z);
  if (len < 1e-9) return { x, y, z, w };
  const half = maxAngle / 2, k = Math.sin(half) / len;
  return { x: x * k, y: y * k, z: z * k, w: Math.cos(half) };
}

/** 関節ルールの軸まわりに angle だけ回す回転。可動域でクランプする。 */
export function hingeQuat(j: Hinge, angle: number): Quat {
  const a = clampHinge(j, angle);
  const axis: Vec3 = j.axis === "x" ? { x: 1, y: 0, z: 0 }
    : j.axis === "y" ? { x: 0, y: 1, z: 0 } : { x: 0, y: 0, z: 1 };
  return quatFromAxisAngle(axis, a);
}

// --- 2. 角度の分配 -------------------------------------------------------------

/**
 * 1つの向き（例: ボールを見るヨー角）を複数の関節へ配る。
 *
 * 各関節は自分の可動域までしか担えないので、根元から順に埋めて余りを次へ送る。
 * `bias` で「胸は控えめ、頭でよく回す」といった配分の癖を付けられる（既定は均等）。
 *
 * 戻り値は関節ごとの角度。合計が total に届かない（全部使い切っても足りない）場合は
 * 可動域いっぱいで飽和する — 呼び出し側が「体ごと向き直る」判断に使える。
 */
export function distributeAngle(total: number, joints: Hinge[], bias?: number[]): number[] {
  const out = new Array<number>(joints.length).fill(0);
  let rest = total;
  // まず bias 比で割り当て、可動域を超えた分を余りへ戻す
  const w = joints.map((_, i) => Math.max(0, bias?.[i] ?? 1));
  const wsum = w.reduce((a, b) => a + b, 0) || 1;
  for (let i = 0; i < joints.length; i++) {
    const want = total * (w[i] / wsum);
    const got = clampHinge(joints[i], want);
    out[i] = got;
    rest -= got;
  }
  // 余りを、まだ余裕のある関節へ根元から詰める
  for (let i = 0; i < joints.length && Math.abs(rest) > 1e-9; i++) {
    const room = rest > 0 ? joints[i].max - out[i] : joints[i].min - out[i];
    const add = rest > 0 ? Math.min(rest, Math.max(0, room)) : Math.max(rest, Math.min(0, room));
    out[i] += add;
    rest -= add;
  }
  return out;
}

/** {@link distributeAngle} の残り（配りきれなかった角度）。体ごと向き直る判断に使う。 */
export function distributeLeftover(total: number, parts: number[]): number {
  return total - parts.reduce((a, b) => a + b, 0);
}

// --- 3. 末端遅延（overlapping action）-----------------------------------------

/**
 * 根元→先端へ、各段が1つ手前を追いかける遅延の連鎖。
 *
 * 全部の関節を同時に動かすと硬く見える。段ごとにレートを落として数フレーム遅らせると、
 * 力が末端へ伝わっていくように見える（体幹→肩→肘→手首）。**全動作に効く**。
 *
 * `rates` は各段の追従速度(1/s)。根元を速く、先端を遅くする（例 `[24, 16, 11, 8]`）。
 */
export class LagChain {
  readonly values: number[];

  constructor(private readonly rates: number[], initial = 0) {
    this.values = new Array<number>(rates.length).fill(initial);
  }

  /** 先頭が input を、以降が1つ手前を追う。更新後の各段の値を返す（内部配列そのもの）。 */
  step(input: number, dt: number): number[] {
    let src = input;
    for (let i = 0; i < this.values.length; i++) {
      this.values[i] = expEase(this.values[i], src, this.rates[i], dt);
      src = this.values[i];
    }
    return this.values;
  }

  /** 全段を同じ値へ即座に揃える（場面転換・リセット用）。 */
  reset(v: number): void {
    this.values.fill(v);
  }

  /** 先端の値。 */
  get tip(): number {
    return this.values[this.values.length - 1];
  }
}

/** {@link LagChain} のクォータニオン版。骨の回転をそのまま遅らせる。 */
export class LagChainQuat {
  readonly values: Quat[];

  constructor(private readonly rates: number[], initial: Quat = { x: 0, y: 0, z: 0, w: 1 }) {
    this.values = rates.map(() => ({ ...initial }));
  }

  step(input: Quat, dt: number): Quat[] {
    let src = input;
    for (let i = 0; i < this.values.length; i++) {
      this.values[i] = easeQuat(this.values[i], src, this.rates[i], dt);
      src = this.values[i];
    }
    return this.values;
  }

  reset(q: Quat): void {
    for (let i = 0; i < this.values.length; i++) this.values[i] = { ...q };
  }

  get tip(): Quat {
    return this.values[this.values.length - 1];
  }
}

/**
 * 押された所を起点に、骨の連鎖を伝わっていく衝撃。
 *
 * 「頭を押されたら首から曲がり、少し遅れて胸・腰へ伝わる」を作る。
 * 剛体で全身を一度に傾けると当たった場所が分からず、板を押したように見える。
 *
 * 連鎖の添字だけを扱う（どの骨か・どの軸で曲げるかは呼び出し側）。
 */
export interface ImpulseWave {
  /** 起点の添字（連鎖の何番目を押されたか）。 */
  at: number;
  /** 起点での強さ（rad 相当）。 */
  mag: number;
  /** 発生からの経過(s)。 */
  t: number;
  /** 隣へ伝わるまでの時間(s)。0 で全身同時。 */
  travel: number;
  /** 1つ離れるごとの減り方（大きいほど当たった所だけ曲がる）。 */
  spread: number;
  /** 到達後の減衰(1/s)。 */
  decay: number;
  /**
   * 伝わる向き。`0`=両側 / `-1`=`at` より小さい側だけ / `+1`=大きい側だけ。
   *
   * ⚠️ 骨は親子なので**根元側を回すと先端側も丸ごと一緒に動く**。押された所より
   * 根元側だけを曲げないと、「頭を押したのに背骨全体が傾く」ことになる。
   * 根元が 0 番の連鎖なら `-1`。
   */
  side: -1 | 0 | 1;
  /**
   * 起点より**先端側**に掛ける倍率。`1` で根元側と同じ、`0` で曲げない。
   *
   * **負にすると先端側は逆へ曲がる＝その場に取り残される**。押された所が動き、
   * 近い所は引かれて付いていき、遠い所は元の位置に留まる、という見え方になる。
   * （腰を押したときに上半身まで一緒に倒れてしまうのを防ぐ）
   */
  tipScale: number;
  /**
   * 先端側の減り方。省略すると {@link spread} と同じ。
   *
   * ⚠️ 取り残し（`tipScale`<0）は**連鎖全体に配らないと効かない**。根元側と同じ強い
   * 減衰を使うと隣の骨だけが少し逆へ曲がって終わり、遠い部位は結局一緒に動く
   * （実測: 頭の累積が 0.368→0.296 rad にしか減らなかった）。先端側は緩く配る。
   */
  tipSpread: number;
}

export function makeImpulseWave(
  at: number, mag: number, o: Partial<Omit<ImpulseWave, 'at' | 'mag' | 't'>> = {},
): ImpulseWave {
  return {
    at, mag, t: 0,
    travel: o.travel ?? 0.05, spread: o.spread ?? 0.55, decay: o.decay ?? 5.0, side: o.side ?? 0,
    tipScale: o.tipScale ?? 1,
    tipSpread: o.tipSpread ?? o.spread ?? 0.55,
  };
}

/**
 * 添字 `i` の骨がいま曲がるべき量(rad)。まだ届いていなければ 0。
 *
 * ⚠️ ここで返るのは**その骨自身のローカル回転**。親子で積み上がるので、根元側の
 * 合計が起点の値を超えないよう `spread` を十分大きく取ること。両側 0.55 のままだと
 * 根元側の合計が起点の 1.2 倍になり、体ごと傾いて見える。
 */
export function waveAmount(w: ImpulseWave, i: number): number {
  if (w.side === -1 && i > w.at) return 0;
  if (w.side === 1 && i < w.at) return 0;
  const d = Math.abs(i - w.at);
  const u = w.t - d * w.travel;
  if (u <= 0) return 0;
  const tip = i > w.at;
  const s = tip ? w.tipScale : 1;
  return w.mag * s * Math.exp(-d * (tip ? w.tipSpread : w.spread)) * Math.exp(-u * w.decay);
}

/**
 * 時間を進める。`length` は連鎖の長さ。
 * まだどこかが動いている（届いていない骨がある／振れが残っている）間 true。
 */
export function advanceWave(w: ImpulseWave, dt: number, length: number, eps = 1e-4): boolean {
  w.t += dt;
  for (let i = 0; i < length; i++) {
    if (w.side === -1 && i > w.at) continue;
    if (w.side === 1 && i < w.at) continue;
    const d = Math.abs(i - w.at);
    if (w.t < d * w.travel) return true;      // まだ届いていない骨がある
    if (Math.abs(waveAmount(w, i)) >= eps) return true;
  }
  return false;
}
