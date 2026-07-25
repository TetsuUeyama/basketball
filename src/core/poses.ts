// ポーズ／腕・手のアニメーション。毎フレームの手・腕のターゲット姿勢
// （オンボール保持/ディナイ/コンテスト挙上/勝利セレブレーション）を決める描画寄り処理。
import { Vector3 } from "@babylonjs/core";
import { Player } from "../objects/player/player";
import { MAX_PASS } from "../config";
import { rate, dist2D, rand, chance } from "../util";
import type { Game } from "../game";

  // ボールに触れている者の手をボールに当てる。それ以外は全員、腕を脇に下ろして休める。
export function poseHands(game: Game, ): void {
    if (game.ballMode === "finale") return;   // updateFinale が全ポーズを管理する
    const b = game.ball.pos;
    // 守備の構えを取る者を割り出し、適用してから runArms をスキップする
    // （守備の構えはレート制限されており runArms に上書きさせない）。
    const posed = new Set<Player>();
    if (game.ballMode === "held" && game.handler) {
      poseOnBallHands(game, game.handler, b, posed);   // オンボール守備者
      poseDenyHands(game, game.handler, b, posed);       // パスをディナイするオフボール守備者
      posed.add(game.handler);   // ドリブルの手は下で徐々に動くので上書きしない
      // キャッチをまとめている間、マークマンは両腕を低く伸ばしてルーズボールをはたきにいく
      if (game.handler.gatherT > 0) {
        const d = game.onBallDefender(game.handler);
        if (d && !d.airborne && dist2D(d.pos, game.handler.pos) < 2.0) {
          d.reach(new Vector3(b.x, b.y, b.z), true);
          posed.add(d);
        }
      }
      // プレストラップ: 二人目は離れて立ち、両手でボールをはたきにいく
      const pt = game.pressTrapper;
      if (pt && !pt.airborne && dist2D(pt.pos, game.handler.pos) < 1.8) {
        pt.reach(new Vector3(b.x, b.y, b.z), true);
        posed.add(pt);
      }
    } else if (game.ballMode === "charge" && game.shooter) {
      const cd = game.onBallDefender(game.shooter);     // 接地コンテストは真上に伸びる
      if (cd && !cd.airborne && dist2D(cd.pos, game.shooter.pos) < 2.2) {
        cd.handsUp(defArmRate(game, cd)); posed.add(cd);
      }
    }
    // フォロースルー中のシューターは自分の腕を保持する（下で処理）ので、
    // クールダウン中に runArms が腕を下ろさないようにする
    if (game.shooter && game.shooter.coolT > 0 && game.shooter !== game.handler) {
      posed.add(game.shooter);
    }
    // スクリーナーは腕を組む（ファウル回避）— runArms に上書きさせない
    for (const p of game.players) {
      if (p.screening) { p.foldArms(); posed.add(p); }
    }
    for (const p of game.players) if (!posed.has(p)) p.runArms();   // 腕振り／休め
    switch (game.ballMode) {
      case "held": {
        if (game.handler) {
          if (game.pendingPassTo) {
            // ジャンプパスのウィンドアップ: 両手でボールを頭上に掲げる
            game.handler.holdBallHands(b);
          } else if (game.handler.gatherT > 0) {
            // キャッチをまとめている間: 両手のキャッチポーズを続ける
            game.handler.holdBallHands(b);
          } else {
            // ドリブル: ボールを運ぶのと同じ側の手でドリブルの高さにかまえる
            const bw = new Vector3(b.x, 0.95, b.z);
            game.handler.reachDribble(bw, game.handler.dribbleWithRight(bw), dribArmRate(game, game.handler));
          }
        }
        break;
      }
      case "charge":
        game.shooter?.reach(b, true);                // ショットポケットにボールをためる
        raiseAirborne(game, b, game.shooter);         // 早く跳んだ守備者は上がっている
        break;
      case "inbound":
        game.handler?.reach(b);                      // スローインのためボールを保持する
        break;
      case "shot":
        // フィニッシャーはリムまで手をボールに乗せ続ける。ジャンパーは最初の一拍だけ
        // リリースを保持し、その後フォロースルーへ移る。
        if (game.shooter && (game.shooterFinishing || game.shotT < game.shotDur * 0.45)) {
          game.shooter.reach(b, true);
        }
        raiseAirborne(game, b, game.shooter);         // コンテストする守備者が上がる
        break;
      case "freethrow":
        if (game.ft.t < 1.4) game.ft.shooter?.reach(b, true);
        break;
      case "pass":
        // 両手のチェストパス: 両腕を胸の高さでレシーバーへ向けて前に押し出す
        if (game.passT < game.passDur * 0.4 && game.passer && game.passTo) {
          const pr = game.passer.pos, tp = game.passTo.pos;
          const dx = tp.x - pr.x, dz = tp.z - pr.z, dl = Math.hypot(dx, dz) || 1;
          game.passer.reach(new Vector3(pr.x + (dx / dl) * 1.2, 1.3, pr.z + (dz / dl) * 1.2), true);
        } else if (game.passT > game.passDur * 0.45) {
          // キャッチ: レシーバーは両手を出して向かってくるボールを迎える
          game.passTo?.holdBallHands(b);
        }
        if (game.passSteal) game.passSteal.def.reach(b);                   // パスコースに跳び込む
        break;
      case "loose":
        // リバウンドに跳ぶ全員がボールに手を伸ばす（フォロースルー中のシューターは除く）
        raiseAirborne(game, b, game.shooter && game.shooter.coolT > 0 ? game.shooter : null);
        // はたき落とされたボールの地面での争奪: 奪う側は手を突き出し、失った者は取り戻そうとする
        {
          const lb = new Vector3(b.x, Math.max(0.35, b.y), b.z);
          const digger = game.looseStealBy, loser = game.looseStealVictim;
          // 奪う側は突進: 片手を出し、上体をひねり、腕を大きく伸ばす
          if (digger && !digger.airborne && dist2D(digger.pos, b) < 2.4) digger.digReach(lb);
          // 失った者は片手を伸ばして取り戻そうとする（のけぞり中は手を出さない＝反応を見せる）
          if (loser && loser !== digger && !loser.airborne && loser.foulReactT <= 0
              && dist2D(loser.pos, b) < 2.2) loser.reach(lb);
        }
        break;
      case "tipoff":
        game.teamPlayers(0)[4].reach(b, true);       // 両センターが両手でタップする
        game.teamPlayers(1)[4].reach(b, true);
        break;
      // "pause": 誰もボールを保持していない — 腕は休めのまま
    }

    // ボール処理の仕事がないのに空中にいる体は、ブロック／コンテストのジャンプ →
    // 両手が真上に上がる。loose/tipoff はボールそのものへ手を伸ばし続けるので除く。
    if (game.ballMode !== "loose" && game.ballMode !== "tipoff") {
      for (const p of game.players) {
        if (!p.airborne || p === game.shooter || p === game.handler) continue;
        if (p === game.passer) continue;   // ジャンプパサーはチェストパスの腕を保つ
        if (p.foulReactT > 0) continue;    // AND-1 のフレックスホップは拳を上げたまま
        p.reach(new Vector3(p.pos.x, 6, p.pos.z), true);   // 真上のターゲット
      }
    }

    // フォロースルー: シューターはクールダウン(coolT)の間ずっと、撃ったバスケットへ
    // 腕を上げたリリースの形を保持する。例外: "charge" のギャザーはポーズを別管理し、
    // "shot" の飛翔の序盤は生のリリース動作（shot ケースが手を伸ばす）。
    const sh = game.shooter;
    const releasing = game.ballMode === "shot" && game.shotT < game.shotDur * 0.45;
    if (sh && sh.coolT > 0 && game.ballMode !== "charge" && !releasing
        && sh !== game.handler && sh.foulReactT <= 0) {
      const rim = game.attackFloor(sh.team);
      sh.reach(new Vector3(rim.x, 3.2, rim.z), true);
    }

    // ファウルのリアクションは最後に再生され、どの休めポーズよりも優先して腕を管理する
    for (const p of game.players) p.poseFoulReaction();

    // 守備成功のセレブレーションは最後に再生する — ただしこのフレームでアクティブな
    // ボールの仕事がない選手（ハンドル／シュート／パス／空中／ルーズボール争奪でない）に限る。
    const scrambling = game.ballMode === "loose" || game.ballMode === "tipoff";
    for (const p of game.players) {
      if (p.defWinT <= 0 || p.foulReactT > 0) continue;
      if (p === game.handler || p === game.shooter || p === game.passer) continue;
      if (p.airborne || scrambling) continue;
      p.poseDefWin();
    }
  }

  // 空中にいる選手は両手をボールへ向けて上げる（掴む・タップする・ブロックする）。
export function raiseAirborne(game: Game, b: Vector3, except: Player | null): void {
    for (const p of game.players) {
      if (p !== except && p.airborne) p.reach(b, true);
    }
  }

  // 守備者が手を置き直す速さ（単位 rad/s）— 守備でゲートされる（低い者は遅く、エリートは速い）。
export function defArmRate(game: Game, d: Player): number {
    return 0.8 + rate(d.attr.defense) * 4.0;   // ~0.8（遅く慎重）.. ~4.8（きびきび）
  }

  // ハンドラーのドリブルの手が置き直される速さ — ドリブル精度(D精度)に連動する。
export function dribArmRate(game: Game, h: Player): number {
    return 0.8 + rate(h.attr.dribbleAcc) * 4.0;
  }

export function poseOnBallHands(game: Game, h: Player, b: Vector3, posed: Set<Player>): void {
    const d = game.onBallDefender(h);
    if (!d || d.airborne) return;
    const r = defArmRate(game, d);
    // 前手を安定した点（ドリブルされるボールでなく胸の高さのハンドラーの体、ボール側へ少し寄せ）に向ける
    const bt = new Vector3(h.pos.x * 0.75 + b.x * 0.25, 1.0, h.pos.z * 0.75 + b.z * 0.25);
    const useRight = d.dribbleWithRight(bt);         // ボールに近い側の手が先導する
    const rim = game.attackFloor(h.team);            // 彼が攻めているバスケット
    const spd = Math.hypot(h.velX, h.velZ);
    const toRimX = rim.x - h.pos.x, toRimZ = rim.z - h.pos.z;
    const rl = Math.hypot(toRimX, toRimZ) || 1;
    const straight = spd > 1.2 && (h.velX * toRimX + h.velZ * toRimZ) / (spd * rl) > 0.5;
    const close = dist2D(d.pos, h.pos) < 0.9;
    // まっすぐな／抜き去られたドライブ、または密着で押される状態はドライブガード。
    // それ以外はヒステリシス付きの構え選択（spd>1.5 で広げ、spd<0.9 でガードへ戻す）。
    if (h.beatenT > 0 || straight) {
      d.guardDrive(bt, useRight, r);                 // 侵入を断つ
    } else {
      if (d.stanceWide) { if (spd < 0.9 || close) d.stanceWide = false; }
      else { if (spd > 1.5 && !close) d.stanceWide = true; }
      if (d.stanceWide) d.armsWide(r);               // サイドのレーンを封じる
      else d.guardDrive(bt, useRight, r);            // 腰を落として突く
    }
    posed.add(d);
  }

  // ボールサイドのオフボール守備者は自分のマークをフロントする（レーンに手を入れ、
  // 背後へのパスを通させない）。ヘルプで下がる守備者は腕を下ろしたまま。
export function poseDenyHands(game: Game, h: Player, b: Vector3, posed: Set<Player>): void {
    for (const o of game.teamPlayers(h.team)) {
      if (o === h) continue;                          // 彼はボール保持者でレシーバーではない
      if (dist2D(o.pos, b) > MAX_PASS) continue;      // パス範囲の外
      const d = game.onBallDefender(o);               // このレシーバーをガードしている者
      if (!d || d.airborne) continue;
      if (dist2D(d.pos, b) < dist2D(o.pos, b)) {      // ボールサイド／フロント → ディナイ
        d.denyLane(d.dribbleWithRight(b), defArmRate(game, d));
        posed.add(d);
      }
    }
  }

  // セレブレーションの両手上げバウンド（amp 1 = 全員で沸く、~0.4 = 控えめ）。
export function festivePose(game: Game, p: Player, dt: number, amp: number): void {
    p.reach(new Vector3(p.pos.x, 2.7 + amp * 0.5, p.pos.z), true);   // 両腕を上げる
    if (!p.airborne && p.landT <= 0 && chance(dt * (1.2 + amp * 1.3))) {
      p.jump(0.1 + amp * rand(0.15, 0.3), rand(0.3, 0.45));
    }
  }
