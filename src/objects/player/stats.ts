// 現在の試合における選手のボックススコア。`min` はコート上の時間で、
// ゲームクロック秒（結果画面では分として表示）。player.ts から分離。
export interface Stats {
  pts: number; reb: number; ast: number; stl: number; blk: number; tov: number;
  fgm: number; fga: number;   // フィールドゴール成功/試投（3Pを含む全シュート）
  tpm: number; tpa: number;   // 3Pシュート成功/試投
  ftm: number; fta: number;   // フリースロー成功/試投
  min: number;
}
