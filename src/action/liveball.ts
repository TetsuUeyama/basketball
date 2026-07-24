// ボール保持(ballMode "held")中のライブプレイ tick。ドリブルのケイデンス前進、
// オフェンス/守備/はたきの毎フレーム進行、そしてキャリー/ギャザー/ピックアップの
// ボール位置決め。方式A: game を第一引数に取る関数。game.ts の更新ループ switch の
// "held" ケースから呼ぶ。game.ts から分離（workPlan.md Phase4 / [[game-split-optionb]]）。
import { rate } from "../attributes";
import { clamp, dist2D, chance } from "../util";
import { runOffense } from "./offense";
import { runDefense, catchStrips, swarmStrips } from "./defense";
import { passToReceiver } from "./passing";
import type { Game } from "../game";

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
        // ピボット完了 → 通常のパス（強制でない）としてリリースするので、レーン／
        // リスクの安全ゲートが依然として走る: 回転中に守備者がレーンに回り込んだ場合、
        // 投げは拒否され（彼は保持する）、そこへ投げ込まれない。弧のチェックだけが
        // スキップされる（彼はすでに正対済み）。
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
  // 先にドリブルのケイデンスを進め、このフレームでボールが手にあるかの判定を最新に
  // する: D精度 がつく回数（レート）を決める（下手なハンドラーはゆっくりドリブルし、
  // ボールが手から離れている時間が長い）
  h.dribblePhase += dt * (1.6 + rate(h.attr.dribbleAcc) * 1.4);   // 1.6 .. 3.0 Hz
  // ボールが明確にハーフを越えた → このポゼッションのフロントコートが確立
  if (!game.frontT && game.attackSign(h.team) * h.pos.z > 0.6) game.frontT = true;
  runOffense(game, dt, h);
  runDefense(game, dt);
  catchStrips(game, dt);
  if (game.ballMode !== "held") return;   // こぼれかけたキャッチからはたき出された
  swarmStrips(game, dt);
  if (game.ballMode !== "held") return;   // このフレームのはたきでドリブルが終わった
  // --- ドリブルのキャリー位置: 生きたボールがハンドラーの周りのどこに収まるか。
  // 前方（リム方向）ならボールを押して走れる — ただしガードする相手にさらされる。
  // 守備者に正対するときは遠い側の腰へ収める。位置間の移動の速さは D精度。
  // ベイト(baitT)中は、リーチインを誘うためにわざと前方に見せる。
  const rim = game.attackFloor(h.team);
  const dx = rim.x - h.pos.x, dz = rim.z - h.pos.z;
  const len = Math.hypot(dx, dz) || 1;
  const fx = dx / len, fz = dz / len;
  let tx = fx * 0.5, tz = fz * 0.5;                    // デフォルト: 前方キャリー
  const od = game.onBallDefender(h);
  const dOn = od ? dist2D(od.pos, h.pos) : 99;
  if (h.baitT > 0) {
    tx = fx * 0.6; tz = fz * 0.6;                      // 見せているボール
  } else if (od && dOn < 1.7) {
    // 正対／シールド中: ボールを、彼自身の（ひねった）上体を基準にした遠い側の腰へ
    // 収める — 実際に手が届く場所。旧コードは向きを無視してリム基準で置いていたので、
    // 彼が隠そうとひねると、ボールが手のひらの届かない背中の真後ろに来てしまった。今は
    // ひねった胸の前に位置し、守備者から遠い側の腰へずらす。
    const cf = h.chestFront(1);                                   // 胸の前方（ひねりを考慮）、単位ベクトル
    let cx = cf.x - h.pos.x, cz = cf.z - h.pos.z;
    const cl = Math.hypot(cx, cz) || 1; cx /= cl; cz /= cl;
    let lx = -cz, lz = cx;                                        // 胸の横方向の軸
    const side = ((od.pos.x - h.pos.x) * lx + (od.pos.z - h.pos.z) * lz) > 0 ? -1 : 1;  // 遠い側の腰
    tx = cx * 0.12 + lx * side * 0.30;                            // 胸の前 ＋ 遠い側の腰へ
    tz = cz * 0.12 + lz * side * 0.30;
  }
  // 持ち替え/クロスオーバーの速さは D精度 依存。下手ほどモッサリ、上手いほど素早い
  // (~0.9 m の左右持ち替えで下手≈1.8s / 上手≈0.45s)。全体に遅めで、持ち替えに
  // ちゃんと「時間がかかる」よう調整した。
  const cs = (0.5 + rate(h.attr.dribbleAcc) * 1.5) * dt;   // 0.5 .. 2.0 m/s
  h.carryX += clamp(tx - h.carryX, -cs, cs);
  h.carryZ += clamp(tz - h.carryZ, -cs, cs);
  // スティール誘い: 守備者にぴたりと壁を作られた状態で、巧いハンドラーは
  // ボールをちらつかせ、引き抜く用意のある突きを誘う
  if (h.baitT <= 0 && od && dOn < 1.3 && h.beatenT <= 0 && h.powerT <= 0
      && h.jukeT <= 0 && chance(dt * (0.1 + rate(h.attr.handling) * 0.45))) {
    h.baitT = 0.5;
  }
  // ピックアップのすくい上げ: ルーズボールを確保した直後、手を下へ伸ばして床から
  // ボールを持ち上げてキャリーへ入れる（跳ねない）。ボールは足首の高さから pickupT
  // かけてポケットへ上がる。手はそれを追う(holdBallHands)ので、きれいな手での拾い上げ
  // として見える。短いすくい上げの間、ドリブルの弾みを上書きする。
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
  // まだ収まっていない: 的を外れたキャッチの直後、ボールは確保されていない —
  // 両手のキャッチがボールを受けた場所、すなわち胸の前で、両手のひらの間に
  // 保持されたままになる。揺れは滑らかな低周波の揺らぎ（減っていく gatherT に
  // 位相を合わせ、毎フレームのノイズはない）: 手は同じ揺れる点を狙っている
  // (poseHands の holdBallHands)ので、ボールと腕は一体として動く — 震えは上腕に
  // 現れ、静止した手のひらの間でボールがガタつくようには見えない。硬直が減るに
  // つれて減衰し、その後は通常の片手キャリーに引き継がれる。
  if (h.gatherT > 0) {
    const amp = Math.min(0.03, h.gatherT * 0.06);   // 大きな揺れでなく、小さな震え
    const ph = h.gatherT * 16 + h.idx;              // gatherT が減るにつれて滑らかに動く
    const prog = h.gatherDur > 0 ? clamp(1 - h.gatherT / h.gatherDur, 0, 1) : 1;
    const c = h.chestFront(0.30);
    let tx = c.x, tz = c.z, ty = 1.0;
    const rimF = game.attackFloor(h.team);
    if (h.catchIntent === "shield") {
      // プレッシャー下: ボールを遠い側の腰へ収める — ただし手が実際に届く腰。胸は
      // 守備者から背けてひねっている(updateFacing)ので、ボールをそのひねった胸のすぐ
      // 前に置き、遠い側へずらす。結果として、背中の真後ろに来ることなく、回した上体の
      // 陰に隠れる（旧来のワールド座標での「守備者から遠ざける」オフセットは、相手が
      // 真正面にいるとき手のひらの届かない場所に置いていた）。
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
      // オープン: 次の動きへ向けてボールを運び出す — 収めるのでなく、リム方向
      // （ドライブの向き）へ一歩リードさせ、すぐ動ける構えにする。
      const dx = rimF.x - h.pos.x, dz = rimF.z - h.pos.z;
      const dl = Math.hypot(dx, dz) || 1;
      tx = c.x + (dx / dl) * 0.14 * prog;
      tz = c.z + (dz / dl) * 0.14 * prog;
    }
    game.ball.pos.set(
      tx + Math.sin(ph) * amp,
      ty + Math.sin(ph * 1.7 + 0.9) * amp * 0.45,   // 胸の高さ、緩やかな上下の揺れ
      tz + Math.sin(ph * 1.35 + 2.1) * amp,
    );
  }
}
