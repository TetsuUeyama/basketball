import { Scene, Vector3, Mesh } from "@babylonjs/core";
import { Player, Ball } from "./entities";
import { makeHandlerRing } from "./court";
import {
  COURT, RIM, SHOOT_RANGE, THREE_DIST, PASS_SPEED,
  SHOT_CLOCK, SHOT_CLOCK_PARTIAL, QUARTER_TIME, QUARTERS,
} from "./config";
import { clamp, dist2D, dist2DTo, moveToward2D, chance, rand } from "./util";
import { ROSTER, ROSTER_SIZE, STARTERS, TACTICS, rate, AbilityKey } from "./attributes";

export type BallMode = "held" | "pass" | "shot" | "loose" | "inbound" | "tipoff" | "freethrow" | "pause" | "subs";

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
  readonly subEvents: { text: string; team: number; ttl: number }[] = [];
  // substitution walk-on/walk-off animation ("subs" ball mode): each walker
  // heads to his target; play resumes (subNext) once everyone has arrived
  private subWalkers: { p: Player; tx: number; tz: number }[] = [];
  private subNext: (() => void) | null = null;
  private subT = 0;
  // bench celebration timers per team — while positive, the bench is on its
  // feet bouncing with both arms up (a short grace period lets jumps land)
  private cheerT: [number, number] = [0, 0];
  readonly ball: Ball;
  private readonly ring: Mesh;
  private readonly tactics = TACTICS; // per-team game plan

  // --- score / clock ---
  score: [number, number] = [0, 0];
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
  private dribbleT = 0;   // advances while the ball is held, to bounce the dribble
  // true once the ball has been established in the frontcourt this possession —
  // from then on, taking it back across halfway is a BACKCOURT violation
  private frontT = false;

  // pass animation
  private passFrom = new Vector3();
  private passTo: Player | null = null;
  private passT = 0;
  private passDur = 0;
  private passer: Player | null = null;                         // who released the current pass
  private passSteal: { def: Player; at: number } | null = null; // decided once at pass time

  // shot animation
  private shotFrom = new Vector3();
  private shotMade = false;
  private shotPoints = 2;
  private shotT = 0;
  private shotDur = 0;
  private shooter: Player | null = null; // who is taking the current shot
  private shooterFinishing = false;      // true for a layup/dunk (drives toward the rim)
  private finishSpot = new Vector3();    // where the finisher gathers & rises — short of the rim, not under it
  private shotApex = 2.2;   // arc height — low for layups/dunks, high for jumpers

  // loose-ball (rebound) / inbound timers
  private looseT = 0;        // safety timeout before a loose ball is guaranteed grabbed
  private looseTips = 0;     // how many times the ball has been tipped while loose
  private looseOff = 0;      // the offensive team when the ball came loose (for the rebound label)
  private looseIsRebound = false; // true when the loose ball came off a missed shot
  private looseStealBy: Player | null = null;     // defender who poked/deflected it loose
  private looseStealVictim: Player | null = null; // ball-handler/passer who lost it
  private looseAge = 0;                            // how long the ball has been loose
  private looseGrabAfter = 0;                      // delay before it can be secured (a visible scramble)
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
    const x = COURT.halfW + 1.3;                  // far (+X) sideline, away from the camera
    const zEnd = COURT.halfL - 1;                 // first seat just inside the baseline
    const z = (p.team === 0 ? -1 : 1) * (zEnd - p.idx * 0.8);
    return { x, z };
  }

  private seatOnBench(p: Player): void {
    const s = this.benchSeat(p);
    p.pos.set(s.x, 0, s.z);
    p.cutting = false;
    p.screening = false;
    p.handsRest();
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
    let d = p.fatigue * 1.6 - 0.55;                       // tired → out
    const s = p.stats;
    const eff = s.pts + s.reb + s.ast - s.tov * 2 - (s.fga - s.fgm) * 0.5;
    if (eff <= -2) d += 0.3;                              // cold / turnover-prone night
    // blowout in the 4th: rest the regulars, empty the bench (starters first)
    const diff = Math.abs(this.score[0] - this.score[1]);
    if (this.quarter >= QUARTERS && diff >= 18) d += p.idx < STARTERS ? 0.7 : 0.2;
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
    this.players[i] = sub;
    const seat = this.benchSeat(out);
    this.subWalkers.push({ p: sub, tx: cx, tz: cz });     // jogs in from his seat
    this.subWalkers.push({ p: out, tx: seat.x, tz: seat.z }); // walks off to his
    this.subsMade++;
    this.subEvents.push({
      text: `#${sub.idx + 1} ${sub.name} In / #${out.idx + 1} ${out.name} Out`,
      team: out.team,
      ttl: 3,
    });
  }

  /** Kick off a bench celebration for the scoring team. */
  private benchCheer(team: number, duration = 1.8): void {
    this.cheerT[team] = Math.max(this.cheerT[team], duration);
  }

  // While a cheer is running, everyone on that bench bounces with both arms up;
  // when it winds down they land, drop their arms and sit back into the game.
  // Bench players get no per-frame updates elsewhere, so jump/sync tick here.
  private updateBenchCheer(dt: number): void {
    for (let t = 0; t < 2; t++) {
      if (this.cheerT[t] <= -0.8) continue;     // fully settled
      this.cheerT[t] -= dt;
      const winding = this.cheerT[t] <= 0;      // grace period: land & rest arms
      for (const p of this.roster[t]) {
        if (this.onCourt(p)) continue;
        if (this.subWalkers.some((w) => w.p === p)) continue; // mid-walk — not cheering
        p.updateJump(dt);
        if (!winding) {
          if (!p.airborne && chance(2.5 * dt)) p.jump(rand(0.25, 0.45), rand(0.35, 0.5));
          // arms overhead, angled a touch differently per player so the bench
          // doesn't celebrate in lockstep
          const ox = ((p.idx * 37) % 11 - 5) * 0.06;
          const oy = ((p.idx * 13) % 7) * 0.08;
          p.reach(new Vector3(p.pos.x + ox, 3.1 + oy, p.pos.z), true);
        } else {
          p.handsRest();
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
    for (const e of this.subEvents) e.ttl = Math.max(e.ttl, 1.2); // hold the chips
    this.ball.pos.y = Math.max(0.3, this.ball.pos.y - 3 * dt);    // ball rests

    const timedOut = this.subT >= 6;   // safety: never let a walk stall the game
    let done = true;
    for (const w of this.subWalkers) {
      if (!timedOut && dist2DTo(w.p.pos, w.tx, w.tz) > 0.25) {
        done = false;
        // a plain jog, NOT accelSpeed: walk-off men are no longer in `players`,
        // so their measured curSpd never updates and accelSpeed would keep them
        // frozen at ~0 — both walkers move together at the same steady pace
        const jog = w.p.runSpeed * 0.85 * (1 - w.p.fatigue * 0.2);
        moveToward2D(w.p.pos, w.tx, w.tz, jog * dt);
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
    if (done || timedOut) {
      for (const w of this.subWalkers) {
        w.p.pos.set(w.tx, 0, w.tz);
        // invariant: nobody stands ON the court with a bench yaw — enforce it
        // whenever a walk phase hands players back to live play
        if (this.onCourt(w.p)) w.p.resetFacing();
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
    return [
      new Vector3(0, 0, hz + dir * 7.5),     // top
      new Vector3(-5, 0, hz + dir * 6),      // left wing
      new Vector3(5, 0, hz + dir * 6),       // right wing
      new Vector3(-6.3, 0, hz + dir * 2.5),  // left corner
      new Vector3(6.3, 0, hz + dir * 2.5),   // right corner
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

  // 連携: how faithfully this player executes the team's tactical plan — the
  // multiplier applied to every tactic-driven term in his decisions.
  private twWeight(p: Player): number {
    return 0.35 + rate(p.attr.teamwork) * 0.65;
  }

  // 反応: multiplier on reaction lags (lower = reacts sooner).
  private reactionLag(p: Player): number {
    return 1.35 - rate(p.attr.reaction) * 0.75;      // ~1.27 (slow) .. ~0.6 (instant)
  }

  // L速度: how far out this player is willing to shoot from (+特能ミドル).
  private shootRangeOf(p: Player): number {
    return SHOOT_RANGE - 0.7 + rate(p.attr.threeRange) * 2.4   // ~7.1 .. ~9.3 m
      + (p.has("range") ? 1.2 : 0);
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
      || text === "TIP-OFF"                // the game clearly begins...
      || text === "HALFTIME"
      || text === "2ND HALF"
      || text === "FINAL"
      || text.startsWith("END OF Q")       // ...and each period clearly ends
      || /^Q\d START$/.test(text);         // ...and clearly restarts
  }

  // ---- lifecycle ---------------------------------------------------------

  reset(): void {
    this.score = [0, 0];
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
    this.cheerT = [-1, -1];
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
    for (const p of this.players) { p.cutting = false; p.offTimer = rand(0.4, 2); p.spotIdx = this.homeSpotIdx(p); }

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
    // the new period visibly begins as the throw-in is readied
    this.setEvent(this.quarter === 3 ? "2ND HALF" : `Q${this.quarter} START`, team, 2.0);
  }

  // ---- main update -------------------------------------------------------

  update(dt: number): void {
    if (this.eventT > 0) this.eventT = Math.max(0, this.eventT - dt);
    if (this.eventT === 0) this.lastEvent = null;
    // age out the substitution feed (entries are pushed in order, so the
    // oldest is always at the front)
    for (const e of this.subEvents) e.ttl -= dt;
    while (this.subEvents.length && this.subEvents[0].ttl <= 0) this.subEvents.shift();

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
        && this.ballMode !== "pause" && this.ballMode !== "subs") {
      this.gameClock -= dt;
      for (const p of this.players) { p.stats.min += dt; p.stintT += dt; }
      if (this.ballMode === "held") {
        this.shotClock -= dt;
        if (this.shotClock <= 0) {
          this.turnover(this.handler!, "SHOT CLOCK");
        }
      }
      // the buzzer: a shot already in the air is allowed to finish (buzzer
      // beater) — resolveShot hands the period end over once it lands
      if (this.gameClock <= 0 && this.ballMode !== "shot") {
        this.endQuarter();
      }
    }

    // ball-state machine
    switch (this.ballMode) {
      case "held": this.updateLive(dt); break;
      case "pass": this.updatePass(dt); break;
      case "shot": this.updateShot(dt); break;
      case "loose": this.updateLoose(dt); break;
      case "inbound": this.updateInbound(dt); break;
      case "tipoff": this.updateTipoff(dt); break;
      case "freethrow": this.updateFreeThrow(dt); break;
      case "pause": this.updatePause(dt); break;
      case "subs": this.updateSubs(dt); break;
    }

    this.resolveCollisions();
    const resting = this.ballMode === "pause" || this.ballMode === "freethrow"
      || this.ballMode === "tipoff" || this.ballMode === "subs";
    for (const p of this.players) {
      p.updateJump(dt);
      p.tickCooldown(dt);
      p.tickMotion(dt, resting);   // measure real speed, drain/recover fatigue
    }
    // the bench recovers while they sit, watching the ball with small personal
    // fidgets — unless they're celebrating (updateBenchCheer animates that) or
    // mid-walk in a substitution (they just track the ball with their eyes)
    for (let t = 0; t < 2; t++) {
      const cheering = this.cheerT[t] > -0.8;
      for (const p of this.roster[t]) {
        if (this.onCourt(p)) continue;
        p.benchRecover(dt);
        if (this.subWalkers.some((w) => w.p === p)) {
          p.faceToward(this.ball.pos.x, this.ball.pos.z);
        } else if (!cheering) {
          p.benchIdle(dt, this.ball.pos.x, this.ball.pos.z);
        }
      }
    }
    this.updateFacing(dt);
    this.syncAll();
  }

  // On-court players turn to face the play: the ball-handler and shooter square
  // up to the basket they attack, and everyone else (defenders keeping eyes on
  // the ball, off-ball attackers reading it) turns toward the ball. Eased so
  // bodies track rather than snap. Skipped during substitutions, where players
  // walk to set spots. Bench players aim their own gaze in benchIdle.
  private updateFacing(dt: number): void {
    if (this.ballMode === "subs") return;
    const b = this.ball.pos;
    const step = 8 * dt;   // rad this frame: fast enough to follow the ball, eased enough not to snap
    for (const p of this.players) {
      if (p === this.handler || p === this.shooter) {
        const rim = this.attackFloor(p.team);
        p.faceSmooth(rim.x, rim.z, step);
      } else {
        p.faceSmooth(b.x, b.z, step);
      }
    }
  }

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
    for (const p of this.players) p.handsRest();
    const b = this.ball.pos;
    switch (this.ballMode) {
      case "held": {
        if (this.handler) {
          // hand hovers at dribble height while the ball bounces below it
          this.handler.reach(new Vector3(b.x, 0.95, b.z));
          // the man guarding him plays active hands; right on top, he stabs at it
          const d = this.onBallDefender(this.handler);
          if (d) {
            if (dist2D(d.pos, this.handler.pos) < 0.9) d.reach(b); // poking for the steal
            else d.armsWide();                                     // walling off lanes & the drive
          }
        }
        break;
      }
      case "inbound":
        this.handler?.reach(b);                      // holds the ball to throw it in
        break;
      case "shot":
        if (this.shooter && this.shotT < this.shotDur * 0.45) this.shooter.reach(b, true);
        this.raiseAirborne(b, this.shooter);         // contesting defenders go up
        break;
      case "freethrow":
        if (this.ftT < 1.4) this.ftShooter?.reach(b, true);
        break;
      case "pass":
        if (this.passT < this.passDur * 0.4) this.passer?.reach(b);        // release...
        else if (this.passT > this.passDur * 0.6) this.passTo?.reach(b);   // ...and catch
        if (this.passSteal) this.passSteal.def.reach(b);                   // jumping the lane
        break;
      case "loose":
        this.raiseAirborne(b, null);                 // everyone going up for the board reaches up
        break;
      case "tipoff":
        this.teamPlayers(0)[4].reach(b, true);       // both centres tip with both hands
        this.teamPlayers(1)[4].reach(b, true);
        break;
      // "pause": nobody is holding the ball — arms stay at rest
    }
  }

  // Players in the air (contesting a shot or crashing the glass) raise both hands
  // up toward the ball to grab, tip, or block it.
  private raiseAirborne(b: Vector3, except: Player | null): void {
    for (const p of this.players) {
      if (p !== except && p.airborne) p.reach(b, true);
    }
  }

  // ---- live play (ball is held) -----------------------------------------

  private updateLive(dt: number): void {
    const h = this.handler!;
    // ball clearly past halfway → frontcourt established for this possession
    if (!this.frontT && this.attackSign(h.team) * h.pos.z > 0.6) this.frontT = true;
    this.runOffense(dt, h);
    this.runDefense(dt);
    // ball dribbles in front of the handler, toward the basket: it bounces
    // between hand height and the floor so it reads as a live dribble (dam-dam)
    const rim = this.attackFloor(h.team);
    const dx = rim.x - h.pos.x, dz = rim.z - h.pos.z;
    const len = Math.hypot(dx, dz) || 1;
    this.dribbleT = (this.dribbleT + dt) % 1000;
    const bounce = Math.abs(Math.cos(Math.PI * this.dribbleT * 2.2)); // 1 = at the hand, 0 = floor
    const y = 0.18 + (1.0 - 0.18) * bounce;
    this.ball.pos.set(h.pos.x + (dx / len) * 0.4, y, h.pos.z + (dz / len) * 0.4);
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
      h.decisionT = rand(0.25, 0.45) * (1.35 - rate(h.attr.offense) * 0.7);
      this.decide(h, dHoop, dDef, rimFloor);
    }

    // movement: how the committed 1-on-1 move plays out. D速度 sets how much of
    // his top speed survives while dribbling.
    let mult = 0.84 + rate(h.attr.dribbleSpd) * 0.18;
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
      // probing dribble between moves — a body in the lane holds him up (balance
      // battle), but this is just jostling, not a committed attack
      const imp = this.driveImpeder(h);
      if (imp) {
        const edge = clamp(rate(h.attr.balance) - rate(imp.attr.balance)
          + (h.has("post") ? 0.12 : 0), -0.6, 1);
        const base = this.isBig(h) ? 0.34 : 0.38;
        mult *= clamp(base + edge * 0.6, 0.2, 0.95);
      }
      moveToward2D(h.pos, h.driveTarget.x, h.driveTarget.z, h.accelToward(dt, h.driveTarget.x, h.driveTarget.z, mult) * dt);
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

    // change of possession: the ball has to be carried up, and that's a guard's
    // job. A PF/C who ends up with it before the frontcourt is set looks for the
    // point guard first, then the shooting guard, and hands it off rather than
    // dribbling it up himself. (An offensive rebound keeps frontT, so a big
    // still finishes at the rim there — this only fires while bringing it up.)
    if (!this.frontT && this.isBig(h) && dHoop > 10) {
      const tp = this.teamPlayers(h.team);
      for (const g of [tp[0], tp[1]]) {          // PG first, SG as the backup
        if (g !== h && this.outletTo(h, g)) return;
      }
      this.advanceSafely(h);                     // no guard free yet — hold/drift, don't attack
      return;
    }

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

    const urgent = this.shotClock < 4 + tac.pace * 3 * this.twWeight(h); // up-tempo teams force earlier
    if (urgent) { this.shoot(h, dHoop, dDef); return; }

    // desire to do each thing = personality + skill + tactics(×連携) + scoring
    // role + 特殊能力 (ドリブラー/ストライカー/ドリブルキープ)
    const tw = this.twWeight(h);
    let driveDesire = rate(h.attr.aggression) * 0.35 + rate(h.attr.handling) * 0.25 + tac.driveBias * 0.4 * tw;
    if (h.has("driver")) driveDesire += 0.25;        // ドリブラー: hunts the blow-by
    let shootDesire = rate(h.attr.aggression) * 0.4 + prio * 0.4 + tac.pace * 0.2 * tw;
    if (h.has("striker")) shootDesire += 0.15;       // ストライカー: scorer's mentality
    if (h.has("keepDribble")) shootDesire -= 0.08;   // キープ型は攻め急がない
    const passDesire = (1 - rate(h.attr.aggression)) * 0.25 + rate(h.attr.passAcc) * 0.2
      + tac.ballMovement * 0.4 * tw + (1 - prio) * 0.25; // lower options give it up more

    const laneOpen = this.laneClear(h, rimFloor);
    const beaten = h.beatenT > 0;
    const isThree = dHoop > THREE_DIST;

    // clear path to the rim within range → usually attack (a layup beats a jumper),
    // unless a pass-first player kicks it or an elite shooter has a wide-open look
    if ((beaten || laneOpen) && dHoop <= 9) {
      if (!beaten && isThree && dDef > 2.0 && rate(h.attr.threeAcc) > 0.65
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
    if (dHoop <= this.shootRangeOf(h) + 0.3) {
      // 1対1シュート: happy to rise over a single defender
      const open = dDef > (h.has("isoShooter") ? 1.4 : 1.8);
      let pShoot = 0.12 + shootDesire * 0.55 - (dHoop - 2) * 0.05 + (dDef - 1) * 0.28;
      if (isThree) pShoot += tac.threeBias * 0.22 * tw - 0.05;
      pShoot = clamp(pShoot, 0.03, 0.95);
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
    this.setDrive(h, rimFloor, 4.5); // reset / probe
  }

  // A teammate who is a clearly higher scoring option, is open, and can be
  // reached with a reasonably safe pass — the "swing it to the go-to guy" read.
  private betterOptionAvailable(h: Player): Player | null {
    let best: Player | null = null;
    let bestPrio = h.offPriority + 0.1;          // must be a meaningfully better option
    for (const p of this.teamPlayers(h.team)) {
      if (p === h || p.offPriority <= bestPrio) continue;
      if (p === this.assistFrom && this.assistTo === h && !p.cutting) continue; // no ping-pong
      if (dist2D(h.pos, p.pos) > MAX_PASS) continue;            // out of range
      if (this.frontT && this.attackSign(h.team) * p.pos.z < 0.4) continue; // backcourt
      if (this.nearestDefenderDist(p) < 2.0) continue;          // not actually open
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
    this.setDrive(h, this.attackFloor(h.team), 8);   // ~top of the key, in the frontcourt
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
      h.driveSide = chance(0.5) ? 1 : -1;
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
    const speedEdge = rate(h.attr.handling) * 0.45 + rate(h.attr.agility) * 0.35
      + rate(h.attr.dribbleAcc) * 0.2 + (h.has("driver") ? 0.1 : 0)
      - (rate(d.attr.agility) * 0.55 + rate(d.attr.reaction) * 0.35
        + rate(d.attr.defense) * 0.35 + (d.has("manMark") ? 0.12 : 0));
    // POWER is a physical battle: the defender resists mostly with ボディバランス
    // (raw strength), and only secondarily with 守判断 — so a strong-bodied
    // defender walls off a bull drive even if his defensive IQ is ordinary.
    const powerEdge = rate(h.attr.balance) * 0.6 + rate(h.attr.aggression) * 0.25
      + rate(h.attr.dribbleAcc) * 0.15 + (h.has("post") ? 0.15 : 0)
      - (rate(d.attr.balance) * 1.0 + rate(d.attr.defense) * 0.35);

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
      h.driveSide = d.shadeSide !== 0 ? -d.shadeSide : (chance(0.5) ? 1 : -1);
      const pPower = clamp(0.52 + powerEdge * 0.96, 0.04, 0.9);
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
    const fakeDir = finalShake && Math.abs(d.lean) > 0.15
      ? (d.lean > 0 ? 1 : -1)
      : h.lastFakeDir !== 0 ? -h.lastFakeDir : (chance(0.5) ? 1 : -1);
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
    const pBeat = clamp(0.46 + speedEdge * 0.95 + wrongWay * 0.45, 0.02, 0.95);
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
      h.driveSide = chance(0.5) ? 1 : -1;
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

    for (const d of defenders) {
      const man = offense[d.slot]; // man-to-man by matching index
      const isOnBall = man === this.handler;
      // off the ball any lingering lean (from a duel that just ended, a switch,
      // a kick-out) eases back to square at the player's quickness
      if (!isOnBall) d.decayLean(dt);

      if (isOnBall) {
        this.defendOnBall(dt, d, man, protect);
        // reach in for a steal from the cushion — sharper reactions and reads get
        // more, a secure dribble (D精度) protects the ball, and an aggressive
        // game plan gambles (and fouls) more
        const press = this.tactics[defTeam].defense.pressure * this.twWeight(d);
        const gap = dist2D(d.pos, man.pos);
        if (gap < 1.5) {
          const close = 1 - gap / 1.5;                 // 1 at point-blank, 0 at 1.5 m
          const stl = rate(d.attr.reaction) * 0.5 + rate(d.attr.defense) * 0.3
            + rate(d.attr.agility) * 0.2;
          // ドリブルキープ shields the ball; スライディング strips it more often
          const resist = rate(man.attr.dribbleAcc) * 0.6 + rate(man.attr.handling) * 0.4
            + (man.has("keepDribble") ? 0.25 : 0);
          const slide = d.has("interceptor") ? 1.3 : 1;
          const pPoke = Math.max(0.005, (0.03 + stl * 0.1 - resist * 0.06 + press * 0.05) * slide);
          if (chance(pPoke * close * dt)) { this.steal(d); return; }
          if (chance((0.02 + press * 0.045) * close * dt)) { this.defensiveFoul(man); return; }
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
      if (this.handler && this.isBig(d) && !isOnBall) {
        const hx = this.handler.pos.x, hz = this.handler.pos.z;
        const dRim = dist2DTo(this.handler.pos, protect.x, protect.z);
        const driving = this.handler.beatenT > 0 || this.handler.powerT > 0;
        if (driving && dRim < 8) {
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

      // transition: caught up-court when possession flipped — get back FIRST
      if (this.getBackOnDefense(dt, d, man)) continue;

      // off-ball: sag toward the basket to help — more for high-help game plans,
      // followed faithfully only by players who buy into the scheme (連携), and
      // organised a step deeper by a DFライン general
      const help = this.tactics[defTeam].defense.help * this.twWeight(d);
      const sag = (1.2 + help * 1.4) * (this.teamHas(defTeam, "dfLine") ? 1.15 : 1);
      const dx = protect.x - man.pos.x, dz = protect.z - man.pos.z;
      const len = Math.hypot(dx, dz) || 1;
      const stx = man.pos.x + (dx / len) * sag, stz = man.pos.z + (dz / len) * sag;
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
    const star = clamp((d.offPriority - 0.45) / 0.4, 0, 1);  // 0 role .. 1 star
    if (star <= 0) return 1;
    if (this.quarter >= 4 && Math.abs(this.score[0] - this.score[1]) <= 6) return 1;
    const nearGoal = clamp(1 - dist2D(d.pos, protect) / 9, 0, 1); // 1 at the rim
    const e = 0.68 + (0.9 - 0.68) * nearGoal;   // cruising 0.68 .. 0.9 at the goal
    return 1 - star * (1 - e);
  }

  // On-ball defence: shade toward the side the handler is attacking (with a
  // reaction lag), stay goal-side to cut off the drive, and chase to recover
  // when beaten off the dribble.
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
    let gap = postUp
      ? 0.45 - this.tactics[d.team].defense.pressure * 0.1   // ~0.35 (tight) on the post
      : 1.25 - this.tactics[d.team].defense.pressure * 0.35; // ~0.9 .. 1.25 cushion otherwise
    if (d.has("manMark")) gap *= 0.85;

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
      const mirror = 0.35 + rate(d.attr.agility) * 0.55 + rate(d.attr.reaction) * 0.3;
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
      moveToward2D(d.pos, 0, tz, d.accelToward(dt, 0, tz, 1.15) * dt);
      this.clampCourt(d.pos);
      return true;
    }
    if (upCourt && manBack) {
      // he and his man are BOTH still up-court: sprint goal-side (top of the
      // key, shaded toward his man's lane) instead of jogging beside a trailer
      // while the ball attacks an open basket
      const tx = man.pos.x * 0.4, tz = s * (RIM.z - 7);
      moveToward2D(d.pos, tx, tz, d.accelToward(dt, tx, tz, 1.12) * dt);
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
    if (this.ballMode === "subs" || this.ballMode === "pause") return;
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
    let w = 0.5 + rate(p.attr.balance) * 1.5;                 // ~0.65 (weak) .. ~2.0 (strong)
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
    const riskTolerance = clamp(
      0.12 + rate(h.attr.passAcc) * 0.2 + rate(h.attr.offense) * 0.1
      + (h.has("outside") ? 0.08 : 0)   // アウトサイド: trusts the tough angle
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
      const progress = 1 / (1 + dist2D(p.pos, rimFloor)); // closer to rim = better
      // vision: a low offensive IQ misjudges how good each option really is
      let value = open + progress * 3 + rand(-1, 1) * (1 - rate(h.attr.offense)) * 0.8;
      if (p.cutting) value += 1.5;            // reward feeding a cutter
      if (atRimCutter) value += 1.5;          // ...especially one open at the rim
      // スルーパス: lives for the killer feed to a cutter
      if (h.has("throughPass") && p.cutting) value += 1.5;
      // don't just toss it straight back to the man who fed you — unless he's
      // genuinely cutting to the rim (the real give-and-go)
      if (p === this.assistFrom && this.assistTo === h
          && !(p.cutting && dist2D(p.pos, rimFloor) < 6.5)) {
        value -= 3.0;
      }
      if (backcourt) {
        // bringing it up is a GUARD's job: outlet to the playmaker. A big only
        // gets it here on a genuine hit-ahead — already free near the basket —
        // never as a bail-out just because he happens to be the most open man
        // (when the guards are smothered the handler keeps the dribble and the
        // outlet man drops back to him instead). Only a dying clock overrides.
        if (this.isBig(p) && dist2D(p.pos, rimFloor) > 6 && this.shotClock > 4) continue;
        value += p.playmaking * 4.0;
      }
      else value += p.offPriority * 1.6 * clamp(open / 2, 0, 1);   // feed an open scorer
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
    const zip = 1.08 - rate(from.attr.passSpd) * 0.25;            // fast pass = harder to cut
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
    if (d > 9) {
      const fade = clamp(1 - (d - 9) * 0.06, 0.6, 1);
      const flightT = d / (PASS_SPEED * (0.8 + rate(from.attr.passSpd) * 0.5) * fade);
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
    return chance(p) ? { def: block.def, at: block.t } : null;
  }

  private pass(h: Player): boolean {
    const target = this.chooseReceiver(h);
    if (!target) return false;
    return this.passToReceiver(h, target);
  }

  // Throw to a specific receiver — used both by the general read (chooseReceiver)
  // and by an explicit decision to swing the ball to a better scoring option.
  private passToReceiver(h: Player, target: Player): boolean {
    // The ball homes onto the receiver, so what matters is the distance to the
    // CATCH point, not to where he stands now — lead a sprinting receiver by
    // his velocity over the flight. Without this, a 7 m release stretches into
    // a cross-court bomb that dodges every range/interception check.
    const zip0 = PASS_SPEED * (0.8 + rate(h.attr.passSpd) * 0.5);
    const d0 = dist2D(h.pos, target.pos);
    const lead = d0 / zip0;                              // first-pass flight time
    const cx = target.pos.x + target.velX * lead;
    const cz = target.pos.z + target.velZ * lead;
    const d = Math.hypot(cx - h.pos.x, cz - h.pos.z);    // true flight distance
    if (d > MAX_PASS + 1.5) return false;                // the bomb isn't on — keep it

    // FINAL safety gate for every pass, whatever read chose it (outlet after a
    // rebound, kick-out, swing): a defender standing in the lane, or a full
    // risk estimate that says "likely turnover", means the ball simply doesn't
    // get thrown. Only a dying shot clock forces a heave through traffic.
    if (this.shotClock > 2
        && (this.laneVetoed(h, target)
          || this.passRisk(h, target) > 0.3
          || (!target.cutting && this.nearestDefenderDist(target) < 1.0))) {
      return false;
    }

    this.passFrom.set(h.pos.x, 1.1, h.pos.z);
    this.passTo = target;
    this.passer = h;
    this.passT = 0;
    // P速度: how hard this player zips the ball — but past ~9 m even a bullet
    // runs out of steam, so long balls hang in the air noticeably longer
    const fade = d > 9 ? clamp(1 - (d - 9) * 0.06, 0.6, 1) : 1;
    this.passDur = Math.max(0.22, d / (zip0 * fade));
    this.passSteal = this.evalInterception(h, target);
    // a hanging long ball can be run down even when nobody sat squarely in the
    // lane at release (スライディング readers range the furthest)
    if (!this.passSteal && d > 9) {
      this.passSteal = this.longBallRead(h, target, this.passDur, d);
    }
    this.ballMode = "pass";
    this.handler = null;
    // follow-through: the passer is rooted briefly and can't immediately
    // re-engage — quick players (敏捷性) reset their balance sooner
    h.coolT = rand(0.5, 0.9) * h.recoveryMult();
    // give-and-go SOMETIMES: always cutting after a pass made the return feed
    // to the "cutter" the best read every time — an A→B→A ping-pong. Now the
    // passer usually just relocates, and only sometimes cuts for the give-and-go.
    if (chance(0.35)) {
      const rim = this.attackFloor(h.team);
      h.cutting = true;
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
      const ix = this.passFrom.x + (this.passTo.pos.x - this.passFrom.x) * this.passSteal.at;
      const iz = this.passFrom.z + (this.passTo.pos.z - this.passFrom.z) * this.passSteal.at;
      moveToward2D(d.pos, ix, iz, d.accelSpeed(dt, 1.08) * dt);
      this.clampCourt(d.pos);
    }

    this.passT += dt;
    const k = Math.min(1, this.passT / this.passDur);
    const a = this.passFrom, b = this.passTo!.pos;
    this.ball.pos.set(
      a.x + (b.x - a.x) * k,
      (1.1 + (1.0 - 1.1) * k) + Math.sin(k * Math.PI) * 0.4, // hand-to-hand with a slight arc
      a.z + (b.z - a.z) * k,
    );

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
      // ダイレクトプレイ: plays off the catch in one touch
      receiver.decisionT = receiver.has("oneTouch") ? 0.08 : 0.25;
      receiver.quickT = 0.6;
      // a completed pass sets up a potential assist for whoever threw it
      this.assistFrom = this.passer;
      this.assistTo = receiver;
    }
  }

  private shoot(h: Player, dHoop: number, dDef: number): void {
    this.pendingAssist = this.assistCreditFor(h);
    const isThree = dHoop > THREE_DIST;
    this.shotPoints = isThree ? 3 : 2;

    // make % = the shooter's skill at this range, less distance and contest
    const skill = rate(isThree ? h.attr.threeAcc : h.attr.midAcc);
    const baseLine = isThree ? 0.16 : 0.30;
    const distRef = isThree ? THREE_DIST : 1.5;
    // L速度 flattens the falloff on deep threes; 特能ミドル flattens it everywhere
    let falloff = isThree ? 0.05 - rate(h.attr.threeRange) * 0.035 : 0.03;
    if (h.has("range")) falloff *= 0.65;
    let p = baseLine + skill * 0.42 - Math.max(0, dHoop - distRef) * falloff;
    // カーブ: an angled mid-range look can use the glass for a cleaner make
    if (!isThree && Math.abs(h.pos.x) > 1.5 && dHoop < 6.5) {
      p += rate(h.attr.bank) * 0.07;
    }
    // ダイレクトプレイ: the catch-and-shoot rhythm is his shot
    if (h.quickT > 0 && h.has("oneTouch")) p += 0.05;
    // contest — S威力 shoots through the contact; a 1対1シュート specialist
    // barely feels a single defender (only real help bothers him)
    let contestScale = 1 - rate(h.attr.shotStrength) * 0.55;
    if (h.has("isoShooter") && this.defendersWithin(h, 2.4) <= 1) contestScale *= 0.6;
    p -= clamp(1.8 - dDef, 0, 1.8) * 0.18 * contestScale;
    // off-balance (shooting on the move) — S技術 keeps the mechanics clean
    if (h.beatenT > 0 || h.curSpd > h.runSpeed * 0.55) {
      p -= 0.10 * (1 - rate(h.attr.shotTech));
    }
    // 精神: fatigue, a deficit and crunch time rattle a weak mind
    p -= this.clutchFactor(h) * 0.12;
    p = clamp(p, 0.04, 0.93);
    this.shotMade = chance(p);

    const blocker = this.tryBlock(h, false);
    if (blocker) { this.swatShot(h, blocker); return; }
    if (this.tryShootingFoul(h, dDef, false)) return;

    this.shotFrom.set(h.pos.x, 2.05, h.pos.z);
    this.shotT = 0;
    this.shotDur = 0.85;
    this.shotApex = 2.2;
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
    // dunks convert on ヘッド, layups on S精度; S威力 finishes through contact
    let p = dunk ? 0.82 + rate(h.attr.dunk) * 0.15 : 0.5 + rate(h.attr.midAcc) * 0.35;
    p -= clamp(1.0 - dDef, 0, 1.0) * 0.25 * (1 - rate(h.attr.shotStrength) * 0.6);
    p -= this.clutchFactor(h) * 0.1;
    this.shotMade = chance(clamp(p, 0.2, 0.97));

    const blocker = this.tryBlock(h, true);
    if (blocker) { this.swatShot(h, blocker); return; }
    if (this.tryShootingFoul(h, dDef, true)) return;

    this.shotFrom.set(h.pos.x, dunk ? 2.6 : 1.7, h.pos.z);
    this.shotT = 0;
    this.shotDur = dunk ? 0.45 : 0.55;
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
    this.ballMode = "shot";
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
  private tryBlock(shooter: Player, isFinish: boolean): Player | null {
    // finishes can be met by help rotating over from the paint; a perimeter
    // jumper only by a man right in the shooter's face
    const range = isFinish ? 2.1 : 1.4;
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
      let p = (isFinish ? 0.30 : 0.20) * (0.2 + blk * 1.35) * close + heightAdv * close;
      p = clamp(p, 0, 0.7);
      if (p > bestP) { bestP = p; best = d; }
    }
    return best && chance(bestP) ? best : null;
  }

  // The shot is swatted: the blocker goes up, the ball comes loose at the rim.
  private swatShot(shooter: Player, blocker: Player): void {
    blocker.stats.blk++;
    shooter.stats.fga++;             // a blocked shot is a missed attempt
    this.pendingAssist = null;
    blocker.jump(0.9, 0.6);
    this.setEvent("BLOCK!", blocker.team);
    this.possession = shooter.team;            // loose ball at the attacked rim
    this.handler = null;
    this.startRebound();
  }

  // ---- fouls & free throws ----------------------------------------------

  // Was the shot fouled? Contact is more likely on contested layups. If so,
  // send the shooter to the line (and-one if the shot still went in).
  private tryShootingFoul(h: Player, dDef: number, layup: boolean): boolean {
    const base = layup ? 0.20 : 0.05;
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
      this.ball.pos.set(a.x + (b.x - a.x) * k, baseY + Math.sin(k * Math.PI) * 1.8, a.z + (b.z - a.z) * k);
      return;
    }

    // resolve this attempt
    if (this.ftMade) {
      this.score[this.ftTeam] += 1;
      this.ftShooter.stats.pts += 1;
      this.benchCheer(this.ftTeam, 1.2);   // a quicker pop for a free throw
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
  private defensiveFoul(victim: Player): void {
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

  private updateShot(dt: number): void {
    this.crashBoards(dt); // everyone converges on the glass while the shot is up

    this.shotT += dt;
    const k = Math.min(1, this.shotT / this.shotDur);
    const a = this.shotFrom, b = this.attackRim(this.possession);
    const baseY = a.y + (b.y - a.y) * k;
    const apex = Math.sin(k * Math.PI) * this.shotApex;
    this.ball.pos.set(a.x + (b.x - a.x) * k, baseY + apex, a.z + (b.z - a.z) * k);

    if (k >= 1) this.resolveShot();
  }

  private resolveShot(): void {
    const shooter = this.possession;
    const sh = this.shooter;
    if (sh) sh.stats.fga++;
    const andOne = this.shotMade && sh !== null && this.pendingAndOne === sh;
    if (this.shotMade) {
      this.score[shooter] += this.shotPoints;
      if (sh) { sh.stats.pts += this.shotPoints; sh.stats.fgm++; }
      if (this.pendingAssist) this.pendingAssist.stats.ast++;
      this.setEvent(andOne ? "AND-1" : this.shotPoints === 3 ? "3 POINTS!" : "2 POINTS",
        shooter, 1.8, { scorer: sh?.name, assist: this.pendingAssist?.name });
      this.benchCheer(shooter);   // the bench is up and bouncing
      // hold on the made basket so the viewer sees it, then subs, then inbound —
      // unless the buzzer already sounded (buzzer beater): the period ends here.
      // An AND-1 continues at the line instead: basket counts + one free throw.
      this.handler = null;
      if (andOne) this.pauseThen(1.4, () => this.startFreeThrows(sh!, 1));
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
    // players hold; the ball settles to the floor
    this.ball.pos.y = Math.max(0.3, this.ball.pos.y - 3 * dt);
    this.pauseT -= dt;
    if (this.pauseT <= 0) {
      const next = this.pauseNext;
      this.pauseNext = null;
      if (next) next();
    }
  }

  // Put the ball into a free, falling, contestable state. `offense` is the team
  // that was attacking when it came loose (decides the rebound label / clock).
  private goLoose(offense: number, timeout: number,
                  opts: { rebound?: boolean; stealBy?: Player | null; victim?: Player | null; grabAfter?: number } = {}): void {
    this.looseOff = offense;
    this.looseT = timeout;
    this.looseTips = 0;
    this.looseIsRebound = opts.rebound ?? false;
    this.looseStealBy = opts.stealBy ?? null;
    this.looseStealVictim = opts.victim ?? null;
    this.looseAge = 0;
    this.looseGrabAfter = opts.grabAfter ?? 0;  // a beat where the ball is visibly free before anyone can secure it
    this.handler = null;
    this.ballMode = "loose";
    for (const p of this.players) p.touchCool = 0;
  }

  // After a miss the ball caroms off the rim and is live: it falls under gravity
  // and anyone who can get a hand to it tips or grabs it (see updateLoose).
  private startRebound(): void {
    const rim = this.attackRim(this.possession);
    this.ball.pos.set(rim.x + rand(-0.3, 0.3), RIM.height + 0.1, rim.z + rand(-0.2, 0.2));
    // off the iron: up a touch, then outward back toward the floor
    this.ball.vel.set(rand(-2.2, 2.2), rand(1.0, 2.6), -Math.sign(rim.z || 1) * rand(0.4, 2.4));
    this.goLoose(this.possession, 2.6, { rebound: true });

    // the bigs (and anyone right at the rim) leap to fight for the board
    const rimFloor = this.attackFloor(this.possession);
    for (const p of this.players) {
      const d = dist2D(p.pos, rimFloor);
      if (d < 2.8 && (this.isBig(p) || d < 1.4)) p.jump(this.isBig(p) ? 0.7 : 0.5, 0.6);
    }
  }

  private updateLoose(dt: number): void {
    const b = this.ball;
    // free-flight under gravity
    b.vel.y -= 9.0 * dt;
    b.pos.x += b.vel.x * dt;
    b.pos.y += b.vel.y * dt;
    b.pos.z += b.vel.z * dt;
    // bounce off the floor, losing energy
    if (b.pos.y < 0.12) { b.pos.y = 0.12; b.vel.y = Math.abs(b.vel.y) * 0.55; b.vel.x *= 0.7; b.vel.z *= 0.7; }
    // reflect off the court boundary so it stays in play
    const mw = COURT.halfW - 0.1, ml = COURT.halfL - 0.1;
    if (b.pos.x < -mw) { b.pos.x = -mw; b.vel.x = Math.abs(b.vel.x) * 0.6; }
    if (b.pos.x > mw) { b.pos.x = mw; b.vel.x = -Math.abs(b.vel.x) * 0.6; }
    if (b.pos.z < -ml) { b.pos.z = -ml; b.vel.z = Math.abs(b.vel.z) * 0.6; }
    if (b.pos.z > ml) { b.pos.z = ml; b.vel.z = -Math.abs(b.vel.z) * 0.6; }
    // clamp speed so a bad bounce can never send it flying (stays deterministic)
    const sp = Math.hypot(b.vel.x, b.vel.y, b.vel.z);
    if (sp > 10) { const k = 10 / sp; b.vel.x *= k; b.vel.y *= k; b.vel.z *= k; }

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

    for (const p of this.players) {
      if (contest.has(p)) {
        moveToward2D(p.pos, bx, bz, p.accelSpeed(dt, this.isBig(p) ? 1.0 : 0.9) * dt);
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
    this.shotClock = offensive ? Math.max(this.shotClock, SHOT_CLOCK_PARTIAL) : SHOT_CLOCK;
    p.decisionT = 0.4;
    this.ball.vel.set(0, 0, 0);
    this.resetMotion();
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
      // a finisher drives to his gather point just short of the rim and rises
      // there (don't let him drift backwards) — committed momentum, so no
      // recovery drag applies mid-flight. The ball goes on up to the hoop.
      if (p === this.shooter && this.ballMode === "shot" && this.shooterFinishing) {
        moveToward2D(p.pos, this.finishSpot.x, this.finishSpot.z, p.runSpeed * (1 - p.fatigue * 0.2) * dt);
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
    return taker === tp[0] ? tp[1] : tp[0];
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
    this.passTo = r;
    this.passer = inb;
    this.passT = 0;
    // ロング: fires the outlet flat and fast down the floor
    const spd = PASS_SPEED * (inb.has("longThrow") ? 1.35 : 1);
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
        const tp = this.teamPlayers(team);
        const outlet = tp[0] !== this.handler ? tp[0] : tp[1];
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
        // (a ラインポジ cutter bursts hard enough to lose his mark)
        moveToward2D(p.pos, p.offTarget.x, p.offTarget.z,
          p.accelToward(dt, p.offTarget.x, p.offTarget.z, p.has("lineMove") ? 1.22 : 1.08) * dt);
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
        moveToward2D(p.pos, spot.x, spot.z, p.accelToward(dt, spot.x, spot.z) * dt);
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
    // bigs are the natural screeners; guards/wings set picks only occasionally
    const screenChance = this.isBig(p) ? 0.7 : 0.3;
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
      h.beatenT = Math.max(h.beatenT, rand(0.45, 0.7)); // handler turns the corner
      d.reactT = Math.max(d.reactT, 0.5);               // defender stuck on the pick
      h.decisionT = Math.max(h.decisionT, 0.25);
      this.setDriveSide(h);                             // aim the handler at the rim
      this.endScreen(p, true);                          // roll to the basket
      return;
    }
    if (p.screenT <= 0) this.endScreen(p, false);       // pick unused — pop out
  }

  private endScreen(p: Player, roll: boolean): void {
    p.screening = false;
    p.screenT = 0;
    if (roll) {
      const rim = this.attackFloor(p.team);
      p.cutting = true;
      p.offTimer = rand(1.5, 2.5);
      p.offTarget.set(rim.x + rand(-0.6, 0.6), 0, rim.z - Math.sign(rim.z) * 0.4);
    } else {
      p.spotIdx = this.bestOpenSpot(p.team, this.formationSpots(p.team), p);
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
    }
    // a change of possession ends any pending assist, and the ball has to be
    // brought up / established in the frontcourt afresh
    this.assistFrom = this.assistTo = null;
    this.frontT = false;
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
    // how cleanly it's knocked toward the defender (0 = scattered, ~0.9 = right to him)
    const grip = clamp(0.2 + rate(d.attr.reaction) * 0.6 - rate(h.attr.handling) * 0.3, 0.05, 0.9);
    const ax = d.pos.x - h.pos.x, az = d.pos.z - h.pos.z;
    const len = Math.hypot(ax, az) || 1;
    const ux = ax / len, uz = az / len;            // handler -> defender
    const power = rand(1.6, 3.2);
    this.ball.pos.set(h.pos.x + ux * 0.3, 1.0, h.pos.z + uz * 0.3);
    this.ball.vel.set(
      ux * power * grip + rand(-1, 1) * (1 - grip),
      rand(0.5, 1.3),
      uz * power * grip + rand(-1, 1) * (1 - grip),
    );
    this.goLoose(h.team, 1.6, { stealBy: d, victim: h, grabAfter: 0.35 });
    h.touchCool = 0.4;                              // knocked off-balance — can't grab instantly
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
    const leader = this.score[0] === this.score[1]
      ? this.possession
      : (this.score[0] > this.score[1] ? 0 : 1);
    this.handler = null;
    this.gameClock = 0;
    const ended = this.quarter;
    this.setEvent(ended === 2 ? "HALFTIME" : `END OF Q${ended}`, leader, 3.0);
    // the break itself restores some legs — halftime considerably more
    if (ended < QUARTERS) {
      const rest = ended === 2 ? 0.15 : 0.06;
      for (let t = 0; t < 2; t++) for (const p of this.roster[t]) p.breakRecover(rest);
    }

    this.pauseThen(1.2, () => this.quarterWalkOff(() => {
      if (ended >= QUARTERS) {
        // the players have left the floor — hold, then the result screen
        this.pauseThen(0.8, () => {
          this.state = "final";
          this.setEvent("FINAL", this.score[0] >= this.score[1] ? 0 : 1);
        });
        return;
      }
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

  // Everyone on the floor walks to a gathering spot in front of his own bench.
  private quarterWalkOff(next: () => void): void {
    this.subWalkers = [];
    for (const p of this.players) {
      const dir = p.team === 0 ? -1 : 1;      // each team's bench half
      this.subWalkers.push({ p, tx: COURT.halfW + 0.6, tz: dir * (8 + p.slot * 0.9) });
    }
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
