import { Scene, Vector3, Mesh, Color3 } from "@babylonjs/core";
import { Player } from "./objects/player/player";
import { Ball } from "./objects/ball";
import "./move/basic/run";   // Player.prototype に走る/ジャンプ/方向転換を注入
import "./move/basic/jump";
import "./move/basic/turn";
import "./objects/player/player-query";
import "./objects/player/player-state";
import "./objects/player/player-visual";
import "./objects/player/player-roster";
import "./animation/basic/arms";    // 部位の基本ムーバを注入（腕/胴・頭/脚）
import "./animation/basic/torso";
import "./animation/action/locomotion";    // アクション毎のアニメを注入
import "./animation/action/dribble";
import "./animation/action/hold";
import "./animation/action/reach";
import "./animation/action/guard";
import "./animation/action/screen";
import "./animation/action/reach-ik";
import "./animation/action/shoot";
import "./animation/action/sit";
import "./animation/reaction/bench-idle";
import "./animation/reaction/foul-react";
import "./animation/reaction/defwin";
import "./animation/reaction/dejected";
import { makeHandlerRing, type Hoops } from "./objects/court";
import {
  COURT, RIM, PASS_SPEED, SHOT_CLOCK, SHOT_CLOCK_PARTIAL, QUARTER_TIME, QUARTERS, OOB_OUTSET, teamShort, } from "./config";
import { rate, clamp, dist2D, moveToward2D, towardPoint, chance, rand } from "./util";
import { reactionLag } from "./eval";
import { FreeThrowSystem } from "./systems/freethrow";
import { TipoffSystem } from "./systems/tipoff";
import { InboundSystem, BALL_HOLD } from "./systems/inbound";
import { RefereeSystem } from "./systems/referees";
import { ScreenState } from "./move/reaction/screen";
import { updateSubs } from "./systems/subs";
import { refreshChoiceRanks } from "./ai/lineups";
import { updatePass } from "./move/action/passing";
import { updateSaveRecover } from "./move/action/save";
import { updateCharge, updateShot } from "./move/action/shooting";
import { updateLoose, stepBallFreeFlight } from "./core/looseball";
import { updateLive } from "./move/action/liveball";
import { endQuarter, updateFinale } from "./core/gameflow";
import { syncAll, updateFacing, tickSwish, tickBallFx, flashBall, updateNameTags } from "./core/visuals";
import { shotClockViolation } from "./core/deadball";
import { resolveCollisions } from "./core/collision";
import { benchSeat, seatOnBench, updateBenchCheer } from "./core/bench";
import { ROSTER, ROSTER_SIZE, STARTERS } from "./roster";
import { TACTICS, AbilityKey } from "./attributes";

export type BallMode = "held" | "charge" | "pass" | "shot" | "loose" | "inbound" | "tipoff" | "freethrow" | "pause" | "subs" | "finale";

type GameState = "live" | "final";

// 画面上の短いイベント表示（例: "3 POINTS!", "STEAL"）。
export interface GameEvent { text: string; team: number; scorer?: string; assist?: string; }

export class Game {
  readonly players: Player[] = [];   // コート上: [0..4]=チーム0の枠 / [5..9]=チーム1の枠
  readonly roster: Player[][] = [[], []]; // 13人フルロスター（先発+ベンチ）
  subsMade = 0;                      // この試合の交代回数（デバッグ/テレメトリ）
  // 直近の交代。UI がフィードとして表示（HOME→AWAY の順に流す）
  readonly subEvents: { inNum: number; inName: string; outNum: number; outName: string; team: number; ttl: number }[] = [];
  // 交代の入場/退場アニメ("subs" ボールモード): 各歩行者が目標へ向かい、全員到着でプレー再開(subNext)
  subWalkers: { p: Player; tx: number; tz: number }[] = [];
  subNext: (() => void) | null = null;
  subT = 0;
  // チーム別のベンチ歓声タイマー（正の間、ベンチが立って歓声）
  cheerT: [number, number] = [0, 0];
  cheerAmp: [number, number] = [0.5, 0.5];   // 歓声の強さ(ダンク/スリーで大きく)
  readonly ball: Ball;
  referees!: RefereeSystem;   // コート上の審判2人(演出専用)
  readonly ring: Mesh;
  readonly tactics = TACTICS; // チーム別の作戦

  // --- スコア / クロック ---
  score: [number, number] = [0, 0];
  qLine: number[][] = [[], []];   // チーム別、各終了クォーターの得点
  quarter = 1;
  gameClock = QUARTER_TIME;
  shotClock = SHOT_CLOCK;
  state: GameState = "live";
  lastEvent: GameEvent | null = null;
  private eventT = 0;

  // --- ポゼッション / ボール状態 ---
  possession = 0;
  handler: Player | null = null;
  ballMode: BallMode = "held";
  // スクリーン(ピック&ロール)の共有状態。処理は move/action/screen(攻撃) と
  // move/reaction/screen(守備カバレッジ) の関数が担う。
  readonly screen = new ScreenState();

  // ---- 現ポゼッションのチーム守備スキーム(resetMotion で決定)。
  // "" = 素のマンツーマン(pnr カバレッジが適用される)。
  zoneScheme: "" | "2-3" | "3-2" = "";
  pressOn = false;
  // このフレームのプレストラップ2人目 — ボールを狙う(ディグ姿勢)。runPress が設定、runDefense がクリア
  pressTrapper: Player | null = null;
  // 飛行中のパスの質(1=ぴったり手元)。捕球時のギャザー時間を決める。
  passQ = 1;
  // このポゼッションでボールがフロントコートに定着したら true（以降バックコート違反）
  frontT = false;
  // 速攻ウィンドウ: ライブでのポゼッション交代後の数秒間 >0（ボールがバックコートにある間）
  pushT = 0;

  // パスのアニメ
  passFrom = new Vector3();
  passCatch = new Vector3();   // ボールが飛ぶ固定のリードポイント
  passMiss = 0;                // 配球が目標から外れる距離(m)
  passMissY = 0;               // 外れパスの縦方向の散らばり
  passTo: Player | null = null;
  passT = 0;
  passDur = 0;
  // パスの種類: chest=通常 / bounce=バウンドパス / jump=ジャンプパス
  passStyle: "chest" | "bounce" | "jump" = "chest";
  // 片手で投げるパス(片手で確保したボールをそのまま放る)。ポーズが両手/片手を切り替える。
  passOneHand = false;
  // ジャンプパスのウィンドアップ: 滞空でこの時間だけ保持する
  pendingPassTo: Player | null = null;
  pendingPassT = 0;
  // 保留中のパスがターンパス(対象を射程へ入れるため体をピボット)であること。
  pendingPassTurn = false;
  // ノールック: 体を向けていない対象へ現在の構えのまま振り抜くパス。
  noLookPass = false;
  // ターンパス完了のリリース中のみ true: 弧チェックはスキップ、安全ゲートはスキップしない。
  turnReleased = false;
  passer: Player | null = null;                         // 現在のパスを放った選手
  passSteal: { def: Player; at: number } | null = null; // パス時に一度だけ決定
  // ライン外へ逸れたパスを追う選手（move/action/save.ts）。この選手だけ clampCourt を
  // 素通しし、コートの外へ出られる。復帰しきる/時間切れで null に戻る。
  saveBy: Player | null = null;
  saveT = 0;

  // シュートのアニメ
  shotFrom = new Vector3();
  shotTarget = new Vector3();   // ボールが実際に飛ぶ先 — 成功ならリム、ミスなら的を外した点
  shotMade = false;
  shotGraze = 0;   // >0: 手がシュートにかすった当たり具合(軌道のずれ幅)。aimShotTarget が消費
  shotWasDunk = false;   // 直前のフィニッシュがダンク
  shotPoints = 2;
  shotT = 0;
  shotDur = 0;
  shooter: Player | null = null; // 現在シュートを打っている選手
  shooterFinishing = false;      // レイアップ/ダンクで true(リムへ突っ込む)
  finishSpot = new Vector3();    // フィニッシャーがギャザーして跳ぶ位置
  finishVX = 0;                   // フィニッシュへ持ち込むドライブの勢い
  finishVZ = 0;
  shotApex = 2.2;   // 弧の高さ — レイアップ/ダンクは低く、ジャンパーは高い
  evadedFinish = false;   // ブロック試行をかわしたフィニッシュ(ダブルクラッチ)
  evadeDirX = 0;          // 空振りしたブロッカーから離れる水平の単位方向
  evadeDirZ = 0;
  // ロングショットのボールカメラ: 遠距離の一発が空中にある間、カメラがボールを追う
  longShot = false;     // 飛行中のシュートが遠距離である
  longShotHoldT = 0;    // 着弾までボールカメラを維持

  // ルーズボール(リバウンド)/インバウンドのタイマー
  looseT = 0;        // ルーズボールが確実に確保されるまでの安全タイムアウト
  looseTips = 0;     // ルーズ中にボールがタップされた回数
  looseOff = 0;      // ボールがこぼれた時の攻撃側チーム(リバウンド表示用)
  lastTouch: Player | null = null;   // 最後にボールに触れた選手 — アウトオブバウンズのスローインを決める
  looseIsRebound = false; // ルーズボールがシュートミス由来なら true
  looseFromTip = false;   // 開始ティップのタップで true — ティップ役+最寄りの相手のみが競る
  looseFromRim = false;   // リム接触由来のみ true — 攻撃側確保でショットクロックがリセット
  looseStealBy: Player | null = null;     // はたいて/はじいてこぼした守備者
  looseStealVictim: Player | null = null; // 失ったボールハンドラー/パサー
  looseAge = 0;                            // ボールがルーズになってからの経過時間
  looseGrabAfter = 0;                      // 確保できるまでの遅延
  blockHoldT = 0;                          // はたかれたボールがブロッカーの手に留まる一拍
  blockHoldVel = new Vector3();            // 保持が終わる時に適用されるはじきの速度

  // スローイン/インバウンド機能（状態と処理は InboundSystem が所有 / 方式A）
  readonly inbound = new InboundSystem(this);

  // アシストの記録
  assistFrom: Player | null = null;
  assistTo: Player | null = null;
  pendingAssist: Player | null = null; // 現在のシュートが決まれば加算
  // 決めたシュートでのファウル(AND-1): resolveShot が処理し1本のフリースローへ
  pendingAndOne: Player | null = null;

  // ティップオフ機能（状態と処理は TipoffSystem が所有 / 方式A）
  readonly tipoff = new TipoffSystem(this);

  // フリースロー機能（状態と処理は FreeThrowSystem が所有 / 方式A: Game 参照）
  readonly ft = new FreeThrowSystem(this);

  // デッドボールの一時停止
  private pauseT = 0;
  private pauseNext: (() => void) | null = null;
  // 一時停止中にボールが落下+バウンドしている間 true
  ballFalling = false;
  coastT = 0;   // ブザー後の短いプレーオン猶予
  hoops: Hoops | null = null;     // 成功時にスウィッシュさせるネット/リムのメッシュ
  netSwish: [number, number] = [0, 0];   // フープ別のスウィッシュタイマー(>0 でアニメ中)
  swishTeam: [number, number] = [0, 0];  // 誰が決めたか(フラッシュ色)
  ballFxT = 0;                           // ボール発光の残り秒(>0 で演出中)
  ballFxDur = 0;                         // その演出の長さ(減衰の基準)
  ballFxPunch = 0;                       // 膨らみの最大量(scaling への加算)
  ballFxHalo = 5;                        // 光の殻の最終倍率
  ballFxKind = "";                       // 演出の種類("score" はネット通過で打ち切る)
  ballFxY0 = 0;                          // 得点演出の開始時のボール高さ(減衰の基準)
  readonly ballFxColor = new Color3();   // 発光色
  ballLooseT = 0;                        // ルーズボール中の白い明滅の位相

  constructor(scene: Scene) {
    for (let t = 0; t < 2; t++) {
      for (let i = 0; i < ROSTER_SIZE; i++) {
        this.roster[t].push(new Player(scene, t, i, ROSTER[t][i]));
      }
    }
    for (let t = 0; t < 2; t++) {
      for (let i = 0; i < STARTERS; i++) this.players.push(this.roster[t][i]);
    }
    this.ball = new Ball(scene);
    this.ring = makeHandlerRing(scene);
    this.referees = new RefereeSystem(scene, this);
    this.reset();
  }

  /** 得点時にスウィッシュできるよう、フープのネット/リムのメッシュを接続する。 */
  attachHoops(hoops: Hoops): void { this.hoops = hoops; }

  /** カメラがボール自体を追うべき間 true(遠距離シュートの飛行+着弾後の一拍)。 */
  get camFollowBall(): boolean {
    return (this.ballMode === "shot" && this.longShot) || this.longShotHoldT > 0;
  }

  /** ユニフォーム（ホーム/アウェイ, TEAM_UNIFORM）を全26人へ即時適用する。 */
  applyUniforms(): void {
    for (let t = 0; t < 2; t++) for (const p of this.roster[t]) p.applyUniform();
  }

  // ---- ベンチ & 交代 -------------------------------------------------------

  /** ロスター登録の全選手、コート上か否かに関わらず(ボックススコア用)。 */
  allPlayers(team: number): Player[] {
    return this.roster[team];
  }

  /** 現在のボール状態(読み取り専用。例: 交代進行中は "subs")。 */
  get mode(): BallMode {
    return this.ballMode;
  }

  onCourt(p: Player): boolean {
    return this.players.includes(p);
  }

  // ---- ヘルパ ------------------------------------------------------------

  teamPlayers(team: number): Player[] {
    return team === 0 ? this.players.slice(0, 5) : this.players.slice(5, 10);
  }
  // p の相手チーム（守備側）。
  oppTeam(p: Player): Player[] {
    return this.teamPlayers(1 - p.team);
  }

  /** チームがコートを入れ替えたら true(後半 = Q3 以降)。 */
  private secondHalf(): boolean {
    return this.quarter >= 3;
  }
  /** この半分で `team` が攻めるゴールの Z 符号(+1 / -1)。ハーフタイムでコートを入れ替える。 */
  attackSign(team: number): number {
    const base = team === 0 ? 1 : -1;
    return this.secondHalf() ? -base : base;
  }

  /** 指定チームが攻めるリム真下の床の点。 */
  attackFloor(team: number): Vector3 {
    return new Vector3(0, 0, this.attackSign(team) * RIM.z);
  }
  /** 指定チームが攻めるリム中心(3D)。 */
  attackRim(team: number): Vector3 {
    return new Vector3(0, RIM.height, this.attackSign(team) * RIM.z);
  }

  /** 攻撃アーク周りのオフボール・フォーメーションスポット。 */
  formationSpots(team: number): Vector3[] {
    const s = this.attackSign(team);
    const hz = s * RIM.z;
    const dir = -s; // ミッドコート方向
    // ゾーンブレイク: ゾーンに対し 1-3-1 型で守備者の隙間に配置、1人がハイポストへフラッシュ。
    if (team === this.possession && this.zoneScheme) {
      return [
        new Vector3(0, 0, hz + dir * 8.5),     // 0 ポイント、ゾーンの頂点の上
        new Vector3(-5.9, 0, hz + dir * 5.6),  // 1 左ウイングの隙間
        new Vector3(5.9, 0, hz + dir * 5.6),   // 2 右ウイングの隙間
        new Vector3(-6.5, 0, hz + dir * 1.1),  // 3 左ショートコーナー(ゾーンの背後)
        new Vector3(6.5, 0, hz + dir * 1.1),   // 4 右ショートコーナー
        new Vector3(0, 0, hz + dir * 4.3),     // 5 ハイポスト — ゾーン崩しのフラッシュ
        new Vector3(0, 0, hz + dir * 0.9),     // 6 リム下のダンカー
      ];
    }
    return [
      // ペリメーターのスポットはアークに張り付く(ライン 6.75m)。コート幅を広く使う。
      new Vector3(0, 0, hz + dir * 7.1),     // トップ(7.1m 外)
      new Vector3(-5.7, 0, hz + dir * 4.6),  // 左ウイング(幅広め)
      new Vector3(5.7, 0, hz + dir * 4.6),   // 右ウイング
      // ディープコーナー: ベースライン近くのコーナースリー（サイドライン際）
      new Vector3(-6.9, 0, hz + dir * 1.5),  // 左コーナー
      new Vector3(6.9, 0, hz + dir * 1.5),   // 右コーナー
      // ローブロック、レーンラインのすぐ外 — ポストビッグの定位置
      new Vector3(-2.8, 0, hz + dir * 1.4),  // 左ローブロック
      new Vector3(2.8, 0, hz + dir * 1.4),   // 右ローブロック
    ];
  }

  clampCourt(p: Vector3): void {
    if (this.saveBy && p === this.saveBy.pos) return;   // セーブ中はライン外へ出てよい
    const mw = COURT.halfW - COURT.margin;
    const ml = COURT.halfL - COURT.margin;
    p.x = clamp(p.x, -mw, mw);
    p.z = clamp(p.z, -ml, ml);
  }

  nearestDefenderDist(p: Player): number {
    const d = this.nearestDefender(p);
    return d ? dist2D(d.pos, p.pos) : Infinity;
  }

  nearestDefender(p: Player): Player | null {
    let best = Infinity, who: Player | null = null;
    for (const d of this.teamPlayers(1 - p.team)) {
      const dd = dist2D(d.pos, p.pos);
      if (dd < best) { best = dd; who = d; }
    }
    return who;
  }

  /** `team` の誰かが指定の特殊能力を持てば true(チーム全体オーラ: 司令塔/DFライン)。 */
  teamHas(team: number, key: AbilityKey): boolean {
    for (const p of this.teamPlayers(team)) if (p.has(key)) return true;
    return false;
  }

  /** この選手の `r` メートル以内にいる守備者の数。 */
  defendersWithin(p: Player, r: number): number {
    let n = 0;
    for (const d of this.teamPlayers(1 - p.team)) if (dist2D(d.pos, p.pos) < r) n++;
    return n;
  }

  // 精神: >0 = 動揺(精度低下)、<0 = 奮起(精度上昇)。呼び出し側は factor×weight を引くので負の factor はバフ。
  clutchFactor(p: Player): number {
    const diff = this.score[p.team] - this.score[1 - p.team];
    let stress = p.fatigue * 0.5;
    if (diff < 0) stress += 0.3;                                        // 劣勢
    if (this.quarter >= QUARTERS && this.gameClock < QUARTER_TIME * 0.5
        && Math.abs(diff) <= 10) stress += 0.6;                         // クランチタイム
    const m = clamp(p.attr.mental, 0, 100);
    const resolve = m >= 80
      ? -(m - 80) / 40      // 80..100 → 0 .. -0.5: 局面で奮起
      : (80 - m) / 80;      // 0..80  → 1 .. 0:     重圧で崩れる
    return clamp(stress, 0, 1) * resolve;
  }

  setEvent(text: string, team: number, dur = 1.8,
                   info?: { scorer?: string; assist?: string }): void {
    // ファウルは審判がシグナル(腕を突き上げる)。バナー可否に関わらず出す。
    if (this.referees && text === "FOUL") this.referees.signalFoul();
    // 目立つプレーだけが画面バナーになる（得点/AND-1/ファウル/ピリオド区切り）。
    // 得点バナーには誰が決めた/アシストしたかを載せる。
    if (!this.bannerWorthy(text)) return;
    this.lastEvent = { text, team, scorer: info?.scorer, assist: info?.assist };
    this.eventT = dur;
  }

  private bannerWorthy(text: string): boolean {
    return text.includes("FOUL")           // FOUL / SHOOTING FOUL
      || text === "AND-1"
      || text === "2 POINTS"
      || text === "3 POINTS!"
      || text === "BACKCOURT"              // オーバー&バック(バックコート)違反
      || text === "SHOT CLOCK VIOLATION"   // ショットクロック違反(攻撃側)
      || text.includes(" BALL")            // どちらのボールか明示する再開バナー
      || text.startsWith("THROW-IN")       // スローイン再開 — どちらのボールか
      || text === "TIP-OFF"
      || text === "HALFTIME"
      || text === "2ND HALF"
      || text === "FINAL"
      || text.endsWith("WINS!")            // 試合終了ブザーの勝利コール
      || text === "DRAW"
      || text.startsWith("END OF Q")
      || /^Q\d START$/.test(text);
  }

  // ---- ライフサイクル ----------------------------------------------------

  reset(): void {
    this.score = [0, 0];
    this.qLine = [[], []];
    this.quarter = 1;
    this.gameClock = QUARTER_TIME;
    this.shotClock = SHOT_CLOCK;
    this.state = "live";
    this.lastEvent = null;
    this.possession = 0;
    this.subsMade = 0;
    this.subEvents.length = 0;
    this.subWalkers = [];
    this.subNext = null;
    this.inbound.oobWalker = null;
    this.blockHoldT = 0;
    this.cheerT = [-1, -1];
    this.longShot = false;
    this.longShotHoldT = 0;
    this.finaleT = 0;
    this.finaleWinner = -1;
    this.finaleWalkers = [];
    this.finaleTrudge = [];
    this.screen.clear();
    // 先発5人が入り直し、ベンチは着席する
    for (let t = 0; t < 2; t++) {
      for (let i = 0; i < ROSTER_SIZE; i++) {
        const p = this.roster[t][i];
        p.resetStats();
        p.resetPose();       // 前試合のジャンプ/腕/リアクション状態を全クリア
        if (i < STARTERS) {
          p.slot = i;
          p.spotIdx = i;
          p.stand();         // 前の試合でベンチだった選手の着席状態を解く
          p.resetFacing();   // 前の試合のベンチでの視線をクリア
          this.players[t * 5 + i] = p;
        } else {
          seatOnBench(this, p);
        }
      }
    }
    this.assistFrom = this.assistTo = this.pendingAssist = null;
    this.applyNumberSides();
    refreshChoiceRanks(this, 0);
    refreshChoiceRanks(this, 1);
    this.tipoff.start();
    updateNameTags(this);   // 試合前(update が走らない)でも設定どおりの表示にしておく
  }

  // 背番号は選手の背中、各チームが攻めるバスケットと反対側に付く。
  // ハーフタイムでコートを入れ替える時に再適用する。
  applyNumberSides(): void {
    for (let t = 0; t < 2; t++) {
      const back = -this.attackSign(t);
      for (const p of this.roster[t]) p.setNumberSide(back);
    }
  }

  /** ロスターのロール/優先度/派生値を再適用する（試合前画面から呼ぶ）。 */
  applyRoster(): void {
    for (let t = 0; t < 2; t++) {
      for (let i = 0; i < ROSTER_SIZE; i++) this.roster[t][i].applyDef(ROSTER[t][i]);
    }
    refreshChoiceRanks(this, 0);
    refreshChoiceRanks(this, 1);
  }

  placeFormation(): void {
    for (let t = 0; t < 2; t++) {
      const spots = this.formationSpots(t);
      const tp = this.teamPlayers(t);
      for (let i = 0; i < 5; i++) {
        tp[i].pos.copyFrom(spots[i]);
        tp[i].sync();
      }
    }
  }

  // 第2・3・4ピリオドはセンターラインからのスローインで始まる。
  // ウイングがスローインし、PG が戻って受け取り運び上げる。守備はゴール側でマッチ。
  startQuarterInbound(team: number, prePlaced = false): void {
    this.possession = team;
    const offense = this.teamPlayers(team);
    if (!prePlaced) {
      // (クォーター間の流れでは代わりに全員をこのスポットへ歩かせる)
      this.placeFormation();                     // 両チームを攻撃スポットへ
      const defenders = this.teamPlayers(1 - team);
      const protect = this.attackFloor(team);    // 守備が守るバスケット
      for (const d of defenders) {
        const man = offense[d.slot];
        const gs = towardPoint(man.pos.x, man.pos.z, protect.x, protect.z, 1.4); // マークのゴール側
        d.pos.set(gs.x, 0, gs.z);
      }
      // スローイン役(ウイング)はセンターラインのアウトオブバウンズに立つ
      offense[2].pos.set(-(COURT.halfW + OOB_OUTSET), 0, 0); // センターライン、左サイドライン
    }
    const taker = offense[2];
    this.handler = taker;
    this.ballMode = "inbound";
    this.inbound.t = 1.0;
    this.shotClock = SHOT_CLOCK;
    this.resetMotion();
    this.inbound.receiver = offense[0];           // ポイントガード
    this.inbound.beginRefThrow(taker);            // 審判が拾ったボールを近づく投げ手へ投げ渡す
    // 新ピリオド開始バナー — どちらのボールか
    this.setEvent(this.quarter === 3
      ? `2ND HALF — ${teamShort(team)} BALL`
      : `Q${this.quarter} START — ${teamShort(team)} BALL`, team, 2.0);
  }

  // ---- メイン更新 --------------------------------------------------------

  update(dt: number): void {
    if (this.eventT > 0) this.eventT = Math.max(0, this.eventT - dt);
    if (this.eventT === 0) this.lastEvent = null;
    // 交代フィードを経過させる（HOME を先に流し、消えてから AWAY）
    const homeLive = this.subEvents.some((e) => e.team === 0);
    for (let i = this.subEvents.length - 1; i >= 0; i--) {
      const e = this.subEvents[i];
      if (e.team === 1 && homeLive) continue;   // HOME が消えるまで AWAY を保留
      e.ttl -= dt;
      if (e.ttl <= 0) this.subEvents.splice(i, 1);
    }

    // ベンチが得点を祝う — 全モードで走る。`final` の早期リターンより前に置く
    updateBenchCheer(this, dt);

    if (this.state === "final") {
      syncAll(this);
      return;
    }

    // 実速度を測るため、各自のフレーム開始位置を記録
    for (const p of this.players) { p.prevX = p.pos.x; p.prevZ = p.pos.z; }

    // クロック — デッドボール中は凍結(ジャンプボール、フリースロー、一時停止、交代)
    if (this.ballMode !== "tipoff" && this.ballMode !== "freethrow"
        && this.ballMode !== "pause" && this.ballMode !== "subs"
        && this.ballMode !== "finale") {
      this.gameClock -= dt;
      for (const p of this.players) { p.stats.min += dt; p.stintT += dt; }
      // マッチアップのベンチ保持はベンチ選手についても試合時間で減少
      for (let t = 0; t < 2; t++) for (const p of this.roster[t]) {
        if (p.matchupHoldT > 0) p.matchupHoldT = Math.max(0, p.matchupHoldT - dt);
      }
      if (this.ballMode === "held") {
        this.shotClock -= dt;
        if (this.shotClock <= 0) {
          shotClockViolation(this);
        }
      }
      // ブザー: 空中/ギャザー中のシュートは完了を許す(ブザービーター)。着弾で resolveShot がピリオド終了を引き継ぐ
      if (this.gameClock <= 0 && this.ballMode !== "shot" && this.ballMode !== "charge") {
        // ホーンが鳴っても一拍だけ惰性でライブプレーを続ける。パスは長めのウィンドウを取る。
        if (this.ballMode === "held" || this.ballMode === "loose" || this.ballMode === "pass" || this.ballMode === "inbound") {
          if (this.coastT <= 0) this.coastT = this.ballMode === "pass" ? 1.4 : 0.8;
          this.coastT -= dt;
          if (this.coastT <= 0) endQuarter(this);
        } else {
          endQuarter(this);
        }
      }
    }

    // ボール状態機械
    switch (this.ballMode) {
      case "held": updateLive(this, dt); break;
      case "charge": updateCharge(this, dt); break;
      case "pass": updatePass(this, dt); break;
      case "shot": updateShot(this, dt); break;
      case "loose": updateLoose(this, dt); break;
      case "inbound": this.inbound.update(dt); break;
      case "tipoff": this.tipoff.update(dt); break;
      case "freethrow": this.ft.update(dt); break;
      case "pause": this.updatePause(dt); break;
      case "subs": updateSubs(this, dt); break;
      case "finale": updateFinale(this, dt); break;
    }

    // 保持中のボールは、この後の衝突解決でハンドラーが押された分だけ一緒にずらす
    // （更新順の都合でボール位置はハンドラー移動前に決まるため、手から取り残されないように）。
    const holder = this.ballMode === "held" ? this.handler
      : this.ballMode === "charge" ? this.chargeShooter : null;
    const holdX = holder ? holder.pos.x : 0, holdZ = holder ? holder.pos.z : 0;
    // 踏ん張るキーパー: ボールを守るハンドラー(keepShieldT)を押しで後退させない。
    // 衝突前にリムまでの距離を記録し、押しで増えたらその線まで引き戻す（後退のみ拒否、横/前進は放置）。
    const keeper = this.handler && this.handler.keepShieldT > 0 ? this.handler : null;
    const keepFloor = keeper ? this.attackFloor(keeper.team) : null;
    const keepDist0 = keeper && keepFloor ? dist2D(keeper.pos, keepFloor) : 0;
    resolveCollisions(this);
    if (keeper && keepFloor) {
      const dx = keeper.pos.x - keepFloor.x, dz = keeper.pos.z - keepFloor.z;
      const now = Math.hypot(dx, dz);
      if (now > keepDist0 + 1e-3) {
        const k = keepDist0 / now;
        keeper.pos.x = keepFloor.x + dx * k;
        keeper.pos.z = keepFloor.z + dz * k;
      }
    }
    if (holder) {   // ハンドラーの押し出し分だけボールを追従
      this.ball.pos.x += holder.pos.x - holdX;
      this.ball.pos.z += holder.pos.z - holdZ;
    }
    const resting = this.ballMode === "pause" || this.ballMode === "freethrow"
      || this.ballMode === "tipoff" || this.ballMode === "subs"
      || this.ballMode === "finale";
    updateSaveRecover(this, dt);   // セーブでライン外へ出た選手をコートへ戻す
    for (const p of this.players) {
      p.updateJump(dt);
      p.tickCooldown(dt);
      p.tickMotion(dt, resting);   // 実速度を計測、疲労のドレイン/回復
      p.updateLegs(dt);            // 計測速度から歩き/走りの脚サイクル
    }
    // ベンチは座って回復し、ボールを見る（歓声中/交代歩行中を除く）
    if (this.ballMode !== "finale") {   // フィナーレが全員をフロア外で管理する
      for (let t = 0; t < 2; t++) {
        const cheering = this.cheerT[t] > -1.6;   // updateBenchCheer の収束ウィンドウに合わせる
        for (const p of this.roster[t]) {
          if (this.onCourt(p)) continue;
          p.benchRecover(dt);
          // (ベンチへ/から)歩行者は updateSubs でアニメ。それ以外はアイドル
          if (!this.subWalkers.some((w) => w.p === p) && !cheering) {
            // 座っている選手は必ず自席の上に居る(引き上げ/歓声で動かされた体を戻す)
            if (p.seated) { const s = benchSeat(this, p); p.pos.set(s.x, 0, s.z); }
            p.benchIdle(dt, this.ball.pos.x, this.ball.pos.z);
          }
        }
      }
    }
    updateFacing(this, dt);
    if (this.longShotHoldT > 0) this.longShotHoldT = Math.max(0, this.longShotHoldT - dt);
    tickSwish(this, dt);   // 成功時のネットスウィッシュ/リムフラッシュ
    tickBallFx(this, dt);  // キャッチ/奪取時のボール発光
    this.referees.update(dt);   // 審判2人: ボールを追って移動・シグナル
    syncAll(this);
  }

  /** シミュを進めずに論理状態をメッシュへ反映する。 */
  syncVisuals(): void { syncAll(this); }

  // ---- ライブプレー(ボール保持中) ---------------------------------------

  // ドリブルが手元近くに上がっていれば true(安全)、床に落ちていれば false(露出)。リズムは D精度。
  ballInHand(h: Player): boolean {
    return Math.abs(Math.cos(Math.PI * h.dribblePhase)) > 0.5;
  }

  // 現在のボールハンドラーに割り当てられた守備者(番号でのマンツーマン)。
  onBallDefender(h: Player): Player | undefined {
    return this.teamPlayers(1 - h.team)[h.slot];
  }

  // ライブでのポゼッション交代後、ボールがバックコートなら速攻ウィンドウを開く。
  maybeStartPush(): void {
    const h = this.handler;
    if (h && !this.frontT && this.attackSign(h.team) * h.pos.z < 6) this.pushT = 4.5;
  }

  // 攻撃サイドを選ぶ: 利き手が主導、逆手頻度で反対側も選ぶ。
  pickSide(h: Player): number {
    return chance(h.strongSideBias()) ? h.strongSide() : -h.strongSide();
  }

  // ドライブをリムへ向け、選んだサイドへ曲げる。抜き切ったらまっすぐ入って
  // フィニッシュ。
  setDriveSide(h: Player): void {
    const rim = this.attackFloor(h.team);
    const dx = rim.x - h.pos.x, dz = rim.z - h.pos.z;
    const len = Math.hypot(dx, dz) || 1;
    const ux = dx / len, uz = dz / len;
    const lx = -uz * h.driveSide, lz = ux * h.driveSide; // 攻撃サイドへの横方向
    // 抜き去りやパワードライブはまっすぐ入る。未解決の探りは大きく曲がる
    const off = (h.beatenT > 0 || h.powerT > 0) ? 0.2 : 1.6;
    h.driveTarget.set(rim.x + lx * off, 0, rim.z + lz * off);
  }

  // (tx,tz) への経路上に立つ体を避けて回る。意図的な接触の動きはこれを呼ばない。
  // `opponentsOnly` は味方(スクリーン/ハンドオフ)を対象外にする。
  steerAround(p: Player, tx: number, tz: number, opponentsOnly = false): { x: number; z: number } {
    const dx = tx - p.pos.x, dz = tz - p.pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 1.0) return { x: tx, z: tz };       // 到着中 — 逸れる余地なし
    const ux = dx / dist, uz = dz / dist;
    let bestT = Infinity, ob: Player | null = null, obLat = 0;
    for (const q of this.players) {
      if (q === p) continue;
      if (opponentsOnly && q.team === p.team) continue;
      const rx = q.pos.x - p.pos.x, rz = q.pos.z - p.pos.z;
      const t = rx * ux + rz * uz;                 // 経路上でどれだけ前方か
      if (t < 0.3 || t > Math.min(dist - 0.4, 3.2)) continue;
      const lat = -rx * uz + rz * ux;              // 経路からの符号付きオフセット
      if (Math.abs(lat) > 0.7) continue;           // 実際には通路内にいない
      if (t < bestT) { bestT = t; ob = q; obLat = lat; }
    }
    if (!ob) return { x: tx, z: tz };
    // ブロッカーがまだ寄せていない側を通す（決定論的なタイブレーク）
    const side = obLat > 0.05 ? -1 : obLat < -0.05 ? 1 : (p.idx % 2 ? 1 : -1);
    const sx = ob.pos.x - uz * side, sz = ob.pos.z + ux * side;
    // かわされた守備者が応じる: 一拍、新レーンの入口を塞ぐため横へスライド(runDefense が実行)
    if (this.ballMode === "held" && ob.team !== p.team && ob.team !== this.possession) {
      ob.wallT = Math.max(ob.wallT, 0.25);
      ob.wallX = sx;
      ob.wallZ = sz;
    }
    return { x: sx, z: sz };
  }

  setDrive(h: Player, rimFloor: Vector3, standoff: number): void {
    const t = towardPoint(rimFloor.x, rimFloor.z, h.pos.x, h.pos.z, standoff);
    h.driveTarget.set(t.x, 0, t.z);
  }

  /** ショットクロックの部分リセット(下限 SHOT_CLOCK_PARTIAL)。 */
  partialShotClock(): void {
    this.shotClock = Math.max(this.shotClock, SHOT_CLOCK_PARTIAL);
  }

  // ---- アクション --------------------------------------------------------

  // シュート決断はチャージ(ギャザー)を開始する — 放つ前に一拍溜める。
  // この間に守備がコンテストできる(updateCharge)。成功率/ブロック/放ちはリリース時(releaseShot)。
  chargeT = 0;
  chargeShooter: Player | null = null;
  chargeDHoop = 0;
  chargeDDef = 0;
  shotWindup = 0;   // 放たれるシュートのギャザー長(tryBlock 用) = 必要準備時間
  chargeHeld = 0;   // 溜め完了後の追加ホールド秒(どフリー時の精度微増用)

  // target へのシュートに跳んで挑む。正対なら垂直ジャンプで最大の高さ、
  // 横にずれていれば斜めにランジ(高さを射程と引き換え)。
  contestLeap(d: Player, target: { x: number; z: number }, baseHeight: number, dur: number): void {
    const gx = target.x - d.pos.x, gz = target.z - d.pos.z;
    const gap = Math.hypot(gx, gz);
    if (gap < 0.6) { d.jump(baseHeight, dur); return; }   // 既に正面 → 真上へ
    const ux = gx / gap, uz = gz / gap;
    const leap = clamp(gap - 0.4, 0, 1.5);                // シュートへどれだけランジするか
    const heightScale = 1 - clamp(leap / 1.5, 0, 1) * 0.4; // 完全な斜めは跳躍の約40%を失う
    d.jump(baseHeight * heightScale, dur, ux * leap, uz * leap);
  }

  // ---- ファウル & フリースロー -------------------------------------------

  // シーンを一瞬凍結(デッドボール)し、次のフェーズを走らせる。
  pauseThen(seconds: number, next: () => void): void {
    this.pauseT = seconds;
    this.pauseNext = next;
    this.ballMode = "pause";
  }

  private updatePause(dt: number): void {
    // 得点後はボールがネットを抜けて床でバウンドする。それ以外は静かに落ち着くだけ
    if (this.ballFalling) stepBallFreeFlight(this, dt);
    else this.ball.pos.y = Math.max(0.3, this.ball.pos.y - 3 * dt);
    // アウトオブバウンズ: スロー役がスポットへ歩いていく
    if (this.inbound.oobWalker) {
      moveToward2D(this.inbound.oobWalker.pos, this.inbound.oobSpot.x, this.inbound.oobSpot.z,
        this.inbound.oobWalker.runSpeed * 0.6 * dt);
      this.inbound.oobWalker.faceToward(this.inbound.oobSpot.x, this.inbound.oobSpot.z);  // 向かう先を向く(ボールへ後ろ歩きしない)
    }
    // 喜び中のハイタッチ: ペアは中間点へ歩み寄り、手が届く距離(約1.3m)で止まって叩き合う。
    for (const p of this.players) {
      if (p.defWinKind !== "highfive" || p.defWinT <= 0) continue;
      if (dist2D(p.pos, p.defWinToward) > 0.65) {
        moveToward2D(p.pos, p.defWinToward.x, p.defWinToward.z, p.runSpeed * 0.4 * dt);
        this.clampCourt(p.pos);
      }
    }
    this.pauseT -= dt;
    if (this.pauseT <= 0) {
      this.ballFalling = false;
      const next = this.pauseNext;
      this.pauseNext = null;
      if (next) next();
    }
  }

  // ボールを争奪可能なルーズ状態にする。`offense` はこぼれた時に攻撃していたチーム。
  goLoose(offense: number, timeout: number,
                  opts: { rebound?: boolean; fromRim?: boolean; stealBy?: Player | null; victim?: Player | null; grabAfter?: number; tip?: boolean } = {}): void {
    this.looseOff = offense;
    this.looseT = timeout;
    this.looseTips = 0;
    this.looseIsRebound = opts.rebound ?? false;
    this.looseFromTip = opts.tip ?? false;
    // リム由来のリバウンドのみ、攻撃側確保でショットクロックをリセット。
    // ブロック/はたき/ファンブルはリセットなし。
    this.looseFromRim = opts.fromRim ?? false;
    this.looseStealBy = opts.stealBy ?? null;
    this.looseStealVictim = opts.victim ?? null;
    this.looseAge = 0;
    this.looseGrabAfter = opts.grabAfter ?? 0;  // 確保できる前の、目に見えて自由な一拍
    this.handler = null;
    this.ballMode = "loose";
    for (const p of this.players) p.touchCool = 0;
    // スティール/はたき出しの被害者は弾かれて軽くのけぞる（衝撃のみ、歩かない）。
    // 全スティール経路(steal/stripGather/deflectCatch/パス奪取)がここを通る。
    const st = opts.stealBy, vic = opts.victim;
    if (st && vic && st !== vic) {
      vic.foulReaction("hurt", vic.pos.x - st.pos.x, vic.pos.z - st.pos.z, rand(0.25, 0.42));
      vic.foulStumble = false; vic.foulStaggerX = vic.foulStaggerZ = 0;
    }
    // ボールがこぼれた反応: 反応の速い選手が先に飛びつく(reactionLag で遅延)。
    for (const p of this.players) p.looseReactT = reactionLag(p);
  }

  // ミス後、ボールはリムに跳ねてライブになる(updateLoose 参照)。
  startRebound(): void {
    const rim = this.attackRim(this.possession);
    this.ball.pos.set(rim.x + rand(-0.3, 0.3), RIM.height + 0.1, rim.z + rand(-0.2, 0.2));
    // リング(鉄)から: 少し上へ、その後外側へ床に向かって
    this.ball.vel.set(rand(-3.4, 3.4), rand(1.2, 3.0), -Math.sign(rim.z || 1) * rand(0.8, 3.6));
    this.goLoose(this.possession, 2.6, { rebound: true, fromRim: true });

    // ビッグ(とリム直下の誰でも)がボードを争って跳ぶ
    this.crashReboundJump(this.attackFloor(this.possession));
  }

  // リム至近の選手(ビッグは広め)がリバウンドへ跳ぶ。
  crashReboundJump(rimFloor: Vector3): void {
    for (const p of this.players) {
      const d = dist2D(p.pos, rimFloor);
      if (d < 2.8 && (this.isBig(p) || d < 1.4)) p.jump(this.isBig(p) ? 0.7 : 0.5, 0.6);
    }
  }

  // ビッグ(PF/C)か。ポジションラベルで判定。
  isBig(p: Player): boolean {
    return p.role === "PF" || p.role === "C";
  }

  // この選手がローブロックに属するか。ビッグはゴールに住み、ストレッチ脅威のみペリメーターへ広がる。
  prefersPost(p: Player): boolean {
    if (p.has("post") || p.has("centerSpot")) return true;
    if (!this.isBig(p)) return false;
    // ゴール下のアンカーは、チームのビッグのうち最も3Pが低い"内寄り"の1人に固定する。
    // これは役割ラベル(ストレッチ/プレイメイキングビッグ)より優先。3Pの下手なビッグ(C等)が
    // 誤ってストレッチ役を割り当てられても、必ずゴール下に入る。
    let anchor: Player | null = null;
    for (const b of this.teamPlayers(p.team)) {
      if (!this.isBig(b)) continue;
      if (!anchor || rate(b.attr.threeAcc) < rate(anchor.attr.threeAcc)) anchor = b;
    }
    if (p === anchor) return true;                   // 最内ビッグは必ずポスト
    // アンカーは1人。もう1人のビッグは広げてスペーシングを確保する（リムランナー/
    // スクリーナーだけは内側に住む）。役割ラベルより属性優先の設計を保つ。
    if (p.evalRole === "スクリーナー" || p.evalRole === "リムランナー") return true;
    return false;
  }

  // フォーメーションスポット: ポストのビッグはブロックへ(PF=左, C=右)、他は自分の枠のスポット。
  homeSpotIdx(p: Player): number {
    if (this.isBig(p) && this.prefersPost(p)) return p.slot === 3 ? 5 : 6;
    return p.slot;
  }

  // シュート時、ビッグはリバウンドに飛び込み、ガード/ウイングは下がって戻る準備をする。
  // リバウンドを競る(残って飛び込む)タイプか: PF/C・センター役・リバウンダーロール・長身(≥2.0m)。
  reboundCrasher(p: Player): boolean {
    return this.isBig(p) || p.has("centerSpot") || p.evalRole === "リバウンダー" || p.height >= 2.0;
  }

  // 味方がシュート(溜め/放出)した瞬間のトランジション戻り。リムを競らないオフェンス選手を
  // 攻撃性に応じて自陣へ戻す(攻撃性95=留まる/現状、低いほど深く速く)。戻したら true。
  // 溜め(charge)中から呼ぶことで判定を早める。リバウンド競り(reboundCrasher)/リム至近は優先で false。
  retreatOnShot(p: Player, dt: number): boolean {
    if (p.team !== this.possession || p.rooted) return false;
    if (this.reboundCrasher(p)) return false;   // 長身/リバウンダーは残って飛び込み優先
    const rimFloor = this.attackFloor(this.possession);
    if (dist2D(p.pos, rimFloor) < 5.5) return false;          // 既にリム至近で競る位置 → 優先
    const stay = clamp((rate(p.attr.aggression) - 0.55) / 0.40, 0, 1);  // 攻撃性95→1, 65→0.25
    const backPull = 1 - stay;
    if (backPull <= 0.05) return false;                       // 攻撃性ほぼ最大 → 現状(セーフティ)
    const defRim = this.attackFloor(1 - this.possession);     // 守る側のリム
    const sgn = this.attackSign(this.possession);
    const safeZ = rimFloor.z - sgn * 7;                       // オフェンスリム7m手前=セーフティ(留まる先)
    const tz = safeZ + (defRim.z - safeZ) * backPull;         // 攻撃性低いほど自陣リムへ深く戻る
    const tx = p.pos.x * (1 - backPull * 0.5);                // 中央寄りに絞りながら
    moveToward2D(p.pos, tx, tz, p.accelSpeed(dt, 0.95 + backPull * 0.6) * dt);   // 戻りは速め
    this.clampCourt(p.pos);
    return true;
  }

  crashBoards(dt: number): void {
    const rimFloor = this.attackFloor(this.possession);
    for (const p of this.players) {
      // フィニッシャーはドライブの勢いを空中へ持ち込む(踏み切り速度が跳躍中に減衰)。
      // ギャザー地点への軽いステアリングでリムへフィニッシュ。
      if (p === this.shooter && this.ballMode === "shot" && this.shooterFinishing) {
        const decay = Math.exp(-dt / 0.33);     // 勢いが抜けていく(τ≈0.33s)
        this.finishVX *= decay;
        this.finishVZ *= decay;
        p.pos.x += this.finishVX * dt;
        p.pos.z += this.finishVZ * dt;
        moveToward2D(p.pos, this.finishSpot.x, this.finishSpot.z, p.runSpeed * 0.18 * dt);
        this.clampCourt(p.pos);
        continue;
      }
      // フォロースルー中のシューターは回復するまでリバウンドに飛び込めない
      if (p.rooted) { this.clampCourt(p.pos); continue; }
      const big = this.reboundCrasher(p); // ビッグ/長身/リバウンダーはリムへ飛び込む
      // オフェンス側のトランジション戻り(リムを競らない選手は攻撃性に応じて自陣へ)。溜め中から効かせる。
      if (this.retreatOnShot(p, dt)) continue;
      // ビッグはリムへ飛び込む。ウイングはサポート、PG は速攻を止めるセーフティとして残る。
      const standoff = big ? 0.8 : (p.role === "PG" ? 6.5 : 4.2);
      const t = towardPoint(rimFloor.x, rimFloor.z, p.pos.x, p.pos.z, standoff);
      const speed = p.accelSpeed(dt, big ? 0.95 : 0.6); // ビッグは踏み込み、ガードは下がって残る
      moveToward2D(p.pos, t.x, t.z, speed * dt);
      this.clampCourt(p.pos);
    }
  }

  // スローイン役が受け手へボールを入れる。捕球でプレーがライブになる。
  throwIn(inb: Player): void {
    const r = this.inbound.receiver ?? this.inbound.pickReceiver(inb);
    const from = inb.chestFront(BALL_HOLD);      // 体の中からでなく手元(胸の前)から放つ
    this.passFrom.set(from.x, 1.3, from.z);
    this.passCatch.set(r.pos.x, 1.3, r.pos.z);   // 固定の目標
    this.passMiss = 0; this.passMissY = 0; // 散らばりなし
    this.passStyle = "chest";              // スローインはバウンド/ジャンプのスタイルを継がない
    this.passOneHand = false;              // 前のパスの片手投げを継がない
    this.passTo = r;
    this.passer = inb;
    this.passT = 0;
    // P速度 がアウトレットの速さを決める。ロング はフラットで速く放つ
    const spd = PASS_SPEED * (0.6 + rate(inb.attr.passSpd) * 0.95) * (inb.has("longThrow") ? 1.3 : 1);
    this.passDur = Math.max(0.3, dist2D(inb.pos, r.pos) / spd);
    this.passSteal = null;                 // スローインはここでは奪われない
    this.ballMode = "pass";
    this.handler = null;
    this.inbound.receiver = null;
    // スロー役はリリースの間その場に固定(フォロースルーが終わるまで踏み込めない)
    inb.coolT = rand(0.5, 0.9) * inb.recoveryMult();
  }

  resetMotion(): void {
    this.pendingPassTo = null;   // ポゼッション交代はウィンドアップ済みのジャンプ/ターンパスを取り消す
    this.pendingPassT = 0;
    this.pendingPassTurn = false;
    this.noLookPass = false;
    for (const p of this.players) {
      p.cutting = false;
      p.offTimer = rand(0.4, 2.0);
      p.spotIdx = this.homeSpotIdx(p);   // ポストのビッグはブロックへ直行
      p.beatenT = 0;
      p.powerT = 0;
      p.stalledT = 0;
      p.jukeT = 0;
      p.comboN = 0;
      p.reactT = 0;
      p.lean = 0;
      p.coolT = 0;   // ポゼッション交代は残ったフォロースルーをクリア
      p.landT = 0;
      p.touchCool = 0;
      p.screening = false;
      p.screenT = 0;
      p.openRollT = 0;
    }
    // ポゼッション交代は保留中のアシストを終わらせ、フロントコート定着をリセットする
    this.assistFrom = this.assistTo = null;
    this.frontT = false;
    this.pushT = 0;   // 新しいポゼッションは以前の速攻ウィンドウをクリア
    this.screen.clear();  // ライブのピック&ロールのカバレッジはポゼッションとともに終わる
  }

  // 守備側のこのポゼッションの構え: プレス? ゾーン(2-3=ペイント/3-2=ペリメーター)? 素のマン?
  schemePoss = -1;

  // 飛び出し: ターンオーバー時、リークアウト走者が即座に自バスケットへ走り出す。resetMotion() の後に呼ぶ。
  leakOut(): void {
    for (const p of this.teamPlayers(this.possession)) {
      if (p === this.handler || !p.has("leakOut")) continue;
      const rim = this.attackFloor(p.team);
      p.cutting = true;
      p.offTimer = rand(2.0, 3.0);
      p.offTarget.set(rim.x + rand(-1.2, 1.2), 0, rim.z - Math.sign(rim.z || 1) * 1.0);
    }
  }

  // ---- ターンオーバー ----------------------------------------------------

  // スティール試行はボールを弾いてルーズにする。巧みな盗り手は自分の方へ弾き大抵確保する。
  // スティール/ターンオーバーは守備が確保した時に加算(secureLoose)。
  steal(d: Player): void {
    const h = this.handler;
    if (!h) return;
    // どれだけきれいに守備者の方へ弾かれるか(0=散らばる、~0.7=ぴったり相手へ)。
    const grip = clamp(0.2 + rate(d.attr.reaction) * 0.55 - rate(h.attr.handling) * 0.3, 0.05, 0.7);
    const ax = d.pos.x - h.pos.x, az = d.pos.z - h.pos.z;
    const len = Math.hypot(ax, az) || 1;
    const ux = ax / len, uz = az / len;            // ハンドラー→守備者
    // 下方向かつ外へ弾かれる — 低く始まり床で跳ねる
    const power = rand(2.2, 5.5);   // 軽い引っかけ 〜 強いはたき出し
    this.ball.pos.set(h.pos.x + ux * 0.35, 0.75, h.pos.z + uz * 0.35);
    this.ball.vel.set(
      ux * power * grip + rand(-2.2, 2.2) * (1 - grip),   // 強い水平方向の飛散
      rand(-0.2, 0.6),                             // 低く — ディグであってロブではない
      uz * power * grip + rand(-2.2, 2.2) * (1 - grip),
    );
    flashBall(this, "intercept", d.team);          // はたいた側の色
    // 自由な一拍で、確保前にはたき出しの争奪が見えるようにする
    this.goLoose(h.team, 1.6, { stealBy: d, victim: h, grabAfter: 0.55 });
    d.digReach(new Vector3(this.ball.pos.x, 0.9, this.ball.pos.z));   // ランジ
    d.defWin("steal");                             // 争奪が片付いたら祝いのガッツポーズ
    h.touchCool = 0.5;                             // バランスを崩された — 即座には掴めない（のけぞりは goLoose で付与）
  }

  // ---- クォーター / 試合終了 ----------------------------------------------

  // ---- 試合終了ブザーの場面: 勝利の歓喜/うなだれ/分かち合う引き分け ------
  finaleT = 0;
  finaleWinner = -1;   // 0/1 = 勝利チーム、-1 = 引き分け
  finaleWalkers: { p: Player; tx: number; tz: number }[] = [];   // フロアで喜ぶ勝者
  finaleTrudge: { p: Player; tx: number; tz: number }[] = [];    // 落胆して退く敗者

  /** 試合終了ブザー: 勝ったベンチがフロアへなだれ込み、負けた5人は自ベンチへ退く。
   *  引き分けは両チームがその場で祝う。バナーに "○○ 勝利!" が流れる。 */

}
