// ビジュアル同期。毎フレーム、状態から各選手メッシュの位置・向き（updateFacing）と
// ネット演出（tickSwish/swishNet）を反映する描画寄り処理。syncAll が全選手の sync を回す。
import { TEAM_COLORS } from "../config";
import { rate, dist2D, dist2DTo } from "../util";
import { hoopIndex } from "../objects/court";
import { poseHands } from "./poses";
import type { Game } from "../game";

  // `team` が今得点したリムで、ネットスウィッシュ＋リム／ボードのフラッシュを開始する。
export function swishNet(game: Game, team: number): void {
    const i = hoopIndex(game.attackSign(team));
    game.netSwish[i] = 1.1;         // 演出の表示時間(秒)
    game.swishTeam[i] = team;
  }

  // 得点時のネットスウィッシュ＋リム／バックボードのフラッシュの1フレーム（描画のみ、
  // フープのないヘッドレスではスキップ）。リムとバックボードは得点チームの色で光り、
  // ネットは下へ弾んで跳ね返る。
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
        // ネットは下へ弾み、減衰する揺れとともに跳ね返る
        const spring = Math.exp(-e * 6);
        net.scaling.y = 1 + 0.9 * spring;
        const sway = Math.sin(e * 24) * 0.25 * spring;
        net.scaling.x = 1 + sway;
        net.scaling.z = 1 - sway;
        // リムとバックボードが得点チームの色で脈打つように光る
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

  // コート上の選手はプレイの方を向く: ハンドラーとシューターは攻めるバスケットへ、
  // それ以外はボールへ。イージングで体が追従する。交代／フィナーレ中はスキップ。
export function updateFacing(game: Game, dt: number): void {
    if (game.ballMode === "subs" || game.ballMode === "finale") return;
    const b = game.ball.pos;
    for (const p of game.players) {
      // パサーは胸をレシーバーへスナップさせて両手パスを出す（足はその場、airborne
      // スキップの前に行うのでジャンプパスでも胸を正対させる）。
      if (game.ballMode === "pass" && p === game.passer && game.passTo) {
        if (game.noLookPass) {
          // ノールック: ターゲットへ正対せず、胴体をわずかに向けるだけ
          p.twistToward(game.passTo.pos.x, game.passTo.pos.z, dt, 0.4, 6);
        } else {
          p.faceChestToward(game.passTo.pos.x, game.passTo.pos.z);
        }
        continue;
      }
      // ターンパスのウィンドアップ: 背後のターゲットへリリース前に体を回す（ボールはまだ手にある）。
      if (game.pendingPassTo && game.pendingPassTurn && p === game.handler) {
        const t = game.pendingPassTo;
        const rt = 2.2 + (rate(p.attr.agility) * 0.6 + rate(p.attr.offense) * 0.4) * 6;
        p.faceSmooth(t.pos.x, t.pos.z, rt * dt);
        p.twistToward(t.pos.x, t.pos.z, dt, undefined, rt * 1.25);
        p.lookToward(t.pos.x, t.pos.z, dt, rt * 1.6);
        continue;
      }
      // 空中では向きを変えられない: 跳んでいる者は着地まで踏み切り時の向きを保つ。
      if (p.airborne) continue;
      // レシーバーは向かってくるボールへ胸を正対させて両手で受ける。約0.5m以内では
      // 方位が激しく振れるので、キャッチ直前の向きを保つ。
      if (game.ballMode === "pass" && p === game.passTo) {
        if (dist2D(p.pos, b) > 0.5) p.faceChestToward(b.x, b.z);
        continue;
      }
      // キャッチをまとめている間(gatherT): 上体をひねって胸を最寄り守備者から背け、
      // ボールを隠す。守備者がいなければキャッチ姿勢を保つだけ。
      if (p === game.handler && p.gatherT > 0 && p.catchIntent === "shield") {
        const nd = game.nearestDefender(p);
        if (nd) {
          // 上体だけが回って隠し、頭はプレイ（リム）を向いたまま
          const shieldX = p.pos.x + (p.pos.x - nd.pos.x), shieldZ = p.pos.z + (p.pos.z - nd.pos.z);
          const rt = 2.2 + (rate(p.attr.agility) * 0.6 + rate(p.attr.offense) * 0.4) * 6;
          p.twistToward(shieldX, shieldZ, dt, undefined, rt * 1.25);   // 胸で守る
          const rim = game.attackFloor(p.team);
          p.lookToward(rim.x, rim.z, dt, rt);                          // 顔はプレイに向けたまま
        }
        continue;
      }
      // ドリブル維持のシールド: マークされた下手なハンドラーは横向きになり、胸を守備者に
      // 直角・リム側へ角度をつけてボールを壁で守る。頭はフロア／リムを追い続ける。
      if (p === game.handler && p.keepShieldT > 0) {
        const od = game.onBallDefender(p);
        if (od) {
          const rimF = game.attackFloor(p.team);
          const dx = od.pos.x - p.pos.x, dz = od.pos.z - p.pos.z;   // 守備者へ向かって
          let px = -dz, pz = dx;                                    // 直角（横向き）
          if (px * (rimF.x - p.pos.x) + pz * (rimF.z - p.pos.z) < 0) { px = dz; pz = -dx; } // リム側を選ぶ
          const sx = p.pos.x + px, sz = p.pos.z + pz;
          const shieldRate = 2.2 + rate(p.attr.agility) * 5;
          p.faceSmooth(sx, sz, shieldRate * dt);                    // 脚／腰を横向きに
          p.twistToward(sx, sz, dt, undefined, shieldRate * 1.2);   // 胸でボールを守る
          p.lookToward(rimF.x, rimF.z, dt, shieldRate * 1.6);       // 目はフロア／リムへ
          continue;
        }
      }
      const aim = (p === game.handler || p === game.shooter) ? game.attackFloor(p.team) : b;
      // 下半身: 走っている間、脚は進行方向を向き、胴体はプレイの方へひねる(twistToward)。
      // 目標から遠ざかる（バックペダル）ときは脚も正対を保つ。静止すると全身が正対する。
      let lx = aim.x, lz = aim.z;
      const spd = Math.hypot(p.velX, p.velZ);
      // ギャザー中のフィニッシャーは脚をリム（aim = フープ）へ正対させる
      const finishing = p === game.shooter && game.shooterFinishing
        && dist2DTo(p.pos, aim.x, aim.z) < 3.2;
      if (spd > 1.5 && !finishing) {
        const ax = aim.x - p.pos.x, az = aim.z - p.pos.z;
        const al = Math.hypot(ax, az);
        // 目標へ動く → 脚は進行方向を向く。遠ざかる遅いシャッフルは胸を向けたまま
        // バックペダル、本気のスプリントで遠ざかるときは向きを変えて走る。
        const committed = spd > p.runSpeed * 0.72;
        if (al > 0.05 && ((p.velX * ax + p.velZ * az) / (spd * al) > -0.26 || committed)) {
          lx = p.pos.x + p.velX;
          lz = p.pos.z + p.velZ;
        }
      }
      // 体をひねって振る速さ — 敏捷性＋ロール能力（守備者は守備、攻撃者はオフェンス）で決まる。
      const offense = p.team === game.possession;
      const quick = rate(p.attr.agility);
      const skill = offense ? rate(p.attr.offense) : rate(p.attr.defense);
      const turnRate = 2.2 + (quick * 0.6 + skill * 0.4) * 6;   // ~2.2（遅い）.. ~8.2（速い）rad/s
      p.faceSmooth(lx, lz, turnRate * dt);                       // 下半身（脚／腰）
      p.twistToward(aim.x, aim.z, dt, undefined, turnRate * 1.25); // 上半身（胸）、少し速め
      // 頭は注視対象（ボール、または攻めるリム）を胸の動きに重ねて追う
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
