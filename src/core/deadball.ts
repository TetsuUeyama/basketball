// デッドボール解決（方式B: GameState 集約）。ターンオーバー(turnover)、ショット
// クロック違反(shotClockViolation)、ディフェンシブファウル(defensiveFoul)と、その後の
// サイドスローイン(sideInbound)。ポゼッション交代とスローイン再開を司る。共有インフラの
// pauseThen/updatePause は Game 残置(多所参照)。状態は Game に集約し game を受け取る。
import { Player } from "../objects/player/player";
import { COURT, SHOT_CLOCK, SHOT_CLOCK_PARTIAL, teamShort } from "../config";
import { clamp, dist2D } from "../util";
import { rate } from "../attributes";
import { withSubs } from "../systems/subs";
import type { Game } from "../game";

  // シュート以外（リーチイン）のファウル: オフェンスがボールを保持してスローインする。
export function defensiveFoul(game: Game, victim: Player, fouler?: Player): void {
    // ぶつけてきた相手から弾かれる。強さは、ファウルした側の強さ／アグレッシブさと、
    // 受けた側がどれだけバランスを保てるかで決まる
    let px = 0, pz = 0, strength = 0.5;
    if (fouler) {
      px = victim.pos.x - fouler.pos.x;
      pz = victim.pos.z - fouler.pos.z;
      strength = clamp(0.3 + rate(fouler.attr.balance) * 0.4 + rate(fouler.attr.aggression) * 0.2
        - rate(victim.attr.balance) * 0.35, 0.1, 1);
    }
    victim.foulReaction("hurt", px, pz, strength);   // プレイが止まる間、接触でよろける
    game.setEvent("FOUL", victim.team);
    game.possession = victim.team;
    game.handler = null;
    game.shotClock = Math.max(game.shotClock, SHOT_CLOCK_PARTIAL); // ファウルでは部分リセット
    // ファウルが見えるよう一拍保持し、次に交代、次にサイドスローイン（ファウルされた
    // 選手がボールをスローインするので、ここでは交代できない）
    game.pauseThen(1.2, () => withSubs(game, () => sideInbound(game, victim), victim));
  }

export function sideInbound(game: Game, victim: Player): void {
    game.possession = victim.team;
    game.handler = victim;
    game.ballMode = "inbound";
    game.inbound.t = 1.0;
    // 再開がどちらのボールか（ファウルのコールは画面に一拍表示された後）
    game.setEvent(`THROW-IN\n${teamShort(victim.team)} BALL`, victim.team, 2.0);
    const sideX = victim.pos.x >= 0 ? COURT.halfW + 0.3 : -(COURT.halfW + 0.3);
    victim.pos.set(sideX, 0, clamp(victim.pos.z, -COURT.halfL + 1, COURT.halfL - 1));
    game.resetMotion();
    game.inbound.receiver = game.inbound.pickReceiver(victim);
  }

  // ショットクロックの満了はオフェンスのバイオレーション: デッドボール（生きた
  // スティールではない）。プレイが止まり、オフェンスにターンオーバーが記録され、
  // 守備がスローインで再開する。
export function shotClockViolation(game: Game): void {
    const off = game.handler ?? game.teamPlayers(game.possession)[0];
    off.stats.tov++;
    const offTeam = game.possession;   // バイオレーションを犯したチーム
    const def = 1 - offTeam;
    // FIBA: スローインは、プレイが止まった場所に最も近いアウトオブバウンズ地点から行う
    // （24秒バイオレーションの特例はない）— デッドボールのポーズで誰かが動く前に、今
    // それを記憶しておく。クロックのルールは地点に従う: 新オフェンスのフロントコート
    // （すなわちバイオレーションが旧オフェンスのバックコートで犯された、押し込まれた
    // 運び上げ）では再開クロックは短い方。バックコートのスローインはフルクロックで再開する。
    const sx = game.ball.pos.x, sz = game.ball.pos.z;
    const front = sz * game.attackSign(def) > 0;
    game.handler = null;
    // オフェンスのバイオレーション（オフェンスに帰属）をアナウンスし、守備のスローイン
    // 再開の前に、デッドボールのポーズの間ずっと画面に表示し続ける
    game.setEvent("SHOT CLOCK VIOLATION", offTeam, 2.6);
    // 続いて再開バナーが、スローインがどちらのボールかを表示する
    game.pauseThen(1.2, () => withSubs(game, () => game.inbound.startAt(def, sx, sz,
      { clock: front ? SHOT_CLOCK_PARTIAL : SHOT_CLOCK })));
  }

export function turnover(game: Game, loser: Player, reason: string): void {
    loser.stats.tov++;
    // 最も近い相手にボールを渡す
    const opp = game.teamPlayers(1 - loser.team);
    let near = opp[0];
    for (const p of opp) {
      if (dist2D(p.pos, loser.pos) < dist2D(near.pos, loser.pos)) near = p;
    }
    game.handler = near;
    game.possession = near.team;
    game.ballMode = "held";
    game.shotClock = SHOT_CLOCK;
    near.decisionT = 0.4;
    game.resetMotion();
    game.leakOut();          // ターンオーバーで飛び出しランナーが走り出す
    game.setEvent(reason, near.team);
  }
