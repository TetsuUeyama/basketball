// デッドボール解決。ターンオーバー(turnover)、ショットクロック違反(shotClockViolation)、
// ディフェンシブファウル(defensiveFoul)と、その後のサイドスローイン(sideInbound)。
// ポゼッション交代とスローイン再開を司る。
import { Player } from "../objects/player/player";
import { COURT, SHOT_CLOCK, SHOT_CLOCK_PARTIAL, OOB_OUTSET, INBOUNDS_INSET, teamShort } from "../config";
import { rate, clamp, dist2D, nearestOf } from "../util";
import { withSubs } from "../systems/subs";
import type { Game } from "../game";

  // シュート以外（リーチイン）のファウル: オフェンスがボールを保持してスローインする。
export function defensiveFoul(game: Game, victim: Player, fouler?: Player): void {
    // ぶつけてきた相手から弾かれる。強さはファウル側の強さ／アグレッシブと受け手のバランスで決まる
    let px = 0, pz = 0, strength = 0.5;
    if (fouler) {
      px = victim.pos.x - fouler.pos.x;
      pz = victim.pos.z - fouler.pos.z;
      strength = clamp(0.3 + rate(fouler.attr.balance) * 0.4 + rate(fouler.attr.aggression) * 0.2
        - rate(victim.attr.balance) * 0.35, 0.1, 1);
    }
    victim.foulReaction("hurt", px, pz, strength);   // 接触でよろける
    game.setEvent("FOUL", victim.team);
    game.possession = victim.team;
    game.handler = null;
    game.partialShotClock(); // 部分リセット
    // 一拍保持 → 交代 → サイドスローイン（ファウルされた選手が投げる）
    game.pauseThen(1.2, () => withSubs(game, () => sideInbound(game, victim), victim));
  }

export function sideInbound(game: Game, victim: Player): void {
    game.possession = victim.team;
    game.handler = victim;
    game.ballMode = "inbound";
    game.inbound.t = 1.0;
    // 再開がどちらのボールか表示する
    game.setEvent(`THROW-IN\n${teamShort(victim.team)} BALL`, victim.team, 2.0);
    const sideX = victim.pos.x >= 0 ? COURT.halfW + OOB_OUTSET : -(COURT.halfW + OOB_OUTSET);
    victim.pos.set(sideX, 0, clamp(victim.pos.z, -COURT.halfL + INBOUNDS_INSET, COURT.halfL - INBOUNDS_INSET));
    game.resetMotion();
    game.inbound.receiver = game.inbound.pickReceiver(victim);
  }

  // ショットクロック満了はオフェンスのバイオレーション。オフェンスに
  // ターンオーバーを記録し、守備がスローインで再開する。
export function shotClockViolation(game: Game): void {
    const off = game.handler ?? game.teamPlayers(game.possession)[0];
    off.stats.tov++;
    const offTeam = game.possession;   // バイオレーションを犯したチーム
    const def = 1 - offTeam;
    // スローインはボールが止まった地点から。地点を今記憶しておく（ポーズ中に動く前に）。
    // 新オフェンスのフロントコートなら再開クロックは短い方、バックコートならフル。
    const sx = game.ball.pos.x, sz = game.ball.pos.z;
    const front = sz * game.attackSign(def) > 0;
    game.handler = null;
    game.setEvent("SHOT CLOCK VIOLATION", offTeam, 2.6);
    game.pauseThen(1.2, () => withSubs(game, () => game.inbound.startAt(def, sx, sz,
      { clock: front ? SHOT_CLOCK_PARTIAL : SHOT_CLOCK })));
  }

export function turnover(game: Game, loser: Player, reason: string): void {
    loser.stats.tov++;
    // 最も近い相手にボールを渡す
    const near = nearestOf(game.teamPlayers(1 - loser.team), (p) => dist2D(p.pos, loser.pos))!;
    game.handler = near;
    game.possession = near.team;
    game.ballMode = "held";
    game.shotClock = SHOT_CLOCK;
    near.decisionT = 0.4;
    game.resetMotion();
    game.leakOut();          // 飛び出しランナーが走り出す
    game.setEvent(reason, near.team);
  }
