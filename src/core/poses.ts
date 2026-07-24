// ポーズ／腕・手のアニメーション（方式B: GameState 集約）。毎フレームの手・腕の
// ターゲット姿勢（オンボール保持/ディナイ/コンテスト挙上/勝利セレブレーション）を
// 決める描画寄りの処理。状態は Game に集約し各関数は第一引数 game を受け取る。
import { Vector3 } from "@babylonjs/core";
import { Player } from "../player";
import { MAX_PASS } from "../config";
import { dist2D, rand, chance } from "../util";
import { rate } from "../attributes";
import type { Game } from "../game";

  // ボールに触れている者の手をボールに当て、浮いているのではなく手のひらから
  // ドリブル／パス／シュート／タップされるようにする。それ以外は全員、腕を
  // 体の脇に下ろして休める。
export function poseHands(game: Game, ): void {
    if (game.ballMode === "finale") return;   // updateFinale が全ポーズを管理する
    const b = game.ball.pos;
    // 守備の構えはレート制限されている（スナップせず目標ポーズへ徐々に近づく）ため、
    // runArms が先にその腕を上書きしてはいけない。このフレームで守備の構えを取る者を
    // 割り出し、それを適用してから、その選手の runArms をスキップする。
    const posed = new Set<Player>();
    if (game.ballMode === "held" && game.handler) {
      poseOnBallHands(game, game.handler, b, posed);   // オンボール守備者が対応する内容
      poseDenyHands(game, game.handler, b, posed);       // パスをディナイするオフボール守備者
      posed.add(game.handler);   // ドリブルの手も下で徐々に動くので上書きしない
      // まだ収まっていない: レシーバーがこぼれかけたキャッチをまとめている間、
      // マークマンはルーズボールをはたきにいく — 両腕を低く伸ばしてむき出しの
      // ボールに手を出すので、スティールの試みが見える（catchStrips が踏み込み＋突きを担う）。
      if (game.handler.gatherT > 0) {
        const d = game.onBallDefender(game.handler);
        if (d && !d.airborne && dist2D(d.pos, game.handler.pos) < 2.0) {
          d.reach(new Vector3(b.x, b.y, b.z), true);
          posed.add(d);
        }
      }
      // プレストラップ: 二人目は体を当てにいかず、離れて立ってボールをはたきにいく。
      // 両手でボールを狙うので、トラップがスティールの試みとして見える
      const pt = game.pressTrapper;
      if (pt && !pt.airborne && dist2D(pt.pos, game.handler.pos) < 1.8) {
        pt.reach(new Vector3(b.x, b.y, b.z), true);
        posed.add(pt);
      }
    } else if (game.ballMode === "charge" && game.shooter) {
      const cd = game.onBallDefender(game.shooter);     // 接地したままのコンテストは真上に伸びる
      if (cd && !cd.airborne && dist2D(cd.pos, game.shooter.pos) < 2.2) {
        cd.handsUp(defArmRate(game, cd)); posed.add(cd);
      }
    }
    // フォロースルーで静止したシューターは自分の腕を保持する（下で処理）— 接地した
    // まま（床を離れないセットジャンパー）でも同様 — なので、クールダウン中に runArms が
    // 腕を下ろし直さないようにする
    if (game.shooter && game.shooter.coolT > 0 && game.shooter !== game.handler) {
      posed.add(game.shooter);
    }
    for (const p of game.players) if (!posed.has(p)) p.runArms();   // 腕振り／休めを回す
    switch (game.ballMode) {
      case "held": {
        if (game.handler) {
          if (game.pendingPassTo) {
            // ジャンプパスのウィンドアップ: 両手でボールを頭上に掲げている
            game.handler.holdBallHands(b);
          } else if (game.handler.gatherT > 0) {
            // まだ収まっていない: 両手のキャッチポーズがそのまま続く —
            // ボールは両手のひらの間（両側に片手ずつ）に収まり、収まるまで
            // 保持全体が一体となって揺れる。その後ドリブルへ移行する
            game.handler.holdBallHands(b);
          } else {
            // ボールが下で弾む間、手はドリブルの高さでかまえる —
            // ボールを運ぶのと同じ側の手でドリブルする（腰での保持は近い側の手を使い、
            // 体を横切って遠い側の腕を伸ばさない）
            const bw = new Vector3(b.x, 0.95, b.z);
            game.handler.reachDribble(bw, game.handler.dribbleWithRight(bw), dribArmRate(game, game.handler));
          }
        }
        break;
      }
      case "charge":
        game.shooter?.reach(b, true);                // ショットポケットにボールをためる
        raiseAirborne(game, b, game.shooter);         // 早く跳んだ守備者はすでに上がっている
        break;
      case "inbound":
        game.handler?.reach(b);                      // スローインするためにボールを保持する
        break;
      case "shot":
        // フィニッシャーはリムまでずっと手をボールに乗せ続ける（ダンク／レイアップは
        // 腕主導）。ジャンパーは最初の一拍だけリリースを保持し、その後フォロースルーへ移る。
        if (game.shooter && (game.shooterFinishing || game.shotT < game.shotDur * 0.45)) {
          game.shooter.reach(b, true);
        }
        raiseAirborne(game, b, game.shooter);         // コンテストする守備者が上がる
        break;
      case "freethrow":
        if (game.ft.t < 1.4) game.ft.shooter?.reach(b, true);
        break;
      case "pass":
        // 両手のチェストパス: 両腕を胸の高さでレシーバーへ向けて前に押し出す —
        // 弧を描くボールを追って上げるのではない（それはオーバーヘッドの投げに見えた）
        if (game.passT < game.passDur * 0.4 && game.passer && game.passTo) {
          const pr = game.passer.pos, tp = game.passTo.pos;
          const dx = tp.x - pr.x, dz = tp.z - pr.z, dl = Math.hypot(dx, dz) || 1;
          game.passer.reach(new Vector3(pr.x + (dx / dl) * 1.2, 1.3, pr.z + (dz / dl) * 1.2), true);
        } else if (game.passT > game.passDur * 0.45) {
          // キャッチ: レシーバーは両手を出して向かってくるボールを迎える
          // （胸はすでにボールへ正対している — updateFacing が向きを変える）、
          // 両側に手のひらを添え、両手の間でボールを受ける構え
          game.passTo?.holdBallHands(b);
        }
        if (game.passSteal) game.passSteal.def.reach(b);                   // パスコースに跳び込む
        break;
      case "loose":
        // リバウンドに跳ぶ全員がボールに手を伸ばす — ただしフォロースルー中の
        // シューターは除く。ブロックされたボールへ腕を振ってはいけない
        // （それは「そこへ投げた」ように見えた）。彼は下でリリースの形を保持する。
        raiseAirborne(game, b, game.shooter && game.shooter.coolT > 0 ? game.shooter : null);
        // はたき落とされたボールの地面での争奪: はたき出した者は手を突き出し続け
        // （テレポート的な奪取でなく、見えるはたき）、失った者は奪い返そうと手を伸ばす —
        // これでスティールが、ボールが単に持ち主を変えるのでなく、生きたルーズボールを
        // 巡る争いとして見える。
        {
          const lb = new Vector3(b.x, Math.max(0.35, b.y), b.z);
          const digger = game.looseStealBy, loser = game.looseStealVictim;
          // 奪う側は突進する: 片手を出し、上体をひねり、腕を大きく伸ばす
          if (digger && !digger.airborne && dist2D(digger.pos, b) < 2.4) digger.digReach(lb);
          // 失った者は片手を伸ばして取り戻そうとする
          if (loser && loser !== digger && !loser.airborne && dist2D(loser.pos, b) < 2.2) loser.reach(lb);
        }
        break;
      case "tipoff":
        game.teamPlayers(0)[4].reach(b, true);       // 両センターが両手でタップする
        game.teamPlayers(1)[4].reach(b, true);
        break;
      // "pause": 誰もボールを保持していない — 腕は休めのまま
    }

    // ボール処理の仕事がないのに空中にいる体は、ブロック／コンテストのジャンプである —
    // 両手が真上に上がる（早がけのコンテストの賭けや、リムプロテクターのタイミングを
    // 計った跳躍は、ボールがまだ "held" の間に起こり、上のどのケースも腕を上げない）。
    // リバウンドの争奪（loose）とティップオフは、代わりにボールそのものへ手を伸ばし続ける。
    if (game.ballMode !== "loose" && game.ballMode !== "tipoff") {
      for (const p of game.players) {
        if (!p.airborne || p === game.shooter || p === game.handler) continue;
        if (p === game.passer) continue;   // ジャンプパサーはチェストパスの腕を保ち、両手上げにしない
        if (p.foulReactT > 0) continue;    // AND-1 のフレックスホップは握り拳を上げたままにする
        p.reach(new Vector3(p.pos.x, 6, p.pos.z), true);   // 真上のターゲット
      }
    }

    // 静止したフォロースルー: シューターはリリースの形を保持する — 撃ったバスケットへ
    // 腕を上げたまま — クールダウン(coolT)の間ずっと、床を離れたかどうかに関わらず。
    // だからセットジャンパーはボールが離れた後もポーズを保ち、ブロック／ミスした
    // シュートでも、そこへ投げたかのようにボールへ腕を振ることは決してない。例外:
    // "charge" のギャザーは彼のポーズを管理し（ボールを頭上にためる）、"shot" の飛翔の
    // ごく序盤は生のリリース動作（shot ケースがボールに手を伸ばす）。その後は形を静止させる。
    const sh = game.shooter;
    const releasing = game.ballMode === "shot" && game.shotT < game.shotDur * 0.45;
    if (sh && sh.coolT > 0 && game.ballMode !== "charge" && !releasing
        && sh !== game.handler && sh.foulReactT <= 0) {
      const rim = game.attackFloor(sh.team);
      sh.reach(new Vector3(rim.x, 3.2, rim.z), true);
    }

    // ファウルのリアクションは最後に再生され、どの休めポーズよりも優先して腕を管理する
    for (const p of game.players) p.poseFoulReaction();

    // 守備成功のセレブレーションは全ての中で最後に再生される — ただしこのフレームで
    // アクティブなボールの仕事がない選手に限る（ハンドル／シュート／パスをしておらず、
    // ブロックで空中に残ってもおらず、ルーズボールを争ってもいない）。だからブロッカーの
    // ガッツポーズは着地まで待ち、スティールした者はすぐにボールを掴んで押し出さなかった
    // 場合のみガッツポーズする（掴んで押し出した場合はドリブルが腕を管理する — リアル）。
    // ファウルのリアクションがあれば、すでに腕を獲得している。
    const scrambling = game.ballMode === "loose" || game.ballMode === "tipoff";
    for (const p of game.players) {
      if (p.defWinT <= 0 || p.foulReactT > 0) continue;
      if (p === game.handler || p === game.shooter || p === game.passer) continue;
      if (p.airborne || scrambling) continue;
      p.poseDefWin();
    }
  }

  // 空中にいる選手（シュートをコンテスト、またはリバウンドに飛び込む）は両手を
  // ボールへ向けて上げ、掴む・タップする・ブロックする。
export function raiseAirborne(game: Game, b: Vector3, except: Player | null): void {
    for (const p of game.players) {
      if (p !== except && p.airborne) p.reach(b, true);
    }
  }

  // オンボール守備者の手は、彼が何に対応しているかを示す。まっすぐな抜き去り（または
  // ハンドラーのリムへのドライブ）→ 前手がレーンを断ち、ボールを突く。左右に揺さぶられる
  // → 両腕を広げて両方向に壁を作る。守備者が真上に付いた静止した保持ボール → 同じ前手の
  // 突き。それ以外では、手をアクティブに広く保つ。
  // 守備者がどれだけ速く手を向け直せるか、単位は rad/s — 弱い守備者は構えの切り替えが
  // 遅く（だから一拍遅れる）、エリートは瞬時に合わせる。
  // 守備者がどれだけ速く手を置き直すか — 守備でゲートされる: 守備の低い選手の腕は
  // ゆっくり慎重に動き、エリートのそれは素早い。決してスナップはしない
  // （setArmDir がこのレートで目標へ徐々に近づく）ので、手はテレポートしない。
export function defArmRate(game: Game, d: Player): number {
    return 0.8 + rate(d.attr.defense) * 4.0;   // ~0.8（遅く慎重）.. ~4.8（きびきび）
  }

  // ハンドラーのドリブルの手がどれだけ速く置き直されるか — 彼のドリブル精度
  // （D精度、オフェンスのボールハンドリング能力）に連動する: ルーズなハンドラーの
  // 手は遅れ、タイトな者の手は素早い。
export function dribArmRate(game: Game, h: Player): number {
    return 0.8 + rate(h.attr.dribbleAcc) * 4.0;
  }

export function poseOnBallHands(game: Game, h: Player, b: Vector3, posed: Set<Player>): void {
    const d = game.onBallDefender(h);
    if (!d || d.airborne) return;
    const r = defArmRate(game, d);
    // 前手を安定した点に向ける — ドリブルされるボールでなく、胸の高さのハンドラーの
    // 体（ボールの x/z は弾みやクロスオーバーのたびに揺れ、手をぶれさせた）。
    // ボール側へ少し寄せているので、依然としてオンボールとして見える。
    const bt = new Vector3(h.pos.x * 0.75 + b.x * 0.25, 1.0, h.pos.z * 0.75 + b.z * 0.25);
    const useRight = d.dribbleWithRight(bt);         // ボールに近い側の手が先導する
    const rim = game.attackFloor(h.team);            // 彼が攻めているバスケット
    const spd = Math.hypot(h.velX, h.velZ);
    const toRimX = rim.x - h.pos.x, toRimZ = rim.z - h.pos.z;
    const rl = Math.hypot(toRimX, toRimZ) || 1;
    const straight = spd > 1.2 && (h.velX * toRimX + h.velZ * toRimZ) / (spd * rl) > 0.5;
    const close = dist2D(d.pos, h.pos) < 0.9;
    // まっすぐな／抜き去られたドライブ、または真正面から体を当てられた状態は
    // ドライブガード（前手を下げる）。それ以外はヒステリシスを持たせた構えの選択:
    // ハンドラーが明確に動いている（spd>1.5）ときのみ広げ、明確に遅い（spd<0.9）
    // ときのみガードへ戻す — こうすれば旧来の 1.2 の境界付近を漂う速度が、フレーム
    // ごとにポーズ（と手）を切り替えなくなる。
    if (h.beatenT > 0 || straight) {
      d.guardDrive(bt, useRight, r);                 // 侵入を断つ
    } else {
      if (d.stanceWide) { if (spd < 0.9 || close) d.stanceWide = false; }
      else { if (spd > 1.5 && !close) d.stanceWide = true; }
      if (d.stanceWide) d.armsWide(r);               // サイドのレーンを封じる
      else d.guardDrive(bt, useRight, r);            // 腰を落として保持ボールを突く
    }
    posed.add(d);
  }

  // 1パス離れてボールサイドにいるオフボール守備者は、自分のマークをフロントする —
  // レーンに斜めに手を入れ、背後へボールを通させない（外へ戻すスイングは許容する）。
  // ヘルプで下がっている守備者（マークのゴール側）は腕を下ろしたまま。オンボール
  // 守備者は poseOnBallHands に任せる。
export function poseDenyHands(game: Game, h: Player, b: Vector3, posed: Set<Player>): void {
    for (const o of game.teamPlayers(h.team)) {
      if (o === h) continue;                          // 彼はボールを持っており、レシーバーではない
      if (dist2D(o.pos, b) > MAX_PASS) continue;      // あらゆるパス範囲の外
      const d = game.onBallDefender(o);               // このレシーバーをガードしている者
      if (!d || d.airborne) continue;
      if (dist2D(d.pos, b) < dist2D(o.pos, b)) {      // ボールサイド／フロント → ディナイ
        d.denyLane(d.dribbleWithRight(b), defArmRate(game, d));
        posed.add(d);
      }
    }
  }

  // セレブレーションする体の両手上げバウンド（amp 1 = 全員で沸く、~0.4 = 控えめ）。
export function festivePose(game: Game, p: Player, dt: number, amp: number): void {
    p.reach(new Vector3(p.pos.x, 2.7 + amp * 0.5, p.pos.z), true);   // 両腕を上げる
    if (!p.airborne && p.landT <= 0 && chance(dt * (1.2 + amp * 1.3))) {
      p.jump(0.1 + amp * rand(0.15, 0.3), rand(0.3, 0.45));
    }
  }
