import { clamp } from "./util";
import { PLAYER_DB, DbPlayer } from "./playerdb";
import { CLUBS } from "./clubdb";

// ---------------------------------------------------------------------------
// 選手の能力値。すべての能力値は 0..100。25項目のスキーマはユーザーの仕様に従う
// (workPlan.md 参照): 以下の各能力値は game.ts に配線されている。
// 身長は PlayerDef 側(メートル)にあり、ここにはない。
// ---------------------------------------------------------------------------
export interface Attributes {
  offense: number;      // オフェンス — オフェンス時の判断・反応の速さ・視野の広さ
  defense: number;      // ディフェンス — ディフェンス時の判断・反応の良さ・視野の広さ
  balance: number;      // ボディバランス — 接触時の強さ
  stamina: number;      // スタミナ — 持久力
  speed: number;        // 速度 — 最高速度
  accel: number;        // 加速力 — 最高速度に到達するまでの速さ
  reaction: number;     // 反応 — とっさの判断や反応
  agility: number;      // 敏捷性 — クイックネス
  dribbleAcc: number;   // D精度 — ドリブル時のスティールされなさ・次の行動への滑らかさ
  dribbleSpd: number;   // D速度 — ドリブル中でも速度が落ちない度
  passAcc: number;      // P精度 — パスの精度・視野の広さ
  passSpd: number;      // P速度 — パスの速さ
  threeAcc: number;     // L精度 — 3Pシュートの精度
  threeRange: number;   // L速度 — 3Pを打てる距離（高いほど遠くから打てる）
  midAcc: number;       // S精度 — ミドルシュートやレイアップの精度
  shotStrength: number; // S威力 — ブロッカーの接触があっても精度を落とさない度合い
  shotTech: number;     // S技術 — 態勢が崩れていても精度よく打てる度合い
  freeThrow: number;    // FK — フリースローの精度
  bank: number;         // 弾道高さ — 3P/ミドル/FTの弾道の高さ。高いほどブロックされにくい（旧カーブを転用）
  dunk: number;         // ヘッド — ダンクのうまさとそれをブロックするうまさ
  jump: number;         // ジャンプ — ジャンプ力
  handling: number;     // 技術 — ボールハンドリングのうまさ
  aggression: number;   // 攻撃性 — オフェンス意識の高さ
  mental: number;       // 精神 — 疲労時・劣勢時・4Q終盤の接戦での強さ
  teamwork: number;     // 連携 — チーム戦術の遂行度
}

// ロスターエディタ用の列メタデータ: 短いラベル + 詳しい説明。
// ここでの順序 = 試合前エディタの列順。
export const ATTR_META: { key: keyof Attributes; label: string; name: string; tip: string }[] = [
  { key: "offense", label: "OFF", name: "オフェンス",
    tip: "オフェンス時の判断・反応の速さ・視野の広さ。高いほど次の行動の判断が速く、良いパスコース／空いた味方を見つけやすい。" },
  { key: "defense", label: "DEF", name: "ディフェンス",
    tip: "ディフェンス時の判断・反応の良さ・視野の広さ。フェイクに引っかかりにくく、パスコースの読みとポジショニングが良くなる。" },
  { key: "balance", label: "BAL", name: "ボディバランス",
    tip: "接触時の強さ。押し合い・ポストアップ・空中の接触で押し負けにくく、相手を押し下げられる。" },
  { key: "stamina", label: "STA", name: "スタミナ",
    tip: "持久力。高いほど疲労が溜まりにくい。疲労すると移動速度とシュート精度が落ちる（落ち方は「精神」で軽減）。" },
  { key: "speed", label: "SPD", name: "速度",
    tip: "最高速度。走って出せるトップスピード。" },
  { key: "accel", label: "ACC", name: "加速力",
    tip: "最高速度に到達するまでの速さ。高いほど出足が鋭い。" },
  { key: "reaction", label: "REA", name: "反応",
    tip: "とっさの判断や反応。スティール・パスカット・ルーズボール・ブロックへの反応、抜かれた後の対応の速さに影響。" },
  { key: "agility", label: "AGI", name: "敏捷性",
    tip: "クイックネス。切り返しや横の動きの鋭さ。1on1で抜く側にも守る側にも効く。" },
  { key: "dribbleAcc", label: "DRA", name: "D精度",
    tip: "ドリブル時のスティールされにくさと、次の行動に移るまでの滑らかさ。" },
  { key: "dribbleSpd", label: "DRS", name: "D速度",
    tip: "ドリブル中でも速度が落ちない度合い。高いほどボール保持中もトップスピードに近い速さで運べる。" },
  { key: "passAcc", label: "PAS", name: "P精度",
    tip: "パスの精度・視野の広さ。狭いコースでもカットされにくいパスを通せる。" },
  { key: "passSpd", label: "PSP", name: "P速度",
    tip: "パスの速さ。速いパスは滞空が短くカットされにくい。" },
  { key: "threeAcc", label: "3PT", name: "L精度",
    tip: "3Pシュートの精度。" },
  { key: "threeRange", label: "RNG", name: "L速度",
    tip: "3Pシュートを打てる距離。高いほどラインの遠くからでも打ち、距離による精度低下も小さい。" },
  { key: "midAcc", label: "SHT", name: "S精度",
    tip: "ミドルシュートやレイアップの精度。" },
  { key: "shotStrength", label: "PWR", name: "S威力",
    tip: "シュート中に相手ブロッカーの接触があっても精度を落とさずシュートを打てる度合い。" },
  { key: "shotTech", label: "TEC", name: "S技術",
    tip: "態勢が崩れていても（ドライブ中・走りながらでも）精度よくシュートを打てる度合い。" },
  { key: "freeThrow", label: "FTS", name: "FK",
    tip: "フリースローの精度。" },
  { key: "bank", label: "ARC", name: "弾道高さ",
    tip: "シュートの弾道の高さ（3P・ミドル・フリースロー）。高いほど山なりでブロックされにくく、低いほどブロックのリスクが上がる。高いほど良い。" },
  { key: "dunk", label: "DNK", name: "ヘッド",
    tip: "ダンクのうまさと、相手のダンク/リム付近のフィニッシュをブロックするうまさ。" },
  { key: "jump", label: "JMP", name: "ジャンプ",
    tip: "ジャンプ力。リバウンド・ブロック・ダンクの高さと、空中のボールへの届きやすさ。" },
  { key: "handling", label: "HND", name: "技術",
    tip: "ボールハンドリングのうまさ。1on1で相手を抜く力・ボールキープ力。" },
  { key: "aggression", label: "AGG", name: "攻撃性",
    tip: "オフェンス意識の高さ。高いほど自分からシュート／ドライブを狙い、カットも積極的に走る。" },
  { key: "mental", label: "MTL", name: "精神",
    tip: "疲れているとき・負けているとき・4Q終盤の接戦での強さ。80が基準で、低いほどその状況で精度が落ち、80より高い選手はむしろ精度が上がる（クラッチ性能）。" },
  { key: "teamwork", label: "TWK", name: "連携",
    tip: "チーム戦術の遂行度。高いほどチーム戦術（ペース・3P志向・ヘルプ等の方針）に忠実にプレーする。" },
];

// ---------------------------------------------------------------------------
// 特殊能力 — 選手ごとの真偽値。それぞれが game.ts の特定の挙動にバイアスをかける。
// 選手はそれを持っているか持っていないかのどちらか。
// ---------------------------------------------------------------------------
export type AbilityKey =
  | "driver" | "keepDribble" | "positioning" | "leakOut" | "general"
  | "throughPass" | "striker" | "isoShooter" | "post" | "lineMove"
  | "range" | "sideSpot" | "centerSpot" | "ftKicker" | "oneTouch"
  | "outside" | "manMark" | "interceptor" | "covering" | "dfLine" | "longThrow";

export const ABILITY_META: { key: AbilityKey; label: string; tip: string }[] = [
  { key: "driver", label: "スラッシャー", tip: "ドリブルでリムへ切り込む意識が高い。ドライブを積極的に選ぶ。" },
  { key: "keepDribble", label: "ボールキープ", tip: "ドリブルでキープしチーム全体の動きを整える。保持中はスティールされにくく、味方の動き直しが速くなり、攻め急がない。" },
  { key: "positioning", label: "オフボール", tip: "オフェンス時に良いポジションを取る。空いたスポットを的確に選び、動き直しも速い。" },
  { key: "leakOut", label: "速攻", tip: "トランジションの瞬間、真っ先に相手ゴールへ走り出す（リークアウト）。" },
  { key: "general", label: "フロアジェネラル", tip: "チーム全体のポジショニングがよくなる。味方全員の動き直しが速く・的確になる。" },
  { key: "throughPass", label: "ディッシュ", tip: "イージーシュートを生むラストパス（カッターへのフィード）を高精度で出せる。" },
  { key: "striker", label: "スコアラー", tip: "得点を取る意識が高い。オフェンス優先度とシュート欲求が上がる。" },
  { key: "isoShooter", label: "アイソレーション", tip: "相手が1人ついていてもシュートまでもっていける。単独マーク相手ならコンテストの影響が大きく減る。" },
  { key: "post", label: "ポストアップ", tip: "ポストプレイが上手い。PF/C以外でもポストアップでき、ゴールへの押し込み・キープが強くなる。" },
  { key: "lineMove", label: "カッティング", tip: "ゴール付近でとっさに動いてマークを置き去りにするのが得意。カットが速く、頻度も上がる。" },
  { key: "range", label: "ロングレンジ", tip: "3Pやミドルシュートをより広範囲から打てる。射程が伸び、距離による精度低下も小さい。" },
  { key: "sideSpot", label: "コーナー", tip: "コーナー待機などコートの両サイドにポジションを取りやすい。" },
  { key: "centerSpot", label: "ペイント", tip: "ゴール下などペイント付近にポジションを取りやすく、リバウンドにも強く絡む。" },
  { key: "ftKicker", label: "FTシューター", tip: "フリースローの精度が高い（成功率+8%）。" },
  { key: "oneTouch", label: "キャッチ&シュート", tip: "パスを受けてからのプレーが速く正確。キャッチ直後の判断が速く、キャッチ&シュートの精度が上がる。" },
  { key: "outside", label: "ノールック", tip: "体の向きに縛られない広い範囲へパスの選択肢がある。際どいコースでもカットされにくい。" },
  { key: "manMark", label: "ロックダウン", tip: "対面のマークが上手い。距離を詰め、抜かれにくく、反応も速い。" },
  { key: "interceptor", label: "パスカット", tip: "パスを読んで奪うのが上手い。パスカットとリーチインの成功率が上がり、ロングパスへいち早く反応して飛び出す。" },
  { key: "covering", label: "ヘルプディフェンス", tip: "抜かれた味方のカバーが上手い。マークを捨ててドライブコースへ先回りする。" },
  { key: "dfLine", label: "守備司令塔", tip: "味方全体の守備位置を指示し補正する。チーム全員の守備反応とヘルプ位置が良くなる。" },
  { key: "longThrow", label: "アウトレット", tip: "インバウンドパスを遠くまで速く投げられる。ロングアウトレットで速攻の起点になる。" },
];

export interface PlayerDef {
  name: string;
  role: string;       // PG / SG / SF / PF / C
  height: number;     // メートル — 身長。リバウンド・ブロック・ゴール下の届く高さに影響
  attr: Attributes;
  abilities?: AbilityKey[]; // 特殊能力 — 持っているものだけ列挙
  priority?: number;  // 明示的なオフェンス優先度 0..1 (ロール/スキルのデフォルトを上書き)
  // オフェンスロール: ハンドラー/エース/スポットアップ等。OVR/チーム戦力バーの評価
  // 重みに加え、OFF_ROLE_ACTION 経由で**試合中の攻撃時の挙動**（何をするか＝打つ/
  // 捌く/スポット待ち/ポスト等）と ROLE_BEHAVIOR 経由の仮想特能/優先度/プレイメイキ
  // ングを変える。undefined = 自動(ポジション基準)。
  evalRole?: string;
  // ディフェンスロール: ロックダウン/リムプロテクター等。DEF_ROLE_BEHAVIOR 経由で
  // 守備時の仮想特能と“常時全力(サボらない)”を付与。オフェンスロールとは独立。
  defRole?: string;
  // オフェンス選択順位 1..5（誰にボールを集めるか＝使用率）。未設定=チーム内の
  // 得点力比較で自動。同順位は「co-primary（2人でシェア）」として扱う。
  choiceRank?: number;
  // 利き手 (DBの利き足を読み替え)。攻める側の選択と逆手フィニッシュ精度に影響
  hand?: "R" | "L";
  // 安定度は未配線。逆手精度/逆手頻度は利き手システムが使用
  future?: { stability: number; offhandAcc: number; offhandFreq: number };
}

// ---------------------------------------------------------------------------
// チーム戦術(各0..1)。これらは各選手の個々の判断とチームの守備ポジショニングに
// バイアスをかける。個人がその方針にどれだけ忠実に従うかは、その選手の連携
// (teamwork)能力値による。
// ---------------------------------------------------------------------------
export interface Tactics {
  offense: {
    pace: number;         // 低 = クロックを使う, 高 = 早めに打つ / プッシュする
    threeBias: number;    // 3Pシュートへの志向
    driveBias: number;    // リムへのアタック志向
    ballMovement: number; // パス&ムーブ vs アイソレーション
  };
  defense: {
    pressure: number;     // オンボールのタイトなプレッシャー(詰める、ギャンブルが多い)
    help: number;         // オフボールの守備がペイント保護のためどれだけ絞るか
    zone: number;         // 0 = 常にマン, 1 = 常にハーフコートゾーン (2-3/3-2)
    press: number;        // 0 = しない, 1 = 毎回ボール運びをフルコートプレスする
    deny: number;         // 0..1 — ショットクロック終盤にシュートをDENYする(オンボールに
                          // 這い寄る + アウトレットを封じる)ことでショットクロック違反を強いる。
                          // リスク: オーバープレイは破られやすい → リムのフィニッシュを許す。
  };
}

// チームでインデックスする。戦術の効果が見えるよう、2つの明確に異なる個性。
export const TACTICS: Tactics[] = [
  // Team 0 — BLAZE: じっくり、内を攻める、保守的なヘルプディフェンス。2-3ゾーンで
  // ペイントをそれなりに固め、めったにプレスしない
  { offense: { pace: 0.35, threeBias: 0.30, driveBias: 0.65, ballMovement: 0.55 },
    defense: { pressure: 0.40, help: 0.70, zone: 0.35, press: 0.10, deny: 0.25 } },
  // Team 1 — WAVE: 速いペース、3P好き、アグレッシブ。詰めてプレスし、
  // ハーフコートではほぼマン
  { offense: { pace: 0.80, threeBias: 0.75, driveBias: 0.45, ballMovement: 0.65 },
    defense: { pressure: 0.80, help: 0.40, zone: 0.12, press: 0.40, deny: 0.35 } },
];

/** 0..100 の能力値を 0..1 の係数へ写す。 */
export const rate = (r: number): number => clamp(r, 0, 100) / 100;

// ---------------------------------------------------------------------------
// 評価ロール → 試合中の挙動 (keys = UI の EVAL_ROLES と同じ日本語名)。
// `ab` はロールが付与する“仮想特能” — 既存の特殊能力の配線にそのまま乗るので、
// ロールを設定するだけで該当する判断・動きが変わる。`pri` は攻撃優先度への加算
// （ボールが集まる度・守備の省エネ判定に影響）、`pm` はプレイメイキング加算
// （ボール運び/アウトレットの受け手優先度に影響）。
// ---------------------------------------------------------------------------
export const ROLE_BEHAVIOR: Record<string, { ab?: AbilityKey[]; pri?: number; pm?: number }> = {
  メインハンドラー:      { ab: ["keepDribble"], pm: 0.5 },               // ボール運び役を奪う(PG基準1.0超え)
  セカンドハンドラー:    { pm: 0.2 },                                    // 第2の組み立て役
  フロアジェネラル:      { ab: ["general"], pm: 0.45 },                  // チーム全体の動きを速く正確に
  スラッシャー:          { ab: ["driver"], pri: 0.06 },                  // ドライブを積極的に選ぶ
  エース:                { ab: ["striker", "isoShooter"], pri: 0.18 },   // 第1オプション化+単独で打ち切る
  スポットアップ:        { ab: ["oneTouch"], pri: 0.02 },                // キャッチ&シュート特化
  "3&D":                 { ab: ["oneTouch", "manMark"], pri: -0.06 },    // C&S+タイトなマンマーク
  ポイントフォワード:    { pm: 0.3 },                                    // FWがボールを運ぶ
  ストレッチ:            { ab: ["range", "sideSpot"], pri: 0.02 },       // 射程延長+外に張る(ポスト常駐しない)
  リムプロテクター:      { ab: ["covering"], pri: -0.1 },                // 抜かれた味方のカバーへ先回り
  リムランナー:          { ab: ["leakOut"], pri: -0.04 },                // 攻守交替で真っ先に走る
  スクリーナー:          { pri: -0.12 },                                 // スクリーン頻度はgame.ts側で加算
  プレイメイキングビッグ: { ab: ["throughPass"], pm: 0.35 },              // ビッグがラストパスを配る
  リバウンダー:          { ab: ["centerSpot"], pri: -0.12 },             // ペイント常駐+ビッグ同様に板へ突入
  フロアスペーサー:      { ab: ["sideSpot", "oneTouch"], pri: -0.04 },   // コーナーに張ってC&S
  オフボールカッター:    { ab: ["lineMove"], pri: -0.02 },               // カットが速く頻度も上がる
  ロックダウン:          { ab: ["manMark"], pri: -0.1 },                 // 常時全力マーク(省エネ免除)
  スイッチディフェンダー: { ab: ["covering", "manMark"], pri: -0.08 },    // カバー+マーク両立(省エネ免除)
  エナジーガイ:          { ab: ["interceptor"], pri: -0.08 },            // リーチイン/飛び出し+常時全力
};

// ---------------------------------------------------------------------------
// オフェンスロール → ボールが手に渡った時の“行動プロファイル”。何をするかを
// ロールが支配するので、パサーやビッグに使用率(選択順位)が集まっても強引に打っ
// たり無理なドリブルをしない。game.ts の decide() がこれを読む。
//   score     … 自分で打ち切る/iso（エース）
//   slash     … ドリブルでリムへアタック（スラッシャー）
//   distribute… まず配球。明確に空いた時だけ打つ（ハンドラー/フロアジェネラル/PF）
//   postHub   … ポスト/ハイポストから配る（プレイメイキングビッグ）
//   spot      … キャッチ&シュート。無理なドリブルはしない（スポット/ストレッチ等）
//   cut/run   … 合わせ/リムラン。空けば決める、無ければ移動
//   screen    … スクリーン主。貰っても捌く
//   rebound   … ペイント/板。貰ってもゴール下フィニッシュか捌くのみ
//   balanced  … 強いロール補正なし＝従来の属性ドリブンな判断
// ---------------------------------------------------------------------------
export type OffAction =
  | "score" | "slash" | "distribute" | "postHub" | "postScore"
  | "spot" | "cut" | "run" | "screen" | "rebound" | "balanced";

export const OFF_ROLE_ACTION: Record<string, OffAction> = {
  メインハンドラー: "distribute", セカンドハンドラー: "distribute",
  フロアジェネラル: "distribute", ポイントフォワード: "distribute",
  スラッシャー: "slash", エース: "score",
  スポットアップ: "spot", "3&D": "spot", ストレッチ: "spot", フロアスペーサー: "spot",
  オフボールカッター: "cut", リムランナー: "run",
  スクリーナー: "screen", プレイメイキングビッグ: "postHub",
  リバウンダー: "rebound", リムプロテクター: "rebound",
  ロックダウン: "balanced", スイッチディフェンダー: "balanced", エナジーガイ: "balanced",
};
export function offActionOf(role: string | undefined): OffAction {
  return (role && OFF_ROLE_ACTION[role]) || "balanced";
}

// ---------------------------------------------------------------------------
// ディフェンスロール → 守備時の仮想特能とエフォート・ギア。オフェンスロールと独立。
// `effort`(0..1) は守備の“出力”＝どれだけ全力で守るか。移動速度が下がると疲労も
// 減る仕組み(entities.tickMotion)なので、effortが低いロール＝スタミナ消費が少ない。
// これで「攻撃に専念して脚を温存する省エネ守備」も「常時全力の二刀流」もロール
// 割当だけで表現でき、守備手抜きを“使用率”に自動連動させずに済む。
// `lockEffort` はクラッチ以外でも常に全力(effort 1.0)。
// ---------------------------------------------------------------------------
export const DEF_ROLE_BEHAVIOR: Record<string, { ab?: AbilityKey[]; effort: number; lockEffort?: boolean }> = {
  ロックダウン:          { ab: ["manMark"], effort: 1.0, lockEffort: true },
  スイッチディフェンダー: { ab: ["covering", "manMark"], effort: 1.0, lockEffort: true },
  パスカット:            { ab: ["interceptor"], effort: 1.0, lockEffort: true },  // 旧エナジーガイを統合
  リムプロテクター:      { ab: ["covering"], effort: 1.0 },
  ヘルプディフェンダー:  { ab: ["covering"], effort: 0.95 },
  守備司令塔:            { ab: ["dfLine"], effort: 0.95 },
  ハッスルディフェンダー: { effort: 1.0, lockEffort: true },  // 常時全力・特能なし(体を張る堅実型)
  バランス:              { effort: 0.9 },                     // 標準
  省エネ:                { effort: 0.7 },                     // 攻撃専念で脚を温存(スタミナ消費小)
};

// オフェンス選択順位(1..5) → 使用率(0..1)。sim検証で「中庸な傾斜」が最良
// （最大まで振ると過剰iso＋守備サボりで逆効果）だったため、緩やかな階段に。
const RANK_USAGE = [0.86, 0.72, 0.60, 0.52, 0.45];
export function usageFromRank(rank: number): number {
  return RANK_USAGE[clamp(Math.round(rank), 1, 5) - 1];
}

// 得点力スコア（選択順位の自動割当に使う。チーム内で相対比較）。
export function scoringPower(a: Attributes): number {
  return rate(a.threeAcc) * 0.26 + rate(a.midAcc) * 0.24 + rate(a.dunk) * 0.12
    + rate(a.aggression) * 0.14 + rate(a.handling) * 0.12 + rate(a.offense) * 0.12;
}

// ---------------------------------------------------------------------------
// ポジションに基づくオフェンスの個性。`scoreBase` はそのポジションが通常どれだけ
// 得点オプションかを表す(頼れるスコアラーはウイング/2ガード)。`playmaking` はその
// ポジションがどれだけボールを運び味方をお膳立てするか(ポイントガード)。
// この後、選手個々の能力値が人ごとにこれらを微調整する。
// ---------------------------------------------------------------------------
const ROLE_OFFENSE: Record<string, { scoreBase: number; playmaking: number }> = {
  PG: { scoreBase: 0.55, playmaking: 1.00 },
  SG: { scoreBase: 0.85, playmaking: 0.55 },
  SF: { scoreBase: 0.80, playmaking: 0.45 },
  PF: { scoreBase: 0.55, playmaking: 0.30 },
  C:  { scoreBase: 0.45, playmaking: 0.25 },
};
export function roleOffense(role: string): { scoreBase: number; playmaking: number } {
  return ROLE_OFFENSE[role] ?? { scoreBase: 0.6, playmaking: 0.4 };
}

// 選手の得点オプションとしての重み(0..1)。def 上の明示的な `priority` が優先される
// (試合前エディタで設定できるように)。それ以外はポジションのベースラインを選手の
// 得点能力値で微調整して導出する。
export function computeOffPriority(def: PlayerDef): number {
  // 明示的な選択順位(1..5)が最も強いシグナル — それこそがユーザー(または自動ランカー)が
  // 設定した使用率そのもの。game.ts は refreshChoiceRanks でコート上のユニットごとに
  // これを再導出する。ここは単独/プレビューのケースをカバーする。
  if (def.choiceRank) return usageFromRank(def.choiceRank);
  if (def.priority !== undefined) return clamp(def.priority, 0, 1);
  const ro = roleOffense(def.role);
  const a = def.attr;
  const scoringSkill = (rate(a.aggression) + rate(a.threeAcc) + rate(a.midAcc)) / 3;
  let base = ro.scoreBase * 0.65 + scoringSkill * 0.35;
  if (def.abilities?.includes("striker")) base += 0.12;  // ストライカー: 頼れる中心選手
  return clamp(base, 0, 1);
}

// ロスターテーブルを読みやすく保つための短縮関数 — 引数は ATTR_META の順に従う。
const A = (
  offense: number, defense: number, balance: number, stamina: number,
  speed: number, accel: number, reaction: number, agility: number,
  dribbleAcc: number, dribbleSpd: number, passAcc: number, passSpd: number,
  threeAcc: number, threeRange: number, midAcc: number, shotStrength: number,
  shotTech: number, freeThrow: number, bank: number, dunk: number,
  jump: number, handling: number, aggression: number, mental: number, teamwork: number,
): Attributes => ({
  offense, defense, balance, stamina, speed, accel, reaction, agility,
  dribbleAcc, dribbleSpd, passAcc, passSpd, threeAcc, threeRange, midAcc,
  shotStrength, shotTech, freeThrow, bank, dunk, jump, handling, aggression,
  mental, teamwork,
});

const MIN = A(10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10);
const MAX = A(99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99);

// ---------------------------------------------------------------------------
// インポートした WE2010 選手データベースからのランダムなマッチアップ: 毎試合、チーム
// ごとに新しい13人ロスターを引く(同じ試合に同じ選手が二度出ることはない)。
// 既存の PlayerDef オブジェクトはその場で書き換える — Player.attr は def.attr への
// ライブ参照を保持するので、フィールドごとの代入でエンティティも更新される。
// ---------------------------------------------------------------------------
// データベースのエントリから、新しい独立した PlayerDef を構築する(その選手本来の
// ポジション、身長、能力値、特殊能力、利き手)。試合前の選手ピッカーが、ロスタースロットに
// 触れずに4000人超の任意の選手をプレビューするのに使う。
export function makeDefFromDb(p: DbPlayer): PlayerDef {
  const [name, role, hcm, ratings, mask, extras, hand] = p;
  const attr = {} as Attributes;
  ATTR_META.forEach((m, k) => { attr[m.key] = clamp(ratings[k] ?? 50, 0, 100); });
  return {
    name, role, height: hcm / 100, attr,
    abilities: ABILITY_META.filter((_, b) => mask & (1 << b)).map((m) => m.key),
    hand: hand === "L" ? "L" : "R",
    future: { stability: extras[0] ?? 0, offhandAcc: extras[1] ?? 0, offhandFreq: extras[2] ?? 0 },
  };
}

// データベースのエントリを既存のロスタースロットへ、その場でコピーする。フィールド
// ごとの attr 代入は意図的: Player.attr は def.attr へのライブ参照を保持するので、
// オブジェクトを差し替えるのではなくフィールドを書き換えるとコート上のエンティティも更新される。
export function applyDbPlayer(def: PlayerDef, p: DbPlayer): void {
  const src = makeDefFromDb(p);
  def.name = src.name;
  def.role = src.role;
  def.height = src.height;
  def.priority = undefined;
  ATTR_META.forEach((m) => { def.attr[m.key] = src.attr[m.key]; });
  def.abilities = src.abilities;
  def.hand = src.hand;
  def.future = src.future;
}

// データベースから1チーム分の新しい13人ロスターを引く。相手チームにすでにいる選手を
// 避けることで、2つのラインナップが選手を共有することはない。
export function randomizeTeam(team: number): void {
  const pools: Record<string, DbPlayer[]> = { PG: [], SG: [], SF: [], PF: [], C: [] };
  for (const p of PLAYER_DB) pools[p[1]]?.push(p);
  const used = new Set<DbPlayer>();
  // 相手チームの現在の選手(名前で照合)を予約しておき、このチームへ重複させないようにする
  const otherNames = new Set(ROSTER[1 - team].map((p) => p.name));
  for (const p of PLAYER_DB) if (otherNames.has(p[0])) used.add(p);
  const draw = (role: string): DbPlayer => {
    const pool = pools[role] ?? PLAYER_DB;
    for (let tries = 0; tries < 60; tries++) {
      const cand = pool[Math.floor(Math.random() * pool.length)];
      if (!used.has(cand)) { used.add(cand); return cand; }
    }
    const fallback = pool.find((c) => !used.has(c)) ?? pool[0];
    used.add(fallback);
    return fallback;
  };
  const roles = ["PG", "SG", "SF", "PF", "C", ...BENCH_ROLES];
  for (let i = 0; i < ROSTER_SIZE; i++) {
    applyDbPlayer(ROSTER[team][i], draw(roles[i]));
    ROSTER[team][i].role = roles[i];   // スロットのポジションに固定(フォールバック抽選だと異なり得る)
  }
}

export function randomizeRosters(): void {
  randomizeTeam(0);
  randomizeTeam(1);   // team 1 は team 0 の新規抽選を避ける → 共有選手なし
}

// ---- クラブ再現 ------------------------------------------------------------
// 実在クラブのスカッド(clubdb。同じマスターリーグのシートから抽出)から1チーム分の
// 13人ロスターを構築する。各スロットには、変換後のロールが一致する残りのスカッド
// メンバーの中で最良の者を入れる。スカッドに欠けるロールは最も近いバスケの
// ポジション(PF↔C, SG↔SF …)へフォールバックする — 例えば変換後のPFがいないクラブは
// そこに2人目のCBを置く。ツインタワーのラインナップのように。
const ROLE_FALLBACK: Record<string, string[]> = {
  PG: ["SG", "SF", "PF", "C"],
  SG: ["SF", "PG", "PF", "C"],
  SF: ["SG", "PF", "PG", "C"],
  PF: ["C", "SF", "SG", "PG"],
  C:  ["PF", "SF", "SG", "PG"],
};
// 各バスケスロットが重視するもの(25能力値配列へのインデックス、ATTR_META順)。
// 単純な25項目平均だと、尖ったスターが何でもこなすロールプレイヤーに埋もれてしまう
// (メッシがSGの座をダニエウ・アウベスに奪われる)ので、スロット値は半分が総合、
// 半分がそのスロットの主要能力値。
const ROLE_KEY_ATTRS: Record<string, number[]> = {
  PG: [10, 11, 0, 21, 7],        // P精度 P速度 オフェンス 技術 敏捷性
  SG: [14, 12, 0, 4, 7, 21],     // S精度 L精度 オフェンス 速度 敏捷性 技術
  SF: [14, 0, 20, 2, 21],        // S精度 オフェンス ジャンプ バランス 技術
  PF: [1, 2, 20, 19, 15],        // ディフェンス バランス ジャンプ ヘッド S威力
  C:  [1, 2, 20, 19, 15],
};
const slotValue = (p: DbPlayer, role: string): number => {
  const r = p[3];
  const avg = r.reduce((a, b) => a + b, 0) / r.length;
  const keys = ROLE_KEY_ATTRS[role] ?? [];
  const key = keys.length ? keys.reduce((a, k) => a + (r[k] ?? 50), 0) / keys.length : avg;
  return avg * 0.5 + key * 0.5;
};

export function clubTeam(team: number, clubIdx: number): void {
  const club = CLUBS[clubIdx];
  if (!club) return;
  const squad = club[2].map((i) => PLAYER_DB[i]).filter(Boolean);
  const used = new Set<DbPlayer>();
  const pick = (role: string): DbPlayer => {
    for (const r of [role, ...ROLE_FALLBACK[role]]) {
      const cands = squad.filter((p) => !used.has(p) && p[1] === r);
      if (cands.length) {
        const best = cands.reduce((a, b) => (slotValue(b, role) > slotValue(a, role) ? b : a));
        used.add(best);
        return best;
      }
    }
    const rest = squad.filter((p) => !used.has(p));
    const best = rest.reduce((a, b) => (slotValue(b, role) > slotValue(a, role) ? b : a));
    used.add(best);
    return best;
  };
  const roles = ["PG", "SG", "SF", "PF", "C", ...BENCH_ROLES];
  for (let i = 0; i < ROSTER_SIZE; i++) {
    applyDbPlayer(ROSTER[team][i], pick(roles[i]));
    ROSTER[team][i].role = roles[i];   // その選手はスロットのポジションでプレーする
  }
}

// [team][idx] でインデックスするNBA式の13人ロスター: idx 0..4 = 先発
// (PG, SG, SF, PF, C)、idx 5..12 = 8人のベンチ(完全なセカンドユニット
// PG/SG/SF/PF/C に加えて3人目のガード、ウイング、ビッグ)。
// NOTE: テスト設定 — RED (BLAZE) は全能力値が下限、BLUE (WAVE) が上限なので、
// 能力値の効果が明白になる。実際のゲーム向けには再調整すること。
export const STARTERS = 5;
export const ROSTER_SIZE = 13;

// 記載ポジション以外でも起用可能な選手。キー = 名前(playerdb と完全一致が必要)。
// 値 = 自分のロールに加えて起用できる追加ポジション。
// それ以外の全員は自分のロールでのみプレーできる — 選手は自分の適性セットにない
// ポジションには決して置かれない(隣接ポジション不可、特能による代替も不可)。
// 選手をマルチポジションにするにはここにエントリを追加する(例: SGもこなすSF)。
export const EXTRA_POSITIONS: Record<string, string[]> = {
  "クリスティアーノ・ロナウド": ["SG"],   // SF に加えて SG も可
};
const BENCH_ROLES = ["PG", "SG", "SF", "PF", "C", "SG", "SF", "PF"];

const mk = (name: string, role: string, height: number, attr: Attributes): PlayerDef =>
  ({ name, role, height, attr });

export const ROSTER: PlayerDef[][] = [
  [ // Team 0 — BLAZE (RED) — すべて最小値
    mk("Vega",  "PG", 1.85, { ...MIN }),
    mk("Knox",  "SG", 1.85, { ...MIN }),
    mk("Reed",  "SF", 1.85, { ...MIN }),
    mk("Boone", "PF", 1.85, { ...MIN }),
    mk("Sato",  "C",  1.85, { ...MIN }),
    ...["Cole", "Duke", "Finn", "Gray", "Hale", "Iker", "Judd", "Kane"]
      .map((n, i) => mk(n, BENCH_ROLES[i], 1.85, { ...MIN })),
  ],
  [ // Team 1 — WAVE (BLUE) — すべて最大値
    mk("Ito",    "PG", 2.10, { ...MAX }),
    mk("Lang",   "SG", 2.10, { ...MAX }),
    mk("Cruz",   "SF", 2.10, { ...MAX }),
    mk("Diaz",   "PF", 2.10, { ...MAX }),
    mk("Okafor", "C",  2.10, { ...MAX }),
    ...["Pena", "Quon", "Ross", "Silva", "Tate", "Umar", "Vidal", "Webb"]
      .map((n, i) => mk(n, BENCH_ROLES[i], 2.10, { ...MAX })),
  ],
];
