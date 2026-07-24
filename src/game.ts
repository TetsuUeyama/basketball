import { Scene, Vector3, Mesh } from "@babylonjs/core";
import { Player } from "./objects/player/player";
import { Ball } from "./objects/ball";
import "./objects/player/player-move";    // Player.prototype に移動/物理/クエリ/状態を注入
import "./objects/player/player-query";
import "./objects/player/player-state";
import "./objects/player/player-visual";
import "./objects/player/player-roster";
import "./objects/player/player-arms";    // Player.prototype にアニメを注入
import "./objects/player/player-facing";
import "./objects/player/player-legs";
import "./objects/player/player-react";
import { makeHandlerRing, type Hoops } from "./objects/court";
import {
  COURT, RIM, PASS_SPEED, SHOT_CLOCK, QUARTER_TIME, QUARTERS, teamShort,
} from "./config";
import { clamp, dist2D, moveToward2D, chance, rand } from "./util";
import { reactionLag } from "./eval";
import { FreeThrowSystem } from "./systems/freethrow";
import { TipoffSystem } from "./systems/tipoff";
import { InboundSystem } from "./systems/inbound";
import { ScreenSystem } from "./systems/screen";
import { updateSubs } from "./systems/subs";
import { refreshChoiceRanks } from "./systems/lineups";
import { updatePass } from "./action/passing";
import { updateCharge, updateShot } from "./action/shooting";
import { updateLoose, stepBallFreeFlight } from "./core/looseball";
import { updateLive } from "./action/liveball";
import { endQuarter, updateFinale } from "./core/gameflow";
import { syncAll, updateFacing, tickSwish } from "./core/visuals";
import { shotClockViolation } from "./core/deadball";
import { resolveCollisions } from "./core/collision";
import { seatOnBench, updateBenchCheer } from "./core/bench";
import { ROSTER, ROSTER_SIZE, STARTERS, TACTICS, rate, AbilityKey } from "./attributes";

export type BallMode = "held" | "charge" | "pass" | "shot" | "loose" | "inbound" | "tipoff" | "freethrow" | "pause" | "subs" | "finale";

type GameState = "live" | "final";

// 画面上の短いイベント表示（例: "3 POINTS!", "STEAL"）。
export interface GameEvent { text: string; team: number; scorer?: string; assist?: string; }

export class Game {
  readonly players: Player[] = [];   // コート上: [0..4]=チーム0の枠 / [5..9]=チーム1の枠
  readonly roster: Player[][] = [[], []]; // 13人フルロスター（先発+ベンチ）
  subsMade = 0;                      // この試合の交代回数（デバッグ/テレメトリ）
  // 直近の交代。UI が「メンバーチェンジ」フィードとして表示する
  // UI は HOME(チーム0)のチップを先に表示。HOME のチップが1つでも生きている間は
  // AWAY(チーム1)のチップは凍結(ttl が進まず、表示もされない) —
  // つまり HOME の交代を全て流し、消えてから AWAY の交代を最初から流す。
  readonly subEvents: { inNum: number; inName: string; outNum: number; outName: string; team: number; ttl: number }[] = [];
  // 交代の入場/退場アニメ("subs" ボールモード): 各歩行者が自分の目標へ向かい、
  // 全員が到着したらプレー再開(subNext)
  subWalkers: { p: Player; tx: number; tz: number }[] = [];
  subNext: (() => void) | null = null;
  subT = 0;
  // チーム別のベンチ歓声タイマー — 正の間、ベンチは立ち上がって両腕を上げ
  // 跳ねる(短い猶予でジャンプが着地しきる)
  cheerT: [number, number] = [0, 0];
  cheerAmp: [number, number] = [0.5, 0.5];   // 歓声の強さ(ダンク/スリーで大きく)
  readonly ball: Ball;
  readonly ring: Mesh;
  readonly tactics = TACTICS; // チーム別の作戦

  // 一時デバッグ(要削除): チャージ/コンテスト/ブロックのテレメトリ

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
  // スクリーン(ピック&ロール)機能（状態と処理は ScreenSystem が所有 / 方式A）
  readonly screen = new ScreenSystem(this);

  // ---- 現ポゼッションのチーム守備スキーム(resetMotion で決定)
  // 守備側はハーフコートの構えと、運び上げにプレスをかけるかを決める。
  // "" = 素のマンツーマン(この場合は上記の pnr カバレッジが適用される)。
  zoneScheme: "" | "2-3" | "3-2" = "";
  pressOn = false;
  // このフレームのプレストラップ2人目 — 体を寄せる代わりにボールを狙う
  // (ディグ姿勢/スティール)。runPress が設定し、runDefense の毎tickでクリア
  pressTrapper: Player | null = null;
  // ジャスト・パスレシーブ: 飛行中のパスの質(1=ぴったり手元)。リリース時に
  // P精度+散らばりから抽選。捕球時、受け手が次の動作へ移れる速さ(ギャザー時間)を決める。
  passQ = 1;
  // このポゼッションでボールがフロントコートに定着したら true —
  // 以降、ハーフウェイを越えて戻すとバックコートバイオレーション
  frontT = false;
  // 速攻ウィンドウ: ライブボールでのポゼッション交代(スティール/守備リバウンド)
  // 後の数秒間 >0。ボールがまだバックコートにあり守備が戻る途中の間。この間、
  // ハンドラーはリムを突き、ウイングはレーンをスプリントする — オープンコートで
  // SPEED/加速力/敏捷性 が効く場面(ハーフコートはスポット基準)。
  pushT = 0;

  // パスのアニメ
  passFrom = new Vector3();
  passCatch = new Vector3();   // ボールが飛ぶ固定のリードポイント — 一定速度、ガタつきなし
  passMiss = 0;                // 配球が目標から外れる距離(m、P精度依存) — 散らばりと捕球ギャザーの両方に効く
  passMissY = 0;               // 外れパスの縦方向の散らばり(高い/低い)、P精度から
  passTo: Player | null = null;
  passT = 0;
  passDur = 0;
  // パスの種類: chest=通常 / bounce=バウンドパス(相手の手の下を通し床で一つ跳ねる)
  // / jump=ジャンプパス(ダンク級に跳んで最高点から頭上を越して放つ)
  passStyle: "chest" | "bounce" | "jump" = "chest";
  // ジャンプパスのウィンドアップ: 跳んでから放つ — 滞空でこの時間だけ保持する
  pendingPassTo: Player | null = null;
  pendingPassT = 0;
  // 保留中のパスがジャンプパスでなくターンパス(上体の正面〜側面の弧より後ろに
  // いた対象を射程へ入れるため体をピボット)であること。
  pendingPassTurn = false;
  // ノールック(outside): 体を向けていない対象へ、現在の構えのまま振り抜くパス —
  // 別種のノールック・リリースモーション。
  noLookPass = false;
  // ターンパス完了のリリース中のみ設定: 弧チェックをスキップ(既に正対済み)する
  // が、レーン/リスクの安全ゲートはスキップしない(ピボット中にローテートしてきた
  // 守備者はスローを拒否できる — でないと相手へ撃ち込む)。
  turnReleased = false;
  passer: Player | null = null;                         // 現在のパスを放った選手
  passSteal: { def: Player; at: number } | null = null; // パス時に一度だけ決定

  // シュートのアニメ
  shotFrom = new Vector3();
  shotTarget = new Vector3();   // ボールが実際に飛ぶ先 — 成功ならリム、ミスなら的を外した点
  shotMade = false;
  shotWasDunk = false;   // 直前のフィニッシュがダンク(ベンチの歓声が大きくなる)
  shotPoints = 2;
  shotT = 0;
  shotDur = 0;
  shooter: Player | null = null; // 現在シュートを打っている選手
  shooterFinishing = false;      // レイアップ/ダンクで true(リムへ突っ込む)
  finishSpot = new Vector3();    // フィニッシャーがギャザーして跳ぶ位置 — リムの手前、真下ではない
  finishVX = 0;                   // フィニッシュへ持ち込むドライブの勢い(空中で減衰)
  finishVZ = 0;
  shotApex = 2.2;   // 弧の高さ — レイアップ/ダンクは低く、ジャンパーは高い
  evadedFinish = false;   // このフィニッシュは実際のブロック試行をかわした(ダブルクラッチ)
  evadeDirX = 0;          // 空振りしたブロッカーから離れる水平の単位方向 —
  evadeDirZ = 0;          // クラッチでボールを相手の脇へ回す
  // ロングショットのボールカメラ: アーク外からの一発が空中にある間(と着弾後の
  // 一拍)、放送カメラがボール自体を追う。視聴者が放物線を追い、決まるか見られる
  longShot = false;     // 飛行中のシュートが遠距離である
  longShotHoldT = 0;    // 着弾までボールカメラを維持

  // ルーズボール(リバウンド)/インバウンドのタイマー
  looseT = 0;        // ルーズボールが確実に確保されるまでの安全タイムアウト
  looseTips = 0;     // ルーズ中にボールがタップされた回数
  looseOff = 0;      // ボールがこぼれた時の攻撃側チーム(リバウンド表示用)
  lastTouch: Player | null = null;   // 最後にボールに触れた選手 — アウトオブバウンズのスローインを決める
  looseIsRebound = false; // ルーズボールがシュートミス由来なら true
  looseFromTip = false;   // 開始ティップのタップで true — ティップ役+最寄りの相手のみが競る(スクラムなし)
  looseFromRim = false;   // リム接触由来のみ true — 攻撃側の確保でショットクロックがリセットされる唯一のケース
  looseStealBy: Player | null = null;     // はたいて/はじいてこぼした守備者
  looseStealVictim: Player | null = null; // 失ったボールハンドラー/パサー
  looseAge = 0;                            // ボールがルーズになってからの経過時間
  looseGrabAfter = 0;                      // 確保できるまでの遅延(見える形での争奪)
  blockHoldT = 0;                          // はたかれたボールがブロッカーの手に留まる一拍
  blockHoldVel = new Vector3();            // 保持が終わる時に適用されるはじきの速度

  // スローイン/インバウンド機能（状態と処理は InboundSystem が所有 / 方式A）
  readonly inbound = new InboundSystem(this);

  // アシストの記録: 今まさにシュートに繋がったパスを誰が投げ、潜在アシストが
  // 誰に付くか
  assistFrom: Player | null = null;
  assistTo: Player | null = null;
  pendingAssist: Player | null = null; // 現在のシュートが決まれば加算
  // 決めたシュートでファウルされた: ボールは通常どおり飛んで決まり、
  // その後 resolveShot が AND-1 として数え、1本のフリースローへ送る
  pendingAndOne: Player | null = null;

  // 開始のジャンプボール
  // ティップオフ機能（状態と処理は TipoffSystem が所有 / 方式A）
  readonly tipoff = new TipoffSystem(this);

  // フリースロー機能（状態と処理は FreeThrowSystem が所有 / 方式A: Game 参照）
  readonly ft = new FreeThrowSystem(this);

  // デッドボールの一時停止。再開前に得点/ファウルを視聴者が把握できるようにする
  private pauseT = 0;
  private pauseNext: (() => void) | null = null;
  // デッドボールの一時停止中にボールが実際に落下+バウンドしている間 true
  // (例: 得点後にネットを抜けて落ち、バウンドする)
  ballFalling = false;
  coastT = 0;   // ブザー後の短いプレーオン猶予(惰性で少し続く)
  hoops: Hoops | null = null;     // 成功時にスウィッシュさせるネット/リムのメッシュ
  netSwish: [number, number] = [0, 0];   // フープ別のスウィッシュタイマー(>0 でアニメ中)
  swishTeam: [number, number] = [0, 0];  // 誰が決めたか(フラッシュ色)

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
    this.reset();
  }

  /** 得点時にスウィッシュできるよう、フープのネット/リムのメッシュを接続する。 */
  attachHoops(hoops: Hoops): void { this.hoops = hoops; }

  /** カメラが放送のワイドではなくボール自体を追うべき間 true(遠距離シュートの
   *  飛行+着弾後の一拍)。 */
  get camFollowBall(): boolean {
    return (this.ballMode === "shot" && this.longShot) || this.longShotHoldT > 0;
  }

  /** モデル切替（人型 ⇄ どんぐり, HUD_OPTS.model）を全26人へ即時適用する。 */
  applyModelAll(): void {
    for (let t = 0; t < 2; t++) for (const p of this.roster[t]) p.applyModel();
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
  // p の相手チーム（守備側）。効果層の関数(pass-risk 等)へ渡す用。
  oppTeam(p: Player): Player[] {
    return this.teamPlayers(1 - p.team);
  }

  /** チームがコートを入れ替えたら true(後半 = Q3 以降)。 */
  private secondHalf(): boolean {
    return this.quarter >= 3;
  }
  /**
   * この半分で `team` が攻めるゴールの Z 符号(+1 / -1)。ハーフタイムでコートを
   * 入れ替えるので、同じチームが Q3/Q4 では反対のフープを攻める。
   */
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
    // ゾーンブレイク: セットされたゾーンに対し、攻撃側は 1-3-1 型の配置に組み替え、
    // ゾーン守備者の間の隙間に選手を置き、1人がハイポスト(フリースローライン)へ
    // フラッシュする — そこで受けるとゾーンの後列が前に出ざるを得ず、ペイントが開く。
    // 2つの「ブロック」スポットはハイポスト+リム下のダンカーになる。
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
      // ペリメーターのスポットはアークに張り付く(ライン 6.75m): そこで受けると
      // ラインぎりぎりのスリー = 最大確率。遠距離のエリートだけがさらに外へ
      // 流れる(updateOffBallMotion のスポットジョグ参照)。
      new Vector3(0, 0, hz + dir * 7.1),     // トップ(7.1m 外)
      new Vector3(-4.7, 0, hz + dir * 5.3),  // 左ウイング(約7.08m 外)
      new Vector3(4.7, 0, hz + dir * 5.3),   // 右ウイング
      // ディープコーナー: ベースライン近くのコーナースリー(3&D/スポットアップの
      // シューターが待つ場所)。旧来の 2.5m 外のスポットより広くフロアを広げ、
      // 余裕あるスリーを保つ
      new Vector3(-6.7, 0, hz + dir * 1.5),  // 左コーナー
      new Vector3(6.7, 0, hz + dir * 1.5),   // 右コーナー
      // ローブロック、レーンラインのすぐ外 — ポストビッグの定位置。ガードや
      // 本物のストレッチビッグはここを取らない(bestOpenSpot 参照)。
      new Vector3(-2.8, 0, hz + dir * 1.4),  // 左ローブロック
      new Vector3(2.8, 0, hz + dir * 1.4),   // 右ローブロック
    ];
  }

  clampCourt(p: Vector3): void {
    const mw = COURT.halfW - COURT.margin;
    const ml = COURT.halfL - COURT.margin;
    p.x = clamp(p.x, -mw, mw);
    p.z = clamp(p.z, -ml, ml);
  }

  nearestDefenderDist(p: Player): number {
    let best = Infinity;
    for (const d of this.teamPlayers(1 - p.team)) {
      const dd = dist2D(d.pos, p.pos);
      if (dd < best) best = dd;
    }
    return best;
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

  // 精神: >0 = 動揺(精度低下)、<0 = プレッシャーで奮起(精度上昇)。プレッシャーは
  // 疲労、スコアでのビハインド、4Q終盤の接戦から積み上がる。精神80が分岐点:
  // 未満だとプレッシャーが害になり(0で0..1にスケール)、超えると同じプレッシャーが
  // クラッチな選手を後押しする(100で最大 -0.5)。呼び出し側は factor×weight を
  // 引くので、負の factor はバフ。
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
    // 目立つプレーだけが画面バナーになる — 得点、AND-1、ファウル、ピリオドの
    // 区切り。ルーティンの流れ(リバウンド、スティール、ブロック、ミス等)は
    // 画面が散らからないようスコアボードに任せる。得点バナーには画面表示用に
    // 誰が決めたか(誰がアシストしたか)を載せる。
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
      || text === "TIP-OFF"                // 試合が明確に始まる…
      || text === "HALFTIME"
      || text === "2ND HALF"
      || text === "FINAL"
      || text.endsWith("WINS!")            // 試合終了ブザーの勝利コール
      || text === "DRAW"
      || text.startsWith("END OF Q")       // …そして各ピリオドが明確に終わる
      || /^Q\d START$/.test(text);         // …そして明確に再開する
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
        if (i < STARTERS) {
          p.slot = i;
          p.spotIdx = i;
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
  }

  // 背番号は選手の背中、各チームが攻めるバスケットと反対側に付く。
  // ハーフタイムでコートを入れ替える時に再適用する。
  applyNumberSides(): void {
    for (let t = 0; t < 2; t++) {
      const back = -this.attackSign(t);
      for (const p of this.roster[t]) p.setNumberSide(back);
    }
  }

  /** (編集された可能性のある)ロスターのロール/優先度/派生値を再適用する。
   *  能力値はライブ参照なので既に反映済み。ロール/優先度の変更を取り込むため
   *  ティップオフ前の試合前画面から呼ぶ。 */
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

  // 実際のルール: 第2・3・4ピリオドはハーフコートのセットでなく、センターライン
  // (スコアラーテーブルの反対側)からのスローインで始まる。ウイングがミッドコートで
  // スローインし、ポイントガードが戻って受け取り運び上げる。守備はゴール側でマッチ。
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
        const dx = protect.x - man.pos.x, dz = protect.z - man.pos.z;
        const len = Math.hypot(dx, dz) || 1;
        d.pos.set(man.pos.x + (dx / len) * 1.4, 0, man.pos.z + (dz / len) * 1.4);
      }
      // スローイン役(ウイング)はセンターラインのアウトオブバウンズに立つ。
      // PG はミッドコート付近へ戻ってスローインを受ける
      offense[2].pos.set(-(COURT.halfW + 0.3), 0, 0); // センターライン、左サイドライン
    }
    const taker = offense[2];
    this.handler = taker;
    this.ballMode = "inbound";
    this.inbound.t = 1.0;
    this.shotClock = SHOT_CLOCK;
    this.resetMotion();
    this.inbound.receiver = offense[0];           // ポイントガード
    // スローイン準備とともに新ピリオドが目に見えて始まる — どちらのボールか告げる
    this.setEvent(this.quarter === 3
      ? `2ND HALF — ${teamShort(team)} BALL`
      : `Q${this.quarter} START — ${teamShort(team)} BALL`, team, 2.0);
  }

  // ---- メイン更新 --------------------------------------------------------

  update(dt: number): void {
    if (this.eventT > 0) this.eventT = Math.max(0, this.eventT - dt);
    if (this.eventT === 0) this.lastEvent = null;
    // 交代フィードを経過させる。HOME(チーム0)のチップが先。HOME のチップが1つでも
    // 生きている間は AWAY(チーム1)のチップは凍結(ttl 保持、UI も隠す) —
    // つまり HOME の交代を全て流し、消えてから AWAY を流す。
    const homeLive = this.subEvents.some((e) => e.team === 0);
    for (let i = this.subEvents.length - 1; i >= 0; i--) {
      const e = this.subEvents[i];
      if (e.team === 1 && homeLive) continue;   // HOME が消えるまで AWAY を保留
      e.ttl -= dt;
      if (e.ttl <= 0) this.subEvents.splice(i, 1);
    }

    // ベンチが得点を祝う — 全モードで走る(得点は一時停止へ繋がる)。最後の得点も
    // 反映されるよう `final` の早期リターンより前に置く
    updateBenchCheer(this, dt);

    if (this.state === "final") {
      syncAll(this);
      return;
    }

    // 後で実速度を測るため、各自がフレーム開始時にどこにいたか記録
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
      // ブザー: 既に空中の — もしくはギャザー中の — シュートは完了を許す
      // (ブザービーター)。着弾したら resolveShot がピリオド終了を引き継ぐ
      if (this.gameClock <= 0 && this.ballMode !== "shot" && this.ballMode !== "charge") {
        // ホーンが鳴った瞬間に凍結しない — ピリオドが実際に終わる前に、ライブプレーを
        // 一拍だけ惰性で続けさせる(選手は勢いを保ち、ボールは転がり続け/飛行中のパスは
        // 弧を描き切る)。パスは軌道全体が描かれるよう長めのウィンドウを取る。
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

    // 踏ん張るキーパー: ボールを守る下手なハンドラー(keepShieldT)がダブルチームの
    // 押しで後退させられてはならない — 踏ん張る。衝突の押しの前にリムまでの距離を
    // 記録(自分の抑えた じりじり/保持の動きはこのフレームで既に実行済み)。押しで
    // 距離が増えたら、その線まで引き戻す。横方向の小突きは放置し、後退のドリフト
    // ("どんどん下げられる")だけを拒否。前進はそのまま。
    const keeper = this.handler && this.handler.keepShieldT > 0 ? this.handler : null;
    const keepDist0 = keeper ? dist2D(keeper.pos, this.attackFloor(keeper.team)) : 0;
    resolveCollisions(this);
    if (keeper) {
      const rim = this.attackFloor(keeper.team);
      const dx = keeper.pos.x - rim.x, dz = keeper.pos.z - rim.z;
      const now = Math.hypot(dx, dz);
      if (now > keepDist0 + 1e-3) {
        const k = keepDist0 / now;
        keeper.pos.x = rim.x + dx * k;
        keeper.pos.z = rim.z + dz * k;
      }
    }
    const resting = this.ballMode === "pause" || this.ballMode === "freethrow"
      || this.ballMode === "tipoff" || this.ballMode === "subs"
      || this.ballMode === "finale";
    for (const p of this.players) {
      p.updateJump(dt);
      p.tickCooldown(dt);
      p.tickMotion(dt, resting);   // 実速度を計測、疲労のドレイン/回復
      p.updateLegs(dt);            // 計測速度から歩き/走りの脚サイクル
    }
    // ベンチは座って回復し、小さな個人的な仕草でボールを見る — 歓声中
    // (updateBenchCheer がアニメ)や交代の歩行中(目でボールを追うだけ)を除く
    if (this.ballMode !== "finale") {   // フィナーレが全員をフロア外で管理する
      for (let t = 0; t < 2; t++) {
        const cheering = this.cheerT[t] > -1.6;   // updateBenchCheer の収束ウィンドウに合わせる
        for (const p of this.roster[t]) {
          if (this.onCourt(p)) continue;
          p.benchRecover(dt);
          // (ベンチへ/から)歩行者は updateSubs でアニメ。それ以外はアイドル
          if (!this.subWalkers.some((w) => w.p === p) && !cheering) {
            p.benchIdle(dt, this.ball.pos.x, this.ball.pos.z);
          }
        }
      }
    }
    updateFacing(this, dt);
    if (this.longShotHoldT > 0) this.longShotHoldT = Math.max(0, this.longShotHoldT - dt);
    tickSwish(this, dt);   // 成功時のネットスウィッシュ/リムフラッシュ
    syncAll(this);
  }

  /** シミュを進めずに論理状態をメッシュへ反映する — 試合を保留したまま試合前の
   *  カメラツアーが選手を描画する。 */
  syncVisuals(): void { syncAll(this); }

  // ---- ライブプレー(ボール保持中) ---------------------------------------

  // 相対的なボール保持の攻防: 守備者の手(反応/敏捷/守備) 対 ハンドラーの
  // コントロール(D精度/技術 + ドリブルキープ)。>0 なら守備者がボール争いで
  // 勝っている — 下手なハンドラー対素早い手なら失い、上手いハンドラー対弱い手なら
  // 決して失わない。はたきに関する全てがこの差でスケールするので、同じハンドラーでも
  // 弱い相手には安全、強い相手には危うい。
  // ドリブルが手元近くに上がっていれば true(安全)、床に落ちていれば false(露出)。
  // リズム — どれだけ頻繁に手元にあるか — は D精度。
  ballInHand(h: Player): boolean {
    return Math.abs(Math.cos(Math.PI * h.dribblePhase)) > 0.5;
  }

  // 現在のボールハンドラーに割り当てられた守備者(番号でのマンツーマン)。
  onBallDefender(h: Player): Player | undefined {
    return this.teamPlayers(1 - h.team)[h.slot];
  }

  // ライブボールでのポゼッション交代後、ボールがバックコートにあれば速攻ウィンドウ
  // を開く(守備をフロアで抜き去る本物のチャンス)。
  maybeStartPush(): void {
    const h = this.handler;
    if (h && !this.frontT && this.attackSign(h.team) * h.pos.z < 6) this.pushT = 4.5;
  }

  // 自由に選べる時の攻撃サイドを選ぶ: 利き手が主導、逆手頻度が反対側へ行くのを
  // どれだけ厭わないかを決める。
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

  // リム→ハンドラーの線に沿って、リムから `standoff` メートル外の点にハンドラーを
  // 向ける(バスケットへドライブするが手前で止まる)。
  // (tx,tz) へのまっすぐな経路上に立つ体を避けて回る: 前方の通路の最初の数メートルに
  // 別の選手がいる時、接触に突っ込んで衝突の押しで処理させる代わりに、その脇の
  // ステップ地点を狙う。意図的な接触の動き(ポストのグラインド、スクリーン、
  // オンボールの攻防)はこれを呼ばない。`opponentsOnly` は味方をかすめる(スクリーン、
  // ハンドオフ)のを対象外にする。
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
    // ブロッカーがまだ寄せていない側を通す(逸れがフレーム毎にちらつかないよう
    // 決定論的なタイブレーク)
    const side = obLat > 0.05 ? -1 : obLat < -0.05 ? 1 : (p.idx % 2 ? 1 : -1);
    const sx = ob.pos.x - uz * side, sz = ob.pos.z + ux * side;
    // かわされた守備者が応じる: 一拍、新しいレーンの入り口を塞ぐため横へスライド
    // する(runDefense がスライドを実行) — 両者の動きが accelToward/plant を通る
    // ので、速い方が勝つステップの勝負
    if (this.ballMode === "held" && ob.team !== p.team && ob.team !== this.possession) {
      ob.wallT = Math.max(ob.wallT, 0.25);
      ob.wallX = sx;
      ob.wallZ = sz;
    }
    return { x: sx, z: sz };
  }

  setDrive(h: Player, rimFloor: Vector3, standoff: number): void {
    const dx = h.pos.x - rimFloor.x, dz = h.pos.z - rimFloor.z;
    const len = Math.hypot(dx, dz) || 1;
    h.driveTarget.set(
      rimFloor.x + (dx / len) * standoff,
      0,
      rimFloor.z + (dz / len) * standoff,
    );
  }

  // ---- アクション --------------------------------------------------------

  // シュート決断はチャージ(ギャザー)を開始する — 放つ前に一拍ボールを溜める。
  // ウィンドアップは遠距離/低い S技術 ほど長く、キャッチ&シュートで最短。この
  // ギャザーが、マークする選手がシュートを読んでクローズアウトしてコンテストできる
  // ウィンドウ(updateCharge 参照)。実際の成功率/ブロック/放ちはリリース時
  // (releaseShot)に起きる。
  chargeT = 0;
  chargeShooter: Player | null = null;
  chargeDHoop = 0;
  chargeDDef = 0;
  shotWindup = 0;   // 放たれるシュートのギャザー長(tryBlock 用)

  // `target`(シューター/ボール)へのシュートに跳んで挑む。正面で正対(小さな隙間)
  // → 通常の垂直ジャンプで最大の高さ。横にずれている → シュートへの斜めの跳躍:
  // 軌道に手を掛けるため水平にランジし、高さを射程と引き換える(低いジャンプだが
  // 「何とか止める」)。
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

  // シーンを一瞬凍結(デッドボール)し、次のフェーズを走らせる。プレー切り替え前に
  // 得点やファウルを把握させる。
  pauseThen(seconds: number, next: () => void): void {
    this.pauseT = seconds;
    this.pauseNext = next;
    this.ballMode = "pause";
  }

  private updatePause(dt: number): void {
    // 得点後はボールがネットを抜けて床でバウンドする。それ以外は静かに落ち着くだけ
    if (this.ballFalling) stepBallFreeFlight(this, dt);
    else this.ball.pos.y = Math.max(0.3, this.ball.pos.y - 3 * dt);
    // アウトオブバウンズ: スロー役がアナウンス中にスポットへ歩いていく
    // (tickMotion/updateLegs が移動位置から歩行をアニメ)
    if (this.inbound.oobWalker) {
      moveToward2D(this.inbound.oobWalker.pos, this.inbound.oobSpot.x, this.inbound.oobSpot.z,
        this.inbound.oobWalker.runSpeed * 0.6 * dt);
      this.inbound.oobWalker.faceToward(this.inbound.oobSpot.x, this.inbound.oobSpot.z);  // 向かう先を向く(ボールへ後ろ歩きしない)
    }
    this.pauseT -= dt;
    if (this.pauseT <= 0) {
      this.ballFalling = false;
      const next = this.pauseNext;
      this.pauseNext = null;
      if (next) next();
    }
  }

  // ボールを自由に落下する争奪可能な状態にする。`offense` はこぼれた時に攻撃して
  // いたチーム(リバウンド表示/クロックを決める)。
  goLoose(offense: number, timeout: number,
                  opts: { rebound?: boolean; fromRim?: boolean; stealBy?: Player | null; victim?: Player | null; grabAfter?: number; tip?: boolean } = {}): void {
    this.looseOff = offense;
    this.looseT = timeout;
    this.looseTips = 0;
    this.looseIsRebound = opts.rebound ?? false;
    this.looseFromTip = opts.tip ?? false;
    // ボールはリム由来か(本物のリバウンド)? その時だけ攻撃側の確保が
    // ショットクロックをリセット(部分値へ)。ブロック/はたき/ファンブルはリムに
    // 当たっていないので、攻撃側はクロックを回したままプレー続行 — リセットなし
    // (NBAルール7: 14秒リセットにはリム接触が必要)。
    this.looseFromRim = opts.fromRim ?? false;
    this.looseStealBy = opts.stealBy ?? null;
    this.looseStealVictim = opts.victim ?? null;
    this.looseAge = 0;
    this.looseGrabAfter = opts.grabAfter ?? 0;  // 誰かが確保できる前に、ボールが目に見えて自由な一拍
    this.handler = null;
    this.ballMode = "loose";
    for (const p of this.players) p.touchCool = 0;
    // ボールがこぼれた反応: 全員が反応して追うまで一拍必要で、反応がその長さを
    // 決める。反応の速い選手が先に飛びつき、遅い選手はまだ振り向いている途中 —
    // 争奪はもはや最も近くに立っていた者だけが勝つのではない。(reactionLag ≈0.6
    // エリート .. ≈1.35 低い。)
    for (const p of this.players) p.looseReactT = reactionLag(p);
  }

  // ミス後、ボールはリムに跳ねてライブになる: 重力で落ち、手が届く者がタップ
  // または掴む(updateLoose 参照)。
  startRebound(): void {
    const rim = this.attackRim(this.possession);
    this.ball.pos.set(rim.x + rand(-0.3, 0.3), RIM.height + 0.1, rim.z + rand(-0.2, 0.2));
    // リング(鉄)から: 少し上へ、その後外側へ床に向かって
    this.ball.vel.set(rand(-3.4, 3.4), rand(1.2, 3.0), -Math.sign(rim.z || 1) * rand(0.8, 3.6));
    this.goLoose(this.possession, 2.6, { rebound: true, fromRim: true });   // リングから出た

    // ビッグ(とリム直下の誰でも)がボードを争って跳ぶ
    const rimFloor = this.attackFloor(this.possession);
    for (const p of this.players) {
      const d = dist2D(p.pos, rimFloor);
      if (d < 2.8 && (this.isBig(p) || d < 1.4)) p.jump(this.isBig(p) ? 0.7 : 0.5, 0.6);
    }
  }

  // ビッグ(パワーフォワード&センター)がリバウンドに飛び込みスクリーンを掛ける。
  // ポジションのラベルが駆動するので、エディタでのロール変更が反映される。
  isBig(p: Player): boolean {
    return p.role === "PF" || p.role === "C";
  }

  // この選手がハーフコートのセットでローブロックに属するか。ビッグはゴールに
  // 住む — 本物のストレッチ脅威だけが代わりにペリメーターへ広がる(このDBの
  // 圧縮スケールでは稀: C の L精度 は 65..83 なので基準は 75+、または 70+ の
  // ロングレンジ)。ポスト/ペイントのスペシャリストはポジションに関わらずそこに
  // 陣取る。
  prefersPost(p: Player): boolean {
    // 指定された ストレッチ は能力値がどうあれポストせずフロアを広げる。
    // プレイメイキングビッグ はブロックでなくトップから働く。
    // スクリーナー/リムランナー は明示的に内側に住む
    if (p.evalRole === "ストレッチ" || p.evalRole === "プレイメイキングビッグ") return false;
    if (p.evalRole === "スクリーナー" || p.evalRole === "リムランナー") return this.isBig(p);
    if (p.has("post") || p.has("centerSpot")) return true;
    if (!this.isBig(p)) return false;
    const acc = rate(p.attr.threeAcc);
    const stretch = acc >= 0.75 || (p.has("range") && acc >= 0.7);
    if (stretch) return false;
    // ローポストのアンカーは一度に1人: C がポスト型なら、PF は代わりにフロアを
    // 広げる — ゴールに2人のビッグを置くとペイントがスクラムになる(上位で
    // ポスト/ペイントを持つ PF はそれでもそこを取る)
    if (p.role === "PF") {
      const c = this.teamPlayers(p.team).find((q) => q.role === "C");
      if (c && c !== p && this.prefersPost(c)) return false;
    }
    return true;
  }

  // ポゼッションが新たに始まる時に選手が取るフォーメーションスポット: ポストの
  // ビッグは自分のブロックへ直行(PF は左、C は右)、それ以外は自分の枠に対応する
  // ペリメーターのスポットを取る。
  homeSpotIdx(p: Player): number {
    if (this.isBig(p) && this.prefersPost(p)) return p.slot === 3 ? 5 : 6;
    return p.slot;
  }

  // シュート時、ビッグ(PF/C)は激しくリバウンドに飛び込み、ガード/ウイングは
  // 一歩下がって長いリバウンドやトランジションで戻る準備をする。
  crashBoards(dt: number): void {
    const rimFloor = this.attackFloor(this.possession);
    for (const p of this.players) {
      // フィニッシャーはドライブの勢いを空中へ持ち込む: 走っていた速度で踏み切り、
      // その速度は跳躍中に減衰する。先に減速して踏み切る(止まってから跳ぶように
      // 見える)のでなく、踏み切りを勢いのまま通過する。ギャザー地点への軽い
      // ステアリングが彼を巻き込んでリムでフィニッシュさせる。ボールはフープへ上がる。
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
      const big = this.isBig(p) || p.has("centerSpot"); // センター: ビッグのように飛び込む
      // ビッグはリムへ飛び込む。ウイングはリバウンド範囲からサポート。ポイントガードは
      // 速攻を止めるセーフティとして後ろに残る
      const standoff = big ? 0.8 : (p.role === "PG" ? 6.5 : 4.2);
      const dx = p.pos.x - rimFloor.x, dz = p.pos.z - rimFloor.z;
      const len = Math.hypot(dx, dz) || 1;
      const tx = rimFloor.x + (dx / len) * standoff;
      const tz = rimFloor.z + (dz / len) * standoff;
      const speed = p.accelSpeed(dt, big ? 0.95 : 0.6); // ビッグは踏み込み、ガードは下がって残る
      moveToward2D(p.pos, tx, tz, speed * dt);
      this.clampCourt(p.pos);
    }
  }

  // スローイン役が受け手へボールを入れる。捕球でプレーがライブになる。
  throwIn(inb: Player): void {
    const r = this.inbound.receiver ?? this.inbound.pickReceiver(inb);
    this.passFrom.set(inb.pos.x, 1.3, inb.pos.z);
    this.passCatch.set(r.pos.x, 1.3, r.pos.z);   // 飛行が安定するよう固定の目標(どのパスとも同様)
    this.passMiss = 0; this.passMissY = 0; // 妨害のないアウトレットはきれいに届く — 散らばりなし
    this.passStyle = "chest";              // スローインはバウンド/ジャンプのスタイルを継がない
    this.passTo = r;
    this.passer = inb;
    this.passT = 0;
    // P速度 が他のパス同様アウトレットを走らせる。ロング はフラットで速く放つ
    const spd = PASS_SPEED * (0.6 + rate(inb.attr.passSpd) * 0.95) * (inb.has("longThrow") ? 1.3 : 1);
    this.passDur = Math.max(0.3, dist2D(inb.pos, r.pos) / spd);
    this.passSteal = null;                 // スローインはここでは奪われない
    this.ballMode = "pass";
    this.handler = null;
    this.inbound.receiver = null;
    // スロー役は他のパサー同様リリースの間その場に固定される — フォロースルーが
    // 終わるまでコートへ踏み込めない
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
    // ポゼッション交代は保留中のアシストを終わらせ、ボールは改めて運び上げ/
    // フロントコートで定着させる必要がある
    this.assistFrom = this.assistTo = null;
    this.frontT = false;
    this.pushT = 0;   // 新しいポゼッションは以前の速攻ウィンドウをクリア
    this.screen.clear();  // ライブのピック&ロールのカバレッジはポゼッションとともに終わる
  }

  // 守備側はこのポゼッションの構えを決める: 運び上げにプレスをかける? ハーフコート
  // ゾーンで構える(2-3 はペイントを固め、3-2 はペリメーターを守る)? それとも
  // 素のマン(ピック&ロールのカバレッジが適用される)?
  schemePoss = -1;

  // 飛び出し: ライブボールのターンオーバー時、新しい攻撃側のリークアウト走者が
  // 守備が戻る前に即座に自分のバスケットへ走り出す。ライブでのポゼッション交代
  // 箇所で resetMotion()(cutting をクリアする)の後に呼ぶ。
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

  // スティール試行はボールを守備者へワープさせず弾いてルーズにするので、視聴者は
  // ボールがこぼれ、追いかけられるのを見る。巧みな盗り手は自分の方へ弾く(そして
  // ハンドラーはバランスを崩し、一拍掴めない)ので大抵は確保する。弱いはたきは
  // 誰にでも取れる形でこぼす。スティールとターンオーバーは守備が実際に確保した時に
  // 初めて加算される(secureLoose で処理)。
  steal(d: Player): void {
    const h = this.handler;
    if (!h) return;
    // どれだけきれいに守備者の方へ弾かれるか(0=散らばる、~0.7=ぴったり相手へ)。
    // 以前より低く抑え、ボールが弾けて2人の間の床でバウンドする — 争う本物の
    // ルーズボール — ようにする。盗り手の手へまっすぐ吸い込まれる(魔法のような
    // ゴリ押し確保に見える)のを避ける。
    const grip = clamp(0.2 + rate(d.attr.reaction) * 0.55 - rate(h.attr.handling) * 0.3, 0.05, 0.7);
    const ax = d.pos.x - h.pos.x, az = d.pos.z - h.pos.z;
    const len = Math.hypot(ax, az) || 1;
    const ux = ax / len, uz = az / len;            // ハンドラー→守備者
    // 下方向かつ外へ弾かれる — 低く始まり(腰の辺りのドリブルからはたき出される)
    // 床で跳ねるので、ボールは手へ浮くのでなく明らかにオフボールに見える
    const power = rand(2.2, 5.5);   // 広い散らばり — 軽い引っかけ 対 強いはたき出し
    this.ball.pos.set(h.pos.x + ux * 0.35, 0.75, h.pos.z + uz * 0.35);
    this.ball.vel.set(
      ux * power * grip + rand(-2.2, 2.2) * (1 - grip),   // 強い水平方向の飛散
      rand(-0.2, 0.6),                             // 低く — ディグであってロブではない
      uz * power * grip + rand(-2.2, 2.2) * (1 - grip),
    );
    // 長めの自由な一拍(0.35 → 0.55)で、誰かが確保する前にはたき出しの争奪が
    // 実際に見えるようにする — その間、2人のダイバーが手を伸ばす
    this.goLoose(h.team, 1.6, { stealBy: d, victim: h, grabAfter: 0.55 });
    d.digReach(new Vector3(this.ball.pos.x, 0.9, this.ball.pos.z));   // ランジ — 今すぐはたきに手を掛ける
    d.defWin("steal");                             // 争奪が片付いたら祝いのガッツポーズ
    h.touchCool = 0.5;                             // バランスを崩された — 即座には掴めない
  }

  // ---- クォーター / 試合終了 ----------------------------------------------

  // ---- 試合終了ブザーの場面: 勝利の歓喜/うなだれ/分かち合う引き分け ------
  finaleT = 0;
  finaleWinner = -1;   // 0/1 = 勝利チーム、-1 = 引き分け
  finaleWalkers: { p: Player; tx: number; tz: number }[] = [];   // フロアで喜ぶ勝者
  finaleTrudge: { p: Player; tx: number; tz: number }[] = [];    // 落胆して退く敗者

  /** 試合終了ブザー: 勝ったベンチがフロアへなだれ込んで5人を囲み、負けた5人は
   *  うつむいて自ベンチへ重い足取りで退く(負けたベンチは既に着席済み)。引き分けは
   *  両チームがその場で、より控えめに祝う。バナーに "○○ 勝利!" が流れる。 */

}
