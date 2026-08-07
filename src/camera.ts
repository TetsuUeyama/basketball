import { Scene, ArcRotateCamera, Camera, Vector3 } from "@babylonjs/core";
import { lerp, clamp } from "./util";
import { COURT } from "./config";

// 攻めている方向への「先取り」。注視点をボールそのものでなく、ボールと攻めるリムの
// 間の点に置く。残り距離に比例させるので、リムへ寄るほど先取りは自然に小さくなる。
const LEAD_RATIO = 0.35;   // ボール→攻めるリムの何割まで先を見るか
const LEAD_MAX = 4.5;      // 先取りの上限(m)。自陣深くからでも行き過ぎない
const AIM_EDGE = 3.0;      // 注視点をベースラインからこれだけ内側に留める(m)

// 先取りも追従の遅れも、ボールを画面の外へ出してはいけない。ボールを必ずこの割合
// （画面の半分に対する比）の内側に保つ。1.0 = 画面の縁ちょうど。
const KEEP_IN = 0.72;

/**
 * 注視点 t が原因でボールが画角から外れるなら、外れないところまで t をボール側へ戻す。
 *
 * ArcRotateCamera はカメラ位置 = 注視点 + radius·dir(alpha,beta) なので、注視点を
 * 動かすとカメラごと平行移動する ＝ 画面上のボールの位置は「注視点からボールへの
 * ベクトル」だけで決まる。そこでそのベクトルを k 倍（0..1）に縮め、ボールが
 * 画角の内側 `keepIn` に入る最大の k を解く。ユーザーのドラッグ/ズーム
 * (alpha/beta/radius)をそのまま使うので、寄っていても回していても外れない。
 */
export function fitTargetToBall(
  cam: ArcRotateCamera, tx: number, ty: number, tz: number,
  bx: number, by: number, bz: number, keepIn = KEEP_IN,
): { x: number; y: number; z: number } {
  const sb = Math.sin(cam.beta);
  const aspect = cam.getEngine().getAspectRatio(cam);
  if (Math.abs(sb) < 1e-3 || !(aspect > 0)) return { x: tx, y: ty, z: tz };
  // 視線方向 f（注視点 → カメラ の逆）と、それに直交する画面の右/上。
  // 符号（座標系の左右手）は結果に効かない — 絶対値しか使わないため。
  const f = { x: -Math.cos(cam.alpha) * sb, y: -Math.cos(cam.beta), z: -Math.sin(cam.alpha) * sb };
  const r = { x: f.z / sb, z: -f.x / sb };                              // cross((0,1,0), f) を正規化
  const u = { x: f.y * r.z, y: f.z * r.x - f.x * r.z, z: -f.y * r.x };  // cross(f, r)
  const th = Math.tan(cam.fov / 2);
  const vertical = cam.fovMode === Camera.FOVMODE_VERTICAL_FIXED;
  const halfW = (vertical ? th * aspect : th) * keepIn;
  const halfH = (vertical ? th : th / aspect) * keepIn;
  const dx = tx - bx, dy = ty - by, dz = tz - bz;
  const af = dx * f.x + dy * f.y + dz * f.z;   // 奥行き方向のずれ
  const ar = dx * r.x + dz * r.z;              // 画面の横方向のずれ
  const au = dx * u.x + dy * u.y + dz * u.z;   // 画面の縦方向のずれ
  // |k·a| / ((radius − k·af)·half) ≤ 1 を k について解く
  const solve = (a: number, half: number): number => {
    const den = Math.abs(a) + half * af;
    return den > 1e-6 ? (half * cam.radius) / den : 1;
  };
  // ボールがカメラの手前(背面)へ回り込まないこと。上の式は radius − k·af > 0 が前提。
  const kDepth = af > 1e-6 ? (cam.radius * 0.85) / af : 1;
  const k = clamp(Math.min(solve(ar, halfW), solve(au, halfH), kDepth), 0, 1);
  return k >= 1 ? { x: tx, y: ty, z: tz } : { x: bx + dx * k, y: by + dy * k, z: bz + dz * k };
}

// イントロで1人を撮る被写体（Player が満たす）。
export type IntroSubject = { pos: { x: number; z: number }; team: number; faceDirWorld(): { x: number; z: number } };

// ボールを追う放送スタイルのカメラ。ドラッグ/ズーム可、オートフォローは注視点のみ調整。
export class BroadcastCamera {
  readonly cam: ArcRotateCamera;
  autoFollow = true;
  private targetX = 0;
  private targetZ = 0;
  private targetY = 1.2;
  // 選手紹介ツアー中は true。introShot() がカメラを支配する。
  private introMode = false;
  // クラブ選択のショーケース中は true。選択チームを固定フレームで映す。
  private showcase = false;
  // ティップオフ後の自動アングル回転(緩やかに一度だけ回し、完了でユーザー操作へ返す)。
  private autoAngle = false;
  private aimAlpha = -Math.PI / 2;
  private aimBeta = 0.95;

  constructor(scene: Scene, canvas: HTMLCanvasElement) {
    this.cam = new ArcRotateCamera("cam", -Math.PI / 2, 0.95, 24, new Vector3(0, 1.2, 0), scene);
    this.cam.attachControl(canvas, true);
    this.cam.lowerRadiusLimit = 12;
    this.cam.upperRadiusLimit = 48;
    this.cam.upperBetaLimit = 1.45;
    this.cam.lowerBetaLimit = 0.3;
    this.cam.wheelPrecision = 18;
    this.cam.panningSensibility = 0;
  }

  /** イントロモードに入る（寄りの構図を許可）。 */
  private enterIntro(): void {
    if (this.introMode) return;
    this.introMode = true;
    this.cam.lowerRadiusLimit = 2;     // 寄りの構図を許可（endIntro で復元）
  }

  /** イントロで選手を1人フレーミングする。顔側（faceDirWorld）から少し引いて構え、
   *  k(0→1) でゆっくり寄る。others を渡すと遮蔽回避角を選ぶ。毎フレーム呼ぶ。 */
  introShot(p: IntroSubject, k: number, others?: IntroSubject[]): void {
    this.enterIntro();
    const dist = 4.3 - k * 0.7;        // 少し引き、ゆっくり寄る
    const f = others ? this.framingDir(p, others) : p.faceDirWorld();
    this.cam.target.set(p.pos.x, 1.05, p.pos.z);
    this.cam.setPosition(new Vector3(p.pos.x + f.x * dist, 1.7, p.pos.z + f.z * dist));
  }

  /** 被写体の顔側で、他の選手がレイに被らない最初の角度を選ぶ（正面→±31°→±54°）。密集時は正面。 */
  private framingDir(p: IntroSubject, others: IntroSubject[]): { x: number; z: number } {
    const f = p.faceDirWorld();
    // 回り込む向きはチームで逆（0=右回り / 1=左回り）
    const s = p.team === 0 ? 1 : -1;
    for (const a of [0, 0.55 * s, -0.55 * s, 0.95 * s, -0.95 * s]) {
      const d = { x: f.x * Math.cos(a) - f.z * Math.sin(a), z: f.x * Math.sin(a) + f.z * Math.cos(a) };
      const blocked = others.some((q) => {
        if (q === p) return false;
        const rx = q.pos.x - p.pos.x, rz = q.pos.z - p.pos.z;
        const t = rx * d.x + rz * d.z;                 // レイに沿った成分
        if (t < 0.4 || t > 4.4) return false;          // 被写体とレンズの間にいない
        return Math.abs(rx * d.z - rz * d.x) < 0.65;   // レイに近すぎる = かぶり
      });
      if (!blocked) return d;
    }
    return f;   // 密集 — 正面で妥協
  }

  /** ベンチの列全体を1カットでフレーミングする。k で寄る。着席選手はレンズを向く。 */
  benchShot(players: { pos: { x: number; z: number }; faceToward(x: number, z: number): void }[],
            k: number): void {
    if (players.length === 0) return;
    this.enterIntro();
    let minZ = Infinity, maxZ = -Infinity, sumX = 0;
    for (const p of players) {
      minZ = Math.min(minZ, p.pos.z); maxZ = Math.max(maxZ, p.pos.z);
      sumX += p.pos.x;
    }
    const cx = sumX / players.length;          // ベンチの列（x ≒ コートサイドの座席）
    const cz = (minZ + maxZ) / 2;
    const span = maxZ - minZ;
    // 列が収まるまでコート側へ下がる
    const dist = Math.max(4.5, span * 0.62 + 2.4) - k * 0.5;
    const side = cx >= 0 ? -1 : 1;             // コート側から寄る
    const camX = cx + side * dist;
    for (const p of players) p.faceToward(camX, cz);   // 全員の顔をカメラへ
    this.cam.target.set(cx, 1.0, cz);
    this.cam.setPosition(new Vector3(camX, 2.1, cz));
  }

  /** クラブ選択中、1チームを固定フレームで映す。5人が収まるまで下がる。 */
  showcaseTeam(players: { pos: { x: number; z: number } }[]): void {
    if (players.length === 0) return;
    this.showcase = true;
    this.cam.lowerRadiusLimit = 6;
    let sx = 0, minZ = Infinity, maxZ = -Infinity;
    for (const p of players) {
      sx += p.pos.x;
      minZ = Math.min(minZ, p.pos.z); maxZ = Math.max(maxZ, p.pos.z);
    }
    const cx = sx / players.length;
    const cz = (minZ + maxZ) / 2;
    const span = Math.max(maxZ - minZ, 6);
    const dist = span * 0.95 + 6;
    // 手前サイドライン(−X)から胸の高さを狙う。注視点は上寄りでシートに隠れないように。
    this.cam.target.set(cx, 1.7, cz);
    this.cam.setPosition(new Vector3(cx - dist, 3.4, cz));
  }

  /** 放送のワイドへ戻る。 */
  endShowcase(): void {
    if (!this.showcase) return;
    this.showcase = false;
    this.cam.lowerRadiusLimit = 12;
    this.targetX = 0; this.targetZ = 0; this.targetY = 1.2;
    this.cam.target.set(0, 1.2, 0);
    this.cam.alpha = -Math.PI / 2;
    this.cam.beta = 0.95;
    this.cam.radius = 24;
  }

  /** ツアー終了 — 放送のワイドへ戻す。 */
  endIntro(): void {
    if (!this.introMode) return;
    this.introMode = false;
    this.cam.lowerRadiusLimit = 12;
    this.targetX = 0; this.targetZ = 0; this.targetY = 1.2;
    this.cam.target.set(0, 1.2, 0);
    this.cam.alpha = -Math.PI / 2;
    this.cam.beta = 0.95;
    this.cam.radius = 24;
  }

  /** ティップオフ後、放送アングルを90°回して構える: −Xサイドからベンチ(+X)を奥に、やや斜め上から
   *  見下ろす。緩やかに一度だけ回し、完了したらユーザーのドラッグ/ズームへ操作を返す。 */
  orientBroadcast(): void {
    this.autoAngle = true;
    this.aimAlpha = -Math.PI;   // 既定 −π/2 から90°回転 → ベンチ(+X)が奥
    this.aimBeta = 1.2;         // 水平寄り = 選手を横から見る側面ビュー(やや見下ろし)
  }
  /** 自動アングル回転を取り消す(新しい試合の準備など)。 */
  cancelAutoAngle(): void { this.autoAngle = false; }

  // goalZ = 攻撃側が攻めるリムの Z。注視点をその向きへ少し先取りさせる。
  update(dt: number, ballX: number, ballZ: number, ballY = 1.2, followBall = false,
         goalZ = 0): void {
    if (this.introMode) return;        // ツアーがカメラを支配
    if (this.showcase) return;         // ショーケースがカメラを支配
    // ティップオフ後の自動アングル: alpha/beta を目標へ緩やかに寄せ、着いたらユーザー操作へ返す
    if (this.autoAngle) {
      const e = Math.min(1, dt * 0.5);   // 緩やかな回転速度
      this.cam.alpha = lerp(this.cam.alpha, this.aimAlpha, e);
      this.cam.beta = lerp(this.cam.beta, this.aimBeta, e);
      if (Math.abs(this.cam.alpha - this.aimAlpha) < 0.005 && Math.abs(this.cam.beta - this.aimBeta) < 0.005) {
        this.cam.alpha = this.aimAlpha; this.cam.beta = this.aimBeta;
        this.autoAngle = false;
      }
    }
    if (!this.autoFollow) return;
    if (followBall) {
      const e = Math.min(1, dt * 5);   // ボールは速いので機敏に
      this.targetX = lerp(this.targetX, ballX, e);
      this.targetZ = lerp(this.targetZ, ballZ, e);
      this.targetY = lerp(this.targetY, Math.min(1.2 + ballY * 0.35, 4.0), e);
    } else {
      // 注視点はボールそのものでなく、攻めている向きへ少し先。速攻ではその先の
      // スペースが、ハーフコートではリム側が画に入る。
      const lead = clamp((goalZ - ballZ) * LEAD_RATIO, -LEAD_MAX, LEAD_MAX);
      const aimZ = clamp(ballZ + lead, -(COURT.halfL - AIM_EDGE), COURT.halfL - AIM_EDGE);
      this.targetX = lerp(this.targetX, ballX * 0.5, Math.min(1, dt * 2));   // 奥行きは中央寄り
      this.targetZ = lerp(this.targetZ, aimZ, Math.min(1, dt * 2));
      this.targetY = lerp(this.targetY, 1.2, Math.min(1, dt * 2));
    }
    // 先取り・中央寄せ・追従の遅れのどれが原因でも、ボールを画面の外へ出さない。
    // 平滑化した後に掛けるので、この保証は毎フレーム成り立つ。
    const fit = fitTargetToBall(this.cam, this.targetX, this.targetY, this.targetZ, ballX, ballY, ballZ);
    this.targetX = fit.x; this.targetY = fit.y; this.targetZ = fit.z;
    this.cam.target.set(this.targetX, this.targetY, this.targetZ);
  }
}
