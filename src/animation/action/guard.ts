// 守備の手（オンボール守備/ディナイ/コンテスト/腕広げ）アクションのアニメ。
// basic/arms のムーバ経由で動く。切り替え速度は armRateCap(rad/s) の規約。
import { Vector3 } from "@babylonjs/core";
import { Player } from "../../objects/player/player";

// 守備の腕は伸ばし切らない。実際の守備者は肘を曲げて手を働かせている。
const GUARD_BEND = 0.55;    // 広げた腕・ディナイの腕（約31°）
const CONTEST_BEND = 0.40;  // 上へ伸ばすコンテストの腕（約23°）
const POKE_BEND = 0.45;     // ボールを突く前の手
// 手の「働き」: 肩は構えたまま前腕だけが動き続ける。全員が揃わないよう選手ごとに位相をずらす。
const WORK_HZ = 0.9;
const WORK_BEND = 0.16;     // 肘の曲げの揺れ幅(rad)。見た目の肘角で ±9° ほど
const WORK_SWING = 0.10;    // 前腕の内外の振り(rad)。rotation.z は直書きなのでそのまま出る

/** 守備中の前腕だけの動き。肩（armPivot）には触らない。
 *  base は肘の基準の曲げ。呼び出し側が setArmDir で肩を決めた後に呼ぶ。 */
function workHands(p: Player, baseL: number, baseR: number): void {
  p.handWork += p.lastDt * WORK_HZ * 2 * Math.PI;
  const t = p.handWork + p.idx * 1.7 + p.team * 0.9;
  p.bendElbow(p.elbowL, baseL + Math.sin(t) * WORK_BEND);
  p.bendElbow(p.elbowR, baseR + Math.sin(t + 2.1) * WORK_BEND);
  // 前腕を内外へ振る（肘の曲げとは別の軸なので、手が「働いて」見える）
  p.elbowL.rotation.z = Math.sin(t * 0.7 + 1.3) * WORK_SWING;
  p.elbowR.rotation.z = -Math.sin(t * 0.7 + 0.4) * WORK_SWING;
}

declare module "../../objects/player/player" {
  interface Player {
    armsWide(rate?: number): void;
    /** 守備の手の「働き」の位相。前腕だけの動きに使う。 */
    handWork: number;
    guardDrive(world: Vector3, useRight: boolean, rate?: number): void;
    denyLane(useRight: boolean, rate?: number): void;
    handsUp(rate?: number, spread?: number, lean?: number): void;
  }
}
Player.prototype.handWork = 0;

/** 両腕を大きく広げる — 左右のドライブを壁で防ぐアクティブな手。`rate` (rad/s)が
 *  切り替えをレート制限する。0は即座に切り替える（ベンチ/非守備用途）。 */
Player.prototype.armsWide = function(rate = 0): void {
    this.armRateCap = rate;
    this.setArmDir(this.armPivotL, -1, -0.35, 0.35);
    this.setArmDir(this.armPivotR, 1, -0.35, 0.35);
    workHands(this, GUARD_BEND, GUARD_BEND);   // 肘は曲げたまま、前腕が働く
    this.armRateCap = 0;
};

/** ストレートドライブを止める: ボールに近い手が前かつ低く出て侵入を壁で防ぎ
 *  ボールを突く（スティール）、逆の手はスライド中のバランスのため低く外へ構える。
 *  `rate` が向け直しをレート制限する。 */
Player.prototype.guardDrive = function(world: Vector3, useRight: boolean, rate = 0): void {
    this.armRateCap = rate;
    const near = useRight ? this.armPivotR : this.armPivotL;
    const far = useRight ? this.armPivotL : this.armPivotR;
    this.aimArm(near, world);                 // 前の手をボールに
    this.setArmDir(far, useRight ? -0.75 : 0.75, -0.55, 0.15);   // 逆の手は低く外へ
    workHands(this, useRight ? GUARD_BEND : POKE_BEND, useRight ? POKE_BEND : GUARD_BEND);
    this.armRateCap = 0;
};

/** パスをディナイする: 片手を斜めに突き出す — ボール側へ外へ、上へ、バスケットへ
 *  向けて後ろへ角度をつける — レーンを壁で塞ぎ、パスが彼の後ろへ滑り込めない
 *  ようにする。胸を横切る横方向のスイングは許容する（それでよい）。 */
Player.prototype.denyLane = function(useRight: boolean, rate = 0): void {
    this.armRateCap = rate;
    const s = useRight ? 1 : -1;
    const near = useRight ? this.armPivotR : this.armPivotL;
    const far = useRight ? this.armPivotL : this.armPivotR;
    this.setArmDir(near, s * 0.85, 0.35, -0.4);   // 外へ、上へ、後方へ角度をつける
    this.setArmDir(far, -s * 0.3, -0.5, 0.1);      // 後ろ側の腕はリラックスして低く
    workHands(this, useRight ? 0.5 : GUARD_BEND, useRight ? GUARD_BEND : 0.5);
    this.armRateCap = 0;
};

/** 垂直の（ジャンプしない）シュートコンテスト: 両手を垂直にし、床を離れずに
 *  挑む（空中のコンテストは代わりにボールへ手を伸ばす）。歓声の「両手を上げる」も
 *  これを使う（`reach(点, true)` は届かない高さだと片手の最大リーチへ落ちるため）。
 *  spread=左右への開き / lean=前後の傾き（+ が前）。 */
Player.prototype.handsUp = function(rate = 0, spread = 0.14, lean = 0.06): void {
    this.armRateCap = rate;
    const fz = -this.numberSide * lean;   // 前 = -numberSide·Z
    this.setArmDir(this.armPivotL, -spread, 1, fz);
    this.setArmDir(this.armPivotR, spread, 1, fz);
    this.bendElbow(this.elbowL, CONTEST_BEND);   // 伸ばし切らない（肘が見える）
    this.bendElbow(this.elbowR, CONTEST_BEND);
    this.armRateCap = 0;
};
