// パス処理（受け手選択・投球・飛行/受球）。Option B: 状態は Game(=GameState)が持ち、
// ここは game を受け取る関数群。パスのリスク/インターセプト計算は resolution/pass-risk。
import { Player } from "../objects/player/player";
import { COURT, PASS_SPEED, MAX_PASS, SHOT_CLOCK } from "../config";
import { rate } from "../attributes";
import { clamp, chance, rand, dist2D, dist2DTo, moveToward2D } from "../util";
import { twWeight, effShootRange, reactionLag } from "../eval";
import { laneVetoed, passRisk, evalInterception, longBallRead } from "../reaction/pass-risk";
import { runDefenseDuringDeadish } from "./defense";
import { updateOffBallMotion, bestOpenSpot } from "./offball";
import { turnover } from "../core/deadball";
import { doubleTeamed } from "../core/reads";
import type { Game } from "../game";

// 投げるべき味方を選び、投げてよいか判定する。カバーされた受け手には投げない。
export function chooseReceiver(game: Game, h: Player): Player | null {
  const rimFloor = game.attackFloor(h.team);
  const tac = game.tactics[h.team].offense;
  // 持ち運び中 vs セット: フロントコートで確立(frontT)するまではアウトレット規則
  const backcourt = !game.frontT || dist2D(h.pos, rimFloor) > 14;

  // 今どれだけインターセプトのリスクを許容するか: パス巧者/ボールムーブ戦術は細い窓を
  // 通し、ショットクロック終盤は急ぐ
  const urgency = game.shotClock < 6 ? (6 - game.shotClock) / 6 : 0; // 0..1
  const vsZone = game.zoneScheme !== "";
  const riskTolerance = clamp(
    0.12 + rate(h.attr.passAcc) * 0.2 + rate(h.attr.offense) * 0.1
    + (h.has("outside") ? 0.08 : 0)   // アウトサイド: 難角度を信じる
    + (vsZone ? 0.08 : 0)             // ゾーンへはスキップパス
    + tac.ballMovement * 0.15 * twWeight(h) + urgency * 0.35,
    0.10, 0.55);

  let best: Player | null = null;
  let bestScore = -Infinity;
  for (const p of game.teamPlayers(h.team)) {
    if (p === h) continue;
    if (dist2D(h.pos, p.pos) > MAX_PASS) continue;   // 現実的な射程外
    // フロントコート確立後、ハーフより後ろへの返しは違反 — 候補にしない
    if (game.frontT && game.attackSign(h.team) * p.pos.z < 0.4) continue;
    // レーンに体を置かれたら計算前にパス不可
    if (laneVetoed(game.oppTeam(h), h, p)) continue;
    const risk = passRisk(game.oppTeam(h), h, p);

    // リム際でワイドオープンのカッターは賭ける価値あり。それ以外は許容超のリスクは拒否
    const atRimCutter = p.cutting && dist2D(p.pos, rimFloor) < 3.5 && risk < 0.5;
    if (risk > riskTolerance && !atRimCutter && game.shotClock > 2) continue;

    const open = game.nearestDefenderDist(p);
    // 守備が張り付いた受け手は的でない(守備へのパスに見える)
    if (open < 1.4 && !atRimCutter && game.shotClock > 2) continue;
    // ダブルチームへは絶対に戻さない(トラップループを再開させる)
    if ((doubleTeamed(game, p) || p.trappedT > 0) && !atRimCutter && game.shotClock > 2) continue;
    const progress = 1 / (1 + dist2D(p.pos, rimFloor)); // リムに近いほど良い
    // vision: 低い攻判断は各選択肢の良さを見誤る
    let value = open + progress * 3 + rand(-1, 1) * (1 - rate(h.attr.offense)) * 0.8;
    if (p.cutting) value += 1.5;            // カッターへのフィードを評価
    if (atRimCutter) value += 1.5;          // …特にリムで空いている者
    if (p.openRollT > 0) value += 2.0;      // 守備が空けたローラーへのポケットパス
    // お膳立て: 良いパサーはオープンシューターを狩る(P精度が高いほど優先)
    if (open > 1.8 && dist2D(p.pos, rimFloor) <= effShootRange(p) + 0.3) {
      value += (0.5 + rate(h.attr.passAcc) * 1.3) * clamp((open - 1.8) / 2, 0, 1);
    }
    // インサイドアウト vs ゾーン: ゾーンがローテできないオープンマンへ回す
    if (vsZone) {
      const dRim = dist2D(p.pos, rimFloor);
      if (open > 1.6 && dRim > 5.5) value += 1.4;      // ギャップのオープンシューターへキック
      else if (dRim > 3.5 && dRim < 5.5) value += 1.0; // ハイポスト/ショートコーナーへ
    }
    // スルーパス: カッターへのキラーフィードに生きる
    if (h.has("throughPass") && p.cutting) value += 1.5;
    // フィードしてくれた相手にただ返さない(本当にリムへカットしている時を除く)
    if (p === game.assistFrom && game.assistTo === h
        && !(p.cutting && dist2D(p.pos, rimFloor) < 6.5)) {
      value -= 3.0;
    }
    // 手放したばかりの味方には返さない(ピンポン防止)。本当のリムカットはフラグ解除済み。
    if (p.justPassedT > 0 && !atRimCutter) continue;
    if (backcourt) {
      // 持ち運びはガードの仕事: プレイメーカーへアウトレット。ビッグは本当のヒットアヘッド時のみ
      if (game.isBig(p) && dist2D(p.pos, rimFloor) > 6 && game.shotClock > 4) continue;
      value += p.playmaking * 4.0;
    }
    else value += p.offPriority * 2.2 * clamp(open / 2, 0, 1);   // プライマリ(選択順)へ集める
    // 期待値: カットされる確率で割り引く
    const score = value * (1 - risk) - risk * 2.5;
    if (score > bestScore) { bestScore = score; best = p; }
  }
  return best;
}

export function pass(game: Game, h: Player): boolean {
  const target = chooseReceiver(game, h);
  if (!target) return false;
  return passToReceiver(game, h, target);
}

// 指定の受け手へ投げる(一般の読みと、より良い得点機会へのスイング判断の双方から使う)。
export function passToReceiver(
  game: Game, h: Player, target: Player, force = false,
  style: "chest" | "bounce" | "jump" = "chest",
): boolean {
  game.passStyle = style;
  game.noLookPass = false;
  // パスアーク: 両手パスは上半身の前〜横(±90°)からのみ出る。後方の相手へはまずピボット
  // (短いワインドアップ)。ノールック(outside)は例外。強制フィード/ワインドアップ中はスキップ。
  if (!force && !game.turnReleased && !game.pendingPassTo) {
    const rel = h.relativeChestAngle(target.pos.x, target.pos.z);
    if (Math.abs(rel) > Math.PI / 2) {
      if (h.has("outside")) {
        game.noLookPass = true;                        // スタンスから → ノールック
      } else {
        game.pendingPassTo = target;
        game.pendingPassTurn = true;
        const excess = Math.abs(rel) - Math.PI / 2;
        game.pendingPassT = clamp(0.12 + excess * 0.42, 0.12, 0.55);
        return true;                                   // 確定; ピボット後にリリース
      }
    }
  }
  // ボールは受け手へホーミングするので、重要なのはキャッチ点までの距離。走る受け手を
  // 速度でリード。P速度が球威を決める(0.6×..1.55×)。
  const zip0 = PASS_SPEED * (0.6 + rate(h.attr.passSpd) * 0.95);
  const d0 = dist2D(h.pos, target.pos);
  const lead = d0 / zip0;                              // 第一次の飛行時間
  // コート外を狙わない: サイドラインを走る受け手はライン沿いにリード
  const cx = clamp(target.pos.x + target.velX * lead, -(COURT.halfW - 0.35), COURT.halfW - 0.35);
  const cz = clamp(target.pos.z + target.velZ * lead, -(COURT.halfL - 0.35), COURT.halfL - 0.35);
  const d = Math.hypot(cx - h.pos.x, cz - h.pos.z);    // 実飛行距離
  if (d > MAX_PASS + 1.5) return false;                // 一発は無理 — 保持

  // クロック終盤の現実チェック: 滞空後に撃つ時間が残らないなら投げない
  if (game.shotClock < 2.2 && game.shotClock - d / zip0 < 0.9) return false;

  // 全パス共通の最終安全ゲート: レーン守備/高リスク/ダブルチームへは投げない(唯一の
  // チョークポイント)。本当のリムカッター(ギブ&ゴー)のみ例外。
  if (!force && game.shotClock > 2
      && (laneVetoed(game.oppTeam(h), h, target)
        || passRisk(game.oppTeam(h), h, target) > 0.3
        || (!target.cutting && game.nearestDefenderDist(target) < 1.0)
        || (!target.cutting && (doubleTeamed(game, target) || target.trappedT > 0)))) {
    return false;
  }

  // リリース高さ: ジャンプパスは守備の頭上
  game.passFrom.set(h.pos.x, style === "jump" ? 2.0 : 1.1, h.pos.z);
  game.passCatch.set(cx, 1.1, cz);   // 固定リード点へ飛ぶ → 一定速
  game.passTo = target;
  game.passer = h;
  game.passT = 0;
  const fade = d > 12 ? clamp(1 - (d - 12) * 0.05, 0.85, 1) : 1;
  game.passDur = Math.max(0.22, d / (zip0 * fade));
  if (style === "bounce") game.passDur *= 1.3;   // 床バウンドが勢いを削ぐ
  // パス品質: P精度が高いほど胸元へジャスト(常にブレ幅あり)。ロングは収まりにくい。
  game.passQ = clamp(0.18 + rate(h.attr.passAcc) * 0.72 + rand(-0.28, 0.28)
    - Math.max(0, d - 9) * 0.03, 0, 1);
  // P精度 = 実際にどこへ落ちるか(メートル)。低精度は明確に散らす(~0.2m..~1.6m)。
  const acc = rate(h.attr.passAcc);
  game.passMiss = clamp(((1 - acc) * 3.0 + Math.max(0, d - 9) * 0.06) * rand(0.65, 1.2), 0, 3.3);
  const ang = rand(0, Math.PI * 2);
  game.passCatch.set(cx + Math.cos(ang) * game.passMiss, 1.1, cz + Math.sin(ang) * game.passMiss);
  game.passMissY = rand(-1, 1) * game.passMiss * 0.55;   // 高い/低い配球も
  game.passSteal = evalInterception(game.oppTeam(h), h, target, game.passStyle);
  // 滞空するロングは誰も真正面に居なくても走り込んで取れる
  if (!game.passSteal && d > 9) {
    game.passSteal = longBallRead(game.oppTeam(h), h, target, game.passDur, d);
  }
  // トラップからの強制: 巧いパサー(P精度)は通す — 能力が決める。雑なパサーはカットされる。
  if (force && game.passSteal && chance(rate(h.attr.passAcc) * 0.6)) {
    game.passSteal = null;
  }
  game.ballMode = "pass";
  game.handler = null;
  // フォロースルー硬直: P精度が高いほど速く復帰(~0.3s)、雑だと最大~2.5s。
  h.coolT = clamp((0.3 + (1 - rate(h.attr.passAcc)) * 2.2) * rand(0.9, 1.1), 0.3, 2.5);
  // 手放したばかり: ~1.6s は真っ直ぐ返さない(2人ピンポン防止)。本当のリムカットは解除。
  h.justPassedT = 1.6;
  // ダブルチームからの脱出: 即座に戻さず(ギブ&ゴーで罠へ戻らない)、オープンスペースへ。
  if (doubleTeamed(game, h)) {
    h.justPassedT = 3.0;
    h.cutting = false;
    h.offTimer = rand(0.8, 1.6);
    h.spotIdx = bestOpenSpot(game, h.team, game.formationSpots(h.team), h);
  } else if (chance(0.28)) {
    // ギブ&ゴーは時々(毎回だとピンポン)。通常は再配置。
    const rim = game.attackFloor(h.team);
    h.cutting = true;
    h.justPassedT = 0;                     // 本物のギブ&ゴーカッターは的
    h.offTimer = rand(1.5, 3.0);
    h.offTarget.set(rim.x + rand(-0.6, 0.6), 0, rim.z - Math.sign(rim.z) * 0.4);
  } else {
    h.cutting = false;
    h.offTimer = rand(0.6, 1.4);
    h.spotIdx = bestOpenSpot(game, h.team, game.formationSpots(h.team), h);
  }
  return true;
}

export function updatePass(game: Game, dt: number): void {
  // パス中もオフボール+守備は動き続ける
  runDefenseDuringDeadish(game, dt);
  updateOffBallMotion(game, dt, game.possession, game.passTo);

  // このパスを跳ぶと決めた守備者は、ボール到達より先にインターセプト点へ全力で走る
  if (game.passSteal && game.passTo) {
    const d = game.passSteal.def;
    const ix = game.passFrom.x + (game.passCatch.x - game.passFrom.x) * game.passSteal.at;
    const iz = game.passFrom.z + (game.passCatch.z - game.passFrom.z) * game.passSteal.at;
    moveToward2D(d.pos, ix, iz, d.accelSpeed(dt, 1.08) * dt);
    game.clampCourt(d.pos);
  }

  // パスを受ける: 受け手はキャッチ点へ迎えに来る(残り時間で残りギャップを詰める、ランジ
  // スプリント上限)。オフターゲット配球だと体が流れる(=ズレて取る)。
  if (game.passTo) {
    const r = game.passTo;
    const remain = Math.max(dt, game.passDur - game.passT);
    const gap = dist2DTo(r.pos, game.passCatch.x, game.passCatch.z);
    if (gap > 0.02) {
      const need = gap / remain;                        // 間に合うm/s
      const spd = Math.min(need, r.runSpeed * 1.35);    // ランジスプリントまで
      moveToward2D(r.pos, game.passCatch.x, game.passCatch.z, spd * dt);
      game.clampCourt(r.pos);
    }
  }

  game.passT += dt;
  const k = Math.min(1, game.passT / game.passDur);
  const a = game.passFrom, b = game.passCatch;   // 固定リード点 → 一定速
  const endY = 1.0 + game.passMissY;             // オフパスは高い/低いへも
  if (game.passStyle === "bounce") {
    // バウンドパス: 手元→床(58%)→受け手の手元(相手の手の下をくぐるV字)
    const kb = 0.58;
    const y = k < kb
      ? a.y + (0.12 - a.y) * (k / kb)
      : 0.12 + (Math.max(0.7, Math.min(endY, 0.95)) - 0.12) * ((k - kb) / (1 - kb));
    game.ball.pos.set(a.x + (b.x - a.x) * k, y, a.z + (b.z - a.z) * k);
  } else {
    // chest 従来 / jump は高いリリース(a.y=2.0)から胸へ
    const arc = game.passStyle === "jump" ? 0.25 : 0.4;
    game.ball.pos.set(
      a.x + (b.x - a.x) * k,
      (a.y + (endY - a.y) * k) + Math.sin(k * Math.PI) * arc,
      a.z + (b.z - a.z) * k,
    );
  }

  // インターセプト: パス時に一度決定、ボールが守備者の点に達したら発火。名手は綺麗に、
  // それ以外は指先だけで弾く。
  if (game.passSteal && k >= game.passSteal.at) {
    const d = game.passSteal.def;
    game.passSteal = null;
    const offense = game.possession;
    const catchP = 0.4 + rate(d.attr.reaction) * 0.45 + (d.has("interceptor") ? 0.15 : 0);
    if (chance(clamp(catchP, 0.2, 0.95))) {
      d.stats.stl++;
      if (game.passer) game.passer.stats.tov++;
      game.handler = d;
      game.possession = d.team;
      game.ballMode = "held";
      game.shotClock = SHOT_CLOCK;
      d.decisionT = 0.4;
      game.ball.vel.set(0, 0, 0);
      game.resetMotion();
      game.maybeStartPush();   // ピックオフは最も綺麗な速攻開始
      game.leakOut();      // 飛び出しが走り出す
      game.setEvent("INTERCEPTED", d.team);
    } else {
      // 弾かれた: 手に当たってライブ
      game.ball.pos.set(d.pos.x, 1.2, d.pos.z);
      game.ball.vel.set(rand(-3.8, 3.8), rand(1.2, 2.6), rand(-3.8, 3.8));
      game.goLoose(offense, 2.0, { stealBy: d, victim: game.passer, grabAfter: 0.3 });
      game.setEvent("DEFLECTED", d.team);
    }
    return;
  }

  if (k >= 1) {
    const receiver = game.passTo!;
    // スローアウェイ: 散った配球がコート外へ — ボールはそこで死ぬ(パサーのTO、逆のスローイン)
    if (Math.abs(game.passCatch.x) > COURT.halfW || Math.abs(game.passCatch.z) > COURT.halfL) {
      if (game.passer) { game.passer.stats.tov++; game.lastTouch = game.passer; }
      const to = 1 - game.possession;
      game.passTo = null;
      game.passSteal = null;
      game.inbound.startAt(to, game.passCatch.x, game.passCatch.z, { clock: SHOT_CLOCK });
      return;
    }
    // 綺麗に迎える: 最後の数cmを詰めて手元へ(back-snap無し)
    const gap = dist2DTo(receiver.pos, game.passCatch.x, game.passCatch.z);
    if (gap > 0.02) moveToward2D(receiver.pos, game.passCatch.x, game.passCatch.z, Math.min(gap, 0.4));
    // オーバー&バック違反のバックストップ
    if (game.frontT && game.attackSign(receiver.team) * receiver.pos.z < 0) {
      game.passTo = null;
      turnover(game, receiver, "BACKCOURT");
      return;
    }
    game.handler = receiver;
    game.passTo = null;
    game.ballMode = "held";
    // catch 硬直: テクニック(handling)ベース(tech100→~0.3s..50→~1.05s)＋オフターゲット分。×0.3。
    const tech = rate(receiver.attr.handling);
    const catchBase = 0.3 + (1 - tech) * 1.5;
    const missPen = game.passMiss * (0.3 + (1 - tech) * 0.6);
    let gather = clamp((catchBase + missPen) * rand(0.9, 1.1), 0.3, 2.5) * 0.3;
    // ダイレクトプレイ: ワンタッチで捌く
    receiver.decisionT = (receiver.has("oneTouch") ? 0.08 : 0.25) + gather;
    // ゴール付近でフリー: 硬直を詰め、即リムへスクエア、ドライブ先をリムへ
    {
      const rimF = game.attackFloor(receiver.team);
      if (dist2D(receiver.pos, rimF) < 4.0 && game.nearestDefenderDist(receiver) > 1.4) {
        gather = Math.min(gather, 0.35);
        receiver.decisionT = 0.06 + gather * 0.5;
        receiver.faceToward(rimF.x, rimF.z);
        game.setDrive(receiver, rimF, 1.1);
      }
    }
    // 4対3で受けた: 味方がダブルチーム中=守備手薄。逡巡せず即攻める。
    if (game.teamPlayers(receiver.team).some((m) => m !== receiver && doubleTeamed(game, m))) {
      receiver.decisionT = Math.min(receiver.decisionT, 0.08 + gather * 0.5);
    }
    if (gather > 0.02) {
      receiver.coolT = Math.max(receiver.coolT, gather);   // 硬直
      receiver.gatherT = receiver.gatherDur = gather;   // …ボールはまだ緩い; この窓でシールド
      // キャッチ姿勢を今決める: 守備あり→シールド / オープン&射程→キャッチ&シュート / それ以外→ドライブ
      const dDefC = game.nearestDefenderDist(receiver);
      const inRange = dist2D(receiver.pos, game.attackFloor(receiver.team)) <= effShootRange(receiver) + 0.3;
      const canShoot = Math.max(rate(receiver.attr.midAcc), rate(receiver.attr.threeAcc)) > 0.5;
      receiver.catchIntent = dDefC < 1.6 ? "shield"
        : (inRange && canShoot && dDefC > 1.9) ? "shoot" : "drive";
    }
    receiver.quickT = Math.max(0.15, 0.6 - gather);   // ジャストほどワンタッチの窓が広い
    // お膳立て: 良いパサーはリズムでオープンマンを打たせる。速いパスは窓を長く保つ。
    const passer = game.passer;
    if (passer) {
      const openAtCatch = game.nearestDefenderDist(receiver);
      const vision = rate(passer.attr.passAcc) * 0.6 + rate(passer.attr.offense) * 0.4;
      const zip = rate(passer.attr.passSpd);   // 0（ロブ）.. 1（弾丸）
      receiver.setupBonus = clamp((vision - 0.4) * 0.36
        + clamp(openAtCatch - 1.3, 0, 2) * 0.05
        + zip * 0.10, 0, 0.28) * game.passQ;
      receiver.setupT = 0.8 + zip * 1.3;         // 速いパス=長いオープン窓
      // 守備を振る: 速いパスは相手のローテを上回りクローズアウトが遅れる(reactT)
      const rd = game.onBallDefender(receiver);
      if (rd) rd.reactT = Math.max(rd.reactT, (0.15 + zip * 0.7) * reactionLag(rd));
    }
    // 通ったパスは投げた者のアシストの布石
    game.assistFrom = game.passer;
    game.assistTo = receiver;
  }
}
