import { Scene, Vector3, Quaternion, MeshBuilder, StandardMaterial, Color3, Mesh, TransformNode, DynamicTexture, VertexData, } from "@babylonjs/core";
import { TEAM_COLORS, HUD_OPTS, uniformOf, type RGB } from "../../config";
import { Attributes, AbilityKey, PlayerDef } from "../../attributes";
import { roleOffense, computeOffPriority, ROLE_BEHAVIOR, DEF_ROLE_BEHAVIOR, OffAction, offActionOf } from "../../roles";
import { rate, clamp } from "../../util";
import { playerLook, type PlayerLook } from "./player-look";
import { makeMat } from "../materials";
import type { Stats } from "./stats";

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
  // ルーズボールを手で床からすくい上げる: ボールが保持位置へ上がり、手が下→上に追う
  pickupT = 0;
  pickupDur = 0;
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
  // "stop"（腕を広げ前へ踏ん張る）。tickCooldownで減算、poseDefWin()でポーズ付け。
  defWinT = 0;
  defWinDur = 0;
  defWinKind: "block" | "steal" | "stop" = "block";

  // ═════════ 3Dメッシュ・ノード（実体） ═════════
  static readonly UPPER_ARM = 0.25;   // 上腕長（肩→肘）
  static readonly FOREARM = 0.25;     // 前腕長（肘→手）
  readonly root: TransformNode;
  // ボールを保持/ドリブル/パス/シュートするために手を伸ばす短い腕
  readonly armPivotL: TransformNode;
  readonly armPivotR: TransformNode;
  elbowL!: TransformNode;   // 上腕 ↔ 前腕の関節（静止時は曲げ、伸ばして届かせる）
  elbowR!: TransformNode;
  // 上半身のキャリア: 胴・頭・腕・背番号がこれに乗り、プレー方向へTWISTする
  // (twistToward)。root（脚/足）は進行方向を向く。
  torsoNode!: TransformNode;
  torsoTwist = 0;   // 平滑化したツイスト(rad)、±TWIST_MAXにクランプ
  headNode!: TransformNode;   // 頭のキャリア — 胴のツイストの上にヨーを重ねる
  headYaw = 0;      // 胴に対する平滑化した頭の回転(rad)、±HEAD_MAX
  // 両方のボディスタイルは生成時から存在する。applyModel()が一方を表示し他方を
  // 隠すので、HUDメニューからスタイルをライブに切り替えられる。
  humanNode!: TransformNode;   // 矩形の胴（リボン+キャップ）
  acornNode!: TransformNode;   // どんぐりの姿（胸+腰+シューズの足）
  acornWaistPivot!: TransformNode; // 腰はこれに乗る。腰-胸の切断面の位置 —
                                       // 着席時は90°前方へ折り畳む（膝の上）
  acornFootL!: TransformNode;  // シューズ型の足 — 非対称なので、位置もヨーも
  acornFootR!: TransformNode;  // numberSideと共に反転する
  acornLegL!: TransformNode;   // 腰→シューズを繋ぐ素肌の脚シリンダー
  acornLegR!: TransformNode;   // （どんぐりモデル専用。rootに固定）
  eyeL!: Mesh;                  // 顔の目 — 前面に配置 (-numberSide·Z)
  eyeR!: Mesh;
  scene!: Scene;               // 後で髪メッシュを再構築できるよう保持
  head!: Mesh;                 // 肌の球（髪/目がこれを親にする）
  // 多関節の脚: 各サイドに股関節ピボット（腿）+膝ピボット（脛+足）。
  // プレー中は歩行/走行サイクルで振れ、ベンチでは着席ポーズに折り畳む。
  // updateLegs()が駆動、sit()/stand()がポーズ付け。
  seated = false;
  hipL!: TransformNode;
  hipR!: TransformNode;
  kneeL!: TransformNode;
  kneeR!: TransformNode;
  footL!: Mesh;
  footR!: Mesh;
  stridePhase = 0;   // 移動距離とともに累積 → 脚の振り
  acornWaddle = 0;   // 平滑化したペンギンの体ロール(rad)、sync()でrootロールに加算

  // ═════════ 見た目マテリアル・背番号・ネームタグ・髪 ═════════
  // 名前が変わると再描画される浮遊ネームタグ
  nameTex!: DynamicTexture;
  namePlane!: Mesh;   // 浮遊ネームタグ。HUD_OPTS.showNamesがオフのとき非表示
  // ユニフォームキットのマテリアル — キット切替時にapplyUniform()でライブに再着色
  topMat!: StandardMaterial;
  bottomMat!: StandardMaterial;
  sleeveMat!: StandardMaterial;
  shoeMat!: StandardMaterial;
  // 背番号のデカール。Zの各サイド・各ボディスタイルごとに1つ。表示されるのは
  // 現在表示中のボディにおける選手の背中側
  numHumanPlus!: Mesh;
  numHumanMinus!: Mesh;
  numAcornPlus!: Mesh;
  numAcornMinus!: Mesh;
  numberSide = 1;   // 現在どちらのローカルZサイドに番号を表示しているか
  sideApplied = false; // Gameがまだ背中側を選んでいない — シェルは非表示のまま
  headMat!: StandardMaterial;  // 肌色（選手が変わると再着色）
  hairMat!: StandardMaterial;  // 髪色（選手が変わると再着色）
  hair: Mesh | null = null;    // 髪のクラウン — 後傾させて前と後頭部で差をつける
  hairTilt = 0;                // 後傾の大きさ（numberSideで反転）
  hairBun: Mesh | null = null; // 後頭部のマンバンの結び（numberSideで反転）
  hairBack: Mesh | null = null;// ロング/ボブの後ろ髪パネル（numberSideで反転）
  hairDreads: TransformNode | null = null; // ドレッドの房（クラスタ全体がnumberSideで反転）
  headband: Mesh | null = null;// チームカラーのバンド（スタイル4）
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
    const mkMat = (tag: string, rgb: RGB): StandardMaterial =>
      makeMat(scene, `${tag}_${team}_${idx}`, {
        diffuse: new Color3(rgb.r, rgb.g, rgb.b), spec: new Color3(0.1, 0.1, 0.1), cull: false,
      });
    const topMat = mkMat("topmat", u.top);        // 上半身（胸）
    const bottomMat = mkMat("botmat", u.bottom);  // 下半身（ショーツ/腰）
    const sleeveMat = mkMat("slvmat", u.sleeve);  // そで + 上腕
    this.topMat = topMat; this.bottomMat = bottomMat; this.sleeveMat = sleeveMat;
    // 付随パーツ（ヘッドバンド等）はTOPキットのマテリアルを流用する
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
    // 3つのパーツ、接合部はすべて平ら（輪切りのどんぐり）: 長い胸（平らな底、半球の肩）、
    // より細い腰（平らな上面、半球の底）、ペンギンの足。Babylonに片端が平らなカプセルが
    // ないので各パーツはプロファイルの旋盤（lathe）で作る。
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
    // 腰は円柱形: 丸い先端もフィレットもない真っ直ぐなシリンダー。切断面(y=0)から
    // 先端高さまで、平らな上下キャップ、一定半径WR。
    const WBOT = (WTIP - ACUT) * 0.66;            // 腰の底のy（上端はカット面のまま）
    // scaling.y=-1反転の後、プロファイルのy=WBOT端が上（胸の下）へ、y=0端が見える底へ
    // 対応する。y=WBOTのキャップは保持し、y=0端は開ける（軸点を落とす）ので、カスタムの
    // 底キャップが平らな円盤を溝で置き換えられる。
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
    // ズボン化: 底面に彫り込んだ溝でショーツを2本の脚に分ける。中心(x≈0)を体の内側へ
    // 押し上げ、前↔後(Z)の中心線で最も深く、縁で面一へフェード。腰の半径にクリップした
    // z方向スライスのグリッド。waistPivotに乗るのでショーツとともにツイスト&折り畳む。Xに対称。
    const grooveMat = makeMat(scene, `groovemat_${team}_${idx}`, {
      diffuse: bottomMat.diffuseColor.clone(),   // ショーツの色
      spec: new Color3(0.05, 0.05, 0.05),
      cull: false,                               // 溝の壁がどの角度からも見える
    });
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
    // 肌/髪のトーンはHUDの顔アイコンと一致（共有のplayerLook、NAMEをシード）。髪メッシュは
    // buildHairMeshesが構築し、ロースター入替時はapplyLook()が再実行する。
    const look = this.look;
    const headMat = makeMat(scene, `hmat_${team}_${idx}`, {
      diffuse: new Color3(look.skin.r, look.skin.g, look.skin.b), spec: new Color3(0.05, 0.05, 0.05),
    });
    head.material = headMat;
    // 頭は胸のツイストの上にヨーを重ねるキャリアに乗るので、胸が別方向を向いた
    // ままボール/マークを見るために回れる（lookToward参照）
    const headNode = new TransformNode(`headYaw_${team}_${idx}`, scene);
    headNode.parent = torsoNode;
    this.headNode = headNode;
    head.parent = headNode;
    this.headMat = headMat;

    const hairMat = makeMat(scene, `hair_${team}_${idx}`, {
      diffuse: new Color3(look.hair.r, look.hair.g, look.hair.b), spec: new Color3(0.04, 0.04, 0.04),
    });
    this.hairMat = hairMat;
    this.buildHairMeshes(look.style);
    // 目 — 頭の前面にある2つの小さな暗い球。前面 = ローカル -numberSide·Z
    // （腕/足と同じ規約）。ハーフタイムでチームがエンドを入れ替えると
    // setNumberSideがZを向け直す。
    const eyeMat = makeMat(scene, `eye_${team}_${idx}`, {
      diffuse: new Color3(0.14, 0.1, 0.08), spec: new Color3(0, 0, 0),
    });
    const mkEye = (sx: number): Mesh => {
      const e = MeshBuilder.CreateSphere(`eye_${team}_${idx}_${sx}`, { diameter: 0.05, segments: 6 }, scene);
      e.material = eyeMat;
      e.parent = head;
      e.position.set(sx, -0.005, -0.15);   // 前の半球（numberSideの既定は+1）
      return e;
    };
    this.eyeL = mkEye(-0.062);
    this.eyeR = mkEye(0.062);

    // どんぐりのペンギンの足、シューズ型。つま先がローカル -Z（numberSide = +1 のとき胸側）を
    // 指すように作る。シューズは前後非対称なので、setNumberSideがz位置とヨーを反転する。
    const shoeMat = makeMat(scene, `shoemat_${team}_${idx}`, {
      diffuse: new Color3(u.shoes.r, u.shoes.g, u.shoes.b),   // シューズ（キットの色）
      spec: new Color3(0.08, 0.08, 0.08),
      cull: false,   // 手作りのくさびは巻き方向に関係なく表示される
    });
    this.shoeMat = shoeMat;
    // 各シューズは1つのメッシュ: 側面図の輪郭 — ソール → 四分楕円のつま先カーブ →
    // まっすぐな甲の対角 → 平らな履き口の上端 → 広がるかかとの背面 — を全幅にスイープし、
    // 両側面を三角形ファンで閉じる。
    const makeAcornFoot = (sx: number, tag: string): TransformNode => {
      const node = new TransformNode(`acornFoot_${tag}_${team}_${idx}`, scene);
      node.parent = this.root;   // 足はツイストする胴ではなく脚に属する
      node.position.set(sx, 0, 0.07);            // z/ヨーはnumberSideごとに向け直す
      const hw = 0.22 / 2;                            // 半幅
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

    // 脚: 腰の底とシューズの履き口の隙間を素肌のシリンダーで埋める（色はheadMat）。
    // root（シューズではない）に固定して垂直を保つ。syncAcornLegs()が足の持ち上げ/スタンスに
    // 合わせて上下（とz）へスライドさせるので、上端は腰・底はシューズに収まる。
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

    // 背番号、ユニフォームの背面にプリント。ボディはヨーしないので「背面」とは攻める
    // バスケットから遠い側 — 各Zサイドごとに1つ焼き込み、setNumberSide()が正しい方を表示する。
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
    const numMat = makeMat(scene, `nummat_${team}_${idx}`, {
      emissive: new Color3(1, 1, 1), unlit: true, cull: false,
    });
    numMat.diffuseTexture = numTex;
    numMat.opacityTexture = numTex;
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
      // [bot, top]でテクスチャのvが正しく上向きになる
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
    // どんぐり: 0.3のカプセル半径のすぐ外側（~100°の巻き）
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
    const nameMat = makeMat(scene, `namemat_${team}_${idx}`, {
      emissive: new Color3(1, 1, 1), unlit: true, cull: false,
    });
    nameMat.diffuseTexture = nameTex;
    nameMat.opacityTexture = nameTex;
    namePlane.material = nameMat;
    namePlane.parent = this.root;

    // --- 腕: 上腕（ユニフォームのそで）→ 肘 → 前腕（肌）→ 手。肩のピボットが
    // 腕全体をボールへ向ける（リーチ）。肘は静止/走行中は曲がり、手のひらをボールに
    // 当てるために伸びる。全長 = UP + FORE。 ---
    const UP = Player.UPPER_ARM, FORE = Player.FOREARM;
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
      // arc0.5 の占有域は z≤0。RotationY(-π/2)で -Z→+X なので右腕(sx>0)は -π/2 で
      // 膨らみが外側(+X)・切断面が胴体側(内側)を向く。
      delt.rotation.y = sx > 0 ? -Math.PI / 2 : Math.PI / 2;   // 膨らみを外側へ

      delt.material = sleeveMat;   // そで: 肩のキャップをそでの色で
      // 上腕は肩側が太く肘側へ細くなるテーパー。
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

  // 胸ツイスト/頭ヨーの可動域・速度は animation/basic/joints.ts の JOINT が定義。

  // --- ベンチのアイドル: 各自の個性で試合を眺める ---
  benchGazeOff = 0;                       // 個人的な視線のオフセット(rad)
  benchGazeT = 0;                         // 次の向け直しまでの時間
  benchActT = 1 + Math.random() * 5;      // 次のそわそわまでの時間
  benchArmT = 0;                          // 現在の腕のジェスチャーの残り時間

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
  static readonly HIP_Y = 0.92;      // 股関節ピボットの高さ（makeLegと一致）
  static readonly SEAT_HIP = 0.46;   // 着席時、腰はベンチ座面に置く
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
  static readonly ACORN_SPLAY = 0.30;   // 立ちスタンス: つま先を外へ開く（各~17°）

  // rootより下の、折り畳んだ腰の最下点（座面に置かれる部分）。折り角度から導出するので
  // SIT_FOLDが変わっても正しいまま。
  static acornSeatDrop(): number {
    const f = Player.SIT_FOLD;
    return Player.ACORN_CUT - Player.ACORN_WAIST_R * (Math.cos(f) + Math.sin(f));
  }

  backArms = false;   // ヒステリシスで閾値付近でスタイルがちらつかないように
  lastDt = 1 / 60;    // 最後のフレーム長、レート制限された腕のスルー用
  // > 0 の間、setArmDirは腕を即座にではなくこのrad/sで目標へ回す — 弱い守備者は
  // 手をゆっくり向け直すので、切り替えが遅れる。
  armRateCap = 0;

}
