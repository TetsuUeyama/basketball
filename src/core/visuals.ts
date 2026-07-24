// ビジュアル同期（方式B: GameState 集約）。毎フレーム、状態から各選手メッシュの位置・
// 向き（updateFacing）とネット演出（tickSwish/swishNet）を反映する描画寄り処理。
// syncAll は全選手の visual sync を回す。状態は Game に集約し各関数は game を受け取る。
// applyModelAll/applyUniforms/syncVisuals は main.ts 向け public API として Game 残置。
import { Vector3 } from "@babylonjs/core";
import { Player } from "../player";
import { RIM, COURT, TEAM_COLORS } from "../config";
import { clamp, dist2D, dist2DTo, moveToward2D, rand } from "../util";
import { rate } from "../attributes";
import { hoopIndex } from "../court";
import { poseHands } from "./poses";
import type { Game } from "../game";

  // `team` が今得点したリムで、ネットスウィッシュ＋リム／ボードのフラッシュを開始する。
export function swishNet(game: Game, team: number): void {
    const i = hoopIndex(game.attackSign(team));
    game.netSwish[i] = 1.1;         // 長めにして、セレブレーションがはっきり見えるように
    game.swishTeam[i] = team;
  }

  // 得点時のネットスウィッシュ＋リム／バックボードのフラッシュの1フレーム（描画のみ。
  // フープが取り付けられていないヘッドレスハーネスではスキップ）。リムとバックボードは
  // 得点したチームの色で明るく光り、誰が得点したかがはっきり分かる。ネットは勢いよく
  // 下へ弾んで跳ね返る。
export function tickSwish(game: Game, dt: number): void {
    if (!game.hoops) return;
    const DUR = 1.1;
    for (let i = 0; i < 2; i++) {
      if (game.netSwish[i] <= 0) continue;
      game.netSwish[i] = Math.max(0, game.netSwish[i] - dt);
      const net = game.hoops.nets[i], rim = game.hoops.rimMats[i], board = game.hoops.boardMats[i];
      const c = TEAM_COLORS[game.swishTeam[i]];
      if (game.netSwish[i] > 0) {
        const e = DUR - game.netSwish[i];                 // 経過秒数
        const damp = Math.exp(-e * 5);                    // 明るさの減衰
        // ネットは勢いよく下へ弾み、減衰する揺れとともに跳ね返る
        const spring = Math.exp(-e * 6);
        net.scaling.y = 1 + 0.9 * spring;
        const sway = Math.sin(e * 24) * 0.25 * spring;
        net.scaling.x = 1 + sway;
        net.scaling.z = 1 - sway;
        // 強いフラッシュ: リムとバックボードが得点チームの色で脈打つように光る
        const pulse = damp * (0.6 + 0.4 * Math.abs(Math.sin(e * 18)));
        rim.emissiveColor.set(0.3 + c.r * 1.3 * pulse, 0.12 + c.g * 1.3 * pulse, c.b * 1.3 * pulse);
        board.emissiveColor.set(c.r * pulse, c.g * pulse, c.b * pulse);
      } else {                                          // 静止状態へ戻す
        net.scaling.set(1, 1, 1);
        rim.emissiveColor.set(0.3, 0.12, 0.0);
        board.emissiveColor.set(0, 0, 0);
      }
    }
  }

  // コート上の選手はプレイの方を向く: ハンドラーとシューターは攻めるバスケットへ正対し、
  // それ以外の全員（ボールから目を離さない守備者、それを読むオフボールの攻撃者）は
  // ボールの方を向く。スナップでなく体が追従するようイージングする。交代中はスキップし、
  // 選手は所定の位置へ歩く。ベンチ選手は benchIdle で各自の視線を向ける。
export function updateFacing(game: Game, dt: number): void {
    if (game.ballMode === "subs" || game.ballMode === "finale") return;
    const b = game.ball.pos;
    for (const p of game.players) {
      // パサーは両手のパスを胸を正対させて出す: 上体を今すぐレシーバーへスナップさせ
      // （パスはイージングした回転には速すぎる）、足はその場に残す。airborne スキップの
      // 前に行うので、ダブルチームからのジャンプパス（trapKickOut は床を離れる）でも
      // 胸をレシーバーへ正対させる。
      if (game.ballMode === "pass" && p === game.passer && game.passTo) {
        if (game.noLookPass) {
          // ノールック: ターゲットへ正対しない — 脚はそのままで、胴体をわずかに
          // その方向へ向けるだけ。だからボールは正対せずに横／背後から鋭く出る
          // （通常とは異なる、ノールックのリリース動作）。
          p.twistToward(game.passTo.pos.x, game.passTo.pos.z, dt, 0.4, 6);
        } else {
          p.faceChestToward(game.passTo.pos.x, game.passTo.pos.z);
        }
        continue;
      }
      // ターンパスのウィンドアップ: ターゲットが前方から側方の弧の外（背後）にいたので、
      // リリース前に体をそちらへ回す（ボールはまだ手にある）。
      if (game.pendingPassTo && game.pendingPassTurn && p === game.handler) {
        const t = game.pendingPassTo;
        const rt = 2.2 + (rate(p.attr.agility) * 0.6 + rate(p.attr.offense) * 0.4) * 6;
        p.faceSmooth(t.pos.x, t.pos.z, rt * dt);
        p.twistToward(t.pos.x, t.pos.z, dt, undefined, rt * 1.25);
        p.lookToward(t.pos.x, t.pos.z, dt, rt * 1.6);
        continue;
      }
      // 床を離れていると向きを変えられない: 跳んでいる者（シューター、コンテスト、タップ）は
      // 着地するまで踏み切り時の向きを保つ — 空中での回転はない。
      if (p.airborne) continue;
      // レシーバーは向かってくるボールへ胸を正対させ、両手で受ける — パサーと同じ
      // 胸を正対させるスナップ。だから背後から来るボールは彼を振り向かせる（胴体で
      // まかなえる分をまかない、足で残りを回す。キャッチ地点への走りには手を触れない
      // — 脚は進み続ける）。約0.5m以内ではボールへの方位がフレームごとに激しく振れるので、
      // 実際にキャッチする瞬間は直前の向きを保つ。
      if (game.ballMode === "pass" && p === game.passTo) {
        if (dist2D(p.pos, b) > 0.5) p.faceChestToward(b.x, b.z);
        continue;
      }
      // キャッチをまとめている間(gatherT): 上体をひねってボールを隠し、胸を最も近い
      // 守備者から背けるように向ける（updateLive でボールは遠い側の腰へ移る）。収まると
      // 正対へ戻る。隠す相手の守備者がいなければ、キャッチの姿勢を保つだけ。
      if (p === game.handler && p.gatherT > 0 && p.catchIntent === "shield") {
        const nd = game.nearestDefender(p);
        if (nd) {
          // プレッシャー下: 上体だけが回って隠す — 胸は守備者から背けてひねり、頭は
          // プレイ（リム）の方を向いたままにする。だから全身が回転するのでなく
          // 「体で守っている」ように見える。固定したワールド座標点への lookToward が
          // 頭を胸に対して逆回転させる。
          const shieldX = p.pos.x + (p.pos.x - nd.pos.x), shieldZ = p.pos.z + (p.pos.z - nd.pos.z);
          const rt = 2.2 + (rate(p.attr.agility) * 0.6 + rate(p.attr.offense) * 0.4) * 6;
          p.twistToward(shieldX, shieldZ, dt, undefined, rt * 1.25);   // 胸で守る
          const rim = game.attackFloor(p.team);
          p.lookToward(rim.x, rim.z, dt, rt);                          // 顔はプレイに向けたまま
        }
        continue;
      }
      // オープンなキャッチ（シュート／ドライブの意図）は、パサーに正対したキャッチ
      // 姿勢を保つのでなくバスケットへ正対する — 下の通常のハンドラーの向き
      // (attackFloor) に流れ込み、上がるか行くかの構えになる。
      // ドリブル維持のシールド: マークされた下手なハンドラーは横向きになってボールを
      // 壁で守る — 胸を守備者に対して直角に、リム側へ角度をつけるので、体が守備者と
      // ボール（遠い側の腰で運ぶ）の間に入る。頭は依然としてフロア／リムを追い、
      // ヘルプのパスを見つけられるようにする。
      if (p === game.handler && p.keepShieldT > 0) {
        const od = game.onBallDefender(p);
        if (od) {
          const rimF = game.attackFloor(p.team);
          const dx = od.pos.x - p.pos.x, dz = od.pos.z - p.pos.z;   // 守備者へ向かって
          let px = -dz, pz = dx;                                    // 直角（横向き）
          if (px * (rimF.x - p.pos.x) + pz * (rimF.z - p.pos.z) < 0) { px = dz; pz = -dx; } // リム側を選ぶ
          const sx = p.pos.x + px, sz = p.pos.z + pz;
          const shieldRate = 2.2 + rate(p.attr.agility) * 5;
          p.faceSmooth(sx, sz, shieldRate * dt);                    // 脚／腰を横向きにする
          p.twistToward(sx, sz, dt, undefined, shieldRate * 1.2);   // 胸でボールを壁のように守る
          p.lookToward(rimF.x, rimF.z, dt, shieldRate * 1.6);       // 目はフロア／リムに向ける
          continue;
        }
      }
      const aim = (p === game.handler || p === game.shooter) ? game.attackFloor(p.team) : b;
      // 下半身: 走っている間、脚は進行方向を向き、胴体はプレイの方へひねる(twistToward)
      // — 動きながら受ける、ドライブする相手にストライドで付く。ただし目標から遠ざかる
      // （バックペダル）ときは除く: そのとき脚は正対を保ち、選手は胸を向けたまま後退する
      // （これがバックペダルの腕ポーズも誘発する）。静止していると全身が目標へ正対し、
      // ひねりがほどける。
      let lx = aim.x, lz = aim.z;
      const spd = Math.hypot(p.velX, p.velZ);
      // ギャザー中のフィニッシャーは脚をリムへ正対させる（aim = フープ）ので、
      // ダンク／レイアップが角度をつけて踏み切るのでなくバスケットへ正対する —
      // これが頻発する「バックダンク」に見えていた原因（体がリムへ向いていなかった）。
      const finishing = p === game.shooter && game.shooterFinishing
        && dist2DTo(p.pos, aim.x, aim.z) < 3.2;
      if (spd > 1.5 && !finishing) {
        const ax = aim.x - p.pos.x, az = aim.z - p.pos.z;
        const al = Math.hypot(ax, az);
        // 目標へ向かって動く → 脚は進行方向を向く。遠ざかる（後退）とき、遅い
        // コンテインシャッフルは胸を向けたまま（目標へ正対を保ちバックペダル）—
        // ただし本気のスプリントで遠ざかる（ルーズボールを追う、または抜かれた守備者が
        // 戻ろうとスプリントする）ときは向きを変えて走る: 進行方向を向き、後ろ歩き
        // にならないようにする。faceSmooth がイージングするので、回転は緩やか。
        const committed = spd > p.runSpeed * 0.72;
        if (al > 0.05 && ((p.velX * ax + p.velZ * az) / (spd * al) > -0.26 || committed)) {
          lx = p.pos.x + p.velX;
          lz = p.pos.z + p.velZ;
        }
      }
      // 新しい方向へどれだけ速く体をひねって振れるか — 瞬間的な回転はない。
      // クイックネス(敏捷性)に加えてロール能力で決まる: 守備者は敏捷性 + ディフェンス
      // でひねり（マークに付き続ける）、攻撃者はオフェンス + 敏捷性で。低い値は
      // ゆっくり回り（方向転換に一拍かかる）、エリートは素早く振れる — ただし
      // 決して瞬時ではない。
      const offense = p.team === game.possession;
      const quick = rate(p.attr.agility);
      const skill = offense ? rate(p.attr.offense) : rate(p.attr.defense);
      const turnRate = 2.2 + (quick * 0.6 + skill * 0.4) * 6;   // ~2.2（遅い）.. ~8.2（速い）rad/s
      p.faceSmooth(lx, lz, turnRate * dt);                       // 下半身（脚／腰）
      p.twistToward(aim.x, aim.z, dt, undefined, turnRate * 1.25); // 上半身（胸）、少し速め
      // 頭は注視すべきもの（ボール、または攻めるリム）を、胸の動きの上に重ねて追う
      // — だから彼は顔をプレイに向けずに走ったり回ったりすることは決してない
      p.lookToward(aim.x, aim.z, dt, turnRate * 1.6);
    }
  }

export function syncAll(game: Game, ): void {
    for (const p of game.players) p.sync();
    game.ball.sync();
    poseHands(game);
    if (game.handler && game.ballMode === "held") {
      game.ring.isVisible = true;
      game.ring.position.set(game.handler.pos.x, 0.03, game.handler.pos.z);
    } else {
      game.ring.isVisible = false;
    }
  }
