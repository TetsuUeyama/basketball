// 守備の手（オンボール守備/ディナイ/コンテスト/腕広げ）アクションのアニメ。
// basic/arms のムーバ経由で動く。切り替え速度は armRateCap(rad/s) の規約。
import { Vector3 } from "@babylonjs/core";
import { Player } from "../../objects/player/player";

declare module "../../objects/player/player" {
  interface Player {
    armsWide(rate?: number): void;
    guardDrive(world: Vector3, useRight: boolean, rate?: number): void;
    denyLane(useRight: boolean, rate?: number): void;
    handsUp(rate?: number): void;
  }
}

/** 両腕を大きく広げる — 左右のドライブを壁で防ぐアクティブな手。`rate` (rad/s)が
 *  切り替えをレート制限する。0は即座に切り替える（ベンチ/非守備用途）。 */
Player.prototype.armsWide = function(rate = 0): void {
    this.armRateCap = rate;
    this.setArmDir(this.armPivotL, -1, -0.35, 0.35);
    this.setArmDir(this.armPivotR, 1, -0.35, 0.35);
    this.bendElbow(this.elbowL, 0);   // 前腕が外へ伸びる、イーズ
    this.bendElbow(this.elbowR, 0);
    this.armRateCap = 0;
};

/** ストレートドライブを止める: ボールに近い手が前かつ低く出て侵入を壁で防ぎ
 *  ボールを突く（スティール）、逆の手はスライド中のバランスのため低く外へ構える。
 *  `rate` が向け直しをレート制限する。 */
Player.prototype.guardDrive = function(world: Vector3, useRight: boolean, rate = 0): void {
    this.armRateCap = rate;
    const near = useRight ? this.armPivotR : this.armPivotL;
    const nearElbow = useRight ? this.elbowR : this.elbowL;
    const far = useRight ? this.armPivotL : this.armPivotR;
    const farElbow = useRight ? this.elbowL : this.elbowR;
    this.aimArm(near, world);                 // 前の手をボールに
    this.bendElbow(nearElbow, 0);             // 前腕が伸びる、イーズ
    this.setArmDir(far, useRight ? -0.75 : 0.75, -0.55, 0.15);   // 逆の手は低く外へ
    this.bendElbow(farElbow, 0);
    this.armRateCap = 0;
};

/** パスをディナイする: 片手を斜めに突き出す — ボール側へ外へ、上へ、バスケットへ
 *  向けて後ろへ角度をつける — レーンを壁で塞ぎ、パスが彼の後ろへ滑り込めない
 *  ようにする。胸を横切る横方向のスイングは許容する（それでよい）。 */
Player.prototype.denyLane = function(useRight: boolean, rate = 0): void {
    this.armRateCap = rate;
    const s = useRight ? 1 : -1;
    const near = useRight ? this.armPivotR : this.armPivotL;
    const nearElbow = useRight ? this.elbowR : this.elbowL;
    const far = useRight ? this.armPivotL : this.armPivotR;
    const farElbow = useRight ? this.elbowL : this.elbowR;
    this.setArmDir(near, s * 0.85, 0.35, -0.4);   // 外へ、上へ、後方へ角度をつける
    this.bendElbow(nearElbow, 0);                  // ディナイの腕が伸びる、イーズ
    this.setArmDir(far, -s * 0.3, -0.5, 0.1);      // 後ろ側の腕はリラックスして低く
    this.bendElbow(farElbow, 0.2);
    this.armRateCap = 0;
};

/** 垂直の（ジャンプしない）シュートコンテスト: 両手を垂直にし、床を離れずに
 *  挑む（空中のコンテストは代わりにボールへ手を伸ばす）。 */
Player.prototype.handsUp = function(rate = 0): void {
    this.armRateCap = rate;
    this.setArmDir(this.armPivotL, -0.14, 1, 0.06);
    this.setArmDir(this.armPivotR, 0.14, 1, 0.06);
    this.bendElbow(this.elbowL, 0);   // 前腕が上へ伸びる、イーズ
    this.bendElbow(this.elbowR, 0);
    this.armRateCap = 0;
};
