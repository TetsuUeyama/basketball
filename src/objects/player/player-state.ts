// 選手の状態リセット（試合開始時のボックススコア/コンディションのゼロ化）。
// プロトタイプ拡張で Player に紐づけ。本体は player.ts から逐語移動（this は Player の
// まま）。呼び出し側は不変。game.ts が副作用 import する。
// 補足: ロースター適用の applyDef は多くのメッシュ/見た目メソッド(applyLook/drawNameTag/
// refreshScale 等)と密結合のため player.ts 側に残置。
import { Player } from "./player";

declare module "./player" {
  interface Player {
    resetStats(): void;
  }
}

/** この選手のボックススコアとコンディションをゼロにする（試合開始）。 */
Player.prototype.resetStats = function(): void {
  const s = this.stats;
  s.pts = s.reb = s.ast = s.stl = s.blk = s.tov = s.fgm = s.fga = s.min = 0;
  s.tpm = s.tpa = s.ftm = s.fta = 0;
  this.fatigue = 0;
  this.curSpd = 0;
  this.stintT = 0;
};
