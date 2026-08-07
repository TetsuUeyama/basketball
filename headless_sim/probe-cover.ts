// シャツの下に地肌（素体メッシュ）が残っていないか、実際に組んだメッシュで数える。
import "./stubs";
import { NullEngine, Scene, TransformNode, Vector3, VertexBuffer } from "@babylonjs/core";
import { buildVoxelBody } from "../src/objects/player/player-voxel";
const engine = new NullEngine();
const scene = new Scene(engine);
const vb = buildVoxelBody(scene, new TransformNode("p", scene), {
  name: "x", balance: 50, height: 1.95, skin: { r: .7, g: .5, b: .4 }, hair: { r: .1, g: .1, b: .1 },
  hairNo: 5, kit: { top: { r: 1, g: .3, b: .1 }, bottom: { r: .8, g: .2, b: .1 }, shoes: { r: 1, g: 1, b: 1 } },
  jerseyText: "7",
});
// シャツが覆う帯（身長1.95m にスケールした概算: 素の 0.95..1.08 → ×1.95/1.83）
const k = 1.95 / 1.83, lo = 0.95 * k, hi = 1.08 * k;
let skinV = 0, clothV = 0;
for (const m of vb.meshes) {
  m.computeWorldMatrix(true);
  const pos = m.getVerticesData(VertexBuffer.PositionKind);
  if (!pos) continue;
  const w = m.getWorldMatrix();
  let n = 0;
  for (let i = 0; i < pos.length; i += 3) {
    const v = Vector3.TransformCoordinates(new Vector3(pos[i], pos[i + 1], pos[i + 2]), w);
    if (v.y > lo && v.y < hi) n++;
  }
  if (n) console.log(`  ${m.name}: ${n}`);
  if (m.name.startsWith("voxb_") || m.name.startsWith("voxhead")) skinV += n; else clothV += n;
}
console.log(`シャツが覆う帯 y ${lo.toFixed(2)}..${hi.toFixed(2)} の頂点: 素体 ${skinV} / 服 ${clothV}`);
let tri = 0;
for (const m of vb.meshes) tri += m.getTotalIndices() / 3;
console.log(`全体 ${vb.meshes.length}メッシュ / ${tri}三角形`);
