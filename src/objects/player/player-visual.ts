// 選手の見た目/メッシュ管理（髪構築・モデル切替・背番号側・スケール・胴の奥行き・
// メッシュ同期・ネームタグ描画・ユニフォーム再着色）。プロトタイプ拡張で Player に紐づけ。
import { MeshBuilder, Color3, TransformNode, Mesh } from "@babylonjs/core";
import { makeMat } from "../materials";
import { TEAM_COLORS, HUD_OPTS, uniformOf } from "../../config";
import { clamp } from "../../util";
import { Player } from "./player";

declare module "./player" {
  interface Player {
    buildHairMeshes(style: number): void;
    applyLook(): void;
    setNumberSide(sign: number): void;
    setJerseyMark(text: string, color: string): void;
    applyModel(): void;
    refreshScale(): void;
    refreshBodyDepth(): void;
    sync(): void;
    drawNameTag(): void;
    applyUniform(): void;
    setNameTagVisible(v: boolean): void;
  }
}

  // （既に生成済みの）頭に髪型の髪メッシュを構築する。コンストラクタから切り出して
  // あるので、ロースター入替でこのスロットに別の選手が来たときapplyLook()が再構築
  // できる。0=短髪 1=丸刈り 2=アフロ 3=フラットトップ 4=ヘッドバンド
  // 5=ボブ 6=前髪上げ 7=モヒカン 8=マンバン 9=センター分け 10=ロング(肩まで)
  // 11=くせ毛長髪(太めの房) 12=ドレッド(細く多く長い房)。
Player.prototype.buildHairMeshes = function(style: number): void {
    const { head, hairMat, team } = this;
    // slice = ドームがどこまで下りてくるか（顔ではなく側面/後ろを覆う）。
    // tilt = 後傾で、後頭部を覆ったまま前が目の上へ乗り上がる（numberSideで反転、前 = -numberSide·Z）。
    // 長さは後頭部を垂れる別の `back` パネル（下記）が担う。
    type HStyle = { d: number; slice: number; sy: number; y: number; tilt: number;
                    back?: { d: number; sx: number; sy: number; sz: number; y: number } };
    const HS: (HStyle | null)[] = [
      { d: 0.375, slice: 0.58, sy: 1.0, y: 0.0, tilt: 0.34 },   // 0 短髪
      { d: 0.362, slice: 0.60, sy: 1.0, y: 0.0, tilt: 0.16 },   // 1 丸刈り(バズ、頭とほぼ同径で薄く覆う)
      { d: 0.47, slice: 0.66, sy: 1.08, y: 0.0, tilt: 0.24 },   // 2 アフロ
      { d: 0.375, slice: 0.56, sy: 1.4, y: 0.02, tilt: 0.30 },  // 3 フラットトップ
      { d: 0.375, slice: 0.56, sy: 0.95, y: 0.0, tilt: 0.32 },  // 4 ヘッドバンド下の髪
      // 5 ボブ: 前は開けたクラウン + 顎ラインまでの後ろ髪パーツ
      { d: 0.375, slice: 0.56, sy: 1.0, y: 0.0, tilt: 0.30,
        back: { d: 0.30, sx: 1.05, sy: 1.30, sz: 0.55, y: -0.05 } },
      { d: 0.36, slice: 0.50, sy: 0.90, y: 0.03, tilt: 0.48 },  // 6 前髪上げ(前を強く後傾、額出し)
      null,                                                     // 7 モヒカン(下のクレストで作る)
      { d: 0.36, slice: 0.55, sy: 0.98, y: 0.0, tilt: 0.30 },   // 8 マンバン(このクラウン+お団子)
      { d: 0.38, slice: 0.58, sy: 1.02, y: -0.005, tilt: 0.24 },// 9 センター分け(前髪は軽く、額は隠れすぎない)
      // 10 ロング: 前は開けたクラウン + 肩まで垂れる後ろ髪パーツ
      { d: 0.375, slice: 0.56, sy: 1.0, y: 0.0, tilt: 0.30,
        back: { d: 0.32, sx: 1.05, sy: 1.75, sz: 0.50, y: -0.13 } },
      // 11 くせ毛長髪: 前は開けたクラウン + サイド〜後ろに垂らす太めの房(下の専用ブランチ)
      { d: 0.365, slice: 0.56, sy: 1.0, y: 0.0, tilt: 0.28 },
      // 12 ドレッド: 同じ作りで房が細く・多く・長い(下の専用ブランチ)
      { d: 0.37, slice: 0.60, sy: 1.0, y: 0.0, tilt: 0.22 },
    ];
    const hs = HS[style];
    if (hs) {
      const hair = MeshBuilder.CreateSphere(`haircap_${team}_${this.idx}`, { diameter: hs.d, segments: 12, slice: hs.slice }, this.scene);
      hair.material = hairMat;
      hair.parent = head;            // 頭に乗る
      hair.position.y = hs.y;
      hair.scaling.y = hs.sy;
      hair.rotation.x = this.numberSide * hs.tilt;   // 後傾: 前が上、後頭部が下
      this.hair = hair;
      this.hairTilt = hs.tilt;
    }
    if (hs?.back) {
      // 後ろ髪: 後頭部を垂れる扁平な楕円体（後ろ = +numberSide·Z、setNumberSideでz反転）。
      // 頭の後ろかつ下で顔に届かない。
      const b = hs.back;
      const back = MeshBuilder.CreateSphere(`hairback_${team}_${this.idx}`, { diameter: b.d, segments: 12 }, this.scene);
      back.material = hairMat;
      back.parent = head;
      back.scaling.set(b.sx, b.sy, b.sz);
      back.position.set(0, b.y, this.numberSide * 0.05);
      this.hairBack = back;
    }
    if (style === 4) {
      // ヘッドバンド — 頭を囲うチームカラーのリング
      const band = MeshBuilder.CreateTorus(`band_${team}_${this.idx}`, { diameter: 0.355, thickness: 0.05, tessellation: 12 }, this.scene);
      const tc = TEAM_COLORS[team];
      band.material = makeMat(this.scene, `bandmat_${team}_${this.idx}`, {
        diffuse: new Color3(tc.r, tc.g, tc.b), spec: new Color3(0.05, 0.05, 0.05),
      });
      band.parent = head;
      band.position.y = 0.035;       // 額の高さ
      this.headband = band;
    }
    if (style === 7) {
      // モヒカン: 頭の中心線に沿って前後に走る、薄く高いクレストの尾根。z=0に対して
      // 対称なので、エンドを入れ替えても（numberSide反転）見た目は変わらない。
      // 再着色/破棄のため `this.hair` として登録する。
      const crest = MeshBuilder.CreateSphere(`mohawk_${team}_${this.idx}`, { diameter: 0.30, segments: 10 }, this.scene);
      crest.material = hairMat;
      crest.parent = head;
      crest.position.y = 0.10;
      crest.scaling.set(0.34, 1.7, 1.05);   // 横に薄く、上に高く、前後に長く
      this.hair = crest;
    }
    if (style === 8) {
      // マンバン: ベースのクラウン（上で構築）に加えて後頭部の上に小さな結び。
      // 後ろ = +numberSide·Z なので、bunのzはハーフタイムで反転する（setNumberSide）。
      const bun = MeshBuilder.CreateSphere(`bun_${team}_${this.idx}`, { diameter: 0.145, segments: 10 }, this.scene);
      bun.material = hairMat;
      bun.parent = head;
      bun.position.set(0, 0.055, this.numberSide * 0.15);
      this.hairBun = bun;
    }
    if (style === 11 || style === 12) {
      // 側面と後ろだけに垂れる房（前は空けて顔を覆わないようにする）。すべてが
      // 1つのノードを親にし、そのY回転がハーフタイムで反転するので、クラスタは
      // 正しい背中側に留まる。
      //   11 くせ毛長髪 = 少なく、太く、短い。 12 ドレッド = 多く、細く、長い。
      const cfg = style === 11
        ? { n: 9, r: 0.15, dia: 0.050, hBase: 0.38, hVar: 0.045, top: 0.02, spread: 3.8 }
        : { n: 16, r: 0.155, dia: 0.030, hBase: 0.50, hVar: 0.060, top: 0.05, spread: 4.4 };
      const root = new TransformNode(`dread_${team}_${this.idx}`, this.scene);
      root.parent = head;
      root.rotation.y = this.numberSide > 0 ? 0 : Math.PI;
      for (let i = 0; i < cfg.n; i++) {
        const phi = -cfg.spread / 2 + (i / (cfg.n - 1)) * cfg.spread;   // 後ろ側。前は飛ばす
        const H = cfg.hBase + (i % 3) * cfg.hVar;                       // 少し不揃いな長さ
        const loc = MeshBuilder.CreateCylinder(`loc_${team}_${this.idx}_${i}`,
          { height: H, diameter: cfg.dia, tessellation: 6 }, this.scene);
        loc.material = hairMat;
        loc.parent = root;
        loc.position.set(Math.sin(phi) * cfg.r, cfg.top - H / 2, Math.cos(phi) * cfg.r);
      }
      this.hairDreads = root;
    }
};

  // このスロットを今占有する選手のために、見た目（肌/髪色+髪型メッシュ）を再適用する。
  // ロースター入替（applyDef）で呼ばれる。
Player.prototype.applyLook = function(): void {
    const look = this.look;
    this.headMat.diffuseColor = new Color3(look.skin.r, look.skin.g, look.skin.b);
    this.hairMat.diffuseColor = new Color3(look.hair.r, look.hair.g, look.hair.b);
    this.hair?.dispose(); this.hair = null; this.hairTilt = 0;
    this.hairBun?.dispose(); this.hairBun = null;
    this.hairBack?.dispose(); this.hairBack = null;
    if (this.hairDreads) {
      this.hairDreads.getChildMeshes(false).forEach((m) => m.dispose());
      this.hairDreads.dispose(); this.hairDreads = null;
    }
    this.headband?.dispose(); this.headband = null;
    this.buildHairMeshes(look.style);
};

  /** 指定のZサイド(+1 / -1)に背番号を表示する — 選手の背中側、すなわち
   *  攻めるバスケットから遠い側。ハーフタイムで反転する。
   *  肩はわずかに前寄りなので、（反対側の）胸側に追随する。 */
Player.prototype.setNumberSide = function(sign: number): void {
    this.sideApplied = true;
    this.numberSide = sign >= 0 ? 1 : -1;
    const human = HUD_OPTS.model === "human";
    const both = this.numBothSides;   // 審判のマークは前後両面に表示
    this.numHumanPlus.isVisible = human && (sign > 0 || both);
    this.numHumanMinus.isVisible = human && (sign < 0 || both);
    this.numAcornPlus.isVisible = !human && (sign > 0 || both);
    this.numAcornMinus.isVisible = !human && (sign < 0 || both);
    this.armPivotL.position.z = -this.numberSide * 0.06;
    this.armPivotR.position.z = -this.numberSide * 0.06;
    // つま先は胸/腕と同じ方向（前 = -numberSide·Z）を指すので、-Zを攻めるチームが
    // 足が後ろ向きに見えることはない
    this.footL.position.z = -this.numberSide * 0.1;
    this.footR.position.z = -this.numberSide * 0.1;
    // 目も胸/前側に配置し、背中側に来ないようにする
    if (this.eyeL) { this.eyeL.position.z = -this.numberSide * 0.15; this.eyeR.position.z = -this.numberSide * 0.15; }
    // 髪は顔に対して後傾するので、傾きは前側とともに反転する
    if (this.hair) this.hair.rotation.x = this.numberSide * this.hairTilt;
    // マンバンは頭の後ろに配置 — 新しい背中側へ向け直す
    if (this.hairBun) this.hairBun.position.z = this.numberSide * 0.15;
    // ロング/ボブの後ろ髪も背中に垂れる — これも向け直す
    if (this.hairBack) this.hairBack.position.z = this.numberSide * 0.05;
    // ドレッドのクラスタは全体で反転し、背中側に留まる
    if (this.hairDreads) this.hairDreads.rotation.y = this.numberSide > 0 ? 0 : Math.PI;
    // シューズの足: 同じ規則だが、シューズは前後非対称なのでヨーも反転する
    // （numberSide +1 用につま先前向きで作られている）。スタンスは体の後ろ寄りで
    // つま先を外へ開く（軽いガニ股）ので、各足のヨー = 基準の向き ± 外向きの開き。
    const fns = this.numberSide;
    this.acornFootL.position.z = -fns * Player.ACORN_FOOT_Z;
    this.acornFootR.position.z = -fns * Player.ACORN_FOOT_Z;
    const fBase = fns > 0 ? 0 : Math.PI;
    this.acornFootL.rotation.y = fBase + fns * Player.ACORN_SPLAY;
    this.acornFootR.rotation.y = fBase - fns * Player.ACORN_SPLAY;
    this.syncAcornLegs();
    if (this.seated) {
      this.foldSeatedLegs();   // 着席の折り畳みを正しい向きに保つ
      if (HUD_OPTS.model === "acorn") this.foldAcornSeat();
    }
};

  /** 背番号デカールを任意の文字（指定色）に差し替え、前後両面へ表示する。
   *  審判用: 背番号の代わりに大きな極太の「R」を胸と背中に付ける。 */
Player.prototype.setJerseyMark = function(text: string, color: string): void {
    const ctx = this.numTex.getContext() as unknown as CanvasRenderingContext2D;
    ctx.clearRect(0, 0, 128, 128);
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "900 106px sans-serif";       // 大きく極太
    ctx.lineWidth = 8;                        // フチをなぞってさらに太らせる
    ctx.fillText(text, 64, 70);
    ctx.strokeText(text, 64, 70);
    this.numTex.update();
    this.numBothSides = true;
    this.setNumberSide(this.numberSide || 1);   // 前後両面のシェルを表示する
};

  /** モデル切替（人型 ⇄ どんぐりカプセル）: 選択中のボディだけを表示し、腕の
   *  肩幅・背番号シェル・着席姿勢をそのモード用に組み直す。いつ呼んでも安全
   *  （腕/頭/名前タグは両モード共用）。 */
Player.prototype.applyModel = function(): void {
    const human = HUD_OPTS.model === "human";
    this.humanNode.setEnabled(human);
    this.hipL.setEnabled(human);          // 脚（腿/脛/足がこれらのピボットに乗る）
    this.hipR.setEnabled(human);
    this.acornNode.setEnabled(!human);
    this.acornFootL.setEnabled(!human);   // シューズの足はrootにある（ツイストしない）
    this.acornFootR.setEnabled(!human);   // ので、別々に切り替わる
    this.acornLegL.setEnabled(!human);    // 素肌の脚（足と同様にrootに固定）
    this.acornLegR.setEnabled(!human);
    // カプセルは矩形の胴より広い — 肩をそれに合わせて外へ動かす
    const sx = human ? 0.28 : 0.34;
    this.armPivotL.position.x = -sx;
    this.armPivotR.position.x = sx;
    if (this.sideApplied) this.setNumberSide(this.numberSide); // 番号をこのボディへ移す
    // このモード用に再ポーズ: 着席のどんぐりは腰を膝の上に折り、着席の人型は
    // 折り畳んだ脚の上に座る（どちらの場合もまずどんぐりの折り畳みを解除）
    if (this.seated && !human) this.foldAcornSeat();
    else this.unfoldAcornSeat();
    this.refreshScale();
};

  /** 選手の身長に対する垂直スケール。 */
Player.prototype.refreshScale = function(): void {
    this.root.scaling.y = this.height / 1.95;
};

  /** ボディバランス(フィジカル)が胴の前後の厚み（Zの奥行き）を決める: 安定して
   *  強い99はフルの体格を保つ。65以下は3分の2（一般的な最小）まで細くなり、
   *  その間は線形。胸、腰、それらの背番号シェルはすべて一緒に圧縮されるので、
   *  番号は（今や浅くなった）背中に留まる。頭、腕、脚は奥行きを保つ。純粋に見た目のみ。 */
Player.prototype.refreshBodyDepth = function(): void {
    const t = clamp((this.attr.balance - 65) / (99 - 65), 0, 1);
    const z = 2 / 3 + t * (1 / 3);   // 0.667（≤65）.. 1.0（99）
    this.acornNode.scaling.z = z;
    this.humanNode.scaling.z = z;
    this.numAcornPlus.scaling.z = z;
    this.numAcornMinus.scaling.z = z;
    this.numHumanPlus.scaling.z = z;
    this.numHumanMinus.scaling.z = z;
};

Player.prototype.sync = function(): void {
    if (this.seated) {
      // リグを下げて（折り畳んだ）腰がベンチ座面に合うようにする。折り畳んだ脚は
      // 前で床に届く。rotation.yはbenchIdle/faceTowardが設定する — それを保つ。
      // 直立のまま（傾きなし）。どんぐりのボディは、折り畳んだ腰の下面（ヒンジから
      // 腰の半径を引いたもの）が座面に置かれるまで下がる — 胸は膝の上に乗り、
      // シューズはfoldAcornSeatが床へ持ち上げ戻す。
      const s = this.height / 1.95;
      const rootY = HUD_OPTS.model === "acorn"
        ? Player.SEAT_SURF - Player.acornSeatDrop() * s
        : Player.SEAT_HIP - Player.HIP_Y * s;
      this.root.position.set(this.pos.x, rootY + this.jumpY(), this.pos.z);
      this.root.rotation.x = 0;
      this.root.rotation.z = 0;
      this.tiltX = this.tiltZ = 0;
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
    // どんぐりのボディは足の羽ばたきに合わせて左右によちよち揺れる（updateAcornFeetで
    // 平滑化、静止/空中や人型モードでは0）。ファウルひるみのロールは角度から来た
    // 一撃で彼を横へ傾ける
    this.root.rotation.z = this.tiltZ + this.flinchRoll + (HUD_OPTS.model === "acorn" ? this.acornWaddle : 0);
    // シュートの溜め姿勢（前傾＋沈み込み）を反映。target は updateCharge が毎フレーム
    // 設定し、リリース後は0へ戻るので自動で伸び上がる。アコーンモデルのみ。
    this.shootLoad += (this.shootLoadTarget - this.shootLoad) * 0.25;
    this.shootLoadTarget = 0;
    if (this.shootLoad > 0.003 && HUD_OPTS.model === "acorn") this.applyShootLoad();
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
   *  再着色する。TEAM_UNIFORM変更後に呼ばれ、スワップがライブに表示される。 */
Player.prototype.applyUniform = function(): void {
    const u = uniformOf(this.team);
    this.topMat.diffuseColor = new Color3(u.top.r, u.top.g, u.top.b);
    this.bottomMat.diffuseColor = new Color3(u.bottom.r, u.bottom.g, u.bottom.b);
    this.sleeveMat.diffuseColor = new Color3(u.sleeve.r, u.sleeve.g, u.sleeve.b);
    this.shoeMat.diffuseColor = new Color3(u.shoes.r, u.shoes.g, u.shoes.b);
};

  /** HUDオプションに関わらず浮遊ネームタグを隠す/表示する — 試合前のイントロは
   *  タグを自身のキャプションボードに置き換える。`true` で復元しても、ユーザーの
   *  HUD_OPTS.showNames設定は尊重する。 */
Player.prototype.setNameTagVisible = function(v: boolean): void {
    this.namePlane.isVisible = v && HUD_OPTS.showNames;
};