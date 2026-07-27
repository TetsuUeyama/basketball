// 審判(レフェリー)。体形・各部位の動作速度を選手と揃えるため、選手(Player)のリグを
// そのままラップし、ユニフォームだけ審判色(グレーシャツ/黒)に再着色する。チームロジック
// には一切関与しない演出専用。得点/ファウルのシグナル、トス、スローインの投げ渡しを行う。
import { Scene, Vector3, Color3 } from "@babylonjs/core";
import { Player } from "./player/player";
import { resolveLook } from "./player/player-look";
import { ROSTER } from "../roster";

export class Referee {
  readonly body: Player;                 // 選手と同じリグ(体形・部位速度が一致)
  sigT = 0;                              // シグナル残り時間
  sigKind: "" | "score" | "foul" | "toss" | "hold" | "pass" = "";
  catchT = 0;                            // キャッチ硬直(受球直後、敏捷で決まる。移動を止める)
  private tx = 0; private tz = 0;         // 向く目標
  private prevX = 0; private prevZ = 0;   // 歩行速度計測用

  constructor(scene: Scene, idx: number) {
    // 実在の選手 def を流用し、能力はオール50、名前/身長を審判向けに差し替え。
    const base = ROSTER[0][0];
    const attr = { ...base.attr };
    for (const k in attr) (attr as Record<string, number>)[k] = 50;   // 能力オール50
    // 髪型: 審判1はロング(肩まで=10)、審判2はミディアム(センター分け=9)。肌/髪色は共通。
    const style = idx === 0 ? 10 : 9;
    const def = { ...base, name: "審判", height: 1.9, look: resolveLook([2, 0, style]), attr };
    this.body = new Player(scene, 0, 90 + idx, def as typeof base);
    this.body.setNameTagVisible(false);
    this.recolor();
    // 背番号の代わりに、大きな極太の「R」(クリムゾンレッド)を胸(前面)と背中(背面)の両方に付ける。
    this.body.setJerseyMark("R", "#DC143C");
  }

  get runSpeed(): number { return this.body.runSpeed; }
  get frozen(): boolean { return this.catchT > 0; }
  // 受球: 両手キャッチ + 敏捷(=50)由来の硬直。
  catch(): void { this.catchT = this.body.recoveryMult() * 0.4; this.signal("hold", 99); }

  // 審判ユニフォーム: 明るいグレーのシャツ、黒のパンツ/袖/靴。
  recolor(): void {
    this.body.topMat.diffuseColor = new Color3(0.86, 0.86, 0.9);   // グレーシャツ
    this.body.bottomMat.diffuseColor = new Color3(0.1, 0.1, 0.12); // 黒パンツ
    this.body.sleeveMat.diffuseColor = new Color3(0.1, 0.1, 0.12); // 黒袖
  }

  get pos(): Vector3 { return this.body.pos; }
  get curSpd(): number { return this.body.curSpd; }

  place(x: number, z: number): void {
    this.body.pos.set(x, 0, z); this.prevX = x; this.prevZ = z;
    this.body.sync();   // メッシュも即移動(ゲーム停止中=紹介中でも位置が反映される)
  }
  faceToward(x: number, z: number): void { this.tx = x; this.tz = z; }
  signal(kind: Referee["sigKind"], dur = 2.0): void { this.sigKind = kind; this.sigT = dur; }

  // ボールを持つ手のワールド位置(トス/投げ渡し用): 胸の前あたり。
  ballHold(): Vector3 {
    const cf = this.body.chestFront(0.35);
    return new Vector3(cf.x, 1.3, cf.z);
  }

  update(dt: number): void {
    const b = this.body;
    if (this.catchT > 0) this.catchT = Math.max(0, this.catchT - dt);   // キャッチ硬直
    // 歩行速度を計測してから位置差で curSpd を出す(選手と同じ脚アニメを回す)
    b.curSpd = Math.hypot(b.pos.x - this.prevX, b.pos.z - this.prevZ) / Math.max(dt, 1e-4);
    this.prevX = b.pos.x; this.prevZ = b.pos.z;
    // ボール(や対象)の方を向く — 選手と同じイージング
    b.faceSmooth(this.tx, this.tz, dt * 4);
    b.updateLegs(dt);   // 選手と同じ脚サイクル(速度で歩調)

    if (this.sigT > 0) {
      this.sigT -= dt;
      this.poseSignal();
      if (this.sigT <= 0) this.sigKind = "";
    } else {
      b.runArms();      // 平常は選手と同じ腕振り/休め
    }
    b.sync();
  }

  // シグナル/保持の腕ポーズ。選手の腕ムーバ(setArmDir/bendElbow/holdBallHands)を通すので
  // 各部位の動作速度は選手と同一(MOVE_RATE)。
  private poseSignal(): void {
    const b = this.body;
    switch (this.sigKind) {
      case "score":
      case "foul":
        // 片腕(右)を真上へ突き上げ、もう片方は下ろす
        b.setArmDir(b.armPivotR, 0.05, 1, 0);   b.bendElbow(b.elbowR, 0);
        b.setArmDir(b.armPivotL, -0.15, -0.9, 0.1); b.bendElbow(b.elbowL, 0.3);
        break;
      case "toss":
        // トス: 両腕を前上へ突き出す(ボールを投げ上げる)
        b.setArmDir(b.armPivotR, 0.1, 0.7, -0.7);  b.bendElbow(b.elbowR, 0.1);
        b.setArmDir(b.armPivotL, -0.1, 0.7, -0.7); b.bendElbow(b.elbowL, 0.1);
        break;
      case "pass": {
        // 投げ渡し: 両手を前へ押し出すチェストパスのモーション。
        const cf = b.chestFront(1.4);
        b.reach(new Vector3(cf.x, 1.4, cf.z), true);
        break;
      }
      case "hold":
        // 保持: 両手でボールを胸の前に抱える
        b.holdBallHands(this.ballHold());
        break;
    }
  }
}
