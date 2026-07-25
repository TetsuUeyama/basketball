import { Scene, MeshBuilder, StandardMaterial, Color3, DynamicTexture, Mesh } from "@babylonjs/core";
import { COURT, RIM, THREE_DIST } from "../config";
import { makeMat } from "./materials";

// フロア（ライン付き）、周囲のエプロン、両フープを構築する。
// 各エンドに1つずつ、得点時に光らせられるフープ部品（ネットの揺れ + リムのフラッシュ）を
// 持つ。`hoopIndex(end)` はリムのZの符号をそのスロットへ対応づける。
export interface Hoops { nets: Mesh[]; rimMats: StandardMaterial[]; boardMats: StandardMaterial[]; }
export const hoopIndex = (end: number): number => (end >= 0 ? 0 : 1);

export function buildCourt(scene: Scene): Hoops {
  buildFloor(scene);
  buildBenches(scene);
  const h0 = buildHoop(scene, +1); // +Zエンド (Team 0 のバスケット)
  const h1 = buildHoop(scene, -1); // -Zエンド (Team 1 のバスケット)
  return {
    nets: [h0.net, h1.net],
    rimMats: [h0.rimMat, h1.rimMat],
    boardMats: [h0.boardMat, h1.boardMat],
  };
}

function buildFloor(scene: Scene): void {
  // コートの下・周囲の暗いエプロン。これでライン入りフロアがコートらしく見える。
  const apron = MeshBuilder.CreateGround("apron", { width: COURT.width + 6, height: COURT.length + 6 }, scene);
  apron.position.y = -0.02;
  apron.material = makeMat(scene, "apronmat", { diffuse: new Color3(0.06, 0.07, 0.09), spec: new Color3(0, 0, 0) });

  const floor = MeshBuilder.CreateGround("floor", { width: COURT.width, height: COURT.length }, scene);
  const mat = makeMat(scene, "floormat", { spec: new Color3(0.08, 0.08, 0.08) });
  mat.diffuseTexture = makeCourtTexture(scene);
  floor.material = mat;
  floor.receiveShadows = true;
}

// 各チームの控え選手用ベンチ。ミッドコート付近の遠い(+X)サイドラインに沿って置く —
// 選手が座る座面と、その後ろの低い背もたれ。完全に見た目だけのもの。
function buildBenches(scene: Scene): void {
  const seatMat = makeMat(scene, "benchseat", { diffuse: new Color3(0.14, 0.16, 0.2), spec: new Color3(0.05, 0.05, 0.05) });
  const legMat = makeMat(scene, "benchleg", { diffuse: new Color3(0.08, 0.09, 0.11), spec: new Color3(0, 0, 0) });

  const x = COURT.halfW + 2.3;            // 控えが座るのと同じサイドライン(コートから後方へ下げる)
  for (const end of [-1, 1]) {            // team 0 は -Z、team 1 は +Z に座る
    // 座席はロスターインデックス 0..12 に対応 → z は ±3.4 (idx12) から ±13 (idx0)。
    // 交代でOUTした先発(idx 0..4)はベースライン寄りに座るので、板は8人の控えだけでなく
    // 13席分のフルレンジをカバーしなければならない。
    const zMid = end * 8.2;               // 13席の列の中心
    const len = 10.6;                     // z ≒ ±2.9 .. ±13.5 をカバー
    // 座面の板(選手は天面 ≒ y 0.42 に乗る) — ソファではなくベンチらしい浅い座面。
    // 選手の着席位置は板の中心(x)のまま
    const SEAT_D = 0.45;
    const seat = MeshBuilder.CreateBox(`benchseat_${end}`, { width: SEAT_D, height: 0.12, depth: len }, scene);
    seat.position.set(x, 0.36, zMid);
    seat.material = seatMat;
    seat.receiveShadows = true;
    // 座面の後端(コートから離れる側、+X)に置く背もたれ
    const back = MeshBuilder.CreateBox(`benchback_${end}`, { width: 0.1, height: 0.55, depth: len }, scene);
    back.position.set(x + SEAT_D / 2 + 0.05, 0.6, zMid);
    back.material = seatMat;
    // 両端の脚2本
    for (const s of [-1, 1]) {
      const leg = MeshBuilder.CreateBox(`benchleg_${end}_${s}`, { width: SEAT_D - 0.07, height: 0.36, depth: 0.12 }, scene);
      leg.position.set(x, 0.18, zMid + s * (len / 2 - 0.2));
      leg.material = legMat;
    }
  }
}

// コートのラインを、フロア全体にマッピングするキャンバステクスチャへ描く。
function makeCourtTexture(scene: Scene): DynamicTexture {
  const pxPerM = 40;
  const w = Math.round(COURT.width * pxPerM);
  const h = Math.round(COURT.length * pxPerM);
  const tex = new DynamicTexture("courttex", { width: w, height: h }, scene, true);
  const ctx = tex.getContext() as unknown as CanvasRenderingContext2D;

  // メートル -> ピクセル(中心を原点。+Z が画像内の「上」に対応 — 対称なので問題なし)
  const px = (x: number) => w / 2 + x * pxPerM;
  const py = (z: number) => h / 2 - z * pxPerM;

  // 板張り
  ctx.fillStyle = "#b07a3c";
  ctx.fillRect(0, 0, w, h);
  // 板の微妙な陰影
  ctx.fillStyle = "rgba(0,0,0,0.05)";
  for (let i = 0; i < w; i += pxPerM) {
    if ((i / pxPerM) % 2 === 0) ctx.fillRect(i, 0, pxPerM, h);
  }

  ctx.strokeStyle = "rgba(255,255,255,0.92)";
  ctx.lineWidth = 0.05 * pxPerM;
  ctx.lineCap = "round";

  const bx = COURT.halfW - 0.1; // 境界を少し内側へ
  const bz = COURT.halfL - 0.1;

  // 外周ライン
  ctx.strokeRect(px(-bx), py(bz), bx * 2 * pxPerM, bz * 2 * pxPerM);

  // ハーフコートライン
  line(ctx, px(-bx), py(0), px(bx), py(0));
  // センターサークル
  circle(ctx, px(0), py(0), 1.8 * pxPerM);

  for (const end of [1, -1]) {
    const baseZ = end * COURT.halfL;
    const rimZ = end * RIM.z;

    // キー / ペイント(幅4.9m、ベースラインから奥行き5.8m)
    const keyW = 4.9, keyDepth = 5.8;
    const ftZ = end * (COURT.halfL - keyDepth);
    rect(ctx, px(-keyW / 2), py(baseZ), px(keyW / 2), py(ftZ));

    // フリースローサークル
    circle(ctx, px(0), py(ftZ), 1.8 * pxPerM);

    // 3Pラインを1本の連続パスとして描く: コーナーの直線 → アーク → コーナーの直線。
    // コーナーの直線は ±cornerX に位置し、ベースラインから、アーク(リムから半径
    // THREE_DIST)がその x と交わる点までちょうど伸びる。これでアークと直線が隙間なく
    // つながる。
    const r3 = THREE_DIST;
    const cornerX = 6.6;
    const tMax = Math.asin(cornerX / r3);                         // x = ±cornerX となるアークの角度
    const meetZ = rimZ - end * Math.sqrt(r3 * r3 - cornerX * cornerX); // 両者が接続する z
    ctx.beginPath();
    ctx.moveTo(px(-cornerX), py(baseZ));
    ctx.lineTo(px(-cornerX), py(meetZ));                          // 左コーナーの直線
    const N = 48;
    for (let i = 0; i <= N; i++) {                               // アーク。ミッドコート側を向く
      const t = -tMax + (2 * tMax) * (i / N);
      ctx.lineTo(px(r3 * Math.sin(t)), py(rimZ - end * r3 * Math.cos(t)));
    }
    ctx.lineTo(px(cornerX), py(baseZ));                          // 右コーナーの直線
    ctx.stroke();
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

// フープ: 一方のベースラインに置くポール、バックボード、リム、そして簡素なネット。
// 得点時にネットを揺らし／リムを光らせられるよう、ネットメッシュとリムマテリアルを返す。
function buildHoop(scene: Scene, end: number): { net: Mesh; rimMat: StandardMaterial; boardMat: StandardMaterial } {
  const rimZ = end * RIM.z;
  const boardZ = end * RIM.backboardZ;

  const white = makeMat(scene, `board_${end}`, { diffuse: new Color3(0.9, 0.9, 0.92), spec: new Color3(0.2, 0.2, 0.2) });

  const board = MeshBuilder.CreateBox(`backboard_${end}`, { width: 1.8, height: 1.05, depth: 0.05 }, scene);
  board.position.set(0, RIM.height + 0.3, boardZ);
  board.material = white;

  // ベースライン裏の支柱ポール + アーム
  const pole = MeshBuilder.CreateCylinder(`pole_${end}`, { height: RIM.height + 0.3, diameter: 0.18 }, scene);
  pole.position.set(0, (RIM.height + 0.3) / 2, end * (COURT.halfL + 0.6));
  pole.material = makeMat(scene, `pole_${end}`, { diffuse: new Color3(0.2, 0.2, 0.22) });

  const rim = MeshBuilder.CreateTorus(`rim_${end}`, { diameter: RIM.radius * 2, thickness: 0.03, tessellation: 24 }, scene);
  rim.position.set(0, RIM.height, rimZ);
  const rimMat = makeMat(scene, `rimmat_${end}`, { diffuse: new Color3(0.95, 0.45, 0.1), emissive: new Color3(0.3, 0.12, 0.0) });
  rim.material = rimMat;

  // 簡素なネット(不透明度の低い下向きの円錐)
  const net = MeshBuilder.CreateCylinder(`net_${end}`, {
    height: 0.45, diameterTop: RIM.radius * 2, diameterBottom: RIM.radius * 1.2, tessellation: 12,
  }, scene);
  net.position.set(0, RIM.height - 0.22, rimZ);
  net.material = makeMat(scene, `netmat_${end}`, { diffuse: new Color3(1, 1, 1), alpha: 0.25, cull: false });

  return { net, rimMat, boardMat: white };
}

// 現在ボールを保持している選手を強調するためのマーカーリング。
export function makeHandlerRing(scene: Scene): Mesh {
  const ring = MeshBuilder.CreateTorus("handlerRing", { diameter: 1.1, thickness: 0.06, tessellation: 24 }, scene);
  ring.position.y = 0.03;
  ring.material = makeMat(scene, "ringmat", { emissive: new Color3(1, 0.95, 0.3), unlit: true });
  ring.isVisible = false;
  return ring;
}
