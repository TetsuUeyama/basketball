// 各関節の基本ルール: 回転軸・可動域(rad)・最大回転速度(rad/s)。
// アニメ（animation/, move/）はこの範囲・速度の中でモーションを作る。
export type Axis = "x" | "y" | "z";
export interface Joint { axis: Axis; min: number; max: number; speed: number; }

export const JOINT = {
  chestTwist: { axis: "y", min: -1.15, max: 1.15, speed: 10 },   // 胸のツイスト（rootに対する上半身のヨー）
  headTurn:   { axis: "y", min: -0.95, max: 0.95, speed: 11 },   // 頭のヨー（胸の上に重ねる）
  elbow:      { axis: "x", min: -2.8, max: 2.8, speed: 14 },     // 肘の曲げ
  hip:        { axis: "x", min: -1.6, max: 1.6, speed: 12 },     // 股関節の前後振り/畳み
  knee:       { axis: "x", min: -1.7, max: 1.7, speed: 14 },     // 膝の曲げ
  acornFoot:  { axis: "x", min: -0.8, max: 0.8, speed: 22 },     // どんぐりのつま先ピッチ
} satisfies Record<string, Joint>;

// 部位を動かすのに必要な時間の規約: 瞬間切替（スナップ）は禁止。呼び出しが速度を
// 指定しない場合（armRateCap 0 など）はこの既定レートで目標へイーズする。
// 値は指数イーズの収束速度(1/s)。目安: 10 ≈ 大きな振りでも到達に約0.3秒。
// 例外: リセット/着席など場面転換の一括ポーズ（resetTwist/resetFacing/sit）。
export const MOVE_RATE = {
  arm: 10,   // 肩の向け直し・肘の曲げの既定レート
};
