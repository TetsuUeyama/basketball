// ボールを守る/運ぶ側の選択: 運び上げ(bringUpLane/outletTo/advanceSafely)と、
// 抜けないハンドラーのキープ(mustKeepDribble/keepDribbleDecide)、トラップの解決。
import { Vector3 } from "@babylonjs/core";
import { Player } from "../../../objects/player/player";
import { COURT, MAX_PASS } from "../../../config";
import { rate, chance, dist2D, dist2DTo } from "../../../util";
import { pass, passToReceiver } from "../../../move/action/passing";
import { finishAtRim } from "../../../move/action/shooting";
import { laneVetoed, passRisk } from "../../../move/reaction/pass-risk";
import { doubleTeamed, openSide } from "../reads";
import type { Game } from "../../../game";

// この D精度未満のハンドラーはドリブルで抜け（クロスオーバー/ブロウバイ/ポスト）を
// 仕掛けられず、キープ（シールド/にじり寄り/味方へ渡す）のみ
const KEEP_DRIBBLE_THRESH = 0.55;

  // マークされた下手なハンドラー(低 D精度)はキープするしかない。
  // フロントコートで守備者が付き、クロックに余裕がある時に真。
export function mustKeepDribble(game: Game, h: Player, dDef: number): boolean {
    if (!game.frontT) return false;                          // 運び上げは別所で処理
    if (dDef > 1.8) return false;                            // 誰も付いていない → 自由にドリブル
    if (game.shotClock < 4) return false;                    // クロック切れ間近 → 得点を試みねば
    // フィジカル型(ビッグ/post)はゴール下では背中で押し込んで勝負する。ハンドリングが
    // 低くてもシールド/組み立て回避に回さず、ポストアップ(体で押す)へ通す。
    if ((game.isBig(h) || h.has("post")) && dist2D(h.pos, game.attackFloor(h.team)) < 6.5) return false;
    return rate(h.attr.dribbleAcc) < KEEP_DRIBBLE_THRESH;    // 本当に下手なハンドルのみ
  }

  // マークされた下手なハンドラーのキープ専用の選択肢: 渡す/じりじり前進/保持してシールド。
export function keepDribbleDecide(game: Game, h: Player, dHoop: number, dDef: number, rimFloor: Vector3): void {
    // ダブルチーム: ハンドルの低い選手は組み立てに加わらない — 抱え込まず即捌く。
    // 開いた味方へパス → 無ければトラップが空けた味方へキックアウト → それも無ければ
    // 圧から一歩引いて立て直す(リム方向へにじり寄らない)。
    if (doubleTeamed(game, h)) {
      if (pass(game, h)) return;
      if (trapKickOut(game, h)) return;
      retreatFromTrap(game, h);
      return;
    }
    // 僅かな隙間があるリム際 → それでも決める(イージーな一本は決して断らない)
    if (dHoop < 2.0 && dDef > 0.85) { finishAtRim(game, h, dDef); return; }
    // ヘルプが来た → 即座に手放す
    if (pass(game, h)) return;
    // さもなければキープ: ほぼ保持&シールド、時々リムへじりじり寄る
    if (chance(0.3) && dHoop > 1.9) {
      game.setDrive(h, rimFloor, Math.max(1.7, dHoop - 0.5));  // ゆっくり守りながら一歩入る
    } else {
      game.setDrive(h, rimFloor, dHoop);                       // 保持: 目標 ≈ 現在地 → 前進なし
    }
    h.keepShieldT = 0.5;   // ドリブルを這うほどに絞り + 体を斜めに(移動 + 向き)
  }

  // ボールをウイングのレーンでフロントコートへ運び上げる。中央から外れていれば
  // その側を保ち、ど真ん中からは空いた側を選ぶ。
export function bringUpLane(game: Game, h: Player): void {
    const s = game.attackSign(h.team);
    const side = Math.abs(h.pos.x) > 1.5 ? Math.sign(h.pos.x) : openSide(game, h);
    // 目標をフロントコート(トップ付近)まで遠くに固定して連続的に運ぶ。近い点にすると
    // 決定間隔(~0.3s)ごとに目標へ届いて止まり「歩いて止まって」のかくつきになるため、
    // 常に十分前方を目標にして滑らかに運ぶ(走っても止まらず歩いてもOK)。
    const tz = game.attackFloor(h.team).z - s * 8;   // フロントコートのトップ付近
    h.driveTarget.set(side * 5.5, 0, tz);
  }

  // 運び上げてくるガードへボールを渡す: 射程内で覆われていない時のみ。
export function outletTo(game: Game, h: Player, g: Player): boolean {
    if (dist2D(h.pos, g.pos) > MAX_PASS) return false;
    if (game.nearestDefenderDist(g) < 1.2) return false;   // まだ覆われている — 待つ
    return passToReceiver(game, h, g);
  }

  // まだアウトレットに空いたガードがいない → ビッグはトップオブザキーへ運び続ける。
  // アウトレットは決定tick毎に再チェックし、誰も空かなければ自分で運び上げる。
export function advanceSafely(game: Game, h: Player): void {
    // 結局運び上げるビッグも、中央でなくサイドのレーンを使う
    if (!game.frontT) bringUpLane(game, h);
    else game.setDrive(h, game.attackFloor(h.team), 8);   // フロントコートの、ほぼトップオブザキー
  }

  // トラップをパスで解決する: ダブルチームが空けた本当にオープンな味方へのみ通す。
  // 強制パスは通常のリスクゲートを飛ばすが、覆われた選手/レーン内の体へは強行しない。
export function trapKickOut(game: Game, h: Player): boolean {
    let best: Player | null = null, bestScore = 0;
    let bestVet = false;
    for (const mate of game.teamPlayers(h.team)) {
      if (mate === h) continue;
      if (dist2D(h.pos, mate.pos) > MAX_PASS) continue;
      // フロントコート確立後、まだハーフを越えていない味方へは返さない — オーバー&バック違反。
      // (後方の後追いは誰も見ておらず「最もオープン」に見えるので明示的に除外する)
      if (game.frontT && game.attackSign(h.team) * mate.pos.z < 0.4) continue;
      // トラップから別のトラップへキックしない — ダブルチームされた味方はスキップ
      if (doubleTeamed(game, mate) || mate.trappedT > 0) continue;
      const open = game.nearestDefenderDist(mate);
      if (open < 1.6) continue;                         // 本当にオープンな選手のみ
      // レーンに体が居てもバウンドパスが手の下を通る — 得点で少し損するだけ
      const vet = laneVetoed(game.oppTeam(h), h, mate);
      const score = open - passRisk(game.oppTeam(h), h, mate) * 2 - (vet ? 0.6 : 0);
      if (score > bestScore) { bestScore = score; best = mate; bestVet = vet; }
    }
    if (!best) return false;
    if (bestVet || chance(0.25)) {
      // 頭上が塞がれている(または気まぐれに) → バウンドパス: 手の下を突いて味方へ
      return passToReceiver(game, h, best, true, "bounce");
    }
    // 頭上が使える → 本物のジャンプパス: ダンク級に跳び、最高点から頭上を越す
    h.jump(0.5, 0.6);
    game.pendingPassTo = best;
    game.pendingPassT = 0.22;
    return true;
  }

  // トラップを回避する: オープンなフロアへリトリートドリブルしてダブルチームを破る。
  // 合法な進行方向をサンプリングし、実際に距離を稼げる方向を取る(中央/上方向へ少し偏らせる)。
export function retreatFromTrap(game: Game, h: Player): void {
    const defs = game.teamPlayers(1 - h.team).slice()
      .sort((a, b) => dist2D(a.pos, h.pos) - dist2D(b.pos, h.pos));
    const a = defs[0], b2 = defs[1] ?? defs[0];
    const s = game.attackSign(h.team);
    let bx = 0, bz = game.frontT ? s * 2 : 0;   // フォールバック: フロア中央へ向かう
    let bestScore = -Infinity;
    for (let i = 0; i < 12; i++) {
      const ang = (i / 12) * Math.PI * 2;
      const tx = h.pos.x + Math.cos(ang) * 3.0;
      const tz = h.pos.z + Math.sin(ang) * 3.0;
      if (Math.abs(tx) > COURT.halfW - 0.7 || Math.abs(tz) > COURT.halfL - 0.7) continue;
      if (game.frontT && s * tz < 0.5) continue;   // バックコートバイオレーションへは決して退かない
      const sep = Math.min(dist2DTo(a.pos, tx, tz), dist2DTo(b2.pos, tx, tz));
      let score = sep - Math.abs(tx) * 0.08;       // サイドラインから少し引く
      if (!game.frontT) score += s * (tz - h.pos.z) * 0.10;   // 運び上げ中: 前方への逃げを優先
      if (score > bestScore) { bestScore = score; bx = tx; bz = tz; }
    }
    h.driveTarget.set(bx, 0, bz);
  }
