// 選手の見た目（ボクセル素体の生成・見た目の反映・背番号の向き・メッシュ同期・
// ネームタグ描画・ユニフォーム再着色）。プロトタイプ拡張で Player に紐づけ。

import { HUD_OPTS, uniformOf } from "../../config";
import { clamp } from "../../util";
import { Player } from "./player";
import { buildVoxelBody, syncVoxelPose } from "./player-voxel";
import { applyClipPose } from "../../animation/voxel-motion";

declare module "./player" {
  interface Player {
    applyLook(): void;
    setNumberSide(sign: number): void;
    setJerseyMark(text: string, color: string): void;
    sync(): void;
    drawNameTag(): void;
    applyUniform(): void;
    setNameTagVisible(v: boolean): void;
    ensureVoxel(): void;
    rebuildVoxel(): void;
    syncVoxel(): void;
  }
}

/** ボクセルの見た目を（まだ無ければ）組む。 */
Player.prototype.ensureVoxel = function(): void {
    if (this.vox || Player.HEADLESS) return;
    const u = this.kitOverride ?? uniformOf(this.team);
    this.vox = buildVoxelBody(this.scene, this.root, {
      name: `${this.team}_${this.idx}`,
      balance: this.attr.balance,
      height: this.height,
      skin: this.look.skin,
      hair: this.look.hair,
      hairNo: this.look.hairNo,
      kit: { top: u.top, bottom: u.bottom, shoes: u.shoes },
      jerseyText: this.jerseyText,
    });
    // 肩の位置・腕の長さ・股関節の高さを素体の実測値へ合わせる（aimArm / reachIK が使う）
    const v = this.vox;
    this.armPivotL.position.set(v.shoulder.x, v.shoulder.y, -this.numberSide * Math.abs(v.shoulder.z));
    this.armPivotR.position.set(-v.shoulder.x, v.shoulder.y, -this.numberSide * Math.abs(v.shoulder.z));
    this.elbowL.position.y = this.elbowR.position.y = -v.upperArm;
    this.upperArmLen = v.upperArm;
    this.foreArmLen = v.foreArm;
    if (this.sideApplied) this.setNumberSide(this.numberSide);
};

/** 身長・体格が変わったときに作り直す（骨組みごと組み直すため）。 */
Player.prototype.rebuildVoxel = function(): void {
    if (!this.vox) return;
    this.vox.dispose();
    this.vox = null;
    this.ensureVoxel();
};

/** 姿勢をボクセルの標準ボーンへ流す（sync から毎フレーム）。
 *  歩く・走る・ドリブルは objcts/player/motion の焼き込みクリップ、それ以外は手続きポーズ。 */
Player.prototype.syncVoxel = function(): void {
    const vb = this.vox;
    if (!vb) return;
    if (applyClipPose(vb, this, this.lastDt)) { vb.skel.prepare(); return; }
    syncVoxelPose(vb, {
      numberSide: this.numberSide,
      torsoYaw: this.torsoNode.rotation.y,
      torsoPitch: this.torsoNode.rotation.x,
      torsoOffsetY: this.torsoNode.position.y,
      torsoOffsetZ: this.torsoNode.position.z,
      headYaw: this.headNode.rotation.y,
      headPitch: this.headPitch,
      armL: this.armPivotL, armR: this.armPivotR,
      elbowL: this.elbowL, elbowR: this.elbowR,
      ikL: this.ikL, ikR: this.ikR,
      hipL: this.hipL, hipR: this.hipR,
      kneeL: this.kneeL, kneeR: this.kneeR,
    });
    vb.skel.prepare();   // ノードのリグ → スケルトン（服のスキニング）
};

  /** このスロットを今占有する選手のために、見た目（肌/髪色・髪型）を再適用する。
   *  ロースター入替（applyDef）で呼ばれる。 */
Player.prototype.applyLook = function(): void {
    const look = this.look;
    this.vox?.setSkinColor(look.skin);
    this.vox?.setHairColor(look.hair);
    this.vox?.setHairStyle(look.hairNo);
};

  /** 指定のZサイド(+1 / -1)に背番号を向ける — 選手の背中側、すなわち攻めるバスケット
   *  から遠い側。ハーフタイムで反転する。ボクセルは骨組みごと 180° 回して前後を
   *  入れ替えるので、背番号のシェルは1枚でよい。 */
Player.prototype.setNumberSide = function(sign: number): void {
    this.sideApplied = true;
    this.numberSide = sign >= 0 ? 1 : -1;
    this.vox?.setNumberVisible(true);
    // 肩はわずかに前寄り（前 = -numberSide·Z）
    const shz = this.vox ? Math.abs(this.vox.shoulder.z) : 0.01;
    this.armPivotL.position.z = -this.numberSide * shz;
    this.armPivotR.position.z = -this.numberSide * shz;
};

  /** 背番号デカールを任意の文字（指定色）に差し替える。
   *  審判用: 背番号の代わりに大きな極太の「R」。 */
Player.prototype.setJerseyMark = function(text: string, color: string): void {
    this.jerseyText = text;
    this.vox?.setJerseyText(text, color);
    this.setNumberSide(this.numberSide || 1);
};

Player.prototype.sync = function(): void {
    if (this.seated) {
      // リグを下げて腰がベンチ座面に合うようにする。畳んだ脚は前で床に届く。
      // rotation.y は benchIdle/faceToward が設定する — それを保つ。直立のまま（傾きなし）。
      const rootY = this.vox ? Player.SEAT_HIP - this.vox.hipY : Player.SEAT_HIP - Player.HIP_Y;
      this.root.position.set(this.pos.x, rootY + this.jumpY(), this.pos.z);
      this.root.rotation.x = 0;
      this.root.rotation.z = 0;
      this.tiltX = this.tiltZ = 0;
      this.syncVoxel();
      return;
    }
    this.root.position.set(this.pos.x, this.jumpY(), this.pos.z);
    // 見える体の傾き: 姿全体を確定した重心へ傾ける。ワールドの傾きベクトルを規約
    // （RotationY(θ)がローカル+Zを(sinθ,0,cosθ)へ対応、faceToward参照）でヨーローカル
    // フレームへ変換し、rootをピッチ/ロールする。平滑化する。
    const m = this.lean * 0.30;                     // フルの傾きで最大~17°
    let tx = 0, tz = 0;
    if (Math.abs(m) > 0.02) {
      const wx = this.leanAxisX * m, wz = this.leanAxisZ * m;
      const th = this.root.rotation.y;
      const c = Math.cos(th), s = Math.sin(th);
      const lx = wx * c - wz * s;                   // ヨーローカルフレームでの傾き
      const lz = wx * s + wz * c;
      tx = lz;                                      // ピッチ: ローカル+Zへ傾ける
      tz = -lx;                                     // ロール: ローカル+Xへ傾ける
    }
    this.tiltX += (tx - this.tiltX) * 0.25;
    this.tiltZ += (tz - this.tiltZ) * 0.25;
    this.root.rotation.x = this.tiltX + this.flinchPitch;   // + ファウルひるみの後ろへのけぞり
    this.root.rotation.z = this.tiltZ + this.flinchRoll;
    // シュートの溜め姿勢（前傾＋沈み込み）を反映。target は updateCharge が毎フレーム
    // 設定し、リリース後は0へ戻るので自動で伸び上がる。
    this.shootLoad += (this.shootLoadTarget - this.shootLoad) * 0.25;
    this.shootLoadTarget = 0;
    if (this.shootLoad > 0.003) this.applyShootLoad();
    // 床のボールをすくい上げる進捗（target は liveball の pickup が毎フレーム設定）。
    // 姿勢そのものは objcts の "pickup" クリップ（voxel-motion）が持つ。
    this.scoopLoad += (this.scoopLoadTarget - this.scoopLoad) * 0.25;
    this.scoopLoadTarget = 0;
    // ⚠️ 溜め・落胆は胴を腰でヒンジさせるオフセット(torsoNode.position / rotation.x)を書く。
    //    どちらも当たらなくなったフレームで戻さないと、上半身が腰からずれたまま残る。
    if (!this.hingePosed) {
      this.torsoNode.rotation.x = 0;
      this.torsoNode.position.set(0, 0, 0);
      this.headPitch = 0;
    }
    this.hingePosed = false;
    this.syncVoxel();   // 仮想の関節ノード → ボクセルの標準ボーン
};

  // 浮遊ネームタグとその下のスタミナゲージを描画する。背番号は名前の横ではなく
  // 選手の背中（デカール）にある。
  // ゲージはタンクの残り(1 - fatigue)を示す: 元気なら緑、息が上がると
  // アンバー、バテると赤。
Player.prototype.drawNameTag = function(): void {
    const ctx = this.nameTex.getContext() as unknown as CanvasRenderingContext2D;
    ctx.clearRect(0, 0, 256, 64);
    // 背景ボックスなし — ドロップシャドウがコート上でテキストを読みやすく保つ
    ctx.shadowColor = "rgba(0,0,0,0.9)";
    ctx.shadowBlur = 6;
    ctx.fillStyle = "#fff";   // 白がコート上で最も読みやすい（チーム=ユニフォーム色）
    // 長いデータベース名（例: クリスティアーノ・ロナウド）はタグに収まるよう縮小する
    const size = this.name.length > 11 ? 18 : this.name.length > 7 ? 24 : 30;
    ctx.font = `bold ${size}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(this.name, 128, 24);

    // スタミナゲージ（トラック+フィル） — HUDがネームタグに表示する設定のときのみ。
    // "icon"モードでは代わりに下部HUDの顔アイコンの下に置かれる
    if (HUD_OPTS.staminaOn === "name") {
      const left = 14, top = 46, width = 228, height = 10;
      const frac = clamp(1 - this.fatigue, 0, 1);
      ctx.fillStyle = "rgba(255,255,255,0.22)";
      ctx.fillRect(left, top, width, height);
      ctx.fillStyle = frac > 0.5 ? "rgb(80,220,110)"
        : frac > 0.25 ? "rgb(240,200,70)" : "rgb(235,80,60)";
      ctx.fillRect(left, top, width * frac, height);
    }
    ctx.shadowBlur = 0;

    this.nameTex.update();
    this.namePlane.isVisible = HUD_OPTS.showNames;   // コート上のネームタグを切り替える
    this.gaugeDrawn = this.fatigue;
    this.gaugeRev = HUD_OPTS.rev;
};

  /** チームの現在アクティブなユニフォーム（ホーム/アウェイ）からこの選手のキットを
   *  再着色する。TEAM_UNIFORM変更後に呼ばれ、スワップがライブに表示される。
   *  ⚠️ ボクセルはキット色を頂点色に焼くのでメッシュを作り直す（着替えは試合前だけ）。 */
Player.prototype.applyUniform = function(): void {
    const u = this.kitOverride ?? uniformOf(this.team);
    this.vox?.setKit({ top: u.top, bottom: u.bottom, shoes: u.shoes });
};

  /** HUDオプションに関わらず浮遊ネームタグを隠す/表示する — 試合前のイントロは
   *  タグを自身のキャプションボードに置き換える。`true` で復元しても、ユーザーの
   *  HUD_OPTS.showNames設定は尊重する。 */
Player.prototype.setNameTagVisible = function(v: boolean): void {
    this.namePlane.isVisible = v && HUD_OPTS.showNames;
};

