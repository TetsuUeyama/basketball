import { Scene, ArcRotateCamera, Vector3 } from "@babylonjs/core";
import { lerp } from "./util";

// ボールをサイドラインに沿って滑らかに追う放送スタイルのカメラ。
// ユーザーはドラッグ/ズーム可能。オートフォローは注視点だけを調整する。
export class BroadcastCamera {
  readonly cam: ArcRotateCamera;
  autoFollow = true;
  private targetX = 0;
  private targetZ = 0;
  private targetY = 1.2;
  // 試合前の選手紹介ツアー: true の間、introShot() が毎フレーム カメラを支配し、
  // 放送フォローは停止する
  private introMode = false;
  // クラブ選択のショーケース: true の間、選んでいるチームを固定フレームで映し続ける
  // （そのユニフォームが画面に映り、色替えが目に見えるようにするため）
  private showcase = false;

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

  /** `followBall`（飛行中／着地直後のディープショット）: ボール自体を追い、狙いを
   *  その弾道方向へ持ち上げることで、放物線とリムがフレームに収まり、決まるかどうかを
   *  視聴者が見られるようにする。それ以外: 放送のワイド。 */
  private enterIntro(): void {
    if (this.introMode) return;
    this.introMode = true;
    this.cam.lowerRadiusLimit = 2;     // 寄りの構図を許可する(endIntro で復元)
  }

  /** 試合前イントロで選手を1人フレーミングする: カメラは、その選手の顔が実際に
   *  レンダリングされる側（faceDirWorld = 目メッシュのワールド上の側。numberSide の
   *  慣習に左右されない）に数メートル離れて目線の高さで構え、体を狙う — 少し引いた
   *  ポートレートで全身がフレームに入る — そしてホールドの間（`k` 0→1）にゆっくり
   *  寄る。ツアー実行中は毎フレーム呼ぶ。 */
  introShot(p: { pos: { x: number; z: number }; faceDirWorld(): { x: number; z: number } },
            k: number, dir?: { x: number; z: number }): void {
    this.enterIntro();
    const dist = 4.3 - k * 0.7;        // 少し引き — 全身、ゆっくり寄る
    const f = dir ?? p.faceDirWorld(); // 呼び出し側が遮蔽回避済みの角度を渡すことがある
    this.cam.target.set(p.pos.x, 1.05, p.pos.z);
    this.cam.setPosition(new Vector3(p.pos.x + f.x * dist, 1.7, p.pos.z + f.z * dist));
  }

  /** ベンチの列全体を一度にフレーミングする、引きの1カット: カメラは、着席した全員が
   *  収まるだけコート側へ下がり、列を中央に据え、ホールドの間にゆっくり寄る。着席した
   *  選手は真っ直ぐ座り、ボールの方ではなくレンズを見る（チーム写真）。 */
  benchShot(players: { pos: { x: number; z: number }; faceToward(x: number, z: number): void }[],
            k: number): void {
    if (players.length === 0) return;
    this.enterIntro();
    let minZ = Infinity, maxZ = -Infinity, sumX = 0;
    for (const p of players) {
      minZ = Math.min(minZ, p.pos.z); maxZ = Math.max(maxZ, p.pos.z);
      sumX += p.pos.x;
    }
    const cx = sumX / players.length;          // ベンチの列(x ≒ コートサイドの座席)
    const cz = (minZ + maxZ) / 2;
    const span = maxZ - minZ;
    // 列が収まるまでコート側へ下がる(座席はフロアの方を向いている)
    const dist = Math.max(4.5, span * 0.62 + 2.4) - k * 0.5;
    const side = cx >= 0 ? -1 : 1;             // コート側から寄る
    const camX = cx + side * dist;
    for (const p of players) p.faceToward(camX, cz);   // 全員の顔をカメラへ
    this.cam.target.set(cx, 1.0, cz);
    this.cam.setPosition(new Vector3(camX, 2.1, cz));
  }

  /** クラブ選択中、1チームを固定フレームで映し続ける: カメラはグループの前（コート中央
   *  側）にほどほどの高さで構え、5人全員が収まるまで下がる。これによりチーム全体 — と
   *  そのリアルタイムなユニフォーム色替え — が選択シートの上に映り続ける。ステップが開いた
   *  ときに一度だけ呼ぶ。 */
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
    // 手前のサイドライン(−X)から見て、少し持ち上げて胸の高さを狙う。注視点はフレームの
    // 上寄りに置き、下部のシートが選手を隠さないようにする。
    this.cam.target.set(cx, 1.7, cz);
    this.cam.setPosition(new Vector3(cx - dist, 3.4, cz));
  }

  /** ショーケースを抜けて放送のワイドへ戻る。 */
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

  /** ツアー終了 — 放送のワイドとそのズーム制限を復元する。 */
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

  update(dt: number, ballX: number, ballZ: number, ballY = 1.2, followBall = false): void {
    if (this.introMode) return;        // イントロツアーがカメラを支配する
    if (this.showcase) return;         // クラブ選択のショーケースがカメラを支配する
    if (!this.autoFollow) return;
    if (followBall) {
      const e = Math.min(1, dt * 5);   // ワイドフレームより機敏に — ボールは速い
      this.targetX = lerp(this.targetX, ballX, e);
      this.targetZ = lerp(this.targetZ, ballZ, e);
      this.targetY = lerp(this.targetY, Math.min(1.2 + ballY * 0.35, 4.0), e);
    } else {
      // 注視点をボールへ寄せる。ワイドを保つためコート中央寄りにバイアスをかける
      this.targetX = lerp(this.targetX, ballX * 0.5, Math.min(1, dt * 2));
      this.targetZ = lerp(this.targetZ, ballZ * 0.85, Math.min(1, dt * 2));
      this.targetY = lerp(this.targetY, 1.2, Math.min(1, dt * 2));
    }
    this.cam.target.set(this.targetX, this.targetY, this.targetZ);
  }
}
