// スキーム選択: この停止/ポゼッションで守備が man / zone / press のどれを敷くかを決める。
import { chance } from "../../../util";
import type { Game } from "../../../game";

// この停止/ポゼッションで守備がどのスキームを敷くか(man/zone/press)を抽選して決める。
export function pickDefScheme(game: Game): void {
  const defTeam = 1 - game.possession;
  const tac = game.tactics[defTeam].defense;
  game.pressOn = chance(tac.press);
  // プレスもボールが上がれば man に落ちる。非プレスのみゾーンに commit。
  if (!game.pressOn && chance(tac.zone)) {
    const bigs = game.teamPlayers(defTeam).filter((p) => game.isBig(p));
    const tall = bigs.length ? bigs.reduce((s, p) => s + p.height, 0) / bigs.length : 2;
    // 高いフロントラインは 2-3、そうでなければ時々 3-2 でアークを守る
    game.zoneScheme = (tall > 2.02 || chance(0.6)) ? "2-3" : "3-2";
  } else {
    game.zoneScheme = "";
  }
}
