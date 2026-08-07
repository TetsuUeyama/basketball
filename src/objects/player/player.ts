import { Scene, Vector3, Quaternion, MeshBuilder, StandardMaterial, Color3, Mesh, TransformNode, DynamicTexture, VertexData, } from "@babylonjs/core";
import { BENCH, TEAM_COLORS, HUD_OPTS, uniformOf, type RGB } from "../../config";
import { Attributes, AbilityKey, PlayerDef } from "../../attributes";
import { roleOffense, computeOffPriority, ROLE_BEHAVIOR, DEF_ROLE_BEHAVIOR, OffAction, offActionOf } from "../../roles";
import { rate, clamp } from "../../util";
import { playerLook, type PlayerLook } from "./player-look";
import { makeMat } from "../materials";
import type { Stats } from "./stats";
import type { VoxelBody } from "./player-voxel";

// 最高速度(m/s)を speed 能力値(0..100)から算出。3点(10→3.86 / 68→5.5 / 97→8.0)を通す
// 2区間の折れ線。実在選手域(68-97)を 5.5-8.0m/s に広げ、68以下は 3.86 まで緩やかに下げる。
export function runSpeedForSpeed(speed: number): number {
  return speed <= 68
    ? 3.86 + (speed - 10) * (1.64 / 58)   // 10→3.86 .. 68→5.5
    : 5.5 + (speed - 68) * (2.5 / 29);    // 68→5.5 .. 97→8.0
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
  // ヘッドレスバッチ実行時true: 髪再構築+ネームタグ再描画（見た目のみ）をスキップ。
  static HEADLESS = false;

  // ═════════ 同一性・能力・ロール（ロースターdef / applyDef 由来） ═════════
  readonly team: number;
  readonly idx: number;          // チーム内のロースター番号 (0..12)。ユニフォーム番号 = idx+1
  name: string;
  look: PlayerLook;              // 見た目(肌/髪/髪型)。defのlookを保持しHUD/頭と共有
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
  // 特殊能力 — ロースターdef由来のAbilityKeyフラグの集合
  abilities: Set<AbilityKey>;

  // ═════════ ローテーション・出場 ═════════
  slot = 0;                      // コート上のスロット 0..4（マンマッチのキー）
  stintT = 0;                    // この選手が最後にチェックインしてからのゲーム秒
  matchupHoldT = 0; // コーチング: マッチアップ交代後この時間ベンチに留める（即座には戻さない）

  // ═════════ ボックススコア ═════════
  // 現在の試合を通して累積するボックススコアの統計
  readonly stats: Stats = { pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, tov: 0, fgm: 0, fga: 0, tpm: 0, tpa: 0, ftm: 0, fta: 0, min: 0 };

  // ═════════ 位置・速度・加速・疲労（毎フレーム計測/更新） ═════════
  readonly pos = new Vector3();  // 論理位置（足元）
  // --- コンディション（スタミナ/加速） ---
  // 前フレームで実際に達した速度(m/s)、変位から計測。
  curSpd = 0;
  fatigue = 0;     // 0（元気）.. 1（バテ） — 速度と精度を削る
  prevX = 0;       // フレーム開始時の位置、curSpd計測用
  prevZ = 0;
  velX = 0;        // 計測した速度(m/s) — 動く受け手をリードするのに使う
  velZ = 0;
  prevVelX = 0;    // 前フレームの速度、急な方向転換の検出用
  prevVelZ = 0;

  // ═════════ 硬直・回復タイマー（tickCooldown/accelSpeed が消費） ═════════
  // パス/シュート後の回復クールダウン — 経過するまで動き出せない（フォロースルー）。
  coolT = 0;
  // 着地の回復 — 降りた後、再ジャンプ/全速前に重心が落ち着くまでの時間。
  landT = 0;
  landDur = 0;   // 着地硬直の全長。accelSpeedが移動スロットルを徐々に戻すのに使う
  // 動き直し: 急な方向転換後のプラント&再プッシュ。動いている間は加速がスロットル
  // される（accelSpeed）。tickMotionで設定。
  plantT = 0;
  plantDur = 0;  // 同上、クロスオーバー/停止のプラント用（動き直し）
  // 完全硬直: 着地/切り返し/ダッシュ急停止の直後、一瞬まったく動けない（accelSpeed=0）。
  // 硬直(landT/plantT)の頭側の一部。敏捷でスケール。
  rootT = 0;
  // シュートの溜め: 前傾＋沈み込みの深さ(0..1)。target を updateCharge が毎フレーム
  // 設定、それ以外は0へ戻り「一気に伸び上がる」。sync が applyShootLoad で姿勢に反映。
  shootLoad = 0;
  shootLoadTarget = 0;
  // 床のルーズボールをすくい上げる姿勢の深さ(0..1)。liveball の pickup が毎フレーム
  // 設定し、それ以外は0へ戻る（＝立ち上がる）。sync が applyScoopLoad で姿勢に反映。
  scoopLoad = 0;
  scoopLoadTarget = 0;
  // このフレームに胴の腰ヒンジ（溜め・落胆）を当てたか。当てなかったら sync が 0 へ戻す。
  hingePosed = false;
  // スローイン後の前進: 非PMビッグの投げ手はバックコートに残らず、フロントコートへ
  // 抜けてガードに組み立てを任せる。フロントコート確立(frontT)かこの秒数で解除。
  frontRunT = 0;
  // リバウンドを空中で確保した直後: 次tickでプットバック/アウトレットを即実行する合図。
  // reboundPutback=true ならリムへプットバック、false ならアウトレット/キックを試みる。
  reboundGo = false;
  reboundPutback = false;
  // ルーズボールを手で床からすくい上げる: ボールが保持位置へ上がり、手が下→上に追う
  pickupT = 0;
  pickupDur = 0;
  // 確保の起点(ワールド): ボールを瞬間移動させず、掴んだ実位置から手元へ地続きに補間するため
  // secureLoose が記録し、liveball の pickup が補間する。
  grabFromX = 0;
  grabFromY = 0;
  grabFromZ = 0;
  // 確保した手の数(true=両手)。secureLoose が記録し、収めるまでの保持ポーズと
  // そのまま出すパス(片手確保→片手パス)を確保時の形に揃える。
  grabTwoHand = true;
  // 背負いポストアップ中(バックダウン): >0 の間は背中をリムへ向けてバックペダルで押し込む。
  // postMove が powerT と同時に張り、tickCooldown で減算。壁で止まったらクリア。
  postT = 0;
  // 硬直: こぼしかけたキャッチを収めている最中。ボールは手の中で揺れ、密着守備者がはたき出せる。
  gatherT = 0;
  gatherDur = 0;   // ギャザーの全長
  // ルーズボールに触れた後の短いロックアウト（1タップが多重接触を再発火しないように）
  touchCool = 0;
  // 直前に手放したばかり: 数秒間パス先として低優先。リムへカットすれば解除。tickCooldownで減算。
  justPassedT = 0;
  // トラップ記憶: 最後にダブルチームの中にいてからの秒数。>0の間はボールを彼へ振り戻さない。
  // 判断毎に更新、tickCooldownで減算。
  trappedT = 0;
  // キープドリブルのシールド: >0の間はドリブルがじりじり進み、体をボールと守備者の間に
  // 入れる。keepDribbleDecideが設定、tickCooldownで減算。
  keepShieldT = 0;
  // ダイレクトプレイ: パスを受けた後のワンタッチプレー用ウィンドウ（秒）
  quickT = 0;
  // ピック&ロール: スクリナーが空いたスペースへロールした — ポケットパスのウィンドウ
  openRollT = 0;
  // お膳立て: 良いパスからリズムよく受けた — 次のシュートが `setupBonus` を得るウィンドウ
  setupT = 0;
  setupBonus = 0;
  baitT = 0;
  // 通路ブロック: 抜かれた直後、一拍(wallX,wallZ)へスライドして再び壁で塞ぐ。steerAroundが設定。
  wallT = 0;
  wallX = 0;
  wallZ = 0;
  decisionT = 0;                 // 次のAI判断までのクールダウン
  offTimer = 0;                  // 次のオフボール判断までのクールダウン
  reactT = 0;      // 守備: シェードが追いつくまでの反応の遅れ
  looseReactT = 0; // ルーズボール: この選手が追いかけ始めるまでの反応の遅れ（反応でスケール）
  // オフボールのマーク外し: shakeOpenT>0 で担当守備を振り切って空いている(deny が緩む/読みが鈍る)。
  shakeOpenT = 0;  // 振り切って空いている残り秒
  shakeT = 0;      // 次の振り切り試行までのクールダウン
  shakeDirX = 0;   // 振り切り時の分離方向（ワールドXZ単位）
  shakeDirZ = 0;
  shakePower = false;  // true=パワー勝負(背中で押さえる) / false=クイックネス

  // ═════════ アクションの3段階（発生=windup / 実行=active / クールダウン=cooldown） ═════════
  // 全アクション共通のライフサイクル。beginAction で発生開始→自動遷移。windup 完了フレームで
  // actFired=true（呼び出し側が効果を実行）。active 後 cooldown で再発動を抑制。tickAction が進める。
  actKind = "";
  actPhase: "" | "windup" | "active" | "cooldown" = "";
  actT = 0;            // 現段階の残り秒
  actActiveDur = 0;    // active フェーズ長（保持）
  actCoolDur = 0;      // cooldown フェーズ長（保持）
  actFired = false;    // windup→active の遷移フレームで真（呼び出し側が消費）

  // ═════════ 攻防の可変状態（1対1/オフボール/ドリブル/スクリーン） ═════════
  // オフボールの動作状態
  cutting = false;               // 現在バスケットへカット中
  spotIdx: number;               // この選手が現在担うフォーメーションの位置
  // 1対1の攻防状態
  driveSide = 1;   // オフェンス: ハンドラーがどちらへ攻めているか (-1左, +1右)
  shadeSide = 1;   // 守備: オンボール守備者がどちらへシェードしているか
  beatenT = 0;     // オフェンス: (スピードによる)抜き去りバーストの残り時間
  powerT = 0;      // オフェンス: 相手を押し込むパワードライブの残り時間
  stalledT = 0;    // オフェンス: ハンドラーが壁にされて(封じられて)引き戻される時間
  jukeT = 0;       // オフェンス: ドリブルムーブ（ステップイン/サイドステップ/ステップバック）実行中
  comboN = 0;      // オフェンス: 現在の揺さぶりコンボで既に仕掛けたシェイクの数
  lastFakeDir = 0; // オフェンス: 直前のフェイクが見せたサイド。コンボが交互になるように
  lean = 0;        // 守備: 横方向の重心 (-1..1, 0=スクエア)
  // leanが指すワールド空間の横軸（単位XZ）。実際のリーン方向は
  // (leanAxisX, leanAxisZ) * lean。leanを変更する箇所で設定する。
  leanAxisX = 0;
  leanAxisZ = 0;
  // オンボール守備のスタンス（ヒステリシスで保持）。true=腕を大きく広げサイドドライブを
  // 壁で防ぐ、false=前の手を下げストレートを止める/ボールをはたく。
  stanceWide = false;
  // キャッチをどう扱うか。キャッチの瞬間に決めて姿勢を確定させる:
  // "shield"=プレッシャー下、遠い腰へしまう。"shoot"=キャッチ&シュート、
  // ポケットへ上げる。"drive"=オープン、次の動き（リム）へ運び出す。
  catchIntent: "shield" | "shoot" | "drive" = "drive";
  // ドリブルの持ち位置: ライブドリブルのハンドラーに対するワールドXZオフセット。
  carryX = 0;
  carryZ = 0;
  // ドリブルのカデンツ位相（ハンドラー毎）。
  dribblePhase = 0;
  // 直近のドリブルでボールを扱っている腕（仮想側）。反対の腕はクリップの腕を残す。
  dribbleArm: "L" | "R" = "R";
  // ボールスクリーン（ピック）の状態 — ハンドラーを解放するためスクリーンをセット/保持
  screening = false;
  screenT = 0;      // ポップアウトする前にピックを確立・保持する残り時間
  screenSide = 1;   // スクリーンがハンドラーをどちらへ解放するか (-1/+1)

  // ═════════ 移動目標（ベクトル） ═════════
  driveTarget = new Vector3();   // ハンドラーが向かっている先
  readonly offTarget = new Vector3(); // 現在のオフボール移動目標
  readonly jukeTarget = new Vector3(); // jukeTが減っている間のフットワーク目標

  // ═════════ ジャンプ ═════════
  // 垂直ジャンプのアニメ（シュート、ダンク、レイアップ、コンテスト、リバウンド）
  jumpRemaining = 0;
  jumpDur = 0;
  jumpHeight = 0;
  // 斜めの跳躍: ジャンプ全体に分散させた水平移動(m)。通常の垂直ジャンプでは0。updateJumpで適用。
  leapX = 0;
  leapZ = 0;

  // ═════════ リアクション演出の状態（ファウル/守備成功/ひるみ） ═════════
  // ファウルリアクション — デッドボールの一時停止中に再生される、純粋に見た目
  // だけの短い演出: "hurt"は接触を演じ（腕が跳ね上がり体が後ろへのけぞる）、
  // "and1"はラインへ向かう前の力み（拳を上げてホップ）
  foulReactT = 0;
  foulReactDur = 0;
  foulReactKind: "hurt" | "and1" = "hurt";
  flinchPitch = 0;   // ひるみ中の追加のrootピッチ、sync()で加算
  flinchRoll = 0;    // ひるみ中の追加のrootロール（方向性のあるファウル傾き）
  // 接触が彼を弾いた方向（ワールド単位XZ; 0,0=情報なし→後ろへのけぞる）、
  // その強さ(0..1)、そしてバランスを崩してよろけたかどうか
  foulPushX = 0;
  foulPushZ = 0;
  foulStrength = 0;
  foulStumble = false;
  foulStaggerX = 0;
  foulStaggerZ = 0;
  // 守備成功の演出（見た目のみ）: "block"（拳を上げてホップ）、"steal"（低い両拳）、
  // "stop"（腕を広げ前へ踏ん張る）、"cheer"（両手を高く上げてバウンド）、"clap"（拍手）、
  // "highfive"（相手へ手を上げる）。tickCooldownで減算、poseDefWin()でポーズ付け。
  defWinT = 0;
  defWinDur = 0;
  defWinKind: "block" | "steal" | "stop" | "cheer" | "clap" | "highfive" = "block";
  defWinToward = new Vector3();   // highfive の相手位置（手を上げる方向）

  // ═════════ 3Dメッシュ・ノード（実体） ═════════
  static readonly UPPER_ARM = 0.25;   // 上腕長（肩→肘）
  static readonly FOREARM = 0.25;     // 前腕長（肘→手）
  // 実際に使う腕の長さ（IK）。ボクセルモデルでは素体の実測値へ差し替わる。
  upperArmLen = Player.UPPER_ARM;
  // このフレームの腕ポーズをIKで解いたか（表示側の胴逃がし補正を掛けない印）
  ikL = false;
  ikR = false;
  foreArmLen = Player.FOREARM;
  // ボクセルの見た目（objcts/player）。実体はここだけが持つ。
  vox: VoxelBody | null = null;
  scene!: Scene;
  readonly root: TransformNode;
  // ── 以下は「仮想の骨組み」。メッシュを持たず、姿勢だけを決める。
  //    毎フレーム player-voxel.ts の syncVoxelPose が標準ボーンへ転写する。
  readonly armPivotL: TransformNode;   // 肩
  readonly armPivotR: TransformNode;
  elbowL!: TransformNode;   // 上腕 ↔ 前腕の関節（静止時は曲げ、伸ばして届かせる）
  elbowR!: TransformNode;
  // 上半身のキャリア: 胴・頭・腕がこれに乗り、プレー方向へTWISTする
  // (twistToward)。root（脚/足）は進行方向を向く。
  torsoNode!: TransformNode;
  torsoTwist = 0;   // 平滑化したツイスト(rad)、±TWIST_MAXにクランプ
  headNode!: TransformNode;   // 頭のキャリア — 胴のツイストの上にヨーを重ねる
  headYaw = 0;      // 胴に対する平滑化した頭の回転(rad)、±HEAD_MAX
  headPitch = 0;    // 顔のピッチ(rad)。シュートの溜めで前傾しても顔を水平へ戻す
  // 多関節の脚: 各サイドに股関節ピボット + 膝ピボット。プレー中は歩行/走行
  // サイクルで振れ、ベンチでは着席ポーズに折り畳む。
  seated = false;
  hipL!: TransformNode;
  hipR!: TransformNode;
  kneeL!: TransformNode;
  kneeR!: TransformNode;
  stridePhase = 0;   // 移動距離とともに累積 → 脚の振り

  // ═════════ ネームタグ・背番号 ═════════
  // 名前が変わると再描画される浮遊ネームタグ
  nameTex!: DynamicTexture;
  namePlane!: Mesh;   // 浮遊ネームタグ。表示可否は updateNameTags が毎フレーム決める
  nameTagAllowed = true;   // false = 常に非表示（イントロツアー中・審判・プレビュー用の選手）
  jerseyText = "";    // 背番号に描く文字（審判は "R"）。ボクセルのデカールに焼く
  kitOverride: { top: RGB; bottom: RGB; shoes: RGB } | null = null;  // 審判など、チームキットを使わない者
  numberSide = 1;   // 現在どちらのローカルZサイドに番号を表示しているか
  sideApplied = false; // Gameがまだ背中側を選んでいない — 背番号は非表示のまま
  gaugeDrawn = 0;   // ネームタグのゲージに最後に描いた疲労値
  gaugeRev = -1;    // タグを最後に描いたときのHUD_OPTS.rev（トグル時に再描画を強制）

  constructor(scene: Scene, team: number, idx: number, def: PlayerDef) {
    this.scene = scene;
    this.team = team;
    this.idx = idx;
    this.slot = Math.min(idx, 4);   // スターターは自分のスロットを持つ。ベンチはチェックイン時に付与
    this.spotIdx = this.slot;
    this.name = def.name;
    this.look = def.look ?? playerLook(def.name);   // DB選手はdef.look、DB外ダミーは名前フォールバック
    this.attr = def.attr;
    this.height = def.height;
    this.runSpeed = runSpeedForSpeed(def.attr.speed); // 折れ線 3.86..8.0（遅い..速い）

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

    // ツイストする上半身 — 腰より上のすべてがここを親にする。
    // メッシュは持たない（見た目はボクセルが担う）。ここは姿勢を決める仮想の骨組み。
    const torsoNode = new TransformNode(`torsoTwist_${team}_${idx}`, scene);
    torsoNode.parent = this.root;
    this.torsoNode = torsoNode;

    // 頭のキャリア — 胸のツイストの上にヨーを重ねる
    const headNode = new TransformNode(`headYaw_${team}_${idx}`, scene);
    headNode.parent = torsoNode;
    this.headNode = headNode;

    // 常にカメラを向く浮遊ネームタグ。個性が読み取れるように。
    const namePlane = MeshBuilder.CreatePlane(`name_${team}_${idx}`, { width: 1.7, height: 0.42 }, scene);
    this.namePlane = namePlane;
    namePlane.position.y = 2.35;
    namePlane.billboardMode = Mesh.BILLBOARDMODE_ALL;
    const nameTex = new DynamicTexture(`nametex_${team}_${idx}`, { width: 256, height: 64 }, scene, false);
    nameTex.hasAlpha = true;
    this.nameTex = nameTex;
    this.drawNameTag();              // 現在の名前を描画
    const nameMat = makeMat(scene, `namemat_${team}_${idx}`, {
      emissive: new Color3(1, 1, 1), unlit: true, cull: false,
    });
    nameMat.diffuseTexture = nameTex;
    nameMat.opacityTexture = nameTex;
    namePlane.material = nameMat;
    namePlane.parent = this.root;

    // --- 仮想の関節。肩・肘・股・膝。位置と回転だけを持ち、メッシュは付かない。
    // ボクセルの標準ボーンへ毎フレーム転写する（player-voxel.ts の syncVoxelPose）。
    // 位置は buildVoxelBody が素体の実測値で上書きする（applyVoxelRig）。 ---
    const mkNode = (name: string, parent: TransformNode, x: number, y: number, z: number): TransformNode => {
      const n = new TransformNode(`${name}_${team}_${idx}`, scene);
      n.parent = parent;
      n.position.set(x, y, z);
      return n;
    };
    this.armPivotL = mkNode("arm_L", torsoNode, -0.12, 1.42, 0);
    this.armPivotR = mkNode("arm_R", torsoNode, 0.12, 1.42, 0);
    this.elbowL = mkNode("elbow_L", this.armPivotL, 0, -Player.UPPER_ARM, 0);
    this.elbowR = mkNode("elbow_R", this.armPivotR, 0, -Player.UPPER_ARM, 0);
    this.hipL = mkNode("hip_L", this.root, -0.10, 0.97, 0);
    this.hipR = mkNode("hip_R", this.root, 0.10, 0.97, 0);
    this.kneeL = mkNode("knee_L", this.hipL, 0, -0.43, 0);
    this.kneeR = mkNode("knee_R", this.hipR, 0, -0.43, 0);
    this.jerseyText = String(idx + 1);
    this.handsRest();

    this.ensureVoxel();   // ボクセルの見た目を組み、腕の長さ・肩の位置を実測値へ合わせる
  }

  // 胸ツイスト/頭ヨーの可動域・速度は animation/basic/joints.ts の JOINT が定義。

  // --- ベンチのアイドル: 各自の個性で試合を眺める ---
  benchGazeOff = 0;                       // 個人的な視線のオフセット(rad)
  benchGazeT = 0;                         // 次の向け直しまでの時間
  benchActT = 1 + Math.random() * 5;      // 次のそわそわまでの時間
  benchArmT = 0;                          // 現在の腕のジェスチャーの残り時間
  benchClapT = 0;                         // 拍手ジェスチャーの残り時間（>0で手を叩く）

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
  static readonly HIP_Y = 0.92;      // 股関節の高さのフォールバック（ボクセルが無いとき）
  static readonly SEAT_HIP = BENCH.seatTop + 0.06;   // 着席時の股関節Y(尻を座面の天面に置く)
  static readonly SIT_HIP = Math.PI / 2;  // 腿を水平（前方）へ畳む
  static readonly SIT_KNEE = -1.55;  // 脛が床へ折れ戻る(符号の規約。角度は foldSeatedLegs が実寸から解く)
  static readonly WAIST_HINGE = 0.72; // 前傾のヒンジ高さ（腰の切れ目。落胆・シュートの溜め）

  backArms = false;   // ヒステリシスで閾値付近でスタイルがちらつかないように
  lastDt = 1 / 60;    // 最後のフレーム長、レート制限された腕のスルー用
  // > 0 の間、setArmDirは腕を即座にではなくこのrad/sで目標へ回す — 弱い守備者は
  // 手をゆっくり向け直すので、切り替えが遅れる。
  armRateCap = 0;

}
