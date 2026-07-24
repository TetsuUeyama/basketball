// シュートの「効果」= 成功率の算出（判定ルール）。状態を変更しない純粋関数として
// game.ts の releaseShot から切り出す。呼び出し側(game.ts)が最寄り守備者・ヘルプ人数・
// クラッチ値・ブザー有無などの文脈を計算して渡し、ここでは確率のみを返す。
// レイヤ分割: 効果(resolution)を発動/状態変更(game.ts)から分離（workPlan.md 参照）。
import { Player } from "../player";
import { THREE_DIST } from "../config";
import { rate } from "../attributes";
import { clamp, chance } from "../util";
import { perimContest, palmRadius, rimProtect } from "../eval";

// ジャンプシュート（ミドル/3P）の成功確率。距離・射程・コンテストから算出し、
// 0.02〜0.93 にクランプして返す（レイアップ/ダンクは finishAtRim 側で別途）。
export function jumpShotMakeProbability(
  h: Player, dHoop: number, dDef: number,
  ctx: {
    nearestDef: Player | null;   // 最寄り守備者（クローズアウトの質とリーチに使用）
    helpCount: number;           // 2.4m以内の守備人数（isoShooter 判定用）
    clutch: number;              // clutchFactor(h)：精神×プレッシャー
    buzzer: boolean;             // 終了間際(残り1秒未満)の駆け込みか
    palmHitbox: boolean;         // 手のひら当たり判定モデルの有効/無効
  },
): number {
  const isThree = dHoop > THREE_DIST;
  // make % = この距離での選手の技量から、距離とコンテストを差し引く
  const skill = rate(isThree ? h.attr.threeAcc : h.attr.midAcc);
  const baseLine = isThree ? 0.16 : 0.30;
  const distRef = isThree ? THREE_DIST : 1.5;
  // L速度は深い3Pの減衰を緩め、特能ミドルは全距離で緩める
  let falloff = isThree ? 0.05 - rate(h.attr.threeRange) * 0.035 : 0.03;
  if (h.has("range")) falloff *= 0.65;
  const over = Math.max(0, dHoop - distRef);
  // 距離は線形で効くが、遠投は二次で崩れる（最大L精度/L速度でも深いと急落、
  // ハーフコートの祈りは数%）。L速度が崩れを少し緩める。
  const heaveDrop = isThree ? over * over * 0.011 * (1 - rate(h.attr.threeRange) * 0.33) : 0;
  let p = baseLine + skill * 0.42 - over * falloff - heaveDrop;
  // ダイレクトプレイ: キャッチ&シュートのリズムが彼のシュート
  if (h.quickT > 0 && h.has("oneTouch")) p += 0.05;
  // お膳立て: 良いパスからオープンで受けた膳立て（アシストが決定を作る）
  if (h.setupT > 0) p += h.setupBonus;
  // コンテスト — S威力は接触を突いて打つ。1対1シュート特化は単独守備をほぼ感じない
  // （本当のヘルプだけが効く）。係数(0.78)と罰(0.24)は平均得点不変で傾きだけ急に。
  let contestScale = 1 - rate(h.attr.shotStrength) * 0.78;
  if (h.has("isoShooter") && ctx.helpCount <= 1) contestScale *= 0.6;
  // 誰がクローズアウトするか: 速く長いペリメーター守備は飛んでくる、スイッチした
  // 遅いビッグは遅れる — 位置＋体格でタグ無し。
  const cn = ctx.nearestDef;
  const perimQ = cn ? clamp(1 + perimContest(cn, h), 0.6, 1.5) : 1;
  // コンテストのリーチ = 手のひら当たり判定（有効時、def−off でサイズ可変）。
  // 良い守備者ほど遠くから手が届き、広いギャップでも make% を削る。無効時は固定1.8m。
  const cReach = ctx.palmHitbox && cn ? palmRadius(cn, h) : 1.8;
  p -= clamp(cReach - dDef, 0, cReach) * 0.24 * contestScale * perimQ;
  // 体勢の崩れ（移動しながらの射撃）— S技術がメカニクスを保つ
  if (h.beatenT > 0 || h.curSpd > h.runSpeed * 0.55) {
    p -= 0.10 * (1 - rate(h.attr.shotTech));
  }
  // 精神: 疲労・劣勢・終盤の重圧が弱い心を乱す
  p -= ctx.clutch * 0.12;
  // 終了間際の駆け込み: 体勢を作れず放るので精度が大きく落ちる。S技術が高いほど
  // 崩れた態勢でも決められるので落ち込みは小さい（×0.5(技術0)〜×0.7(技術100)）。
  if (ctx.buzzer) {
    p *= 0.5 + rate(h.attr.shotTech) * 0.2;
  }
  return clamp(p, 0.02, 0.93);   // 低い下限で遠投も数%は残す
}

// リング下のフィニッシュ（レイアップ/ダンク）の効果。ダンクにするか(dunk)を抽選し、
// それに応じた成功率(p, 0.05〜0.97)を算出して返す。dunk フラグは呼び出し側で
// アニメ・演出にも使うため一緒に返す。
export function rimFinishOutcome(
  h: Player, dDef: number,
  ctx: {
    nearestDef: Player | null;   // 最寄り守備者（リムプロテクトの質）
    crowd: number;               // 2.4m以内の守備人数（人だかりの壁）
    clutch: number;              // clutchFactor(h)
  },
): { dunk: boolean; p: number } {
  // ジャンプ+ヘッドで叩き込めるか、バランスで体を割ってダンクできるか
  const athletic = rate(h.attr.jump) * 0.5 + rate(h.attr.dunk) * 0.3 + rate(h.attr.balance) * 0.2;
  const lane = dDef > 1.1 || (rate(h.attr.balance) > 0.65 && dDef > 0.6);
  const dunk = lane && chance(0.06 + athletic * 0.7);
  // ダンクはヘッド、レイアップはS精度、S威力が接触を突いてフィニッシュ
  let p = dunk ? 0.82 + rate(h.attr.dunk) * 0.15 : 0.5 + rate(h.attr.midAcc) * 0.35;
  // 逆サイドのレイアップは逆手フィニッシュ — 逆手精度(2..8)で綺麗に、片手選手は落とす（ダンクは両手で対象外）
  if (!dunk && h.driveSide === -h.strongSide()) {
    p -= (1 - h.offhandAcc / 8) * 0.1;
  }
  const strong = rate(h.attr.shotStrength);
  // 誰がコンテストするかが距離と同じくらい重要: リム保護ビッグは壁、スイッチした
  // ガードはほぼ邪魔にならない（rimProtect は位置＋体格でロールタグ無し）。
  const near = ctx.nearestDef;
  const contestQ = near ? clamp(1 + rimProtect(near, h), 0.5, 1.6) : 1;
  p -= clamp(1.1 - dDef, 0, 1.0) * 0.42 * (1 - strong * 0.7) * contestQ;
  // マークを突いてフィニッシュ — オフェンスは守備が付いている時だけ効き、密着度で
  // スケール（オープン(dDef≥1.5)は不変、密着ほどオフェンスが決める）。75が中立。
  const mark = clamp((1.5 - dDef) / 1.5, 0, 1);   // 0 オープン .. 1 密着
  p += (rate(h.attr.offense) - 0.75) * 1.6 * mark;
  // リム付近の追加の人だかりは壁 — 2-3人へ突っ込むのは低確率、S威力もほぼ効かない
  // （オープンのキャッチ&フィニッシュ(人だかり0/1)は高確率を維持）。
  if (ctx.crowd >= 2) p -= (ctx.crowd - 1) * 0.23 * (1 - strong * 0.2);
  p -= ctx.clutch * 0.1;
  return { dunk, p: clamp(p, 0.05, 0.97) };
}
