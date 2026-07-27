import { Scene, ArcRotateCamera, Vector3 } from "@babylonjs/core";
import { lerp } from "./util";

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

  update(dt: number, ballX: number, ballZ: number, ballY = 1.2, followBall = false): void {
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
      // 注視点をボールへ。ワイド維持のため中央寄りにバイアス
      this.targetX = lerp(this.targetX, ballX * 0.5, Math.min(1, dt * 2));
      this.targetZ = lerp(this.targetZ, ballZ * 0.85, Math.min(1, dt * 2));
      this.targetY = lerp(this.targetY, 1.2, Math.min(1, dt * 2));
    }
    this.cam.target.set(this.targetX, this.targetY, this.targetZ);
  }
}
