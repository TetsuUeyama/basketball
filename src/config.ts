// ---------------------------------------------------------------------------
// Simulation constants. All distances in metres, all speeds in metres/second.
// Coordinate convention (kept deliberately simple — no imported models, so
// handedness never produces a visible orientation bug):
//   X = court width   (sidelines at x = ±halfW)
//   Z = court length  (baselines at z = ±halfL)
//   Y = up
// Team 0 attacks the +Z hoop, Team 1 attacks the -Z hoop.
// ---------------------------------------------------------------------------

export const COURT = {
  width: 15,   // X extent (NBA: 15.24)
  length: 28,  // Z extent (NBA: 28.65)
  halfW: 7.5,
  halfL: 14,
  margin: 0.5, // players are kept this far inside the lines
};

export const RIM = {
  height: 3.05,
  radius: 0.23,
  z: 13.0,        // |Z| of the rim centre at each end (just inside the baseline)
  backboardZ: 13.6,
};

// Returns the rim centre (a 3D point) for the hoop a team attacks.
export function hoopCenter(team: number) {
  const z = team === 0 ? RIM.z : -RIM.z;
  return { x: 0, y: RIM.height, z };
}
// Floor point directly under that rim.
export function hoopFloor(team: number) {
  return { x: 0, z: team === 0 ? RIM.z : -RIM.z };
}

export const SHOOT_RANGE = 7.6;   // max distance a player will normally shoot from
export const THREE_DIST = 6.75;   // beyond this counts as a 3-pointer

export const PLAYER_SPEED = 6.2;  // offensive run speed
export const DEF_SPEED = 6.5;     // defenders are a touch quicker so they can recover
export const PASS_SPEED = 13;     // pass travel speed
export const SHOT_CLOCK = 24;
export const QUARTER_TIME = 60;   // game-seconds per quarter (shown on the clock)
export const QUARTERS = 4;

export const TEAM_COLORS = [
  { r: 0.86, g: 0.34, b: 0.12 }, // Team 0 — orange
  { r: 0.16, g: 0.42, b: 0.82 }, // Team 1 — blue
];
export const TEAM_NAMES = ["BLAZE", "WAVE"];
