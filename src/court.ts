import {
  Scene, MeshBuilder, StandardMaterial, Color3, DynamicTexture, Vector3, Mesh,
} from "@babylonjs/core";
import { COURT, RIM } from "./config";

// Builds the floor (with painted markings), surrounding apron, and both hoops.
// The animatable hoop parts a made basket lights up (swish + rim flash), one
// per end. `hoopIndex(end)` maps a rim's Z sign to its slot.
export interface Hoops { nets: Mesh[]; rimMats: StandardMaterial[]; boardMats: StandardMaterial[]; }
export const hoopIndex = (end: number): number => (end >= 0 ? 0 : 1);

export function buildCourt(scene: Scene): Hoops {
  buildFloor(scene);
  buildBenches(scene);
  const h0 = buildHoop(scene, +1); // +Z end (Team 0's basket)
  const h1 = buildHoop(scene, -1); // -Z end (Team 1's basket)
  return {
    nets: [h0.net, h1.net],
    rimMats: [h0.rimMat, h1.rimMat],
    boardMats: [h0.boardMat, h1.boardMat],
  };
}

function buildFloor(scene: Scene): void {
  // Dark apron under/around the court so the painted floor reads as a court.
  const apron = MeshBuilder.CreateGround("apron", { width: COURT.width + 6, height: COURT.length + 6 }, scene);
  apron.position.y = -0.02;
  const apronMat = new StandardMaterial("apronmat", scene);
  apronMat.diffuseColor = new Color3(0.06, 0.07, 0.09);
  apronMat.specularColor = new Color3(0, 0, 0);
  apron.material = apronMat;

  const floor = MeshBuilder.CreateGround("floor", { width: COURT.width, height: COURT.length }, scene);
  const mat = new StandardMaterial("floormat", scene);
  mat.diffuseTexture = makeCourtTexture(scene);
  mat.specularColor = new Color3(0.08, 0.08, 0.08);
  floor.material = mat;
  floor.receiveShadows = true;
}

// A bench for each team's reserves, along the far (+X) sideline near mid-court —
// a seat the players sit on plus a low backrest behind them. Purely cosmetic.
function buildBenches(scene: Scene): void {
  const seatMat = new StandardMaterial("benchseat", scene);
  seatMat.diffuseColor = new Color3(0.14, 0.16, 0.2);
  seatMat.specularColor = new Color3(0.05, 0.05, 0.05);
  const legMat = new StandardMaterial("benchleg", scene);
  legMat.diffuseColor = new Color3(0.08, 0.09, 0.11);
  legMat.specularColor = new Color3(0, 0, 0);

  const x = COURT.halfW + 2.3;            // same sideline the reserves sit at (set back off the court)
  for (const end of [-1, 1]) {            // team 0 sits at -Z, team 1 at +Z
    // seats are keyed by roster index 0..12 → z from ±3.4 (idx12) to ±13 (idx0);
    // a subbed-OUT starter (idx 0..4) sits nearest the baseline, so the plank
    // must span the FULL 13-seat range, not just the 8 reserves.
    const zMid = end * 8.2;               // centre of the 13-seat row
    const len = 10.6;                     // covers z ≈ ±2.9 .. ±13.5
    // seat plank (players rest on top ≈ y 0.42)
    const seat = MeshBuilder.CreateBox(`benchseat_${end}`, { width: 0.9, height: 0.12, depth: len }, scene);
    seat.position.set(x, 0.36, zMid);
    seat.material = seatMat;
    seat.receiveShadows = true;
    // backrest behind the players (away from the court, +X)
    const back = MeshBuilder.CreateBox(`benchback_${end}`, { width: 0.1, height: 0.55, depth: len }, scene);
    back.position.set(x + 0.5, 0.6, zMid);
    back.material = seatMat;
    // two end legs
    for (const s of [-1, 1]) {
      const leg = MeshBuilder.CreateBox(`benchleg_${end}_${s}`, { width: 0.8, height: 0.36, depth: 0.12 }, scene);
      leg.position.set(x, 0.18, zMid + s * (len / 2 - 0.2));
      leg.material = legMat;
    }
  }
}

// Draw the court markings onto a canvas texture mapped across the floor.
function makeCourtTexture(scene: Scene): DynamicTexture {
  const pxPerM = 40;
  const w = Math.round(COURT.width * pxPerM);
  const h = Math.round(COURT.length * pxPerM);
  const tex = new DynamicTexture("courttex", { width: w, height: h }, scene, true);
  const ctx = tex.getContext() as unknown as CanvasRenderingContext2D;

  // metre -> pixel (centre origin; +Z maps "up" in the image — symmetric, so fine)
  const px = (x: number) => w / 2 + x * pxPerM;
  const py = (z: number) => h / 2 - z * pxPerM;

  // hardwood
  ctx.fillStyle = "#b07a3c";
  ctx.fillRect(0, 0, w, h);
  // subtle plank shading
  ctx.fillStyle = "rgba(0,0,0,0.05)";
  for (let i = 0; i < w; i += pxPerM) {
    if ((i / pxPerM) % 2 === 0) ctx.fillRect(i, 0, pxPerM, h);
  }

  ctx.strokeStyle = "rgba(255,255,255,0.92)";
  ctx.lineWidth = 0.05 * pxPerM;
  ctx.lineCap = "round";

  const bx = COURT.halfW - 0.1; // boundary inset slightly
  const bz = COURT.halfL - 0.1;

  // outer boundary
  ctx.strokeRect(px(-bx), py(bz), bx * 2 * pxPerM, bz * 2 * pxPerM);

  // half-court line
  line(ctx, px(-bx), py(0), px(bx), py(0));
  // centre circle
  circle(ctx, px(0), py(0), 1.8 * pxPerM);

  for (const end of [1, -1]) {
    const baseZ = end * COURT.halfL;
    const rimZ = end * RIM.z;

    // the key / paint (4.9m wide, 5.8m deep from the baseline)
    const keyW = 4.9, keyDepth = 5.8;
    const ftZ = end * (COURT.halfL - keyDepth);
    rect(ctx, px(-keyW / 2), py(baseZ), px(keyW / 2), py(ftZ));

    // free-throw circle
    circle(ctx, px(0), py(ftZ), 1.8 * pxPerM);

    // three-point arc around the rim, facing mid-court
    const r = 6.75 * pxPerM;
    const cx = px(0), cy = py(rimZ);
    ctx.beginPath();
    if (end === 1) ctx.arc(cx, cy, r, Math.PI * 0.15, Math.PI * 0.85, false);
    else ctx.arc(cx, cy, r, Math.PI * 1.15, Math.PI * 1.85, false);
    ctx.stroke();
    // corner straights from baseline to the arc
    const cornerX = 6.6;
    line(ctx, px(-cornerX), py(baseZ), px(-cornerX), py(end * (COURT.halfL - 2.9)));
    line(ctx, px(cornerX), py(baseZ), px(cornerX), py(end * (COURT.halfL - 2.9)));
  }

  tex.update();
  return tex;
}

function line(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number) {
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
}
function rect(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number) {
  ctx.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
}
function circle(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
}

// A hoop: pole, backboard, rim and a simple net, at one baseline. Returns the
// net mesh and rim material so a made basket can swish the net / flash the rim.
function buildHoop(scene: Scene, end: number): { net: Mesh; rimMat: StandardMaterial; boardMat: StandardMaterial } {
  const rimZ = end * RIM.z;
  const boardZ = end * RIM.backboardZ;

  const white = new StandardMaterial(`board_${end}`, scene);
  white.diffuseColor = new Color3(0.9, 0.9, 0.92);
  white.specularColor = new Color3(0.2, 0.2, 0.2);

  const board = MeshBuilder.CreateBox(`backboard_${end}`, { width: 1.8, height: 1.05, depth: 0.05 }, scene);
  board.position.set(0, RIM.height + 0.3, boardZ);
  board.material = white;

  // support pole + arm behind the baseline
  const pole = MeshBuilder.CreateCylinder(`pole_${end}`, { height: RIM.height + 0.3, diameter: 0.18 }, scene);
  pole.position.set(0, (RIM.height + 0.3) / 2, end * (COURT.halfL + 0.6));
  const dark = new StandardMaterial(`pole_${end}`, scene);
  dark.diffuseColor = new Color3(0.2, 0.2, 0.22);
  pole.material = dark;

  const rim = MeshBuilder.CreateTorus(`rim_${end}`, { diameter: RIM.radius * 2, thickness: 0.03, tessellation: 24 }, scene);
  rim.position.set(0, RIM.height, rimZ);
  const rimMat = new StandardMaterial(`rimmat_${end}`, scene);
  rimMat.diffuseColor = new Color3(0.95, 0.45, 0.1);
  rimMat.emissiveColor = new Color3(0.3, 0.12, 0.0);
  rim.material = rimMat;

  // simple net (a downward cone of low opacity)
  const net = MeshBuilder.CreateCylinder(`net_${end}`, {
    height: 0.45, diameterTop: RIM.radius * 2, diameterBottom: RIM.radius * 1.2, tessellation: 12,
  }, scene);
  net.position.set(0, RIM.height - 0.22, rimZ);
  const netMat = new StandardMaterial(`netmat_${end}`, scene);
  netMat.diffuseColor = new Color3(1, 1, 1);
  netMat.alpha = 0.25;
  netMat.backFaceCulling = false;
  net.material = netMat;

  return { net, rimMat, boardMat: white };
}

// Marker ring used to highlight which player currently holds the ball.
export function makeHandlerRing(scene: Scene): Mesh {
  const ring = MeshBuilder.CreateTorus("handlerRing", { diameter: 1.1, thickness: 0.06, tessellation: 24 }, scene);
  ring.position.y = 0.03;
  const mat = new StandardMaterial("ringmat", scene);
  mat.emissiveColor = new Color3(1, 0.95, 0.3);
  mat.disableLighting = true;
  ring.material = mat;
  ring.isVisible = false;
  return ring;
}
