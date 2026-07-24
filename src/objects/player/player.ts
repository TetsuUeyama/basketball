import {
  Scene, Vector3, Quaternion, MeshBuilder, StandardMaterial, Color3, Mesh, TransformNode,
  DynamicTexture, VertexData,
} from "@babylonjs/core";
import { TEAM_COLORS, HUD_OPTS, uniformOf, type RGB } from "../../config";
import { Attributes, AbilityKey, PlayerDef, rate, roleOffense, computeOffPriority, ROLE_BEHAVIOR,
  DEF_ROLE_BEHAVIOR, OffAction, offActionOf } from "../../attributes";
import { clamp, playerLook } from "../../util";

// 現在の試合における選手のボックススコア。`min` はコート上の時間で、
// ゲームクロック秒（結果画面では分として表示）。
export interface Stats {
  pts: number; reb: number; ast: number; stl: number; blk: number; tov: number;
  fgm: number; fga: number;   // フィールドゴール成功/試投（3Pを含む全シュート）
  tpm: number; tpa: number;   // 3Pシュート成功/試投
  ftm: number; fta: number;   // フリースロー成功/試投
  min: number;
}

// 既定の下向きの腕 (0,-1,0) を単位ベクトルへ回転させるクォータニオン。
export function aimDownTo(vx: number, vy: number, vz: number): Quaternion {
  const dot = -vy;                                   // dot((0,-1,0),(vx,vy,vz))
  if (dot > 0.9999) return Quaternion.Identity();
  if (dot < -0.9999) return Quaternion.RotationAxis(new Vector3(1, 0, 0), Math.PI);
  const axis = new Vector3(-vz, 0, vx);              // cross((0,-1,0),(vx,vy,vz))
  axis.normalize();
  return Quaternion.RotationAxis(axis, Math.acos(clamp(dot, -1, 1)));
}

// ---------------------------------------------------------------------------
// Player — キネマティックなアクター。論理位置は `pos`（XZ、足は床面）に持ち、
// メッシュは毎フレームそこから同期する。物理ボディは持たない。
// ---------------------------------------------------------------------------
export class Player {
  // ヘッドレスバッチ実行: (純粋に見た目だけの)スワップ毎の髪再構築+ネームタグ
  // 再描画をスキップし、数千回のロースター入替でBabylonメッシュが増殖/リークしない
  // ようにする。シミュレーション前にヘッドレスランナーがtrueにする。画面表示のゲームではfalseのまま。
  static HEADLESS = false;
  readonly team: number;
  readonly idx: number;          // チーム内のロースター番号 (0..12)。ユニフォーム番号 = idx+1
  slot = 0;                      // コート上のスロット 0..4（マンマッチのキー）
  stintT = 0;                    // この選手が最後にチェックインしてからのゲーム秒
  name: string;
  attr: Attributes;              // defの能力値へのライブ参照
  height: number;                // メートル
  runSpeed: number;              // m/s、`speed`能力値から算出
  role: string;                  // PG / SG / SF / PF / C
  evalRole: string | undefined;  // オフェンスロール — 攻撃時の挙動修飾 (applyDef)
  defRole: string | undefined;   // ディフェンスロール — 守備時の挙動修飾 (applyDef)
  offAction: OffAction = "balanced"; // オフェンスロール由来の行動プロファイル
  lockDef = false;               // 守備をサボらない（defRole由来の常時全力）
  defEffortGear: number | undefined; // defRole由来の守備エフォート上限(0..1)。未設定=自動
  choiceRank: number | undefined; // 手動の選択順位 1..5 (def由来。未設定=自動)
  autoRank = 3;                  // refreshChoiceRanks が入れる自動順位 1..5
  hand: "R" | "L" = "R";         // 利き手 — 得意な攻撃サイド＆フィニッシュの手
  offhandAcc = 5;                // 逆手精度 2..8 (WE2010スケール) — 逆手フィニッシュの質
  offhandFreq = 5;               // 逆手頻度 2..8 — どれだけ進んで逆サイドを使うか
  offPriority: number;           // 0..1 スコアオプションの比重（頼れるスコアラー=高）
  playmaking: number;            // 0..1 ボール運び/プレイメイキングのロール（PG=高）

  // 現在の試合を通して累積するボックススコアの統計
  readonly stats: Stats = { pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, tov: 0, fgm: 0, fga: 0, tpm: 0, tpa: 0, ftm: 0, fta: 0, min: 0 };
  readonly pos = new Vector3();  // 論理位置（足元）
  readonly root: TransformNode;

  // ボールを保持/ドリブル/パス/シュートするために手を伸ばす短い腕
  readonly armPivotL: TransformNode;
  readonly armPivotR: TransformNode;
  elbowL!: TransformNode;   // 上腕 ↔ 前腕の関節（静止時は曲げ、伸ばして届かせる）
  elbowR!: TransformNode;

  // 名前が変わると再描画される浮遊ネームタグ
  private nameTex!: DynamicTexture;
  private namePlane!: Mesh;   // 浮遊ネームタグ。HUD_OPTS.showNamesがオフのとき非表示
  // ユニフォームキットのマテリアル — キット切替時にapplyUniform()でライブに再着色
  private topMat!: StandardMaterial;
  private bottomMat!: StandardMaterial;
  private sleeveMat!: StandardMaterial;
  private shoeMat!: StandardMaterial;

  // 背番号のデカール。Zの各サイド・各ボディスタイルごとに1つ。表示されるのは
  // 現在表示中のボディにおける選手の背中側
  private numHumanPlus!: Mesh;
  private numHumanMinus!: Mesh;
  private numAcornPlus!: Mesh;
  private numAcornMinus!: Mesh;
  numberSide = 1;   // 現在どちらのローカルZサイドに番号を表示しているか
  private sideApplied = false; // Gameがまだ背中側を選んでいない — シェルは非表示のまま

  // 上半身のキャリア: 胴・頭・腕・背番号がこれに乗り、プレー方向へTWISTする
  // (twistToward)。一方でroot — そして脚と足 — は進行方向を向く。胴を回して
  // 受け・パス・ドライブへの追随をしながら、片方向へ走り続けられるようにする。
  torsoNode!: TransformNode;
  torsoTwist = 0;   // 平滑化したツイスト(rad)、±TWIST_MAXにクランプ
  headNode!: TransformNode;   // 頭のキャリア — 胴のツイストの上にヨーを重ねる
  headYaw = 0;      // 胴に対する平滑化した頭の回転(rad)、±HEAD_MAX

  // 両方のボディスタイルは生成時から存在する。applyModel()が一方を表示し他方を
  // 隠すので、HUDメニューからスタイルをライブに切り替えられる。
  private humanNode!: TransformNode;   // 矩形の胴（リボン+キャップ）
  private acornNode!: TransformNode;   // どんぐりの姿（胸+腰+シューズの足）
  acornWaistPivot!: TransformNode; // 腰はこれに乗る。腰-胸の切断面の位置 —
                                       // 着席時は90°前方へ折り畳む（膝の上）
  acornFootL!: TransformNode;  // シューズ型の足 — 非対称なので、位置もヨーも
  acornFootR!: TransformNode;  // numberSideと共に反転する
  acornLegL!: TransformNode;   // 腰→シューズを繋ぐ素肌の脚シリンダー
  acornLegR!: TransformNode;   // （どんぐりモデル専用。rootに固定）
  eyeL!: Mesh;                  // 顔の目 — 前面に配置 (-numberSide·Z)
  eyeR!: Mesh;
  private scene!: Scene;               // 後で髪メッシュを再構築できるよう保持
  private head!: Mesh;                 // 肌の球（髪/目がこれを親にする）
  private headMat!: StandardMaterial;  // 肌色（選手が変わると再着色）
  private hairMat!: StandardMaterial;  // 髪色（選手が変わると再着色）
  private hair: Mesh | null = null;    // 髪のクラウン — 後傾させて前と後頭部で差をつける
  private hairTilt = 0;                // 後傾の大きさ（numberSideで反転）
  private hairBun: Mesh | null = null; // 後頭部のマンバンの結び（numberSideで反転）
  private hairBack: Mesh | null = null;// ロング/ボブの後ろ髪パネル（numberSideで反転）
  private hairDreads: TransformNode | null = null; // ドレッドの房（クラスタ全体がnumberSideで反転）
  private headband: Mesh | null = null;// チームカラーのバンド（スタイル4）

  decisionT = 0;                 // 次のAI判断までのクールダウン
  driveTarget = new Vector3();   // ハンドラーが向かっている先

  // オフボールの動作状態
  cutting = false;               // 現在バスケットへカット中
  offTimer = 0;                  // 次のオフボール判断までのクールダウン
  spotIdx: number;               // この選手が現在担うフォーメーションの位置
  readonly offTarget = new Vector3(); // 現在のオフボール移動目標

  // 1対1の攻防状態
  driveSide = 1;   // オフェンス: ハンドラーがどちらへ攻めているか (-1左, +1右)
  shadeSide = 1;   // 守備: オンボール守備者がどちらへシェードしているか
  reactT = 0;      // 守備: シェードが追いつくまでの反応の遅れ
  looseReactT = 0; // ルーズボール: この選手が追いかけ始めるまでの反応の遅れ（反応でスケール）
  matchupHoldT = 0; // コーチング: マッチアップ交代後この時間ベンチに留める（即座には戻さない）
  beatenT = 0;     // オフェンス: (スピードによる)抜き去りバーストの残り時間
  powerT = 0;      // オフェンス: 相手を押し込むパワードライブの残り時間
  stalledT = 0;    // オフェンス: ハンドラーが壁にされて(封じられて)引き戻される時間
  jukeT = 0;       // オフェンス: ドリブルムーブ（ステップイン/サイドステップ/ステップバック）実行中
  readonly jukeTarget = new Vector3(); // jukeTが減っている間のフットワーク目標
  comboN = 0;      // オフェンス: 現在の揺さぶりコンボで既に仕掛けたシェイクの数
  lastFakeDir = 0; // オフェンス: 直前のフェイクが見せたサイド。コンボが交互になるように
  lean = 0;        // 守備: 横方向の重心 (-1..1, 0=スクエア)
  // leanが指すワールド空間の横軸（単位XZ）。実際のリーン方向は
  // (leanAxisX, leanAxisZ) * lean。leanを変更する箇所で設定する。
  leanAxisX = 0;
  leanAxisZ = 0;

  // パスやシュート後の回復クールダウン — これが経過するまで選手は根が生えた
  // 状態（動き出せない）で、リリースのフォロースルーを表現する
  coolT = 0;
  // 着地の回復 — ジャンプから降りてきた後、次のジャンプやスプリントへ爆発する
  // 前に重心が落ち着く必要がある（完全に根が生えるわけではない: すり足はできるが
  // 再ジャンプや全速の踏み出しはできない）
  landT = 0;
  landDur = 0;   // 着地硬直の全長。accelSpeedがこれをかけて移動スロットルを
                         // 徐々に戻せるようにする（長い回復でも平坦なほぼ静止では
                         // ない — 動き出せるが再ジャンプはできない）
  plantDur = 0;  // 同上、クロスオーバー/停止のプラント用（動き直し）
  // ルーズボールを手で床からすくい上げる（ホップなし）: ボールは足首の高さから
  // このウィンドウをかけて保持位置へ上がり、手はそれを下→上に追う
  pickupT = 0;
  pickupDur = 0;

  // オンボール守備のスタンス。ヒステリシスで保持し、ハンドラーの速度が閾値付近で
  // ぶれても毎フレームポーズが切り替わらないようにする（その切り替わりが
  // 「手を小刻みに動かす」ように見えた）。true=腕を大きく広げてサイドドライブを壁で防ぐ、
  // false=前の手を下げてストレートドライブを止める/ボールをはたく。
  stanceWide = false;

  // 硬直: こぼしかけたキャッチをまだ収めている最中。これが動いている間ボールは
  // 手の中で揺れ（まだ確保していない）、密着した守備者がはたき出せる。
  // 長さは配球がどれだけ逸れたかと本人の技術（ハンドリング）でスケールする。
  gatherT = 0;
  gatherDur = 0;   // ギャザーの全長。キャッチが収まるにつれてボールを段階的に
                   // シールド（遠い腰へ振る）できるようにする — 収める前に
                   // 手が届いた守備者がはたき出す。
  // キャッチをどう扱うか。キャッチの瞬間に決めて姿勢を確定させる:
  // "shield"=プレッシャー下、遠い腰へしまう。"shoot"=キャッチ&シュート、
  // ポケットへ上げる。"drive"=オープン、次の動き（リム）へ運び出す。
  catchIntent: "shield" | "shoot" | "drive" = "drive";
  // 通路ブロック: 攻撃側がこの守備者の脇をサイドステップで抜いた直後 — 一拍の間
  // (wallX, wallZ)、新しいレーンの入口へスライドして再び壁で塞ぐ。steerAroundが
  // 設定する。スライド自体はaccelToward経由で走るので、素早さ
  // (turnFactor / 動き直しのプラント)がステップ勝負の勝者を決める。
  wallT = 0;
  wallX = 0;
  wallZ = 0;
  // 特殊能力 — ロースターdef由来のAbilityKeyフラグの集合
  abilities: Set<AbilityKey>;
  // ダイレクトプレイ: パスを受けた後のワンタッチプレー用ウィンドウ（秒）
  quickT = 0;
  // ピック&ロール: このスクリナーが守備の空けたスペースへロールした（ヘッジ/
  // スイッチでマークが後ろに残った） — 供給する価値のあるポケットパスのウィンドウ
  openRollT = 0;
  // お膳立て: 良いパスからリズムよく受けた — 次のシュートが `setupBonus` を得る
  // キャッチ&シュートのウィンドウ（優れたパサーは限られたスコアラーにも決めやすい
  // 形を作り出す。速いパスほどウィンドウが長く開く）。
  setupT = 0;
  setupBonus = 0;

  // ドリブルの持ち位置: ライブドリブルがハンドラーに対してどこにあるか（ワールド
  // XZオフセット）。ゲームは速い前方キャリーと守られた横キャリーの間を、D精度が
  // 決める速さで補間する。baitTは意図的に「見せたボール」のウィンドウで、
  // ハンドラーが仕留める準備のあるリーチインを誘う。
  carryX = 0;
  carryZ = 0;
  baitT = 0;
  // ドリブルのカデンツ位相（ハンドラー毎）: D精度が高いハンドラーほど速く進む。
  // 下手なハンドラーはゆっくり突くのでボールが手から離れている時間が長くなる
  // （はたかれる隙になり、次の動作はボールが手に戻ってからしか始められない）。
  dribblePhase = 0;

  // ファウルリアクション — デッドボールの一時停止中に再生される、純粋に見た目
  // だけの短い演出: "hurt"は接触を演じ（腕が跳ね上がり体が後ろへのけぞる）、
  // "and1"はラインへ向かう前の力み（拳を上げてホップ）
  foulReactT = 0;
  foulReactDur = 0;
  foulReactKind: "hurt" | "and1" = "hurt";
  flinchPitch = 0;   // ひるみ中の追加のrootピッチ、sync()で加算
  flinchRoll = 0;    // ひるみ中の追加のrootロール（方向性のあるファウル傾き）
  // 守備成功の演出 — 守備プレーに勝った直後に再生される、純粋に見た目だけの
  // 短い喜び/主張。良いストップが画面上でちゃんと伝わるように:
  // "block"（勝ち誇って拳を上げてホップ）、"steal"（低い両拳のガッツポーズ）、
  // "stop"（踏ん張った — 腕を広げ前へ踏ん張る）。tickCooldownで減算され、
  // runArms/poseFoulReactionの後にposeDefWin()でポーズ付けする。
  defWinT = 0;
  defWinDur = 0;
  defWinKind: "block" | "steal" | "stop" = "block";
  // 接触が彼を弾いた方向（ワールド単位XZ; 0,0=情報なし→後ろへのけぞる）、
  // その強さ(0..1)、そしてバランスを崩してよろけたかどうか
  foulPushX = 0;
  foulPushZ = 0;
  foulStrength = 0;
  foulStumble = false;
  foulStaggerX = 0;
  foulStaggerZ = 0;

  // --- コンディション（スタミナ/加速） ---
  // 前フレームで実際に達した速度(m/s)、変位から計測。加速モデルはこれを基に
  // 積み上げるので、静止からの発進はトップスピードまで立ち上がる。
  curSpd = 0;
  fatigue = 0;     // 0（元気）.. 1（バテ） — 速度と精度を削る
  prevX = 0;       // フレーム開始時の位置、curSpd計測用
  prevZ = 0;
  velX = 0;        // 計測した速度(m/s) — 動く受け手をリードするのに使う
  velZ = 0;
  prevVelX = 0;    // 前フレームの速度、急な方向転換の検出用
  prevVelZ = 0;
  // 動き直し: 急な方向転換後のプラント&再プッシュ。全速で切り返すことはできない
  // — 新しい方向へ踏み出す前に足を踏み直す必要があり、これが動いている間は
  // 加速がスロットルされる（accelSpeed参照）。素早い(敏捷性)選手はすぐ立て直す。
  // 遅い選手は実際に一拍失い、速く動いていた(ダッシュ)ほどプラントが大きくなる。
  // tickMotionで設定。
  plantT = 0;
  gaugeDrawn = 0;   // ネームタグのゲージに最後に描いた疲労値
  gaugeRev = -1;    // タグを最後に描いたときのHUD_OPTS.rev（トグル時に再描画を強制）

  // ルーズボールに触れた後の短いロックアウト。1回のタップが同じフレーム区間で
  // 何十回もの接触を再発火させないように
  touchCool = 0;

  // 直前に手放したばかり: ボールを手放してから数秒間この選手はパス先として
  // 低優先になり、ボールがすぐ彼に跳ね返らないようにする（ショットクロックを
  // 浪費するだけの2人のピンポン）。本当にリムへカットすれば（本物のギブ&ゴー）
  // 解除される。tickCooldownで減算。
  justPassedT = 0;

  // トラップ記憶: この選手が最後に本物のダブルチーム（2人以上の守備者が寄った）
  // の中にいてからの秒数。>0の間はボールを彼へ振り戻さない/戻さない — トラップが
  // まだ生きている（あるいは直前まで生きていて、瞬間的な2.0m判定ではボール到着時に
  // 再び寄り集まるトラップを見逃しうる）。これがオフェンスが脱出したばかりの
  // トラップへA→B→Aで戻すのを実際に止める。トラップ中は判断毎に更新、tickCooldownで減算。
  trappedT = 0;

  // キープドリブルのシールド: 下手なハンドラー（低D精度）がマークされて前進できず
  // — 半身になってボールをシールドする。>0の間はドリブルがじりじりと進み、
  // 体をボールと守備者の間に入れる。keepDribbleDecideが設定、tickCooldownで減算。
  keepShieldT = 0;

  // ボールスクリーン（ピック）の状態 — ハンドラーを解放するためスクリーンをセット/保持
  screening = false;
  screenT = 0;      // ポップアウトする前にピックを確立・保持する残り時間
  screenSide = 1;   // スクリーンがハンドラーをどちらへ解放するか (-1/+1)

  // 垂直ジャンプのアニメ（シュート、ダンク、レイアップ、コンテスト、リバウンド）
  jumpRemaining = 0;
  jumpDur = 0;
  jumpHeight = 0;
  // 斜めの跳躍: ジャンプ全体に分散させた水平移動(メートル)。コンテスト/ブロックが
  // 正面にないシュートへ横方向へ踏み込めるようにする — 高さと引き換えにリーチを得る。
  // 通常の垂直ジャンプでは0。updateJumpで適用。
  leapX = 0;
  leapZ = 0;

  // 多関節の脚: 各サイドに股関節ピボット（腿）+膝ピボット（脛+足）。
  // プレー中は歩行/走行サイクルで振れ、ベンチでは着席ポーズに折り畳む。
  // updateLegs()が駆動、sit()/stand()がポーズ付け。
  seated = false;
  hipL!: TransformNode;
  hipR!: TransformNode;
  kneeL!: TransformNode;
  kneeR!: TransformNode;
  private footL!: Mesh;
  private footR!: Mesh;
  stridePhase = 0;   // 移動距離とともに累積 → 脚の振り
  acornWaddle = 0;   // 平滑化したペンギンの体ロール(rad)、sync()でrootロールに加算

  constructor(scene: Scene, team: number, idx: number, def: PlayerDef) {
    this.scene = scene;
    this.team = team;
    this.idx = idx;
    this.slot = Math.min(idx, 4);   // スターターは自分のスロットを持つ。ベンチはチェックイン時に付与
    this.spotIdx = this.slot;
    this.name = def.name;
    this.attr = def.attr;
    this.height = def.height;
    this.runSpeed = 3.2 + rate(def.attr.speed) * 4.8; // ~3.2（遅い）.. 8.0（速い）

    // オフェンスのアイデンティティ: ロールのベースラインを能力値（または明示的な優先度）で微調整
    this.role = def.role;
    this.abilities = new Set(def.abilities ?? []);
    this.offPriority = computeOffPriority(def);
    this.playmaking = roleOffense(def.role).playmaking;
    this.evalRole = def.evalRole;
    this.offAction = offActionOf(def.evalRole);
    this.defRole = def.defRole;
    this.choiceRank = def.choiceRank;

    this.root = new TransformNode(`p_${team}_${idx}`, scene);

    // ツイストする上半身 — 腰より上のすべてがここを親にする
    const torsoNode = new TransformNode(`torsoTwist_${team}_${idx}`, scene);
    torsoNode.parent = this.root;
    this.torsoNode = torsoNode;

    // 人型専用の胴パーツすべてのキャリア。ボディスタイルが切り替わるとき矩形の胴
    // 全体を一体で有効/無効にできる
    const humanNode = new TransformNode(`human_${team}_${idx}`, scene);
    humanNode.parent = torsoNode;
    this.humanNode = humanNode;

    // ユニフォーム: このチームのアクティブなキット（ホーム/アウェイ）由来の
    // 独立して着色される4つのキットパーツ（top/bottom/sleeve/shoes）。キット切替時に
    // applyUniform()がライブに再着色できるようPlayerに保持する。
    const u = uniformOf(team);
    const mkMat = (tag: string, rgb: RGB): StandardMaterial => {
      const m = new StandardMaterial(`${tag}_${team}_${idx}`, scene);
      m.diffuseColor = new Color3(rgb.r, rgb.g, rgb.b);
      m.specularColor = new Color3(0.1, 0.1, 0.1);
      m.backFaceCulling = false;
      return m;
    };
    const topMat = mkMat("topmat", u.top);        // 上半身（胸）
    const bottomMat = mkMat("botmat", u.bottom);  // 下半身（ショーツ/腰）
    const sleeveMat = mkMat("slvmat", u.sleeve);  // そで + 上腕
    this.topMat = topMat; this.bottomMat = bottomMat; this.sleeveMat = sleeveMat;
    // レガシーエイリアス: TOPキットのマテリアルが、付随パーツ（ヘッドバンド等）で
    // 旧来の単一ユニフォーム色の代わりを務める
    const bodyMat = topMat;
    // 胴 = 2つの角丸長方形プリズム（小さな角のフィレットRを持つ矩形断面を垂直に
    // 押し出したもの）。Core Babylonには角丸ボックスがないので、角丸長方形の
    // リングを手で構築し、側面は下と上のリングの間の閉じたリボンにする。
    // 上半身は腰よりわずかに大きい。
    const rrRing = (a: number, b: number, r: number, y: number): Vector3[] => {
      const pts: Vector3[] = [];
      const corner = (cx: number, cz: number, a0: number) => {
        for (let i = 0; i <= 4; i++) {
          const t = a0 + (Math.PI / 2) * (i / 4);
          pts.push(new Vector3(cx + Math.cos(t) * r, y, cz + Math.sin(t) * r));
        }
      };
      corner(a - r, -(b - r), -Math.PI / 2);   // 右下 → 右辺
      corner(a - r, b - r, 0);                 // 右上 → 上辺
      corner(-(a - r), b - r, Math.PI / 2);    // 左上 → 左辺
      corner(-(a - r), -(b - r), Math.PI);     // 左下 → 下辺
      return pts;
    };
    // 平らなキャップ（中心からリングへの三角形ファン）が端を閉じる
    const makeCap = (name: string, ring: Vector3[], y: number, mat: StandardMaterial = bodyMat): void => {
      const positions: number[] = [0, y, 0];
      for (const p of ring) positions.push(p.x, p.y, p.z);
      const indices: number[] = [];
      const n = ring.length;
      for (let i = 0; i < n; i++) indices.push(0, i + 1, ((i + 1) % n) + 1);
      const normals: number[] = [];
      VertexData.ComputeNormals(positions, indices, normals);
      const vd = new VertexData();
      vd.positions = positions; vd.indices = indices; vd.normals = normals;
      const cap = new Mesh(name, scene);
      vd.applyToMesh(cap);
      cap.material = mat;
      cap.parent = humanNode;
    };
    const roundedBox = (name: string, a: number, b: number, r: number, y0: number, y1: number,
                        mat: StandardMaterial = bodyMat): Mesh => {
      const bot = rrRing(a, b, r, y0), top = rrRing(a, b, r, y1);
      const m = MeshBuilder.CreateRibbon(name, {
        pathArray: [bot, top], closePath: true, sideOrientation: Mesh.DOUBLESIDE,
      }, scene);
      m.material = mat;
      m.parent = humanNode;
      makeCap(`${name}_top`, top, y1, mat);   // 上下を閉じて胴が中空にならないようにする
      makeCap(`${name}_bot`, bot, y0, mat);
      return m;
    };
    // 腰/骨盤（下半身 = bottomキット）とわずかに大きい胸（上半身 = topキット）
    const lowerBody = roundedBox(`lower_${team}_${idx}`, 0.21, 0.15, 0.06, 0.79, 1.21, bottomMat);
    // topは頭より下（頭の底 ≈ 1.61）に保ち、頭が埋もれないようにする
    const upperBody = roundedBox(`upper_${team}_${idx}`, 0.25, 0.18, 0.07, 1.15, 1.58, topMat);
    // 背番号が乗る平らな背中（上半身の奥行き）
    const backZ = 0.18;

    // 「どんぐり」の姿 — 代替スタイルとして保持し、HUDメニューから切り替える。
    // 3つのパーツで、接合部はすべて平ら（切断面に丸みなし — 輪切りにした
    // どんぐりのように）: 旧カプセルのr0.3のシルエットをそのまま保つ長い胸
    // （腰の切断面で平らな底、半球の肩）、その下のより細い腰（平らな上面、
    // 床のすぐ上に垂れる半球の底）、そしてペンギンの足 — つま先だけが前に覗く。
    // Core Babylonには片端が平らなカプセルがないので、各パーツはプロファイルの
    // 旋盤（lathe）で作る。
    const acornNode = new TransformNode(`acorn_${team}_${idx}`, scene);
    acornNode.parent = torsoNode;   // 胸+腰はツイストする。足はrootに留まる
    this.acornNode = acornNode;
    const AR = 0.3, ACUT = Player.ACORN_CUT, ARC = 8; // 胸の半径 / 腰-胸の切断面の高さ
    const WR = Player.ACORN_WAIST_R, WTIP = 0.22; // 腰の半径 / 腰の底の先端高さ
    // 腰は切断面のピボットに乗るので、着席時に90°前方（膝の上）へ折り畳める
    // — そのプロファイルは切断面基準（ACUTでy=0）で構築する
    const waistPivot = new TransformNode(`acornWaist_${team}_${idx}`, scene);
    waistPivot.parent = acornNode;
    waistPivot.position.y = ACUT;
    this.acornWaistPivot = waistPivot;
    // 腰は最上部で広がって胸と面一（WTOP ≈ 胸の半径AR）で接するので、より広い胸が
    // より狭い腰にもう張り出さない — その接合部の張り出した縁が、上半身側の
    // 大きな「R」だった。小さなフィレット(RF)が上の外縁をほんの少し和らげる。
    // 円柱形: 丸い先端もフィレットRもない真っ直ぐなシリンダー。切断面(y=0)から
    // 先端高さまで、平らな上下キャップ、一定半径WR。
    const WBOT = (WTIP - ACUT) * 0.66;            // 腰の底のy — 腰を少し長く(上端はカット面のまま)。下げるほど脚は短くなる
    // 注意: 下のscaling.y=-1反転の後、プロファイルのy=WBOT端が上（胸の下）へ、
    // y=0端が見える底へ対応する。y=WBOTのキャップ（胸の下に隠れる）は保持するが、
    // y=0端は開ける（軸点を落とす）ので、本物の溝を持つカスタムの底キャップが
    // そこの平らな円盤を置き換えられる。
    const lowerShape: Vector3[] = [
      new Vector3(0, WBOT, 0),                    // 軸 → 隠れた端（胸の下）を閉じる
      new Vector3(WR, WBOT, 0),                   // その端の縁
      new Vector3(WR, 0, 0),                      // 開いた端（見える底 — 軸点なし）
    ];
    const upperShape: Vector3[] = [
      new Vector3(0, ACUT, 0),                   // 軸から外へ出る平らな切断面
      new Vector3(AR, ACUT, 0),                  // 肩までまっすぐな側面
    ];
    for (let i = 0; i <= ARC; i++) {   // 上の半球: 軸の先端まで全半径 (1.675)
      const t = (i / ARC) * Math.PI / 2;
      upperShape.push(new Vector3(Math.cos(t) * AR, 1.375 + Math.sin(t) * AR, 0));
    }
    const makeAcornPiece = (name: string, shape: Vector3[], mat: StandardMaterial): Mesh => {
      const m = MeshBuilder.CreateLathe(name, {
        shape, tessellation: 12, sideOrientation: Mesh.DOUBLESIDE,
      }, scene);
      m.material = mat;
      m.parent = acornNode;
      return m;
    };
    const acornLower = makeAcornPiece(`acornLower_${team}_${idx}`, lowerShape, bottomMat);  // 下半身
    acornLower.parent = waistPivot;              // 着席ピボットとともに折り畳む
    // 上下反転: 同じ位置に保ったまま腰を上下反転する（広がりが今度は底に、
    // 丸い先端が上に）。DOUBLESIDEの旋盤なので、反転した巻き方向でも両面が描画される。
    acornLower.scaling.y = -1;
    acornLower.position.y = WBOT;
    // ズボン化: 底面に彫り込んだ本物の溝。旋盤の平らな底の円盤は（上で）除去した。
    // このカスタムキャップがそれを本物の溝で置き換える — 中心(x≈0)を体の内側へ
    // 押し上げ、前↔後(Z)の中心線に沿って最も深く、縁で面一へフェードする。だから
    // 下から見上げると窪んだ溝へ入っていく: ショーツを2本の脚に分ける切れ込み。
    // キャップは腰の半径にクリップしたz方向スライスのグリッド（滑らかな円形の縁）。
    // waistPivotに乗るのでショーツとともにツイスト&折り畳む。Xに対称。
    const grooveMat = new StandardMaterial(`groovemat_${team}_${idx}`, scene);
    grooveMat.diffuseColor = bottomMat.diffuseColor.clone();   // ショーツの色
    grooveMat.specularColor = new Color3(0.05, 0.05, 0.05);
    grooveMat.backFaceCulling = false;                         // 溝の壁がどの角度からも見える
    const GD = 0.09, GHW = 0.05;      // 溝の深さ（体の内側へ）/ 半幅
    const NZ = 24, NX = 12;
    const gpos: number[] = [];
    for (let iz = 0; iz <= NZ; iz++) {
      const z = -WR + (2 * WR) * (iz / NZ);
      const xmax = Math.sqrt(Math.max(0, WR * WR - z * z));    // このzでの円のクリップ
      for (let ix = 0; ix <= NX; ix++) {
        const x = xmax === 0 ? 0 : -xmax + (2 * xmax) * (ix / NX);
        const r = Math.hypot(x, z);
        const valley = Math.max(0, 1 - Math.abs(x) / GHW);     // 0を中心としたX方向のV字
        const edge = clamp((WR - r) / 0.06, 0, 1);             // 縁で面一へフェード
        gpos.push(x, WBOT + GD * valley * edge, z);            // 中心を持ち上げる = 窪み
      }
    }
    const gidx: number[] = [];
    const gRow = NX + 1;
    for (let iz = 0; iz < NZ; iz++) {
      for (let ix = 0; ix < NX; ix++) {
        const a = iz * gRow + ix, b = a + 1, c = a + gRow, d = c + 1;
        gidx.push(a, c, b, b, c, d);
      }
    }
    const gnorm: number[] = [];
    VertexData.ComputeNormals(gpos, gidx, gnorm);
    const gvd = new VertexData();
    gvd.positions = gpos; gvd.indices = gidx; gvd.normals = gnorm;
    const grooveCap = new Mesh(`acornWaistBottom_${team}_${idx}`, scene);
    gvd.applyToMesh(grooveCap);
    grooveCap.material = grooveMat;
    grooveCap.parent = waistPivot;
    const acornUpper = makeAcornPiece(`acornUpper_${team}_${idx}`, upperShape, topMat);     // 上半身

    const head = MeshBuilder.CreateSphere(`head_${team}_${idx}`, { diameter: 0.34, segments: 10 }, scene);
    head.position.y = 1.78;
    this.head = head;
    // 肌/髪のトーンはHUDの顔アイコンと一致する（共有のplayerLook、NAMEをシードに
    // するので見た目は選手のアイデンティティに紐づき、ロースターのスロットには紐づかない）。
    // 髪のメッシュはbuildHairMeshesが（再）構築する。ロースター入替でこのスロットの
    // 占有者が変わると、applyLook()が両方を再実行する。
    const look = playerLook(this.name);
    const headMat = new StandardMaterial(`hmat_${team}_${idx}`, scene);
    headMat.diffuseColor = new Color3(look.skin.r, look.skin.g, look.skin.b);
    headMat.specularColor = new Color3(0.05, 0.05, 0.05);
    head.material = headMat;
    // 頭は胸のツイストの上にヨーを重ねるキャリアに乗るので、胸が別方向を向いた
    // ままボール/マークを見るために回れる（lookToward参照）
    const headNode = new TransformNode(`headYaw_${team}_${idx}`, scene);
    headNode.parent = torsoNode;
    this.headNode = headNode;
    head.parent = headNode;
    this.headMat = headMat;

    const hairMat = new StandardMaterial(`hair_${team}_${idx}`, scene);
    hairMat.diffuseColor = new Color3(look.hair.r, look.hair.g, look.hair.b);
    hairMat.specularColor = new Color3(0.04, 0.04, 0.04);
    this.hairMat = hairMat;
    this.buildHairMeshes(look.style);
    // 目 — 頭の前面にある2つの小さな暗い球。前面 = ローカル -numberSide·Z
    // （腕/足と同じ規約）。ハーフタイムでチームがエンドを入れ替えると
    // setNumberSideがZを向け直す。
    const eyeMat = new StandardMaterial(`eye_${team}_${idx}`, scene);
    eyeMat.diffuseColor = new Color3(0.14, 0.1, 0.08);
    eyeMat.specularColor = new Color3(0, 0, 0);
    const mkEye = (sx: number): Mesh => {
      const e = MeshBuilder.CreateSphere(`eye_${team}_${idx}_${sx}`, { diameter: 0.05, segments: 6 }, scene);
      e.material = eyeMat;
      e.parent = head;
      e.position.set(sx, -0.005, -0.15);   // 前の半球（numberSideの既定は+1）
      return e;
    };
    this.eyeL = mkEye(-0.062);
    this.eyeR = mkEye(0.062);

    // どんぐりのペンギンの足、シューズ型: 長く低いつま先ボックス + 丸いつま先の
    // キャップ + 腰の底の下に収まる高めの足首シャフト。つま先がローカル -Z
    // （numberSide = +1 のとき胸側）を指すように作る。シューズは前後非対称なので、
    // ハーフタイムにsetNumberSideがz位置だけでなくヨーも反転する。
    const shoeMat = new StandardMaterial(`shoemat_${team}_${idx}`, scene);
    shoeMat.diffuseColor = new Color3(u.shoes.r, u.shoes.g, u.shoes.b);   // シューズ（キットの色）
    shoeMat.specularColor = new Color3(0.08, 0.08, 0.08);
    shoeMat.backFaceCulling = false;   // 手作りのくさびは巻き方向に関係なく表示される
    this.shoeMat = shoeMat;
    // 各シューズは1つのメッシュなので、一体成形されたパーツに見える（かつては
    // 4つのプリミティブで接合部がすべて見えていた）: 側面図の輪郭 —
    // ソール → 四分楕円のつま先カーブ → まっすぐな甲の対角 → 平らな
    // 履き口の上端 → ソールへ向かってわずかに広がるかかとの背面 — をシューズの
    // 全幅にわたってスイープし、両側面を三角形ファンで閉じる（輪郭は凸）。
    const makeAcornFoot = (sx: number, tag: string): TransformNode => {
      const node = new TransformNode(`acornFoot_${tag}_${team}_${idx}`, scene);
      node.parent = this.root;   // 足はツイストする胴ではなく脚に属する
      node.position.set(sx, 0, 0.07);            // z/ヨーはnumberSideごとに向け直す
      const hw = 0.22 / 2;                            // 半幅 — さらに横広に
      const capZ = -0.20, capR = 0.08, capH = 0.13;   // つま先カーブ: 開始/膨らみ/高さ
      const topY = 0.25, slopeZ = -0.08;              // 履き口の上端 / 甲の端
      const heelTopZ = 0.11, heelBotZ = 0.18;         // かかとの背面: 下外へ広がって長めのかかとになる
      const TSEG = 6;
      const prof: [number, number][] = [[heelBotZ, 0]]; // (z,y)の閉じた輪郭、かかと下端から
      for (let i = 0; i <= TSEG; i++) {   // つま先: ソール先端から四分楕円を上へ乗り越える
        const t = (1 - i / TSEG) * Math.PI / 2;
        prof.push([capZ - capR * Math.sin(t), capH * Math.cos(t)]);
      }
      prof.push([slopeZ, topY]);          // 甲の対角を履き口まで上げる
      prof.push([heelTopZ, topY]);        // 平らな履き口の上端。ループは広がったかかとを下って閉じる
      const N = prof.length;
      const spos: number[] = [];
      for (const [z, y] of prof) spos.push(-hw, y, z, hw, y, z);  // ペア 2i / 2i+1
      const sidx: number[] = [];
      for (let i = 0; i < N; i++) {       // スイープした輪郭面（ソール&かかと背面を含む）
        const j = (i + 1) % N;
        const a = 2 * i, b = a + 1, c = 2 * j, d = c + 1;
        sidx.push(a, c, b, b, c, d);
      }
      for (let i = 1; i < N - 1; i++) {   // 平らな側面キャップ、かかと下端の角からファン状に
        sidx.push(0, 2 * i, 2 * (i + 1));
        sidx.push(1, 2 * (i + 1) + 1, 2 * i + 1);
      }
      const snorm: number[] = [];
      VertexData.ComputeNormals(spos, sidx, snorm);
      const svd = new VertexData();
      svd.positions = spos; svd.indices = sidx; svd.normals = snorm;
      const shoe = new Mesh(`acornShoe_${tag}_${team}_${idx}`, scene);
      svd.applyToMesh(shoe);
      shoe.material = shoeMat;
      shoe.parent = node;
      return node;
    };
    this.acornFootL = makeAcornFoot(-0.12, "L");
    this.acornFootR = makeAcornFoot(0.12, "R");

    // 脚: （半分にした）腰の底とシューズの履き口の隙間を素肌のシリンダーで埋める
    // — 色は顔/手と一致（headMat）、前腕より太い（腕⌀0.10 → 脚⌀0.20）。root（シューズ
    // ではない）に固定: 垂直を保つので上面が腰の下から傾き出ることがない。
    // syncAcornLegs()が各脚を、その足の持ち上げ/スタンスちょうどの分だけ上下（とz）へ
    // スライドさせるので、足がパタパタしても上端は腰に収まり底はシューズに収まる
    // — 両端が繋がっている。どんぐりモデルと連動して切り替わる。
    const makeAcornLeg = (sx: number, tag: string): TransformNode => {
      const node = new TransformNode(`acornLeg_${tag}_${team}_${idx}`, scene);
      node.parent = this.root;                     // 足と同様に固定（ツイストなし、傾きなし）
      node.position.set(sx, 0, 0);
      const legTop = ACUT + WBOT;                  // 腰の底 (~0.47)
      const legBot = 0.16;                          // シューズの履き口の中まで下げる
      const h = legTop - legBot + 0.08;             // 腰とシューズの両方に重なる
      const leg = MeshBuilder.CreateCylinder(`acornShin_${tag}_${team}_${idx}`,
        { height: h, diameter: 0.20, tessellation: 12 }, scene);
      leg.parent = node;
      leg.material = headMat;                        // 肌色 (顔・手と同じ)
      leg.position.y = (legTop + legBot) / 2;
      return node;
    };
    this.acornLegL = makeAcornLeg(-0.12, "L");
    this.acornLegR = makeAcornLeg(0.12, "R");

    // 背番号、ユニフォームの背面にプリント。デカールが数字をカプセルへ投影するので、
    // 平らな面に浮くのではなく体の曲面に沿う。ボディはヨーしないので「背面」とは
    // 単に攻めているバスケットから遠い側 — 各Zサイドごとに1つのデカールを焼き込み、
    // setNumberSide()が正しい方を表示する（ハーフタイムで反転）。
    const numTex = new DynamicTexture(`numtex_${team}_${idx}`, { width: 128, height: 128 }, scene, false);
    numTex.hasAlpha = true;
    const ctx = numTex.getContext() as unknown as CanvasRenderingContext2D;
    ctx.clearRect(0, 0, 128, 128);
    ctx.fillStyle = "white";
    ctx.font = "bold 84px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(idx + 1), 64, 68);
    numTex.update();
    const numMat = new StandardMaterial(`nummat_${team}_${idx}`, scene);
    numMat.diffuseTexture = numTex;
    numMat.opacityTexture = numTex;
    numMat.emissiveColor = new Color3(1, 1, 1);
    numMat.disableLighting = true;
    numMat.backFaceCulling = false;
    // 番号はカプセル面のすぐ外側で胴に沿う薄い曲面シェル（リボン）が担うので、
    // 数字はユニフォームのプリントのように体の曲面に沿う。頂点はここで明示的に
    // 計算する — 投影/UVの内部実装に依存しない。アークのスイープ方向はサイド
    // ごとに選び、そのサイドに立つ視点から数字が左から右へ読めるようにする
    // （既定の左手系カメラ: +Zに沿って見ると+Xが画面右、-Zに沿って見ると-X）。
    const makeNumberShell = (sign: number, tag: string, R: number,
      yTop: number, yBot: number, span: number): Mesh => {
      const SEG = 12;
      const top: Vector3[] = [];
      const bot: Vector3[] = [];
      for (let i = 0; i <= SEG; i++) {
        const a = (i / SEG - 0.5) * span * (sign > 0 ? -1 : 1);
        const x = Math.sin(a) * R;
        const z = Math.cos(a) * R * sign;
        top.push(new Vector3(x, yTop, z));
        bot.push(new Vector3(x, yBot, z));
      }
      // [bot, top]でテクスチャのvが正しく上向きになる（画面上で確認済み）
      const shell = MeshBuilder.CreateRibbon(`numshell_${tag}_${sign}_${team}_${idx}`, {
        pathArray: [bot, top], sideOrientation: Mesh.DOUBLESIDE,
      }, scene);
      shell.material = numMat;
      shell.parent = torsoNode;   // 番号は（ツイストする）ユニフォームにプリントされる
      shell.isVisible = false;            // Gameが各ハーフで背中側を選ぶ
      return shell;
    };
    // 人型: 平らな矩形の背中のすぐ外側（~60°の緩やかな巻き、上背部）
    this.numHumanPlus = makeNumberShell(1, "h", backZ + 0.012, 1.52, 1.08, Math.PI * 0.34);
    this.numHumanMinus = makeNumberShell(-1, "h", backZ + 0.012, 1.52, 1.08, Math.PI * 0.34);
    // どんぐり: 0.3のカプセル半径のすぐ外側（~100°の巻き、従来通り）
    this.numAcornPlus = makeNumberShell(1, "a", 0.315, 1.42, 0.88, Math.PI * 0.55);
    this.numAcornMinus = makeNumberShell(-1, "a", 0.315, 1.42, 0.88, Math.PI * 0.55);

    // 常にカメラを向く浮遊ネームタグ。個性が読み取れるように。
    const namePlane = MeshBuilder.CreatePlane(`name_${team}_${idx}`, { width: 1.7, height: 0.42 }, scene);
    this.namePlane = namePlane;
    namePlane.position.y = 2.35;
    namePlane.billboardMode = Mesh.BILLBOARDMODE_ALL;
    const nameTex = new DynamicTexture(`nametex_${team}_${idx}`, { width: 256, height: 64 }, scene, false);
    nameTex.hasAlpha = true;
    this.nameTex = nameTex;
    this.drawNameTag();              // 現在の名前を描画
    const nameMat = new StandardMaterial(`namemat_${team}_${idx}`, scene);
    nameMat.diffuseTexture = nameTex;
    nameMat.opacityTexture = nameTex;
    nameMat.emissiveColor = new Color3(1, 1, 1);
    nameMat.disableLighting = true;
    nameMat.backFaceCulling = false;
    namePlane.material = nameMat;
    namePlane.parent = this.root;

    // --- 腕: 上腕（ユニフォームのそで）→ 肘 → 前腕（肌）→ 手。肩のピボットが
    // 腕全体をボールへ向ける（リーチ）。肘は静止時/走行中は曲がり、手のひらを
    // ボールに当てるために伸びる。全長 = UP + FORE で、旧ARM_LENと一致するので
    // リーチの計算は変わらない。 ---
    const UP = 0.25, FORE = 0.25;
    const makeArm = (sx: number, tag: string): { pivot: TransformNode; elbow: TransformNode } => {
      const pivot = new TransformNode(`arm_${tag}_${team}_${idx}`, scene);
      pivot.parent = torsoNode;   // 肩はツイストする胸に乗る
      pivot.position.set(sx, 1.45, 0.06);          // 肩
      // 肩のデルトイド1/4球: slice0.5(上半分)×arc0.5(経度半分)のクォーター。
      // 平らな切断面の一方（赤道面）が上腕の断面に重なり、もう一方（垂直面）が
      // 胴体側を向く=胴と上腕の角を丸いフィレットで埋めるイメージ。膨らみは
      // 外側(±X)を向くよう左右で回転を反転。ピボット子なので腕の向きに追従し、
      // 上腕の平行断面を常に覆う。
      const delt = MeshBuilder.CreateSphere(`delt_${tag}_${team}_${idx}`,
        { diameter: 0.155, segments: 8, slice: 0.5, arc: 0.5 }, scene);
      delt.parent = pivot;
      // 1/4楕円球: 長さは**上腕断面(半径0.0675)にぴったり被さる程度**。
      // 切断面は内側へ0.068、膨らみ軸(ローカルZ=arc占有軸)は1.8倍 →
      // 到達 -0.068+0.0775×1.8 ≈ +0.072。全長≈0.14で断面±0.0675を数mmだけ超える。
      delt.position.set(sx > 0 ? -0.068 : 0.068, -0.005, 0);
      delt.scaling.z = 1.8;
      // 実測(NullEngine): arc0.5 の占有域は z≤0。RotationY(-π/2)で -Z→+X なので
      // 右腕(sx>0)は -π/2 で膨らみが外側(+X)・切断面が胴体側(内側)を向く。
      delt.rotation.y = sx > 0 ? -Math.PI / 2 : Math.PI / 2;   // 膨らみを外側へ

      delt.material = sleeveMat;   // そで: 肩のキャップをそでの色で
      // 上腕は肩側が太く肘側へ細くなるテーパー: デルトイド球から途切れなく
      // 「斜めに」流れる輪郭になる（旧: 平行断面の等径円柱）。
      const upper = MeshBuilder.CreateCylinder(`upper_${tag}_${team}_${idx}`,
        { height: UP, diameterTop: 0.135, diameterBottom: 0.105, tessellation: 10 }, scene);
      upper.parent = pivot;
      upper.position.set(0, -UP / 2, 0);           // 上腕、ユニフォームのそで
      upper.material = sleeveMat;                   // そで+上腕: そでの色
      const elbow = new TransformNode(`elbow_${tag}_${team}_${idx}`, scene);
      elbow.parent = pivot;
      elbow.position.set(0, -UP, 0);               // 上腕の端の肘
      const fore = MeshBuilder.CreateCylinder(`fore_${tag}_${team}_${idx}`,
        { height: FORE, diameter: 0.1, tessellation: 8 }, scene);
      fore.parent = elbow;
      fore.position.set(0, -FORE / 2, 0);          // 前腕、素肌
      fore.material = headMat;
      const hand = MeshBuilder.CreateSphere(`hand_${tag}_${team}_${idx}`,
        { diameter: 0.16, segments: 8 }, scene);
      hand.parent = elbow;
      hand.position.set(0, -FORE, 0);              // 前腕の端の手のひら
      hand.material = headMat;
      return { pivot, elbow };
    };
    const armL = makeArm(-0.28, "L");   // 肩をより細い胴の方へ引き寄せる
    const armR = makeArm(0.28, "R");
    this.armPivotL = armL.pivot; this.elbowL = armL.elbow;
    this.armPivotR = armR.pivot; this.elbowR = armR.elbow;
    this.handsRest();

    // --- 多関節の脚: 股関節ピボット（腿、ユニフォームのショーツ）+膝ピボット
    // （脛、肌+足）。静止時、脚は股関節のy≈0.9から床までまっすぐ垂れる。
    // updateLegs()が歩行サイクルのために股関節を振り（膝を曲げ）、sit()が折り畳む。 ---
    const HIP_Y = 0.92, THIGH = 0.46, SHIN = 0.44;
    const makeLeg = (sx: number, tag: string): { hip: TransformNode; knee: TransformNode; foot: Mesh } => {
      const hip = new TransformNode(`hip_${tag}_${team}_${idx}`, scene);
      hip.parent = this.root;
      hip.position.set(sx, HIP_Y, 0);
      const thigh = MeshBuilder.CreateCylinder(`thigh_${tag}_${team}_${idx}`,
        { height: THIGH, diameter: 0.21, tessellation: 8 }, scene);
      thigh.parent = hip;
      thigh.position.set(0, -THIGH / 2, 0);      // 股関節から下へ垂れる
      thigh.material = bottomMat;                  // 下半身: bottomキットの色のショーツ
      const knee = new TransformNode(`knee_${tag}_${team}_${idx}`, scene);
      knee.parent = hip;
      knee.position.set(0, -THIGH, 0);            // 腿の下端の膝
      const shin = MeshBuilder.CreateCylinder(`shin_${tag}_${team}_${idx}`,
        { height: SHIN, diameter: 0.16, tessellation: 8 }, scene);
      shin.parent = knee;
      shin.position.set(0, -SHIN / 2, 0);         // 膝から下へ垂れる（肌）
      shin.material = headMat;
      const foot = MeshBuilder.CreateBox(`foot_${tag}_${team}_${idx}`,
        { width: 0.16, height: 0.1, depth: 0.28 }, scene);
      foot.parent = knee;
      foot.position.set(0, -SHIN, 0.06);          // つま先のオフセットはsetNumberSide内でnumberSideごとに設定
      foot.material = headMat;
      return { hip, knee, foot };
    };
    const legL = makeLeg(-0.13, "L");
    const legR = makeLeg(0.13, "R");
    this.hipL = legL.hip; this.kneeL = legL.knee; this.footL = legL.foot;
    this.hipR = legR.hip; this.kneeR = legR.knee; this.footR = legR.foot;

    // 姿全体を選手の身長に合わせて垂直方向にスケール（基準体格 ≈ 1.95 m）
    this.root.scaling.y = def.height / 1.95;

    this.meshes = [upperBody, lowerBody, head, acornUpper, acornLower];
    this.refreshBodyDepth();   // ボディバランスに応じて胴を前後に細くする
    this.applyModel();   // 現在選択中のボディスタイルを表示
  }

  readonly meshes: Mesh[];

  /** `height` メートルの、`dur` 秒続くジャンプを開始する。任意の (leapX,leapZ) は
   *  飛行全体に分散する水平の踏み込み — 正面にないシュートへの斜めのジャンプ
   *  （高さは低いが、ブロックするために横へ届く）。 */

  // （既に生成済みの）頭に髪型の髪メッシュを構築する。コンストラクタから切り出して
  // あるので、ロースター入替でこのスロットに別の選手が来たときapplyLook()が再構築
  // できる。0=短髪 1=丸刈り 2=アフロ 3=フラットトップ 4=ヘッドバンド
  // 5=ボブ 6=前髪上げ 7=モヒカン 8=マンバン 9=センター分け 10=ロング(肩まで)
  // 11=くせ毛長髪(太めの房) 12=ドレッド(細く多く長い房)。
  private buildHairMeshes(style: number): void {
    const { head, hairMat, team } = this;
    // slice = ドームがどこまで下りてくるか（顔ではなく側面/後ろを覆う）。
    // tilt = 後傾で、後頭部を覆ったまま前が目の上へ乗り上がる（numberSideで反転
    // するので前 = -numberSide·Z）。
    // slice ≲0.6 + 適度なtiltでクラウンを顔から外す（ヘルメット感なし）。
    // 長さは後頭部を垂れる別の `back` パネル（下記）が担い、大きなsliceでは担わない
    // — 大きなドームは後ろと同じくらい顔も覆ってしまう。
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
      // 後ろ髪: 後頭部を垂れる扁平な楕円体（後ろ = +numberSide·Z なので、ハーフタイムに
      // setNumberSideでzが反転する）。頭の後ろかつ下に位置するので顔に届かない
      // — 前を覆わずに長さを出す。
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
      const bandMat = new StandardMaterial(`bandmat_${team}_${this.idx}`, this.scene);
      const tc = TEAM_COLORS[team];
      bandMat.diffuseColor = new Color3(tc.r, tc.g, tc.b);
      bandMat.specularColor = new Color3(0.05, 0.05, 0.05);
      band.material = bandMat;
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
  }

  // このスロットを今占有する選手のために、手続き的な見た目（肌/髪の色+髪型メッシュ）
  // 全体を再適用する。ロースター入替（applyDef）で呼ばれ、NAMEをキーにした見た目が
  // 構築時のまま留まらず実際に選手に追随するようにする。
  private applyLook(): void {
    const look = playerLook(this.name);
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
  }

  /** 指定のZサイド(+1 / -1)に背番号を表示する — 選手の背中側、すなわち
   *  攻めるバスケットから遠い側。ハーフタイムで反転する。
   *  肩はわずかに前寄りなので、（反対側の）胸側に追随する — さもないと-Zを攻める
   *  チームが前後逆に見え、腕が背中に付いているように見える。 */
  setNumberSide(sign: number): void {
    this.sideApplied = true;
    this.numberSide = sign >= 0 ? 1 : -1;
    const human = HUD_OPTS.model === "human";
    this.numHumanPlus.isVisible = human && sign > 0;
    this.numHumanMinus.isVisible = human && sign < 0;
    this.numAcornPlus.isVisible = !human && sign > 0;
    this.numAcornMinus.isVisible = !human && sign < 0;
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
  }

  /** モデル切替（人型 ⇄ どんぐりカプセル）: 選択中のボディだけを表示し、腕の
   *  肩幅・背番号シェル・着席姿勢をそのモード用に組み直す。いつ呼んでも安全
   *  （腕/頭/名前タグは両モード共用）。 */
  applyModel(): void {
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
  }

  // 胸が腰からどこまでツイストできるか（どちらの向きも）。実際の胴は足を回さねば
  // ならなくなる前に~60-70°までいける。
  static readonly TWIST_MAX = 1.15;

  /** 上半身をツイストして、root（脚、足）が自身の向きを保ったまま胸がワールド点を
   *  向くようにする — 走りながら受ける、並走しながらドライブへ追随する。TWIST_MAXに
   *  クランプし平滑化する。rootの向き付近を狙う（またはスクエアに立つ）と
   *  ゼロへ巻き戻る。 */

  // 頭が胸を越えてどこまで回れるか（胴のツイストの上に）。
  static readonly HEAD_MAX = 0.95;   // ~54°

  /** 胸のツイストの上に重ねて、頭を回してワールド点を見る — 片方向へ動く/向いた
   *  選手でもボール（やマーク）を見続けられる。胸を越えてHEAD_MAXにクランプし
   *  平滑化する。胸が既に向いている方を見るとゼロへ巻き戻る。 */

  /** 胸を今すぐ(x,z)へ向ける（イージングなし） — 両手パスは胸を的へ正対させて
   *  投げる。胴はそこへツイストする。足は胴が賄えない分だけ回る（|twist|は
   *  TWIST_MAXで上限）ので、上半身が受け手に定まる間、足は遅れうる
   *  （「足はズレていても」）。 */

  /** 胸が現在向いている方向とワールド点への方向の間の符号付き角度(rad)。
   *  0=的が胸の真正面。±π/2=真横。±π/2を越える=上半身の後ろ（そこへのパスは
   *  彼が向き直す必要がある）。 */

  /** 胸を即座に腰の上へスクエアに戻す（ベンチ着席、リセット）。 */

  /** 姿全体をヨーさせて、胸（番号の反対側）がワールド点を向くようにする —
   *  ベンチの選手が目でボールを追う。コート上のボディはヨーしない（すべての
   *  ゲーム計算がそれを前提とする）ので、これはベンチ専用。 */

  // --- ベンチのアイドル: 各自の個性で試合を眺める ---
  benchGazeOff = 0;                       // 個人的な視線のオフセット(rad)
  benchGazeT = 0;                         // 次の向け直しまでの時間
  benchActT = 1 + Math.random() * 5;      // 次のそわそわまでの時間
  benchArmT = 0;                          // 現在の腕のジェスチャーの残り時間

  /**
   * ベンチに座ってボールを眺める1フレーム: 視線は数秒ごとに漂う個人的な
   * オフセットとともにボールを追い、数秒ごとに小さなランダムなそわそわが発火する
   * — 小さなホップ、片手を半分上げる、腕を広げる。自身のジャンプ減算とメッシュ
   * 同期を処理する（ベンチの選手はコート上の毎フレーム更新を受けない）。
   */

  /** コート上のボディをワールド点へ向ける。このフレームで最大 `maxStep` ラジアン
   *  までイージングするので、選手はプレー（ボール、または攻めるバスケット）を
   *  カクつかずに追う。faceTowardと同じ胸の向き規約を使う。腕のリグ(aimArm)は
   *  結果として生じるヨーを織り込む。 */

  /** ヨーをクリアする（試合開始/ベンチの視線）。ボディは次の向き更新で再び
   *  スクエアになる。 */

  /** うなだれ: 腰と脚は直立のまま — 上半身だけが前へかがみ（胴のピッチ）、腕は
   *  だらりと垂れる。とぼとぼとベンチへ戻る間もこの姿勢を保つ（脚は下で歩き続ける）。
   *  毎フレーム呼んで保持する。resetTwist()/sit()/resetFacing()が体をまっすぐに戻す。 */

  /** ファウルリアクションを開始する。`pushX/pushZ` は接触が彼を弾いたワールド方向
   *  （0,0=不明 → 単純に後ろへのけぞる）。`strength` (0..1) がのけぞりの強さ、
   *  継続時間、よろけになる確率をスケールする。 */

  /** ファウルリアクションのポーズの1フレーム。runArmsの後に呼ぶ（動いている間は
   *  腕を占有する）。減算はtickCooldownで行う。 */

  /** 守備成功の演出を開始する（純粋に見た目のみ）。ファウルリアクションが既に
   *  動いている場合は無視する（ブロックからのファウルは接触の演出を保つ）。 */

  /** 守備成功のポーズの1フレーム。runArms/poseFoulReactionの後に呼ぶ（動いている間は
   *  腕+ひるみの傾きを占有する）。減算はtickCooldownで行う。呼び出し側は、選手が
   *  アクティブなボールの仕事（ハンドリング、シュート、まだ空中、ルーズボールへの
   *  スクランブル）を持つ間はこれを抑止する。 */

  /** パス/シュートのフォロースルー中は true — 動き出してはいけない。 */
  get rooted(): boolean {
    return this.coolT > 0;
  }

  /** 選手が床を離れている（ジャンプ中）間は true。 */
  get airborne(): boolean {
    return this.jumpRemaining > 0;
  }

  jumpY(): number {
    if (this.jumpDur <= 0 || this.jumpRemaining <= 0) return 0;
    const k = 1 - this.jumpRemaining / this.jumpDur; // ジャンプ全体で0..1
    return Math.sin(k * Math.PI) * this.jumpHeight;  // 上がってから下がる
  }

  tiltX = 0;  // 平滑化した見た目の体の傾き(rad)、sync()で適用
  tiltZ = 0;

  // 脚のジオメトリ/ポーズの定数。
  private static readonly HIP_Y = 0.92;      // 股関節ピボットの高さ（makeLegと一致）
  private static readonly SEAT_HIP = 0.46;   // 着席時、腰はベンチ座面に置く
  static readonly SIT_HIP = 1.45;    // 腿が~水平（前方）まで振り上がる
  static readonly SIT_KNEE = -1.55;  // 脛が床へ折れ戻る
  // どんぐりの着席: 腰が腰-胸の切断面で90°前方へ折れ（膝の上に見える）、
  // シューズがその下に収まって床に立つ
  static readonly ACORN_CUT = 0.72;     // 腰-胸の切断面の高さ（着席のヒンジ）
  private static readonly ACORN_WAIST_R = 0.25; // 腰の半径（コンストラクタのWR）
  static readonly SEAT_SURF = 0.42;     // 折り畳んだ腰が置かれるベンチ座面
  static readonly SIT_FOLD = 1.15;      // 着席時の腰の折り（~66°、きつい90°より緩やか）
  static readonly ACORN_WAIST_LEN = 0.50; // ピボット→腰先端の長さ（旋盤プロファイルから）
  static readonly ACORN_FOOT_Z = 0.02;  // 立ちスタンス: 足は後ろ寄りに配置
  private static readonly ACORN_SPLAY = 0.30;   // 立ちスタンス: つま先を外へ開く（各~17°）

  /** 選手の身長に対する垂直スケール。 */
  private refreshScale(): void {
    this.root.scaling.y = this.height / 1.95;
  }

  /** ボディバランス(フィジカル)が胴の前後の厚み（Zの奥行き）を決める: 安定して
   *  強い99はフルの体格を保つ。65以下は3分の2（一般的な最小）まで細くなり、
   *  その間は線形。胸、腰、それらの背番号シェルはすべて一緒に圧縮されるので、
   *  番号は（今や浅くなった）背中に留まる。頭、腕、脚は奥行きを保つ。純粋に見た目のみ。 */
  private refreshBodyDepth(): void {
    const t = clamp((this.attr.balance - 65) / (99 - 65), 0, 1);
    const z = 2 / 3 + t * (1 / 3);   // 0.667（≤65）.. 1.0（99）
    this.acornNode.scaling.z = z;
    this.humanNode.scaling.z = z;
    this.numAcornPlus.scaling.z = z;
    this.numAcornMinus.scaling.z = z;
    this.numHumanPlus.scaling.z = z;
    this.numHumanMinus.scaling.z = z;
  }

  // どんぐりのボディを着席ポーズに折り畳む: 腰が胸側へ水平まで振り上がり（前 =
  // -numberSide·Z なので、rotation.x = +90°·ns が下向きの腰を -ns·Z へ対応させる）、
  // シューズは膝の下で前へ動き床へ戻る（rootは着席中sync()が落とす）。
  // rootより下の、折り畳んだ腰の最下点（座面に置かれる部分）。
  // 折り角度から導出するのでSIT_FOLDが変わっても正しいまま。90°の折りで
  // 旧来の (ACORN_CUT - ACORN_WAIST_R)=0.47 になる。
  static acornSeatDrop(): number {
    const f = Player.SIT_FOLD;
    return Player.ACORN_CUT - Player.ACORN_WAIST_R * (Math.cos(f) + Math.sin(f));
  }

  sync(): void {
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
    // 見える体の傾き: 姿全体を確定した重心へ傾ける。ワールドの傾きベクトル →
    // コードベースで検証済みの規約（RotationY(θ)がローカル+Zを(sinθ,0,cosθ)へ
    // 対応させる — faceToward参照）を使ってヨーローカルフレームへ変換し、rootを
    // ピッチ/ロールする。平滑化するので揺さぶりがカクつきでなく重心移動に見える。
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
  }

  /** （編集されたかもしれない）ロースターdefから名前/身長/ロール/優先度/派生値を
   *  読み直す。`attr` はライブ参照なので、能力値の編集は既に反映されている。 */
  applyDef(def: PlayerDef): void {
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
      if (!Player.HEADLESS) { this.drawNameTag(); this.applyLook(); }   // 見た目のみ — ヘッドレスではスキップ
    }
    if (def.height !== this.height) {
      this.height = def.height;
      this.refreshScale();   // 姿を新しい身長へ再スケール（着席の潰しを保つ）
    }
    this.refreshBodyDepth();   // 交代で入った選手のボディバランスが胴の奥行きを決める
  }

  // 浮遊ネームタグとその下のスタミナゲージを描画する。背番号は名前の横ではなく
  // 選手の背中（デカール）にある。
  // ゲージはタンクの残り(1 - fatigue)を示す: 元気なら緑、息が上がると
  // アンバー、バテると赤。
  drawNameTag(): void {
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
  }

  /** チームの現在アクティブなユニフォーム（ホーム/アウェイ）からこの選手のキットを
   *  再着色する。TEAM_UNIFORM変更後に呼ばれ、スワップがライブに表示される。 */
  applyUniform(): void {
    const u = uniformOf(this.team);
    this.topMat.diffuseColor = new Color3(u.top.r, u.top.g, u.top.b);
    this.bottomMat.diffuseColor = new Color3(u.bottom.r, u.bottom.g, u.bottom.b);
    this.sleeveMat.diffuseColor = new Color3(u.sleeve.r, u.sleeve.g, u.sleeve.b);
    this.shoeMat.diffuseColor = new Color3(u.shoes.r, u.shoes.g, u.shoes.b);
  }

  /** HUDオプションに関わらず浮遊ネームタグを隠す/表示する — 試合前のイントロは
   *  タグを自身のキャプションボードに置き換える。`true` で復元しても、ユーザーの
   *  HUD_OPTS.showNames設定は尊重する。 */
  setNameTagVisible(v: boolean): void {
    this.namePlane.isVisible = v && HUD_OPTS.showNames;
  }

  /** 両腕を脇に垂らし、肘を少し曲げる（既定ポーズ）。 */

  // ボールをハンドリングしていない選手の腕。前へ走るとストライドに合わせて前後に
  // 振る（同じ側の脚と逆位相、肘は曲げたまま） — どんぐりのボディも振るが、
  // 半分ほどの振り幅（ずんぐりしたペンギンの腕）。バックペダル（胸の向きに逆らって
  // 動く — 後退する守備者）ではバランスポーズに切り替わる: 両腕を低く少し前へ出し、
  // 足に合わせてはためく。歩行/静止では休める。poseHands()が全員にこれを呼び、
  // その後でボールの腕を上書きする。
  backArms = false;   // ヒステリシスで閾値付近でスタイルがちらつかないように
  lastDt = 1 / 60;    // 最後のフレーム長、レート制限された腕のスルー用
  // > 0 の間、setArmDirは腕を即座にではなくこのrad/sで目標へ回す — 弱い守備者は
  // 手をゆっくり向け直すので、切り替えが遅れる。
  armRateCap = 0;

  /** 右手（または両手）を伸ばして手のひらが `world` — ボール — に合うようにする。
   *  肘が伸びて手のひらが狙った点に実際に届く。 */

  /** ディグ(掻き出し): 片手で伸ばし、上半身をボールへ回転させて先行する肩が横切り、
   *  手がボールへ大きく伸びる。反対の腕はバランスのため後ろへ振れる。守備者が
   *  はたき出したルーズボールを突くのに使う — 両手でつかむのではなく、
   *  思い切った踏み込み。 */

  /** 両手のホールド: 手のひらがボールを両側から包む — ボールの両側に片手ずつ、
   *  ボール1個分の幅を空けて — 両腕が同じ点を狙う（手のひらがボール越しに触れる）
   *  のではなく。キャッチとギャザーに使い、ボールが手の間に収まり腕とともに
   *  動くようにする。 */

  /** ボールがある側と同じ側の手でドリブル/保持する — 左腰へ運んだボールは右腕を
   *  体を横切って（越えて）伸ばすのではなく左手で持つ、そしてその逆も。 */

  /** 両腕を大きく広げる — 左右のドライブを壁で防ぐアクティブな手。`rate` (rad/s)が
   *  切り替えをレート制限する。0は即座に切り替える（ベンチ/非守備用途）。 */

  /** ストレートドライブを止める: ボールに近い手が前かつ低く出て侵入を壁で防ぎ
   *  ボールを突く（スティール）、逆の手はスライド中のバランスのため低く外へ構える。
   *  `rate` が向け直しをレート制限する。 */

  /** パスをディナイする: 片手を斜めに突き出す — ボール側へ外へ、上へ、バスケットへ
   *  向けて後ろへ角度をつける — レーンを壁で塞ぎ、パスが彼の後ろへ滑り込めない
   *  ようにする。胸を横切る横方向のスイングは許容する（それでよい）。 */

  /** 垂直の（ジャンプしない）シュートコンテスト: 両手を垂直にし、床を離れずに
   *  挑む（空中のコンテストは代わりにボールへ手を伸ばす）。 */

}
