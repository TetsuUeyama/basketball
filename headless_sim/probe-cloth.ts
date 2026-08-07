// 再焼き後も見た目のデータが変わっていないか（ボクセル数・三角形数）と、
// 布のウェイトが袖ぐり/股でどれだけ混ざっているかを見る。
import "./stubs";
import { NullEngine, Scene, TransformNode } from "@babylonjs/core";
import { buildVoxelBody } from "../src/objects/player/player-voxel";
import clothN from "@objcts/player/voxel/data/cloth-normal.json";

const engine = new NullEngine();
const scene = new Scene(engine);
const vb = buildVoxelBody(scene, new TransformNode("p", scene), {
  name: "x", balance: 50, height: 1.95, skin: { r: .7, g: .5, b: .4 }, hair: { r: .1, g: .1, b: .1 },
  hairNo: 5, kit: { top: { r: 1, g: .3, b: .1 }, bottom: { r: .8, g: .2, b: .1 }, shoes: { r: 1, g: 1, b: 1 } },
  jerseyText: "7",
});
let tri = 0, vert = 0;
for (const m of vb.meshes) { tri += m.getTotalIndices() / 3; vert += m.getTotalVertices(); }
console.log(`1人ぶん ${vb.meshes.length}メッシュ / ${vert}頂点 / ${tri}三角形`);

// 布のウェイトが「2本以上のボーンに混ざっている」割合を部位ごとに数える
const c = clothN as unknown as {
  voxelSize: number; skinBones: string[]; skinWeights: number[];
  parts: Record<string, { pivot: number[]; voxels: number[][] }>;
};
console.log("\n部位        ボクセル  混合(2本以上)  主なボーンの組み合わせ");
for (const [name, pd] of Object.entries(c.parts)) {
  if (!pd.voxels.length) continue;
  let mixed = 0;
  const combo = new Map<string, number>();
  for (const v of pd.voxels) {
    const wi = v[4];
    if (wi === undefined) continue;
    const f = c.skinWeights.slice(wi * 8, wi * 8 + 8);
    const bs: string[] = [];
    for (let i = 0; i < 4; i++) if (f[4 + i] > 0) bs.push(c.skinBones[f[i]]);
    if (bs.length > 1) mixed++;
    const k = bs.join("+");
    combo.set(k, (combo.get(k) ?? 0) + 1);
  }
  const top = [...combo].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, n]) => `${k}(${n})`).join("  ");
  console.log(`${name.padEnd(11)} ${String(pd.voxels.length).padStart(6)}  ${String(mixed).padStart(6)} (${(mixed / pd.voxels.length * 100).toFixed(0)}%)   ${top}`);
}
