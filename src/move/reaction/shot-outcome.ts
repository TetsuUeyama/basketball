// シュートの「効果」= 成功率の算出（判定ルール）。状態を変更しない純粋関数。
// 呼び出し側が最寄り守備者・ヘルプ人数・クラッチ値・ブザー有無などの文脈を渡し、確率のみ返す。
import { Player } from "../../objects/player/player";
import { THREE_DIST } from "../../config";
import { rate, clamp, chance } from "../../util";
import { perimContest, palmRadius, rimProtect } from "../../eval";

// ジャンプシュート（ミドル/3P）の成功確率。距離・射程・コンテストから算出し、
// 0.02〜0.93 にクランプして返す（レイアップ/ダンクは finishAtRim 側で別途）。
export function jumpShotMakeProbability(
  h: Player, dHoop: number, dDef: number,
  ctx: {
    nearestDef: Player | null;   // 最寄り守備者（クローズアウトの質とリーチに使用）
    helpCount: number;           // 2.4m以内の守備人数（isoShooter 判定用）
    clutch: number;              // clutchFactor(h)：精神×プレッシャー
    prepShort: number;           // 準備不足の秒数（急ぎ撃ち/ブザー — 大きいほど精度低下）
    prepExtra: number;           // 準備延長の秒数（どフリーでじっくり — 精度微増、上限あり）
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
  // 遠投は二次で崩れる。L速度が崩れを少し緩める。
  const heaveDrop = isThree ? over * over * 0.011 * (1 - rate(h.attr.threeRange) * 0.33) : 0;
  let p = baseLine + skill * 0.42 - over * falloff - heaveDrop;
  // ダイレクトプレイ: キャッチ&シュートのリズム
  if (h.quickT > 0 && h.has("oneTouch")) p += 0.05;
  // お膳立て: 良いパスからオープンで受けた膳立て
  if (h.setupT > 0) p += h.setupBonus;
  // コンテスト — S威力は接触を突いて打つ。1対1シュート特化は単独守備をほぼ感じない。
  let contestScale = 1 - rate(h.attr.shotStrength) * 0.78;
  if (h.has("isoShooter") && ctx.helpCount <= 1) contestScale *= 0.6;
  // クローズアウトの質は位置＋体格で決まる（速い外守備は飛んでくる、遅いビッグは遅れる）。
  const cn = ctx.nearestDef;
  const perimQ = cn ? clamp(1 + perimContest(cn, h), 0.6, 1.5) : 1;
  // コンテストのリーチ = 手のひら当たり判定（有効時 def−off でサイズ可変、無効時は固定1.8m）。
  const cReach = ctx.palmHitbox && cn ? palmRadius(cn, h) : 1.8;
  p -= clamp(cReach - dDef, 0, cReach) * 0.24 * contestScale * perimQ;
  // 目の前で跳んで手をシュートコースに入れてくる守備者は、視界とリリースを乱して精度を大きく削る。
  // (今までは水平距離だけでコンテストを測っていた — 跳んだ手のコンテストを make% に反映)
  if (cn && cn.airborne && dDef < cReach + 0.4) {
    const inFace = clamp(1 - dDef / (cReach + 0.4), 0, 1);   // 0(離れ)..1(目の前)
    p -= inFace * 0.2 * contestScale;
  }
  // 体勢の崩れ（移動しながらの射撃）— S技術がメカニクスを保つ
  if (h.beatenT > 0 || h.curSpd > h.runSpeed * 0.55) {
    p -= 0.10 * (1 - rate(h.attr.shotTech));
  }
  // 精神: 疲労・劣勢・終盤の重圧が弱い心を乱す
  p -= ctx.clutch * 0.12;
  // 準備不足(急ぎ撃ち/ブザー): 溜め切れなかった秒数だけ精度が落ちる。S技術が落ち込みを緩和。
  if (ctx.prepShort > 0) p -= ctx.prepShort * 0.5 * (1 - rate(h.attr.shotTech) * 0.4);
  // 準備延長(どフリーでじっくり): 溜めを延ばした秒数だけ精度が少し上がる(上限0.4秒相当)。
  if (ctx.prepExtra > 0) p += Math.min(ctx.prepExtra, 0.4) * 0.12;
  return clamp(p, 0.02, 0.93);   // 低い下限で遠投も数%は残す
}

// リング下のフィニッシュ（レイアップ/ダンク）の効果。ダンクにするか(dunk)を抽選し、
// 成功率(p, 0.05〜0.97)とともに返す。
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
  // コンテストの質は位置＋体格で決まる（リム保護ビッグは壁、スイッチしたガードは邪魔にならない）。
  const near = ctx.nearestDef;
  const contestQ = near ? clamp(1 + rimProtect(near, h), 0.5, 1.6) : 1;
  p -= clamp(1.1 - dDef, 0, 1.0) * 0.42 * (1 - strong * 0.7) * contestQ;
  // マークを突いてフィニッシュ — 守備が付いている時だけ効き、密着度でスケール（75が中立）。
  const mark = clamp((1.5 - dDef) / 1.5, 0, 1);   // 0 オープン .. 1 密着
  p += (rate(h.attr.offense) - 0.75) * 1.6 * mark;
  // リム付近の人だかりは壁 — 2-3人へ突っ込むのは低確率。
  if (ctx.crowd >= 2) p -= (ctx.crowd - 1) * 0.23 * (1 - strong * 0.2);
  p -= ctx.clutch * 0.1;
  return { dunk, p: clamp(p, 0.05, 0.97) };
}
