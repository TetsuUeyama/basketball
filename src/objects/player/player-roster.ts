// 選手のロースター適用（試合前エディタで編集され得る PlayerDef を選手モデルへ読み直す）。
// 名前/身長/ロール/優先度/派生値/特殊能力を def から反映し、必要なら見た目（ネームタグ/
// look/スケール）も更新する。プロトタイプ拡張で Player に紐づけ。本体は player.ts から
// 逐語移動（this は Player のまま）。呼び出し側は不変。game.ts が副作用 import する。
// 補足: PlayerDef 自体（ロースターのデータ）は attributes.ts、編成画面の UI は ui.ts。
// ここは「def を選手へ適用する」モデル操作＝試合前の setup 関心を、試合中の挙動から分離する。
import { rate, computeOffPriority, roleOffense, offActionOf, ROLE_BEHAVIOR,
  DEF_ROLE_BEHAVIOR, type PlayerDef } from "../../attributes";
import { clamp } from "../../util";
import { playerLook } from "./player-look";
import { Player } from "./player";

declare module "./player" {
  interface Player {
    applyDef(def: PlayerDef): void;
  }
}

/** （編集されたかもしれない）ロースターdefから名前/身長/ロール/優先度/派生値を
 *  読み直す。`attr` はライブ参照なので、能力値の編集は既に反映されている。 */
Player.prototype.applyDef = function(def: PlayerDef): void {
    this.role = def.role;
    this.attr = def.attr;   // 再バインド: 試合前のスワップはdefオブジェクトを差し替えうる
    this.abilities = new Set(def.abilities ?? []);
    this.runSpeed = 3.2 + rate(def.attr.speed) * 4.8; // コンストラクタと同期を保つ
    this.offPriority = computeOffPriority(def);
    this.playmaking = roleOffense(def.role).playmaking;
    // 評価ロールを実挙動へ: 仮想特能の付与と優先度/プレイメイキング補正。
    // これで「エースにはボールが集まる」「ロックダウンは常時マンマーク」等が
    // 既存の特殊能力/優先度の配線に乗って動く。
    this.evalRole = def.evalRole;
    this.offAction = offActionOf(def.evalRole);
    this.choiceRank = def.choiceRank;
    this.hand = def.hand ?? "R";
    this.offhandAcc = def.future?.offhandAcc || 5;
    this.offhandFreq = def.future?.offhandFreq || 5;
    const rb = def.evalRole ? ROLE_BEHAVIOR[def.evalRole] : undefined;
    if (rb) {
      for (const k of rb.ab ?? []) this.abilities.add(k);
      this.offPriority = clamp(this.offPriority + (rb.pri ?? 0), 0, 1);
      this.playmaking = clamp(this.playmaking + (rb.pm ?? 0), 0, 1);
    }
    // ディフェンスロール（オフェンスロールとは独立）: 守備の仮想特能と常時全力。
    this.defRole = def.defRole;
    this.lockDef = false;
    this.defEffortGear = undefined;
    const db = def.defRole ? DEF_ROLE_BEHAVIOR[def.defRole] : undefined;
    if (db) {
      for (const k of db.ab ?? []) this.abilities.add(k);
      this.lockDef = !!db.lockEffort;
      this.defEffortGear = db.effort;
    }
    if (def.name !== this.name) {
      this.name = def.name;
      this.look = def.look ?? playerLook(def.name);   // 新しい占有者の見た目へ（applyLookが参照）
      if (!Player.HEADLESS) { this.drawNameTag(); this.applyLook(); }   // 見た目のみ — ヘッドレスではスキップ
    }
    if (def.height !== this.height) {
      this.height = def.height;
      this.refreshScale();   // 姿を新しい身長へ再スケール（着席の潰しを保つ）
    }
    this.refreshBodyDepth();   // 交代で入った選手のボディバランスが胴の奥行きを決める
};
