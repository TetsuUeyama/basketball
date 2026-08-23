/**
 * balance — 重心と支持基底のバランス制御。Babylon 非依存の層1。
 *
 * IK は「決まった位置へ肢を届かせる」だけで、**踏み出すべきかどうかは決められない**。
 * ここがその判断層。倒立振子モデルで、
 *
 *   1. 小さな崩れ … 足を動かさず、足首まわりの踏ん張りだけで戻す（CoP を支持基底内で動かす）
 *   2. 中くらい   … その場では止まれない → 足を踏み出して支持基底ごと動かす
 *   3. 大きい     … 踏み出しても届かない → **転倒**（呼び出し側がラグドールへ渡す）
 *
 * 重心は水平面(x,z)だけを解く。高さは一定（倒立振子の前提）。
 *
 * 座標系: 右手系・Y が鉛直上向き・単位はメートル。
 */

export interface Vec2 { x: number; z: number; }

export interface Foot {
  /** 足首の位置。 */
  x: number; z: number;
  /** 接地しているか。踏み出し中の足は false になり支持基底から外れる。 */
  planted: boolean;
  /** 足首から見たかかとの位置（省略＝足首と同じ）。 */
  heel?: Vec2;
  /** 足首から見たつま先の位置（省略＝足首と同じ）。 */
  toe?: Vec2;
}

/** 支持基底の円。かかととつま先から作る。 */
export interface SupportCircle { x: number; z: number; r: number; }

export interface BalanceOptions {
  /** 重心の高さ(m)。倒立振子の長さ。 */
  comHeight: number;
  /** 一歩で届く最大距離(m)。脚の全長から決める。これを超える踏み出しが要ると転倒。 */
  maxStep: number;
  /** 支持基底の余裕(m)。足の実寸ぶん、足の点のまわりに広げる。 */
  supportMargin?: number;
  /** 踏み出しにかかる時間(s)。この間その足は接地しない。 */
  stepDuration?: number;
  /**
   * 踏み出し時間を時定数 τ に対する比で指定する（指定すると stepDuration より優先）。
   * ⚠️ 固定秒だと**重心を下げたときに相対的に遅すぎる**。重心が低いほど振子は速く
   *    (g/h が大きい)、滞空中に離れる量 e^(滞空/τ) が増えて一歩で追いつけなくなる。
   *    実測で重心 1.07m→0.75m は耐性が上がるのに 0.60m で下がった。τ 比なら単調になる。
   */
  stepTauRatio?: number;
  /** 続けて踏める回数。超えたら踏ん張りきれなかったとして転倒。 */
  maxSteps?: number;
  /**
   * 支持基底の中心へ引き戻す強さ。
   * ⚠️ キャプチャポイントだけで CoP を決めると**止まりはするが中心へ戻らない**
   * （静止した位置がそのまま平衡点になる。実測で 80mm ずれたまま留まり、そこから
   * 微小な踏み出しを繰り返して転倒まで行った）。この項が復元を担う。
   */
  returnGain?: number;
  /**
   * 静止時の各足の定位置（**重心から見た相対位置**）。落ち着いたらここへ戻す。
   * ⚠️ 無いと踏み出した足がその場に残り、**足幅が広がったままになる**。
   */
  stance?: Vec2[];
  /**
   * 定位置からこれ以上ずれていたら足を戻す(m)。**そのまま残差になる**ので小さく取る。
   * ⚠️ 以前は 0.06 にしていたが、戻し切れず足幅が 51mm 狭いまま残った。
   *    `stanceDirty` で「踏み出した後だけ戻す」ようにしたので、小刻みに動く心配は無い。
   */
  stanceTolerance?: number;
  /**
   * 支持基底の円の**中にいる間**の速度の残り率（1秒あたり）。
   * 円の中では姿勢制御をしないが、完全に無制御だと僅かな速度で重心が漂い続け、
   * いずれ必ず円から出てしまう。体自身の粘性（通常の歩行動作で吸収される分）として
   * ここで落とす。1 で減衰なし。
   */
  insideDamping?: number;
  /**
   * 円の中で重心を支持基底の中心へ戻す強さ(1/s²)。0 で戻さない。
   *
   * ⚠️ 0 にすると重心がずれたまま止まり、**腰がずれた＝太もも・脛が傾いたまま**になる
   * （実測で 63mm ずれたまま静止した）。足は動かさないが、姿勢は戻す必要がある。
   * 足首の踏ん張りに相当する。踏み出しや沈み込みは**起こさない**。
   */
  insideReturn?: number;
  /**
   * 股関節で吸収できる重心のずれ(m)。足の円の外側へこの分だけ CoP を出せる。
   *
   * 人のバランスには段階がある。足首だけで耐える（ankle strategy）→ 腰を折って
   * 上体を振り出し、実効的な CoP を足の外まで持っていく（hip strategy）→ 踏み出す。
   * 足の円しか無いと真ん中の段階が抜け、**足首の限界がそのまま踏み出しの限界**になる。
   *
   * 0 で無効（＝足首だけ）。{@link hipLean} でどれだけ使っているかを取れる。
   */
  hipAbsorb?: number;
  /**
   * 2本目を出すまでの遅れ（1歩の所要時間に対する比）。0 で完全に同時。
   *
   * ⚠️ 0 にすると両足が同時に地面を離れて支持が消える。少しずらして、1本目が
   * 浮いている間に2本目が離陸する形にする。
   */
  stepDelay?: number;
  /**
   * 両足を出す閾値。1歩目の距離が `一歩の限界 × これ` を超えたら2本目も出す。
   * 1 以上で「常に1本ずつ」。小さいほど両足が出やすい。
   */
  bothStepRatio?: number;
  /**
   * 押しの伝わり方。`true`（既定）で「**既に逃げているぶんは伝わらない**」。
   *
   * 押す手の速さより体が速く逃げていれば、それ以上は押せない。これが無いと
   * 連打のたびに速度が足し込まれて青天井になる（実測: 0.5m/s の5連打で 2.5m/s）。
   * `false` で単純加算（従来の挙動）。
   */
  pushChase?: boolean;
  gravity?: number;
}

export interface SwingState {
  /** 踏み出している足の添字。 */
  foot: number;
  from: Vec2;
  to: Vec2;
  /** 0..1 の進捗。 */
  t: number;
  /**
   * 離陸までの待ち(s)。0 になるまで足は**接地したまま**。
   * これで2本目を少し遅らせて出せる（同時に地面から離すと支持が消えるため）。
   */
  delay?: number;
  /**
   * バランスは取れていて、足を定位置へ置き直しているだけか。
   * ⚠️ この区別が無いと、置き直しの間も片足支持として重心が加速し、着地すると
   *    もう片方がズレて…と延々に繰り返す（実測 41歩の暴走）。
   *    balance が取れているうえでの置き直しは体を不安定にしない。
   */
  recovery?: boolean;
}

export interface Balance {
  com: Vec2;
  vel: Vec2;
  feet: Foot[];
  /**
   * 進行中の踏み出し。**同時に複数走る**。
   * ⚠️ 1本ずつしか出せないと、強く押されたとき「片足が着地してからもう片足」に
   *    なり、**もう片方が明らかに遅れて動く**。強い外乱では人は両足を続けて出す。
   */
  swings: SwingState[];
  /** 連続で踏み出した回数（落ち着くと 0 に戻る）。 */
  stepsTaken: number;
  /** 転倒した。以後の更新は何もしない。 */
  fallen: boolean;
  /**
   * バランスのために足を踏み出したので、落ち着いたら定位置へ戻す必要がある。
   * ⚠️ このフラグ無しで「定位置とのズレ」だけを見て戻すと、**円の中で重心が少し
   *    ドリフトしただけでも足が動く**（実測: 弱い押しで 72mm ずれ → 不感帯 60mm 超で発動）。
   *    円の中では何も起こさない、が仕様。
   */
  stanceDirty: boolean;
  opts: Required<BalanceOptions>;
  accum: number;
}

/** 内部の固定タイムステップ(s)。フレームレートに依らず同じ結果にするため。 */
export const FIXED_DT = 1 / 120;
const MAX_SUBSTEPS = 8;

const DEFAULTS = {
  supportMargin: 0.09,
  stepDuration: 0.22,
  maxSteps: 3,
  returnGain: 0.45,
  stance: [],
  stanceTolerance: 0.015,
  stepTauRatio: 0.665,
  insideDamping: 0.02,
  insideReturn: 9.0,
  hipAbsorb: 0.08,
  stepDelay: 0.7,
  bothStepRatio: 0.5,
  pushChase: true,
  gravity: 9.81,
};

/** 倒立振子の時定数 √(h/g)。踏み出し位置と速度しきい値はここから出る。 */
export function timeConstant(comHeight: number, gravity = DEFAULTS.gravity): number {
  return Math.sqrt(comHeight / gravity);
}

export function makeBalance(com: Vec2, feet: Foot[], opts: BalanceOptions): Balance {
  return {
    com: { ...com }, vel: { x: 0, z: 0 },
    feet: feet.map((f) => ({ ...f })),
    swings: [], stepsTaken: 0, fallen: false, stanceDirty: false,
    opts: { ...DEFAULTS, ...opts },
    accum: 0,
  };
}

/**
 * 外乱を与える（重心の速度を足す）。
 *
 * `height` を渡すと**押された高さで効き方が変わる**。足首を支点に回る棒とみなすと、
 * 高さ h に与えた力積 J による重心の速度は `J·h /(m·h_com)` ＝ **h/h_com に比例**する。
 * 胸を押すのと膝を押すのとでは、同じ力でも倒れ方が違う。
 * 省略すると重心の高さ（＝倍率1.0）。
 *
 * `transmit` は**重心まで伝わる割合**（{@link transmitRatio}）。体の中心から遠い所
 * （頭・手足）を押すと、そこが動いて力を逃がすので重心はあまりブレない。
 */
export function pushBalance(
  b: Balance, vx: number, vz: number, height?: number, transmit = 1,
): void {
  const k = (height === undefined ? 1 : height / Math.max(1e-6, b.opts.comHeight)) * transmit;
  if (!b.opts.pushChase) { b.vel.x += vx * k; b.vel.z += vz * k; return; }
  // ⚠️ 単純に足すと**連打で青天井**になる（0.5m/s を5連打で 2.5m/s＝必ず転ぶ）。
  //    実際には、押す手より体が速く逃げていればそれ以上は伝わらない。
  //    押す向きの成分だけを見て「まだ足りないぶん」を足す。
  const sp = Math.hypot(vx, vz);
  if (sp < 1e-9) return;
  const dx = vx / sp, dz = vz / sp;
  const along = b.vel.x * dx + b.vel.z * dz;       // その向きへ既に出ている速度
  const add = Math.max(0, sp * k - along);
  b.vel.x += dx * add;
  b.vel.z += dz * add;
}

/**
 * 接触点が体の中心から遠いほど、重心へ伝わる割合は小さくなる。
 *
 * 硬い胴を押せば力はそのまま重心へ行くが、頭や手足のように**先で動ける所**を押すと
 * そこが振られて力を逃がす。`half` の距離で伝わる割合が半分になる。
 *
 * 逃がしたぶんは押された部位の動きが大きくなる（見た目は呼び出し側で作る）。
 */
export function transmitRatio(distFromCenter: number, half = 0.5): number {
  return 1 / (1 + Math.max(0, distFromCenter) / Math.max(1e-6, half));
}

/**
 * キャプチャポイント＝この速度で倒れ続けたとき、そこへ足を置けば止まれる点。
 * `重心 + 速度 × √(h/g)`。踏み出し先はここ。
 */
export function capturePoint(b: Balance): Vec2 {
  const tau = timeConstant(b.opts.comHeight, b.opts.gravity);
  return { x: b.com.x + b.vel.x * tau, z: b.com.z + b.vel.z * tau };
}

/** 接地している足の重心（支持基底の中心）。 */
export function supportCenter(b: Balance): Vec2 {
  const c = supportCircle(b);
  return { x: c.x, z: c.z };
}

/** その足がいま踏み出し中なら、その状態。待機中(`delay`>0)も含む。 */
export function swingOf(b: Balance, foot: number): SwingState | null {
  return b.swings.find((s) => s.foot === foot) ?? null;
}

/** いま踏み出し中の足の本数（待機中は数えない）。 */
export function swingCount(b: Balance): number {
  return b.swings.filter((s) => !s.delay).length;
}

/** 接地している足の、かかととつま先の点を集める。 */
export function footPoints(b: Balance): Vec2[] {
  const pts: Vec2[] = [];
  for (const f of b.feet) {
    if (!f.planted) continue;
    pts.push({ x: f.x + (f.heel?.x ?? 0), z: f.z + (f.heel?.z ?? 0) });
    pts.push({ x: f.x + (f.toe?.x ?? 0), z: f.z + (f.toe?.z ?? 0) });
  }
  return pts;
}

/**
 * 支持基底の円。**両足のかかととつま先**の中心を円の中心とし、そこから最も遠い点
 * までを半径にする。`supportMargin` はさらに外側へ足す余裕。
 *
 * この円の中に重心がある限り、体は安定していて何の制御も要らない。
 * 外れたときだけバランスを取る（{@link stepBalance}）。
 */
export function supportCircle(b: Balance): SupportCircle {
  const pts = footPoints(b);
  if (pts.length === 0) return { x: b.com.x, z: b.com.z, r: 0 };
  let cx = 0, cz = 0;
  for (const p of pts) { cx += p.x; cz += p.z; }
  cx /= pts.length; cz /= pts.length;
  let r = 0;
  for (const p of pts) r = Math.max(r, Math.hypot(p.x - cx, p.z - cz));
  return { x: cx, z: cz, r: r + b.opts.supportMargin };
}

/**
 * 制御に使える円。**足の円 + `hipAbsorb`**。
 *
 * 足の円（{@link supportCircle}）は「足の裏が地面に触れている範囲」なので、CoP は
 * 本来そこから出せない。しかし人は腰を折って上体を振り出すことで、実効的な CoP を
 * 足の外まで持っていける（hip strategy）。その分をここで足す。
 *
 * 描画や「安定しているか」の判定には**足の円**を、踏み出すかどうかの判定と
 * CoP の押し込みには**この円**を使う。
 */
export function controlCircle(b: Balance): SupportCircle {
  const c = supportCircle(b);
  return { x: c.x, z: c.z, r: c.r + Math.max(0, b.opts.hipAbsorb) };
}

/** 点を制御できる円の中へ押し込んだ位置を返す。 */
export function clampToSupport(b: Balance, p: Vec2): Vec2 {
  const c = controlCircle(b);
  return towards({ x: c.x, z: c.z }, p, c.r);
}

/**
 * いま股関節でどれだけ吸収しているか。`amount` は 0..1（1 = `hipAbsorb` を使い切り）。
 * `x`/`z` は吸収している向きの単位ベクトル。腰を傾ける量に使う。
 *
 * ⚠️ 基準は重心の位置ではなく**キャプチャポイント**（＝倒れていく先）。腰は「今どこに
 * いるか」ではなく「このままだとどこまで行くか」に対して働く。重心で測ると、
 * 速度で押し込まれている最中はまだ円の中なので **0% のまま動かない**（実測: 0.6m/s の
 * 押しで足は出ないのに吸収 0%）。
 *
 * 足の円の中（`amount`=0）では何もしない。円から出た分だけ腰が働く。
 */
export function hipLean(b: Balance): { x: number; z: number; amount: number } {
  const c = supportCircle(b);
  const cp = capturePoint(b);
  const dx = cp.x - c.x, dz = cp.z - c.z;
  const d = Math.hypot(dx, dz);
  const over = d - c.r;
  if (over <= 0 || d < 1e-9 || b.opts.hipAbsorb <= 0) return { x: 0, z: 0, amount: 0 };
  return { x: dx / d, z: dz / d, amount: Math.min(1, over / b.opts.hipAbsorb) };
}

/** 重心が支持基底の円の中にあるか＝バランスを取る必要がないか。 */
export function isStable(b: Balance): boolean {
  const c = supportCircle(b);
  return Math.hypot(b.com.x - c.x, b.com.z - c.z) <= c.r;
}

/** `from` から `p` の方へ、最大 `max` だけ進んだ点。 */
function towards(from: Vec2, p: Vec2, max: number): Vec2 {
  const dx = p.x - from.x, dz = p.z - from.z;
  const d = Math.hypot(dx, dz);
  if (d <= max || d < 1e-9) return { ...p };
  return { x: from.x + (dx / d) * max, z: from.z + (dz / d) * max };
}

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/**
 * いま「どれだけ崩れているか」(0..1)。
 * キャプチャポイントが支持基底からどれだけ外へ出ているかを、支持基底の余裕で正規化する。
 * 0 = その場で止まれる（無事）／1 = 余裕1つぶん外れている（かなり崩れた）。
 */
export function disturbance(b: Balance): number {
  // 股関節で吸収できる分は「まだ崩れていない」。制御できる円で測る。
  const c = controlCircle(b);
  const over = Math.hypot(b.com.x - c.x, b.com.z - c.z) - c.r;
  return Math.min(1, Math.max(0, over) / Math.max(1e-6, c.r));
}

/**
 * 崩れの大きさから「重心をどれだけ下げるべきか」(0..maxDrop) を返す。
 *
 * **押されたら沈んで耐え、収まったら立ち上がる**を作るための目標値。
 * 重心が低いほど τ=√(h/g) が小さくなり、キャプチャポイントが近くなって崩れにくい
 * （実測: 重心 1.07m→0.60m で耐えられる速度が 1.4→1.9 m/s）。
 *
 * 呼び出し側はこの値へ**レート制限付きで**近づけること。人は瞬間には沈めないし、
 * 立ち上がりは沈むより遅い。
 */
export function crouchTarget(b: Balance, maxDrop: number): number {
  return disturbance(b) * maxDrop;
}

/** キャプチャポイントが支持基底の外か＝その場では止まれないか。 */
export function needsStep(b: Balance): boolean {
  const cp = capturePoint(b);
  return dist(cp, clampToSupport(b, cp)) > 1e-6;
}

/**
 * 時間を進める。内部は固定ステップなのでフレームレートに依らず同じ結果になる。
 *
 * 各ステップで:
 *   - 望ましい CoP（＝キャプチャポイント）を支持基底の中へ押し込む
 *   - 倒立振子 `a = (g/h)(com − cop)` で重心を更新
 *     （CoP を重心の進行方向側に置けるほど減速でき、置けなければ加速し続ける）
 *   - 押し込みきれなければ踏み出しを開始。届かなければ転倒。
 */
export function stepBalance(b: Balance, dt: number): void {
  if (b.fallen) return;
  b.accum += dt;
  let n = 0;
  while (b.accum >= FIXED_DT && n < MAX_SUBSTEPS) {
    substep(b);
    b.accum -= FIXED_DT;
    n++;
    if (b.fallen) { b.accum = 0; return; }
  }
  if (n === MAX_SUBSTEPS) b.accum = 0;
}

function substep(b: Balance): void {
  const {
    comHeight, gravity, maxStep, maxSteps, returnGain, stepTauRatio, insideDamping, insideReturn,
    stepDelay, bothStepRatio,
  } = b.opts;
  const tau = timeConstant(comHeight, gravity);
  // 踏み出し時間は τ 比で決める（重心の高さに追随する）
  const stepDuration = stepTauRatio > 0 ? stepTauRatio * tau : b.opts.stepDuration;

  // 踏み出し中の足を運ぶ（複数同時に走りうる）
  for (const sw of b.swings) {
    if (sw.delay !== undefined && sw.delay > 0) {
      sw.delay -= FIXED_DT;      // 待っている間は接地したまま＝支持が消えない
      if (sw.delay > 0) continue;
      sw.delay = 0;
    }
    const f = b.feet[sw.foot];
    f.planted = false;           // 実際に離陸するのはここ
    sw.t += FIXED_DT / stepDuration;
    if (sw.t >= 1) {
      f.x = sw.to.x; f.z = sw.to.z; f.planted = true;
    } else {
      f.x = sw.from.x + (sw.to.x - sw.from.x) * sw.t;
      f.z = sw.from.z + (sw.to.z - sw.from.z) * sw.t;
    }
  }
  if (b.swings.length > 0) b.swings = b.swings.filter((sw) => sw.t < 1);

  // ⚠️ 重心が支持基底の円の中にある間は**何もしない**。体は安定していて、
  //    バランスを取らなくても自由に動ける。円から出たときだけ制御が働く。
  const circle = supportCircle(b);
  // 置き直しの間は「安定している」扱い（片足支持で加速させない）
  const recovering = b.swings.some((s) => s.recovery);
  // 両足とも浮いている間は制御できない（支持が無い）。弾道に任せる。
  const airborne = !b.feet.some((f) => f.planted);
  const outside = !recovering && !airborne
    && Math.hypot(b.com.x - circle.x, b.com.z - circle.z) > circle.r;

  const cp = capturePoint(b);
  if (outside) {
    // 足首の踏ん張り: CoP を支持基底内で、できるだけ「止めたい点」へ寄せる。
    // 止めたい点 = キャプチャポイント（減速）+ 円の中心からのズレ（復元）。
    const want = {
      x: cp.x + (b.com.x - circle.x) * returnGain,
      z: cp.z + (b.com.z - circle.z) * returnGain,
    };
    const cop = clampToSupport(b, want);
    const k = gravity / comHeight;
    b.vel.x += k * (b.com.x - cop.x) * FIXED_DT;
    b.vel.z += k * (b.com.z - cop.z) * FIXED_DT;
  } else {
    // 円の中: 足は動かさず踏み出しもしないが、姿勢は立ち位置へ戻す。
    // （戻さないと腰がずれたまま＝太もも・脛が傾いたままになる）
    // ⚠️ 置き直し中は引き戻さない。片足だけの円の中心は横にずれており、
    //    そこへ引っ張ると重心が振り回されて復帰が壊れる。
    if (!recovering) {
      b.vel.x += (circle.x - b.com.x) * insideReturn * FIXED_DT;
      b.vel.z += (circle.z - b.com.z) * insideReturn * FIXED_DT;
    }
    const d = Math.pow(insideDamping, FIXED_DT);
    b.vel.x *= d; b.vel.z *= d;
  }
  b.com.x += b.vel.x * FIXED_DT;
  b.com.z += b.vel.z * FIXED_DT;

  // 落ち着いたら踏み出し回数をリセット
  // 止まれる ＝ キャプチャポイントが円の中（＝そこへ重心が落ち着く）
  const cpIn = clampToSupport(b, cp);
  const canStop = dist(cp, cpIn) < 1e-6;
  if (b.swings.length === 0 && Math.hypot(b.vel.x, b.vel.z) < 0.05 && canStop) {
    b.stepsTaken = 0;
    b.stanceDirty = false;
    // ⚠️ ここで「足を定位置へ戻す」歩を出してはいけない。戻すと支持基底が動いて
    //    重心が押し返され、また戻して…と**反復横跳び**になる（実測で往復が止まらない）。
    //    足幅は「戻す」のではなく、**踏み出しの着地点そのものを定位置に取る**ことで
    //    保つ（下の踏み出しで `stance` を足している）。
    return;
  }

  // その場で止まれない → 踏み出す
  // ⚠️ 踏み出すかは**キャプチャポイント**で決める。復元項を混ぜた want で判定すると、
  //    その場で止まれるのに微小な踏み出しを繰り返し、回数上限で転倒する（実測）。
  if (b.swings.length === 0 && !canStop) {
    if (b.stepsTaken >= maxSteps) { b.fallen = true; return; }
    // ⚠️ 踏み出し先は「今の」キャプチャポイントではなく**着地時点の**キャプチャポイント。
    //    滞空中(stepDuration)、支持は残る片足だけになり重心は指数的に離れる:
    //      cp(t) = cop + (cp0 − cop)·e^(t/τ)
    //    実測 τ=0.331s / 滞空0.22s では e^0.665 ≈ 1.94 倍。今の cp を狙うと着地時には
    //    倍近く離れており、1歩で追いつけず転倒していた。
    // 踏み出す足は、倒れていく方向（キャプチャポイント）に近い側
    let idx = 0, bestD = Infinity;
    for (let i = 0; i < b.feet.length; i++) {
      const d = dist(b.feet[i], cp);
      if (d < bestD) { bestD = d; idx = i; }
    }
    // ⚠️ 予測の支点は**残る軸足**。両足の CoP を支点にすると軸足より前に取るぶん
    //    成長を過小評価し、踏み出しが常に足りずに転倒する（実測: どの速度でも
    //    「踏み出して復帰」する帯が存在しなかった）。
    const pivot = b.feet[1 - idx] ?? b.feet[idx];
    // ⚠️ キャプチャポイントが e^(t/τ) で離れていくのは**軸足が接地している間だけ**。
    //    両足が浮いている間は支持が無く、重心は等速なので CP は伸びない。
    //    伸び続ける前提で予測すると踏み出しが行き過ぎ、着地後に重心が追いつかず
    //    **踏み戻し**が起きる（実測: 足が z=0.772 まで出て 0.132 へ戻った）。
    const landAt = (supported: number): Vec2 => {
      const g = Math.exp(supported / tau);
      return { x: pivot.x + (cp.x - pivot.x) * g, z: pivot.z + (cp.z - pivot.z) * g };
    };
    // 2本目を重ねて出すかは踏み出しの大きさで決まるので、まず全滞空ぶんで仮に見積もる
    const overlap = b.feet.length > 1
      && dist(b.feet[idx], landAt(stepDuration)) > maxStep * bothStepRatio;
    // 軸足が接地している時間 = 2本目が離陸するまで（重ねない場合は滞空いっぱい）
    const land = landAt(overlap ? stepDelay * stepDuration : stepDuration);
    // 1歩目は**キャプチャポイントちょうど**へ。ここをずらすと減速点を外して止まれない
    // （実測: 足1本ぶん外へずらしたら耐性 1.40→0.85 m/s に落ちた）。
    const from = { x: b.feet[idx].x, z: b.feet[idx].z };
    const lead = dist(from, land);
    if (lead > maxStep) { b.fallen = true; return; }   // 届かない → 転倒
    b.feet[idx].planted = false;
    b.swings.push({ foot: idx, from, to: land, t: 0 });

    // ⚠️ もう片方も**必ず**続けて運ぶ。片足だけ動かすと支持基底の中心が両足の中点＝
    //    重心から見て足幅の半分ずれた所になり、あとから「足を戻す」歩が要る。
    //    その戻し歩がまた支持基底を動かして重心を押し返し、**反復横跳び**になる。
    //    2本目を新しい足幅の位置へ置けば、着地した時点で定位置になっていて戻しが要らない。
    if (b.feet.length > 1) {
      const j = 1 - idx;
      const st = b.opts.stance;
      const off = st && st.length === b.feet.length
        ? { x: st[j].x - st[idx].x, z: st[j].z - st[idx].z }
        : { x: b.feet[j].x - b.feet[idx].x, z: b.feet[j].z - b.feet[idx].z };
      const t2 = { x: land.x + off.x, z: land.z + off.z };
      const from2 = { x: b.feet[j].x, z: b.feet[j].z };
      if (dist(from2, t2) > b.opts.stanceTolerance && dist(from2, t2) <= maxStep) {
        // 大きく踏み出すときだけ滞空を重ねる。小さいときは1歩目の着地と同時に出す。
        b.swings.push({
          foot: j, from: from2, to: t2, t: 0,
          delay: (overlap ? stepDelay : 1) * stepDuration,
        });
      }
    }
    // ⚠️ 両足まとめて1回と数える。2回に数えると転倒の閾値が半分になる。
    b.stepsTaken++;
  }
}
