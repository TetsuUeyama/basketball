// ボール保持(ballMode "held")中のライブプレイ tick。ドリブルのケイデンス前進、
// オフェンス/守備/はたきの毎フレーム進行、キャリー/ギャザー/ピックアップのボール位置決め。
import { rate, clamp, dist2D, chance, dirTo2D } from "../../util";
import { runOffense } from "../../ai/offense";
import { runDefense, catchStrips, swarmStrips } from "../../ai/defense";
import { passToReceiver } from "./passing";
import type { Game } from "../../game";

export function updateLive(game: Game, dt: number): void {
  const h = game.handler!;
  // ジャンプパスのウィンドアップ中: 跳び上がってボールを頭上に掲げ、最高点
  // 付近でリリース。コミット済みなので判断もドライブもしない。
  if (game.pendingPassTo) {
    game.pendingPassT -= dt;
    // ターンパス: 体をターゲットへ回す間、ボールは手の中で下のままにする
    // （updateFacing が回転させる）。ジャンプパスは代わりにボールを頭上へ持ち上げる。
    if (game.pendingPassTurn) game.ball.pos.set(h.pos.x + h.carryX, 1.0, h.pos.z + h.carryZ);
    else game.ball.pos.set(h.pos.x, 2.0, h.pos.z);
    if (game.pendingPassT <= 0) {
      const target = game.pendingPassTo;
      const turn = game.pendingPassTurn;
      game.pendingPassTo = null;
      game.pendingPassTurn = false;
      if (turn) {
        // ピボット完了 → 通常のパス（強制でない）としてリリース: レーン/リスクの安全ゲートは
        // 走り、弧のチェックだけスキップ（すでに正対済み）。
        game.turnReleased = true;
        passToReceiver(game, h, target, false, "chest");
        game.turnReleased = false;
      } else {
        passToReceiver(game, h, target, true, "jump");   // トラップ越しのコミット済みキックアウト
      }
    }
    runDefense(game, dt);
    return;
  }
  if (game.pushT > 0) game.pushT = Math.max(0, game.pushT - dt);
  // 先にドリブルのケイデンスを進め、このフレームでボールが手にあるかを最新化する。
  h.dribblePhase += dt * (1.6 + rate(h.attr.dribbleAcc) * 1.4);   // 1.6 .. 3.0 Hz
  // ボールが明確にハーフを越えた → このポゼッションのフロントコートが確立
  if (!game.frontT && game.attackSign(h.team) * h.pos.z > 0.6) game.frontT = true;
  runOffense(game, dt, h);
  runDefense(game, dt);
  catchStrips(game, dt);
  if (game.ballMode !== "held") return;   // こぼれかけたキャッチからはたき出された
  swarmStrips(game, dt);
  if (game.ballMode !== "held") return;   // このフレームのはたきでドリブルが終わった
  // ドリブルのキャリー位置: 生きたボールがハンドラーのどこに収まるか。前方=リム方向へ押す、
  // 守備者に正対時は遠い側の腰へ、ベイト(baitT)中はわざと前方に見せる。移動の速さは D精度。
  const rim = game.attackFloor(h.team);
  const { ux: fx, uz: fz } = dirTo2D(h.pos.x, h.pos.z, rim.x, rim.z);
  let tx = fx * 0.5, tz = fz * 0.5;                    // デフォルト: 前方キャリー
  const od = game.onBallDefender(h);
  const dOn = od ? dist2D(od.pos, h.pos) : 99;
  if (h.baitT > 0) {
    tx = fx * 0.6; tz = fz * 0.6;                      // 見せているボール
  } else if (od && dOn < 1.7) {
    // 正対／シールド中: ひねった上体を基準に、守備者から遠い側の腰へボールを収める。
    const cf = h.chestFront(1);                                   // 胸の前方（ひねりを考慮）、単位ベクトル
    let cx = cf.x - h.pos.x, cz = cf.z - h.pos.z;
    const cl = Math.hypot(cx, cz) || 1; cx /= cl; cz /= cl;
    let lx = -cz, lz = cx;                                        // 胸の横方向の軸
    const side = ((od.pos.x - h.pos.x) * lx + (od.pos.z - h.pos.z) * lz) > 0 ? -1 : 1;  // 遠い側の腰
    tx = cx * 0.12 + lx * side * 0.30;                            // 胸の前 ＋ 遠い側の腰へ
    tz = cz * 0.12 + lz * side * 0.30;
  }
  // 持ち替え/クロスオーバーの速さは D精度 依存(~0.9m の左右持ち替えで下手≈1.8s / 上手≈0.45s)。
  const cs = (0.5 + rate(h.attr.dribbleAcc) * 1.5) * dt;   // 0.5 .. 2.0 m/s
  h.carryX += clamp(tx - h.carryX, -cs, cs);
  h.carryZ += clamp(tz - h.carryZ, -cs, cs);
  // スティール誘い: 壁を作られた状態で、巧いハンドラーがボールをちらつかせ突きを誘う
  if (h.baitT <= 0 && od && dOn < 1.3 && h.beatenT <= 0 && h.powerT <= 0
      && h.jukeT <= 0 && chance(dt * (0.1 + rate(h.attr.handling) * 0.45))) {
    h.baitT = 0.5;
  }
  // ピックアップのすくい上げ: ルーズボール確保直後、床からボールを持ち上げキャリーへ入れる。
  // 足首の高さから pickupT かけてポケットへ上がる。短いすくい上げ中はドリブルの弾みを上書き。
  if (h.pickupT > 0) {
    const prog = h.pickupDur > 0 ? clamp(1 - h.pickupT / h.pickupDur, 0, 1) : 1;
    const scoop = h.chestFront(0.24);
    const py = 0.22 + (0.95 - 0.22) * prog;                    // 床 → キャリーの高さ
    game.ball.pos.set(
      h.pos.x + (scoop.x - h.pos.x) * prog,
      py,
      h.pos.z + (scoop.z - h.pos.z) * prog,
    );
  } else {
    // 運ぶボールは手の高さと床の間で弾む（ダムダム）
    const bounce = Math.abs(Math.cos(Math.PI * h.dribblePhase)); // 1 = 手の位置、0 = 床
    const y = 0.18 + (1.0 - 0.18) * bounce;
    game.ball.pos.set(h.pos.x + h.carryX, y, h.pos.z + h.carryZ);
  }
  // まだ収まっていない: キャッチ直後、ボールは胸の前・両手のひらの間に保持される。
  // 揺れは gatherT に位相を合わせた低周波の揺らぎで、硬直が減るにつれ減衰する。
  if (h.gatherT > 0) {
    const amp = Math.min(0.03, h.gatherT * 0.06);   // 大きな揺れでなく、小さな震え
    const ph = h.gatherT * 16 + h.idx;              // gatherT が減るにつれて滑らかに動く
    const prog = h.gatherDur > 0 ? clamp(1 - h.gatherT / h.gatherDur, 0, 1) : 1;
    const c = h.chestFront(0.30);
    let tx = c.x, tz = c.z, ty = 1.0;
    const rimF = game.attackFloor(h.team);
    if (h.catchIntent === "shield") {
      // プレッシャー下: ひねった胸のすぐ前に置き、守備者から遠い側の腰へずらして上体の陰に隠す。
      const front = h.chestFront(0.18);            // 背けてひねった胸の前
      let hx = front.x, hz = front.z;
      const nd = game.nearestDefender(h);
      if (nd) {
        const f = h.chestFront(1);                 // 胸の前方（単位ベクトル）
        let fx = f.x - h.pos.x, fz = f.z - h.pos.z;
        const fl = Math.hypot(fx, fz) || 1; fx /= fl; fz /= fl;
        let lx = -fz, lz = fx;                     // 横方向（直角）の軸
        const ax = h.pos.x - nd.pos.x, az = h.pos.z - nd.pos.z;   // 守備者から遠ざかる向き
        if (lx * ax + lz * az < 0) { lx = -lx; lz = -lz; }        // 遠い側の腰の側を選ぶ
        hx += lx * 0.16; hz += lz * 0.16;          // 遠い側の腰へずらす（それでも手の届く範囲）
      }
      tx = c.x + (hx - c.x) * prog;                // キャッチ地点から遠い側の腰へ収める
      tz = c.z + (hz - c.z) * prog;
      ty = 1.0 - prog * 0.08;                      // 守られたキャリーへ少し下げる
    } else if (h.catchIntent === "shoot") {
      // キャッチアンドシュート: 胸の前へ持ち上げてショットポケットに入れ、
      // キャッチが収まるにつれてシュートフォームへ上げていく。
      const sp = h.chestFront(0.26);
      tx = sp.x; tz = sp.z;
      ty = 1.0 + prog * 0.35;                       // ポケットへ上げる
    } else {
      // オープン: 収めず、リム方向（ドライブの向き）へ一歩リードさせすぐ動ける構えに。
      const { ux, uz } = dirTo2D(h.pos.x, h.pos.z, rimF.x, rimF.z);
      tx = c.x + ux * 0.14 * prog;
      tz = c.z + uz * 0.14 * prog;
    }
    game.ball.pos.set(
      tx + Math.sin(ph) * amp,
      ty + Math.sin(ph * 1.7 + 0.9) * amp * 0.45,   // 胸の高さ、緩やかな上下の揺れ
      tz + Math.sin(ph * 1.35 + 2.1) * amp,
    );
  }
}
