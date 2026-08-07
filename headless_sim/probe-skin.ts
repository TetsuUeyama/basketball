// スキン付きの服が、腕の回転にどれだけ追従するかを実測する。
import "./stubs";
import { NullEngine, Scene, TransformNode, Vector3, Quaternion, VertexBuffer } from "@babylonjs/core";
import { buildVoxelBody, syncVoxelPose } from "../src/objects/player/player-voxel";
import { aimDownTo } from "../src/objects/player/player";

const engine = new NullEngine();
const scene = new Scene(engine);
const vb = buildVoxelBody(scene, new TransformNode("p", scene), {
  name: "x", balance: 50, height: 1.95, skin: { r: .7, g: .5, b: .4 }, hair: { r: .1, g: .1, b: .1 },
  hairNo: 5, kit: { top: { r: 1, g: .3, b: .1 }, bottom: { r: .8, g: .2, b: .1 }, shoes: { r: 1, g: 1, b: 1 } },
  jerseyText: "7",
});
const cloth = vb.meshes.filter((m) => m.name.startsWith("voxu_"));
console.log(`服のメッシュ ${cloth.length}枚  ボーン ${vb.skel.bones.length}本`);
const m = cloth[0];
console.log(`頂点 ${m.getTotalVertices()} / 三角形 ${m.getTotalIndices() / 3}  スキン属性 ${!!m.getVerticesData(VertexBuffer.MatricesWeightsKind)}`);
const bb = m.getBoundingInfo().boundingBox;
console.log(`静止時の範囲 x ${bb.minimum.x.toFixed(2)}..${bb.maximum.x.toFixed(2)}  y ${bb.minimum.y.toFixed(2)}..${bb.maximum.y.toFixed(2)}`);

const node = (): TransformNode => { const n = new TransformNode("v", scene); n.rotationQuaternion = aimDownTo(0, -1, 0); return n; };
const armL = node(), armR = node(), elbowL = node(), elbowR = node();
const hipL = node(), hipR = node(), kneeL = node(), kneeR = node();
const pose = (): void => syncVoxelPose(vb, {
  numberSide: -1, torsoYaw: 0, torsoPitch: 0, torsoOffsetY: 0, torsoOffsetZ: 0,
  headYaw: 0, headPitch: 0, armL, armR, elbowL, elbowR, ikL: true, ikR: true, hipL, hipR, kneeL, kneeR,
});
const snap = (): number[] => {
  pose(); vb.skel.prepare(true); m.computeWorldMatrix(true);
  (m.geometry as unknown as { _softwareSkinningFrameId: number })._softwareSkinningFrameId = -1;
  m.applySkeleton(vb.skel);
  return [...(m.getVerticesData(VertexBuffer.PositionKind) as Float32Array)];
};
const rest = snap();
// 両腕を前へ水平に（チェストパスの形）
const fwd = aimDownTo(0, -0.15, 1);
armL.rotationQuaternion = fwd; armR.rotationQuaternion = fwd;
const posed = snap();

// 帯ごとに移動量を見る（左肩まわり）
const bands: { name: string; hit: (x: number, y: number) => boolean }[] = [
  { name: "胴の中心 (|x|<0.06, y1.2-1.4)", hit: (x, y) => Math.abs(x) < 0.06 && y > 1.2 && y < 1.4 },
  { name: "袖ぐり  (x -0.18..-0.13, y1.28-1.40)", hit: (x, y) => x < -0.13 && x > -0.18 && y > 1.28 && y < 1.40 },
  { name: "上腕の袖(x -0.30..-0.20, y1.20-1.40)", hit: (x, y) => x < -0.20 && x > -0.30 && y > 1.20 && y < 1.40 },
  { name: "腰 (|x|<0.10, y0.95-1.05)", hit: (x, y) => Math.abs(x) < 0.10 && y > 0.95 && y < 1.05 },
];
for (const b of bands) {
  let n = 0, sum = 0, mx = 0;
  for (let i = 0; i < rest.length; i += 3) {
    if (!b.hit(rest[i], rest[i + 1])) continue;
    const d = Math.hypot(posed[i] - rest[i], posed[i + 1] - rest[i + 1], posed[i + 2] - rest[i + 2]);
    n++; sum += d; if (d > mx) mx = d;
  }
  console.log(`${b.name.padEnd(34)} ${String(n).padStart(5)}頂点  平均${(sum / (n || 1)).toFixed(3)}m 最大${mx.toFixed(3)}m`);
}

// --- 追い込み ---
console.log("\nボーン:", vb.skel.bones.map((b, i) => `${i}:${b.name}`).join(" "));
const mi = m.getVerticesData(VertexBuffer.MatricesIndicesKind) as Float32Array;
const mw = m.getVerticesData(VertexBuffer.MatricesWeightsKind) as Float32Array;
const use = new Map<number, number>();
for (let i = 0; i < mi.length; i += 4) for (let s = 0; s < 4; s++) if (mw[i + s] > 0) use.set(mi[i + s], (use.get(mi[i + s]) ?? 0) + 1);
console.log("使われているボーンindex:", [...use].sort((a, b) => b[1] - a[1]).map(([b, n]) => `${b}(${n})`).join(" "));
const ua = vb.skel.bones.find((b) => b.name === "LeftUpperArm")!;
console.log("LeftUpperArm 回転後のローカル行列 m[12..14]:", ua.getLocalMatrix().m[12].toFixed(3), ua.getLocalMatrix().m[13].toFixed(3), ua.getLocalMatrix().m[14].toFixed(3));
console.log("  回転成分 m[0],m[1],m[4]:", ua.getLocalMatrix().m[0].toFixed(3), ua.getLocalMatrix().m[1].toFixed(3), ua.getLocalMatrix().m[4].toFixed(3));
console.log("  リンク先ノードの回転:", vb.rig.node("LeftUpperArm")!.rotationQuaternion?.toString());
