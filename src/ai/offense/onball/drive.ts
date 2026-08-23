// 1対1の実行: ドライブの方向決めとフェイク(driveDecision)、ステップバック、ポストの
// 押し込み、速攻のプッシュ。「仕掛けるかどうか」の判断は ./decide。
import { Player } from "../../../objects/player/player";
import { rate, clamp, chance, rand, dist2D, dirTo2D } from "../../../util";
import { reactionLag, jukeDeception, jukeDiscipline, shotThreat, burstTime } from "../../../eval";
import { passToReceiver } from "../../../move/action/passing";
import { finishAtRim } from "../../../move/action/shooting";
import type { Game } from "../../../game";

  // ビッグが相手を押し込む: 背中で守備者を押し下げてリムへ迫る(クロスオーバー/フェイント無し)。
  // ハンドリング非依存 — 接触の強さ=ボディバランス(balance)+postが押し込み・逆押し込みを支配する。
export function postMove(game: Game, h: Player): void {
    const rim = game.attackFloor(h.team);
    const d = game.onBallDefender(h);
    const dRim = dist2D(h.pos, rim);
    // 背負い成立(守備者が自分とリムの間に密着)なら power で背中から押し込む。既存の powerT
    // 前進+壁判定を再利用: 押し込めれば前進しフィニッシュ圏へ、押し負ければ壁で止まり
    // stalledT へ(キック/リトリート)。押し込みの強さ/長さは物理優位(edge)でスケール。
    if (d && dRim > 1.7 && dRim < 6.5 && h.powerT <= 0 && h.stalledT <= 0
        && dist2D(h.pos, d.pos) < 1.5 && dist2D(d.pos, rim) < dRim) {
      const edge = clamp(rate(h.attr.balance) * 0.55 + (h.has("post") ? 0.2 : 0)
        - rate(d.attr.balance) * 0.5 - rate(d.attr.defense) * 0.15, -0.6, 1);
      h.driveSide = game.pickSide(h);
      h.powerT = rand(0.5, 0.85) * (1 + Math.max(0, edge) * 0.5);
      h.postT = h.powerT;   // 背負い(バックダウン)アニメ: 背中をリムへ向けてバックペダル
      game.setDrive(h, rim, Math.max(1.0, dRim - 1.6));   // リムへ一歩押し込む
      return;
    }
    h.driveTarget.set(rim.x, 0, rim.z);   // 背後に守備者無し/至近 → そのままリムへ
  }

  // 速攻: 守備が整う前にリムへ強く押し込む。ウイングがリム付近でオープンなら
  // そこへ通してレイアップさせる。
export function pushBreak(game: Game, h: Player, dHoop: number): void {
    // ボールより前にいる走者がリムでオープン → 落とす
    const rim = game.attackFloor(h.team);
    let best: Player | null = null, bestGap = 1.6;
    for (const p of game.teamPlayers(h.team)) {
      if (p === h) continue;
      const dRim = dist2D(p.pos, rim);
      const ahead = game.attackSign(h.team) * (p.pos.z - h.pos.z) > 1.5;
      if (ahead && dRim < 4.5) {
        const g = game.nearestDefenderDist(p);
        if (g > bestGap) { bestGap = g; best = p; }
      }
    }
    if (best && dHoop > 3 && passToReceiver(game, h, best)) return;
    // さもなければ自分でリムを攻める(後ろの抜かれた守備者は止められない)
    if (dHoop < 1.9) { finishAtRim(game, h, game.nearestDefenderDist(h)); return; }
    game.setDrive(h, rim, 1.5);
  }

  // ハンドラーがドリブルで相手を抜ける状況にあるか: 近く、フロントコートで、
  // クロックに時間があること。
export function canIso(game: Game, h: Player, dHoop: number): boolean {
    if (dHoop > 9 || dHoop < 1.8) return false;
    if (game.shotClock < 3) return false;
    if (game.frontT && game.attackSign(h.team) * h.pos.z < 0.4) return false; // バックコート
    return true;
  }

  // 1対1の核心: どちらへ攻めるかを選び、フェイクで守備者の体重を誤った方向へ
  // 動かし、開いた隙を攻める。
export function driveDecision(game: Game, h: Player): void {
    const d = game.onBallDefender(h);
    if (!d) {
      // 前に誰もいない — 側を選んで真っ直ぐ入るだけ
      h.comboN = 0;
      h.driveSide = game.pickSide(h);
      h.beatenT = Math.max(h.beatenT, rand(0.4, 0.7));
      game.setDriveSide(h);
      return;
    }
    d.reactT = reactionLag(d);    // どんな move も反応を強いる

    // ドリブルで相手を抜く2通り、有利な方で攻める:
    //  • SPEED — クロスオーバーでコーナーを回る
    //  • POWER — 肩を下げてリムへ力任せに押し戻す
    const speedEdge = rate(h.attr.handling) * 0.45 + rate(h.attr.agility) * 0.35
      + rate(h.attr.dribbleAcc) * 0.2 + (h.has("driver") ? 0.1 : 0)
      - (rate(d.attr.agility) * 0.62 + rate(d.attr.reaction) * 0.4
        + rate(d.attr.defense) * 0.55 + (d.has("manMark") ? 0.12 : 0));
    // POWER は物理的な戦い — 押し込みながらボールを保つにはハンドルも要る。
    // 守備者は主にボディバランスに守判断を加えて抵抗する。
    const powerEdge = rate(h.attr.balance) * 0.55 + rate(h.attr.aggression) * 0.2
      + rate(h.attr.dribbleAcc) * 0.2 + rate(h.attr.handling) * 0.15 + (h.has("post") ? 0.15 : 0)
      - (rate(d.attr.balance) * 1.05 + rate(d.attr.defense) * 0.60);

    // 選手自身のツールがスタイルを決める: フィジカルな選手は力で割り込み、
    // 速くハンドルの高い選手はクロスオーバー。その後マッチアップが微調整する。
    const ownPower = rate(h.attr.balance) + rate(h.attr.aggression) * 0.5 + (h.has("post") ? 0.4 : 0);
    const ownSpeed = rate(h.attr.agility) + rate(h.attr.handling) * 0.7 + (h.has("driver") ? 0.4 : 0);
    // 押し込む間はボールが空いた手に出るので、担当以外が寄っていると狙われる。
    // 技術が低い選手は、目の前の相手しか居ない場面でしか選ばない。
    const helpers = game.defendersWithin(h, 2.4) - 1;
    const powerSafe = helpers <= 0
      || chance(clamp(rate(h.attr.handling) * 1.2 - helpers * 0.4, 0, 0.95));
    // ゴール下ほど、そして体の強い選手ほど押し込みを選ぶ(押し切ってイージーシュートにする)。
    const dRim = dist2D(h.pos, game.attackFloor(h.team));
    const rimPull = clamp((7.0 - dRim) / 5.0, 0, 1) * rate(h.attr.balance);
    const usePower = powerSafe && h.comboN === 0 && chance(clamp(0.62 + (ownPower - ownSpeed) * 0.6
      + (powerEdge - speedEdge) * 0.5 + rimPull * 0.55, 0.08, 0.96));   // コンボ途中はドリブルを続ける

    if (usePower) {
      // POWER: 守備者に肩を入れる。力比べに勝てば相手をリムまで押し戻し、
      // 負ければ壁で止められてリセットするしかない。
      h.driveSide = d.shadeSide !== 0 ? -d.shadeSide : game.pickSide(h);
      const pPower = clamp(0.72 + powerEdge * 1.0, 0.18, 0.94);   // 選んだら大抵は押し込みへ(止まるかは接触側で判定)
      if (chance(pPower)) {
        h.powerT = rand(0.55, 0.9) * (1 + Math.max(0, powerEdge) * 0.4);
        d.lean = clamp(d.lean * 0.4, -1, 1);             // 土台を崩された
      } else {
        h.stalledT = rand(0.35, 0.6);                    // 壁に当たった
      }
      game.setDriveSide(h);
      return;
    }

    // SPEED: ドリブルの move で守備者を揺さぶり、開いた隙を攻める。
    const jukeEdge = jukeDeception(h) - jukeDiscipline(d);
    const rim = game.attackFloor(h.team);
    const { ux, uz, len: rl } = dirTo2D(h.pos.x, h.pos.z, rim.x, rim.z);   // リムへ
    const latx = -uz, latz = ux;                                      // 横方向

    // 新規のアタック → ドリブルを計画: 上手いハンドラーは1..3の move を繋ぐ。
    // 序盤は純粋な揺さぶり、最後の move だけが戻れない側を抜いてバーストする。
    if (h.comboN === 0) {
      h.lastFakeDir = 0;
      let plan = 1;
      const pMore = clamp(0.25 + jukeDeception(h) * 0.55, 0.1, 0.8);
      if (chance(pMore)) plan++;
      if (plan > 1 && chance(pMore * 0.6)) plan++;
      h.comboN = plan;
    }
    const finalShake = h.comboN <= 1;

    // 正面の守備者を揺さぶる: ジャブステップイン or サイドステップ。準備の揺さぶりは
    // 左右交互、最後の move は傾きを読んで戻れない側を抜く。
    const stepIn = h.lastFakeDir === 0 && finalShake && chance(0.35);
    let fakeDir: number;
    if (finalShake) {
      // GO 側 = 手で重み付けした守備者の傾きの読み: 片手の選手は利き側に留まり、
      // 両手使いは傾きが与えるものを取る。
      const strong = h.strongSide();
      const beat = (side: number) => clamp(-d.lean * side, -1, 1);
      // 片手の選手を利き手から引き剥がすのは明確な過剰対応だけ
      const handEdge = (h.strongSideBias() - 0.5) * 3.2;   // 0 (両手) .. 約0.65
      const go = beat(strong) + handEdge >= beat(-strong) ? strong : -strong;
      fakeDir = -go;                       // 逆へ誘い込んでから、そこを攻める
    } else {
      fakeDir = h.lastFakeDir !== 0 ? -h.lastFakeDir : -game.pickSide(h);
    }
    let ox: number, oz: number, leanMag: number;
    if (stepIn) {
      ox = ux * 0.35; oz = uz * 0.35; leanMag = 0.7;               // リムへのジャブ
      d.applyReactLag(); // 彼は躊躇する
    } else {
      ox = latx * fakeDir * 0.45; oz = latz * fakeDir * 0.45; leanMag = 1.1; // サイドステップ
    }
    h.jukeT = rand(0.18, 0.3);
    h.jukeTarget.set(h.pos.x + ox, 0, h.pos.z + oz);
    game.clampCourt(h.jukeTarget);

    // 食いつくか？ 揺さぶり vs 規律が体重の振れ幅を決める
    const bite = clamp(0.3 + jukeEdge * 1.1, 0.03, 0.95);
    if (chance(bite)) {
      // 体重がまだ前のフェイクの反対側にあれば、戻りの振りが行き過ぎる
      const across = Math.max(0, -d.lean * fakeDir);
      d.lean = clamp(d.lean + fakeDir * (rand(0.5, 1.0) * leanMag + across * 0.8), -1, 1);
      d.leanAxisX = latx; d.leanAxisZ = latz;   // このデュエルの軸で仕掛けた
    }

    if (!finalShake) {
      // 準備の揺さぶりのみ — 生きたまま、次の move は逆方向から来る
      h.comboN--;
      h.lastFakeDir = fakeDir;
      return;
    }

    // GO move: 最後のフェイクの逆へ、彼の仕掛けた体重が戻れない側を攻める
    h.comboN = 0;
    const go = -fakeDir;
    h.driveSide = go;
    const wrongWay = clamp(-d.lean * go, 0, 1);
    const pBeat = clamp(0.49 + speedEdge * 1.2 + wrongWay * 0.45, 0.02, 0.95);
    if (chance(pBeat)) {
      // バーストはリムまで運ぶ。時間は詰めるべき距離にスケール。
      h.beatenT = burstTime(rl, speedEdge);
      d.applyReactLag();
      // 勢いが彼をさらに誤った方向へ運ぶ — 追い戻しは這うように始まる
      d.lean = clamp(d.lean + go * 0.3, -1, 1);
      d.leanAxisX = latx; d.leanAxisZ = latz;
    } else {
      h.stalledT = rand(0.3, 0.55);
    }
    game.setDriveSide(h);
  }

  // ステップバック: シュートにコンテストする守備者に対してドリブルから後退する。
  // 彼が前へ過剰反応すれば抜き去り、腰を落として留まればジャンパーの距離を得る。
export function stepBack(game: Game, h: Player, d: Player, dHoop: number): void {
    const rim = game.attackFloor(h.team);
    const away = dirTo2D(rim.x, rim.z, h.pos.x, h.pos.z);   // リムから離れる方向
    h.jukeT = rand(0.2, 0.32);
    h.jukeTarget.set(h.pos.x + away.ux * 0.7, 0, h.pos.z + away.uz * 0.7);
    game.clampCourt(h.jukeTarget);

    const threat = shotThreat(h);
    const edge = jukeDeception(h) - jukeDiscipline(d);
    const bait = clamp(0.2 + edge * 0.5 + threat * 0.25, 0.05, 0.82);
    if (chance(bait)) {
      // 彼が前へ突っ込んだ → ステップバックから抜き去る
      h.beatenT = burstTime(dHoop, edge);
      d.applyReactLag();
      d.lean = clamp(d.lean * 0.5, -1, 1);
      h.driveSide = game.pickSide(h);
      game.setDriveSide(h);                              // バーストはリムへ向かう
    } else {
      // 腰を落として留まった → クッションを保ち、次の判断でジャンパーを放たせる
      d.applyReactLag();
      h.driveTarget.copyFrom(h.jukeTarget);
    }
  }
