import type { PlayerLook } from "./objects/player/player-look";

// ---------------------------------------------------------------------------
// 選手の能力値。すべての能力値は 0..100(25項目)。
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
  bank: number;         // 弾道高さ — 3P/ミドル/FTの弾道の高さ。高いほどブロックされにくい
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
  // オフェンスロール: ハンドラー/エース/スポットアップ等。OFF_ROLE_ACTION 経由で攻撃時の挙動、
  // ROLE_BEHAVIOR 経由で仮想特能/優先度/プレイメイキングを変える。undefined = 自動(ポジション基準)。
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
  // 見た目（肌/髪の色+髪型）。playerdb の look番号 → resolveLook で解決。DBから作る def
  // には必ず入る。DB外の初期ダミー等では未設定 → 利用側は playerLook(name) にフォールバック。
  look?: PlayerLook;
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
