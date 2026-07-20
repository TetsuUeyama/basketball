import { Scene, Vector3, Mesh } from "@babylonjs/core";
import { Player, Ball } from "./entities";
import { makeHandlerRing, hoopIndex, type Hoops } from "./court";
import {
  COURT, RIM, THREE_DIST, PASS_SPEED,
  SHOT_CLOCK, SHOT_CLOCK_PARTIAL, QUARTER_TIME, QUARTERS, TEAM_COLORS, teamShort,
} from "./config";
import { clamp, dist2D, dist2DTo, moveToward2D, chance, rand } from "./util";
import { ROSTER, ROSTER_SIZE, STARTERS, TACTICS, rate, AbilityKey,
  scoringPower, usageFromRank } from "./attributes";

export type BallMode = "held" | "charge" | "pass" | "shot" | "loose" | "inbound" | "tipoff" | "freethrow" | "pause" | "subs" | "finale";

// how close (metres) a defender must be to the passing lane to threaten it
const LANE_W = 1.1;
// nobody attempts a pass longer than this — a cross-court bomb isn't a read
// (the ロング throw-in outlet is a separate, deliberate play)
const MAX_PASS = 13;
type GameState = "live" | "final";

// Brief on-screen event text (e.g. "3 POINTS!", "STEAL").
export interface GameEvent { text: string; team: number; scorer?: string; assist?: string; }

export class Game {
  readonly players: Player[] = [];   // ON COURT: [0..4] = team 0 slots, [5..9] = team 1 slots
  readonly roster: Player[][] = [[], []]; // full 13-man rosters (starters + bench)
  subsMade = 0;                      // substitutions this game (debug/telemetry)
  // recent substitutions, shown by the UI as a "メンバーチェンジ" feed
  // The UI shows HOME (team 0) chips first; AWAY (team 1) chips are FROZEN (their
  // ttl doesn't tick and they aren't shown) while any HOME chip is still live —
  // so the feed plays all HOME subs, clears, then all AWAY subs from the first.
  readonly subEvents: { inNum: number; inName: string; outNum: number; outName: string; team: number; ttl: number }[] = [];
  // substitution walk-on/walk-off animation ("subs" ball mode): each walker
  // heads to his target; play resumes (subNext) once everyone has arrived
  private subWalkers: { p: Player; tx: number; tz: number }[] = [];
  private subNext: (() => void) | null = null;
  private subT = 0;
  // bench celebration timers per team — while positive, the bench is on its
  // feet bouncing with both arms up (a short grace period lets jumps land)
  private cheerT: [number, number] = [0, 0];
  private cheerAmp: [number, number] = [0.5, 0.5];   // celebration intensity (bigger for dunks / threes)
  readonly ball: Ball;
  private readonly ring: Mesh;
  private readonly tactics = TACTICS; // per-team game plan

  // TEMP debug (remove): charge/contest/block telemetry

  // --- score / clock ---
  score: [number, number] = [0, 0];
  qLine: number[][] = [[], []];   // per-team points scored in each completed quarter
  quarter = 1;
  gameClock = QUARTER_TIME;
  shotClock = SHOT_CLOCK;
  state: GameState = "live";
  lastEvent: GameEvent | null = null;
  private eventT = 0;

  // --- possession / ball state ---
  possession = 0;
  private handler: Player | null = null;
  private ballMode: BallMode = "held";
  // ---- pick-and-roll defensive coverage (set when a ball screen connects) ----
  // The screener's defender picks how to guard the screen; the two involved
  // defenders then move by that scheme for a short window, and the offensive
  // outcome (blow-by / pull-up / roll / mismatch) follows from the choice.
  private pnrCov: "" | "drop" | "show" | "switch" = "";
  private pnrT = 0;                       // seconds the coverage window is live
  private pnrHandlerDef: Player | null = null;   // handler's man (trails / switches to roller)
  private pnrScreenerDef: Player | null = null;  // screener's man (drops / hedges / switches to ball)
  private pnrScreener: Player | null = null;     // the roller

  // ---- team defensive scheme for the current possession (picked at resetMotion)
  // The DEFENDING team commits to a half-court look and whether to press the
  // bring-up. "" = straight man-to-man (the pnr coverage above applies then).
  private zoneScheme: "" | "2-3" | "3-2" = "";
  private pressOn = false;
  // the press trap's second man THIS frame — he hunts the ball (dig pose /
  // steal) instead of bodying in; set by runPress, cleared every runDefense tick
  private pressTrapper: Player | null = null;
  // ジャスト・パスレシーブ: quality of the pass currently in flight (1 = right on
  // the hands). Rolled at release from P精度 + spread; on the catch it decides
  // how quickly the receiver can move to his next action (gather time).
  private passQ = 1;
  // true once the ball has been established in the frontcourt this possession —
  // from then on, taking it back across halfway is a BACKCOURT violation
  private frontT = false;
  // fast-break window: >0 for a few seconds after a live-ball change of
  // possession (steal / defensive rebound), while the ball is still in the
  // backcourt and the defence is scrambling back. During it the handler
  // attacks the rim and wings sprint the lanes — this is where SPEED / 加速力
  // / 敏捷性 pay off in the open court (the half-court is spot-based).
  private pushT = 0;

  // pass animation
  private passFrom = new Vector3();
  private passCatch = new Vector3();   // the FIXED lead point the ball flies to — constant speed, no lurch
  private passMiss = 0;                // metres the delivery lands off-target (P精度-driven) — feeds both the scatter and the catch gather
  private passMissY = 0;               // vertical scatter of an off-target pass (high / low), from P精度
  private passTo: Player | null = null;
  private passT = 0;
  private passDur = 0;
  // パスの種類: chest=通常 / bounce=バウンドパス(相手の手の下を通し床で一つ跳ねる)
  // / jump=ジャンプパス(ダンク級に跳んで最高点から頭上を越して放つ)
  passStyle: "chest" | "bounce" | "jump" = "chest";
  // ジャンプパスのウィンドアップ: 跳んでから放つ — 滞空でこの時間だけ保持する
  private pendingPassTo: Player | null = null;
  private pendingPassT = 0;
  private passer: Player | null = null;                         // who released the current pass
  private passSteal: { def: Player; at: number } | null = null; // decided once at pass time

  // shot animation
  private shotFrom = new Vector3();
  private shotTarget = new Vector3();   // where the ball ACTUALLY flies — the rim on a make, an off-target point on a miss
  private shotMade = false;
  private shotWasDunk = false;   // last finish was a dunk (bigger bench celebration)
  private shotPoints = 2;
  private shotT = 0;
  private shotDur = 0;
  private shooter: Player | null = null; // who is taking the current shot
  private shooterFinishing = false;      // true for a layup/dunk (drives toward the rim)
  private finishSpot = new Vector3();    // where the finisher gathers & rises — short of the rim, not under it
  private finishVX = 0;                   // drive momentum carried into the finish (decays in the air)
  private finishVZ = 0;
  private shotApex = 2.2;   // arc height — low for layups/dunks, high for jumpers
  private evadedFinish = false;   // this finish dodged a live block attempt (double clutch)
  private evadeDirX = 0;          // horizontal unit dir AWAY from the whiffing blocker —
  private evadeDirZ = 0;          // the clutch swings the ball around his side
  // long-shot ball cam: while a beyond-the-arc bomb is in the air (and for a
  // beat after it lands) the broadcast camera chases the ball itself, so the
  // viewer can follow the rainbow and see whether it drops
  private longShot = false;     // the shot currently in flight is a deep one
  private longShotHoldT = 0;    // keep the ball cam on through the landing

  // loose-ball (rebound) / inbound timers
  private looseT = 0;        // safety timeout before a loose ball is guaranteed grabbed
  private looseTips = 0;     // how many times the ball has been tipped while loose
  private looseOff = 0;      // the offensive team when the ball came loose (for the rebound label)
  private lastTouch: Player | null = null;   // last player to touch the ball — decides out-of-bounds throw-ins
  private looseIsRebound = false; // true when the loose ball came off a missed shot
  private looseFromRim = false;   // true only off RIM contact — the only offensive recovery that resets the shot clock
  private looseStealBy: Player | null = null;     // defender who poked/deflected it loose
  private looseStealVictim: Player | null = null; // ball-handler/passer who lost it
  private looseAge = 0;                            // how long the ball has been loose
  private looseGrabAfter = 0;                      // delay before it can be secured (a visible scramble)
  private blockHoldT = 0;                          // a beat where a swatted ball is pinned at the blocker's hand
  private blockHoldVel = new Vector3();            // the deflection velocity applied when the hold ends
  private inboundT = 0;

  // assist bookkeeping: who threw the pass currently being shot off, and who the
  // potential assist would go to
  private assistFrom: Player | null = null;
  private assistTo: Player | null = null;
  private pendingAssist: Player | null = null; // credited if the current shot drops
  // shooter fouled on a MADE shot: the ball still flies and drops as normal,
  // then resolveShot counts it as an AND-1 and sends him to the line for one
  private pendingAndOne: Player | null = null;

  // opening jump ball
  private tipoffT = 0;
  private tipWinner = 0;
  private tipGuard!: Player;
  private tipJumped = false;   // true once the centres have left the floor for the ball

  // free throws
  private ftShooter!: Player;
  private ftRemaining = 0;
  private ftTeam = 0;
  private ftT = 0;
  private ftMade = false;

  // throw-in (inbound)
  private inboundReceiver: Player | null = null;

  // dead-ball pause so the viewer can register a score / foul before the restart
  private pauseT = 0;
  private pauseNext: (() => void) | null = null;
  // out-of-bounds: the thrower walks to the spot during the announcement pause
  private oobWalker: Player | null = null;
  private oobSpot = new Vector3();
  private oobTeam = 0;
  private oobShotClock = 0;   // the shot clock to restore on the throw-in (decided at the whistle)
  // true while the ball is physically dropping+bouncing during a dead-ball
  // pause (e.g. after a made basket it falls through the net and bounces)
  private ballFalling = false;
  private coastT = 0;   // brief play-on window after the buzzer (惰性で少し続く)
  private hoops: Hoops | null = null;     // net/rim meshes to swish on a make
  private netSwish: [number, number] = [0, 0];   // per-hoop swish timer (>0 animating)
  private swishTeam: [number, number] = [0, 0];  // who scored (flash colour)

  constructor(scene: Scene) {
    for (let t = 0; t < 2; t++) {
      for (let i = 0; i < ROSTER_SIZE; i++) {
        this.roster[t].push(new Player(scene, t, i, ROSTER[t][i]));
      }
    }
    for (let t = 0; t < 2; t++) {
      for (let i = 0; i < STARTERS; i++) this.players.push(this.roster[t][i]);
    }
    this.ball = new Ball(scene);
    this.ring = makeHandlerRing(scene);
    this.reset();
  }

  /** Wire up the hoop net/rim meshes so a made basket can swish them. */
  attachHoops(hoops: Hoops): void { this.hoops = hoops; }

  /** True while the camera should chase the ball itself (a deep shot's flight
   *  plus a beat after it lands) instead of framing the broadcast wide. */
  get camFollowBall(): boolean {
    return (this.ballMode === "shot" && this.longShot) || this.longShotHoldT > 0;
  }

  /** モデル切替（人型 ⇄ どんぐり, HUD_OPTS.model）を全26人へ即時適用する。 */
  applyModelAll(): void {
    for (let t = 0; t < 2; t++) for (const p of this.roster[t]) p.applyModel();
  }

  /** ユニフォーム（ホーム/アウェイ, TEAM_UNIFORM）を全26人へ即時適用する。 */
  applyUniforms(): void {
    for (let t = 0; t < 2; t++) for (const p of this.roster[t]) p.applyUniform();
  }

  // Kick off the net swish + rim/board flash on the rim `team` just scored on.
  private swishNet(team: number): void {
    const i = hoopIndex(this.attackSign(team));
    this.netSwish[i] = 1.1;         // longer, so the celebration reads clearly
    this.swishTeam[i] = team;
  }

  // One frame of the net-swish + rim/backboard flash on a make (visual only;
  // skipped in the headless harness where no hoops are attached). The rim and
  // backboard flash bright in the SCORING team's colour so it's obvious who
  // scored, and the net snaps down hard and springs back.
  private tickSwish(dt: number): void {
    if (!this.hoops) return;
    const DUR = 1.1;
    for (let i = 0; i < 2; i++) {
      if (this.netSwish[i] <= 0) continue;
      this.netSwish[i] = Math.max(0, this.netSwish[i] - dt);
      const net = this.hoops.nets[i], rim = this.hoops.rimMats[i], board = this.hoops.boardMats[i];
      const c = TEAM_COLORS[this.swishTeam[i]];
      if (this.netSwish[i] > 0) {
        const e = DUR - this.netSwish[i];                 // seconds elapsed
        const damp = Math.exp(-e * 5);                    // brightness decay
        // net snaps down hard and springs back with a decaying wobble
        const spring = Math.exp(-e * 6);
        net.scaling.y = 1 + 0.9 * spring;
        const sway = Math.sin(e * 24) * 0.25 * spring;
        net.scaling.x = 1 + sway;
        net.scaling.z = 1 - sway;
        // strong flash: rim & backboard glow the scoring team's colour, pulsing
        const pulse = damp * (0.6 + 0.4 * Math.abs(Math.sin(e * 18)));
        rim.emissiveColor.set(0.3 + c.r * 1.3 * pulse, 0.12 + c.g * 1.3 * pulse, c.b * 1.3 * pulse);
        board.emissiveColor.set(c.r * pulse, c.g * pulse, c.b * pulse);
      } else {                                          // settle back to rest
        net.scaling.set(1, 1, 1);
        rim.emissiveColor.set(0.3, 0.12, 0.0);
        board.emissiveColor.set(0, 0, 0);
      }
    }
  }

  // ---- bench & substitutions ----------------------------------------------

  /** Every rostered player, on court or not (for the box score). */
  allPlayers(team: number): Player[] {
    return this.roster[team];
  }

  /** Current ball-state (read-only; e.g. "subs" while an exchange is running). */
  get mode(): BallMode {
    return this.ballMode;
  }

  private onCourt(p: Player): boolean {
    return this.players.includes(p);
  }

  /** Fixed bench seat, unique per roster index. Both benches share the same
   *  sideline (-X, like the real bench side); each team's row starts at its own
   *  baseline (backend) and fills toward mid-court, so the two benches meet a
   *  clear gap at centre and can never overlap — whoever gets subbed out. */
  private benchSeat(p: Player): { x: number; z: number } {
    const x = COURT.halfW + 2.3;                  // far (+X) sideline, set back off the court
    const zEnd = COURT.halfL - 1;                 // first seat just inside the baseline
    const z = (p.team === 0 ? -1 : 1) * (zEnd - p.idx * 0.8);
    return { x, z };
  }

  private seatOnBench(p: Player): void {
    const s = this.benchSeat(p);
    p.pos.set(s.x, 0, s.z);
    p.cutting = false;
    p.screening = false;
    p.sit();          // compress + drop onto the bench seat (sitting look)
    p.sync();
  }

  // Overall talent, for choosing who checks in (average of all ratings, 0..1).
  private overallOf(p: Player): number {
    const a = p.attr as unknown as Record<string, number>;
    let sum = 0, n = 0;
    for (const k in a) { sum += a[k]; n++; }
    return n ? sum / n / 100 : 0.5;
  }

  // How compatible a bench player's position is with the slot he'd fill.
  private roleFit(benchRole: string, outRole: string): number {
    if (benchRole === outRole) return 1;
    const groups: Record<string, string[]> = {
      PG: ["SG"], SG: ["PG", "SF"], SF: ["SG", "PF"], PF: ["C", "SF"], C: ["PF"],
    };
    return (groups[outRole] ?? []).includes(benchRole) ? 0.6 : 0;
  }

  // How badly this player needs to come out: gassed legs, a poor night
  // (turnovers piling up with nothing to show), or garbage time in a blowout.
  private subDesire(p: Player): number {
    const s = p.stats;
    // LEASH by primary order: プライマリ1が最も出ずっぱり、5に向かって徐々に交代
    // されやすく、ベンチが最短。得点役(エース/スラッシャー)は順位に依らず長め。
    const rank = p.choiceRank ?? p.autoRank;              // 1..5
    let leash = p.idx < STARTERS ? clamp((5 - rank) / 4, 0, 1) : 0;  // rank1→1 .. rank5→0
    if (p.offAction === "score") leash = Math.max(leash, 0.9);
    else if (p.offAction === "slash") leash = Math.max(leash, 0.6);
    const coeff = 1.6 - leash * 0.3;   // fatigue weight: 1.6(早い交代) .. 1.3(粘る)
    const base = 0.45 + leash * 0.2;   // hook 閾値 ≈ 疲労 0.28(rank5) .. 0.50(rank1=半分で休む)
    let d = p.fatigue * coeff - base;
    // 活躍度: 好調(スタッツが良い)なら少し長く起用、不調(TO過多/決まらない)なら早めの交代。
    // ただし効果は控えめ — 半分以下まで疲れたら好調でも休ませる。
    const eff = s.pts + s.reb + s.ast - s.tov * 2 - (s.fga - s.fgm) * 0.5;
    d -= clamp(eff * 0.025, -0.1, 0.3);
    // blowout in the 4th: rest the regulars, empty the bench (starters first)
    const diff = Math.abs(this.score[0] - this.score[1]);
    const blowout = this.quarter >= QUARTERS && diff >= 18;
    if (blowout) d += p.idx < STARTERS ? 0.7 : 0.2;
    // ROTATION SHAPE around the 4Q close (skip in garbage time): rest the
    // starters through the 3rd so they can go the distance, then keep the
    // CLOSING LINEUP — the starters, the higher primaries most — on in the 4th.
    else if (p.idx < STARTERS) {
      if (this.quarter === 3) d += 0.2 + leash * 0.25;   // planned 3Q breather (stars most)
      else if (this.quarter >= QUARTERS) d -= 0.4 + leash * 0.3;  // close with the starters
    }
    if (p.stintT < 12) d -= 0.6;                          // just checked in — stays on
    return d;
  }

  // At a dead ball: if anyone needs a sub, freeze play in the "subs" ball mode
  // and run the walk-on/walk-off exchange; `next` (the inbound etc.) runs only
  // once every walker has reached his spot. With no subs, play continues as-is.
  private withSubs(next: () => void, exclude: Player | null = null): void {
    if (!this.planSubs(exclude)) { next(); return; }
    this.subNext = next;
    this.subT = 0;
    this.handler = null;               // nobody plays the ball during the exchange
    this.ballMode = "subs";
  }

  // Decide the substitutions and perform the LOGICAL swap (roster slot, clock,
  // feed) — the walk animation then carries each body to its destination.
  // NBA-style: players may re-enter later once they've recovered on the bench.
  // In a 4th-quarter blowout the freshness requirement is waived — garbage time
  // empties the bench even when the regulars aren't tired.
  private planSubs(exclude: Player | null): boolean {
    this.subWalkers = [];
    const blowout = this.quarter >= QUARTERS
      && Math.abs(this.score[0] - this.score[1]) >= 18;
    for (let team = 0; team < 2; team++) {
      const bench = this.roster[team].filter((p) => !this.onCourt(p));
      for (const out of [...this.teamPlayers(team)]) {
        if (out === this.handler || out === exclude) continue; // keeps the ball
        if (this.subDesire(out) <= 0) continue;
        let best: Player | null = null;
        let bestScore = 0;
        for (const b of bench) {
          if (b.fatigue > 0.35) continue;                 // not recovered enough
          // outside garbage time the sub must bring meaningfully fresher legs
          if (!blowout && b.fatigue > out.fatigue - 0.15) continue;
          const fit = this.roleFit(b.role, out.role);
          if (fit <= 0) continue;
          const score = this.overallOf(b) * 0.5 + (1 - b.fatigue) * 0.5 + fit * 0.3;
          if (score > bestScore) { bestScore = score; best = b; }
        }
        if (best) {
          this.substitute(out, best);
          bench.splice(bench.indexOf(best), 1);
        }
      }
    }
    // PROACTIVE RESTORE: bring a rested starter back in for a bench-level player
    // on the floor. Q3 is SKIPPED on purpose — that's the planned breather so the
    // starters are fresh to close. In the 4th the threshold is relaxed so the
    // CLOSING LINEUP (the starters) comes back even if not fully recovered.
    // Skipped in 4Q garbage time (that deliberately empties the bench).
    const closing = this.quarter >= QUARTERS;
    if (!blowout && this.quarter !== 3) {
      const restThresh = closing ? 0.7 : 0.30;
      for (let team = 0; team < 2; team++) {
        const resting = this.roster[team]
          .filter((p) => p.idx < STARTERS && !this.onCourt(p) && p.fatigue < restThresh
            && !this.subWalkers.some((w) => w.p === p))
          .sort((a, b) => (a.choiceRank ?? a.autoRank) - (b.choiceRank ?? b.autoRank)); // primary first
        for (const starter of resting) {
          let target: Player | null = null, worst = -Infinity;
          for (const oc of this.teamPlayers(team)) {
            if (oc === this.handler || oc === exclude) continue;
            if (oc.idx < STARTERS) continue;                       // never pull another starter
            if (oc.stintT < 12) continue;                          // just checked in
            if (this.roleFit(starter.role, oc.role) <= 0) continue; // compatible slot
            if (this.subWalkers.some((w) => w.p === oc)) continue;
            const bad = oc.fatigue + (1 - this.overallOf(oc) / 99);   // most tired / weakest first
            if (bad > worst) { worst = bad; target = oc; }
          }
          if (target) this.substitute(target, starter);
        }
      }
    }
    return this.subWalkers.length > 0;
  }

  // Swap the players in the books: the sub takes over the court slot at once
  // (man-matching, stint clock, feed entry), while physically he still has to
  // jog in from the bench — and the resting man has to walk off to his seat.
  private substitute(out: Player, sub: Player): void {
    const i = this.players.indexOf(out);
    if (i < 0) return;
    const cx = out.pos.x, cz = out.pos.z;   // the court spot being handed over
    sub.slot = out.slot;
    sub.spotIdx = out.slot;
    sub.stintT = 0;
    sub.cutting = false;
    sub.screening = false;
    sub.beatenT = sub.powerT = sub.stalledT = sub.jukeT = sub.comboN = sub.reactT = sub.coolT = sub.landT = 0;
    out.lean = 0;        // the man coming off straightens up for the walk to the bench
    sub.resetFacing();   // court bodies carry no yaw — clear the bench gaze
    sub.stand();         // up off the bench to jog in
    this.players[i] = sub;
    const seat = this.benchSeat(out);
    this.subWalkers.push({ p: sub, tx: cx, tz: cz });     // jogs in from his seat
    this.subWalkers.push({ p: out, tx: seat.x, tz: seat.z }); // walks off to his
    this.subsMade++;
    this.subEvents.push({
      inNum: sub.idx + 1, inName: sub.name,
      outNum: out.idx + 1, outName: out.name,
      team: out.team, ttl: 1.8,
    });
    // the on-court unit changed → re-derive the choice order (auto usage) so the
    // incoming player slots into the pecking order by ability
    this.refreshChoiceRanks(out.team);
  }

  /** Kick off a bench celebration for the scoring team. `amp` (0..1) scales how
   *  big it is — a dunk or three brings the whole bench up bouncing. */
  private benchCheer(team: number, duration = 1.8, amp = 0.5): void {
    const fresh = this.cheerT[team] <= 0;   // previous cheer already over → start anew
    this.cheerT[team] = Math.max(this.cheerT[team], duration);
    this.cheerAmp[team] = fresh ? amp : Math.max(this.cheerAmp[team], amp);
  }

  // While a cheer is running, everyone on that bench bounces with both arms up;
  // when it winds down they land, drop their arms and sit back into the game.
  // Bench players get no per-frame updates elsewhere, so jump/sync tick here.
  private updateBenchCheer(dt: number): void {
    for (let t = 0; t < 2; t++) {
      if (this.cheerT[t] <= -1.6) continue;     // fully settled (all have sat by now)
      this.cheerT[t] -= dt;
      const amp = this.cheerAmp[t];   // celebration intensity (dunk / three → 1.0)
      for (const p of this.roster[t]) {
        if (this.onCourt(p)) continue;
        if (this.subWalkers.some((w) => w.p === p)) continue; // mid-walk — not cheering
        p.updateJump(dt);
        const seat = this.benchSeat(p);
        const frontX = seat.x - (0.8 + amp * 0.7);   // a bigger celebration steps further out
        // each reserve lingers a personal beat before dropping back — so the
        // bench doesn't all sit down in lockstep
        const windOff = ((p.idx * 37) % 10) * 0.08;   // 0 .. ~0.72s of extra celebrating
        const winding = this.cheerT[t] <= -windOff;
        if (!winding) {
          p.stand();   // up off the seat to celebrate
          // step out in front of the bench so they're not jumping through it
          p.pos.x += (frontX - p.pos.x) * Math.min(1, dt * 5);
          p.pos.z = seat.z;
          // bigger, more frequent jumps for a dunk / three
          if (!p.airborne && chance((1.6 + amp * 2.4) * dt)) {
            p.jump(rand(0.2, 0.38) + amp * 0.4, rand(0.35, 0.55));
          }
          // arms overhead, angled a touch differently per player so the bench
          // doesn't celebrate in lockstep; they punch higher on a big play
          const ox = ((p.idx * 37) % 11 - 5) * 0.06;
          const oy = ((p.idx * 13) % 7) * 0.08;
          p.reach(new Vector3(p.pos.x + ox, 2.9 + oy + amp * 0.5, p.pos.z), true);
        } else {
          // wind down: walk back to the seat, then sit once there
          p.pos.x += (seat.x - p.pos.x) * Math.min(1, dt * 5);
          if (!p.airborne && Math.abs(p.pos.x - seat.x) < 0.12) p.sit();
        }
        p.sync();
      }
    }
  }

  // The exchange itself: play is frozen, each walker moves to his destination,
  // the sub chips stay on screen, and the pending restart runs when everyone
  // (with a safety timeout) is in place.
  private updateSubs(dt: number): void {
    this.subT += dt;
    // NOTE: the sub chips are NOT held here — they age normally (the update()
    // feed loop runs HOME then AWAY). Play resumes only once they've all cleared
    // (see the resume gate below), so no chip ever lingers into live play.
    this.ball.pos.y = Math.max(0.12, this.ball.pos.y - 3 * dt);   // settles onto the floor

    const timedOut = this.subT >= 9;   // safety cap: never let a walk / feed stall the game
    let done = true;
    for (const w of this.subWalkers) {
      if (!timedOut && dist2DTo(w.p.pos, w.tx, w.tz) > 0.25) {
        done = false;
        // a plain jog, NOT accelSpeed: walk-off men are no longer in `players`,
        // so their measured curSpd never updates and accelSpeed would keep them
        // frozen at ~0 — both walkers move together at the same steady pace
        const jog = w.p.runSpeed * 0.85 * (1 - w.p.fatigue * 0.2);
        moveToward2D(w.p.pos, w.tx, w.tz, jog * dt);
        // face where he's HEADING (else he jogs backwards toward the bench) and
        // run the leg/arm cycle so he's not sliding along stiff
        w.p.faceToward(w.tx, w.tz);
        w.p.twistToward(w.tx, w.tz, dt);   // unwind any twist left over from play
        w.p.curSpd = jog;
        w.p.updateLegs(dt);
        w.p.runArms();
      } else {
        w.p.pos.set(w.tx, 0, w.tz);
      }
    }
    // the In and Out man trade places along the same line — push walking bodies
    // apart so they flow around each other (and around anyone standing) instead
    // of ghosting through
    const MIN = 0.62;
    const bodies = new Set<Player>(this.players);
    for (const w of this.subWalkers) bodies.add(w.p);
    const all = [...bodies];
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const a = all[i], b = all[j];
        let dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z;
        let d = Math.hypot(dx, dz);
        if (d >= MIN) continue;
        if (d < 1e-4) { dx = rand(-1, 1); dz = rand(-1, 1); d = Math.hypot(dx, dz) || 1; }
        const push = (MIN - d) / 2;
        const nx = dx / d, nz = dz / d;
        a.pos.x -= nx * push; a.pos.z -= nz * push;
        b.pos.x += nx * push; b.pos.z += nz * push;
      }
    }
    for (const w of this.subWalkers) w.p.sync(); // walk-off men left `players` — sync here
    // resume only once the walkers are in place AND the sub feed (HOME then AWAY)
    // has fully played out and cleared — so the away chips are gone BEFORE the
    // ball goes live, never lingering into the restart. timedOut is the hard cap.
    if ((done && this.subEvents.length === 0) || timedOut) {
      for (const w of this.subWalkers) {
        w.p.pos.set(w.tx, 0, w.tz);
        // invariant: nobody stands ON the court with a bench yaw — enforce it
        // whenever a walk phase hands players back to live play
        if (this.onCourt(w.p)) w.p.resetFacing();
        else w.p.sit();   // the man who reached the bench sits back down
        w.p.sync();
      }
      this.subWalkers = [];
      const next = this.subNext;
      this.subNext = null;
      if (next) next();
    }
  }

  // ---- helpers -----------------------------------------------------------

  private teamPlayers(team: number): Player[] {
    return team === 0 ? this.players.slice(0, 5) : this.players.slice(5, 10);
  }

  /** True once the teams have switched ends (second half = Q3 onward). */
  private secondHalf(): boolean {
    return this.quarter >= 3;
  }
  /**
   * The Z sign (+1 / -1) of the basket `team` attacks this half. Teams swap
   * ends at half-time, so the same team attacks the opposite hoop in Q3/Q4.
   */
  private attackSign(team: number): number {
    const base = team === 0 ? 1 : -1;
    return this.secondHalf() ? -base : base;
  }

  /** Floor point under the rim the given team attacks. */
  private attackFloor(team: number): Vector3 {
    return new Vector3(0, 0, this.attackSign(team) * RIM.z);
  }
  /** Rim centre (3D) the given team attacks. */
  private attackRim(team: number): Vector3 {
    return new Vector3(0, RIM.height, this.attackSign(team) * RIM.z);
  }

  /** Off-ball formation spots around the attacking arc. */
  private formationSpots(team: number): Vector3[] {
    const s = this.attackSign(team);
    const hz = s * RIM.z;
    const dir = -s; // toward mid-court
    // ZONE BREAK: against a set zone the offence reshapes into a 1-3-1-style
    // alignment that sits players in the GAPS between the zone defenders, with a
    // man flashing to the HIGH POST (the free-throw line) — a touch there forces
    // the zone's back line to step up and cracks the paint open. The two "block"
    // spots become the high post + the dunker under the rim.
    if (team === this.possession && this.zoneScheme) {
      return [
        new Vector3(0, 0, hz + dir * 8.5),     // 0 point, above the top of the zone
        new Vector3(-5.9, 0, hz + dir * 5.6),  // 1 left wing gap
        new Vector3(5.9, 0, hz + dir * 5.6),   // 2 right wing gap
        new Vector3(-6.5, 0, hz + dir * 1.1),  // 3 left short corner (behind the zone)
        new Vector3(6.5, 0, hz + dir * 1.1),   // 4 right short corner
        new Vector3(0, 0, hz + dir * 4.3),     // 5 HIGH POST — the zone-buster flash
        new Vector3(0, 0, hz + dir * 0.9),     // 6 dunker under the rim
      ];
    }
    return [
      // perimeter spots HUG the arc (line 6.75 m): a catch there is a three taken
      // from as close as the line allows — max percentage. Only a deep-range
      // elite drifts further out (see the spot jog in updateOffBallMotion).
      new Vector3(0, 0, hz + dir * 7.1),     // top (7.1 m out)
      new Vector3(-4.7, 0, hz + dir * 5.3),  // left wing (~7.08 m out)
      new Vector3(4.7, 0, hz + dir * 5.3),   // right wing
      // DEEP corners: down on the corner three near the baseline (where the
      // 3&D / spot-up shooters wait), stretching the floor wider than the old
      // 2.5 m-out spot and keeping them a comfortable three
      new Vector3(-6.7, 0, hz + dir * 1.5),  // left corner
      new Vector3(6.7, 0, hz + dir * 1.5),   // right corner
      // low blocks, just outside the lane line — the post big's home. Guards
      // and genuine stretch bigs never claim these (see bestOpenSpot).
      new Vector3(-2.8, 0, hz + dir * 1.4),  // left low block
      new Vector3(2.8, 0, hz + dir * 1.4),   // right low block
    ];
  }

  private clampCourt(p: Vector3): void {
    const mw = COURT.halfW - COURT.margin;
    const ml = COURT.halfL - COURT.margin;
    p.x = clamp(p.x, -mw, mw);
    p.z = clamp(p.z, -ml, ml);
  }

  private nearestDefenderDist(p: Player): number {
    let best = Infinity;
    for (const d of this.teamPlayers(1 - p.team)) {
      const dd = dist2D(d.pos, p.pos);
      if (dd < best) best = dd;
    }
    return best;
  }

  private nearestDefender(p: Player): Player | null {
    let best = Infinity, who: Player | null = null;
    for (const d of this.teamPlayers(1 - p.team)) {
      const dd = dist2D(d.pos, p.pos);
      if (dd < best) { best = dd; who = d; }
    }
    return who;
  }

  // How well THIS defender protects the rim against THIS shooter — pure position
  // + physique, no role label: length over the shooter, ヘッド (rim protection),
  // ジャンプ and 守備. A rangy shot-blocking big scores high, a switched-on guard
  // low. Centred so a run-of-the-mill contest ≈ 0. This is what makes "keep your
  // big home" real interior defence and a guard caught on the roll a layup line.
  private rimProtect(d: Player, shooter: Player): number {
    // 守判断 weight raised 0.2→0.35 (centre re-tuned so a flat-70 contest is
    // unchanged): attr-impact audit showed DEF+20 moved opponent FG% by ~0 —
    // the judgement stat now steepens the QUALITY of the same contest.
    return clamp(
      (d.height - shooter.height) * 0.5
      + rate(d.attr.dunk) * 0.35            // ヘッド = rim protection / shot-blocking
      + rate(d.attr.jump) * 0.25
      + rate(d.attr.defense) * 0.35
      - 0.505,                              // baseline: an average contest sits near 0
      -0.4, 0.6);
  }

  // How well THIS defender contests a jumper — quickness to close out (反応/敏捷),
  // 守備 and a little reach. A rangy, sharp perimeter defender flies at the shot; a
  // slow big switched onto a shooter closes out late. Centred so an average
  // contest ≈ 0. This is the perimeter half of the same interdependence: switch
  // your big onto a guard, or play slow-footed defenders out top, and the threes
  // fall.
  private perimContest(d: Player, shooter: Player): number {
    // 守判断 weight raised 0.3→0.5 (centre re-tuned, flat-70 unchanged) — see
    // rimProtect note; the audit demanded DEF actually move opponents' FG%.
    return clamp(
      rate(d.attr.reaction) * 0.35 + rate(d.attr.agility) * 0.3 + rate(d.attr.defense) * 0.5
      + (d.height - shooter.height) * 0.15
      - 0.64,
      -0.35, 0.4);
  }

  // 連携: how faithfully this player executes the team's tactical plan — the
  // multiplier applied to every tactic-driven term in his decisions.
  private twWeight(p: Player): number {
    return 0.35 + rate(p.attr.teamwork) * 0.65;
  }

  // 反応: multiplier on reaction lags (lower = reacts sooner).
  private reactionLag(p: Player): number {
    return 1.35 - rate(p.attr.reaction) * 0.75;      // ~1.27 (slow) .. ~0.6 (instant)
  }

  // L速度(3P range) → how far out this player can comfortably shoot. Calibrated
  // to the user's spec: 75 = the three-point line, 95 = the halfway line (and
  // that is the CAP — nobody's comfortable range reaches past centre court).
  // Below 75 the comfortable range falls INSIDE the arc; such a player can still
  // launch from beyond it, but only with GATHER TIME (see gatherFor).
  private static readonly SHOOT_ARC = THREE_DIST;   // 6.75 m (the three-point line)
  private static readonly SHOOT_HALF = RIM.z;       // 13.0 m (rim → the centre line)
  private shootRangeOf(p: Player): number {
    const r = Game.SHOOT_ARC + (p.attr.threeRange - 75)
      * (Game.SHOOT_HALF - Game.SHOOT_ARC) / 20;   // 75→arc, 95→halfway, linear
    // floor at ~mid-range: a poor L速度 shooter still takes 2s inside the arc (he
    // just can't get to the 3-point line comfortably), capped at halfway.
    return clamp(r, 4.5, Game.SHOOT_HALF) + (p.has("range") ? 1.0 : 0);
  }

  // Seconds of wind-up needed to launch from beyond the comfortable range: the
  // further past shootRangeOf, the longer the gather. A low-L速度 player therefore
  // cannot just quick-heave a deep three at the shot-clock buzzer — he needs time
  // he doesn't have, so the clock dies (a violation) instead.
  private gatherFor(p: Player, dHoop: number): number {
    const over = dHoop - this.shootRangeOf(p);
    return over <= 0 ? 0 : over * 0.22;   // ~0.22 s per metre beyond range
  }

  // ディープ3の資格: L精度とL速度がともに90以上のエリートだけが、ラインの遥か
  // 外から放つ価値がある。それ以外の選手の深い3は確率を捨てるだけなので、
  // シュート判断はライン際(+0.55m)までに制限され、まずラインへ寄ってから打つ
  // （成功率最優先）。物理的な射程・ブザー間際の苦し紛れはゲートしない。
  private deepThreeOK(p: Player): boolean {
    return p.attr.threeAcc >= 90 && p.attr.threeRange >= 90;
  }
  private effShootRange(p: Player): number {
    const r = this.shootRangeOf(p);
    // エリート(90/90)はラインの遥か外まで射程。それ以外は**ライン際までは全員が
    // オープンなら打つ**(=「3Pライン上から打つ」の趣旨)＝射程の下限を THREE_DIST+0.5
    // に引き上げ、上限もそこで止める(深いヒーブはエリート限定)。低L速度でも
    // ワイドオープンのキャッチ&シュートは打つ(精度は L精度 が別途罰する)。
    // ※旧実装は shootRangeOf(大半の選手でライン内側)をそのまま使い、ライン上の
    //   オープン3すら打てず=違反多発の主因だった。
    if (this.deepThreeOK(p)) return r;
    return THREE_DIST + 0.5;   // 全員ライン際までは打つ / 深いのはエリートのみ
  }

  // How long this player would GATHER this shot (the overhead load before release).
  private shotWindupFor(h: Player, dHoop: number): number {
    let w = 0.16 + this.gatherFor(h, dHoop) + (1 - rate(h.attr.shotTech)) * 0.12;
    if (h.quickT > 0 && h.has("oneTouch")) w *= 0.55;   // ダイレクト: quick release
    return w;
  }

  // A shot he shouldn't attempt: a LONG overhead load with a defender in his
  // airspace is asking to be stripped/blocked before it goes up — better to
  // drive, kick it, or reset than load up into a waiting shot-blocker.
  private wontLoadUp(h: Player, dHoop: number, dDef: number): boolean {
    return this.shotWindupFor(h, dHoop) > 0.45 && dDef < 1.7 && h.beatenT <= 0;
  }

  /** True if anyone on `team` has the given 特殊能力 (team-wide auras: 司令塔/DFライン). */
  private teamHas(team: number, key: AbilityKey): boolean {
    for (const p of this.teamPlayers(team)) if (p.has(key)) return true;
    return false;
  }

  /** How many defenders are within `r` metres of this player. */
  private defendersWithin(p: Player, r: number): number {
    let n = 0;
    for (const d of this.teamPlayers(1 - p.team)) if (dist2D(d.pos, p.pos) < r) n++;
    return n;
  }

  // 精神: >0 = rattled (accuracy drops), <0 = thrives under pressure (accuracy
  // RISES). Pressure builds from fatigue, from trailing on the scoreboard and
  // from a close 4th-quarter finish. Mental 80 is the pivot: below it the
  // pressure hurts (scaled 0..1 down at 0), above it the same pressure fuels a
  // clutch performer (up to -0.5 at 100). Callers subtract factor × weight, so
  // a negative factor is a buff.
  private clutchFactor(p: Player): number {
    const diff = this.score[p.team] - this.score[1 - p.team];
    let stress = p.fatigue * 0.5;
    if (diff < 0) stress += 0.3;                                        // losing
    if (this.quarter >= QUARTERS && this.gameClock < QUARTER_TIME * 0.5
        && Math.abs(diff) <= 10) stress += 0.6;                         // crunch time
    const m = clamp(p.attr.mental, 0, 100);
    const resolve = m >= 80
      ? -(m - 80) / 40      // 80..100 → 0 .. -0.5: rises to the moment
      : (80 - m) / 80;      // 0..80  → 1 .. 0:     crumbles under it
    return clamp(stress, 0, 1) * resolve;
  }

  private setEvent(text: string, team: number, dur = 1.8,
                   info?: { scorer?: string; assist?: string }): void {
    // Only the notable plays get an on-screen banner — scoring, and-1s, fouls
    // and the period markers. Routine flow (rebounds, steals, blocks, misses,
    // etc.) is left to the scoreboard so the view isn't cluttered. Scoring
    // banners carry who scored (and who assisted) for the on-screen credit.
    if (!this.bannerWorthy(text)) return;
    this.lastEvent = { text, team, scorer: info?.scorer, assist: info?.assist };
    this.eventT = dur;
  }

  private bannerWorthy(text: string): boolean {
    return text.includes("FOUL")           // FOUL / SHOOTING FOUL
      || text === "AND-1"
      || text === "2 POINTS"
      || text === "3 POINTS!"
      || text === "BACKCOURT"              // over-and-back violation
      || text === "SHOT CLOCK VIOLATION"   // shot-clock violation (offence)
      || text.includes(" BALL")            // restart banners that SAY whose ball it is
      || text.startsWith("THROW-IN")       // throw-in restart — WHOSE ball it is
      || text === "TIP-OFF"                // the game clearly begins...
      || text === "HALFTIME"
      || text === "2ND HALF"
      || text === "FINAL"
      || text.endsWith("WINS!")            // the final-horn victory call
      || text === "DRAW"
      || text.startsWith("END OF Q")       // ...and each period clearly ends
      || /^Q\d START$/.test(text);         // ...and clearly restarts
  }

  // ---- lifecycle ---------------------------------------------------------

  reset(): void {
    this.score = [0, 0];
    this.qLine = [[], []];
    this.quarter = 1;
    this.gameClock = QUARTER_TIME;
    this.shotClock = SHOT_CLOCK;
    this.state = "live";
    this.lastEvent = null;
    this.possession = 0;
    this.subsMade = 0;
    this.subEvents.length = 0;
    this.subWalkers = [];
    this.subNext = null;
    this.oobWalker = null;
    this.blockHoldT = 0;
    this.cheerT = [-1, -1];
    this.longShot = false;
    this.longShotHoldT = 0;
    this.finaleT = 0;
    this.finaleWinner = -1;
    this.finaleWalkers = [];
    this.finaleTrudge = [];
    this.clearPnr();
    // the starting five check back in; the bench takes their seats
    for (let t = 0; t < 2; t++) {
      for (let i = 0; i < ROSTER_SIZE; i++) {
        const p = this.roster[t][i];
        p.resetStats();
        if (i < STARTERS) {
          p.slot = i;
          p.spotIdx = i;
          p.resetFacing();   // clear any bench gaze from the previous game
          this.players[t * 5 + i] = p;
        } else {
          this.seatOnBench(p);
        }
      }
    }
    this.assistFrom = this.assistTo = this.pendingAssist = null;
    this.applyNumberSides();
    this.refreshChoiceRanks(0);
    this.refreshChoiceRanks(1);
    this.startTipoff();
  }

  // Jersey numbers sit on the players' backs: the side away from the basket
  // each team attacks. Re-applied when the teams switch ends at half-time.
  private applyNumberSides(): void {
    for (let t = 0; t < 2; t++) {
      const back = -this.attackSign(t);
      for (const p of this.roster[t]) p.setNumberSide(back);
    }
  }

  /** Re-apply the (possibly edited) roster's roles/priorities/derived values.
   *  Ratings are live references, so they already take effect; call this from
   *  the pre-game screen before tip-off to pick up role/priority changes. */
  applyRoster(): void {
    for (let t = 0; t < 2; t++) {
      for (let i = 0; i < ROSTER_SIZE; i++) this.roster[t][i].applyDef(ROSTER[t][i]);
    }
    this.refreshChoiceRanks(0);
    this.refreshChoiceRanks(1);
  }

  // Turn the CHOICE ORDER into each on-court player's usage (offPriority = who
  // the ball is funnelled to). A player with an explicit choiceRank keeps it;
  // duplicate explicit ranks stay equal = "co-primary" who share the ball. The
  // rest are auto-ranked by scoring power into the remaining 1..5 slots — this is
  // the "auto by ability" default the user asked for. Recomputed per on-court
  // unit so a substitution re-shuffles the pecking order.
  private refreshChoiceRanks(team: number): void {
    const on = this.teamPlayers(team);
    const used = new Set<number>();
    for (const p of on) if (p.choiceRank) used.add(p.choiceRank);
    const auto = on.filter((p) => !p.choiceRank)
      .sort((a, b) => scoringPower(b.attr) - scoringPower(a.attr));
    let r = 1;
    for (const p of auto) {
      while (used.has(r) && r < 5) r++;
      p.autoRank = clamp(r, 1, 5); used.add(r); r++;
    }
    for (const p of on) {
      const rank = p.choiceRank ?? p.autoRank;
      // a designated shot-creator (エース) gets a small usage bump on top of rank
      p.offPriority = clamp(usageFromRank(rank) + (p.offAction === "score" ? 0.06 : 0), 0, 1);
    }
  }

  // Opening jump ball: the two centres meet at the circle, the ball is tossed
  // straight up, they elevate, and the winner tips it to a guard.
  private startTipoff(): void {
    this.placeFormation();
    const t0 = this.teamPlayers(0), t1 = this.teamPlayers(1);
    // jumpers (centres, idx 4) face off at the centre circle
    t0[4].pos.set(0, 0, -0.7);
    t1[4].pos.set(0, 0, 0.7);
    // the other eight ring the circle, each on their own half
    const ring0 = [[-3, -2], [3, -2], [-2, -4.2], [2, -4.2]];
    const ring1 = [[-3, 2], [3, 2], [-2, 4.2], [2, 4.2]];
    for (let i = 0; i < 4; i++) {
      t0[i].pos.set(ring0[i][0], 0, ring0[i][1]);
      t1[i].pos.set(ring1[i][0], 0, ring1[i][1]);
    }
    // everyone on the floor stands: a starter who was seated on the bench at the
    // end of a previous game must not tip off still in the sitting pose
    for (const p of this.players) { p.stand(); p.cutting = false; p.offTimer = rand(0.4, 2); p.spotIdx = this.homeSpotIdx(p); }

    this.tipWinner = chance(0.5) ? 0 : 1;
    this.tipGuard = this.teamPlayers(this.tipWinner)[0];
    this.tipoffT = 0;
    this.tipJumped = false;
    this.handler = null;
    this.ballMode = "tipoff";
    this.ball.pos.set(0, 2, 0);
    this.ball.vel.set(0, 0, 0);
    // the centres stay grounded for now — they time their jump to the toss
  }

  private updateTipoff(dt: number): void {
    this.tipoffT += dt;
    const t = this.tipoffT;

    const TOSS_UP = 0.7;   // ball rises to its peak
    const TIP_AT = 1.15;   // it has fallen back to the jumpers' reach — they tap it
    const START_Y = 2.0, PEAK_Y = 5.0, TIP_Y = 3.6;

    if (t < TOSS_UP) {
      // referee's toss: the ball arcs up to its peak (easing out as it rises)
      const k = t / TOSS_UP;
      this.ball.pos.set(0, START_Y + (PEAK_Y - START_Y) * Math.sin(k * Math.PI / 2), 0);
      return;
    }

    // at the peak, both centres leave the floor — their jumps are timed so the
    // apex lands on the tip moment, meeting the ball as it drops back down
    if (!this.tipJumped) {
      this.tipJumped = true;
      const dur = (TIP_AT - TOSS_UP) * 2; // peaks at TIP_AT
      this.teamPlayers(0)[4].jump(1.0, dur);
      this.teamPlayers(1)[4].jump(1.0, dur);
    }

    if (t < TIP_AT) {
      // the ball falls from the peak down into the rising hands
      const k = (t - TOSS_UP) / (TIP_AT - TOSS_UP);
      this.ball.pos.set(0, PEAK_Y + (TIP_Y - PEAK_Y) * k, 0);
      return;
    }

    // the winning centre taps it: send the ball toward his guard and go live,
    // letting the loose-ball chase resolve who comes up with it
    const g = this.tipGuard.pos;
    const dx = g.x, dz = g.z;
    const len = Math.hypot(dx, dz) || 1;
    this.ball.pos.set(0, TIP_Y, 0);
    this.ball.vel.set((dx / len) * 3.6, 1.0, (dz / len) * 3.6);
    this.goLoose(this.tipWinner, 2.6);
    this.setEvent("TIP-OFF", this.tipWinner);
  }

  private placeFormation(): void {
    for (let t = 0; t < 2; t++) {
      const spots = this.formationSpots(t);
      const tp = this.teamPlayers(t);
      for (let i = 0; i < 5; i++) {
        tp[i].pos.copyFrom(spots[i]);
        tp[i].sync();
      }
    }
  }

  // Real rules: the 2nd, 3rd and 4th periods are started by a throw-in from the
  // centre line (the side opposite the scorer's table), not a half-court set. A
  // wing takes it out at mid-court and the point guard flashes back to receive
  // and bring it up; the defence matches up goal-side.
  private startQuarterInbound(team: number, prePlaced = false): void {
    this.possession = team;
    const offense = this.teamPlayers(team);
    if (!prePlaced) {
      // (the quarter-break flow walks everyone to these spots instead)
      this.placeFormation();                     // both teams at their attacking spots
      const defenders = this.teamPlayers(1 - team);
      const protect = this.attackFloor(team);    // basket the defence guards
      for (const d of defenders) {
        const man = offense[d.slot];
        const dx = protect.x - man.pos.x, dz = protect.z - man.pos.z;
        const len = Math.hypot(dx, dz) || 1;
        d.pos.set(man.pos.x + (dx / len) * 1.4, 0, man.pos.z + (dz / len) * 1.4);
      }
      // inbounder (a wing) stands out of bounds at the centre line; the PG
      // comes back to receive the throw-in near mid-court
      offense[2].pos.set(-(COURT.halfW + 0.3), 0, 0); // centre line, left sideline
    }
    const taker = offense[2];
    this.handler = taker;
    this.ballMode = "inbound";
    this.inboundT = 1.0;
    this.shotClock = SHOT_CLOCK;
    this.resetMotion();
    this.inboundReceiver = offense[0];           // the point guard
    // the new period visibly begins as the throw-in is readied — say whose ball
    this.setEvent(this.quarter === 3
      ? `2ND HALF — ${teamShort(team)} BALL`
      : `Q${this.quarter} START — ${teamShort(team)} BALL`, team, 2.0);
  }

  // ---- main update -------------------------------------------------------

  update(dt: number): void {
    if (this.eventT > 0) this.eventT = Math.max(0, this.eventT - dt);
    if (this.eventT === 0) this.lastEvent = null;
    // age out the substitution feed. HOME (team 0) chips run first; while ANY
    // home chip is still live the AWAY (team 1) chips are FROZEN (ttl held, and
    // the UI hides them) — so the feed plays all HOME subs, clears, then AWAY's.
    const homeLive = this.subEvents.some((e) => e.team === 0);
    for (let i = this.subEvents.length - 1; i >= 0; i--) {
      const e = this.subEvents[i];
      if (e.team === 1 && homeLive) continue;   // hold AWAY until HOME has cleared
      e.ttl -= dt;
      if (e.ttl <= 0) this.subEvents.splice(i, 1);
    }

    // the bench celebrates a score — runs in every mode (scores lead into a
    // pause), and before the `final` early-return so the last bucket still lands
    this.updateBenchCheer(dt);

    if (this.state === "final") {
      this.syncAll();
      return;
    }

    // remember where everyone starts the frame, to measure real speed later
    for (const p of this.players) { p.prevX = p.pos.x; p.prevZ = p.pos.z; }

    // clocks — frozen during dead balls (jump ball, free throws, pauses, subs)
    if (this.ballMode !== "tipoff" && this.ballMode !== "freethrow"
        && this.ballMode !== "pause" && this.ballMode !== "subs"
        && this.ballMode !== "finale") {
      this.gameClock -= dt;
      for (const p of this.players) { p.stats.min += dt; p.stintT += dt; }
      if (this.ballMode === "held") {
        this.shotClock -= dt;
        if (this.shotClock <= 0) {
          this.shotClockViolation();
        }
      }
      // the buzzer: a shot already in the air — or being gathered — is allowed to
      // finish (buzzer beater); resolveShot hands the period end over once it lands
      if (this.gameClock <= 0 && this.ballMode !== "shot" && this.ballMode !== "charge") {
        // don't freeze the instant the horn sounds — let a live play COAST for
        // a beat (players carry their momentum, the ball keeps rolling) before
        // the period actually ends
        if (this.ballMode === "held" || this.ballMode === "loose") {
          if (this.coastT <= 0) this.coastT = 0.8;
          this.coastT -= dt;
          if (this.coastT <= 0) this.endQuarter();
        } else {
          this.endQuarter();
        }
      }
    }

    // ball-state machine
    switch (this.ballMode) {
      case "held": this.updateLive(dt); break;
      case "charge": this.updateCharge(dt); break;
      case "pass": this.updatePass(dt); break;
      case "shot": this.updateShot(dt); break;
      case "loose": this.updateLoose(dt); break;
      case "inbound": this.updateInbound(dt); break;
      case "tipoff": this.updateTipoff(dt); break;
      case "freethrow": this.updateFreeThrow(dt); break;
      case "pause": this.updatePause(dt); break;
      case "subs": this.updateSubs(dt); break;
      case "finale": this.updateFinale(dt); break;
    }

    this.resolveCollisions();
    const resting = this.ballMode === "pause" || this.ballMode === "freethrow"
      || this.ballMode === "tipoff" || this.ballMode === "subs"
      || this.ballMode === "finale";
    for (const p of this.players) {
      p.updateJump(dt);
      p.tickCooldown(dt);
      p.tickMotion(dt, resting);   // measure real speed, drain/recover fatigue
      p.updateLegs(dt);            // walk / run leg cycle from the measured speed
    }
    // the bench recovers while they sit, watching the ball with small personal
    // fidgets — unless they're celebrating (updateBenchCheer animates that) or
    // mid-walk in a substitution (they just track the ball with their eyes)
    if (this.ballMode !== "finale") {   // the finale owns everyone off the floor
      for (let t = 0; t < 2; t++) {
        const cheering = this.cheerT[t] > -1.6;   // matches updateBenchCheer's settle window
        for (const p of this.roster[t]) {
          if (this.onCourt(p)) continue;
          p.benchRecover(dt);
          // walkers (to/from the bench) are animated in updateSubs; idle otherwise
          if (!this.subWalkers.some((w) => w.p === p) && !cheering) {
            p.benchIdle(dt, this.ball.pos.x, this.ball.pos.z);
          }
        }
      }
    }
    this.updateFacing(dt);
    if (this.longShotHoldT > 0) this.longShotHoldT = Math.max(0, this.longShotHoldT - dt);
    this.tickSwish(dt);   // net swish / rim flash on a make
    this.syncAll();
  }

  // On-court players turn to face the play: the ball-handler and shooter square
  // up to the basket they attack, and everyone else (defenders keeping eyes on
  // the ball, off-ball attackers reading it) turns toward the ball. Eased so
  // bodies track rather than snap. Skipped during substitutions, where players
  // walk to set spots. Bench players aim their own gaze in benchIdle.
  private updateFacing(dt: number): void {
    if (this.ballMode === "subs" || this.ballMode === "finale") return;
    const b = this.ball.pos;
    for (const p of this.players) {
      // the PASSER delivers a two-handed pass CHEST-ON: snap his upper body to the
      // receiver NOW (the pass is too quick for an eased turn), feet left where
      // they are. Done BEFORE the airborne skip so a JUMP pass out of a double-team
      // (trapKickOut leaves the floor) still turns chest-on to the receiver.
      if (this.ballMode === "pass" && p === this.passer && this.passTo) {
        p.faceChestToward(this.passTo.pos.x, this.passTo.pos.z);
        continue;
      }
      // OFF THE FLOOR he can't re-orient: a jumper (shooter, contester, tip) holds
      // whatever way he was facing at take-off until he lands — no mid-air turns.
      if (p.airborne) continue;
      // the RECEIVER squares his chest to the INCOMING ball to take it in both
      // hands — the same chest-on snap the passer makes, so a ball arriving from
      // behind turns him around (the torso covers what it can, the feet turn the
      // excess; his run to the catch point is untouched — legs keep travelling).
      // Inside ~0.5 m the bearing to the ball swings wildly frame-to-frame, so
      // hold the last orientation for the actual catch instant.
      if (this.ballMode === "pass" && p === this.passTo) {
        if (dist2D(p.pos, b) > 0.5) p.faceChestToward(b.x, b.z);
        continue;
      }
      // still corralling the catch (gatherT): HOLD the catch posture — he doesn't
      // swing his chest around to the goal until the ball is actually secured
      // (the ball wobbles at his chest and both hands stay on it meanwhile)
      if (p === this.handler && p.gatherT > 0) continue;
      const aim = (p === this.handler || p === this.shooter) ? this.attackFloor(p.team) : b;
      // Lower body: while running, the legs face the direction of TRAVEL and the
      // torso twists toward the play (twistToward) — receiving on the move,
      // shadowing a driver in stride. EXCEPT when moving away from the aim
      // (a backpedal): then the legs hold their square-up so the player retreats
      // chest-on (which is also what triggers the backpedal arm pose). Standing
      // still, the whole body squares to the aim and the twist unwinds.
      let lx = aim.x, lz = aim.z;
      const spd = Math.hypot(p.velX, p.velZ);
      if (spd > 1.5) {
        const ax = aim.x - p.pos.x, az = aim.z - p.pos.z;
        const al = Math.hypot(ax, az);
        // Moving toward the aim → legs face travel. Moving AWAY (a retreat) a
        // slow contain-shuffle stays chest-on (keep facing the aim, backpedal) —
        // BUT a committed SPRINT away (chasing a loose ball, or a beaten defender
        // sprinting back to recover) turns and RUNS: face the travel direction so
        // he doesn't moon-walk. faceSmooth eases it, so the turn is gradual.
        const committed = spd > p.runSpeed * 0.72;
        if (al > 0.05 && ((p.velX * ax + p.velZ * az) / (spd * al) > -0.26 || committed)) {
          lx = p.pos.x + p.velX;
          lz = p.pos.z + p.velZ;
        }
      }
      // How fast he can WHIP his body around to a new direction — no instant
      // spins. Driven by クイックネス(敏捷性) plus his role skill: a DEFENDER turns
      // on 敏捷性 + ディフェンス (staying with his man), an attacker on オフェンス +
      // 敏捷性. Low ratings turn slowly (a beat to change direction), elite ones
      // snap around — but never instantly.
      const offense = p.team === this.possession;
      const quick = rate(p.attr.agility);
      const skill = offense ? rate(p.attr.offense) : rate(p.attr.defense);
      const turnRate = 2.2 + (quick * 0.6 + skill * 0.4) * 6;   // ~2.2 (slow) .. ~8.2 (quick) rad/s
      p.faceSmooth(lx, lz, turnRate * dt);                       // lower body (legs/hips)
      p.twistToward(aim.x, aim.z, dt, undefined, turnRate * 1.25); // upper body (chest), a touch quicker
    }
  }

  /** Push the logical state to the meshes WITHOUT advancing the sim — the
   *  pregame camera tour renders players while the game itself is on hold. */
  syncVisuals(): void { this.syncAll(); }

  private syncAll(): void {
    for (const p of this.players) p.sync();
    this.ball.sync();
    this.poseHands();
    if (this.handler && this.ballMode === "held") {
      this.ring.isVisible = true;
      this.ring.position.set(this.handler.pos.x, 0.03, this.handler.pos.z);
    } else {
      this.ring.isVisible = false;
    }
  }

  // Put a hand on the ball for whoever is touching it, so the ball is dribbled /
  // passed / shot / tipped from a palm rather than floating. Everyone else rests
  // their arms at their sides.
  private poseHands(): void {
    if (this.ballMode === "finale") return;   // updateFinale owns every pose
    const b = this.ball.pos;
    // Defensive stances are RATE-LIMITED — they slew toward the target pose rather
    // than snapping — so runArms must not stomp those arms first. Work out who is
    // holding a defensive stance this frame, apply it, and skip their runArms.
    const posed = new Set<Player>();
    if (this.ballMode === "held" && this.handler) {
      this.poseOnBallHands(this.handler, b, posed);   // what the on-ball defender answers
      this.poseDenyHands(this.handler, b, posed);       // off-ball defenders denying the pass
      posed.add(this.handler);   // his dribble hand slews too (below) — don't stomp it
      // まだ収まっていない: while the receiver is corralling a bobbled catch, the man
      // on him DIGS at the loose ball — both arms reaching low for the exposed
      // ball, so the steal attempt is visible (catchStrips does the step + poke).
      if (this.handler.gatherT > 0) {
        const d = this.onBallDefender(this.handler);
        if (d && !d.airborne && dist2D(d.pos, this.handler.pos) < 2.0) {
          d.reach(new Vector3(b.x, b.y, b.z), true);
          posed.add(d);
        }
      }
      // press trap: the second man doesn't body in — he stands off and DIGS at
      // the ball, both hands hunting it, so the trap reads as a steal attempt
      const pt = this.pressTrapper;
      if (pt && !pt.airborne && dist2D(pt.pos, this.handler.pos) < 1.8) {
        pt.reach(new Vector3(b.x, b.y, b.z), true);
        posed.add(pt);
      }
    } else if (this.ballMode === "charge" && this.shooter) {
      const cd = this.onBallDefender(this.shooter);     // a grounded contest goes STRAIGHT UP
      if (cd && !cd.airborne && dist2D(cd.pos, this.shooter.pos) < 2.2) {
        cd.handsUp(this.defArmRate(cd)); posed.add(cd);
      }
    }
    // a shooter frozen in his follow-through owns his own arms (held below) — even
    // grounded (a set jumper that doesn't leave the floor) — so don't let runArms
    // pump them back down during his cooldown
    if (this.shooter && this.shooter.coolT > 0 && this.shooter !== this.handler) {
      posed.add(this.shooter);
    }
    for (const p of this.players) if (!posed.has(p)) p.runArms();   // run swing / rest
    switch (this.ballMode) {
      case "held": {
        if (this.handler) {
          if (this.pendingPassTo) {
            // ジャンプパスのウィンドアップ: 両手でボールを頭上に掲げている
            this.handler.holdBallHands(b);
          } else if (this.handler.gatherT > 0) {
            // まだ収まっていない: the two-handed CATCH pose carries straight on —
            // the ball sits BETWEEN the palms (one hand each side) and the whole
            // hold shakes as one until it settles; then he drops into the dribble
            this.handler.holdBallHands(b);
          } else {
            // hand hovers at dribble height while the ball bounces below it —
            // dribbled with the hand on the SAME side the ball is carried (a hip
            // carry uses the near hand, not the far arm reaching across the body)
            const bw = new Vector3(b.x, 0.95, b.z);
            this.handler.reachDribble(bw, this.handler.dribbleWithRight(bw), this.dribArmRate(this.handler));
          }
        }
        break;
      }
      case "charge":
        this.shooter?.reach(b, true);                // ball loaded in the shot pocket
        this.raiseAirborne(b, this.shooter);         // a defender who left early is already up
        break;
      case "inbound":
        this.handler?.reach(b);                      // holds the ball to throw it in
        break;
      case "shot":
        // a FINISHER keeps his hand ON the ball all the way to the rim (a dunk/layup
        // is arm-driven); a jumper only holds the release for the first beat, then
        // follows through.
        if (this.shooter && (this.shooterFinishing || this.shotT < this.shotDur * 0.45)) {
          this.shooter.reach(b, true);
        }
        this.raiseAirborne(b, this.shooter);         // contesting defenders go up
        break;
      case "freethrow":
        if (this.ftT < 1.4) this.ftShooter?.reach(b, true);
        break;
      case "pass":
        // two-handed CHEST pass: both arms shove FORWARD at chest height toward the
        // receiver — NOT up after the arcing ball (which read as an overhead throw)
        if (this.passT < this.passDur * 0.4 && this.passer && this.passTo) {
          const pr = this.passer.pos, tp = this.passTo.pos;
          const dx = tp.x - pr.x, dz = tp.z - pr.z, dl = Math.hypot(dx, dz) || 1;
          this.passer.reach(new Vector3(pr.x + (dx / dl) * 1.2, 1.3, pr.z + (dz / dl) * 1.2), true);
        } else if (this.passT > this.passDur * 0.45) {
          // CATCH: the receiver puts BOTH hands out to meet the incoming ball
          // (his chest is already squared to it — updateFacing turns him), one
          // palm to each side of it, ready to take it BETWEEN the hands
          this.passTo?.holdBallHands(b);
        }
        if (this.passSteal) this.passSteal.def.reach(b);                   // jumping the lane
        break;
      case "loose":
        // everyone going up for the board reaches for it — EXCEPT a shooter still
        // in his follow-through, who must not snap his arms toward a blocked ball
        // (that read as "he threw it there"); he holds his release form below.
        this.raiseAirborne(b, this.shooter && this.shooter.coolT > 0 ? this.shooter : null);
        // GROUND SCRAMBLE for a poked-loose ball: the man who knocked it free keeps
        // a hand STABBING at it (a visible dig, not a teleport-grab), and the man
        // who lost it reaches to snatch it back — so a steal reads as a fight for
        // a live loose ball rather than the ball just changing hands.
        {
          const lb = new Vector3(b.x, Math.max(0.35, b.y), b.z);
          const digger = this.looseStealBy, loser = this.looseStealVictim;
          // the thief LUNGES: one hand out, upper body rotated, arm extended far
          if (digger && !digger.airborne && dist2D(digger.pos, b) < 2.4) digger.digReach(lb);
          // the man who lost it reaches back one-handed to recover
          if (loser && loser !== digger && !loser.airborne && dist2D(loser.pos, b) < 2.2) loser.reach(lb);
        }
        break;
      case "tipoff":
        this.teamPlayers(0)[4].reach(b, true);       // both centres tip with both hands
        this.teamPlayers(1)[4].reach(b, true);
        break;
      // "pause": nobody is holding the ball — arms stay at rest
    }

    // A body in the air with no ball-handling job IS a block/contest jump —
    // both hands go STRAIGHT UP (the early-contest gamble and the rim
    // protector's timed leap happen while the ball is still "held", where no
    // case above raises the arms). Rebound scrambles (loose) and the tip-off
    // keep reaching for the ball itself instead.
    if (this.ballMode !== "loose" && this.ballMode !== "tipoff") {
      for (const p of this.players) {
        if (!p.airborne || p === this.shooter || p === this.handler) continue;
        if (p === this.passer) continue;   // a jump PASSER keeps his chest-pass arms, not hands-up
        if (p.foulReactT > 0) continue;    // the AND-1 flex hop keeps its fists up
        p.reach(new Vector3(p.pos.x, 6, p.pos.z), true);   // dead-vertical target
      }
    }

    // FROZEN FOLLOW-THROUGH: a shooter holds his release form — arms up toward the
    // basket he shot at — for his whole cooldown (coolT), whether he left the floor
    // or not. So a set jumper keeps the pose after the ball leaves, and a
    // blocked/missed shot never snaps his arms toward the ball as if he threw it
    // there. Exceptions: the "charge" gather owns his pose (ball loaded overhead),
    // and the very start of the "shot" flight is the live release motion (the shot
    // case reaches with the ball); after that we freeze the form.
    const sh = this.shooter;
    const releasing = this.ballMode === "shot" && this.shotT < this.shotDur * 0.45;
    if (sh && sh.coolT > 0 && this.ballMode !== "charge" && !releasing
        && sh !== this.handler && sh.foulReactT <= 0) {
      const rim = this.attackFloor(sh.team);
      sh.reach(new Vector3(rim.x, 3.2, rim.z), true);
    }

    // foul reactions play out last so they own the arms over any rest pose
    for (const p of this.players) p.poseFoulReaction();
  }

  // Players in the air (contesting a shot or crashing the glass) raise both hands
  // up toward the ball to grab, tip, or block it.
  private raiseAirborne(b: Vector3, except: Player | null): void {
    for (const p of this.players) {
      if (p !== except && p.airborne) p.reach(b, true);
    }
  }

  // The on-ball defender's hands say what he is answering. Straight blow-by (or a
  // handler driving at the rim) → a front hand cuts off the lane and stabs at the
  // ball. Working it side to side → arms spread wide to wall both directions. A
  // held, stationary ball with the defender right on top → the same front-hand
  // poke. Otherwise he keeps his hands active and wide.
  // How fast a defender can re-orient his hands, in rad/s — a weak defender switches
  // his stance slowly (so he's a beat late), an elite one snaps to it.
  private defArmRate(d: Player): number {
    return 1.2 + rate(d.attr.defense) * 4.3;   // ~1.2 (slow drift) .. ~5.5 (crisp)
  }

  // How fast the ball-handler's dribbling hand can re-place itself — tied to his
  // dribble accuracy (D精度): a loose handler's hand lags, a tight one's is quick.
  private dribArmRate(h: Player): number {
    return 1.2 + rate(h.attr.dribbleAcc) * 4.3;
  }

  private poseOnBallHands(h: Player, b: Vector3, posed: Set<Player>): void {
    const d = this.onBallDefender(h);
    if (!d || d.airborne) return;
    const r = this.defArmRate(d);
    // aim the front hand at a STEADY height, not the raw ball — the dribble bounces
    // y between the floor and the hand, and chasing it makes the hand bob
    const bt = new Vector3(b.x, 1.0, b.z);
    const useRight = d.dribbleWithRight(bt);         // the hand nearer the ball leads
    const rim = this.attackFloor(h.team);            // the basket he is attacking
    const spd = Math.hypot(h.velX, h.velZ);
    const toRimX = rim.x - h.pos.x, toRimZ = rim.z - h.pos.z;
    const rl = Math.hypot(toRimX, toRimZ) || 1;
    const straight = spd > 1.2 && (h.velX * toRimX + h.velZ * toRimZ) / (spd * rl) > 0.5;
    if (h.beatenT > 0 || straight) d.guardDrive(bt, useRight, r);         // cut off penetration
    else if (spd > 1.2) d.armsWide(r);                                    // shut the side lanes
    else if (dist2D(d.pos, h.pos) < 0.9) d.guardDrive(bt, useRight, r);   // poke the held ball
    else d.armsWide(r);
    posed.add(d);
  }

  // Off-ball defenders one pass away and ball-side FRONT their man — a diagonal
  // hand in the lane so the ball can't be threaded behind them (a swing back out
  // is conceded). A defender sagging as help (goal-side of his man) keeps his
  // arms down; the on-ball defender is left to poseOnBallHands.
  private poseDenyHands(h: Player, b: Vector3, posed: Set<Player>): void {
    for (const o of this.teamPlayers(h.team)) {
      if (o === h) continue;                          // he has the ball, not a receiver
      if (dist2D(o.pos, b) > MAX_PASS) continue;      // out of any passing range
      const d = this.onBallDefender(o);               // the man guarding this receiver
      if (!d || d.airborne) continue;
      if (dist2D(d.pos, b) < dist2D(o.pos, b)) {      // ball-side / fronting → deny
        d.denyLane(d.dribbleWithRight(b), this.defArmRate(d));
        posed.add(d);
      }
    }
  }

  // ---- live play (ball is held) -----------------------------------------

  // RELATIVE ball-security duel: a defender's hands (反応/敏捷/守備) vs the
  // handler's control (D精度/技術 + ドリブルキープ). >0 means the defender is
  // winning the battle for the ball — a poor handler vs quick hands loses it, a
  // great handler vs weak hands never does. Everything about the strip scales
  // off THIS difference, so the same handler is safe vs a weak man and in
  // trouble vs a strong one.
  private stripEdge(d: Player, h: Player): number {
    const hands = rate(d.attr.reaction) * 0.45 + rate(d.attr.agility) * 0.35 + rate(d.attr.defense) * 0.2
      + (d.has("interceptor") ? 0.15 : 0);
    const secure = rate(h.attr.dribbleAcc) * 0.62 + rate(h.attr.handling) * 0.38
      + (h.has("keepDribble") ? 0.28 : 0);
    return hands - secure;
  }

  // True when the dribble is up near the hand (secure); false while it's down at
  // the floor (exposed). The cadence — how often it's in the hand — is D精度.
  private ballInHand(h: Player): boolean {
    return Math.abs(Math.cos(Math.PI * h.dribblePhase)) > 0.5;
  }

  // Off-ball defenders who have collapsed onto the ball-handler ALSO dig at it,
  // so being swarmed by 2-3 is genuinely dangerous for a poor handler and barely
  // a bother for a great one (the on-ball defender's own poke is in runDefense).
  // Easier to strip while the ball is down at the floor between dribbles.
  private swarmStrips(dt: number): void {
    const h = this.handler;
    if (!h || this.ballMode !== "held") return;
    const onBall = this.onBallDefender(h);
    const exposed = this.ballInHand(h) ? 0.55 : 1.5;
    for (const d of this.teamPlayers(1 - h.team)) {
      if (d === onBall || d.airborne) continue;
      const gap = dist2D(d.pos, h.pos);
      if (gap > 1.5) continue;
      const close = 1 - gap / 1.5;
      const p = Math.max(0, 0.02 + this.stripEdge(d, h) * 0.55);
      if (chance(p * close * exposed * dt)) { this.steal(d); return; }
    }
  }

  private updateLive(dt: number): void {
    const h = this.handler!;
    // ジャンプパスのウィンドアップ中: 跳び上がってボールを頭上に掲げ、最高点
    // 付近でリリース。コミット済みなので判断もドライブもしない。
    if (this.pendingPassTo) {
      this.pendingPassT -= dt;
      this.ball.pos.set(h.pos.x, 2.0, h.pos.z);
      if (this.pendingPassT <= 0) {
        const target = this.pendingPassTo;
        this.pendingPassTo = null;
        this.passToReceiver(h, target, true, "jump");
      }
      this.runDefense(dt);
      return;
    }
    if (this.pushT > 0) this.pushT = Math.max(0, this.pushT - dt);
    // advance the dribble cadence FIRST so ball-in-hand gating is current this
    // frame: D精度 sets the pound rate (a poor handler dribbles slowly, the ball
    // away from his hand longer)
    h.dribblePhase += dt * (1.6 + rate(h.attr.dribbleAcc) * 1.4);   // 1.6 .. 3.0 Hz
    // ball clearly past halfway → frontcourt established for this possession
    if (!this.frontT && this.attackSign(h.team) * h.pos.z > 0.6) this.frontT = true;
    this.runOffense(dt, h);
    this.runDefense(dt);
    this.catchStrips(dt);
    if (this.ballMode !== "held") return;   // knocked loose out of a bobbled catch
    this.swarmStrips(dt);
    if (this.ballMode !== "held") return;   // a strip this frame ended the dribble
    // --- dribble CARRY position: where the live ball sits around the handler.
    // Out FRONT (toward the rim) he can push it and run — but it's exposed to
    // the man guarding him. Squared up against a defender it tucks to the hip
    // on the FAR side. How fast it relocates between spots is D精度; during a
    // bait (baitT) it's deliberately shown out front to invite the reach-in.
    const rim = this.attackFloor(h.team);
    const dx = rim.x - h.pos.x, dz = rim.z - h.pos.z;
    const len = Math.hypot(dx, dz) || 1;
    const fx = dx / len, fz = dz / len;
    let tx = fx * 0.5, tz = fz * 0.5;                    // default: front carry
    const od = this.onBallDefender(h);
    const dOn = od ? dist2D(od.pos, h.pos) : 99;
    if (h.baitT > 0) {
      tx = fx * 0.6; tz = fz * 0.6;                      // the shown ball
    } else if (od && dOn < 1.7) {
      // squared up: tuck it to the hip away from the defender, pulled back a touch
      const side = ((od.pos.x - h.pos.x) * -fz + (od.pos.z - h.pos.z) * fx) > 0 ? -1 : 1;
      tx = -fz * side * 0.45 - fx * 0.06;
      tz = fx * side * 0.45 - fz * 0.06;
    }
    // 持ち替え/クロスオーバーの速さは D精度 依存。下手ほどモッサリ、上手いほど素早い
    // (~0.9 m の左右持ち替えで下手≈1.8s / 上手≈0.45s)。全体に遅めで、持ち替えに
    // ちゃんと「時間がかかる」よう調整した。
    const cs = (0.5 + rate(h.attr.dribbleAcc) * 1.5) * dt;   // 0.5 .. 2.0 m/s
    h.carryX += clamp(tx - h.carryX, -cs, cs);
    h.carryZ += clamp(tz - h.carryZ, -cs, cs);
    // スティール誘い: walled off with the defender tight, a skilled handler
    // flashes the ball to bait the poke he is ready to yank away from
    if (h.baitT <= 0 && od && dOn < 1.3 && h.beatenT <= 0 && h.powerT <= 0
        && h.jukeT <= 0 && chance(dt * (0.1 + rate(h.attr.handling) * 0.45))) {
      h.baitT = 0.5;
    }
    // the carried ball bounces between hand height and the floor (dam-dam)
    const bounce = Math.abs(Math.cos(Math.PI * h.dribblePhase)); // 1 = at the hand, 0 = floor
    const y = 0.18 + (1.0 - 0.18) * bounce;
    this.ball.pos.set(h.pos.x + h.carryX, y, h.pos.z + h.carryZ);
    // まだ収まっていない: fresh off an off-target catch the ball is NOT secured —
    // it stays where the two-handed catch met it, OUT IN FRONT OF THE CHEST,
    // held BETWEEN both palms. The shake is a SMOOTH low-frequency sway (phased
    // off the draining gatherT, no per-frame noise): the hands are aimed at the
    // same swaying point (holdBallHands in poseHands), so ball and arms move as
    // ONE unit — the tremble reads in the upper arms, not as the ball rattling
    // loose between static palms. Decays as the 硬直 drains, then the normal
    // one-hand carry takes over.
    if (h.gatherT > 0) {
      const amp = Math.min(0.09, h.gatherT * 0.18);
      const ph = h.gatherT * 22 + h.idx;              // smooth sweep as gatherT drains
      const c = h.chestFront(0.36);
      this.ball.pos.set(
        c.x + Math.sin(ph) * amp,
        1.0 + Math.sin(ph * 1.7 + 0.9) * amp * 0.45,  // chest height, gentle vertical bob
        c.z + Math.sin(ph * 1.35 + 2.1) * amp,
      );
    }
  }

  // 収まる前のスティール: while the receiver is still corralling a bobbled catch
  // (gatherT), the ball is loose in his hands — any defender right on him can dig
  // it out and knock it away (a live loose ball, not a clean pick). The worse the
  // bobble (deeper into the 硬直) and the weaker his 技術 vs the defender's hands,
  // the more likely. A clean catch (gatherT≈0) is never exposed this way.
  private catchStrips(dt: number): void {
    const h = this.handler;
    if (!h || this.ballMode !== "held" || h.gatherT <= 0) return;
    const bobble = clamp(h.gatherT * 2.4, 0.2, 1.3);       // how loose the ball still is
    const b = this.ball.pos;
    // the man guarding him JUMPS the bobble: he steps in and digs at the loose
    // ball (the reach pose is in poseHands, gated on the same gatherT). A help
    // defender close by can also poke, but only the primary lunges in.
    const onBall = this.onBallDefender(h);
    for (const d of this.teamPlayers(1 - h.team)) {
      if (d.airborne) continue;
      const gap = dist2D(d.pos, h.pos);
      if (gap > 1.8) continue;
      if (d === onBall && gap > 0.75) {
        // lunge in to attack the exposed ball (don't crawl onto his back)
        moveToward2D(d.pos, b.x, b.z, d.accelSpeed(dt, 1.2) * dt * 0.8);
      }
      const close = 1 - clamp(gap / 1.8, 0, 1);
      const edge = 0.18 + this.stripEdge(d, h) * 0.65;     // defender hands vs handler security
      if (chance(Math.max(0, edge) * close * bobble * dt)) { this.steal(d); return; }
    }
  }

  private runOffense(dt: number, h: Player): void {
    const team = h.team;
    const rimFloor = this.attackFloor(team);
    const dHoop = dist2D(h.pos, rimFloor);
    const dDef = this.nearestDefenderDist(h);

    // off-ball players run motion (cuts, give-and-go, perimeter movement)
    this.updateOffBallMotion(dt, team, h);

    // handler decision — a high offensive IQ reads the floor faster
    h.decisionT -= dt;
    if (h.decisionT <= 0) {
      // the next action can only START when the ball is back in his hand. A poor
      // handler's slow dribble (see dribblePhase cadence) leaves the ball on the
      // floor longer, so he waits — a beat of sluggishness a quick handler never
      // has. (A committed move / dead clock is exempt — the ball's already up.)
      const committed = h.beatenT > 0 || h.powerT > 0 || h.jukeT > 0;
      if (!committed && !this.ballInHand(h) && this.shotClock > 1) {
        h.decisionT = 0.02;   // hold — re-check almost immediately, act when it's up
      } else {
        h.decisionT = rand(0.25, 0.45) * (1.35 - rate(h.attr.offense) * 0.7);
        this.decide(h, dHoop, dDef, rimFloor);
      }
    }

    // movement: how the committed 1-on-1 move plays out. D速度 sets how much of
    // his top speed survives while dribbling; a ball pushed out FRONT adds a
    // little more (and a ball tucked to the hip pushes nothing).
    let mult = 0.84 + rate(h.attr.dribbleSpd) * 0.18;
    if (dHoop > 0.5) {
      const frontness = (h.carryX * (rimFloor.x - h.pos.x) + h.carryZ * (rimFloor.z - h.pos.z)) / dHoop;
      mult *= 1 + clamp(frontness, 0, 0.6) * 0.1;
    }
    if (h.jukeT > 0) {
      // executing a dribble move — the visible footwork (jab step-in, side-step,
      // or step-back) that shakes the defender before the drive resolves
      h.jukeT = Math.max(0, h.jukeT - dt);
      moveToward2D(h.pos, h.jukeTarget.x, h.jukeTarget.z, h.accelToward(dt, h.jukeTarget.x, h.jukeTarget.z, 0.95) * dt);
    } else if (h.beatenT > 0) {
      // SPEED blow-by: burst past the beaten defender to the rim
      h.beatenT = Math.max(0, h.beatenT - dt);
      mult *= 1.12 + rate(h.attr.agility) * 0.14;        // quick handlers burst harder
      // the burst goes past the recovering defender's SHOULDER on the beaten
      // side — never through his chest (running straight at the rim used to
      // grind the blow-by to a halt in the body-collision step)
      let btx = h.driveTarget.x, btz = h.driveTarget.z;
      const bd = this.onBallDefender(h);
      if (bd && dist2D(h.pos, bd.pos) < 1.7
          && dist2D(bd.pos, rimFloor) < dist2D(h.pos, rimFloor)) {
        const dx = rimFloor.x - h.pos.x, dz = rimFloor.z - h.pos.z;
        const dl = Math.hypot(dx, dz) || 1;
        const lx = -dz / dl, lz = dx / dl;               // lateral, driveSide space
        btx = bd.pos.x + lx * h.driveSide * 1.05 + (dx / dl) * 0.5;
        btz = bd.pos.z + lz * h.driveSide * 1.05 + (dz / dl) * 0.5;
      }
      moveToward2D(h.pos, btx, btz, h.accelToward(dt, btx, btz, mult) * dt);
    } else if (h.powerT > 0) {
      // POWER drive: grind straight at the rim INTO the defender. He advances
      // slower, but the collision step (holdWeight²) shoves the weaker man back,
      // so a strong handler bulls his way to the basket and a weak one bogs down.
      h.powerT = Math.max(0, h.powerT - dt);
      mult *= 0.5 + rate(h.attr.balance) * 0.35;         // strong = keeps churning through contact
      moveToward2D(h.pos, h.driveTarget.x, h.driveTarget.z, h.accelToward(dt, h.driveTarget.x, h.driveTarget.z, mult) * dt);
      // PHYSICAL WALL: a defender bodying him up who actually wins the strength
      // battle (higher holdWeight — mostly ボディバランス) stonewalls the drive
      // instead of getting walked to the rim; a weaker one still gets bulldozed.
      const dm = this.onBallDefender(h);
      if (dm && dist2D(h.pos, dm.pos) < 0.95) {
        // a set, strong-bodied defender (ボディバランス, + some 守判断) can
        // stonewall a committed bull drive; the handler's own strength (and post
        // footwork) makes him harder to stop — a weak defender just gets bulldozed
        const stop = rate(dm.attr.balance) * 0.85 + rate(dm.attr.defense) * 0.2
          - rate(h.attr.balance) * 0.75 - (h.has("post") ? 0.15 : 0);
        if (chance(clamp(stop, 0, 0.85) * dt * 2.5)) {
          h.powerT = 0;
          h.stalledT = rand(0.3, 0.5);                   // couldn't move him — walled off
        }
      }
    } else if (h.stalledT > 0) {
      // WALLED OFF: the defender held his ground — the handler is contained and
      // has to pull the ball back out, losing a step of tempo.
      h.stalledT = Math.max(0, h.stalledT - dt);
      this.setDrive(h, rimFloor, dist2D(h.pos, rimFloor) + 0.5); // retreat dribble
      moveToward2D(h.pos, h.driveTarget.x, h.driveTarget.z, h.accelToward(dt, h.driveTarget.x, h.driveTarget.z, 0.5) * dt);
    } else {
      // probing dribble between moves. A big backing his man down keeps the
      // grind (the balance battle is the point of a post-up); anyone else READS
      // the body in his lane and steps AROUND it instead of ploughing straight
      // into the jostle and letting the collision push sort it out.
      const imp = this.driveImpeder(h);
      const posting = this.isBig(h) || h.has("post");
      let tx = h.driveTarget.x, tz = h.driveTarget.z;
      if (imp && posting) {
        const edge = clamp(rate(h.attr.balance) - rate(imp.attr.balance)
          + (h.has("post") ? 0.12 : 0), -0.6, 1);
        const base = this.isBig(h) ? 0.34 : 0.38;
        mult *= clamp(base + edge * 0.6, 0.2, 0.95);
      } else {
        const av = this.steerAround(h, tx, tz, true);
        tx = av.x; tz = av.z;
        if (imp) mult *= 0.8;   // brushing right past a body still isn't free
      }
      moveToward2D(h.pos, tx, tz, h.accelToward(dt, tx, tz, mult) * dt);
    }
    this.clampCourt(h.pos);
    // once established, the handler must not dribble back across halfway
    if (this.frontT) {
      const s = this.attackSign(h.team);
      if (h.pos.z * s < 0.05) h.pos.z = 0.05 * s;
    }
  }

  // The ball-handler's choice — shoot / drive / pass / reset — blending the
  // player's own tendencies & skills with the team's tactical game plan.
  private decide(h: Player, dHoop: number, dDef: number, rimFloor: Vector3): void {
    const tac = this.tactics[h.team].offense;
    const prio = h.offPriority;
    // ロール由来の行動プロファイル: 何をするかはオフェンスロールが支配する。
    // canCreate = 自分から仕掛ける役（エース/スラッシャー/得点ビッグ/balanced）、
    // passFirst = まず配球（ハンドラー/フロアジェネラル/ハブビッグ）、
    // noCreate = 無理に作らない（スポット/カッター/スクリーナー/リバウンダー等）。
    const act = h.offAction;
    const canCreate = act === "score" || act === "slash" || act === "postScore" || act === "balanced";
    const passFirst = act === "distribute" || act === "postHub";
    const noCreate = act === "spot" || act === "cut" || act === "run" || act === "screen" || act === "rebound";

    // BUZZER BEATER: almost no time on the game/shot clock and no chance to work
    // a good look — heave it up from wherever he is, however off-balance. shoot()
    // already floors the make% for a desperation distance, so it's a real prayer.
    // game buzzer → always heave. Shot-clock buzzer → heave UNLESS a hard deny
    // has him smothered (then he can't get it off and the clock dies = violation).
    const gameBuzzer = this.gameClock > 0 && this.gameClock < 0.9;
    const shotBuzzer = this.shotClock < 0.45;
    // he can only launch the deep one if there's clock left to GATHER it — a low
    // L速度 player heaving from way behind the arc needs wind-up time he doesn't
    // have, so the shot clock dies (violation) instead of an ugly deep prayer.
    // (the end-of-quarter game buzzer is exempt: any desperation heave goes up.)
    const canGather = this.shotClock >= this.gatherFor(h, dHoop);
    if ((gameBuzzer || (shotBuzzer && canGather && !this.denySmother(h, dDef))) && dHoop > 1.8) {
      this.shoot(h, dHoop, dDef); return;
    }

    // ゴール至近でフリーで受けた: 迷わずフィニッシュ。ここから外へ持ち出して
    // ゴールに向き直る「時間をかける攻め」は不要 — マークが居ないなら即アタック。
    if (dDef > 1.0 && this.frontT) {
      if (dHoop <= 2.3) { this.finishAtRim(h, dDef); return; }
      if (dHoop <= 4.0 && this.laneClear(h, rimFloor)) { this.setDrive(h, rimFloor, 1.2); return; }
    }

    // change of possession: the ball has to be carried up, and that's a guard's
    // job. A PF/C who ends up with it before the frontcourt is set looks for the
    // point guard first, then the shooting guard, and hands it off rather than
    // dribbling it up himself. (An offensive rebound keeps frontT, so a big
    // still finishes at the rim there — this only fires while bringing it up.)
    // (a プレイメイキングビッグ is exempt — he brings it up and runs the
    // offence himself, ヨキッチ-style)
    if (!this.frontT && this.isBig(h) && h.evalRole !== "プレイメイキングビッグ" && dHoop > 10) {
      // the two best playmakers get first call (normally PG then SG — but a
      // designated メインハンドラー outranks them wherever he plays)
      const guards = this.teamPlayers(h.team).filter((g) => g !== h)
        .sort((a, b) => b.playmaking - a.playmaking);
      for (const g of guards.slice(0, 2)) {
        if (this.outletTo(h, g)) return;
      }
      this.advanceSafely(h);                     // no guard free yet — hold/drift, don't attack
      return;
    }

    // FAST BREAK: a guard/wing with the ball and an open floor pushes it hard
    // at the rim before the defence sets (the big already outlet above).
    if (this.pushT > 0) { this.pushBreak(h, dHoop); return; }

    // at the rim → finish; shot-clock dying → put one up
    // at the rim → finish. A handler arriving at full burst takes off earlier —
    // the driving layup/floater launches from a step further out
    if (dHoop < (h.beatenT > 0 ? 2.3 : 1.8)) { this.finishAtRim(h, dDef); return; }

    // a committed 1-on-1 move is already under way — see it through (the burst /
    // bull drive carries him; the finish check above ends it at the rim) rather
    // than re-deciding every tick, which is what made the old drive look mushy
    if (h.beatenT > 0 || h.powerT > 0 || h.jukeT > 0) return;
    // walled off: contained this rep — kick it out to a better look, otherwise
    // keep pulling it back out (movement handles the retreat) and re-attack once
    // the stall clears
    if (h.stalledT > 0) { if (chance(0.5) && this.pass(h)) return; return; }

    // mid-combo: the last shake didn't spring him but the defender is rocking —
    // go straight back into the duel with the next move the other way
    if (h.comboN > 0) {
      if (this.canIso(h, dHoop)) { this.driveDecision(h); return; }
      h.comboN = 0;                        // situation changed — abandon the combo
    }

    // the man guarding him has LEFT HIS FEET (an early-contest gamble or a
    // fake he bought) — put the ball on the floor and walk past the floater.
    // Quick, sharp handlers punish it almost every time; slower ones sometimes
    // hesitate and the moment passes. (only the shot-creators exploit it off the
    // dribble — a spot-up/distributor doesn't suddenly iso.)
    if (canCreate) {
      const od = this.onBallDefender(h);
      if (od && od.airborne && dDef < 2.2 && this.canIso(h, dHoop)
          && chance(0.45 + rate(h.attr.reaction) * 0.3 + rate(h.attr.handling) * 0.15)) {
        h.driveSide = this.pickSide(h);
        h.beatenT = rand(0.6, 0.9);
        od.reactT = Math.max(od.reactT, rand(0.35, 0.6) * this.reactionLag(od));
        this.setDriveSide(h);
        return;
      }
      // ATTACK THE CLOSEOUT: a defender still flying at him under control-less
      // momentum (high closing speed) can be driven straight past — the handle
      // (技術) and quickness (敏捷性) beat him, and his ボディバランス is what
      // lets him stop and stay down instead of blowing by. A slow, balanced
      // closeout isn't punished.
      if (od && !od.airborne && dDef < 2.4 && od.curSpd > od.runSpeed * 0.55
          && this.canIso(h, dHoop)) {
        const edge = rate(h.attr.handling) * 0.4 + rate(h.attr.agility) * 0.35
          + rate(h.attr.dribbleAcc) * 0.25 - rate(od.attr.balance) * 0.5;
        if (chance(clamp(0.3 + edge, 0.08, 0.75))) {
          h.driveSide = this.pickSide(h);
          h.beatenT = rand(0.55, 0.85);
          od.reactT = Math.max(od.reactT, rand(0.3, 0.5) * this.reactionLag(od));
          this.setDriveSide(h);
          return;
        }
      }
    }

    // 目の前の守備を抜けない（直前のドライブが止められた）: 単騎の壁でも
    // キックアウトの引き出し（ジャンプパス/バウンドパス）で打開を試みる
    if (h.stalledT > 0 && dDef < 1.6 && this.trapKickOut(h)) return;

    // DOUBLE-TEAM / TRAP: a GENUINE trap is two men BOTH collapsed tight on the
    // ball (not merely two defenders loosely in the area, which is constant in a
    // half-court). Only then does the trap read take over; otherwise fall through
    // to the normal decision. The correct read is to KICK OUT (a double team
    // leaves a team-mate open) or keep it and reset — not bull into the wall.
    {
      const d1 = this.onBallDefender(h);
      let tight = 0, contain = 0;
      let d2: Player | null = null, d2d = Infinity;
      for (const dn of this.teamPlayers(1 - h.team)) {
        const dd = dist2D(dn.pos, h.pos);
        if (dd < 1.6) {
          tight++;
          contain += rate(dn.attr.defense) * 0.4 + rate(dn.attr.agility) * 0.35 + rate(dn.attr.balance) * 0.25;
        }
        if (dn !== d1 && dd < 1.9 && dd < d2d) { d2d = dd; d2 = dn; }
      }
      // real trap: two men within 1.6 m AND actual on-ball pressure (dDef tight)
      if (tight >= 2 && dDef < 1.4) {
        // Splitting the trap off the dribble. A designated slasher — スラッシャー
        // special ability ("driver") OR スラッシャー offence role (offAction
        // "slash") — does it READILY; anyone else only rarely forces it (a low,
        // non-zero floor so the read isn't robotic). It is NOT just an ability
        // check: a real SEAM has to exist between the two trappers, and a team-mate
        // bodying one of them opens it up further. Success is RELATIVE to the trap.
        if (this.canIso(h, dHoop)) {
          // SEAM measured along the lane to the rim: split to either side → a gap
          // down the MIDDLE; overloaded to one side → the OUTSIDE is the opening;
          // stacked on the ball → no lane.
          let seam = 0;
          if (d1 && d2) {
            let ux = rimFloor.x - h.pos.x, uz = rimFloor.z - h.pos.z;
            const ul = Math.hypot(ux, uz) || 1; ux /= ul; uz /= ul;
            const px = -uz, pz = ux;                                    // lateral axis
            const lat1 = (d1.pos.x - h.pos.x) * px + (d1.pos.z - h.pos.z) * pz;
            const lat2 = (d2.pos.x - h.pos.x) * px + (d2.pos.z - h.pos.z) * pz;
            seam = lat1 * lat2 < 0 ? Math.min(Math.abs(lat1), Math.abs(lat2)) : 0.8;
          }
          const seamScore = clamp((seam - 0.4) / 1.2, 0, 1);           // ~bodies..wide-open
          // a TEAM-MATE bodying / screening one trapper occupies him, so the trap
          // is effectively short-handed and the handler slips his mark
          let screen = 0;
          for (const mate of this.teamPlayers(h.team)) {
            if (mate === h) continue;
            if (d1 && dist2D(mate.pos, d1.pos) < 1.2) screen = Math.max(screen, 0.5);
            if (d2 && dist2D(mate.pos, d2.pos) < 1.2) screen = Math.max(screen, 0.5);
          }
          const attack = rate(h.attr.handling) * 0.35 + rate(h.attr.agility) * 0.35
            + rate(h.attr.dribbleAcc) * 0.20 + rate(h.attr.speed) * 0.10;
          const rel = attack - contain / tight;                        // edge over the trap
          const slasher = h.has("driver") || act === "slash";
          const openness = seamScore * (slasher ? 0.28 : 0.14) + screen * (slasher ? 0.22 : 0.12);
          const splitChance = slasher
            ? clamp(0.05 + rel * 1.5 + openness, 0.03, 0.65)
            : clamp(0.02 + rel * 0.45 + openness, 0.015, 0.24);
          if (chance(splitChance)) { this.driveDecision(h); return; }
        }
        // can't split → SOLVE IT WITH PASSING: kick out to the man the trap left
        // open (a good passer threads a bounce/jump pass between them). If nobody
        // is open yet, EVADE — retreat-dribble out of the trap and reset, rather
        // than standing there keeping the ball in the double-team.
        if (this.trapKickOut(h)) return;
        this.retreatFromTrap(h);
        return;
      }
    }

    // ROLE-DRIVEN ACTION — the ball has reached him; what he does now follows
    // his OFFENSIVE ROLE, so funnelling usage to a distributor/big/spacer does
    // NOT turn him into a gunner or a reckless dribbler.
    if (passFirst) {
      // ハンドラー/フロアジェネラル/ハブビッグ: まず配球。ただし「打たずにパス回し
      // だけ」にならないよう、空いた球は打ち、レーンが開けば仕掛けてギャップを作る。
      if (!this.frontT) { this.bringUpLane(h); return; }
      if (this.shotClock < SHOT_CLOCK * 0.3 && dHoop > 1.8 && canGather && !this.wontLoadUp(h, dHoop, dDef) && !this.denySmother(h, dDef)) {
        // ヒーブを投げ捨てる前に: まだ1秒以上あるなら、まずラインまで急いで寄る
        // （深い3は効き射程外＝確率を捨てるだけ）。1秒を切ったら腹を括って打つ。
        if (dHoop > this.effShootRange(h) + 0.6 && this.shotClock > 1.0) { this.setDrive(h, rimFloor, THREE_DIST + 0.2); return; }
        this.shoot(h, dHoop, dDef);
        return;
      }
      const inRange = dHoop <= this.effShootRange(h) + 0.3;
      const clockPush = clamp((SHOT_CLOCK * 0.5 - this.shotClock) / (SHOT_CLOCK * 0.5), 0, 1);   // 遅いほど打つ(残半分から)
      // a clean lane → attack to bend the defence (a big posts instead of dribbling)
      if (this.laneClear(h, rimFloor) && dHoop <= 8 && this.canIso(h, dHoop)
          && chance(clamp(0.2 + rate(h.attr.handling) * 0.25 + clockPush * 0.3, 0, 0.6))) {
        if (this.isBig(h)) this.postMove(h); else this.driveDecision(h);
        return;
      }
      const open = dDef > 1.7;
      const pS = clamp(0.16 + rate(h.attr.threeAcc) * 0.28 + (dDef - 1.7) * 0.2 + clockPush * 0.5, 0.04, 0.9);
      if (inRange && open && chance(pS)) { this.shoot(h, dHoop, dDef); return; }
      if (this.pass(h)) return;
      this.setDrive(h, rimFloor, Math.min(4.5, Math.max(dHoop, 1.2)));   // probe/reset — never backs a man OUT of the paint
      return;
    }
    if (noCreate) {
      // スポット/カッター/ランナー/スクリーナー/リバウンダー: キャッチ&シュートが
      // 基本。無理な単独クリエイトはしないが、「クローズアウトには仕掛ける」ことで
      // ギャップを作り、開いた球はしっかり打つ（打たずに回すだけにしない）。
      if (!this.frontT) { this.bringUpLane(h); return; }
      if (this.shotClock < SHOT_CLOCK * 0.3 && dHoop > 1.8 && canGather && !this.wontLoadUp(h, dHoop, dDef) && !this.denySmother(h, dDef)) {
        // ヒーブを投げ捨てる前に: まだ1秒以上あるなら、まずラインまで急いで寄る
        // （深い3は効き射程外＝確率を捨てるだけ）。1秒を切ったら腹を括って打つ。
        if (dHoop > this.effShootRange(h) + 0.6 && this.shotClock > 1.0) { this.setDrive(h, rimFloor, THREE_DIST + 0.2); return; }
        this.shoot(h, dHoop, dDef);
        return;
      }
      const inRange = dHoop <= this.effShootRange(h) + 0.3;
      const clockPush = clamp((SHOT_CLOCK * 0.5 - this.shotClock) / (SHOT_CLOCK * 0.5), 0, 1);
      // ATTACK THE CLOSEOUT: a shooter with a live handle drives past a defender
      // flying at him — the main way an off-ball scorer creates a gap.
      const od = this.onBallDefender(h);
      if (od && !od.airborne && dDef < 2.3 && od.curSpd > od.runSpeed * 0.5
          && this.canIso(h, dHoop) && rate(h.attr.handling) > 0.45
          && chance(clamp(0.28 + rate(h.attr.handling) * 0.4 + rate(h.attr.agility) * 0.3
              - rate(od.attr.balance) * 0.4, 0.1, 0.7))) {
        h.driveSide = this.pickSide(h); h.beatenT = rand(0.5, 0.8);
        od.reactT = Math.max(od.reactT, rand(0.3, 0.5) * this.reactionLag(od));
        this.setDriveSide(h); return;
      }
      const isThreeL = dHoop > THREE_DIST;
      const open = dDef > (h.has("isoShooter") ? 1.3 : 1.5);
      const pS = clamp(0.42 + rate(h.attr.aggression) * 0.2 + (dDef - 1.5) * 0.22
        + (isThreeL ? tac.threeBias * 0.2 * this.twWeight(h) : 0.12) + clockPush * 0.4, 0.06, 0.95);
      if (inRange && open && chance(pS)) { this.shoot(h, dHoop, dDef); return; }
      if (this.pass(h)) return;
      this.setDrive(h, rimFloor, Math.min(4.5, Math.max(dHoop, 1.2)));
      return;
    }

    // BIGS (PF/C) — and anyone with the ポスト ability — work in the post: back
    // the defender down to the rim for a layup/dunk rather than settle for a
    // jumper. Kick out if bodied up hard or if a clearly better look is open.
    if (this.isBig(h) || h.has("post")) {
      if (dDef < 1.1 && chance(0.3)) {
        const better = this.betterOptionAvailable(h);
        if (better && this.passToReceiver(h, better)) return;
      }
      if (dHoop > 6 && chance(dHoop > 10 ? 0.85 : 0.45) && this.pass(h)) return;
      this.postMove(h);
      return;
    }

    // 残クロックに対する相対しきい値(SHOT_CLOCK 依存)。7秒クロックでは ~2.5秒前後で
    // 初めて「打ち急ぎ」に入る（up-tempo は少し早い）。絶対秒だと短クロックで早過ぎた。
    const urgent = this.shotClock < SHOT_CLOCK * (0.28 + tac.pace * 0.14 * this.twWeight(h));
    // 打ち急ぎ圏でギャザーが間に合わない（深すぎる）: 外で持て余さず、ワインド
    // アップの要らないレイアップを狙ってリムへ切り込む
    if (urgent && this.shotClock > 0.8 && this.wontLoadUp(h, dHoop, dDef)) {
      this.driveDecision(h);
      return;
    }
    if (urgent && canGather && !this.wontLoadUp(h, dHoop, dDef) && !this.denySmother(h, dDef)) {
      // 打ち急ぎでも深い3は投げ捨てない: 効き射程の外に居てまだ1秒以上あるなら、
      // まずラインへ寄る（1秒を切ったらどこからでも打つ）
      if (dHoop > this.effShootRange(h) + 0.6 && this.shotClock > 1.0) { this.setDrive(h, rimFloor, THREE_DIST + 0.2); return; }
      this.shoot(h, dHoop, dDef);
      return;
    }

    // desire to do each thing = personality + skill + tactics(×連携) + scoring
    // role + 特殊能力 (ドリブラー/ストライカー/ドリブルキープ)
    const tw = this.twWeight(h);
    let driveDesire = rate(h.attr.aggression) * 0.35 + rate(h.attr.handling) * 0.25 + tac.driveBias * 0.4 * tw;
    if (h.has("driver")) driveDesire += 0.25;        // ドリブラー: hunts the blow-by
    let shootDesire = rate(h.attr.aggression) * 0.4 + prio * 0.4 + tac.pace * 0.2 * tw;
    if (h.has("striker")) shootDesire += 0.15;       // ストライカー: scorer's mentality
    if (h.has("keepDribble")) shootDesire -= 0.08;   // キープ型は攻め急がない
    let passDesire = (1 - rate(h.attr.aggression)) * 0.25 + rate(h.attr.passAcc) * 0.2
      + tac.ballMovement * 0.4 * tw + (1 - prio) * 0.25; // lower options give it up more

    // ペイント内で持った場合、連携が低い選手ほどチーム戦術やパスより「自分で決める」
    // ことを優先する: ドライブ/フィニッシュ意欲を上げ、キックアウト意欲を下げる。連携が
    // 高い選手はここでも設計どおりボールを動かす。(オープンなリム至近は上流で即フィニッシュ
    // 済みなので、ここが効くのは競り合った状態のペイント。)
    if (dHoop <= 4.3 && Math.abs(h.pos.x) <= 2.6) {
      const selfish = (1 - rate(h.attr.teamwork)) * 0.4;   // 連携100→+0, 連携0→+0.4
      driveDesire += selfish;
      shootDesire += selfish;
      passDesire = Math.max(0, passDesire - selfish * 1.2);
    }

    const laneOpen = this.laneClear(h, rimFloor);
    const beaten = h.beatenT > 0;
    const isThree = dHoop > THREE_DIST;

    // clear path to the rim within range → usually attack (a layup beats a jumper),
    // unless a pass-first player kicks it or an elite shooter has a wide-open look
    if ((beaten || laneOpen) && dHoop <= 9) {
      if (!beaten && isThree && dDef > 2.0 && rate(h.attr.threeAcc) > 0.65
          && dHoop <= this.effShootRange(h) + 0.3           // within his EFFECTIVE range (deep 3 = elite only)
          && chance(0.25 + tac.threeBias * 0.4 * tw)) { this.shoot(h, dHoop, dDef); return; }
      const driveChance = beaten ? 1 : clamp(0.35 + driveDesire * 0.55, 0.25, 0.95);
      if (chance(driveChance)) { this.driveDecision(h); return; }
      if (chance(passDesire * 0.7) && this.pass(h)) return;
      this.driveDecision(h);
      return;
    }

    // no clean lane: an open look is taken (the primary option most readily);
    // a tough, contested look is swung to a higher scoring option if one is open.
    // L速度 (range) decides how far out this player is a willing shooter.
    if (dHoop <= this.effShootRange(h) + 0.3) {
      // 1対1シュート: happy to rise over a single defender
      const open = dDef > (h.has("isoShooter") ? 1.4 : 1.7);
      // クロック連動の撃ち急ぎ: 残クロックが減るほどオープンな射程内の球は打つ。
      // (この主判断ルートには従来 clockPush が無く、開いていても回してしまい
      //  ショットクロック違反を量産していた。)
      const clockPush = clamp((SHOT_CLOCK * 0.6 - this.shotClock) / (SHOT_CLOCK * 0.6), 0, 1);
      let pShoot = 0.20 + shootDesire * 0.55 - (dHoop - 2) * 0.04 + (dDef - 1) * 0.3 + clockPush * 0.5;
      if (isThree) pShoot += tac.threeBias * 0.22 * tw - 0.05;
      pShoot = clamp(pShoot, 0.03, 0.96);
      if (open && chance(pShoot)) { this.shoot(h, dHoop, dDef); return; }

      // a defender closing out on a shooter with a handle can be punished with a
      // STEP-BACK: bait the closeout, then blow by or rise into clean space
      if (!open && dDef < 1.5 && this.canIso(h, dHoop) && h.jukeT <= 0
          && (rate(h.attr.midAcc) > 0.55 || rate(h.attr.threeAcc) > 0.6)
          && chance(clamp(0.05 + rate(h.attr.dribbleAcc) * 0.14 + rate(h.attr.agility) * 0.1, 0, 0.32))) {
        const d = this.onBallDefender(h);
        if (d) { this.stepBack(h, d, dHoop); return; }
      }

      // not a clean look → this is where a scorer ATTACKS his man off the dribble
      // (a real isolation), trying to beat him with speed or power rather than
      // settling or resetting. This is the main source of half-court penetration.
      if (this.canIso(h, dHoop) && chance(clamp(0.2 + driveDesire * 0.5, 0.08, 0.7))) {
        this.driveDecision(h); return;
      }

      // difficult shot → look to swing it to a better (open) scoring option
      const better = this.betterOptionAvailable(h);
      if (better && this.passToReceiver(h, better)) return;

      if (chance(pShoot)) { this.shoot(h, dHoop, dDef); return; } // else back yourself
    }
    // out of shooting range (or declined to shoot): attack off the dribble to get
    // downhill, else move the ball, else probe and reset
    if (this.canIso(h, dHoop) && chance(clamp(driveDesire * 0.45, 0, 0.6))) {
      this.driveDecision(h); return;
    }
    const passUrge = clamp(passDesire * 0.6 + (dDef < 1.3 ? 0.2 : 0), 0, 0.85);
    if (chance(passUrge) && this.pass(h)) return;
    // still bringing it up (backcourt) → carry it up a SIDE lane, not the gut;
    // in the frontcourt it's just a reset probe toward the rim
    if (!this.frontT) this.bringUpLane(h);
    else this.setDrive(h, rimFloor, Math.min(4.5, Math.max(dHoop, 1.2)));
  }

  // The side (−1 left / +1 right) with more room — fewer team-mates on it — so
  // the ball comes up away from the crowd and the floor stays spread.
  private openSide(h: Player): number {
    let l = 0, r = 0;
    for (const p of this.teamPlayers(h.team)) {
      if (p === h) continue;
      if (p.pos.x < -0.5) l++; else if (p.pos.x > 0.5) r++;
    }
    return l <= r ? -1 : 1;
  }

  // Bring the ball up a WING lane into the frontcourt rather than straight up the
  // middle (which jams the paint and kills the passing angles). Once he's off
  // centre he keeps his side; from dead centre he picks the open side.
  private bringUpLane(h: Player): void {
    const s = this.attackSign(h.team);
    const side = Math.abs(h.pos.x) > 1.5 ? Math.sign(h.pos.x) : this.openSide(h);
    // BREAK to the sideline first (mostly lateral) while still central, THEN
    // carry it up hugging that side — keeps the middle clear and opens the
    // left/right passing angles instead of jamming straight up the gut.
    const ahead = Math.abs(h.pos.x) < 4 ? 1.8 : 5.0;
    h.driveTarget.set(side * 5.5, 0, h.pos.z + s * ahead);
  }

  // A teammate who is a clearly higher scoring option, is open, and can be
  // reached with a reasonably safe pass — the "swing it to the go-to guy" read.
  // 2+ defenders collapsed within 2.0 m — a genuine double-team. Passing to a
  // trapped man just restarts the trap the offence is trying to escape.
  private doubleTeamed(p: Player): boolean {
    let n = 0;
    for (const d of this.teamPlayers(1 - p.team)) if (dist2D(d.pos, p.pos) < 2.0) { if (++n >= 2) return true; }
    return false;
  }

  private betterOptionAvailable(h: Player): Player | null {
    let best: Player | null = null;
    let bestPrio = h.offPriority + 0.1;          // must be a meaningfully better option
    for (const p of this.teamPlayers(h.team)) {
      if (p === h || p.offPriority <= bestPrio) continue;
      if (p === this.assistFrom && this.assistTo === h && !p.cutting) continue; // no ping-pong
      if (dist2D(h.pos, p.pos) > MAX_PASS) continue;            // out of range
      if (this.frontT && this.attackSign(h.team) * p.pos.z < 0.4) continue; // backcourt
      if (this.nearestDefenderDist(p) < 2.0) continue;          // not actually open
      if (this.doubleTeamed(p)) continue;                        // never swing back into a trap
      if (p.justPassedT > 0) continue;                           // he just gave it up — no ping-pong
      if (this.laneVetoed(h, p) || this.passRisk(h, p) > 0.25) continue; // no lane
      bestPrio = p.offPriority;
      best = p;
    }
    return best;
  }

  // The defender assigned to the current ball-handler (man-to-man by number).
  private onBallDefender(h: Player): Player | undefined {
    return this.teamPlayers(1 - h.team)[h.slot];
  }

  // A big backs his man down: drive straight at the rim (no crossover/feint).
  // How fast he gets there — and whether he bulls the defender backward — is the
  // strength battle resolved in runOffense and the collision step.
  private postMove(h: Player): void {
    const rim = this.attackFloor(h.team);
    h.driveTarget.set(rim.x, 0, rim.z);
  }

  // Hand the ball off to a guard bringing it up: only when he's a realistic
  // outlet (in range and not smothered — he's come back toward the ball, so with
  // the defence ahead in transition this usually lands).
  private outletTo(h: Player, g: Player): boolean {
    if (dist2D(h.pos, g.pos) > MAX_PASS) return false;
    if (this.nearestDefenderDist(g) < 1.2) return false;   // still covered — wait
    return this.passToReceiver(h, g);
  }

  // No guard is open for the outlet yet — the big keeps carrying it up toward the
  // top of the key rather than stalling short of halfway (which used to freeze him
  // right at the centre line). The outlet is re-checked every decision tick, so he
  // still hands off the instant a guard comes free; if none ever does, he brings it
  // up himself rather than getting stuck.
  private advanceSafely(h: Player): void {
    // a big who ends up bringing it up also uses a side lane, not the middle
    if (!this.frontT) this.bringUpLane(h);
    else this.setDrive(h, this.attackFloor(h.team), 8);   // ~top of the key, in the frontcourt
  }

  // SOLVE THE TRAP WITH PASSING: the double-team leaves a man open — hit him. Only
  // force it to a GENUINELY OPEN team-mate through a lane that isn't dead-blocked
  // (no wild kick-outs into coverage that read as throw-aways). The forced pass
  // still skips the normal risk gate, so a skilled passer threads a tightish lane,
  // but a covered man / a body in the lane is never forced.
  private trapKickOut(h: Player): boolean {
    let best: Player | null = null, bestScore = 0;
    let bestVet = false;
    for (const mate of this.teamPlayers(h.team)) {
      if (mate === h) continue;
      if (dist2D(h.pos, mate.pos) > MAX_PASS) continue;
      const open = this.nearestDefenderDist(mate);
      if (open < 1.6) continue;                         // only a genuinely open man
      // a body dead in the lane no longer kills the option — the BOUNCE pass goes
      // under his hands — it just costs a little in the scoring
      const vet = this.laneVetoed(h, mate);
      const score = open - this.passRisk(h, mate) * 2 - (vet ? 0.6 : 0);
      if (score > bestScore) { bestScore = score; best = mate; bestVet = vet; }
    }
    if (!best) return false;
    if (bestVet || chance(0.25)) {
      // 頭上のレーンが塞がれている(または気まぐれに) → バウンドパス:
      // トラッパーの手の下を突き、床で一つ跳ねて味方の手元へ
      return this.passToReceiver(h, best, true, "bounce");
    }
    // 頭上が使える → 本物のジャンプパス: ダンク級に跳び、最高点から頭上を越す
    h.jump(0.5, 0.6);
    this.pendingPassTo = best;
    this.pendingPassT = 0.22;
    return true;
  }

  // EVADE THE TRAP: retreat-dribble to open floor to break the double-team and
  // open a passing angle, instead of standing in it. NOT simply "away from the
  // defenders": for a handler herded into a corner that direction points OUT OF
  // BOUNDS, and the court clamp then pins him on the corner exactly as the trap
  // wants — the classic 角で固められる. Instead sample legal headings and take
  // the one that actually gains separation while staying on the floor (biased
  // a touch toward the middle / up-court, where his outlets live).
  private retreatFromTrap(h: Player): void {
    const defs = this.teamPlayers(1 - h.team).slice()
      .sort((a, b) => dist2D(a.pos, h.pos) - dist2D(b.pos, h.pos));
    const a = defs[0], b2 = defs[1] ?? defs[0];
    const s = this.attackSign(h.team);
    let bx = 0, bz = this.frontT ? s * 2 : 0;   // fallback: head for centre floor
    let bestScore = -Infinity;
    for (let i = 0; i < 12; i++) {
      const ang = (i / 12) * Math.PI * 2;
      const tx = h.pos.x + Math.cos(ang) * 3.0;
      const tz = h.pos.z + Math.sin(ang) * 3.0;
      if (Math.abs(tx) > COURT.halfW - 0.7 || Math.abs(tz) > COURT.halfL - 0.7) continue;
      if (this.frontT && s * tz < 0.5) continue;   // never retreat into a backcourt violation
      const sep = Math.min(dist2DTo(a.pos, tx, tz), dist2DTo(b2.pos, tx, tz));
      let score = sep - Math.abs(tx) * 0.08;       // slight pull off the sideline
      if (!this.frontT) score += s * (tz - h.pos.z) * 0.10;   // bringing it up: prefer forward escapes
      if (score > bestScore) { bestScore = score; bx = tx; bz = tz; }
    }
    h.driveTarget.set(bx, 0, bz);
  }

  // Open a fast-break window after a live-ball change of possession, if the
  // ball is in the backcourt (a real chance to beat the defence down the floor).
  private maybeStartPush(): void {
    const h = this.handler;
    if (h && !this.frontT && this.attackSign(h.team) * h.pos.z < 6) this.pushT = 4.5;
  }

  // FAST BREAK: the handler pushes the ball hard at the rim before the defence
  // gets set. If a wing has beaten his man down the floor and is open near the
  // rim, hit him for the layup instead. SPEED / 加速力 (how fast the handler
  // covers ground and the runners fill the lanes) decide whether it lands.
  private pushBreak(h: Player, dHoop: number): void {
    // ahead-of-the-ball runner open at the rim → drop it off
    const rim = this.attackFloor(h.team);
    let best: Player | null = null, bestGap = 1.6;
    for (const p of this.teamPlayers(h.team)) {
      if (p === h) continue;
      const dRim = dist2D(p.pos, rim);
      const ahead = this.attackSign(h.team) * (p.pos.z - h.pos.z) > 1.5;
      if (ahead && dRim < 4.5) {
        const g = this.nearestDefenderDist(p);
        if (g > bestGap) { bestGap = g; best = p; }
      }
    }
    if (best && dHoop > 3 && this.passToReceiver(h, best)) return;
    // otherwise attack the rim himself (a beaten defender behind him can't stop it)
    if (dHoop < 1.9) { this.finishAtRim(h, this.nearestDefenderDist(h)); return; }
    this.setDrive(h, rim, 1.5);
  }

  // Whether the handler is in a spot to take his man off the dribble: close
  // enough to drive on, in the frontcourt, and with time on the clock. No point
  // isolating from 20 feet out or with the shot clock about to expire.
  private canIso(h: Player, dHoop: number): boolean {
    if (dHoop > 9 || dHoop < 1.8) return false;
    if (this.shotClock < 3) return false;
    if (this.frontT && this.attackSign(h.team) * h.pos.z < 0.4) return false; // backcourt
    return true;
  }

  // Pick an attack side when free to choose: the dominant hand leads, 逆手頻度
  // decides how often he is happy going the other way.
  private pickSide(h: Player): number {
    return chance(h.strongSideBias()) ? h.strongSide() : -h.strongSide();
  }

  // The heart of the 1-on-1: choose which way to attack, throw in the odd
  // crossover, and blow by when the defender is caught leaning the wrong way.
  // The 1-on-1 read: a dribble move that tries to shift the defender's weight
  // (his centre of gravity) the wrong way with a fake, then attacks the opening.
  // A high-handle, quick creator sells the move and turns the corner far more
  // often; a disciplined, quick-footed defender bites less and stays in front.
  private driveDecision(h: Player): void {
    const d = this.onBallDefender(h);
    if (!d) {
      // nobody in front — just pick a side and go straight in
      h.comboN = 0;
      h.driveSide = this.pickSide(h);
      h.beatenT = Math.max(h.beatenT, rand(0.4, 0.7));
      this.setDriveSide(h);
      return;
    }
    d.reactT = rand(0.18, 0.4) * this.reactionLag(d);    // any move forces a reaction

    // TWO ways to beat your man off the dribble, and a player attacks the way his
    // tools (and the matchup) favour:
    //  • SPEED — a crossover that shifts the defender's weight, then turn the corner
    //  • POWER — lower the shoulder and bull him back toward the rim
    // NOTE: the defender's containment weighs MORE than the handler's creation,
    // so a quick, high-IQ defender wins the neutral matchup — good on-ball defence
    // actually stops penetration instead of every drive being a coin flip.
    // The defender's containment weighs MORE than the handler's creation (see
    // below); a good on-ball defender should genuinely stop penetration.
    const speedEdge = rate(h.attr.handling) * 0.45 + rate(h.attr.agility) * 0.35
      + rate(h.attr.dribbleAcc) * 0.2 + (h.has("driver") ? 0.1 : 0)
      - (rate(d.attr.agility) * 0.62 + rate(d.attr.reaction) * 0.4
        + rate(d.attr.defense) * 0.55 + (d.has("manMark") ? 0.12 : 0));   // 守判断を増強(基準は pBeat 側で再センタ)
    // POWER is a physical battle — but it still takes HANDLE to keep the ball on
    // a string while bulling in; a strong but clumsy player (a defender-type big
    // with low 技術/D精度) can't just steamroll to the rim. The defender resists
    // mostly with ボディバランス (raw strength) plus 守判断.
    const powerEdge = rate(h.attr.balance) * 0.55 + rate(h.attr.aggression) * 0.2
      + rate(h.attr.dribbleAcc) * 0.2 + rate(h.attr.handling) * 0.15 + (h.has("post") ? 0.15 : 0)
      - (rate(d.attr.balance) * 1.05 + rate(d.attr.defense) * 0.60);   // 守判断を増強(基準は pPower 側で再センタ)

    // a player's OWN tools set his style first: a strong, physical player (high
    // ボディバランス, aggressive) bullies his way in; a quick, high-handle player
    // (敏捷性/技術) crosses over. The matchup then nudges it — attack whichever the
    // defender is weaker against.
    const ownPower = rate(h.attr.balance) + rate(h.attr.aggression) * 0.5 + (h.has("post") ? 0.4 : 0);
    const ownSpeed = rate(h.attr.agility) + rate(h.attr.handling) * 0.7 + (h.has("driver") ? 0.4 : 0);
    const usePower = h.comboN === 0 && chance(clamp(0.5 + (ownPower - ownSpeed) * 0.6
      + (powerEdge - speedEdge) * 0.5, 0.08, 0.92));   // mid-combo he stays with the rock

    if (usePower) {
      // POWER: shoulder into the defender. Win the strength battle and he drives
      // the man back to the rim; lose it and he's walled off and must reset.
      h.driveSide = d.shadeSide !== 0 ? -d.shadeSide : this.pickSide(h);
      const pPower = clamp(0.53 + powerEdge * 1.25, 0.03, 0.9);   // +0.13 = 守判断重み増のフラット70補償
      if (chance(pPower)) {
        h.powerT = rand(0.55, 0.9) * (1 + Math.max(0, powerEdge) * 0.4);
        d.lean = clamp(d.lean * 0.4, -1, 1);             // knocked off his base
      } else {
        h.stalledT = rand(0.35, 0.6);                    // met the wall
      }
      this.setDriveSide(h);
      return;
    }

    // SPEED: shake the defender with a dribble move, then attack the opening.
    // 敏捷性(quickness) + D精度(dribble control) drive the deception; the defender
    // resists with 守判断(defense) + quickness/反応(burst). The move he uses
    // depends on how the defender is playing him.
    const jukeEdge = this.jukeDeception(h) - this.jukeDiscipline(d);
    const rim = this.attackFloor(h.team);
    const rl = Math.hypot(rim.x - h.pos.x, rim.z - h.pos.z) || 1;
    const ux = (rim.x - h.pos.x) / rl, uz = (rim.z - h.pos.z) / rl;   // toward rim
    const latx = -uz, latz = ux;                                      // lateral

    // fresh attack → plan the rock: a skilled handler strings 1..3 moves. The
    // early shakes are pure 揺さぶり — they only swing the defender's weight —
    // and only the LAST move attacks, bursting past the side he can no longer
    // recover to. A quick defender resets between shakes; a slow one rocks
    // further off balance with every swing.
    if (h.comboN === 0) {
      h.lastFakeDir = 0;
      let plan = 1;
      const pMore = clamp(0.25 + this.jukeDeception(h) * 0.55, 0.1, 0.8);
      if (chance(pMore)) plan++;
      if (plan > 1 && chance(pMore * 0.6)) plan++;
      h.comboN = plan;
    }
    const finalShake = h.comboN <= 1;

    // shake the fronting defender: a jab step-in to freeze him, or a hard
    // side-step to drag him one way and attack back the other. Setup shakes
    // ALTERNATE sides to swing his weight; the FINAL move reads his actual
    // lean — one more sell INTO it, then burst past the side he can't recover to.
    const stepIn = h.lastFakeDir === 0 && finalShake && chance(0.35);
    let fakeDir: number;
    if (finalShake) {
      // the GO side = the defender's lean read WEIGHTED BY THE HAND: a
      // one-handed player (低逆手頻度) stays on his strong side unless the
      // weak-side lane is clearly the better read; an ambidextrous handler
      // just takes whatever the lean gives him
      const strong = h.strongSide();
      const beat = (side: number) => clamp(-d.lean * side, -1, 1);
      // scaled so a ROUTINE shade (lean ≈0.3) doesn't pry a one-handed player
      // off his strong hand — only a clear overplay does
      const handEdge = (h.strongSideBias() - 0.5) * 3.2;   // 0 (both hands) .. ~0.65
      const go = beat(strong) + handEdge >= beat(-strong) ? strong : -strong;
      fakeDir = -go;                       // sell the other way, then attack it
    } else {
      fakeDir = h.lastFakeDir !== 0 ? -h.lastFakeDir : -this.pickSide(h);
    }
    let ox: number, oz: number, leanMag: number;
    if (stepIn) {
      ox = ux * 0.35; oz = uz * 0.35; leanMag = 0.7;               // jab toward the rim
      d.reactT = Math.max(d.reactT, rand(0.15, 0.3) * this.reactionLag(d)); // he hesitates
    } else {
      ox = latx * fakeDir * 0.45; oz = latz * fakeDir * 0.45; leanMag = 1.1; // side-step
    }
    h.jukeT = rand(0.18, 0.3);
    h.jukeTarget.set(h.pos.x + ox, 0, h.pos.z + oz);
    this.clampCourt(h.jukeTarget);

    // does he bite? deception vs discipline sets how far his weight shifts
    const bite = clamp(0.3 + jukeEdge * 1.1, 0.03, 0.95);
    if (chance(bite)) {
      // if his weight is still ACROSS from the previous fake, the swing back
      // overshoots — this is what stacks the lean up on a slow-recovering
      // defender while a quick one is square again before each move lands
      const across = Math.max(0, -d.lean * fakeDir);
      d.lean = clamp(d.lean + fakeDir * (rand(0.5, 1.0) * leanMag + across * 0.8), -1, 1);
      d.leanAxisX = latx; d.leanAxisZ = latz;   // committed on THIS duel's axis
    }

    if (!finalShake) {
      // setup shake only — stay live, the next move comes back the other way
      h.comboN--;
      h.lastFakeDir = fakeDir;
      return;
    }

    // the GO move: attack away from the final fake, at the side his committed
    // weight can't recover to
    h.comboN = 0;
    const go = -fakeDir;
    h.driveSide = go;
    // (base lowered when the GO move learned to read the lean — keeps the
    // overall blow-by rate at the previously tuned level)
    const wrongWay = clamp(-d.lean * go, 0, 1);
    const pBeat = clamp(0.49 + speedEdge * 1.2 + wrongWay * 0.45, 0.02, 0.95);   // +0.11 = 守判断重み増のフラット70補償
    if (chance(pBeat)) {
      // the burst carries ALL THE WAY to the rim — a blow-by that dies at the
      // free-throw line isn't a blow-by. Time is scaled to the ground the
      // handler actually has to cover (≈7.5 m/s burst pace).
      h.beatenT = clamp(rl / 7.5, 0.5, 1.3) * rand(0.95, 1.15)
        * (1 + Math.max(0, speedEdge) * 0.2);
      d.reactT = Math.max(d.reactT, rand(0.3, 0.55) * this.reactionLag(d));
      // momentum carries him further wrong — and with his weight committed the
      // wrong way, the chase back (leanFactor) starts at a crawl
      d.lean = clamp(d.lean + go * 0.3, -1, 1);
      d.leanAxisX = latx; d.leanAxisZ = latz;
    } else {
      h.stalledT = rand(0.3, 0.55);
    }
    this.setDriveSide(h);
  }

  // How well a handler sells a dribble move — quickness + dribble control lead.
  private jukeDeception(h: Player): number {
    return rate(h.attr.agility) * 0.45 + rate(h.attr.dribbleAcc) * 0.4
      + rate(h.attr.handling) * 0.15 + (h.has("driver") ? 0.1 : 0);
  }

  // How well a defender stays in front / doesn't bite — defence + burst.
  private jukeDiscipline(d: Player): number {
    return rate(d.attr.defense) * 0.4 + rate(d.attr.agility) * 0.35
      + rate(d.attr.reaction) * 0.25 + (d.has("manMark") ? 0.1 : 0);
  }

  // STEP-BACK: retreat off the dribble against a defender contesting a shot. If he
  // over-commits forward (bites the shot fake) the handler blows by him off the
  // step; if he stays down, the handler has bought clean separation for a jumper.
  // Baiting the closeout scales with the handler's shot threat + deception; the
  // defender resists with discipline.
  private stepBack(h: Player, d: Player, dHoop: number): void {
    const rim = this.attackFloor(h.team);
    const bx = h.pos.x - rim.x, bz = h.pos.z - rim.z;     // away from the rim
    const bl = Math.hypot(bx, bz) || 1;
    h.jukeT = rand(0.2, 0.32);
    h.jukeTarget.set(h.pos.x + (bx / bl) * 0.7, 0, h.pos.z + (bz / bl) * 0.7);
    this.clampCourt(h.jukeTarget);

    const shotThreat = Math.max(rate(h.attr.threeAcc), rate(h.attr.midAcc));
    const edge = this.jukeDeception(h) - this.jukeDiscipline(d);
    const bait = clamp(0.2 + edge * 0.5 + shotThreat * 0.25, 0.05, 0.82);
    if (chance(bait)) {
      // he lunged forward → attack past him off the step-back (burst carries
      // to the rim, like any blow-by)
      h.beatenT = clamp(dHoop / 7.5, 0.5, 1.3) * rand(0.95, 1.15)
        * (1 + Math.max(0, edge) * 0.2);
      d.reactT = Math.max(d.reactT, rand(0.35, 0.6) * this.reactionLag(d));
      d.lean = clamp(d.lean * 0.5, -1, 1);
      h.driveSide = this.pickSide(h);
      this.setDriveSide(h);                              // the burst goes at the rim
    } else {
      // stayed down → the step-back bought a cushion; hold it for the jumper and
      // let the next decision fire the (now open) look
      d.reactT = Math.max(d.reactT, rand(0.3, 0.5) * this.reactionLag(d));
      h.driveTarget.copyFrom(h.jukeTarget);
    }
  }

  // Aim the drive toward the rim, curving to the chosen side; on a blow-by go
  // straight in for the finish.
  private setDriveSide(h: Player): void {
    const rim = this.attackFloor(h.team);
    const dx = rim.x - h.pos.x, dz = rim.z - h.pos.z;
    const len = Math.hypot(dx, dz) || 1;
    const ux = dx / len, uz = dz / len;
    const lx = -uz * h.driveSide, lz = ux * h.driveSide; // lateral toward the attack side
    // a blow-by or a bull drive goes straight in; an unresolved probe curves wide
    const off = (h.beatenT > 0 || h.powerT > 0) ? 0.2 : 1.6;
    h.driveTarget.set(rim.x + lx * off, 0, rim.z + lz * off);
  }

  // A defender within ~1.2 m ahead and squarely in the drive path; their body
  // contact is what slows the ball-handler down.
  private driveImpeder(h: Player): Player | null {
    const tx = h.driveTarget.x - h.pos.x, tz = h.driveTarget.z - h.pos.z;
    const len = Math.hypot(tx, tz) || 1;
    const ux = tx / len, uz = tz / len;
    for (const d of this.teamPlayers(1 - h.team)) {
      const rx = d.pos.x - h.pos.x, rz = d.pos.z - h.pos.z;
      const along = rx * ux + rz * uz;       // how far ahead along the drive
      if (along < 0 || along > 1.2) continue;
      const perp = Math.abs(rx * -uz + rz * ux);
      if (perp < 0.7) return d;
    }
    return null;
  }

  // Aim the handler at a point `standoff` metres out from the rim along the
  // line rim->handler (so they drive toward the basket but stop short).
  // STEER AROUND a body standing in the straight path to (tx,tz): when the
  // first few metres of the corridor ahead hold another player, aim at a
  // side-step point beside him instead of ploughing into the contact and
  // letting the collision push sort it out. Deliberate-contact moves (a post
  // grind, a screen, the on-ball duel) never call this. `opponentsOnly` leaves
  // brushing past a team-mate (screens, hand-offs) untouched.
  private steerAround(p: Player, tx: number, tz: number, opponentsOnly = false): { x: number; z: number } {
    const dx = tx - p.pos.x, dz = tz - p.pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 1.0) return { x: tx, z: tz };       // arriving — no room to swerve
    const ux = dx / dist, uz = dz / dist;
    let bestT = Infinity, ob: Player | null = null, obLat = 0;
    for (const q of this.players) {
      if (q === p) continue;
      if (opponentsOnly && q.team === p.team) continue;
      const rx = q.pos.x - p.pos.x, rz = q.pos.z - p.pos.z;
      const t = rx * ux + rz * uz;                 // how far ahead along the path
      if (t < 0.3 || t > Math.min(dist - 0.4, 3.2)) continue;
      const lat = -rx * uz + rz * ux;              // signed offset from the path
      if (Math.abs(lat) > 0.7) continue;           // not actually in the corridor
      if (t < bestT) { bestT = t; ob = q; obLat = lat; }
    }
    if (!ob) return { x: tx, z: tz };
    // pass on the side the blocker is NOT already shading toward (deterministic
    // tie-break so the swerve doesn't flicker frame to frame)
    const side = obLat > 0.05 ? -1 : obLat < -0.05 ? 1 : (p.idx % 2 ? 1 : -1);
    const sx = ob.pos.x - uz * side, sz = ob.pos.z + ux * side;
    // the DODGED DEFENDER answers: for a beat he slides across to wall off the
    // mouth of the NEW lane (runDefense executes the slide) — a step battle the
    // quicker man wins, since both moves run through accelToward/plant
    if (this.ballMode === "held" && ob.team !== p.team && ob.team !== this.possession) {
      ob.wallT = Math.max(ob.wallT, 0.25);
      ob.wallX = sx;
      ob.wallZ = sz;
    }
    return { x: sx, z: sz };
  }

  private setDrive(h: Player, rimFloor: Vector3, standoff: number): void {
    const dx = h.pos.x - rimFloor.x, dz = h.pos.z - rimFloor.z;
    const len = Math.hypot(dx, dz) || 1;
    h.driveTarget.set(
      rimFloor.x + (dx / len) * standoff,
      0,
      rimFloor.z + (dz / len) * standoff,
    );
  }

  private runDefense(dt: number): void {
    const defTeam = 1 - this.possession;
    const protect = this.attackFloor(this.possession); // basket the defence guards
    const defenders = this.teamPlayers(defTeam);
    const offense = this.teamPlayers(this.possession);

    // commit to a defensive look once per possession
    if (this.possession !== this.schemePoss) { this.schemePoss = this.possession; this.pickDefScheme(); }

    // full-court press: trap the bring-up in the backcourt before the offence
    // gets it into its set. Ends the moment the ball is established up front.
    this.pressTrapper = null;   // (re)set each tick — only a live press assigns one
    if (this.pressOn && !this.frontT && this.handler) { this.runPress(dt); return; }

    // a half-court zone is a different animal — no man-matching, no pick-and-roll
    // switching; defenders guard AREAS and the ball
    if (this.zoneScheme) { this.runZoneDefense(dt); return; }

    // pick-and-roll coverage window: while it is live the two involved defenders
    // move by the chosen scheme (drop / show / switch) instead of plain man
    if (this.pnrT > 0) {
      this.pnrT -= dt;
      if (this.pnrT <= 0) this.pnrCov = "";
    }

    // ONE rim protector at a time: when the handler beats his man and drives, the
    // LOW MAN — the defender best placed between the ball and the rim — rotates
    // over to wall it off; the rest stay pinned to their men (all collapsing at
    // once made every drive hit a 3-5 man wall). A big is preferred (real rim
    // protection, the −1.2 m credit), but if only a GUARD is back he steps up
    // rather than nobody helping — a beaten drive to an otherwise-undefended rim
    // must still be met by whoever is the last line, not conceded a free layup.
    let rimHelper: Player | null = null;
    if (this.handler && (this.handler.beatenT > 0 || this.handler.powerT > 0)) {
      let best = Infinity;
      for (const d of defenders) {
        if (offense[d.slot] === this.handler) continue;   // not the beaten on-ball man
        // the LOW MAN = the non-on-ball defender closest to the basket rotates,
        // any position. Even if he's out guarding his own man he sprints back to
        // wall the rim rather than conceding a free layup — being "the last line"
        // beats staying glued to a spot-up man. A big is preferred (−1.2 m credit).
        const score = dist2D(d.pos, protect) - (this.isBig(d) ? 1.2 : 0);
        if (score < best) { best = score; rimHelper = d; }
      }
    }


    for (const d of defenders) {
      const man = offense[d.slot]; // man-to-man by matching index
      const isOnBall = man === this.handler;
      // off the ball any lingering lean (from a duel that just ended, a switch,
      // a kick-out) eases back to square at the player's quickness
      if (!isOnBall) d.decayLean(dt);

      // pick-and-roll: the screen's two defenders play the coverage scheme
      if (this.pnrCov && (d === this.pnrScreenerDef || d === this.pnrHandlerDef)) {
        this.defendScreenCoverage(dt, d, protect);
        continue;
      }

      if (isOnBall) {
        this.defendOnBall(dt, d, man, protect);
        // reach in for a steal from the cushion — sharper reactions and reads get
        // more, a secure dribble (D精度) protects the ball, and an aggressive
        // game plan gambles (and fouls) more
        const press = this.tactics[defTeam].defense.pressure * this.twWeight(d);
        const gap = dist2D(d.pos, man.pos);
        if (gap < 1.5) {
          const close = 1 - gap / 1.5;                 // 1 at point-blank, 0 at 1.5 m
          const stl = rate(d.attr.reaction) * 0.45 + rate(d.attr.agility) * 0.35
            + rate(d.attr.defense) * 0.2;
          // ドリブルキープ shields the ball; スライディング strips it more often
          const resist = rate(man.attr.dribbleAcc) * 0.6 + rate(man.attr.handling) * 0.4
            + (man.has("keepDribble") ? 0.25 : 0);
          const slide = d.has("interceptor") ? 1.3 : 1;
          // CROSSOVER REACH-IN: the ball is exposed mid-dribble-move, so quick
          // hands (敏捷性/反応) poke it during a juke — BUT a skilled, quick
          // ball-handler (D精度/技術/敏捷性) keeps it on a string, so the poke
          // only bites when the defender's quickness OUT-strips the handler's
          // security. (Without this, high 敏捷性 backfired: agile players juke
          // more and were punished for it — see attr-impact tuning.)
          const secure = rate(man.attr.dribbleAcc) * 0.5 + rate(man.attr.handling) * 0.3
            + rate(man.attr.agility) * 0.2;
          const exposed = man.jukeT > 0
            ? 1 + Math.max(0, rate(d.attr.agility) * 0.6 + rate(d.attr.reaction) * 0.4 - secure) * 2.2 : 1;
          const pPoke = Math.max(0.005, (0.03 + stl * 0.1 - resist * 0.06 + press * 0.05) * slide * exposed);
          // CARRY position: a ball shown out front is there to be poked, one
          // tucked on the far hip is out of reach (compare the defender's
          // distance to the BALL vs to the man)
          const dBall = dist2DTo(d.pos, this.ball.pos.x, this.ball.pos.z);
          // a baited (deliberately shown) ball draws the poke hardest of all —
          // that's the whole point of showing it
          const carryMod = clamp(1 + (gap - dBall) * 1.2, 0.55, 1.6)
            * (man.baitT > 0 ? 1.6 : 1);
          if (chance(pPoke * close * carryMod * dt)) {
            if (man.baitT > 0 && chance(0.35 + rate(man.attr.dribbleAcc) * 0.45)) {
              // 誘い成立: the shown ball is yanked away, the lunging defender's
              // weight is committed — the handler bursts past the reach
              man.baitT = 0;
              const bx = this.ball.pos.x - d.pos.x, bz = this.ball.pos.z - d.pos.z;
              const bl = Math.hypot(bx, bz) || 1;
              d.leanAxisX = bx / bl;
              d.leanAxisZ = bz / bl;
              d.lean = 0.9;
              d.reactT = Math.max(d.reactT, 0.35);
              man.beatenT = Math.max(man.beatenT, 0.2 + rate(man.attr.agility) * 0.15);
            } else {
              this.steal(d);
              return;
            }
          }
          if (chance((0.02 + press * 0.045) * close * dt)) { this.defensiveFoul(man, d); return; }
        }
        continue;
      }

      // カバーリング: when the man guarding the ball is beaten, a cover defender
      // abandons his man and slides into the drive lane to pick the handler up
      if (this.handler && this.handler.beatenT > 0 && d.has("covering")) {
        const hx = this.handler.pos.x, hz = this.handler.pos.z;
        const t = 0.55;   // meet him partway down the lane to the basket
        const ctx = hx + (protect.x - hx) * t, ctz = hz + (protect.z - hz) * t;
        // rim-bound help is goal defence — even a coasting star gives ~90%
        moveToward2D(d.pos, ctx, ctz,
          d.accelToward(dt, ctx, ctz, 1.12 * Math.max(this.defEffort(d, protect), 0.9)) * dt);
        this.clampCourt(d.pos);
        continue;
      }

      // RIM PROTECTION: when the ball-handler has beaten his man and is bearing
      // down on the basket, an off-ball big abandons his man and drops between the
      // ball and the rim to wall it off — this is what puts a tall shot-blocker in
      // position to actually challenge (and swat) the finish.
      if (this.handler && d === rimHelper) {
        const hx = this.handler.pos.x, hz = this.handler.pos.z;
        const dRim = dist2DTo(this.handler.pos, protect.x, protect.z);
        // the rim protector TIMES his leap against the incoming finisher — go
        // up early and the dunk meets hands at their peak (tryBlock's airborne
        // bonus); mistime it and he is landing (landT) as the finish releases,
        // barely able to contest at all (tryBlock's landT penalty)
        if (!d.airborne && d.landT <= 0 && dRim < 4.5
            && dist2D(d.pos, this.handler.pos) < 2.6) {
          const timing = rate(d.attr.reaction) * 0.5 + rate(d.attr.defense) * 0.3;
          if (chance((0.35 + timing * 0.9) * dt * 3)) {
            d.jump(0.55 + rate(d.attr.jump) * 0.3, 0.6);
          }
        }
        if (dRim < 8) {
          const dx = hx - protect.x, dz = hz - protect.z;
          const len = Math.hypot(dx, dz) || 1;
          // meet the driver a couple of metres off the rim, right in his path
          const rtx = protect.x + (dx / len) * 2.0, rtz = protect.z + (dz / len) * 2.0;
          // protecting the rim is goal defence — minimum ~90% from anyone
          moveToward2D(d.pos, rtx, rtz,
            d.accelToward(dt, rtx, rtz, 1.1 * Math.max(this.defEffort(d, protect), 0.9)) * dt);
          this.clampCourt(d.pos);
          continue;
        }
      }

      // 通路ブロック: an attacker just side-stepped around this defender — answer
      // by sliding across into the mouth of the new lane. His own quickness
      // (accelToward → turnFactor / 動き直し) decides whether the step lands.
      if (d.wallT > 0) {
        moveToward2D(d.pos, d.wallX, d.wallZ,
          d.accelToward(dt, d.wallX, d.wallZ, 1.05 * Math.max(this.defEffort(d, protect), 0.85)) * dt);
        this.clampCourt(d.pos);
        continue;
      }

      // transition: caught up-court when possession flipped — get back FIRST
      if (this.getBackOnDefense(dt, d, man)) continue;

      // off-ball: sag toward the basket to help — more for high-help game plans,
      // followed faithfully only by players who buy into the scheme (連携), and
      // organised a step deeper by a DFライン general
      const help = this.tactics[defTeam].defense.help * this.twWeight(d);
      // DENY late in the clock: pull OFF the help-sag and crowd the man to deny
      // him the ball (fewer open outlets → the offence can't get a look off before
      // the clock dies). The lost help is part of the deny's risk.
      const sag = (1.2 + help * 1.4) * (this.teamHas(defTeam, "dfLine") ? 1.15 : 1)
        * (1 - this.denyIntensity(defTeam) * 0.8);
      const dx = protect.x - man.pos.x, dz = protect.z - man.pos.z;
      const len = Math.hypot(dx, dz) || 1;
      let stx = man.pos.x + (dx / len) * sag, stz = man.pos.z + (dz / len) * sag;
      // PATH DENIAL: a man on the MOVE (a cutter, a runner bending around
      // traffic) is shadowed where he is GOING, not where he was — the defender
      // steps into the corridor AHEAD of the run (still goal-side via the sag),
      // so a side-step around one body meets the marker already sliding across
      // to wall the new lane. How far ahead he reads scales with 反応/守判断;
      // the lead is capped so nobody teleports in front of a sprinter.
      const mSpd = Math.hypot(man.velX, man.velZ);
      if (mSpd > 2.5) {
        const read = 0.15 + rate(d.attr.reaction) * 0.22 + rate(d.attr.defense) * 0.10;
        const cap = Math.min(1, 2.0 / (mSpd * read || 1));   // lead at most ~2 m ahead
        stx += man.velX * read * cap;
        stz += man.velZ * read * cap;
      }
      // off-ball shadowing runs at the defender's effort — a star jogs it
      moveToward2D(d.pos, stx, stz, d.accelToward(dt, stx, stz, this.defEffort(d, protect)) * dt);
      this.clampCourt(d.pos);
    }
  }

  // How hard this defender is working RIGHT NOW. Offensive stars (high
  // オフェンス優先度) coast on defence to save their legs — they don't chase
  // and pressure far from the basket; that dirty work belongs to the role
  // players / 3&D men (low priority), who always give 100%. Everyone locks
  // back in near his own goal (~90% even for the most ball-dominant star)
  // and in crunch time (Q4, close game).
  private defEffort(d: Player, protect: Vector3): number {
    // crunch time: everyone locks back in regardless of role
    if (this.quarter >= 4 && Math.abs(this.score[0] - this.score[1]) <= 6) return 1;
    if (d.lockDef) return 1;                                  // 常時全力ロール
    const nearGoal = clamp(1 - dist2D(d.pos, protect) / 9, 0, 1); // 1 at the rim
    // DEFENSE-ROLE gear (preferred): the role sets his defensive output — 省エネ
    // saves his legs (lower speed → less fatigue), ツーウェイ/バランス give more.
    // This is how a two-way star keeps full effort while a scorer conserves —
    // controlled by the DEF role, NOT auto-tied to his offensive usage.
    if (d.defEffortGear !== undefined) {
      return clamp(d.defEffortGear + (1 - d.defEffortGear) * nearGoal, 0, 1);
    }
    // legacy fallback (no defRole set): offensive stars auto-coast a little
    if (d.evalRole === "ロックダウン" || d.evalRole === "スイッチディフェンダー"
      || d.evalRole === "エナジーガイ" || d.evalRole === "3&D") return 1;
    const star = clamp((d.offPriority - 0.45) / 0.4, 0, 1);  // 0 role .. 1 star
    if (star <= 0) return 1;
    const e = 0.68 + (0.9 - 0.68) * nearGoal;   // cruising 0.68 .. 0.9 at the goal
    return 1 - star * (1 - e);
  }

  // On-ball defence: shade toward the side the handler is attacking (with a
  // reaction lag), stay goal-side to cut off the drive, and chase to recover
  // when beaten off the dribble.
  // How hard a defence is DENYING the shot right now: its `deny` tactic, ramped
  // up only late in the shot clock (when running the clock out is worth the
  // gamble). 0 early in the clock, → deny value as it nears expiry.
  private denyIntensity(defTeam: number): number {
    // Every defence tightens a LITTLE as the clock dies, but only a real deny
    // TACTIC actually smothers the shot. A small universal floor (0.12) keeps the
    // late-clock crowding without forcing a shot-clock violation every possession
    // — the 0.28 floor made ordinary defences smother everyone and spammed
    // violations (offences couldn't get an open look off in time).
    const t = Math.max(this.tactics[defTeam].defense.deny, 0.12);
    if (!this.frontT) return 0;
    const late = this.shotClock < 4.5 ? (4.5 - this.shotClock) / 4.5 : 0;
    return t * late;
  }

  // A hard deny has the handler SMOTHERED — he can't get a clean look off. He
  // must beat it off the dribble (the deny's risk) or move it; if neither, the
  // clock runs out (a shot-clock violation — the deny's payoff). Returns true
  // when he's too smothered to just settle for a jumper.
  private denySmother(h: Player, dDef: number): boolean {
    return this.denyIntensity(1 - h.team) > 0.18 && dDef < 1.0;
  }

  private defendOnBall(dt: number, d: Player, man: Player, protect: Vector3): void {
    const effort = this.defEffort(d, protect);
    // a star doesn't press the ball in the BACKCOURT — hounding the bring-up is
    // the role players' / 3&D men's job. He drops off and waits just inside his
    // own half, on the ball's line to the basket, picking up on the catch there.
    const s0 = this.attackSign(this.possession);
    if (effort < 0.9 && man.pos.z * s0 < 0.3) {
      const wx = man.pos.x * 0.6, wz = s0 * 1.5;
      moveToward2D(d.pos, wx, wz, d.accelToward(dt, wx, wz, 0.9 * effort) * dt);
      this.clampCourt(d.pos);
      return;
    }
    // catch the shade up to the handler's drive side once the reaction lag ends
    // (a DFライン general on the floor talks everyone through it faster)
    if (d.reactT > 0) d.reactT -= dt * (this.teamHas(d.team, "dfLine") ? 1.3 : 1);
    else d.shadeSide = man.driveSide;

    // balance: ease the weight back toward a slight shade. クイックネス(敏捷性)
    // rules how fast the centre of gravity comes back over the feet — a quick
    // defender resets between the handler's moves, a heavy-footed one is still
    // leaning when the next shake comes and the lean stacks up
    const targetLean = clamp(d.shadeSide * 0.3, -0.3, 0.3);
    const recover = (d.leanRecoverRate() + rate(d.attr.reaction) * 0.15) * dt;
    d.lean += clamp(targetLean - d.lean, -recover, recover);

    const dx = protect.x - man.pos.x, dz = protect.z - man.pos.z;
    const len = Math.hypot(dx, dz) || 1;
    const ux = dx / len, uz = dz / len;        // handler -> basket
    // the lean lives on the lateral axis of this duel — keep the world-space
    // axis current so movement (leanFactor) feels the committed weight
    d.leanAxisX = -uz; d.leanAxisZ = ux;

    // Keep an appropriate cushion rather than smothering the ball-handler — but
    // body up tight on a big posting up / pushing near the rim, to contest the
    // push. Aggressive game plans — and a マンマーク specialist — close the gap.
    const postUp = (this.isBig(man) || man.has("post")) && dist2D(man.pos, protect) < 5.5;
    // 密着限界: how close he DARES to press is his ディフェンス能力 vs the man's
    // オフェンス能力 — outmatched (diff −) he gives ground so he isn't just blown
    // by, superior (diff +) he crawls right up — and the DEEPER the ball (nearer
    // the defended goal) the tighter every defender bodies up regardless: layup
    // range is never conceded, while way out high a mismatch shows as a big sag.
    const diff = clamp(rate(d.attr.defense) - rate(man.attr.offense), -0.5, 0.5);
    const depth = clamp((dist2D(man.pos, protect) - 3) / 6, 0, 1);  // 0 at the rim .. 1 beyond ~9 m
    let gap = postUp
      ? 0.45 - this.tactics[d.team].defense.pressure * 0.1   // ~0.35 (tight) on the post
      : (1.25 - this.tactics[d.team].defense.pressure * 0.35 - diff * 0.7)
        * (0.45 + 0.55 * depth);   // ability gap sets the standoff, depth squeezes it
    if (d.has("manMark")) gap *= 0.85;
    if (d.evalRole === "ロックダウン") gap *= 0.85;   // the stopper crawls into his shirt
    gap = clamp(gap, 0.3, 2.1);
    // DENY (late shot clock): crawl in to smother the look and run the clock out.
    // The RISK: overplaying is beatable — a live handler blows past for a rim
    // finish (the price of gambling for a shot-clock violation).
    const dny = this.denyIntensity(d.team);
    if (dny > 0) {
      gap = Math.max(0.32, gap - dny * 0.7);
      if (man.beatenT <= 0 && man.powerT <= 0 && man.jukeT <= 0) {
        const edge = rate(man.attr.handling) * 0.5 + rate(man.attr.agility) * 0.4
          - rate(d.attr.agility) * 0.35 - rate(d.attr.defense) * 0.25;
        if (chance(clamp(dny * (0.55 + edge), 0, 0.7) * dt * 3)) {
          man.driveSide = this.pickSide(man);
          man.beatenT = rand(0.5, 0.85);
          d.reactT = Math.max(d.reactT, rand(0.3, 0.55) * this.reactionLag(d));
          this.setDriveSide(man);
        }
      }
    }

    // EARLY-CONTEST GAMBLE: against a shooter sizing up in range, an
    // aggressive defender may leave his feet FIRST. If the shot goes up now
    // it meets a huge contest (tryBlock/foul honour the airborne man) — but
    // if the handler puts it on the floor instead, the floater is walked past
    // (decide() exploits an airborne on-ball defender).
    if (!d.airborne && d.landT <= 0
        && man.beatenT <= 0 && man.powerT <= 0 && man.jukeT <= 0
        && dist2D(d.pos, man.pos) < 1.7
        && dist2D(man.pos, protect) <= this.effShootRange(man) + 0.3) {
      const threat = Math.max(rate(man.attr.threeAcc), rate(man.attr.midAcc));
      const gamble = (0.015 + rate(d.attr.aggression) * 0.045
        + this.tactics[d.team].defense.pressure * 0.02) * threat;
      if (chance(gamble * dt * 6)) {
        d.jump(0.55 + rate(d.attr.jump) * 0.3, 0.62);
      }
    }

    let tx: number, tz: number;
    if (man.beatenT > 0) {
      // beaten: sprint to CUT HIM OFF — race for a point on the drive between
      // the handler and the basket, not straight at his body (which just set up
      // a head-on plug that stopped the blow-by dead)
      tx = man.pos.x + (protect.x - man.pos.x) * 0.45;
      tz = man.pos.z + (protect.z - man.pos.z) * 0.45;
    } else {
      // goal-side, and actively slide to cut off the side being attacked. Quick,
      // sharp-reacting defenders (敏捷性/反応) get across to wall off the drive
      // and keep the handler in front; a wrong-footed lean drags them the other
      // way and opens the lane. This is what makes a good on-ball defender bite.
      const lx = -uz, lz = ux;
      const mirror = 0.28 + rate(d.attr.agility) * 0.8 + rate(d.attr.reaction) * 0.22
        + (d.evalRole === "ロックダウン" ? 0.2 : 0);   // the stopper stays glued in front
      const cut = clamp(d.shadeSide * mirror + d.lean * 0.45, -1.1, 1.1) * 0.6;
      tx = man.pos.x + ux * gap + lx * cut;
      tz = man.pos.z + uz * gap + lz * cut;
    }
    // a coasting star moves at his effort level — but the formula floors his
    // effort toward 0.9 as the play closes on his own goal
    const mult = (man.beatenT > 0 ? 1.06 + rate(d.attr.agility) * 0.12 : 1.05) * effort;
    moveToward2D(d.pos, tx, tz, d.accelToward(dt, tx, tz, mult) * dt);
    this.clampCourt(d.pos);
  }

  // ---- half-court zone defence (2-3 / 3-2) ------------------------------
  // Zone home spots for each defender, before the ball-side shift: the guards
  // (low slots) man the top row, the bigs man the back row across the paint.
  // 2-3 keeps three across the baseline (paint locked, arc soft); 3-2 puts
  // three up on the perimeter (arc guarded, low blocks softer).
  private zoneHomes(defTeam: number, s: number): Map<Player, { x: number; z: number }> {
    const ds = this.teamPlayers(defTeam);
    const rimZ = s * RIM.z;
    const dir = -s;                              // toward mid-court
    const topN = this.zoneScheme === "3-2" ? 3 : 2;
    const order = [...ds].sort((a, b) => a.slot - b.slot);  // guards first
    const top = order.slice(0, topN);
    const back = order.slice(topN);
    const topXs = topN === 3 ? [-4.4, 0, 4.4] : [-2.9, 2.9];
    const backXs = back.length === 3 ? [-3.5, 0, 3.5] : [-2.9, 2.9];
    const topDepth = 6.9;
    const m = new Map<Player, { x: number; z: number }>();
    // keep left-to-right order stable so defenders don't cross over each other
    top.sort((a, b) => a.pos.x - b.pos.x).forEach((d, i) =>
      m.set(d, { x: topXs[i], z: rimZ + dir * topDepth }));
    back.sort((a, b) => a.pos.x - b.pos.x).forEach((d, i) => {
      const mid = back.length === 3 && i === 1;   // the middle back man sits on the rim
      m.set(d, { x: backXs[i], z: rimZ + dir * (mid ? 1.1 : 2.1) });
    });
    return m;
  }

  private runZoneDefense(dt: number): void {
    const defTeam = 1 - this.possession;
    const s = this.attackSign(this.possession);
    const rim = this.attackFloor(this.possession);
    const defenders = this.teamPlayers(defTeam);
    const offense = this.teamPlayers(this.possession);
    const h = this.handler;
    const b = this.ball.pos;
    const homes = this.zoneHomes(defTeam, s);
    const shiftX = clamp(b.x * 0.4, -2.8, 2.8);        // the whole zone slides ball-side

    // the defender whose area the ball sits in steps up to pressure it
    let ballDef: Player | null = null;
    if (h) {
      let best = Infinity;
      for (const d of defenders) {
        const dd = dist2D(d.pos, h.pos);
        if (dd < best) { best = dd; ballDef = d; }
      }
    }

    for (const d of defenders) {
      if (this.getBackOnDefense(dt, d, offense[d.slot])) continue;   // transition first
      d.decayLean(dt);

      if (d === ballDef && h) {
        // pressure the ball inside the zone (a soft man-up), and poke from the top
        this.defendOnBall(dt, d, h, rim);
        const gap = dist2D(d.pos, h.pos);
        if (gap < 1.4) {
          const close = 1 - gap / 1.4;
          const stl = rate(d.attr.reaction) * 0.4 + rate(d.attr.agility) * 0.3 + rate(d.attr.defense) * 0.3;
          const resist = rate(h.attr.dribbleAcc) * 0.6 + rate(h.attr.handling) * 0.4;
          if (chance(Math.max(0.004, 0.025 + stl * 0.08 - resist * 0.06) * close * dt)) { this.steal(d); return; }
        }
        continue;
      }

      const home = homes.get(d)!;
      let tx = home.x + shiftX, tz = home.z;
      // MATCH-UP flavour: an offensive player sitting in this defender's area gets
      // picked up (bumped) — but the back-line bigs never chase out past the arc,
      // which is exactly what leaves a perimeter shooter open (the zone's price)
      const reach = this.isBig(d) ? 3.0 : 3.8;
      let claim: Player | null = null;
      let bestD = reach;
      for (const o of offense) {
        if (o === h) continue;
        const dd = Math.hypot(o.pos.x - (home.x + shiftX), o.pos.z - home.z);
        if (dd < bestD) { bestD = dd; claim = o; }
      }
      if (claim) {
        // close out toward the man in the area, but hold zone depth (don't vacate
        // the paint to fly at a non-threat)
        tx = claim.pos.x * 0.6 + (home.x + shiftX) * 0.4;
        tz = claim.pos.z * 0.45 + home.z * 0.55;
      }
      // help the rim when the ball is driving into the paint
      if (h && (h.beatenT > 0 || h.powerT > 0) && this.isBig(d) && dist2D(h.pos, rim) < 6) {
        tx = (tx + rim.x) / 2; tz = (tz + rim.z) / 2;
      }
      const effort = this.defEffort(d, rim);
      moveToward2D(d.pos, tx, tz, d.accelToward(dt, tx, tz, effort) * dt);
      this.clampCourt(d.pos);
    }
  }

  // ---- full-court press / trap ------------------------------------------
  // A pressing team hounds the bring-up: the ball-handler's man harasses him,
  // a second man races over to TRAP (double), the rest deny the outlet passes,
  // and one safety hangs back to stop the layup if the ball is thrown over the
  // top. High turnover reward, high risk if it's split — the classic gamble.
  private runPress(dt: number): void {
    const defTeam = 1 - this.possession;
    const defenders = this.teamPlayers(defTeam);
    const offense = this.teamPlayers(this.possession);
    const h = this.handler!;
    const protect = this.attackFloor(this.possession);   // rim the defence guards
    // primary on-ball harasser = the handler's own man
    const primary = this.onBallDefender(h) ?? defenders[0];
    // trapper = the nearest OTHER defender; safety = the one deepest back (nearest
    // to the defended rim); the remaining two deny their men's outlet lanes
    const others = defenders.filter((d) => d !== primary);
    let trapper = others[0], tBest = Infinity;
    for (const d of others) { const dd = dist2D(d.pos, h.pos); if (dd < tBest) { tBest = dd; trapper = d; } }
    const rest = others.filter((d) => d !== trapper);
    // safety = the rest-man closest to our own rim (the last line of defence)
    const safety = rest.reduce((a, b) => (dist2D(a.pos, protect) <= dist2D(b.pos, protect) ? a : b));
    const deny = rest.filter((d) => d !== safety);

    // handler → rim direction, and the lateral axis to sandwich him
    const dx = protect.x - h.pos.x, dz = protect.z - h.pos.z;
    const len = Math.hypot(dx, dz) || 1;
    const ux = dx / len, uz = dz / len;          // toward the rim (down-court)
    const lx = -uz, lz = ux;                     // sideways

    // PRIMARY: body up ball-side, turn him / cut off the middle (full effort — no
    // backing off in the backcourt during a press)
    {
      const side = h.pos.x >= 0 ? 1 : -1;        // push him toward the near sideline
      const tx = h.pos.x + ux * 0.55 - lx * 0.5 * side;
      const tz = h.pos.z + uz * 0.55 - lz * 0.5 * side;
      moveToward2D(primary.pos, tx, tz, primary.accelToward(dt, tx, tz, 1.1) * dt);
      this.clampCourt(primary.pos);
    }
    // TRAPPER: closes the pincer from the OTHER side, but does NOT add a second
    // shoving body — only the primary bodies the handler. He holds an arm's-length
    // standoff walling the escape route and hunts the BALL from there (the dig
    // pose is in poseHands, the rip itself in the trapped roll below), so the
    // second man reads as a steal threat, not as another bulldozer pinning the
    // handler into the corner until the clock dies.
    {
      const side = h.pos.x >= 0 ? 1 : -1;
      const tx = h.pos.x + ux * 0.35 + lx * 1.0 * side;
      const tz = h.pos.z + uz * 0.35 + lz * 1.0 * side;
      moveToward2D(trapper.pos, tx, tz, trapper.accelToward(dt, tx, tz, 1.15) * dt);
      this.clampCourt(trapper.pos);
      this.pressTrapper = trapper;
    }
    // DENY: stand in the passing lane between the ball and your man (ball-side),
    // so a pass out of the trap has to go through you
    for (const d of deny) {
      const man = offense[d.slot];
      const tx = man.pos.x * 0.55 + h.pos.x * 0.45 + (h.pos.x - man.pos.x) * 0.05;
      const tz = man.pos.z * 0.55 + h.pos.z * 0.45;
      moveToward2D(d.pos, tx, tz, d.accelToward(dt, tx, tz, 1.05) * dt);
      d.decayLean(dt);
      this.clampCourt(d.pos);
    }
    // SAFETY: retreat toward our rim, centred, to stop the layup over the top
    {
      const tx = 0, tz = protect.z - Math.sign(protect.z || 1) * 6;
      moveToward2D(safety.pos, tx, tz, safety.accelToward(dt, tx, tz, 1.0) * dt);
      this.clampCourt(safety.pos);
    }

    // the TRAP forces the ball out: with both trappers draped on him, quick hands
    // (反応/敏捷性) rip it or force the wild pass. A secure handler (技術/D精度)
    // and a キープ specialist splits it more often.
    const trapped = dist2D(primary.pos, h.pos) < 1.6 && dist2D(trapper.pos, h.pos) < 1.9;
    if (trapped) {
      const hands = rate(primary.attr.reaction) * 0.25 + rate(primary.attr.agility) * 0.2
        + rate(trapper.attr.reaction) * 0.25 + rate(trapper.attr.agility) * 0.2;
      const secure = rate(h.attr.dribbleAcc) * 0.5 + rate(h.attr.handling) * 0.4
        + (h.has("keepDribble") ? 0.2 : 0);
      const p = Math.max(0.01, 0.06 + hands * 0.12 - secure * 0.14);
      // the TRAPPER takes it — he's the one hunting the ball with free hands
      // (the primary is busy bodying the handler, division of labour)
      if (chance(p * dt * 6)) { this.steal(trapper); return; }
    }
  }

  // TRANSITION — GET BACK FIRST: when possession flips, a defender caught
  // up-court (he was crashing the glass or posting up a moment ago) sprints
  // home before worrying about his man. Bigs give the rim absolute priority —
  // a C (and, a step higher, a PF) whose man is still trailing the play runs
  // straight back and holds the paint, so the goal is never left open behind
  // a fast break. Returns true when it handled this frame's movement.
  private getBackOnDefense(dt: number, d: Player, man: Player): boolean {
    const s = this.attackSign(this.possession);  // defence's own half: z*s > 0
    const upCourt = d.pos.z * s < 0.5;           // he hasn't crossed halfway yet
    const manBack = man.pos.z * s < 0.5;         // ...and neither has his man
    if (this.isBig(d) && (upCourt || manBack)) {
      // the C parks right under the goal; a PF holds a step higher up the lane
      const depth = d.role === "C" ? 1.6 : 3.0;
      const tz = s * (RIM.z - depth);
      const gb = this.steerAround(d, 0, tz);   // sprint home AROUND bodies, not through
      moveToward2D(d.pos, gb.x, gb.z, d.accelToward(dt, gb.x, gb.z, 1.15) * dt);
      this.clampCourt(d.pos);
      return true;
    }
    if (upCourt && manBack) {
      // he and his man are BOTH still up-court: sprint goal-side (top of the
      // key, shaded toward his man's lane) instead of jogging beside a trailer
      // while the ball attacks an open basket
      const gb = this.steerAround(d, man.pos.x * 0.4, s * (RIM.z - 7));
      moveToward2D(d.pos, gb.x, gb.z, d.accelToward(dt, gb.x, gb.z, 1.12) * dt);
      this.clampCourt(d.pos);
      return true;
    }
    return false;
  }

  // Bodies can't overlap: push any two players who collide apart, splitting the
  // correction by "hold" weight so it reads as jostling for position rather than
  // one player phasing through another. Run after all movement each frame.
  private resolveCollisions(): void {
    const MIN = 0.62; // ~2x capsule radius
    for (let iter = 0; iter < 2; iter++) {
      for (let i = 0; i < this.players.length; i++) {
        for (let j = i + 1; j < this.players.length; j++) {
          const a = this.players[i], b = this.players[j];
          let dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z;
          let d = Math.hypot(dx, dz);
          if (d >= MIN) continue;
          if (d < 1e-4) { dx = rand(-1, 1); dz = rand(-1, 1); d = Math.hypot(dx, dz) || 1; }
          const overlap = MIN - d;
          const nx = dx / d, nz = dz / d;
          const wa = this.holdWeight(a), wb = this.holdWeight(b);
          // square the hold weights so a real strength gap shows: the stronger
          // man barely gives ground while the weaker one is shoved back (and a
          // strong post player bulls a weak defender backwards)
          const wa2 = wa * wa, wb2 = wb * wb;
          const total = wa2 + wb2;
          a.pos.x -= nx * overlap * (wb2 / total); a.pos.z -= nz * overlap * (wb2 / total);
          b.pos.x += nx * overlap * (wa2 / total); b.pos.z += nz * overlap * (wa2 / total);

          // mid-air collision: the stronger body knocks the other away
          if (a.airborne && b.airborne) {
            const diff = rate(a.attr.balance) - rate(b.attr.balance);
            const knock = Math.abs(diff) * 0.6;
            if (diff > 0) { b.pos.x += nx * knock; b.pos.z += nz * knock; }
            else { a.pos.x -= nx * knock; a.pos.z -= nz * knock; }
          }
        }
      }
    }
    // keep everyone in bounds — except an inbounder, who stands out of bounds;
    // during a substitution/walk-off exchange, when players legitimately cross
    // the sideline; and during dead-ball pauses (nobody moves, and the quarter
    // break holds everyone gathered at the bench, outside the court)
    if (this.ballMode === "subs" || this.ballMode === "pause"
        || this.ballMode === "finale") return;   // losers walk off to the bench
    // the inbounder stands out of bounds to throw, and stays there through the
    // throw's flight (he steps in only once his follow-through is done) — so
    // don't yank him onto the court. Normal in-bounds passers are unaffected.
    const skip = this.ballMode === "inbound" ? this.handler
      : this.ballMode === "pass" ? this.passer : null;
    for (const p of this.players) if (p !== skip) this.clampCourt(p.pos);
  }

  // How hard a player holds their ground in a collision (higher = shoves more).
  // ボディバランス wins the body battle: a strong post player backs his man down
  // and is pushed around less; a weak one yields ground.
  private holdWeight(p: Player): number {
    let w = 0.5 + rate(p.attr.balance) * 0.78;                // ~0.6 (weak) .. ~1.28 (strong)
    if (p === this.handler) w += 0.5 + (p.has("post") ? 0.3 : 0); // protects the ball / posts up
    else if (p.screening) w += 0.6;                           // a set screen holds firm
    else if (p.team === 1 - this.possession) w += 0.25;       // defenders hold position
    return w;
  }

  // ---- actions -----------------------------------------------------------

  // Choose the best teammate to pass to — and judge whether to pass at all. The
  // handler reads each lane: he refuses passes riskier than he's willing to
  // attempt right now, then among the safe options weighs openness and progress
  // toward the rim against the chance the ball never arrives. Returns null when
  // every option is too dangerous (the handler keeps the ball instead).
  private chooseReceiver(h: Player): Player | null {
    const rimFloor = this.attackFloor(h.team);
    const tac = this.tactics[h.team].offense;
    // bringing it up vs in the set: until the ball is ESTABLISHED in the
    // frontcourt (frontT) the outlet rules apply — the old distance-only test
    // left a strip near halfway where a "feed the open scorer" read fired and
    // sprayed passes to bigs streaking ahead of the ball
    const backcourt = !this.frontT || dist2D(h.pos, rimFloor) > 14;

    // how much interception risk the handler will accept right now: pass-savvy
    // players and ball-movement game plans thread tighter windows, and a dying
    // shot clock forces the issue
    const urgency = this.shotClock < 6 ? (6 - this.shotClock) / 6 : 0; // 0..1
    // even in a hurry, nobody deliberately throws into a covered lane — the
    // tolerance caps well below "obvious turnover" territory
    // against a zone the ball has to MOVE — swing and skip it side to side to
    // beat the defenders' shifts, so the handler threads slightly tighter windows
    const vsZone = this.zoneScheme !== "";
    const riskTolerance = clamp(
      0.12 + rate(h.attr.passAcc) * 0.2 + rate(h.attr.offense) * 0.1
      + (h.has("outside") ? 0.08 : 0)   // アウトサイド: trusts the tough angle
      + (vsZone ? 0.08 : 0)             // skip passes vs the zone
      + tac.ballMovement * 0.15 * this.twWeight(h) + urgency * 0.35,
      0.10, 0.55);

    let best: Player | null = null;
    let bestScore = -Infinity;
    for (const p of this.teamPlayers(h.team)) {
      if (p === h) continue;
      if (dist2D(h.pos, p.pos) > MAX_PASS) continue;   // out of realistic range
      // frontcourt established → a pass back across halfway is a violation;
      // don't even consider receivers hanging in (or near) the backcourt
      if (this.frontT && this.attackSign(h.team) * p.pos.z < 0.4) continue;
      // a body planted in the lane rules the pass out before any maths
      if (this.laneVetoed(h, p)) continue;
      // full risk estimate: lane defender + hang time + long-ball chasers
      const risk = this.passRisk(h, p);

      // a cutter wide open at the rim is worth gambling on (within reason);
      // otherwise refuse any pass riskier than tolerance (unless the clock is
      // nearly dead)
      const atRimCutter = p.cutting && dist2D(p.pos, rimFloor) < 3.5 && risk < 0.5;
      if (risk > riskTolerance && !atRimCutter && this.shotClock > 2) continue;

      const open = this.nearestDefenderDist(p);
      // a receiver with his man draped on him isn't a target — throwing there
      // reads as a pass to the defender
      if (open < 1.4 && !atRimCutter && this.shotClock > 2) continue;
      // NEVER swing it back into a DOUBLE-TEAM: a team-mate with 2+ defenders
      // collapsed on him (≤2.0 m) is trapped — feeding him just restarts the
      // trap loop the offence is trying to escape (the classic ダブルチームに
      // 引っかかり続ける往復). The double-team leaves someone else free; the ball
      // should go THERE, not back into the trap.
      if (this.doubleTeamed(p) && !atRimCutter && this.shotClock > 2) continue;
      const progress = 1 / (1 + dist2D(p.pos, rimFloor)); // closer to rim = better
      // vision: a low offensive IQ misjudges how good each option really is
      let value = open + progress * 3 + rand(-1, 1) * (1 - rate(h.attr.offense)) * 0.8;
      if (p.cutting) value += 1.5;            // reward feeding a cutter
      if (atRimCutter) value += 1.5;          // ...especially one open at the rim
      if (p.openRollT > 0) value += 2.0;      // the pocket pass to a rolling screener the D left open
      // お膳立て: a good passer HUNTS the open shooter — the better his vision
      // (P精度), the more he prioritises hitting a free man in range with a
      // catch-and-shoot, so his teammates' looks come created rather than forced.
      if (open > 1.8 && dist2D(p.pos, rimFloor) <= this.effShootRange(p) + 0.3) {
        value += (0.5 + rate(h.attr.passAcc) * 1.3) * clamp((open - 1.8) / 2, 0, 1);
      }
      // INSIDE-OUT vs zone: swing to the open man the zone can't rotate to (an
      // open perimeter shooter), and reward the high-post touch that collapses it
      if (vsZone) {
        const dRim = dist2D(p.pos, rimFloor);
        if (open > 1.6 && dRim > 5.5) value += 1.4;      // kick to the open shooter in the gap
        else if (dRim > 3.5 && dRim < 5.5) value += 1.0; // feed the high post / short corner
      }
      // スルーパス: lives for the killer feed to a cutter
      if (h.has("throughPass") && p.cutting) value += 1.5;
      // don't just toss it straight back to the man who fed you — unless he's
      // genuinely cutting to the rim (the real give-and-go)
      if (p === this.assistFrom && this.assistTo === h
          && !(p.cutting && dist2D(p.pos, rimFloor) < 6.5)) {
        value -= 3.0;
      }
      // 手放したばかりの味方には返さない: a player who gave the ball up in the last
      // ~1.6 s is NOT a target (hard exclude), so the ball can't ping-pong back and
      // forth between two men burning the clock — if he's the only "open" man, the
      // handler drives/shoots instead of swinging it back. A genuine rim cut clears
      // the flag at pass time, so a real give-and-go still gets fed.
      if (p.justPassedT > 0 && !atRimCutter) continue;
      if (backcourt) {
        // bringing it up is a GUARD's job: outlet to the playmaker. A big only
        // gets it here on a genuine hit-ahead — already free near the basket —
        // never as a bail-out just because he happens to be the most open man
        // (when the guards are smothered the handler keeps the dribble and the
        // outlet man drops back to him instead). Only a dying clock overrides.
        if (this.isBig(p) && dist2D(p.pos, rimFloor) > 6 && this.shotClock > 4) continue;
        value += p.playmaking * 4.0;
      }
      else value += p.offPriority * 2.2 * clamp(open / 2, 0, 1);   // funnel to the primary (choice order)
      // expected value: discount by the chance the pass is picked off
      const score = value * (1 - risk) - risk * 2.5;
      if (score > bestScore) { bestScore = score; best = p; }
    }
    return best;
  }

  // The defender most directly in the passing lane between two players (or null).
  private laneBlock(from: Player, to: Player): { def: Player; perp: number; t: number } | null {
    const ax = from.pos.x, az = from.pos.z;
    const dx = to.pos.x - ax, dz = to.pos.z - az;
    const len2 = dx * dx + dz * dz || 1;
    let best: { def: Player; perp: number; t: number } | null = null;
    for (const d of this.teamPlayers(1 - from.team)) {
      const t = ((d.pos.x - ax) * dx + (d.pos.z - az) * dz) / len2;
      if (t <= 0.12 || t >= 0.92) continue;             // beside passer/receiver
      const px = ax + dx * t, pz = az + dz * t;
      const perp = Math.hypot(d.pos.x - px, d.pos.z - pz);
      if (perp > LANE_W) continue;                      // not in the lane
      if (!best || perp < best.perp) best = { def: d, perp, t };
    }
    return best;
  }

  // Probability a pass is picked off by the most threatening defender in its
  // lane. Blends how squarely the defender sits in the lane, the pass distance
  // (long passes hang in the air), the defender's ball-hawking (反応/守判断),
  // the passer's accuracy (P精度 threads a tighter window through the very same
  // gap) and pass speed (P速度 — a bullet is harder to jump).
  private interceptChance(from: Player, to: Player,
                          block: { def: Player; perp: number; t: number }): number {
    const d = dist2D(from.pos, to.pos);
    const inLane = 1 - block.perp / LANE_W;                       // 0 at lane edge .. 1 dead-on
    const distFactor = clamp(d / 11, 0.45, 1.25);
    const hawk = rate(block.def.attr.reaction) * 0.45 + rate(block.def.attr.defense) * 0.35
      + rate(block.def.attr.agility) * 0.2
      + (block.def.has("interceptor") ? 0.18 : 0);                // スライディング
    const skill = rate(from.attr.passAcc);
    const zip = 1.18 - rate(from.attr.passSpd) * 0.45;            // fast pass = much harder to cut
    const angle = from.has("outside") ? 0.8 : 1;                  // アウトサイド: odd angles
    let p = inLane * (0.45 + hawk * 0.6) * distFactor * zip * angle - skill * 0.3;
    p += Math.max(0, d - 10) * 0.06;   // a long ball hangs — anyone can jump it
    return clamp(p, 0, 0.9);
  }

  // Long-ball read: a pass past ~9 m fades and hangs — any defender who can
  // physically RUN to a point on its flight path before the ball gets there
  // has a real chance to pick it off. A スライディング reader breaks earlier
  // (effectively covering more ground) and converts the read far more often.
  private longBallBest(from: Player, to: Player, flightT: number,
                       flightDist: number): { def: Player; at: number; p: number } | null {
    const hang = clamp((flightDist - 9) / 6, 0, 1);   // 0 at 9 m → 1 at 15 m
    const ax = from.pos.x, az = from.pos.z;
    const dx = to.pos.x - ax, dz = to.pos.z - az;
    const len2 = dx * dx + dz * dz || 1;
    let best: { def: Player; at: number; p: number } | null = null;
    for (const df of this.teamPlayers(1 - from.team)) {
      const t = ((df.pos.x - ax) * dx + (df.pos.z - az) * dz) / len2;
      if (t <= 0.15 || t >= 0.88) continue;
      const px = ax + dx * t, pz = az + dz * t;
      const perp = Math.hypot(df.pos.x - px, df.pos.z - pz);
      // ground he can cover before the ball crosses his point (a reader with
      // スライディング leaves on the passer's wind-up — a head start)
      const cover = df.runSpeed * 0.85 * (flightT * t) * (df.has("interceptor") ? 1.35 : 1);
      if (perp > cover + 0.4) continue;               // simply can't get there
      let p = 0.35 + hang * 0.3 + rate(df.attr.reaction) * 0.2
        - rate(from.attr.passAcc) * 0.2;
      if (df.has("interceptor")) p += 0.2;
      p = clamp(p, 0.05, 0.85);
      if (!best || p > best.p) best = { def: df, at: t, p };
    }
    return best;
  }

  private longBallRead(from: Player, to: Player, flightT: number,
                       flightDist: number): { def: Player; at: number } | null {
    const best = this.longBallBest(from, to, flightT, flightDist);
    return best && chance(best.p) ? { def: best.def, at: best.at } : null;
  }

  // Hard geometric rule, before any probability: a defender standing squarely
  // IN the passing lane (dead centre, not hugging either end) means the pass
  // is simply not on — however good the passer thinks he is.
  private laneVetoed(from: Player, to: Player): boolean {
    const block = this.laneBlock(from, to);
    return !!block && block.perp < 0.65;
  }

  // The handler's own estimate of "does this pass survive?" — the SAME dangers
  // the flight will actually face (lane defender + hang time + anyone able to
  // run the long ball down). Every pass decision funnels through this, so a
  // covered receiver simply doesn't get thrown to.
  private passRisk(from: Player, to: Player): number {
    const d = dist2D(from.pos, to.pos);
    const block = this.laneBlock(from, to);
    let r = block ? this.interceptChance(from, to, block) : 0;
    if (d > 9) {   // the read still weighs a long ball's hang, matching the flight fade
      const fade = d > 12 ? clamp(1 - (d - 12) * 0.05, 0.85, 1) : 1;
      const flightT = d / (PASS_SPEED * (0.6 + rate(from.attr.passSpd) * 0.95) * fade);
      r += (this.longBallBest(from, to, flightT, d)?.p ?? 0) * 0.9;
    }
    return r;
  }

  // Decide (once, at release) whether the chosen pass is actually picked off.
  private evalInterception(from: Player, to: Player): { def: Player; at: number } | null {
    const block = this.laneBlock(from, to);
    if (!block) return null;
    let p = this.interceptChance(from, to, block);
    // スルーパス: the killer feed to a cutter arrives where only he can play it
    if (from.has("throughPass") && to.cutting) p *= 0.75;
    // バウンド=手の下をくぐる / ジャンプ=頭上を越える — どちらもレーンの守備の
    // 届く高さを外すのがそもそもの目的
    if (this.passStyle === "bounce") p *= 0.45;
    else if (this.passStyle === "jump") p *= 0.6;
    return chance(p) ? { def: block.def, at: block.t } : null;
  }

  private pass(h: Player): boolean {
    const target = this.chooseReceiver(h);
    if (!target) return false;
    return this.passToReceiver(h, target);
  }

  // Throw to a specific receiver — used both by the general read (chooseReceiver)
  // and by an explicit decision to swing the ball to a better scoring option.
  private passToReceiver(h: Player, target: Player, force = false,
                         style: "chest" | "bounce" | "jump" = "chest"): boolean {
    this.passStyle = style;
    // The ball homes onto the receiver, so what matters is the distance to the
    // CATCH point, not to where he stands now — lead a sprinting receiver by
    // his velocity over the flight. Without this, a 7 m release stretches into
    // a cross-court bomb that dodges every range/interception check.
    // P速度 drives how hard the ball is zipped — a WIDE spread so a great passer
    // fires a bullet and a poor one lobs it (0.6× .. 1.55× of PASS_SPEED).
    const zip0 = PASS_SPEED * (0.6 + rate(h.attr.passSpd) * 0.95);
    const d0 = dist2D(h.pos, target.pos);
    const lead = d0 / zip0;                              // first-pass flight time
    // never AIM out of bounds: a receiver sprinting the sideline is led ALONG
    // the line, not past it — the intended catch point stays a step inside the
    // court (only the P精度 scatter below can still carry the ball out, and that
    // sails away as a throw-away, not a catch)
    const cx = clamp(target.pos.x + target.velX * lead, -(COURT.halfW - 0.35), COURT.halfW - 0.35);
    const cz = clamp(target.pos.z + target.velZ * lead, -(COURT.halfL - 0.35), COURT.halfL - 0.35);
    const d = Math.hypot(cx - h.pos.x, cz - h.pos.z);    // true flight distance
    if (d > MAX_PASS + 1.5) return false;                // the bomb isn't on — keep it

    // クロック終盤の現実チェック: このパスの滞空後、受け手に撃つ時間(判断+ワインド
    // アップ≈0.9s)が残らないなら「回しても間に合わない」— 投げずに自分で打つ/
    // 切り込む判断へ返す。時間を捨てるパス回しをしない。
    if (this.shotClock < 2.2 && this.shotClock - d / zip0 < 0.9) return false;

    // FINAL safety gate for every pass, whatever read chose it (outlet after a
    // rebound, kick-out, swing): a defender standing in the lane, or a full
    // risk estimate that says "likely turnover", means the ball simply doesn't
    // get thrown. Only a dying shot clock forces a heave through traffic.
    if (!force && this.shotClock > 2
        && (this.laneVetoed(h, target)
          || this.passRisk(h, target) > 0.3
          || (!target.cutting && this.nearestDefenderDist(target) < 1.0))) {
      return false;
    }

    // release height: a jump pass leaves the hands ABOVE the defenders
    this.passFrom.set(h.pos.x, style === "jump" ? 2.0 : 1.1, h.pos.z);
    this.passCatch.set(cx, 1.1, cz);   // ball flies to this FIXED lead point → constant speed
    this.passTo = target;
    this.passer = h;
    this.passT = 0;
    // P速度: how hard this player zips the ball — but past ~9 m even a bullet
    // runs out of steam, so long balls hang in the air noticeably longer
    // only the LONGEST balls hang a touch (kept subtle so passes don't visibly
    // lurch slower mid-court): full speed to ~12 m, barely fading beyond.
    const fade = d > 12 ? clamp(1 - (d - 12) * 0.05, 0.85, 1) : 1;
    this.passDur = Math.max(0.22, d / (zip0 * fade));
    if (style === "bounce") this.passDur *= 1.3;   // the floor bounce bleeds pace
    // パス品質: P精度が高いほど胸元へ「ジャスト」で届く — ただし常にブレ幅が
    // あり、名手でもズレる時はズレるし、雑なパサーがドンピシャを通す時もある。
    // ロングは収まりにくい。
    this.passQ = clamp(0.18 + rate(h.attr.passAcc) * 0.72 + rand(-0.28, 0.28)
      - Math.max(0, d - 9) * 0.03, 0, 1);
    // P精度 = WHERE it actually lands, in METRES off the target. This is driven
    // ALMOST ENTIRELY by P精度 (accuracy dominates, only a light jitter) so a
    // low-accuracy passer CLEARLY sprays it while a precise one is on the money —
    // spread ~0.2 m (elite) up to ~1.6 m (poor), long balls a touch looser. The
    // ball lands off in a random front/back/left/right + high/low direction; the
    // receiver then has to step/reach for it (he homes to this point in
    // updatePass), and the harder the reach the more it breaks his balance for the
    // next move (see the gather penalty at the catch, tied to this same passMiss).
    const acc = rate(h.attr.passAcc);
    this.passMiss = clamp(((1 - acc) * 3.0 + Math.max(0, d - 9) * 0.06) * rand(0.65, 1.2), 0, 3.3);
    const ang = rand(0, Math.PI * 2);
    this.passCatch.set(cx + Math.cos(ang) * this.passMiss, 1.1, cz + Math.sin(ang) * this.passMiss);
    this.passMissY = rand(-1, 1) * this.passMiss * 0.55;   // a high / low delivery too
    this.passSteal = this.evalInterception(h, target);
    // a hanging long ball can be run down even when nobody sat squarely in the
    // lane at release (スライディング readers range the furthest)
    if (!this.passSteal && d > 9) {
      this.passSteal = this.longBallRead(h, target, this.passDur, d);
    }
    // FORCED out of a trap: a skilled passer (P精度) THREADS it — a bounce pass
    // slipped between the two trappers, or a jump pass over the top — so his
    // ability, not the veto, decides it. A weak passer forcing it gets picked.
    if (force && this.passSteal && chance(rate(h.attr.passAcc) * 0.6)) {
      this.passSteal = null;
    }
    this.ballMode = "pass";
    this.handler = null;
    // follow-through: the passer is rooted briefly and can't immediately
    // re-engage — quick players (敏捷性) reset their balance sooner
    h.coolT = rand(0.5, 0.9) * h.recoveryMult();
    // 手放したばかり: for the next ~1.6 s the ball shouldn't come straight back to
    // him (breaks the 2-man ping-pong that just eats the clock). A real cut to the
    // rim clears it (a give-and-go IS worth feeding).
    h.justPassedT = 1.6;
    // give-and-go SOMETIMES: always cutting after a pass made the return feed
    // to the "cutter" the best read every time — an A→B→A ping-pong. Now the
    // passer usually just relocates, and only sometimes cuts for the give-and-go.
    if (chance(0.28)) {
      const rim = this.attackFloor(h.team);
      h.cutting = true;
      h.justPassedT = 0;                     // a genuine give-and-go cutter IS a target
      h.offTimer = rand(1.5, 3.0);
      h.offTarget.set(rim.x + rand(-0.6, 0.6), 0, rim.z - Math.sign(rim.z) * 0.4);
    } else {
      h.cutting = false;
      h.offTimer = rand(0.6, 1.4);
      h.spotIdx = this.bestOpenSpot(h.team, this.formationSpots(h.team), h);
    }
    return true;
  }

  private updatePass(dt: number): void {
    // off-ball + defence keep moving during the pass
    this.runDefenseDuringDeadish(dt);
    this.updateOffBallMotion(dt, this.possession, this.passTo);

    // a defender who decided to jump this pass breaks for the interception
    // point at full tilt, ahead of the ball arriving (he read it early)
    if (this.passSteal && this.passTo) {
      const d = this.passSteal.def;
      const ix = this.passFrom.x + (this.passCatch.x - this.passFrom.x) * this.passSteal.at;
      const iz = this.passFrom.z + (this.passCatch.z - this.passFrom.z) * this.passSteal.at;
      moveToward2D(d.pos, ix, iz, d.accelSpeed(dt, 1.08) * dt);
      this.clampCourt(d.pos);
    }

    // RECEIVE THE PASS: the receiver comes to meet the ball at the catch point,
    // so the ball actually arrives IN his hands instead of homing to a spot he
    // never left. He covers the remaining gap over the remaining flight time
    // (capped at a lunging sprint), and turns to face the incoming ball. An
    // off-target delivery (low P精度) puts the catch point off his line, so he
    // has to step/reach OFF his spot to get it — that displacement is the visible
    // "ズレて取る", and the gather at the catch (below) is what then costs him the
    // balance for his next move.
    if (this.passTo) {
      const r = this.passTo;
      const remain = Math.max(dt, this.passDur - this.passT);
      const gap = dist2DTo(r.pos, this.passCatch.x, this.passCatch.z);
      if (gap > 0.02) {
        const need = gap / remain;                        // m/s to arrive on time
        const spd = Math.min(need, r.runSpeed * 1.35);    // up to a lunging sprint
        moveToward2D(r.pos, this.passCatch.x, this.passCatch.z, spd * dt);
        this.clampCourt(r.pos);
      }
      // (updateFacing turns him chest-on to the ball this same frame — his aim is
      // the ball while he's the receiver — so the approach reads as a catch)
    }

    this.passT += dt;
    const k = Math.min(1, this.passT / this.passDur);
    const a = this.passFrom, b = this.passCatch;   // FIXED lead point → the ball travels at a steady speed
    const endY = 1.0 + this.passMissY;             // an off pass arrives high / low too
    if (this.passStyle === "bounce") {
      // バウンドパス: 手元から床(58%地点)へ落とし、跳ねて受け手の手元へ — 相手の
      // 手の下をくぐる V 字の軌道
      const kb = 0.58;
      const y = k < kb
        ? a.y + (0.12 - a.y) * (k / kb)
        : 0.12 + (Math.max(0.7, Math.min(endY, 0.95)) - 0.12) * ((k - kb) / (1 - kb));
      this.ball.pos.set(a.x + (b.x - a.x) * k, y, a.z + (b.z - a.z) * k);
    } else {
      // chest は従来どおり / jump は高いリリース点(a.y=2.0)から受け手の胸へ降ろす
      const arc = this.passStyle === "jump" ? 0.25 : 0.4;
      this.ball.pos.set(
        a.x + (b.x - a.x) * k,
        (a.y + (endY - a.y) * k) + Math.sin(k * Math.PI) * arc, // hand-to-hand with a slight arc
        a.z + (b.z - a.z) * k,
      );
    }

    // interception: decided once at pass time, triggered as the ball reaches
    // the defender's point in the lane. A good thief picks it clean; otherwise
    // he only gets a fingertip and the ball deflects loose.
    if (this.passSteal && k >= this.passSteal.at) {
      const d = this.passSteal.def;
      this.passSteal = null;
      const offense = this.possession;
      const catchP = 0.4 + rate(d.attr.reaction) * 0.45 + (d.has("interceptor") ? 0.15 : 0);
      if (chance(clamp(catchP, 0.2, 0.95))) {
        d.stats.stl++;
        if (this.passer) this.passer.stats.tov++;
        this.handler = d;
        this.possession = d.team;
        this.ballMode = "held";
        this.shotClock = SHOT_CLOCK;
        d.decisionT = 0.4;
        this.ball.vel.set(0, 0, 0);
        this.resetMotion();
        this.maybeStartPush();   // a pick-off is the cleanest fast-break start
        this.leakOut();      // 飛び出し runners sprint out off the pick
        this.setEvent("INTERCEPTED", d.team);
      } else {
        // deflected: the ball caroms off his hand and is live
        this.ball.pos.set(d.pos.x, 1.2, d.pos.z);
        this.ball.vel.set(rand(-2.5, 2.5), rand(1.0, 2.2), rand(-2.5, 2.5));
        this.goLoose(offense, 2.0, { stealBy: d, victim: this.passer, grabAfter: 0.3 });
        this.setEvent("DEFLECTED", d.team);
      }
      return;
    }

    if (k >= 1) {
      const receiver = this.passTo!;
      // スローアウェイ: the scattered delivery sailed OUT OF BOUNDS — the receiver
      // chased but clampCourt held him inbounds, and a ball landing past the line
      // is NOT dragged into his hands (that read as a magic catch from outside).
      // It's dead where it crossed: turnover on the passer, throw-in the other way.
      if (Math.abs(this.passCatch.x) > COURT.halfW || Math.abs(this.passCatch.z) > COURT.halfL) {
        if (this.passer) { this.passer.stats.tov++; this.lastTouch = this.passer; }
        const to = 1 - this.possession;
        this.passTo = null;
        this.passSteal = null;
        this.startInboundAt(to, this.passCatch.x, this.passCatch.z, { clock: SHOT_CLOCK });
        return;
      }
      // meet the ball cleanly: nudge the receiver the last few cm onto the catch
      // point so the held ball sits in his hands with no back-snap (the homing
      // above keeps this tiny; the cap stops a jump if he couldn't quite get there)
      const gap = dist2DTo(receiver.pos, this.passCatch.x, this.passCatch.z);
      if (gap > 0.02) moveToward2D(receiver.pos, this.passCatch.x, this.passCatch.z, Math.min(gap, 0.4));
      // backstop for the rule itself: an established ball caught behind halfway
      // (e.g. the receiver drifted back) is an over-and-back violation
      if (this.frontT && this.attackSign(receiver.team) * receiver.pos.z < 0) {
        this.passTo = null;
        this.turnover(receiver, "BACKCOURT");
        return;
      }
      this.handler = receiver;
      this.passTo = null;
      this.ballMode = "held";
      // ジャスト・レシーブ: a pass right on the hands lets the receiver flow into
      // his next move; the further off-target it lands, the longer he's FROZEN
      // (硬直) corralling it before he can move into his next action. The freeze is
      // proportional to how far off the ball was (passMiss, in metres), scaled by
      // 技術(handling) about a pivot of 80: a receiver above 80 secures it FASTER
      // (shorter freeze), below 80 takes LONGER — a great one still loses a touch
      // on a wild pass, but far less than a clumsy one. Tied to the SAME passMiss
      // that displaced the catch, and to the wobble/steal window below.
      const handFactor = clamp(1 + (0.80 - rate(receiver.attr.handling)) * 2.2, 0.35, 2.2);
      const gather = clamp(this.passMiss * 0.42 * handFactor * rand(0.85, 1.2), 0, 1.1);
      // ダイレクトプレイ: plays off the catch in one touch
      receiver.decisionT = (receiver.has("oneTouch") ? 0.08 : 0.25) + gather;
      // ゴール下でフリーで受けた: 考えない — キャッチ即フィニッシュの本能
      // (ここでの逡巡が「ゴールから離れて向き直る」不自然さの正体)
      {
        const rimF = this.attackFloor(receiver.team);
        if (dist2D(receiver.pos, rimF) < 2.6 && this.nearestDefenderDist(receiver) > 1.0) {
          receiver.decisionT = 0.06 + gather * 0.5;   // even a bobble settles quicker under the rim
        }
      }
      // 4対3の優位で受けた: 味方がダブルチーム中＝守備が一人手薄。トラップが
      // ローテートして来る前に、逡巡せず即攻める(オープン3/ドライブ)。これが
      // 「ダブルチームを剥がしてフリーの味方が突く」正しい対応。
      if (this.teamPlayers(receiver.team).some((m) => m !== receiver && this.doubleTeamed(m))) {
        receiver.decisionT = Math.min(receiver.decisionT, 0.08 + gather * 0.5);
      }
      if (gather > 0.02) {
        receiver.coolT = Math.max(receiver.coolT, gather);   // 硬直: rooted this long
        receiver.gatherT = gather;   // …and the ball is still loose in his hands this whole time
      }
      receiver.quickT = Math.max(0.15, 0.6 - gather);   // ジャストほどワンタッチの窓が広い
      // お膳立て: a good passer hits an OPEN man in rhythm — ready to shoot with
      // nothing to do but rise. The better the passer's vision/accuracy and the
      // more open the catch, the bigger the catch-and-shoot boost his next shot
      // gets (this is how a playmaker CREATES points for a limited scorer). A
      // FAST pass (P速度) keeps the window open longer — it beat the closeout.
      const passer = this.passer;
      if (passer) {
        const openAtCatch = this.nearestDefenderDist(receiver);
        const vision = rate(passer.attr.passAcc) * 0.6 + rate(passer.attr.offense) * 0.4;
        const zip = rate(passer.attr.passSpd);   // 0 (lob) .. 1 (bullet)
        receiver.setupBonus = clamp((vision - 0.4) * 0.36
          + clamp(openAtCatch - 1.3, 0, 2) * 0.05
          + zip * 0.10, 0, 0.28) * this.passQ;    // a bullet beats the closeout → a cleaner look
        receiver.setupT = 0.8 + zip * 1.3;         // fast pass = longer open window
        // SWING THE DEFENCE: a fast pass beats his man's rotation — the closeout is
        // LATE (reactT), so a bullet to the open man really frees him. A slow lob
        // gives the defender time to recover, so it barely helps.
        const rd = this.onBallDefender(receiver);
        if (rd) rd.reactT = Math.max(rd.reactT, (0.15 + zip * 0.7) * this.reactionLag(rd));
      }
      // a completed pass sets up a potential assist for whoever threw it
      this.assistFrom = this.passer;
      this.assistTo = receiver;
    }
  }

  // Deciding to shoot starts a CHARGE (gather) — the ball is loaded for a beat
  // before it launches. The wind-up is longer from range / for a low S技術, and
  // shortest on a catch-and-shoot. This gather is the window in which the man
  // guarding him can read the shot and close out to contest (see updateCharge);
  // the actual make% / block / launch happen at RELEASE (releaseShot).
  private chargeT = 0;
  private chargeShooter: Player | null = null;
  private chargeDHoop = 0;
  private chargeDDef = 0;
  private shotWindup = 0;   // the gather length of the shot being launched (for tryBlock)
  private shoot(h: Player, dHoop: number, dDef: number): void {
    // BUZZER BEATER: no time to gather — he just flings it up as the horn sounds.
    // It's a pure accuracy trade-off (releaseShot already floors the make%), so
    // there's no charge phase and no wind-up (the ball goes NOW).
    if (this.gameClock > 0 && this.gameClock < 0.9) {
      this.shotWindup = 0;
      this.releaseShot(h, dHoop, dDef);
      return;
    }
    const windup = this.shotWindupFor(h, dHoop);
    this.shotWindup = windup;
    this.chargeShooter = h;
    this.chargeDHoop = dHoop;
    this.chargeDDef = dDef;
    this.chargeT = windup;
    this.shooter = h;              // pose owner during the gather
    this.handler = null;
    this.ballMode = "charge";
    // the ball STARTS at the gather pocket (chest) and is lifted over the head
    // across the wind-up (see chargeBallY) — the jump-shot pocket he releases from
    this.ball.pos.set(h.pos.x, this.chargeBallY(), h.pos.z);
  }
  private static readonly SHOT_SET_Y = 2.1;    // overhead ball height at the top of the load
  private static readonly SHOT_GATHER_Y = 1.2; // where the gather begins — chest / pocket

  // The ball climbs from the pocket to overhead across the wind-up so the load
  // reads as a motion, not a frozen pose: overhead by ~80% of the gather, then
  // held there for the release window. Eased (smoothstep) for an unhurried lift.
  private chargeBallY(): number {
    const w = this.shotWindup || 0.001;
    const p = clamp(1 - this.chargeT / w, 0, 1);   // 0 at gather start → 1 at release
    const rise = clamp(p / 0.8, 0, 1);
    const e = rise * rise * (3 - 2 * rise);
    return Game.SHOT_GATHER_Y + (Game.SHOT_SET_Y - Game.SHOT_GATHER_Y) * e;
  }

  // One frame of the gather: hold the ball loaded, and let the on-ball defender
  // READ the shot and CLOSE OUT / leave his feet to contest. A defender who was
  // caught leaning on the drive (beaten / recovering) can't get there — that's
  // how over-playing the dribble gives up a clean look.
  private updateCharge(dt: number): void {
    const h = this.chargeShooter;
    if (!h) { this.ballMode = "held"; return; }
    this.chargeT -= dt;
    this.ball.pos.set(h.pos.x, this.chargeBallY(), h.pos.z);   // lifted from the pocket over the head
    const d = this.teamPlayers(1 - h.team)[h.slot];   // the man guarding the shooter
    const beaten = h.beatenT > 0 || h.powerT > 0;     // he blew by → the closeout is late
    if (d && !beaten) {
      const gap = dist2D(d.pos, h.pos);
      if (!d.airborne && d.landT <= 0) {
        // hard closeout toward the shooter
        if (gap > 0.75) {
          const clo = d.accelToward(dt, h.pos.x, h.pos.z, 1.15) * dt;
          moveToward2D(d.pos, h.pos.x, h.pos.z, clo);
          this.clampCourt(d.pos);
        }
        // as the release nears, a defender who's close and read it LEAVES HIS FEET
        // to challenge — 反応/守判断 time it, ジャンプ gives the length to reach it
        if (this.chargeT < 0.13 && gap < 1.7) {
          const read = rate(d.attr.reaction) * 0.5 + rate(d.attr.defense) * 0.5;
          if (chance((0.25 + read * 1.5) * dt * 9)) d.jump(0.5 + rate(d.attr.jump) * 0.35, 0.6);
        }
      }
      // STRIP ON THE GATHER: while the ball is loaded OVERHEAD, a defender in his
      // airspace swipes at it — per frame, so a LONGER gather (a deep / slow load)
      // is far more likely to be knocked loose BEFORE the release. He has to reach
      // the high ball (airborne helps a lot); a taller shooter holds it away.
      if (gap < 1.2) {
        const poke = rate(d.attr.reaction) * 0.4 + rate(d.attr.agility) * 0.35
          + rate(d.attr.defense) * 0.25 + (d.has("interceptor") ? 0.12 : 0);
        const secure = rate(h.attr.handling) * 0.5 + clamp((h.height - d.height) * 0.6, -0.15, 0.35);
        const reach = d.airborne ? 1.3 : 0.5;   // the ball is overhead — he must get up to it
        if (chance(Math.max(0, poke - secure) * reach * dt * 5)) { this.stripGather(h, d); return; }
      }
    }
    if (this.chargeT <= 0) this.releaseShot(h, this.chargeDHoop, this.chargeDDef);
  }

  // The loaded (overhead) ball is knocked out of the shooter's hands before the
  // release — a live loose ball, sprayed toward the defender who tipped it.
  private stripGather(h: Player, d: Player): void {
    this.chargeShooter = null;
    d.stats.stl++;
    const ax = d.pos.x - h.pos.x, az = d.pos.z - h.pos.z;
    const len = Math.hypot(ax, az) || 1;
    const grip = clamp(0.2 + rate(d.attr.reaction) * 0.6 - rate(h.attr.handling) * 0.3, 0.05, 0.9);
    const power = rand(1.8, 3.4);
    this.ball.pos.set(h.pos.x, Game.SHOT_SET_Y, h.pos.z);
    this.ball.vel.set((ax / len) * power * grip + rand(-1, 1) * (1 - grip), rand(-0.4, 0.9),
                      (az / len) * power * grip + rand(-1, 1) * (1 - grip));
    this.setEvent("STRIP!", d.team);
    this.lastTouch = d;   // the stripper last touched it
    h.touchCool = 0.4;
    this.goLoose(h.team, 1.6, { stealBy: d, victim: h, grabAfter: 0.35 });
  }

  private releaseShot(h: Player, dHoop: number, dDef: number): void {
    this.chargeShooter = null;
    this.pendingAssist = this.assistCreditFor(h);
    const isThree = dHoop > THREE_DIST;
    this.shotPoints = isThree ? 3 : 2;
    this.shotWasDunk = false;   // jump shot, not a dunk

    // make % = the shooter's skill at this range, less distance and contest
    const skill = rate(isThree ? h.attr.threeAcc : h.attr.midAcc);
    const baseLine = isThree ? 0.16 : 0.30;
    const distRef = isThree ? THREE_DIST : 1.5;
    // L速度 flattens the falloff on deep threes; 特能ミドル flattens it everywhere
    let falloff = isThree ? 0.05 - rate(h.attr.threeRange) * 0.035 : 0.03;
    if (h.has("range")) falloff *= 0.65;
    const over = Math.max(0, dHoop - distRef);
    // distance hurts linearly, but a far HEAVE collapses QUADRATICALLY — even a
    // max L精度/L速度 shooter tops out ~20% from deep (≈13 m) and it drops fast
    // beyond that (a half-court prayer is a couple of percent). L速度 flattens
    // the collapse a little (a genuine long-range shooter holds up).
    const heaveDrop = isThree ? over * over * 0.011 * (1 - rate(h.attr.threeRange) * 0.33) : 0;
    let p = baseLine + skill * 0.42 - over * falloff - heaveDrop;
    // 弾道高さ (旧カーブ) no longer changes the make% directly — it now sets the
    // ARC of the shot (higher = harder to block); see shotApex + tryBlock below.
    // ダイレクトプレイ: the catch-and-shoot rhythm is his shot
    if (h.quickT > 0 && h.has("oneTouch")) p += 0.05;
    // お膳立て: caught open in rhythm off a good pass — a set-up look even a
    // limited scorer converts (the assist created the make)
    if (h.setupT > 0) p += h.setupBonus;
    // contest — S威力 shoots through the contact; a 1対1シュート specialist
    // barely feels a single defender (only real help bothers him)
    // S威力: shooting through contact. The coefficient (0.78) and the penalty
    // magnitude (0.24) are re-centred together so AVERAGE scoring is unchanged
    // but the SLOPE is steeper — a strong shooter shrugs off contests a weak
    // one can't (attr-impact tuning: revived S威力 from ~0 to a real effect).
    let contestScale = 1 - rate(h.attr.shotStrength) * 0.78;
    if (h.has("isoShooter") && this.defendersWithin(h, 2.4) <= 1) contestScale *= 0.6;
    // WHO is closing out matters: a quick, rangy perimeter defender flies at it, a
    // slow big switched onto the shooter is late — position + physique, no tag.
    const cn = this.nearestDefender(h);
    const perimQ = cn ? clamp(1 + this.perimContest(cn, h), 0.6, 1.5) : 1;
    p -= clamp(1.8 - dDef, 0, 1.8) * 0.24 * contestScale * perimQ;
    // off-balance (shooting on the move) — S技術 keeps the mechanics clean
    if (h.beatenT > 0 || h.curSpd > h.runSpeed * 0.55) {
      p -= 0.10 * (1 - rate(h.attr.shotTech));
    }
    // 精神: fatigue, a deficit and crunch time rattle a weak mind
    p -= this.clutchFactor(h) * 0.12;
    // 終了間際の駆け込み: どの距離でも体勢を作れずに放るので精度が大きく落ちる
    // （近〜中距離の"ブザービーター"が通常確率で入りすぎるのを抑える）。S技術が
    // 高い選手ほど崩れた態勢でも決められるので落ち込みが小さい。
    if (this.gameClock > 0 && this.gameClock < 1.0) {
      p *= 0.5 + rate(h.attr.shotTech) * 0.2;   // ×0.5(技術0) 〜 ×0.7(技術100)
    }
    p = clamp(p, 0.02, 0.93);   // low floor so a long heave can be a couple %
    this.shotMade = chance(p);

    this.shooter = h;   // own the shot NOW so a block freezes HIS follow-through
    this.lastTouch = h;   // the shooter last touched it (an airball out → other team's ball)
    // ミドル/ゴール下のジャンプシュートも、レイアップ/ダンク同様に S技術 で
    // ブロックをかわして打てる（3Pは対象外）。
    const blocker = this.tryBlock(h, false, !isThree);
    if (blocker) { this.swatShot(h, blocker); return; }
    if (this.tryShootingFoul(h, dDef, false)) return;

    this.shotFrom.set(h.pos.x, 2.05, h.pos.z);
    this.aimShotTarget(dHoop);   // rim on a make; a big off-target point on a long miss
    this.shotT = 0;
    // Beyond the arc the ball is HEAVED, not flicked: the farther out, the
    // higher and slower the rainbow (a buzzer bomb hangs in the air long enough
    // to follow). Inside the arc nothing changes (far = 0 → the old 0.85/2.2).
    const far = Math.min(12, Math.max(0, dHoop - THREE_DIST));
    this.shotDur = 0.85 + far * 0.11;
    // 弾道高さ: the jumper's arc rises with the rating (≈1.6 low .. 2.8 high,
    // centred on the old 2.2), plus the deep-heave lift. A higher arc reads as a
    // rainbow and is harder to block (tryBlock reads the same rating).
    this.shotApex = (1.6 + rate(h.attr.bank) * 1.2) + far * 0.45;
    this.longShot = far > 0.5;   // deep enough that the ball cam should chase it
    this.longShotHoldT = 0;      // a new flight owns the camera call

    this.ballMode = "shot";
    this.shooter = h;
    this.shooterFinishing = false;
    this.handler = null;
    h.jump(0.4, 0.8);          // shooter rises on the jump shot
    this.contestJump(h);       // nearest defender contests
    // follow-through: the shooter is rooted through the shot's flight and a beat
    // of landing, so he can't instantly crash the boards or get back
    h.coolT = this.shotDur + rand(0.4, 0.7) * h.recoveryMult();
    // team-mates and defenders can crash the boards while the ball is in the air
  }

  // Layup or dunk: a high-percentage finish at the rim with a flat, quick arc.
  private finishAtRim(h: Player, dDef: number): void {
    this.pendingAssist = this.assistCreditFor(h);
    this.shotPoints = 2;
    // ジャンプ+ヘッド decide whether he can throw it down; バランス lets him
    // dunk through a body
    const athletic = rate(h.attr.jump) * 0.5 + rate(h.attr.dunk) * 0.3 + rate(h.attr.balance) * 0.2;
    const lane = dDef > 1.1 || (rate(h.attr.balance) > 0.65 && dDef > 0.6);
    const dunk = lane && chance(0.06 + athletic * 0.7);
    this.shotWasDunk = dunk;   // a dunk gets a bigger bench celebration
    // dunks convert on ヘッド, layups on S精度; S威力 finishes through contact
    let p = dunk ? 0.82 + rate(h.attr.dunk) * 0.15 : 0.5 + rate(h.attr.midAcc) * 0.35;
    // a layup finished on the WEAK side is a weak-hand finish — 逆手精度 (2..8)
    // keeps it clean, a one-handed player bricks it (dunks are two-handed, exempt)
    if (!dunk && h.driveSide === -h.strongSide()) {
      p -= (1 - h.offhandAcc / 8) * 0.1;
    }
    // CONTEST at the rim. The nearest defender's contest is softened by S威力
    // (finishing through contact) — but only the FIRST man. Driving into a
    // CROWD (a second/third body at the rim) is low-percentage no matter how
    // strong you are, so extra help barely feels S威力: this is what stops a
    // physical player from bulling through 2-3 defenders for an easy dunk. An
    // OPEN catch-and-finish (nobody near) keeps its high percentage.
    const strong = rate(h.attr.shotStrength);
    // WHO is contesting matters as much as how close: a rim-protecting big walls
    // the basket, a guard switched onto the roll barely bothers it (rimProtect is
    // pure position + physique, not a role tag). This is the interior-defence
    // interdependence — vacate the paint or switch small and finishes fall in.
    const near = this.nearestDefender(h);
    const contestQ = near ? clamp(1 + this.rimProtect(near, h), 0.5, 1.6) : 1;
    p -= clamp(1.1 - dDef, 0, 1.0) * 0.42 * (1 - strong * 0.7) * contestQ;
    // FINISHING THROUGH A MARK — オフェンス helps ONLY when a defender is on him,
    // scaled by how tight the mark is: an OPEN finish (dDef ≥ 1.5, nobody near) is
    // UNCHANGED by offence; the tighter the mark, the more offence decides it. 75 =
    // neutral, above → buries the contested dunk, below → the defence-first big
    // clanks the dunk he'd otherwise mass-produce.
    const mark = clamp((1.5 - dDef) / 1.5, 0, 1);   // 0 open .. 1 draped
    p += (rate(h.attr.offense) - 0.75) * 1.6 * mark;
    // EACH additional body at the rim is a wall — driving into a crowd is a
    // low-percentage prayer that S威力 barely helps. This is what stops a
    // physical player bulling through 2-3 defenders for an easy bucket while
    // leaving the OPEN catch-and-finish (crowd = 0/1) at its high percentage.
    let crowd = 0;
    for (const d of this.teamPlayers(1 - h.team)) {
      if (dist2D(d.pos, h.pos) < 2.4) crowd++;
    }
    if (crowd >= 2) p -= (crowd - 1) * 0.23 * (1 - strong * 0.2);
    p -= this.clutchFactor(h) * 0.1;
    this.shotMade = chance(clamp(p, 0.05, 0.97));

    this.shooter = h;   // own the shot NOW so a block freezes HIS follow-through
    this.lastTouch = h;   // the shooter last touched it (an airball out → other team's ball)
    this.evadedFinish = false;
    const blocker = this.tryBlock(h, true);
    if (blocker) { this.swatShot(h, blocker); return; }
    if (this.tryShootingFoul(h, dDef, true)) return;

    this.shotFrom.set(h.pos.x, dunk ? 2.6 : 1.7, h.pos.z);
    this.shotT = 0;
    // an evaded block reads as a DOUBLE CLUTCH — he hangs a beat longer to let
    // the swat whiff past before laying it in
    this.shotDur = (dunk ? 0.45 : 0.55) + (this.evadedFinish ? 0.14 : 0);
    this.shotApex = dunk ? 0.25 : 0.7;
    // take off SHORT of the rim (on the approach side) and reach the ball up to
    // the hoop, rather than planting the body directly under it. A dunker gets
    // closer than a layup. If he's already right under the rim, gather from the
    // mid-court side.
    {
      const rimFloor = this.attackFloor(h.team);
      let dx = h.pos.x - rimFloor.x, dz = h.pos.z - rimFloor.z;
      let len = Math.hypot(dx, dz);
      if (len < 0.4) { dx = 0; dz = -this.attackSign(h.team); len = 1; }   // approach from mid-court
      const standoff = dunk ? 0.6 : 0.9;
      this.finishSpot.set(rimFloor.x + (dx / len) * standoff, 0, rimFloor.z + (dz / len) * standoff);
    }
    // carry his DRIVE MOMENTUM into the leap: he takes off at the speed he was
    // running (a stride into the finish, not a dead-stop planted jump), and that
    // horizontal speed decays in the air (crashBoards). Capped so a fast break
    // doesn't sail him past the rim.
    {
      const cap = h.runSpeed * 1.05;
      const sp = Math.hypot(h.velX, h.velZ);
      const k = sp > cap ? cap / sp : 1;
      this.finishVX = h.velX * k;
      this.finishVZ = h.velZ * k;
    }
    this.shotTarget.copyFrom(this.attackRim(this.possession));   // point-blank: a miss just rims out
    this.ballMode = "shot";
    this.longShot = false;   // a rim finish is never ball-cam material
    this.longShotHoldT = 0;  // and it cancels a lingering long-shot hold
    this.shooter = h;
    this.shooterFinishing = true;
    this.handler = null;
    // elevation scales with ジャンプ
    h.jump(dunk ? 0.85 + rate(h.attr.jump) * 0.3 : 0.55 + rate(h.attr.jump) * 0.2,
      dunk ? 0.7 : 0.6);
    this.contestJump(h);
    // the finisher drives in during the shot (handled in crashBoards), then a
    // short recovery before he can move again
    h.coolT = this.shotDur + rand(0.25, 0.45) * h.recoveryMult();
    this.setEvent(dunk ? "DUNK!" : "LAYUP", h.team);
  }

  // The nearest defender jumps to contest a shot/finish.
  private contestJump(shooter: Player): void {
    let near: Player | null = null;
    let best = 2.6; // only contest from within this range
    for (const d of this.teamPlayers(1 - shooter.team)) {
      const dd = dist2D(d.pos, shooter.pos);
      if (dd < best) { best = dd; near = d; }
    }
    if (near) near.jump(0.5, 0.65);
  }

  // Can a defender swat the shot? Every defender who can reach the shot gets a
  // crack at it — not just the single nearest — so a weak-side rim protector
  // blocks a guard who beat his man, which is where blocks actually come from.
  // Rim finishes are challenged with ヘッド (dunk/rim protection) + ジャンプ +
  // 守判断; jumpers with ジャンプ + 反応 + 守判断; both reward a real height edge
  // and a tight contest. The best available shot-blocker is the one who goes up.
  // evadeOK: whether the shooter may dodge a would-be block with S技術 (the
  // double-clutch). Finishes always can; jump shots inside the arc (ミドル/ゴール下)
  // now can too, so a high-S技術 scorer shoots OVER/AROUND a contest instead of
  // always being swatted. Threes don't (evadeOK=false there).
  private tryBlock(shooter: Player, isFinish: boolean, evadeOK = isFinish): Player | null {
    // finishes can be met by help rotating over from the paint; a perimeter
    // jumper only by a man right in the shooter's face
    // a jumper is contestable a touch further out now that the defender closes
    // out during the gather (updateCharge), not just if he was already glued on
    const range = isFinish ? 2.1 : 1.7;
    // a LONG gather (a deep heave / a slow, low-S技術 release) is a sitting duck:
    // the defender has time to set and rise into it, so the block chance climbs
    // with the wind-up. A quick catch-and-shoot barely gives him a window.
    const windupEdge = isFinish ? 0 : clamp(this.shotWindup - 0.3, 0, 0.8);
    let best: Player | null = null;
    let bestP = 0;
    for (const d of this.teamPlayers(1 - shooter.team)) {
      const dd = dist2D(d.pos, shooter.pos);
      if (dd > range) continue;
      const blk = isFinish
        ? rate(d.attr.jump) * 0.4 + rate(d.attr.dunk) * 0.35 + rate(d.attr.defense) * 0.25
        : rate(d.attr.jump) * 0.42 + rate(d.attr.reaction) * 0.3 + rate(d.attr.defense) * 0.28;
      const close = 1 - dd / range;              // 1 = on the shooter, 0 = at the edge
      // height is a real rim-protection edge: length swats shots the shorter
      // defender can't reach
      const heightAdv = clamp((d.height - shooter.height) * 0.9, -0.25, 0.4);
      let p = (isFinish ? 0.30 : 0.23) * (0.2 + blk * 1.35) * close + heightAdv * close;
      p += windupEdge * (0.18 + blk * 0.2) * close;   // a slow gather is more blockable
      // ALREADY IN THE AIR when the shot goes up (read the gather, rose into it):
      // hands are at their peak right in the shooting pocket
      if (d.airborne) p += 0.18 * close;
      // ...but a man who jumped TOO early is coming down / regathering as the
      // shot releases — barely a contest at all (the gamble's other edge)
      else if (d.landT > 0) p *= 0.3;
      // 弾道高さ: a high, rainbowing jumper sails over the contest; a flat one is
      // there to be swatted. (Rim finishes are a different motion — arc n/a.)
      if (!isFinish) p *= clamp(1.5 - rate(shooter.attr.bank), 0.5, 1.5);
      p = clamp(p, 0, 0.7);
      if (p > bestP) { bestP = p; best = d; }
    }
    if (!best || !chance(bestP)) return null;
    // イベイド（ダブルクラッチ）: フィニッシュ限定 — 伸びてきたブロックの手を
    // 空中でかわしてシュートまで行く。S技術(空中で打ち直す技巧)+敏捷性が高い
    // ほど成功し、ブロッカーのリムプロテクト(ヘッド)と身長差が高い壁になる。
    if (evadeOK) {
      const pEvade = clamp(
        rate(shooter.attr.shotTech) * 0.5 + rate(shooter.attr.agility) * 0.25
        - rate(best.attr.dunk) * 0.2
        - Math.max(0, best.height - shooter.height) * 0.5
        - 0.12,
        0.03, 0.7);
      if (chance(pEvade)) {
        // the swat WHIFFS — the blocker still rises, the shooter hangs and
        // re-shapes the shot. The adjusted release is a touch harder to convert,
        // but S技術 keeps the mechanics clean even mid-air.
        if (!best.airborne) best.jump(0.9, 0.6);
        // the double-clutch re-route is a FINISH motion (ball pulled under the
        // swat, around the blocker); a jump shot just gets it off over the hand,
        // so the curved-ball visual (evadedFinish) is finish-only.
        if (isFinish) {
          this.evadedFinish = true;
          const ex = shooter.pos.x - best.pos.x, ez = shooter.pos.z - best.pos.z;
          const el = Math.hypot(ex, ez) || 1;
          this.evadeDirX = ex / el;
          this.evadeDirZ = ez / el;
        }
        if (this.shotMade && chance(0.18 * (1 - rate(shooter.attr.shotTech)))) this.shotMade = false;
        return null;
      }
    }
    return best;
  }

  // The shot is swatted: the blocker goes up, the ball comes loose at the rim.
  private swatShot(shooter: Player, blocker: Player): void {
    blocker.stats.blk++;
    shooter.stats.fga++;             // a blocked shot is a missed attempt
    if (this.shotPoints === 3) shooter.stats.tpa++;
    this.pendingAssist = null;
    // the blocker rises and meets the ball with his hand right at the release —
    // but he may ALREADY be up (he jumped during the gather), so don't re-jump
    // (that would reset his leap and break the contact read)
    if (!blocker.airborne) blocker.jump(0.95, 0.6);
    this.setEvent("BLOCK!", blocker.team);
    this.handler = null;

    // The hand SWATS the ball off its flight: it is knocked away from the block
    // point (the shooter's release), rejected back OUT away from the rim with a
    // sideways spray, then falls under gravity as a live loose ball. A stronger
    // blocker (ジャンプ/守判断) sends it further.
    const rim = this.attackFloor(shooter.team);
    let ox = shooter.pos.x - rim.x, oz = shooter.pos.z - rim.z;
    let ol = Math.hypot(ox, oz);
    if (ol < 0.9) {                            // a rim finish: swat it out toward the floor
      ox = rand(-1, 1); oz = -Math.sign(rim.z || 1) * rand(0.6, 1.3);
      ol = Math.hypot(ox, oz) || 1;
    }
    ox /= ol; oz /= ol;
    const px = -oz, pz = ox, kick = rand(-0.8, 0.8);   // sideways spray off the hand
    const power = 3.0 + (rate(blocker.attr.jump) * 0.5 + rate(blocker.attr.defense) * 0.5) * 3.0;
    // CONTACT POINT = the BLOCKER's hand, not the shooter's space: place the ball
    // just in front of the blocker (toward the shooter), up at the top of his reach,
    // so it's WITHIN his reach and the hand visibly lands on it — the ball is
    // knocked away FROM his hand, not teleported off the shooter.
    let hx = shooter.pos.x - blocker.pos.x, hz = shooter.pos.z - blocker.pos.z;
    const hl = Math.hypot(hx, hz) || 1;
    this.ball.pos.set(blocker.pos.x + (hx / hl) * 0.45, 2.6, blocker.pos.z + (hz / hl) * 0.45);
    // the ball STOPS DEAD on the hand for a beat (blockHoldT) — the contact reads —
    // then it's swatted mostly OUT and DOWN. Hold the deflection velocity until the
    // pin releases (updateLoose), keeping the ball pinned at the hand until then.
    this.blockHoldVel.set((ox + px * kick) * power, rand(-0.6, 1.0), (oz + pz * kick) * power);
    this.blockHoldT = 0.13;
    this.ball.vel.setAll(0);
    blocker.reach(this.ball.pos, true);        // hand on the ball at contact
    this.lastTouch = blocker;                  // he last touched it → out-of-bounds stays with the offence
    // the SHOOTER can't recover it while he is still in his shot motion / landing
    // (no instantly re-grabbing his own blocked shot), and grabAfter keeps it a
    // clear, free, rolling loose ball before ANYONE can secure it.
    shooter.touchCool = 1.0;
    // FREEZE his follow-through: releaseShot never got to set coolT (the block
    // returned first), so set it here — otherwise the loose-ball pose lets his
    // airborne arms snap toward the swatted ball as if he threw it there. With
    // coolT up, poseHands excludes him from the scramble and holds his release form.
    shooter.coolT = 0.6 + rand(0.3, 0.6) * shooter.recoveryMult();
    this.goLoose(shooter.team, 2.6, { rebound: true, grabAfter: 0.6 });
  }

  // ---- fouls & free throws ----------------------------------------------

  // Was the shot fouled? Contact is more likely on contested layups. If so,
  // send the shooter to the line (and-one if the shot still went in).
  private tryShootingFoul(h: Player, dDef: number, layup: boolean): boolean {
    let base = layup ? 0.20 : 0.05;
    // a defender who left his feet early crashes INTO the shooter far more
    // often — the built-in risk of the gamble
    const od = this.onBallDefender(h);
    if (od && od.airborne && dist2D(od.pos, h.pos) < 1.3) base += 0.08;
    const p = base * clamp(1.3 - dDef, 0, 1.3); // tighter contest => more contact
    if (!chance(p)) return false;

    if (this.shotMade) {
      // AND-ONE: by rule the basket has to actually GO IN — so don't
      // short-circuit here. Let the shot fly and drop like any other make;
      // resolveShot sees the pending foul, counts it, then awards the one shot.
      this.pendingAndOne = h;
      return false;
    }

    // fouled on the MISS: no basket — straight to the line for two (three)
    this.contestJump(h);
    this.handler = null;
    this.pendingAssist = null;
    // knocked away from the contesting defender, harder if he's strong/aggressive
    const fpx = od ? h.pos.x - od.pos.x : 0;
    const fpz = od ? h.pos.z - od.pos.z : 0;
    const fs = od ? clamp(0.3 + rate(od.attr.balance) * 0.4 + rate(od.attr.aggression) * 0.2
      - rate(h.attr.balance) * 0.35, 0.1, 1) : 0.5;
    h.foulReaction("hurt", fpx, fpz, fs);   // sell the contact during the dead-ball beat
    this.setEvent("SHOOTING FOUL", h.team, 1.8);
    const count = this.shotPoints;
    // hold so the foul reads, then go to the line
    this.pauseThen(1.3, () => this.startFreeThrows(h, count));
    return true;
  }

  private startFreeThrows(shooter: Player, count: number): void {
    this.handler = null;
    this.possession = shooter.team;
    this.ftTeam = shooter.team;
    this.ftShooter = shooter;
    this.ftRemaining = count;
    this.ballMode = "freethrow";

    const sign = this.attackSign(shooter.team);
    const ftZ = sign * (COURT.halfL - 5.8); // free-throw line at the basket he attacks
    shooter.pos.set(0, 0, ftZ);
    this.lineUpForFreeThrow(shooter, sign);
    this.beginFreeThrowAttempt();
  }

  // Place everyone except the shooter along the lane / out top.
  private lineUpForFreeThrow(shooter: Player, sign: number): void {
    const slots: number[][] = [
      [-2.4, 1.0], [2.4, 1.0], [-2.4, 2.4], [2.4, 2.4], [-2.4, 3.8], [2.4, 3.8],
      [-5.0, 1.5], [5.0, 1.5], [0, 8.5],
    ]; // [x, distance inward from the baseline]
    let i = 0;
    for (const p of this.players) {
      if (p === shooter) continue;
      const s = slots[i % slots.length];
      p.pos.set(s[0], 0, sign * (COURT.halfL - s[1]));
      p.cutting = false;
      i++;
    }
  }

  private beginFreeThrowAttempt(): void {
    this.ftT = 0;
    // FK precision, shaken by fatigue / the scoreboard for a weak 精神;
    // a PKキッカー has the routine grooved in
    const p = 0.5 + rate(this.ftShooter.attr.freeThrow) * 0.45
      + (this.ftShooter.has("ftKicker") ? 0.08 : 0)
      - this.clutchFactor(this.ftShooter) * 0.15;
    this.ftMade = chance(clamp(p, 0.3, 0.97));
    this.ball.pos.set(this.ftShooter.pos.x, 1.2, this.ftShooter.pos.z);
  }

  private updateFreeThrow(dt: number): void {
    this.ftT += dt;
    const setup = 0.6, shotDur = 0.8;

    if (this.ftT < setup) {
      // shooter holds the ball at the line
      this.ball.pos.set(this.ftShooter.pos.x, 1.2, this.ftShooter.pos.z);
      return;
    }
    if (this.ftT < setup + shotDur) {
      const k = (this.ftT - setup) / shotDur;
      const a = this.ftShooter.pos, b = this.attackRim(this.ftTeam);
      const baseY = 2.0 + (b.y - 2.0) * k;
      // 弾道高さ: the free-throw arc rises with the rating too (uncontested, so
      // it's the visual — a flat vs a high, soft trajectory)
      const ftArc = 1.2 + rate(this.ftShooter.attr.bank) * 1.2;
      this.ball.pos.set(a.x + (b.x - a.x) * k, baseY + Math.sin(k * Math.PI) * ftArc, a.z + (b.z - a.z) * k);
      return;
    }

    // resolve this attempt
    this.ftShooter.stats.fta++;
    if (this.ftMade) {
      this.score[this.ftTeam] += 1;
      this.ftShooter.stats.pts += 1;
      this.ftShooter.stats.ftm++;
      this.benchCheer(this.ftTeam, 1.2);   // a quicker pop for a free throw
      this.swishNet(this.ftTeam);          // the net snaps on the make
    }
    this.ftRemaining -= 1;
    if (this.ftRemaining > 0) {
      this.beginFreeThrowAttempt();
      return;
    }
    // last free throw done
    if (this.ftMade) {
      const conceding = 1 - this.ftTeam;
      this.setEvent("GOOD", this.ftTeam);
      this.handler = null;
      this.pauseThen(1.1, () => this.withSubs(() => this.startInbound(conceding)));
    } else {
      this.possession = this.ftTeam;       // missed: live rebound
      this.startRebound();
    }
  }

  // Non-shooting (reach-in) foul: the offence keeps the ball and inbounds.
  private defensiveFoul(victim: Player, fouler?: Player): void {
    // knocked AWAY from the man who hit him; how hard depends on the fouler's
    // strength/aggression vs how well the victim keeps his balance
    let px = 0, pz = 0, strength = 0.5;
    if (fouler) {
      px = victim.pos.x - fouler.pos.x;
      pz = victim.pos.z - fouler.pos.z;
      strength = clamp(0.3 + rate(fouler.attr.balance) * 0.4 + rate(fouler.attr.aggression) * 0.2
        - rate(victim.attr.balance) * 0.35, 0.1, 1);
    }
    victim.foulReaction("hurt", px, pz, strength);   // rock off the contact while play stops
    this.setEvent("FOUL", victim.team);
    this.possession = victim.team;
    this.handler = null;
    this.shotClock = Math.max(this.shotClock, SHOT_CLOCK_PARTIAL); // partial reset on a foul
    // hold so the foul reads, then subs, then the side inbound (the fouled
    // player takes the ball in, so he can't be subbed here)
    this.pauseThen(1.2, () => this.withSubs(() => this.sideInbound(victim), victim));
  }

  private sideInbound(victim: Player): void {
    this.possession = victim.team;
    this.handler = victim;
    this.ballMode = "inbound";
    this.inboundT = 1.0;
    // whose ball the restart is (the foul call has had its beat on screen)
    this.setEvent(`THROW-IN\n${teamShort(victim.team)} BALL`, victim.team, 2.0);
    const sideX = victim.pos.x >= 0 ? COURT.halfW + 0.3 : -(COURT.halfW + 0.3);
    victim.pos.set(sideX, 0, clamp(victim.pos.z, -COURT.halfL + 1, COURT.halfL - 1));
    this.resetMotion();
    this.inboundReceiver = this.pickInboundReceiver(victim);
  }

  // True if the path from the handler to the rim is free of defenders.
  private laneClear(h: Player, rimFloor: Vector3): boolean {
    const ax = h.pos.x, az = h.pos.z;
    const dx = rimFloor.x - ax, dz = rimFloor.z - az;
    const len2 = dx * dx + dz * dz || 1;
    for (const d of this.teamPlayers(1 - h.team)) {
      const t = ((d.pos.x - ax) * dx + (d.pos.z - az) * dz) / len2;
      if (t <= 0.05 || t >= 1) continue;             // not between handler and rim
      const px = ax + dx * t, pz = az + dz * t;
      if (Math.hypot(d.pos.x - px, d.pos.z - pz) < 1.1) return false; // defender in the lane
    }
    return true;
  }

  // Where the ball actually flies. A make heads for the rim centre; a miss heads
  // for a point AROUND the rim / off the backboard — never dead-centre (that
  // reads like a make) and never way out of bounds. A farther shot scatters a
  // bit more, but it always stays by the basket, so it can be rebounded.
  private aimShotTarget(dHoop: number): void {
    const rim = this.attackRim(this.possession);
    this.shotTarget.copyFrom(rim);
    if (this.shotMade) return;
    const scatter = 0.4 + Math.min(1, Math.max(0, dHoop - THREE_DIST) / 8) * 0.55;   // 0.4 .. ~0.95
    const zSign = Math.sign(rim.z) || 1;
    this.shotTarget.x = rim.x + rand(-1, 1) * scatter;
    this.shotTarget.z = rim.z + zSign * rand(0.05, 0.3 + scatter * 0.5);   // biased long, toward the backboard
    this.shotTarget.y = RIM.height + rand(-0.2, 0.5);
  }

  private updateShot(dt: number): void {
    this.crashBoards(dt); // everyone converges on the glass while the shot is up

    this.shotT += dt;
    const k = Math.min(1, this.shotT / this.shotDur);
    const b = this.shotTarget;   // rim on a make, off-target on a miss
    // FINISH (dunk / layup): the ball rides up out of the finisher's HAND and into
    // the rim on ONE smooth arc — no mid-air kink. Horizontally it eases from where
    // his hand IS (he's gliding in) to the rim; vertically it rises to a peak (a
    // slam sits above the rim) then drops through. The arm tracks the ball the whole
    // way (poseHands), so the hand and ball stay linked.
    if (this.shooterFinishing && this.shooter) {
      const fin = this.shooter;
      const e = k * k * (3 - 2 * k);                 // smoothstep — continuous velocity
      const top = this.shotFrom.y;                   // take-off hand height (2.6 dunk / 1.7 layup)
      const peak = Math.max(top, b.y) + this.shotApex;
      let x = fin.pos.x + (b.x - fin.pos.x) * e;
      let y = top + (b.y - top) * e + Math.sin(k * Math.PI) * (peak - Math.max(top, b.y));
      let z = fin.pos.z + (b.z - fin.pos.z) * e;
      // ダブルクラッチ: イベイドしたフィニッシュはボールを一度スワットの下へ
      // 引き込み、ブロッカーと反対側へ体側で回してからリムへ運び直す。腕は
      // poseHands でボールに追従するので、この軌道の曲がりがそのまま「手を
      // かわす」動きとして見える（窓は飛行の18..68%、両端でゼロ=軌道は滑らか）。
      if (this.evadedFinish) {
        const c = Math.sin(clamp((k - 0.18) / 0.5, 0, 1) * Math.PI);
        y -= c * 0.38;                               // pull DOWN out of the swat
        x += this.evadeDirX * c * 0.25;              // swing around the blocker's side
        z += this.evadeDirZ * c * 0.25;
      }
      this.ball.pos.set(x, y, z);
      if (k >= 1) this.resolveShot();
      return;
    }
    const a = this.shotFrom;
    const baseY = a.y + (b.y - a.y) * k;
    const apex = Math.sin(k * Math.PI) * this.shotApex;
    this.ball.pos.set(a.x + (b.x - a.x) * k, baseY + apex, a.z + (b.z - a.z) * k);

    if (k >= 1) this.resolveShot();
  }

  private resolveShot(): void {
    // a deep bomb keeps the ball cam on through the landing/bounce, so the
    // viewer sees whether it dropped before the frame eases back out
    if (this.longShot) { this.longShotHoldT = 1.6; this.longShot = false; }
    const shooter = this.possession;
    const sh = this.shooter;
    if (sh) { sh.stats.fga++; if (this.shotPoints === 3) sh.stats.tpa++; }
    const andOne = this.shotMade && sh !== null && this.pendingAndOne === sh;
    if (this.shotMade) {
      this.score[shooter] += this.shotPoints;
      if (sh) {
        sh.stats.pts += this.shotPoints; sh.stats.fgm++;
        if (this.shotPoints === 3) sh.stats.tpm++;
      }
      if (this.pendingAssist) this.pendingAssist.stats.ast++;
      this.setEvent(andOne ? "AND-1" : this.shotPoints === 3 ? "3 POINTS!" : "2 POINTS",
        shooter, 1.8, { scorer: sh?.name, assist: this.pendingAssist?.name });
      // a dunk or a three brings the whole bench up bouncing; a routine two is a
      // smaller pop
      const big = this.shotPoints === 3 || this.shotWasDunk;
      this.benchCheer(shooter, big ? 2.6 : 1.7, big ? 1.0 : 0.4);
      // the ball drops through the net and bounces on the floor during the hold
      const rim = this.attackRim(shooter);
      this.ball.pos.set(rim.x, RIM.height - 0.15, rim.z);
      this.ball.vel.set(rand(-0.5, 0.5), -2.4, -Math.sign(rim.z || 1) * rand(0.2, 0.8));
      this.ballFalling = true;
      this.swishNet(shooter);   // net snaps + rim flashes on the make
      // hold on the made basket so the viewer sees it, then subs, then inbound —
      // unless the buzzer already sounded (buzzer beater): the period ends here.
      // An AND-1 continues at the line instead: basket counts + one free throw.
      this.handler = null;
      // AND-1: the scorer flexes over the made bucket, THEN heads to the line
      if (andOne) { sh!.foulReaction("and1"); this.pauseThen(1.4, () => this.startFreeThrows(sh!, 1)); }
      else if (this.gameClock <= 0) this.pauseThen(1.4, () => this.endQuarter());
      else this.pauseThen(1.4, () => this.withSubs(() => this.startInbound(1 - shooter)));
    } else {
      this.setEvent("MISS", shooter);
      if (this.gameClock <= 0) { this.handler = null; this.endQuarter(); }
      else this.startRebound();
    }
    this.pendingAssist = null;
    this.pendingAndOne = null;
  }

  // The teammate (if any) whose pass set up this shooter — credited an assist if
  // the shot drops. Requires the shooter to be the player who caught the pass.
  private assistCreditFor(shooter: Player): Player | null {
    return (this.assistTo === shooter && this.assistFrom && this.assistFrom !== shooter)
      ? this.assistFrom : null;
  }

  // Freeze the scene for a moment (dead ball), then run the next phase. Lets a
  // score or foul register before play switches.
  private pauseThen(seconds: number, next: () => void): void {
    this.pauseT = seconds;
    this.pauseNext = next;
    this.ballMode = "pause";
  }

  private updatePause(dt: number): void {
    // after a made basket the ball drops through the net and bounces on the
    // floor; otherwise it just settles down to rest
    if (this.ballFalling) this.stepBallFreeFlight(dt);
    else this.ball.pos.y = Math.max(0.3, this.ball.pos.y - 3 * dt);
    // OUT OF BOUNDS: the thrower walks over to the spot during the announcement
    // (tickMotion/updateLegs animate the walk from his moved position)
    if (this.oobWalker) {
      moveToward2D(this.oobWalker.pos, this.oobSpot.x, this.oobSpot.z,
        this.oobWalker.runSpeed * 0.6 * dt);
    }
    this.pauseT -= dt;
    if (this.pauseT <= 0) {
      this.ballFalling = false;
      const next = this.pauseNext;
      this.pauseNext = null;
      if (next) next();
    }
  }

  // Put the ball into a free, falling, contestable state. `offense` is the team
  // that was attacking when it came loose (decides the rebound label / clock).
  private goLoose(offense: number, timeout: number,
                  opts: { rebound?: boolean; fromRim?: boolean; stealBy?: Player | null; victim?: Player | null; grabAfter?: number } = {}): void {
    this.looseOff = offense;
    this.looseT = timeout;
    this.looseTips = 0;
    this.looseIsRebound = opts.rebound ?? false;
    // did the ball come off the RIM (a genuine rebound)? Only then does an
    // offensive recovery reset the shot clock (to the partial). A block, strip or
    // fumble did NOT hit the rim, so the offence just plays on with the clock
    // running — no reset (NBA Rule 7: the 14-second reset needs rim contact).
    this.looseFromRim = opts.fromRim ?? false;
    this.looseStealBy = opts.stealBy ?? null;
    this.looseStealVictim = opts.victim ?? null;
    this.looseAge = 0;
    this.looseGrabAfter = opts.grabAfter ?? 0;  // a beat where the ball is visibly free before anyone can secure it
    this.handler = null;
    this.ballMode = "loose";
    for (const p of this.players) p.touchCool = 0;
    // reaction to the ball coming loose: everyone needs a beat before they react
    // and give chase, and 反応 sets how long. A quick-reacting player pounces first
    // while a slow one is still turning to it — scrambles are no longer won purely
    // on who happened to be standing closest. (reactionLag ≈0.6 elite .. ≈1.35 poor.)
    for (const p of this.players) p.looseReactT = rand(0.35, 0.55) * this.reactionLag(p);
  }

  // After a miss the ball caroms off the rim and is live: it falls under gravity
  // and anyone who can get a hand to it tips or grabs it (see updateLoose).
  private startRebound(): void {
    const rim = this.attackRim(this.possession);
    this.ball.pos.set(rim.x + rand(-0.3, 0.3), RIM.height + 0.1, rim.z + rand(-0.2, 0.2));
    // off the iron: up a touch, then outward back toward the floor
    this.ball.vel.set(rand(-2.2, 2.2), rand(1.0, 2.6), -Math.sign(rim.z || 1) * rand(0.4, 2.4));
    this.goLoose(this.possession, 2.6, { rebound: true, fromRim: true });   // came off the iron

    // the bigs (and anyone right at the rim) leap to fight for the board
    const rimFloor = this.attackFloor(this.possession);
    for (const p of this.players) {
      const d = dist2D(p.pos, rimFloor);
      if (d < 2.8 && (this.isBig(p) || d < 1.4)) p.jump(this.isBig(p) ? 0.7 : 0.5, 0.6);
    }
  }

  // One frame of ball free-flight: gravity, a floor bounce that keeps a little
  // energy (so it dribbles to rest like a real basketball), and reflection off
  // the court boundary. Shared by the loose ball and the cosmetic drop after a
  // made basket. `restY` is the floor contact height (ball radius).
  private stepBallFreeFlight(dt: number, reflect = true): void {
    const b = this.ball;
    b.vel.y -= 9.0 * dt;
    b.pos.x += b.vel.x * dt;
    b.pos.y += b.vel.y * dt;
    b.pos.z += b.vel.z * dt;
    // bounce off the floor, losing energy (a rolling-to-rest dribble)
    if (b.pos.y < 0.12) { b.pos.y = 0.12; b.vel.y = Math.abs(b.vel.y) * 0.62; b.vel.x *= 0.72; b.vel.z *= 0.72; }
    // reflect off the court boundary to keep it in play — but a LIVE loose ball
    // (reflect = false) is allowed to cross the line so it can go out of bounds
    // and become a throw-in (updateLoose detects the crossing).
    if (reflect) {
      const mw = COURT.halfW - 0.1, ml = COURT.halfL - 0.1;
      if (b.pos.x < -mw) { b.pos.x = -mw; b.vel.x = Math.abs(b.vel.x) * 0.6; }
      if (b.pos.x > mw) { b.pos.x = mw; b.vel.x = -Math.abs(b.vel.x) * 0.6; }
      if (b.pos.z < -ml) { b.pos.z = -ml; b.vel.z = Math.abs(b.vel.z) * 0.6; }
      if (b.pos.z > ml) { b.pos.z = ml; b.vel.z = -Math.abs(b.vel.z) * 0.6; }
    }
    // clamp speed so a bad bounce can never send it flying (stays deterministic)
    const sp = Math.hypot(b.vel.x, b.vel.y, b.vel.z);
    if (sp > 10) { const k = 10 / sp; b.vel.x *= k; b.vel.y *= k; b.vel.z *= k; }
  }

  private updateLoose(dt: number): void {
    if (this.blockHoldT > 0) {
      // BLOCK CONTACT: the swatted ball stops dead on the blocker's hand for a
      // beat so the hit reads, then the deflection velocity is released.
      this.blockHoldT -= dt;
      if (this.blockHoldT <= 0) this.ball.vel.copyFrom(this.blockHoldVel);
    } else {
      this.stepBallFreeFlight(dt, false);   // a live loose ball may cross the line
      // OUT OF BOUNDS → throw-in for the team that did NOT touch it last (e.g. a
      // block swatted out off the defender's hand stays with the offence).
      const b = this.ball.pos;
      if (Math.abs(b.x) > COURT.halfW || Math.abs(b.z) > COURT.halfL) {
        const to = this.lastTouch ? 1 - this.lastTouch.team : 1 - this.looseOff;
        this.startInboundAt(to, b.x, b.z);
        return;
      }
    }
    for (const p of this.players) if (p.touchCool > 0) p.touchCool = Math.max(0, p.touchCool - dt);

    this.looseAge += dt;
    this.chaseLoose(dt);
    // hold off securing for a beat so a steal/deflect reads as a real scramble
    if (this.looseAge >= this.looseGrabAfter) this.resolveLooseContact();
    if (this.ballMode !== "loose") return;   // someone secured it this frame

    this.looseT -= dt;
    if (this.looseT <= 0) {                    // safety net: nearest player comes up with it
      let near = this.players[0];
      for (const p of this.players) {
        if (dist2DTo(this.ball.pos, p.pos.x, p.pos.z) < dist2DTo(this.ball.pos, near.pos.x, near.pos.z)) near = p;
      }
      this.secureLoose(near);
    }
  }

  // Only a few players actually contest a loose ball; the rest spread out to
  // get ready for the next play rather than everyone collapsing into a pile.
  // Contesters: the nearest of each team (so it's a real battle), plus any extra
  // who are genuinely close, capped at three total.
  private chaseLoose(dt: number): void {
    const bx = this.ball.pos.x, bz = this.ball.pos.z;
    const distToBall = (p: Player) => dist2DTo(p.pos, bx, bz);

    // tick down each player's reaction-to-the-loose-ball delay
    for (const p of this.players) if (p.looseReactT > 0) p.looseReactT -= dt;

    const contest = new Set<Player>();
    for (const team of [0, 1]) {                 // the closest man on each team goes
      let near = this.teamPlayers(team)[0];
      for (const p of this.teamPlayers(team)) if (distToBall(p) < distToBall(near)) near = p;
      contest.add(near);
    }
    const order = [...this.players].sort((a, b) => distToBall(a) - distToBall(b));
    for (const p of order) {                      // fill up to three, but only truly close ones
      if (contest.size >= 3) break;
      if (!contest.has(p) && distToBall(p) < 2.5) contest.add(p);
    }
    // a dedicated リバウンダー crashes every scramble he can reach — that IS the
    // job — even when he isn't among the closest men
    for (const p of this.players) {
      if (p.evalRole === "リバウンダー" && distToBall(p) < 7) contest.add(p);
    }

    for (const p of this.players) {
      if (contest.has(p)) {
        // still reacting to the ball coming loose → hasn't set off yet, so a
        // quicker-reacting (higher 反応) opponent gets a head start on the chase
        if (p.looseReactT > 0) continue;
        // chase the ball AROUND bodies in the way — a scramble is still not a
        // licence to run straight through someone's back
        const cv = this.steerAround(p, bx, bz);
        moveToward2D(p.pos, cv.x, cv.z, p.accelSpeed(dt, this.isBig(p) ? 1.0 : 0.9) * dt);
        this.clampCourt(p.pos);
        // time a jump to a ball that's up in the air and within a stride
        if (!p.airborne && this.ball.pos.y > 1.7 && distToBall(p) < 1.3) {
          p.jump(0.55 + rate(p.attr.jump) * 0.45, 0.6);
        }
      } else {
        // not contesting → drift to a spacing spot, ready for whatever comes next
        const spot = this.formationSpots(p.team)[p.slot];
        moveToward2D(p.pos, spot.x, spot.z, p.accelSpeed(dt, 0.8) * dt);
        this.clampCourt(p.pos);
      }
    }
  }

  // The best-placed player able to get a hand on the ball makes contact.
  private resolveLooseContact(): void {
    let best: Player | null = null;
    let bestReach = -Infinity;
    for (const p of this.players) {
      if (p.touchCool > 0) continue;
      if (p.looseReactT > 0) continue;   // hasn't reacted to the loose ball yet
      if (dist2DTo(this.ball.pos, p.pos.x, p.pos.z) > 0.6) continue;
      const top = p.reachTopY();
      if (this.ball.pos.y > top || this.ball.pos.y < 0.3) continue; // out of reach high/low
      if (top > bestReach) { bestReach = top; best = p; }
    }
    if (best) this.contactLooseBall(best);
  }

  // A hand reaches the ball: secure it (clean catch) or tip it (deflect the
  // trajectory). ジャンプ/反応/バランス and height drive how often it's secured;
  // defenders box out (守判断) for an edge. After a few tips the next is forced.
  private contactLooseBall(p: Player): void {
    this.lastTouch = p;   // a hand on the ball — decides a subsequent out-of-bounds
    const defending = p.team !== this.looseOff;
    const rebSkill = rate(p.attr.jump) * 0.3 + rate(p.attr.reaction) * 0.25
      + rate(p.attr.balance) * 0.2;
    const heightEdge = clamp((p.height - 1.95) * 0.25, -0.1, 0.12);
    let secure = 0.28 + rebSkill * 0.55 + heightEdge;
    if (defending) secure += 0.05 + rate(p.attr.defense) * 0.06;  // boxing out
    if (this.looseTips >= 3) secure = 1;      // don't let it pinball forever
    if (chance(clamp(secure, 0.1, 0.96))) {
      this.secureLoose(p);
    } else {
      // tipped: deflect the ball up and away — the trajectory genuinely changes
      this.looseTips++;
      p.touchCool = 0.22;
      const a = rand(0, Math.PI * 2);
      this.ball.vel.set(Math.cos(a) * rand(0.6, 1.9), rand(2.4, 3.8), Math.sin(a) * rand(0.6, 1.9));
      p.jump(0.4, 0.45);
      this.setEvent("TIP", p.team);
    }
  }

  // A player comes down with the loose ball and play resumes.
  private secureLoose(p: Player, label?: string): void {
    this.lastTouch = p;
    const offensive = p.team === this.looseOff;
    if (this.looseIsRebound) p.stats.reb++;   // only count boards off a missed shot
    if (!offensive && this.looseStealBy) {    // the defence came up with a poked-loose ball
      this.looseStealBy.stats.stl++;          // steal credited to whoever knocked it free
      if (this.looseStealVictim) this.looseStealVictim.stats.tov++;
    }
    this.looseStealBy = this.looseStealVictim = null;
    this.handler = p;
    this.possession = p.team;
    this.ballMode = "held";
    // shot clock: a change of possession is a full reset; an offensive rebound OFF
    // THE RIM gets the partial reset; any other offensive recovery (a blocked shot,
    // a strip, a fumble — no rim contact) just plays ON with the clock running.
    if (!offensive) this.shotClock = SHOT_CLOCK;
    else if (this.looseFromRim) this.shotClock = Math.max(this.shotClock, SHOT_CLOCK_PARTIAL);
    p.decisionT = 0.4;
    this.ball.vel.set(0, 0, 0);
    this.resetMotion();
    if (!offensive) this.maybeStartPush();   // change of possession → run the break
    this.leakOut();          // 飛び出し runners take off on the change of possession
    p.jump(0.35, 0.4);
    this.setEvent(label ?? (offensive ? "OFF. REBOUND" : "REBOUND"), p.team);
  }

  // The bigs (power forward & centre) crash the glass and set screens; their
  // position label drives this, so a role change in the editor takes effect.
  private isBig(p: Player): boolean {
    return p.role === "PF" || p.role === "C";
  }

  // Whether this player belongs on the low block in the half-court set. Bigs
  // live at the goal — only a genuine stretch threat spaces to the perimeter
  // instead (rare on this DB's compressed scale: C の L精度 is 65..83, so the
  // bar is 75+, or ロングレンジ with 70+). A ポスト/ペイント specialist plants
  // himself there regardless of position.
  private prefersPost(p: Player): boolean {
    // a designated ストレッチ spaces the floor instead of posting, whatever
    // his ratings say; a プレイメイキングビッグ works from the top, not the
    // block; スクリーナー/リムランナー explicitly live inside
    if (p.evalRole === "ストレッチ" || p.evalRole === "プレイメイキングビッグ") return false;
    if (p.evalRole === "スクリーナー" || p.evalRole === "リムランナー") return this.isBig(p);
    if (p.has("post") || p.has("centerSpot")) return true;
    if (!this.isBig(p)) return false;
    const acc = rate(p.attr.threeAcc);
    const stretch = acc >= 0.75 || (p.has("range") && acc >= 0.7);
    if (stretch) return false;
    // one low-post anchor at a time: when the C is a post player, the PF spaces
    // the floor instead — two bigs stationed at the goal turns the paint into a
    // scrum (a PF with ポスト/ペイント above still claims it)
    if (p.role === "PF") {
      const c = this.teamPlayers(p.team).find((q) => q.role === "C");
      if (c && c !== p && this.prefersPost(c)) return false;
    }
    return true;
  }

  // The formation spot a player claims when a possession starts fresh: a post
  // big heads straight for his block (PF left, C right), everyone else takes
  // the perimeter spot matching his slot.
  private homeSpotIdx(p: Player): number {
    if (this.isBig(p) && this.prefersPost(p)) return p.slot === 3 ? 5 : 6;
    return p.slot;
  }

  // On a shot, the bigs (PF/C) crash the glass hard while guards/wings hold a
  // step back, ready for a long board or to get back in transition.
  private crashBoards(dt: number): void {
    const rimFloor = this.attackFloor(this.possession);
    for (const p of this.players) {
      // a finisher carries his DRIVE MOMENTUM into the air: he takes off at the
      // speed he was running and that speed decays over the leap, so he travels
      // in stride through the take-off instead of decelerating to a plant first
      // (which read as a stop-then-jump). A light steer toward the gather point
      // curls him in to finish at the rim. The ball goes on up to the hoop.
      if (p === this.shooter && this.ballMode === "shot" && this.shooterFinishing) {
        const decay = Math.exp(-dt / 0.33);     // momentum bleeds off (τ≈0.33s)
        this.finishVX *= decay;
        this.finishVZ *= decay;
        p.pos.x += this.finishVX * dt;
        p.pos.z += this.finishVZ * dt;
        moveToward2D(p.pos, this.finishSpot.x, this.finishSpot.z, p.runSpeed * 0.18 * dt);
        this.clampCourt(p.pos);
        continue;
      }
      // a shooter following through can't crash the glass until he recovers
      if (p.rooted) { this.clampCourt(p.pos); continue; }
      const big = this.isBig(p) || p.has("centerSpot"); // センター: crashes like a big
      // bigs crash to the rim; wings support from rebound range; the point guard
      // hangs back as the safety to stop the break
      const standoff = big ? 0.8 : (p.role === "PG" ? 6.5 : 4.2);
      const dx = p.pos.x - rimFloor.x, dz = p.pos.z - rimFloor.z;
      const len = Math.hypot(dx, dz) || 1;
      const tx = rimFloor.x + (dx / len) * standoff;
      const tz = rimFloor.z + (dz / len) * standoff;
      const speed = p.accelSpeed(dt, big ? 0.95 : 0.6); // bigs commit, guards hang back
      moveToward2D(p.pos, tx, tz, speed * dt);
      this.clampCourt(p.pos);
    }
  }

  private startInbound(team: number): void {
    this.possession = team;
    // the basket was made by the other team — inbound from behind that baseline
    const scorer = 1 - team;
    const sign = this.attackSign(scorer);
    const baselineZ = sign * RIM.z;
    const tp = this.teamPlayers(team);
    let taker = tp[0];
    for (const p of tp) {
      if (Math.abs(p.pos.z - baselineZ) < Math.abs(taker.pos.z - baselineZ)) taker = p;
    }
    taker.pos.set(rand(-2, 2), 0, sign * (COURT.halfL + 0.3)); // behind the endline
    this.handler = taker;
    this.ballMode = "inbound";
    this.inboundT = 0.9;
    this.shotClock = SHOT_CLOCK;
    this.resetMotion();
    this.inboundReceiver = this.pickInboundReceiver(taker);
    // after a made basket / free throw the CONCEDING team plays it in — show it
    this.setEvent(`THROW-IN\n${teamShort(team)} BALL`, team, 1.8);
  }

  // Throw-in from where the ball went out: the taker (nearest team-mate) steps
  // just over the nearest edge — the sideline if it crossed the touchline, the
  // baseline if it crossed the endline.
  private startInboundAt(team: number, ox: number, oz: number,
                         opts: { clock?: number; announce?: string | null } = {}): void {
    this.possession = team;
    const overSide = Math.abs(ox) - COURT.halfW;   // how far past each edge it went
    const overEnd = Math.abs(oz) - COURT.halfL;
    let sx: number, sz: number;
    if (overSide >= overEnd) {                     // out over a sideline
      sx = Math.sign(ox || 1) * (COURT.halfW + 0.3);
      sz = clamp(oz, -(COURT.halfL - 1), COURT.halfL - 1);
    } else {                                        // out over an endline (baseline)
      sx = clamp(ox, -(COURT.halfW - 1), COURT.halfW - 1);
      sz = Math.sign(oz || 1) * (COURT.halfL + 0.3);
    }
    const tp = this.teamPlayers(team);
    let taker = tp[0];
    for (const p of tp) {
      if (dist2DTo(this.ball.pos, p.pos.x, p.pos.z) < dist2DTo(this.ball.pos, taker.pos.x, taker.pos.z)) taker = p;
    }
    // the ball is dead at the spot; ANNOUNCE the out-of-bounds and let the thrower
    // WALK over to it (updatePause moves him) before play resumes — no instant
    // restart. finishOOB then puts the ball in his hands and goes live.
    this.ball.pos.set(sx, 1.2, sz);
    this.ball.vel.set(0, 0, 0);
    this.handler = null;
    this.possession = team;
    this.oobWalker = taker;
    this.oobSpot.set(sx, 0, sz);
    this.oobTeam = team;
    // decide the restart shot clock NOW (it stops during the dead ball): a CHANGE
    // of possession is a full reset; the offence RETAINING off the rim gets the
    // partial; retaining off a block/strip (no rim) plays on with the clock as-is.
    // …unless the CALLER already ruled on the clock (e.g. a shot-clock violation,
    // where FIBA gives the new offence the short clock on a frontcourt throw-in)
    this.oobShotClock = opts.clock ?? (team !== this.looseOff ? SHOT_CLOCK
      : this.looseFromRim ? Math.max(this.shotClock, SHOT_CLOCK_PARTIAL)
      : this.shotClock);
    // announce WHOSE ball the throw-in is (team-coloured banner) — "OUT OF
    // BOUNDS" alone never said who plays it in
    if (opts.announce !== null) {
      this.setEvent(opts.announce ?? `THROW-IN\n${teamShort(team)} BALL`, team, 2.0);
    }
    this.pauseThen(1.5, () => this.finishOOB());
  }

  // The announcement is over: the thrower is at (or snapped to) the spot — put the
  // ball in his hands and start the throw-in.
  private finishOOB(): void {
    const taker = this.oobWalker ?? this.teamPlayers(this.oobTeam)[0];
    taker.pos.set(this.oobSpot.x, 0, this.oobSpot.z);
    this.handler = taker;
    this.lastTouch = taker;
    this.possession = this.oobTeam;
    this.ballMode = "inbound";
    this.inboundT = 0.9;
    this.shotClock = this.oobShotClock;   // full / partial / continued — decided at the whistle
    this.resetMotion();
    this.inboundReceiver = this.pickInboundReceiver(taker);
    this.oobWalker = null;
  }

  // A teammate (a guard, if available) flashes in to take the throw-in — but a
  // ロング thrower looks deep first and hits the furthest man up the floor.
  private pickInboundReceiver(taker: Player): Player {
    const tp = this.teamPlayers(taker.team);
    if (taker.has("longThrow")) {
      const sign = this.attackSign(taker.team);
      let deep: Player | null = null;
      for (const p of tp) {
        if (p === taker) continue;
        if (!deep || p.pos.z * sign > deep.pos.z * sign) deep = p;
      }
      // only worth it when someone is genuinely ahead of the play
      if (deep && (deep.pos.z - taker.pos.z) * sign > 6) return deep;
    }
    // otherwise: the best playmaker on the floor takes the ball in-bounds
    return tp.filter((p) => p !== taker)
      .sort((a, b) => b.playmaking - a.playmaking)[0];
  }

  private updateInbound(dt: number): void {
    const inb = this.handler!;             // inbounder, stood out of bounds
    const team = this.possession;
    const spots = this.formationSpots(team);
    const r = this.inboundReceiver;

    for (const p of this.teamPlayers(team)) {
      if (p === inb) continue;             // the inbounder holds the ball, still
      if (p === r) {
        // flash in-bounds toward the inbounder to get open for the throw
        moveToward2D(p.pos, inb.pos.x * 0.35, inb.pos.z * 0.55, p.accelSpeed(dt) * dt);
      } else {
        moveToward2D(p.pos, spots[p.spotIdx].x, spots[p.spotIdx].z, p.accelSpeed(dt) * dt);
      }
      this.clampCourt(p.pos);
    }
    this.runDefenseDuringDeadish(dt);

    // ball waits in the inbounder's hands, just over the line
    this.ball.pos.set(inb.pos.x, 1.3, inb.pos.z);

    this.inboundT -= dt;
    if (this.inboundT <= 0) this.throwIn(inb);
  }

  // The inbounder passes the ball in to the receiver; play goes live on the catch.
  private throwIn(inb: Player): void {
    const r = this.inboundReceiver ?? this.pickInboundReceiver(inb);
    this.passFrom.set(inb.pos.x, 1.3, inb.pos.z);
    this.passCatch.set(r.pos.x, 1.3, r.pos.z);   // fixed target so the flight is steady (as for any pass)
    this.passMiss = 0; this.passMissY = 0; // an unopposed outlet arrives clean — no scatter
    this.passStyle = "chest";              // a throw-in never inherits a bounce/jump style
    this.passTo = r;
    this.passer = inb;
    this.passT = 0;
    // P速度 zips the outlet like any other pass; ロング fires it flat and fast
    const spd = PASS_SPEED * (0.6 + rate(inb.attr.passSpd) * 0.95) * (inb.has("longThrow") ? 1.3 : 1);
    this.passDur = Math.max(0.3, dist2D(inb.pos, r.pos) / spd);
    this.passSteal = null;                 // a throw-in isn't picked off here
    this.ballMode = "pass";
    this.handler = null;
    this.inboundReceiver = null;
    // the thrower is rooted through the release like any passer — he can't step
    // onto the court until the follow-through is done
    inb.coolT = rand(0.5, 0.9) * inb.recoveryMult();
  }

  // ---- off-ball motion (the core of "looks like real basketball") -------

  // Drives every off-ball offensive player: occupy a spot, cut to the basket,
  // give-and-go after passing, rotate to open spots, and space off the ball.
  private updateOffBallMotion(dt: number, team: number, exclude: Player | null): void {
    const spots = this.formationSpots(team);
    const rim = this.attackFloor(team);
    for (const p of this.teamPlayers(team)) {
      if (p === exclude) continue;
      if (p.rooted) continue;   // following through on a pass/shot — hold position

      // bringing it up after a change of possession: the primary ball-handler
      // (PG, or SG when the PG has it) comes BACK toward the ball to take the
      // outlet — always when a big has ended up with it, and also when he
      // himself is covered / the passing lane to him is blocked, so the handler
      // is never forced to bail out to a big just to move the ball.
      if (!this.frontT && this.handler && dist2D(this.handler.pos, rim) > 10) {
        // the team's best playmaker (not the handler) is the outlet man
        const outlet = this.teamPlayers(team)
          .filter((q) => q !== this.handler)
          .sort((a, b) => b.playmaking - a.playmaking)[0];
        if (p === outlet) {
          const wanted = this.isBig(this.handler)
            || this.nearestDefenderDist(p) < 1.4
            || this.laneBlock(this.handler, p) !== null;
          if (wanted) {
            const s = this.attackSign(team);
            const bx = this.handler.pos.x, bz = this.handler.pos.z;
            // show up-court from the ball, toward the middle — a catchable outlet
            const otx = bx * 0.5, otz = bz + s * 2.0;
            moveToward2D(p.pos, otx, otz, p.accelToward(dt, otx, otz, 1.1) * dt);
            this.clampCourt(p.pos);
            continue;
          }
        }
      }

      // FILL THE LANES: on a fast break, wings (not the ball-handler) sprint
      // ahead down their side to the rim, ready for the drop-off. Faster
      // players (速度/加速力) get there first — this is where open-court speed
      // turns into transition layups. Bigs trail; the handler pushes it himself.
      if (this.pushT > 0 && this.handler && p !== this.handler && !this.isBig(p)) {
        const s = this.attackSign(team);
        const side = p.pos.x >= 0 ? 1 : -1;
        const fb = this.steerAround(p, side * 4.5, s * (RIM.z - 1.5));   // fill the lane around traffic
        moveToward2D(p.pos, fb.x, fb.z, p.accelToward(dt, fb.x, fb.z, 1.25) * dt);
        this.clampCourt(p.pos);
        continue;
      }

      // a 司令塔 on the floor (and a キープ handler buying time) speeds up the
      // whole team's re-positioning; a ポジショニング player re-reads on his own
      let tick = this.teamHas(team, "general") ? 1.3 : 1;
      if (this.handler?.has("keepDribble")) tick *= 1.2;
      if (p.has("positioning")) tick *= 1.25;
      p.offTimer -= dt * tick;

      if (p.screening) {
        this.updateScreen(dt, p);
      } else if (p.cutting) {
        // sprint along the cut; cutters move a touch faster than they jog spots
        // (a ラインポジ cutter bursts hard enough to lose his mark) — bending
        // around any DEFENDER standing in the runway (team-mates are handled by
        // the spacing nudge below; a screen is meant to be shaved)
        const ct = this.steerAround(p, p.offTarget.x, p.offTarget.z, true);
        moveToward2D(p.pos, ct.x, ct.z,
          p.accelToward(dt, ct.x, ct.z, p.has("lineMove") ? 1.22 : 1.08) * dt);
        // bend the run around bodies (the post big, the handler) instead of
        // slicing straight through them — personal space only, the cut still goes
        this.spacingNudge(dt, p, 1.7);
        if (dist2DTo(p.pos, p.offTarget.x, p.offTarget.z) < 0.6) {
          const atRim = dist2DTo(p.offTarget, rim.x, rim.z) < 1.6;
          if (atRim) {
            // didn't get the ball at the rim — clear through to an open spot
            p.spotIdx = this.bestOpenSpot(team, spots, p);
            p.offTarget.copyFrom(spots[p.spotIdx]);
          } else {
            p.cutting = false;
            p.offTimer = rand(2.5, 4.5);
          }
        }
      } else if (this.clearDriveLane(dt, p)) {
        // stepped out of the ball-handler's drive lane this frame
      } else if (this.isoHandler()) {
        // 釣り出し: the star has the ball — pin your own defender OUT wide
        // (corners / deep wings / weak-side dunker) and hold there; no new
        // cuts or spot-reads that would drag a helper back into the lane
        const t2 = this.isoSpreadTarget(p, this.isoHandler()!);
        moveToward2D(p.pos, t2.x, t2.z, p.accelToward(dt, t2.x, t2.z) * dt);
        this.spacingNudge(dt, p, 1.7);
        this.clampCourt(p.pos);
      } else {
        let spot = spots[p.spotIdx];
        // a post big HOLDS his block: he doesn't chase the full floor-spacing
        // rules — but he still keeps a minimal personal space (1.6 m) so bodies
        // don't stack into a scrum, relocating (usually to the other block)
        // when someone is basically standing on him
        const atPost = p.spotIdx >= 5;
        // DUNKER SLIDE: when the handler has committed a drive into the paint,
        // the block big vacates along the baseline to the short corner on his
        // side — clearing the rim for the finisher (and sitting right there for
        // the dump-off) instead of standing in the driving lane
        if (atPost && this.handler
            && ((this.handler.beatenT > 0 || this.handler.powerT > 0)
                  && dist2D(this.handler.pos, p.pos) < 6.5
                || dist2D(this.handler.pos, p.pos) < 3.2)) {
          const s = this.attackSign(team);
          const sx = (spot.x || p.pos.x) > 0 ? 1 : -1;
          const tx = sx * 4.8, tz = s * (RIM.z - 0.9);
          moveToward2D(p.pos, tx, tz, p.accelToward(dt, tx, tz, 1.1) * dt);
          this.spacingNudge(dt, p, 1.6);
          this.clampCourt(p.pos);
          continue;
        }
        // relocate when the spot is crowded — on top of the ball-handler, or a
        // team-mate has drifted into this player's area — to keep the floor spread
        if ((this.handler && dist2DTo(this.handler.pos, spot.x, spot.z) < 3)
            || this.nearestTeammateDist(p) < (atPost ? 2.0 : 3.2)) {
          p.spotIdx = this.bestOpenSpot(team, spots, p);
          spot = spots[p.spotIdx];
        }
        // ディープシューター(L精度/L速度とも90+)だけはスポットより一歩外に張り、
        // ロゴ3の脅威でフロアを広げる。他の全員はライン際の形どおりに立つ。
        let spx = spot.x, spz = spot.z;
        if (this.deepThreeOK(p)) {
          const dxs = spot.x - rim.x, dzs = spot.z - rim.z;
          const dl = Math.hypot(dxs, dzs);
          if (dl > THREE_DIST - 0.4) {
            const k = (dl + 1.1) / dl;
            spx = rim.x + dxs * k;
            spz = rim.z + dzs * k;
          }
        }
        const sj = this.steerAround(p, spx, spz, true);   // jog around, not through
        moveToward2D(p.pos, sj.x, sj.z, p.accelToward(dt, sj.x, sj.z) * dt);
        // continuous separation: ease out of any team-mate's personal space so
        // spacing holds between spot re-reads (real off-ball players never let a
        // team-mate crowd them)
        this.spacingNudge(dt, p, atPost ? 1.6 : 3.5);

        if (p.offTimer <= 0) {
          p.offTimer = rand(2.0, 4.0);
          this.pickOffBallAction(team, spots, p);
        }
      }

      this.clampCourt(p.pos);
    }
  }

  // After holding a spot for a while, an off-ball player chooses his next move:
  // come set a ball screen for a pressured handler, make a basket cut (which
  // opens a passing lane and drags a defender with it), or drift to a more open
  // spot. At most one screener/cutter at a time keeps the floor spaced instead
  // of everyone collapsing toward the ball.
  private pickOffBallAction(team: number, spots: Vector3[], p: Player): void {
    const rim = this.attackFloor(team);
    const busy = this.countScreening(team) + this.countCutting(team);
    // bigs are the natural screeners; guards/wings set picks only occasionally —
    // and a designated スクリーナー hunts the pick regardless of position
    const screenChance = (this.isBig(p) ? 0.7 : 0.3) * (p.evalRole === "スクリーナー" ? 1.5 : 1);
    if (busy === 0 && this.handlerPressured() && this.goodScreener(p) && chance(screenChance)) {
      this.startScreen(p);
      return;
    }
    // scorers cut hard to get open looks (a basket cut also opens a feed lane and
    // drags a defender inside); an aggressive mindset — and a ラインポジ mover —
    // hunts those cuts, while lower-priority players hold spacing
    // a stationed post big shrinks the cutting room — teams with a low-post
    // anchor cut through the paint far less often
    const postHome = this.teamPlayers(team)
      .some((q) => q !== p && q.spotIdx >= 5 && !q.cutting && !q.screening);
    if (this.countCutting(team) === 0
        // don't launch a cut into a lane the handler is already attacking
        && !(this.handler && (this.handler.beatenT > 0 || this.handler.powerT > 0
          || this.handler.jukeT > 0))
        && chance((0.2 + p.offPriority * 0.25 + rate(p.attr.aggression) * 0.15
          + (p.has("lineMove") ? 0.15 : 0)) * (postHome ? 0.55 : 1))) {
      p.cutting = true;
      // where does the cut finish? With a post big stationed at the goal the
      // paint is HIS — the cutter flashes to the ELBOW on the open side for a
      // mid-range catch instead of running to a rim that's already occupied.
      // With the paint empty, cut all the way to the basket (away from any
      // occupied block side).
      let occL = false, occR = false;
      for (const q of this.teamPlayers(team)) {
        if (q !== p && q.spotIdx >= 5 && !q.cutting && !q.screening) {
          if (spots[q.spotIdx].x > 0) occR = true; else occL = true;
        }
      }
      const sgn = Math.sign(rim.z);
      let tx: number, tz: number;
      if (occL || occR) {
        const ex = occR ? -1 : occL ? 1 : (chance(0.5) ? 1 : -1);
        tx = rim.x + ex * rand(1.6, 2.4);
        tz = rim.z - sgn * rand(3.6, 5.0);            // elbow / FT-line area
      } else {
        tx = rim.x + rand(-0.6, 0.6);
        tz = rim.z - sgn * 0.4;                       // all the way to the rim
      }
      // ...and only if the RUN itself threads clean — a straight line that
      // slices over the stationed big (or through the handler) is a cut a real
      // player simply doesn't make; hold spacing instead
      if (!this.cutLaneClear(team, p, tx, tz)) { p.cutting = false; return; }
      p.offTarget.set(tx, 0, tz);
      return;
    }
    // otherwise reposition to keep a passing lane open and stay out of the drive
    // gap (a 司令塔 keeps everyone moving to the right spots)
    if (chance(this.teamHas(team, "general") ? 0.7 : 0.5)) {
      p.spotIdx = this.bestOpenSpot(team, spots, p);
    }
  }

  private countCutting(team: number): number {
    let n = 0;
    for (const p of this.teamPlayers(team)) if (p.cutting) n++;
    return n;
  }

  private countScreening(team: number): number {
    let n = 0;
    for (const p of this.teamPlayers(team)) if (p.screening) n++;
    return n;
  }

  // ---- screens (pick-and-roll) ------------------------------------------

  // Is the ball-handler pressured closely enough that a screen would help?
  private handlerPressured(): boolean {
    const h = this.handler;
    if (!h) return false;
    const d = this.onBallDefender(h);
    return !!d && dist2D(d.pos, h.pos) < 1.7;
  }

  // A teammate close enough to come over and set the pick.
  private goodScreener(p: Player): boolean {
    return !!this.handler && dist2D(p.pos, this.handler.pos) < 7.5;
  }

  // Begin a ball screen. The screener frees the handler away from where the
  // on-ball defender is shading, and the handler commits to attacking that side.
  private startScreen(p: Player): void {
    const h = this.handler!;
    const d = this.onBallDefender(h);
    p.screening = true;
    p.cutting = false;
    p.screenT = rand(1.2, 2.0);
    p.screenSide = d ? -d.shadeSide : (chance(0.5) ? 1 : -1);
    h.driveSide = p.screenSide;
  }

  // Move into the pick beside the handler on the chosen side. Once the screener
  // is set and the on-ball defender runs into him, the handler turns the corner
  // (a blow-by burst) while the defender is held up — then the screener rolls
  // hard to the rim for the pocket pass. An unused pick expires and he pops out.
  private updateScreen(dt: number, p: Player): void {
    const h = this.handler;
    p.screenT -= dt;
    const d = h ? this.onBallDefender(h) : undefined;
    if (!h || !d) { this.endScreen(p, false); return; }

    const rim = this.attackFloor(p.team);
    const dx = rim.x - h.pos.x, dz = rim.z - h.pos.z;
    const len = Math.hypot(dx, dz) || 1;
    const fx = dx / len, fz = dz / len;                 // handler -> rim
    const lx = -fz * p.screenSide, lz = fx * p.screenSide;
    // a step ahead of the handler on the attack side — in the defender's path
    const tx = h.pos.x + fx * 0.5 + lx * 0.9;
    const tz = h.pos.z + fz * 0.5 + lz * 0.9;
    moveToward2D(p.pos, tx, tz, p.accelSpeed(dt) * dt);

    const set = dist2DTo(p.pos, tx, tz) < 0.5;
    if (set && dist2D(p.pos, d.pos) < 0.95) {
      // the pick connects — the DEFENCE now chooses how to guard it, and the
      // handler's outcome (blow-by / pull-up / walled off) follows from that
      this.resolveScreenCoverage(h, p, d);
      this.endScreen(p, true);                          // screener rolls
      return;
    }
    if (p.screenT <= 0) this.endScreen(p, false);       // pick unused — pop out
  }

  // The two defenders in a ball screen and how the screener's man plays it.
  // Called the instant the pick connects. Sets a coverage window (pnrT) that
  // runDefense reads to move both defenders by the scheme, and applies the
  // matching consequence to the offence.
  private resolveScreenCoverage(handler: Player, screener: Player, hDef: Player): void {
    const defTeam = 1 - handler.team;
    const sDef = this.teamPlayers(defTeam)[screener.slot];
    const cov = this.chooseScreenCoverage(hDef, sDef);
    this.pnrCov = cov;
    this.pnrT = 1.3;
    this.pnrHandlerDef = hDef;
    this.pnrScreenerDef = sDef;
    this.pnrScreener = screener;
    handler.decisionT = Math.max(handler.decisionT, 0.2);
    this.setDriveSide(handler);
    if (cov === "drop") {
      // the big sits back and protects the rim — the handler gets a STEP for a
      // pull-up (not a rim blow-by), and the roll is covered
      handler.beatenT = Math.max(handler.beatenT, rand(0.18, 0.32));
      hDef.reactT = Math.max(hDef.reactT, 0.35);   // handler's man trails over the top
    } else if (cov === "show") {
      // the big jumps out to stop the ball — the handler is walled off for a
      // beat, but the SCREENER rolls into the space his man vacated
      handler.stalledT = Math.max(handler.stalledT, rand(0.35, 0.55));
      hDef.reactT = Math.max(hDef.reactT, 0.45);
      screener.openRollT = 0.9;
    } else {
      // SWITCH: the men swap. No easy corner — but if the big switched onto the
      // guard is a step slow, the handler attacks that mismatch (a delayed
      // blow-by scaled by the quickness gap); the roller, now on a smaller man,
      // gets an open lane too
      const agiGap = rate(handler.attr.agility) - rate(sDef.attr.agility);
      handler.beatenT = Math.max(handler.beatenT, clamp(agiGap, 0, 0.45) * 1.3);
      hDef.reactT = Math.max(hDef.reactT, 0.3);
      if (screener.height - hDef.height > 0.06) screener.openRollT = 0.7;   // size mismatch on the roll
    }
  }

  // Which coverage the screener's defender plays: a slow-footed big drops to
  // protect the rim; an aggressive game plan (or a quick big) hedges out to
  // blow up the ball; comparable, switchable defenders just swap men. Weighted
  // so a team varies its looks rather than always doing one thing.
  private chooseScreenCoverage(hDef: Player, sDef: Player): "drop" | "show" | "switch" {
    const press = this.tactics[sDef.team].defense.pressure;
    const sAgi = rate(sDef.attr.agility);
    // a slow big can't step out on a quick guard — he drops
    const wDrop = (this.isBig(sDef) ? 0.5 : 0.2) + (1 - sAgi) * 0.7 + (1 - press) * 0.3;
    // aggressive, quick defenders hedge/show to disrupt the handler
    const wShow = 0.15 + press * 0.7 + sAgi * 0.25;
    // switch when the two are close in size (a big gap = a bad switch to avoid)
    const sizeGap = Math.abs(sDef.height - hDef.height);
    const wSwitch = 0.15 + sAgi * 0.4 + clamp(1 - sizeGap * 2.5, 0, 1) * 0.5
      + (this.teamHas(sDef.team, "manMark") ? 0.15 : 0);   // ロックダウン-type teams switch confidently
    const total = wDrop + wShow + wSwitch;
    let r = rand(0, total);
    if ((r -= wDrop) < 0) return "drop";
    if ((r -= wShow) < 0) return "show";
    return "switch";
  }

  // Move the two ball-screen defenders by the chosen coverage for the window.
  private defendScreenCoverage(dt: number, d: Player, protect: Vector3): void {
    const h = this.handler;
    const screener = this.pnrScreener;
    if (!h || !screener) return;
    const effort = this.defEffort(d, protect);
    if (d === this.pnrScreenerDef) {
      if (this.pnrCov === "drop") {
        // sag between the ball and the rim, deep — wall the paint and meet the
        // roller (this is what takes the rim finish / roll away)
        const tx = h.pos.x + (protect.x - h.pos.x) * 0.62;
        const tz = h.pos.z + (protect.z - h.pos.z) * 0.62;
        moveToward2D(d.pos, tx, tz, d.accelToward(dt, tx, tz, 1.05 * effort) * dt);
      } else if (this.pnrCov === "show") {
        // hedge hard at the ball early, then sprint back to recover the roller
        const early = this.pnrT > 0.75;
        const t = early ? h : screener;
        const gx = t.pos.x + (protect.x - t.pos.x) * 0.35;
        const gz = t.pos.z + (protect.z - t.pos.z) * 0.35;
        moveToward2D(d.pos, gx, gz, d.accelToward(dt, gx, gz, 1.15 * effort) * dt);
      } else {
        this.defendOnBall(dt, d, h, protect);   // switch: he now guards the ball
      }
    } else {   // d === this.pnrHandlerDef
      if (this.pnrCov === "switch") {
        // pick up the roller, goal-side
        const gx = screener.pos.x + (protect.x - screener.pos.x) * 0.3;
        const gz = screener.pos.z + (protect.z - screener.pos.z) * 0.3;
        moveToward2D(d.pos, gx, gz, d.accelToward(dt, gx, gz, 1.1 * effort) * dt);
      } else {
        // drop / show: chase the handler over the top of the pick to recover
        const gx = h.pos.x + (protect.x - h.pos.x) * 0.2;
        const gz = h.pos.z + (protect.z - h.pos.z) * 0.2;
        moveToward2D(d.pos, gx, gz, d.accelToward(dt, gx, gz, 1.12 * effort) * dt);
      }
    }
    this.clampCourt(d.pos);
  }

  private endScreen(p: Player, connected: boolean): void {
    p.screening = false;
    p.screenT = 0;
    if (!connected) {
      p.spotIdx = this.bestOpenSpot(p.team, this.formationSpots(p.team), p);
      return;
    }
    const rim = this.attackFloor(p.team);
    // PICK-AND-POP vs PICK-AND-ROLL: a stretch-shooting screener POPS back out to
    // the arc for a catch-and-shoot three instead of rolling to the rim. A rim
    // runner (or a non-shooter) rolls hard as before.
    const canPop = rate(p.attr.threeAcc) > 0.68 || p.has("range") || p.evalRole === "ストレッチ";
    p.cutting = true;
    p.offTimer = rand(1.5, 2.5);
    if (canPop && chance(0.6)) {
      const dir = -this.attackSign(p.team);           // toward mid-court
      const px = clamp(p.pos.x + p.screenSide * 1.5, -6.5, 6.5);
      p.offTarget.set(px, 0, rim.z + dir * 7.2);       // out to three-point range
      p.openRollT = 2.0;                               // stays a feed target through the pop-out travel
    } else {
      p.offTarget.set(rim.x + rand(-0.6, 0.6), 0, rim.z - Math.sign(rim.z) * 0.4);   // roll to the rim
    }
  }

  // Nearest team-mate who is ALSO trying to hold spacing (the ball-handler,
  // cutters and screeners are meant to be where they are, so they don't count).
  private nearestTeammateDist(self: Player): number {
    let best = Infinity;
    for (const q of this.teamPlayers(self.team)) {
      if (q === self || q === this.handler || q.cutting || q.screening) continue;
      best = Math.min(best, dist2D(self.pos, q.pos));
    }
    return best;
  }

  // Ease an off-ball player out of any team-mate's personal space so the floor
  // stays spread frame-to-frame (a boids-style separation on top of spot-seeking).
  private spacingNudge(dt: number, p: Player, min = 3.5): void {
    const MIN = min;                      // start pushing apart within this range
    let rx = 0, rz = 0;
    for (const q of this.teamPlayers(p.team)) {
      if (q === p) continue;
      const dx = p.pos.x - q.pos.x, dz = p.pos.z - q.pos.z;
      const d = Math.hypot(dx, dz);
      if (d < MIN && d > 1e-3) {
        const w = (MIN - d) / MIN;        // 0 at the edge → 1 when overlapping
        rx += (dx / d) * w; rz += (dz / d) * w;
      }
    }
    const rl = Math.hypot(rx, rz);
    if (rl > 1e-3) {
      const step = p.accelSpeed(dt, 0.7) * dt * Math.min(1, rl);
      moveToward2D(p.pos, p.pos.x + rx / rl, p.pos.z + rz / rl, step);
    }
  }

  // The 1-on-1 star currently going to work, if any — an エース/スラッシャー
  // with the ball in the frontcourt gets the floor cleared for his attack.
  private isoHandler(): Player | null {
    const h = this.handler;
    if (!h || !this.frontT) return null;
    return (h.evalRole === "エース" || h.evalRole === "スラッシャー") ? h : null;
  }

  // 釣り出し (gravity spread): where everyone stands while the star goes to
  // work — both corners and the deep weak-side wing, with the (non-stretch)
  // big tucked in the weak-side dunker pocket. Defenders position off their
  // man, so pinning each man WIDE drags his defender out of the paint and the
  // drive meets one body instead of four.
  private isoSpreadTarget(p: Player, h: Player): { x: number; z: number } {
    const s = this.attackSign(h.team);
    const hz = s * RIM.z, dir = -s;
    const hs = h.pos.x >= 0 ? 1 : -1;            // the side the star works on
    if (this.isBig(p) && this.prefersPost(p)) {
      // first post big → weak-side dunker pocket; a second one → strong corner
      const bigs = this.teamPlayers(h.team)
        .filter((q) => q !== h && this.isBig(q) && this.prefersPost(q));
      return bigs.indexOf(p) <= 0
        ? { x: -hs * 4.9, z: hz + dir * 0.9 }
        : { x: hs * 6.7, z: hz + dir * 1.5 };     // deep corner three
    }
    const spots = [
      { x: -hs * 6.7, z: hz + dir * 1.5 },       // weak corner (deep, on the three)
      { x: hs * 6.7, z: hz + dir * 1.5 },        // strong corner (deep, on the three)
      { x: -hs * 6.0, z: hz + dir * 7.0 },       // weak deep wing
      { x: hs * 6.2, z: hz + dir * 7.5 },        // strong deep wing
    ];
    const mates = this.teamPlayers(h.team)
      .filter((q) => q !== h && !(this.isBig(q) && this.prefersPost(q)));
    const idx = Math.max(0, mates.indexOf(p));
    return spots[Math.min(idx, spots.length - 1)];
  }

  // Get an off-ball team-mate OUT of the ball-handler's driving lane: if he is
  // standing ahead of the handler and inside the corridor to the rim, he slides
  // laterally to clear the path (and re-reads to a spot out of the lane), instead
  // of holding a spot the handler then dribbles straight into. Returns true when
  // it fires (that frame's movement is handled here). Only in the frontcourt,
  // where a drive is a real threat.
  private clearDriveLane(dt: number, p: Player): boolean {
    const h = this.handler;
    if (!h || !this.frontT) return false;
    const rim = this.attackFloor(h.team);
    const dx = rim.x - h.pos.x, dz = rim.z - h.pos.z;
    const len = Math.hypot(dx, dz) || 1;
    const ux = dx / len, uz = dz / len;              // handler → rim
    const rx = p.pos.x - h.pos.x, rz = p.pos.z - h.pos.z;
    const along = rx * ux + rz * uz;                 // distance ahead of the handler
    if (along < 0.3 || along > 5.5) return false;    // behind him, or too far ahead to matter
    const perp = rx * -uz + rz * ux;                 // signed lateral offset from the lane
    if (Math.abs(perp) > 1.25) return false;         // already clear of the corridor
    // slide out to the side he's already on (dead-centre → toward the nearer sideline)
    const side = Math.abs(perp) < 0.05 ? (p.pos.x >= 0 ? 1 : -1) : (perp > 0 ? 1 : -1);
    const tx = p.pos.x + -uz * side * 2.2, tz = p.pos.z + ux * side * 2.2;
    moveToward2D(p.pos, tx, tz, p.accelToward(dt, tx, tz, 1.15) * dt);
    // re-home to a spot out of the lane so he doesn't drift straight back in
    p.spotIdx = this.bestOpenSpot(p.team, this.formationSpots(p.team), p);
    return true;
  }

  // Would a cut from p's position to (tx,tz) run over a stationed team-mate?
  // Checks the straight path against the post big holding his block (1.7 m) and
  // the ball-handler (1.4 m) — the two bodies a real cutter never slices through.
  private cutLaneClear(team: number, p: Player, tx: number, tz: number): boolean {
    const hits: { x: number; z: number; r: number }[] = [];
    for (const q of this.teamPlayers(team)) {
      if (q === p || q.cutting || q.screening) continue;
      if (q.spotIdx >= 5) hits.push({ x: q.pos.x, z: q.pos.z, r: 1.7 });
    }
    if (this.handler && this.handler !== p)
      hits.push({ x: this.handler.pos.x, z: this.handler.pos.z, r: 1.4 });
    const dx = tx - p.pos.x, dz = tz - p.pos.z;
    const len2 = dx * dx + dz * dz || 1;
    for (const o of hits) {
      const t = clamp(((o.x - p.pos.x) * dx + (o.z - p.pos.z) * dz) / len2, 0, 1);
      const px = p.pos.x + dx * t, pz = p.pos.z + dz * t;
      if (Math.hypot(o.x - px, o.z - pz) < o.r) return false;
    }
    return true;
  }

  // Pick the formation spot that is open (far from defenders), spaced from the
  // ball, and not already occupied by a teammate.
  private bestOpenSpot(team: number, spots: Vector3[], self: Player): number {
    const rimFloor = this.attackFloor(team);
    let bestI = self.spotIdx;
    let bestScore = -Infinity;
    for (let i = 0; i < spots.length; i++) {
      const s = spots[i];
      // skip spots a teammate already holds (cutters/screeners have left theirs)
      let owned = false;
      for (const q of this.teamPlayers(team)) {
        if (q === self || q.cutting || q.screening || q === this.handler) continue;
        // a spot is taken if a team-mate has claimed it (even while still moving
        // to it) OR is standing on it — either way, find another to stay spread
        if (q.spotIdx === i || dist2DTo(q.pos, s.x, s.z) < 2.5) { owned = true; break; }
      }
      if (owned) continue;

      // spacing: distance to the nearest defender
      let open = Infinity;
      for (const d of this.teamPlayers(1 - team)) open = Math.min(open, dist2DTo(d.pos, s.x, s.z));
      const fromHandler = this.handler ? dist2DTo(this.handler.pos, s.x, s.z) : 5;
      // a clear passing lane makes the spot a genuine outlet; sitting in the
      // handler's path to the rim clogs the driving gap, so steer away from it
      const lane = this.handler ? this.laneOpenness(this.handler.pos, s.x, s.z) : 1;
      const clog = this.handler ? this.clogPenalty(this.handler.pos, rimFloor, s.x, s.z) : 0;

      // the low blocks (idx 5/6) are big-man country: guards and genuine
      // stretch bigs never camp the goal area
      if (i >= 5 && !this.prefersPost(self)) continue;

      let score: number;
      if (i >= 5) {
        // the block: being AT the goal is the point — a post big holds deep
        // position even with his man draped over him, so openness barely
        // counts here (ペイント holders are anchored even harder)
        score = 6.0 + Math.min(open, 2.0) * 0.5 + lane * 0.8
          - clog * 2.5
          - dist2DTo(self.pos, s.x, s.z) * 0.1
          + (self.has("centerSpot") ? 1.5 : 0);
      } else {
        score = open * (self.has("positioning") ? 1.35 : 1) // 特能: reads the open spot
          + Math.min(fromHandler, 6) * 0.3   // keep some distance off the ball
          + lane * 2.0                       // stay in a live passing lane
          - clog * 2.5                       // vacate the drive gap to the rim
          - dist2DTo(self.pos, s.x, s.z) * 0.1;
        // spot preferences: サイド lives in the corners (idx 3/4)
        if (self.has("sideSpot") && (i === 3 || i === 4)) score += 1.5;
        // a post player leaves the goal area only reluctantly — and he doesn't
        // hunt perimeter openness the way a shooter does, so a wide-open corner
        // never outbids his block
        if (this.prefersPost(self)) score = Math.min(score, 4.0) - 1.5;
      }
      if (score > bestScore) { bestScore = score; bestI = i; }
    }
    return bestI;
  }

  // Openness of the passing lane from `from` to the point (x,z): 1 = no defender
  // near the line, falling toward 0 as a defender sits squarely in it.
  private laneOpenness(from: Vector3, x: number, z: number): number {
    const dx = x - from.x, dz = z - from.z;
    const len2 = dx * dx + dz * dz || 1;
    let minPerp = Infinity;
    for (const d of this.teamPlayers(1 - this.possession)) {
      const t = ((d.pos.x - from.x) * dx + (d.pos.z - from.z) * dz) / len2;
      if (t <= 0.1 || t >= 0.95) continue;
      const px = from.x + dx * t, pz = from.z + dz * t;
      minPerp = Math.min(minPerp, Math.hypot(d.pos.x - px, d.pos.z - pz));
    }
    return minPerp === Infinity ? 1 : clamp(minPerp / LANE_W, 0, 1);
  }

  // How much a spot at (x,z) clogs the handler's straight-line drive to the rim:
  // 1 = sitting right in that corridor, 0 = clear of it. Off-ball players use
  // this to clear out and leave a gap to attack.
  private clogPenalty(from: Vector3, rim: Vector3, x: number, z: number): number {
    const dx = rim.x - from.x, dz = rim.z - from.z;
    const len2 = dx * dx + dz * dz || 1;
    const t = ((x - from.x) * dx + (z - from.z) * dz) / len2;
    if (t <= 0.05 || t >= 1) return 0;                  // not between handler and rim
    const px = from.x + dx * t, pz = from.z + dz * t;
    const perp = Math.hypot(x - px, z - pz);
    return clamp(1 - perp / 2.0, 0, 1);                 // within ~2 m of the lane = clogging
  }

  private resetMotion(): void {
    this.pendingPassTo = null;   // a possession change cancels a wound-up jump pass
    this.pendingPassT = 0;
    for (const p of this.players) {
      p.cutting = false;
      p.offTimer = rand(0.4, 2.0);
      p.spotIdx = this.homeSpotIdx(p);   // post bigs head straight for the block
      p.beatenT = 0;
      p.powerT = 0;
      p.stalledT = 0;
      p.jukeT = 0;
      p.comboN = 0;
      p.reactT = 0;
      p.lean = 0;
      p.coolT = 0;   // a change of possession clears any lingering follow-through
      p.landT = 0;
      p.touchCool = 0;
      p.screening = false;
      p.screenT = 0;
      p.openRollT = 0;
    }
    // a change of possession ends any pending assist, and the ball has to be
    // brought up / established in the frontcourt afresh
    this.assistFrom = this.assistTo = null;
    this.frontT = false;
    this.pushT = 0;   // a fresh possession clears any prior fast-break window
    this.clearPnr();  // any live pick-and-roll coverage ends with the possession
  }

  // Drop any live pick-and-roll coverage window.
  private clearPnr(): void {
    this.pnrCov = "";
    this.pnrT = 0;
    this.pnrHandlerDef = this.pnrScreenerDef = this.pnrScreener = null;
  }

  // The defending team commits to a look for THIS possession: press the
  // bring-up? sit in a half-court zone (2-3 packs the paint, 3-2 guards the
  // perimeter)? or straight man (where the pick-and-roll coverage applies).
  private schemePoss = -1;
  private pickDefScheme(): void {
    const defTeam = 1 - this.possession;
    const tac = this.tactics[defTeam].defense;
    this.pressOn = chance(tac.press);
    // a pressing possession still falls into man once the ball is up; only a
    // NON-pressing possession commits to a set half-court zone
    if (!this.pressOn && chance(tac.zone)) {
      const bigs = this.teamPlayers(defTeam).filter((p) => this.isBig(p));
      const tall = bigs.length ? bigs.reduce((s, p) => s + p.height, 0) / bigs.length : 2;
      // a tall front line packs a 2-3; otherwise a 3-2 sometimes guards the arc
      this.zoneScheme = (tall > 2.02 || chance(0.6)) ? "2-3" : "3-2";
    } else {
      this.zoneScheme = "";
    }
  }

  // 飛び出し: on a live-ball turnover, leak-out runners on the NEW offence take
  // off for their basket immediately, ahead of the defence getting back. Call
  // after resetMotion() (which clears cutting) at live change-of-possession sites.
  private leakOut(): void {
    for (const p of this.teamPlayers(this.possession)) {
      if (p === this.handler || !p.has("leakOut")) continue;
      const rim = this.attackFloor(p.team);
      p.cutting = true;
      p.offTimer = rand(2.0, 3.0);
      p.offTarget.set(rim.x + rand(-1.2, 1.2), 0, rim.z - Math.sign(rim.z || 1) * 1.0);
    }
  }

  // Defenders keep tracking their men even when the ball isn't "held".
  private runDefenseDuringDeadish(dt: number): void {
    const defTeam = 1 - this.possession;
    const protect = this.attackFloor(this.possession);
    const defenders = this.teamPlayers(defTeam);
    const offense = this.teamPlayers(this.possession);
    for (const d of defenders) {
      // the pass-jumper is sprinting to his interception point — leave him to it
      if (this.ballMode === "pass" && this.passSteal?.def === d) continue;
      d.decayLean(dt);   // nobody is duelling while the ball is in the air
      const man = offense[d.slot];
      // an outlet / throw-in is exactly when a big must sprint home, not shadow
      // a trailing man up-court
      if (this.getBackOnDefense(dt, d, man)) continue;
      const dx = protect.x - man.pos.x, dz = protect.z - man.pos.z;
      const len = Math.hypot(dx, dz) || 1;
      moveToward2D(d.pos, man.pos.x + (dx / len) * 1.5, man.pos.z + (dz / len) * 1.5,
        d.accelSpeed(dt) * dt);
      this.clampCourt(d.pos);
    }
  }

  // ---- turnovers ---------------------------------------------------------

  // A steal attempt knocks the ball LOOSE rather than teleporting it to the
  // defender, so the viewer sees it pop free and get chased down. A skilled
  // thief pops it toward himself (and the handler is left off-balance, unable to
  // grab it for a beat) so he usually comes up with it; a weak poke squirts it
  // free for anyone. The steal & turnover are credited only once the defence
  // actually secures it (handled in secureLoose).
  private steal(d: Player): void {
    const h = this.handler;
    if (!h) return;
    // how cleanly it's knocked toward the defender (0 = scattered, ~0.7 = right to
    // him). Capped lower than before so the ball POPS FREE and bounces on the
    // floor between them — a real loose ball to fight for — instead of snapping
    // straight into the thief's hands (which read as a magic bulldoze-grab).
    const grip = clamp(0.2 + rate(d.attr.reaction) * 0.55 - rate(h.attr.handling) * 0.3, 0.05, 0.7);
    const ax = d.pos.x - h.pos.x, az = d.pos.z - h.pos.z;
    const len = Math.hypot(ax, az) || 1;
    const ux = ax / len, uz = az / len;            // handler -> defender
    // knocked DOWN and away — starts low (poked out of the dribble at the hip)
    // and skips off the floor, so the ball is visibly off-ball, not floating
    // to a hand
    const power = rand(1.3, 2.4);
    this.ball.pos.set(h.pos.x + ux * 0.35, 0.75, h.pos.z + uz * 0.35);
    this.ball.vel.set(
      ux * power * grip + rand(-1.2, 1.2) * (1 - grip),
      rand(-0.2, 0.6),                             // low — a dig, not a lob
      uz * power * grip + rand(-1.2, 1.2) * (1 - grip),
    );
    // a longer free beat (0.35 → 0.55) so the poke-loose scramble is actually
    // visible before anyone secures it — the two divers reach for it meanwhile
    this.goLoose(h.team, 1.6, { stealBy: d, victim: h, grabAfter: 0.55 });
    d.digReach(new Vector3(this.ball.pos.x, 0.9, this.ball.pos.z));   // lunge — hand on the poke NOW
    h.touchCool = 0.5;                             // knocked off-balance — can't grab instantly
  }

  // Shot-clock expiry is an OFFENSIVE VIOLATION: a dead ball (not a live steal).
  // Play stops, the offence is charged a turnover, and the defence restarts with
  // a throw-in.
  private shotClockViolation(): void {
    const off = this.handler ?? this.teamPlayers(this.possession)[0];
    off.stats.tov++;
    const offTeam = this.possession;   // the team that committed the violation
    const def = 1 - offTeam;
    // FIBA: the throw-in is from the out-of-bounds spot NEAREST to where play was
    // stopped (no special case for the 24-second violation) — remember it now,
    // before the dead-ball pause moves anyone. The clock rule follows the spot:
    // in the new offence's FRONTcourt (i.e. the violation was committed in the
    // old offence's backcourt, a smothered bring-up) the restart clock is the
    // short one; a backcourt throw-in restarts with the full clock.
    const sx = this.ball.pos.x, sz = this.ball.pos.z;
    const front = sz * this.attackSign(def) > 0;
    this.handler = null;
    // announce the OFFENSIVE violation (attributed to the offence) and hold it on
    // screen through the dead-ball pause before the defence's throw-in restart
    this.setEvent("SHOT CLOCK VIOLATION", offTeam, 2.6);
    // the restart banner then says WHOSE ball the throw-in is
    this.pauseThen(1.2, () => this.withSubs(() => this.startInboundAt(def, sx, sz,
      { clock: front ? SHOT_CLOCK_PARTIAL : SHOT_CLOCK })));
  }

  private turnover(loser: Player, reason: string): void {
    loser.stats.tov++;
    // give the ball to the nearest opponent
    const opp = this.teamPlayers(1 - loser.team);
    let near = opp[0];
    for (const p of opp) {
      if (dist2D(p.pos, loser.pos) < dist2D(near.pos, loser.pos)) near = p;
    }
    this.handler = near;
    this.possession = near.team;
    this.ballMode = "held";
    this.shotClock = SHOT_CLOCK;
    near.decisionT = 0.4;
    this.resetMotion();
    this.leakOut();          // 飛び出し runners take off on the turnover
    this.setEvent(reason, near.team);
  }

  // ---- quarter / game end ------------------------------------------------

  // The period ends on the buzzer, but not abruptly: an END banner, then both
  // fives WALK OFF to their benches, hold there a beat, and (after any subs)
  // walk back out to their spots for the next period's throw-in.
  private endQuarter(): void {
    this.coastT = 0;
    this.ballFalling = false;
    const leader = this.score[0] === this.score[1]
      ? this.possession
      : (this.score[0] > this.score[1] ? 0 : 1);
    this.handler = null;
    this.gameClock = 0;
    const ended = this.quarter;
    // log this period's points for the result-screen line score (cumulative
    // score minus what the earlier periods already accounted for). Guarded so a
    // re-entrant buzzer path can't record the same quarter twice.
    if (this.qLine[0].length < ended) {
      for (let t = 0; t < 2; t++) {
        const prior = this.qLine[t].reduce((s, v) => s + v, 0);
        this.qLine[t].push(this.score[t] - prior);
      }
    }
    this.setEvent(ended === 2 ? "HALFTIME" : `END OF Q${ended}`, leader, 3.0);
    // the break itself restores some legs — halftime considerably more
    if (ended < QUARTERS) {
      const rest = ended === 2 ? 0.15 : 0.06;
      for (let t = 0; t < 2; t++) for (const p of this.roster[t]) p.breakRecover(rest);
    }

    // the FINAL horn gets its own scene: winners mob the floor, losers hang
    // their heads (a draw celebrates both benches) — no walk-off first
    if (ended >= QUARTERS) {
      this.pauseThen(1.2, () => this.startFinale());
      return;
    }

    this.pauseThen(1.2, () => this.quarterWalkOff(() => {
      // a short huddle at the bench, then the next period
      this.pauseThen(1.0, () => {
        this.quarter = ended + 1;
        this.gameClock = QUARTER_TIME;
        this.shotClock = SHOT_CLOCK;
        this.applyNumberSides(); // teams switch ends at half-time — numbers follow
        // Possession to start the period follows the opening-tip rule (NBA):
        // the team that LOST the opening jump ball starts Q2 & Q3; the winner
        // starts Q4 (ends switched in the second half via attackSign).
        const team = this.quarterStartTeam(this.quarter);
        this.withSubs(() => this.quarterWalkOn(team));
      });
    }));
  }

  // ---- final-horn scene: victory mob / hanging heads / a shared draw ------
  private static readonly FINALE_DUR = 6.0;
  private finaleT = 0;
  private finaleWinner = -1;   // 0/1 = winning team, -1 = draw
  private finaleWalkers: { p: Player; tx: number; tz: number }[] = [];   // winners mobbing the floor
  private finaleTrudge: { p: Player; tx: number; tz: number }[] = [];    // losers walking off dejected

  /** The FINAL horn: the winning bench pours onto the floor to mob the five,
   *  the losing five trudge off to their bench heads-down (the losing bench is
   *  already seated); a draw has both squads celebrating in place, more
   *  politely. "○○ 勝利!" runs on the banner. */
  private startFinale(): void {
    const w = this.score[0] === this.score[1] ? -1 : (this.score[0] > this.score[1] ? 0 : 1);
    this.finaleWinner = w;
    this.finaleT = 0;
    this.finaleWalkers = [];
    this.finaleTrudge = [];
    this.handler = null;
    this.cheerT = [-9, -9];   // the finale supersedes any running bench cheer
    this.setEvent(w >= 0 ? `${teamShort(w)} WINS!` : "DRAW",
      w >= 0 ? w : this.possession, Game.FINALE_DUR);
    // centre of the winning five, so the bench can fan out around them
    const winFive = w >= 0 ? this.teamPlayers(w) : [];
    const cx = winFive.length ? winFive.reduce((s, q) => s + q.pos.x, 0) / winFive.length : 0;
    const cz = winFive.length ? winFive.reduce((s, q) => s + q.pos.z, 0) / winFive.length : 0;
    for (let t = 0; t < 2; t++) {
      for (const p of this.roster[t]) {
        const onCourt = this.onCourt(p);
        if (t === w) {
          if (onCourt) continue;   // on-court winners celebrate in place (updateFinale)
          // the winning bench rushes the floor, fanning out around the five
          p.stand();
          p.resetFacing();
          const ang = (this.finaleWalkers.length / 8) * Math.PI * 2;
          this.finaleWalkers.push({
            p,
            tx: clamp(cx + Math.cos(ang) * 1.8, -COURT.halfW + 1, COURT.halfW - 1),
            tz: clamp(cz + Math.sin(ang) * 1.8, -COURT.halfL + 1, COURT.halfL - 1),
          });
        } else if (w < 0) {
          if (onCourt) continue;   // draw: on-court players celebrate in place
          p.stand();               // the bench stands up and claps along
          p.resetFacing();
        } else if (onCourt) {
          // the losing five trudge off toward the front of their own bench,
          // heads down (the deep seat can be a full court away — the gather
          // spot in front of the bench is a reachable target)
          const dir = t === 0 ? -1 : 1;
          this.finaleTrudge.push({ p, tx: COURT.halfW + 0.6, tz: dir * (8 + p.slot * 0.9) });
        } else if (!p.seated) {
          p.sit();       // the losing bench is already sitting, heads low
        }
      }
    }
    this.ballMode = "finale";
  }

  // Hands-up bounces for a celebrating body (amp 1 = full mob, ~0.4 = polite).
  private festivePose(p: Player, dt: number, amp: number): void {
    p.reach(new Vector3(p.pos.x, 2.7 + amp * 0.5, p.pos.z), true);   // both arms up
    if (!p.airborne && p.landT <= 0 && chance(dt * (1.2 + amp * 1.3))) {
      p.jump(0.1 + amp * rand(0.15, 0.3), rand(0.3, 0.45));
    }
  }

  private updateFinale(dt: number): void {
    this.finaleT += dt;
    const w = this.finaleWinner;
    this.ball.pos.y = Math.max(0.15, this.ball.pos.y - 3 * dt);   // ball settles
    for (let t = 0; t < 2; t++) {
      const won = t === w, draw = w < 0;
      for (const p of this.roster[t]) {
        const walker = this.finaleWalkers.find((f) => f.p === p);
        if (walker) {
          // bench mobbing the floor: sprint in, then bounce with the group
          if (dist2DTo(p.pos, walker.tx, walker.tz) > 0.6) {
            const jog = p.runSpeed * 0.9;
            moveToward2D(p.pos, walker.tx, walker.tz, jog * dt);
            p.faceToward(walker.tx, walker.tz);
            p.twistToward(walker.tx, walker.tz, dt);
            p.curSpd = jog;
            p.updateLegs(dt);
            p.runArms();
          } else {
            this.festivePose(p, dt, 1);
          }
          p.updateJump(dt);
          p.sync();
          continue;
        }
        const trudger = this.finaleTrudge.find((f) => f.p === p);
        if (trudger) {
          // the losing five walk off toward the bench, upper body hunched the
          // whole way — and keep standing there dejected once they arrive. They
          // are in this.players, so the main loop measures speed / runs the leg
          // cycle / syncs; here we only steer + hold the pose.
          if (dist2DTo(p.pos, trudger.tx, trudger.tz) > 0.4) {
            moveToward2D(p.pos, trudger.tx, trudger.tz, p.runSpeed * 0.6 * dt);   // heavy walk
            p.faceToward(trudger.tx, trudger.tz);
          }
          p.dejectedPose();                     // hunched forward, arms limp, all the way
          continue;
        }
        if (this.onCourt(p)) {
          // on-court bodies tick/sync in the main loop — just pose them
          if (won) this.festivePose(p, dt, 1);
          else if (draw) this.festivePose(p, dt, 0.45);
          else p.dejectedPose();
        } else if (draw) {
          // both benches share a standing, measured celebration at the seats
          this.festivePose(p, dt, 0.4);
          p.updateJump(dt);
          p.sync();
        } else {
          p.sync();   // the losing bench sits still, heads down
        }
      }
    }
    // keep the mob from stacking into one column
    const bodies: Player[] = [...this.players, ...this.finaleWalkers.map((f) => f.p)];
    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) {
        const a = bodies[i], b = bodies[j];
        let dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z;
        let d = Math.hypot(dx, dz);
        if (d >= 0.62) continue;
        if (d < 1e-4) { dx = rand(-1, 1); dz = rand(-1, 1); d = Math.hypot(dx, dz) || 1; }
        const push = (0.62 - d) / 2;
        a.pos.x -= (dx / d) * push; a.pos.z -= (dz / d) * push;
        b.pos.x += (dx / d) * push; b.pos.z += (dz / d) * push;
      }
    }
    if (this.finaleT >= Game.FINALE_DUR) {
      this.state = "final";
      this.setEvent("FINAL", this.score[0] >= this.score[1] ? 0 : 1);
    }
  }

  // Everyone on the floor walks to a gathering spot in front of his own bench.
  private quarterWalkOff(next: () => void): void {
    this.subWalkers = [];
    for (const p of this.players) {
      const dir = p.team === 0 ? -1 : 1;      // each team's bench half
      this.subWalkers.push({ p, tx: COURT.halfW + 0.6, tz: dir * (8 + p.slot * 0.9) });
    }
    // the ball doesn't stay lying where the period died — it's placed at the
    // NEXT period's throw-in spot (centre line, left sideline — where the taker
    // will stand) before the players head for their benches, like an official
    // setting it for the restart.
    this.ball.pos.set(-(COURT.halfW + 0.3), 0.12, 0);
    this.ball.vel.set(0, 0, 0);
    this.subNext = next;
    this.subT = 0;
    this.ballMode = "subs";
  }

  // The (possibly substituted) fives walk from the bench out to the exact
  // spots the quarter throw-in uses, then the throw-in is readied in place.
  private quarterWalkOn(team: number): void {
    const offense = this.teamPlayers(team);
    const defenders = this.teamPlayers(1 - team);
    const spots = this.formationSpots(team);
    const protect = this.attackFloor(team);
    this.subWalkers = [];
    for (const p of offense) {
      if (p === offense[2]) {                 // the throw-in taker heads wide
        this.subWalkers.push({ p, tx: -(COURT.halfW + 0.3), tz: 0 });
      } else {
        this.subWalkers.push({ p, tx: spots[p.slot].x, tz: spots[p.slot].z });
      }
    }
    for (const d of defenders) {
      const s = spots[d.slot];                // goal-side of the man's spot
      const dx = protect.x - s.x, dz = protect.z - s.z;
      const len = Math.hypot(dx, dz) || 1;
      this.subWalkers.push({ p: d, tx: s.x + (dx / len) * 1.4, tz: s.z + (dz / len) * 1.4 });
    }
    this.subNext = () => this.startQuarterInbound(team, true);
    this.subT = 0;
    this.ballMode = "subs";
  }

  // Which team starts the given quarter, by the opening-tip rule.
  private quarterStartTeam(quarter: number): number {
    const loser = 1 - this.tipWinner;
    return (quarter === 2 || quarter === 3) ? loser : this.tipWinner;
  }
}
