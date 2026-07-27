// 審判システム: コート上に2人。両サイドライン近くでボール位置に合わせて移動し試合を
// 見守る。得点/ファウルでシグナル、ティップオフのトス、スローインの手渡しを補助する。
// 試合ロジックには関与しない演出専用。
import { Scene, Vector3 } from "@babylonjs/core";
import { Referee } from "../objects/referee";
import { COURT, OOB_WALL } from "../config";
import type { Player } from "../objects/player/player";
import type { Game } from "../game";

interface Acquire {
  ref: Referee; mode: "retrieve" | "throw" | "return"; t: number;
  bx: number; bz: number;         // ボール地点(投げ元 / 拾う地点 / 返球の起点)
  sx: number; sz: number;         // 審判の到達地点(投げ渡し位置 besideSpot)
  startX: number; startZ: number; // 審判の開始位置
  benchThrower?: Player | null;   // ベンチから拾って投げ返す控え選手(いれば)
}

export class RefereeSystem {
  readonly refs: [Referee, Referee];
  private ballRef: Referee | null = null;   // ボール保持中の審判(tipoff/inbound)
  private acq: Acquire | null = null;        // 集球(拾う/受け取る)進行中
  private retrieveHold = false;              // 審判が拾いに行った → 拾った場所からスローワーへ投げる(歩いて戻らない)
  private btX = 0; private btZ = 0;          // ボール当番が歩いて向かう所定位置(ワープ回避)
  private bfX = 0; private bfZ = 0;          // ボール当番が向く先(スローワー)
  thrower: Player | null = null;             // 審判へボールを投げ渡す選手(演出: 腕を振る)
  readonly throwAt = new Vector3();          // その投げ先(審判の手)
  private sideX = COURT.halfW + 0.8;         // サイドラインのすぐ外
  private maxZ = COURT.halfL - 0.6;

  // 目標へ歩いて近づく(瞬間移動でなく等速で寄る)。到着/キャッチ硬直中は止まる。
  // 速度は審判の runSpeed(能力オール50)× mult。mult=0.45で歩き、0.7で軽いジョグ。
  private walkToward(r: Referee, tx: number, tz: number, dt: number, mult = 0.45): void {
    if (r.frozen) return;   // キャッチ硬直中は動かない
    const dx = tx - r.pos.x, dz = tz - r.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.03) return;
    const step = Math.min(d, r.runSpeed * mult * dt);
    r.pos.x += (dx / d) * step; r.pos.z += (dz / d) * step;
  }

  constructor(scene: Scene, private game: Game) {
    this.refs = [new Referee(scene, 0), new Referee(scene, 1)];
    // 初期配置: 各サイドラインのミッドコート付近
    this.refs[0].place(this.sideX, 3);
    this.refs[1].place(-this.sideX, -3);
  }

  // 毎フレーム: ボールを持っていない審判は両サイドラインでボールを追い、見守る。
  update(dt: number): void {
    const g = this.game;
    if (this.acq) this.updateAcq(dt);
    const bx = g.ball.pos.x, bz = g.ball.pos.z;
    for (let i = 0; i < 2; i++) {
      const r = this.refs[i];
      if (r === this.ballRef) {
        if (this.acq && this.acq.ref === r) continue;   // 集球中は updateAcq が位置/ボール/更新を管理
        this.walkToward(r, this.btX, this.btZ, dt);      // 所定位置へ歩く(ワープしない)
        r.faceToward(this.bfX, this.bfZ);
        r.update(dt);
        // 保持中のボールは審判の手に追従(落として歩かない)。ただし tipoff(トス)と inbound
        // (投げ渡し)はそれぞれ tipoff.update / inbound.update がボールを管理するので触らない。
        if (g.ballMode !== "inbound" && g.ballMode !== "tipoff") g.ball.pos.copyFrom(r.ballHold());
        continue;
      }
      const sx = i === 0 ? this.sideX : -this.sideX;
      // 1人はボールの少し前、1人は少し後ろ(z方向にスタッガー)。軽いジョグでボールを追う。
      const tz = clamp(bz + (i === 0 ? 2.5 : -2.5), -this.maxZ, this.maxZ);
      this.walkToward(r, sx, tz, dt, 0.7);
      r.faceToward(bx, bz);                                  // ボールを見る(curSpd は Referee が自算出)
      r.update(dt);
    }
  }

  // 得点シグナル: ボールに近い側の審判が腕を上げて示す。
  signalScore(): void {
    this.nearestToBall().signal("score", 2.4);
  }
  // ファウルシグナル: ボールに近い側の審判が腕を突き上げる。
  signalFoul(): void {
    this.nearestToBall().signal("foul", 2.2);
  }

  private nearestToBall(): Referee {
    const b = this.game.ball.pos;
    return dist2(this.refs[0].pos, b) <= dist2(this.refs[1].pos, b) ? this.refs[0] : this.refs[1];
  }

  // 紹介中/準備中: 審判を両サイドラインへ寄せ、中央に立たせない(選手紹介の邪魔をしない)。
  parkForTipoff(): void {
    this.acq = null; this.ballRef = null; this.thrower = null;
    this.refs[0].place(this.sideX, 3);
    this.refs[1].place(-this.sideX, -3);
  }

  // ティップオフ: センターサークル脇に審判を1人立たせ、ボールを持たせる。トスまで保持。
  tipoffSetup(): Referee {
    const r = this.refs[0];
    this.ballRef = r;
    r.place(1.4, 0);            // サークルの脇(トスは中央の演出なのでここは即配置)
    this.btX = 1.4; this.btZ = 0; this.bfX = 0; this.bfZ = 0;
    r.faceToward(0, 0);
    r.signal("hold", 99);       // トスまで胸に抱える
    return r;
  }
  // トスの瞬間: 審判が両腕を上げてボールを投げ上げる。
  tipoffToss(): void {
    if (this.ballRef) this.ballRef.signal("toss", 1.2);
  }
  // ティップオフ終了: 審判をボール当番から解放し通常巡回へ戻す。
  tipoffDone(): void { this.ballRef = null; this.thrower = null; }

  // 集球開始: プレー停止時、ボールがOOBなら審判が拾いに行き、コート内なら最寄りの選手が
  // 審判へ投げる。どちらも審判がボールを持ってスローイン地点へ運ぶ。startAt から呼ぶ。
  // 集球開始。mode="throw"は必ず「選手が審判へ投げる」(得点後/ファウル)、"retrieve"は必ず
  // 「審判が拾いに行く」(OOB)、"auto"は近く(3.5m以内)に選手がいれば投げ、いなければ拾いに行く。
  // 投げ手はボールを取るチーム(possession)の最寄り選手(インバウンダー除く)。
  acquireBall(bx: number, bz: number, sx: number, sz: number, mode: "auto" | "throw" | "retrieve" = "auto"): void {
    this.retrieveHold = false;                             // 新規集球 → 拾い留まりフラグをクリア
    const bs = this.besideSpot(sx, sz);                    // 投げ渡し位置(スローワー横)
    const ref = this.pickSideRef(sx);                      // 同サイドの審判(逆サイドが回ってこない)
    this.ballRef = ref;
    this.btX = bs.x; this.btZ = bs.z; this.bfX = sx; this.bfZ = sz;
    ref.signal("hold", 99);
    const thrower = this.nearestPlayer(bx, bz);
    const near = !!thrower && dist2d(thrower.pos, bx, bz) <= 3.5;
    const doThrow = !!thrower && (mode === "throw" || (mode === "auto" && near));
    if (doThrow) {
      // 選手が審判へ投げる(選手が腕を振る演出付き)。審判は投げ渡し位置へ短距離歩く。
      this.thrower = thrower;
      this.acq = { ref, mode: "throw", t: 0, bx, bz, sx: bs.x, sz: bs.z, startX: ref.pos.x, startZ: ref.pos.z };
    } else {
      // OOB。壁を越えて飛んで行った場合だけ、向こうから審判へ山なりに投げ返される(return)。
      // コートと壁の間(アプロン)で止まった場合は今まで通り: 近くの選手/ベンチが拾って投げ、
      // 誰も近くにいなければ審判が歩いて拾いに行く(retrieve)。ボールが勝手に審判へ飛ばない。
      this.thrower = null;
      const atWall = Math.abs(bx) >= COURT.halfW + OOB_WALL - 0.3 || Math.abs(bz) >= COURT.halfL + OOB_WALL - 0.3;
      const bench = !atWall && bx > COURT.halfW - 0.5 ? this.nearestBenchPlayer(bx, bz) : null;
      if (atWall) {
        // 壁を越えた → 向こうから山なりに投げ返される
        this.acq = { ref, mode: "return", t: 0, bx, bz, sx: bs.x, sz: bs.z, startX: ref.pos.x, startZ: ref.pos.z };
      } else if (bench && dist2d(bench.pos, bx, bz) < 4) {
        bench.stand();   // アプロンのベンチ付近: 控えが立って拾って投げる(腕は updateAcq が直接ポーズ)
        this.acq = { ref, mode: "throw", t: 0, bx: bench.pos.x, bz: bench.pos.z,
          sx: bs.x, sz: bs.z, startX: ref.pos.x, startZ: ref.pos.z, benchThrower: bench };
      } else if (near) {
        // アプロン: コート上の最寄り選手が拾って投げる(今まで通り)
        this.thrower = thrower;
        this.acq = { ref, mode: "throw", t: 0, bx, bz, sx: bs.x, sz: bs.z, startX: ref.pos.x, startZ: ref.pos.z };
      } else {
        // アプロンで止まり誰も近くにいない → 審判が歩いて拾いに行く(勝手に飛ばさない)
        this.acq = { ref, mode: "retrieve", t: 0, bx, bz, sx: bs.x, sz: bs.z, startX: ref.pos.x, startZ: ref.pos.z };
      }
    }
  }

  get acqActive(): boolean { return this.acq !== null; }

  // ボールを取るチーム(possession)の最寄り選手(インバウンダー=handler は除く)。
  private nearestPlayer(x: number, z: number): Player | null {
    let best: Player | null = null, bd = Infinity;
    for (const p of this.game.teamPlayers(this.game.possession)) {
      if (p === this.game.handler) continue;
      const d = dist2d(p.pos, x, z); if (d < bd) { bd = d; best = p; }
    }
    return best;
  }

  // OOB地点に最も近い着席中の控え選手(両チームのベンチから)。いなければ null。
  private nearestBenchPlayer(x: number, z: number): Player | null {
    let best: Player | null = null, bd = Infinity;
    for (let t = 0; t < 2; t++) {
      for (const p of this.game.allPlayers(t)) {
        if (this.game.onCourt(p) || !p.seated) continue;
        const d = dist2d(p.pos, x, z); if (d < bd) { bd = d; best = p; }
      }
    }
    return best;
  }

  // スローイン地点の x サイドにいる審判を選ぶ(逆サイドの審判が横切ってこないように)。
  private pickSideRef(sx: number): Referee { return sx >= 0 ? this.refs[0] : this.refs[1]; }

  // スローワー横(ライン沿い、コート外)の投げ渡し位置。サイドラインはz方向、ベースはx方向へ約2.2m。
  private besideSpot(spotX: number, spotZ: number): { x: number; z: number } {
    const onSide = Math.abs(spotX) > COURT.halfW - 0.5;
    if (onSide) return { x: spotX, z: clamp(spotZ - Math.sign(spotZ || 1) * 2.2, -(COURT.halfL - 0.5), COURT.halfL - 0.5) };
    return { x: clamp(spotX - Math.sign(spotX || 1) * 2.2, -(COURT.halfW - 0.5), COURT.halfW - 0.5), z: spotZ };
  }

  private updateAcq(dt: number): void {
    const a = this.acq!; a.t += dt; const g = this.game;
    if (a.t > 4) { g.ball.pos.copyFrom(a.ref.ballHold()); this.finishBench(a); this.acqDone(); return; }   // 安全上限
    if (a.mode === "return") {
      // 壁を越えた返球: 即座に反射させず、まず壁を貫通してさらに外へ飛んで消え(FLY)、少ししてから
      // 壁の向こうから審判の手へ山なりに帰ってくる(RETURN)。審判は投げ渡し位置へ歩き、来る方向を向く。
      this.walkToward(a.ref, a.sx, a.sz, dt);
      a.ref.faceToward(a.bx, a.bz);
      const rh = a.ref.ballHold();
      const FLY = 0.6;      // 壁を貫通して外へ飛んで行く時間
      // ボールが越えた壁の外向き方向と、壁の向こうの点(帰ってくる起点)
      const outX = Math.abs(a.bx) >= COURT.halfW + OOB_WALL - 0.3 ? Math.sign(a.bx) : 0;
      const outZ = Math.abs(a.bz) >= COURT.halfL + OOB_WALL - 0.3 ? Math.sign(a.bz) : 0;
      const beyondX = a.bx + outX * 2.5, beyondZ = a.bz + outZ * 2.5;
      if (a.t < FLY) {
        // 貫通: 壁を越えてさらに外へ飛び、放物線で下へ抜けて視界外へ消える
        const p = a.t / FLY;
        g.ball.pos.set(a.bx + (beyondX - a.bx) * p, 1.8 - 2.2 * p * p, a.bz + (beyondZ - a.bz) * p);
        a.ref.update(dt);
        return;
      }
      // 少し置いてから、壁の向こうから審判の手へ山なりに帰ってくる
      const k = clamp((a.t - FLY) / 1.1, 0, 1);
      if (k < 1) {
        const arc = 3.0 * Math.sin(k * Math.PI);   // 高い山なり
        g.ball.pos.set(beyondX + (rh.x - beyondX) * k, 0.3 + (rh.y - 0.3) * k + arc, beyondZ + (rh.z - beyondZ) * k);
      } else {
        g.ball.pos.copyFrom(rh); a.ref.catch(); this.acqDone();
      }
      a.ref.update(dt);
      return;
    }
    if (a.mode === "retrieve") {
      // 拾いに行く: 審判が自分の位置→ボール地点へ歩いて拾い、その場所からスローワーへ投げる
      // (投げ渡し位置まで歩いて戻らない)。
      const WALK = 1.0;   // ボールへ歩く
      if (a.t < WALK) {
        const k = a.t / WALK;
        a.ref.pos.x = a.startX + (a.bx - a.startX) * k;
        a.ref.pos.z = a.startZ + (a.bz - a.startZ) * k;
        a.ref.faceToward(a.bx, a.bz);
        g.ball.pos.set(a.bx, 0.15, a.bz);   // ボールは床で待つ
      } else {
        // 拾った → その場に留まってボールを持ち、スローワー地点の方を向く。以降 inbound が
        // この場所から投げる(inboundSetup が retrieveHold で handoff 位置へ歩かせない)。
        a.ref.pos.set(a.bx, 0, a.bz);
        a.ref.faceToward(a.sx, a.sz);
        g.ball.pos.copyFrom(a.ref.ballHold());
        this.acqDone();
        this.btX = a.bx; this.btZ = a.bz;   // 拾った場所に固定(歩かせない)
        this.bfX = a.sx; this.bfZ = a.sz;
        this.retrieveHold = true;
      }
    } else {
      // 選手が投げる: 審判は投げ渡し位置へ歩いて向かい(同サイド・短距離)、ボールが
      // ボール地点から審判へ放物線で飛ぶ。審判は投げ元を向く。選手側の腕は poseHands が振る。
      this.walkToward(a.ref, a.sx, a.sz, dt);
      a.ref.faceToward(a.bx, a.bz);
      const k = clamp(a.t / 0.8, 0, 1);
      const rh = a.ref.ballHold();
      this.throwAt.copyFrom(rh);   // 投げ手の選手が腕を向ける先(審判の手)
      // ベンチの控えが投げる場合: コート外なので毎フレーム更新されない。審判の方を向かせ、両手を
      // 審判(ボール先)へ伸ばす投げモーションを直接ポーズして描画同期する(lastDt を与えて腕をイーズ)。
      if (a.benchThrower) {
        const bt = a.benchThrower;
        bt.lastDt = dt;
        bt.faceToward(rh.x, rh.z);
        bt.reach(new Vector3(rh.x, rh.y, rh.z), true);
        bt.sync();
      }
      if (k < 1) {
        const arc = 1.4 * Math.sin(k * Math.PI);
        g.ball.pos.set(a.bx + (rh.x - a.bx) * k, 1.4 + (rh.y - 1.4) * k + arc, a.bz + (rh.z - a.bz) * k);
      } else {
        g.ball.pos.copyFrom(rh);
        this.finishBench(a);         // 控えは投げ終わって着席へ戻す
        this.thrower = null;         // 投げ終わり → 選手の投げモーション解除
        a.ref.catch();              // 審判は両手でキャッチ + 硬直
        this.acqDone();
      }
    }
    a.ref.update(dt);
  }

  // ベンチの控えが投げ終わったら着席に戻す(コート外なので明示的に座らせて同期)。
  private finishBench(a: Acquire): void {
    if (a.benchThrower) { a.benchThrower.sit(); a.benchThrower.sync(); a.benchThrower = null; }
  }

  // 集球完了: ボール当番の審判が投げ渡し位置で保持する状態へ移行(以降 inbound.update が投げる)。
  private acqDone(): void {
    if (!this.acq) return;
    this.btX = this.acq.sx; this.btZ = this.acq.sz;
    this.thrower = null;
    this.acq = null;
  }

  // スローイン: 地点に最も近い審判をライン外(スローワー脇)に立たせ、ボールを保持させる。
  // handoffSpot: スローワーの立ち位置。審判はその少しライン外側に立つ。
  inboundSetup(spotX: number, spotZ: number): Referee {
    // 集球でボールを持った審判を引き継ぐ。いなければ同サイドの審判を選ぶ(逆サイドが横切らない)。
    const r = this.acq ? this.acq.ref : this.pickSideRef(spotX);
    this.acq = null;                 // 集球完了 → 通常の保持/投げ渡しへ
    this.ballRef = r;
    if (this.retrieveHold) {
      // 審判が拾いに行った → 拾った場所(現在地)からスローワーへ投げる。投げ渡し位置へ歩かせない。
      this.retrieveHold = false;
      this.btX = r.pos.x; this.btZ = r.pos.z; this.bfX = spotX; this.bfZ = spotZ;
    } else {
      // スローワーの横(ライン沿い、コート外)を「所定位置」に。そこへ歩いて向かう(ワープしない)。
      const bs = this.besideSpot(spotX, spotZ);
      this.btX = bs.x; this.btZ = bs.z; this.bfX = spotX; this.bfZ = spotZ;
    }
    r.signal("hold", 99);
    return r;
  }
  // スローイン開始: 審判をボール当番から解放(スローワーに渡し終えた)。
  inboundDone(): void { this.thrower = null; if (this.ballRef) { this.ballRef.signal("hold", 0.4); this.ballRef = null; } }

  // 現在ボール当番の審判(ボール位置を管理する側)。いなければ null。
  get onBallRef(): Referee | null { return this.ballRef; }

  // モデル切替(人型⇄どんぐり)を審判にも反映し、審判色に再着色し直す。
  applyModel(): void { for (const r of this.refs) { r.body.applyModel(); r.recolor(); } }
}

function clamp(v: number, lo: number, hi: number): number { return v < lo ? lo : v > hi ? hi : v; }
function dist2(a: Vector3, b: Vector3): number { const dx = a.x - b.x, dz = a.z - b.z; return dx * dx + dz * dz; }
function dist2d(a: Vector3, x: number, z: number): number { const dx = a.x - x, dz = a.z - z; return dx * dx + dz * dz; }
