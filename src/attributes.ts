import { clamp } from "./util";

// ---------------------------------------------------------------------------
// Player attributes. All ratings are 0..100. Phase 1 wires up the physical and
// shooting ones; the rest are defined now so later phases (defence, passing,
// tendencies, team tactics) can fill them in without a schema change.
// ---------------------------------------------------------------------------
export interface Attributes {
  // physical
  speed: number; quickness: number; strength: number; physical: number; vertical: number;
  // offence
  handle: number; finishing: number; midRange: number; three: number;
  freeThrow: number; passing: number; offRebound: number;
  // defence
  lateral: number; steal: number; block: number; defRebound: number; discipline: number;
  // tendencies (how the player likes to play)
  shootTendency: number; driveTendency: number; passTendency: number;
}

export interface PlayerDef {
  name: string;
  role: string;       // PG / SG / SF / PF / C
  height: number;     // metres (affects mesh size and rebounding)
  attr: Attributes;
  priority?: number;  // explicit offensive priority 0..1 (overrides the role/skill default)
}

// ---------------------------------------------------------------------------
// Team tactics (0..1 each). These bias every player's individual judgement and
// the team's defensive positioning.
// ---------------------------------------------------------------------------
export interface Tactics {
  offense: {
    pace: number;         // low = work the clock, high = shoot early / push
    threeBias: number;    // preference for three-point shots
    driveBias: number;    // preference for attacking the rim
    ballMovement: number; // pass-and-move vs isolation
  };
  defense: {
    pressure: number;     // tight on-ball pressure (closer, gambles more)
    help: number;         // how much off-ball defenders sag to protect the paint
  };
}

// Indexed by team. Two distinct identities so the tactical effect is visible.
export const TACTICS: Tactics[] = [
  // Team 0 — BLAZE: deliberate, attack inside, conservative help defence
  { offense: { pace: 0.35, threeBias: 0.30, driveBias: 0.65, ballMovement: 0.55 },
    defense: { pressure: 0.40, help: 0.70 } },
  // Team 1 — WAVE: fast pace, three-happy, aggressive on-ball pressure
  { offense: { pace: 0.80, threeBias: 0.75, driveBias: 0.45, ballMovement: 0.65 },
    defense: { pressure: 0.80, help: 0.40 } },
];

/** Map a 0..100 rating to a 0..1 factor. */
export const rate = (r: number): number => clamp(r, 0, 100) / 100;

// ---------------------------------------------------------------------------
// Role-based offensive identity. `scoreBase` is how much of a scoring option the
// position usually is (the go-to scorers are the wings/2-guard); `playmaking` is
// how much the position brings the ball up and sets others up (the point guard).
// A player's individual ratings then nudge these per person.
// ---------------------------------------------------------------------------
const ROLE_OFFENSE: Record<string, { scoreBase: number; playmaking: number }> = {
  PG: { scoreBase: 0.55, playmaking: 1.00 },
  SG: { scoreBase: 0.85, playmaking: 0.55 },
  SF: { scoreBase: 0.80, playmaking: 0.45 },
  PF: { scoreBase: 0.55, playmaking: 0.30 },
  C:  { scoreBase: 0.45, playmaking: 0.25 },
};
export function roleOffense(role: string): { scoreBase: number; playmaking: number } {
  return ROLE_OFFENSE[role] ?? { scoreBase: 0.6, playmaking: 0.4 };
}

// A player's scoring-option weight (0..1). An explicit `priority` on the def
// wins (so it can be set in the pre-game editor); otherwise it's derived from
// the position baseline nudged by the player's scoring ratings.
export function computeOffPriority(def: PlayerDef): number {
  if (def.priority !== undefined) return clamp(def.priority, 0, 1);
  const ro = roleOffense(def.role);
  const a = def.attr;
  const scoringSkill = (rate(a.shootTendency) + rate(a.three) + rate(a.midRange) + rate(a.finishing)) / 4;
  return clamp(ro.scoreBase * 0.65 + scoringSkill * 0.35, 0, 1);
}

// Shorthand to keep the roster table readable.
const A = (
  speed: number, quickness: number, strength: number, physical: number, vertical: number,
  handle: number, finishing: number, midRange: number, three: number,
  freeThrow: number, passing: number, offRebound: number,
  lateral: number, steal: number, block: number, defRebound: number, discipline: number,
  shootTendency: number, driveTendency: number, passTendency: number,
): Attributes => ({
  speed, quickness, strength, physical, vertical, handle, finishing, midRange, three,
  freeThrow, passing, offRebound, lateral, steal, block, defRebound, discipline,
  shootTendency, driveTendency, passTendency,
});

// Roster indexed [team][slot], slot 0..4 = PG, SG, SF, PF, C (slot>=3 are bigs).
// Each team has a distinct mix of personalities.
export const ROSTER: PlayerDef[][] = [
  // NOTE: test setup — RED (BLAZE) is every attribute at the floor, BLUE (WAVE)
  // at the ceiling, so the effect of attributes is obvious. Re-tune for a real game.
  [ // Team 0 — BLAZE (RED) — minimum everything
    //   spd qui str phy ver  hdl fin mid 3pt  ft pas orb  lat stl blk drb dis  sT dT pT
    { name: "Vega",  role: "PG", height: 1.85, attr: A(10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10) },
    { name: "Knox",  role: "SG", height: 1.85, attr: A(10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10) },
    { name: "Reed",  role: "SF", height: 1.85, attr: A(10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10) },
    { name: "Boone", role: "PF", height: 1.85, attr: A(10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10) },
    { name: "Sato",  role: "C",  height: 1.85, attr: A(10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10) },
  ],
  [ // Team 1 — WAVE (BLUE) — maximum everything
    { name: "Ito",   role: "PG", height: 2.10, attr: A(99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99) },
    { name: "Lang",  role: "SG", height: 2.10, attr: A(99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99) },
    { name: "Cruz",  role: "SF", height: 2.10, attr: A(99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99) },
    { name: "Diaz",  role: "PF", height: 2.10, attr: A(99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99) },
    { name: "Okafor",role: "C",  height: 2.10, attr: A(99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99) },
  ],
];
