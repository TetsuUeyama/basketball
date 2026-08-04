// 選手データフォルダの結合点。WE2010 Excel由来（手編集不可）の選手を、統一ID で
// 3ファイルへ分割して保持し、ここで id 整列して従来と同一形状の PLAYER_DB を再構築する
// （id = 配列インデックス）。
//   - identity.ts : [id, name, role, heightCm, hand, look[skin,hair,style,hairNo]]
//   - ratings.ts  : [id, ratings[25], extras[安定度,逆手精度,逆手頻度]]
//   - abilities.ts: [id, abilityMask]
// 再生成フロー: Excel→生成→bake-look（look付与）→split-players（3ファイルへ分割）
//               →assign-hair（髪型Noを138種へ均等配分。scripts/assign-hair.mjs）。
import { IDENTITY } from "./identity";
import { RATINGS } from "./ratings";
import { ABILITIES } from "./abilities";

// 従来の playerdb タプルと同一形状（並び）。既存コードはこの形状に依存する。
// [name, role, heightCm, ratings[25], abilityMask, extras[3], hand, look[skin,hair,style,hairNo]]
export type DbPlayer = [string, string, number, number[], number, number[], string, [number, number, number, number]];

// 3テーブルを id（=配列インデックス）で整列結合して再構築。
export const PLAYER_DB: DbPlayer[] = IDENTITY.map((idn, i): DbPlayer => {
  const rt = RATINGS[i], ab = ABILITIES[i];
  return [idn[1], idn[2], idn[3], rt[1], ab[1], rt[2], idn[4], idn[5]];
});
