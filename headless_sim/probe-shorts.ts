// ズボンの太さと、脚の素体との隙間を実測する。
import "./stubs";
import { uniformVoxels, bodyData, uniformData, partStretch, applyStretch, VoxRole, VOX_SIZE,
  DEFAULT_WIDTH_EXPONENT, DEFAULT_HEAD_EXPONENT, variantFor } from "@objcts/player/voxel/voxelBody";

const we = DEFAULT_WIDTH_EXPONENT, he = DEFAULT_HEAD_EXPONENT;
for (const height of [1.80, 1.95, 2.10]) {
  const variant = variantFor(50);
  const cl = uniformData(variant), bd = bodyData(variant);
  const st = partStretch(variant, height, we, he);
  console.log(`\n=== 身長 ${height.toFixed(2)}m (${variant}) ===`);
  for (const part of ["hips", "thighL"]) {
    const cloth = uniformVoxels(variant, part, height, we);
    // ショーツ役の布だけを見る
    const sv = cloth.filter((v) => cl.palette[v[3]][3] === VoxRole.Shorts);
    if (!sv.length) { console.log(`  ${part}: ショーツの布なし`); continue; }
    const skin = applyStretch(bd.parts[part]?.voxels ?? [], st[part] ?? { x: 0, y: 0, z: 0 });
    const ext = (a: number[][], axis: number): [number, number] => {
      let lo = Infinity, hi = -Infinity;
      for (const v of a) { if (v[axis] < lo) lo = v[axis]; if (v[axis] > hi) hi = v[axis]; }
      return [lo, hi];
    };
    const [cx0, cx1] = ext(sv, 0), [cz0, cz1] = ext(sv, 2), [cy0, cy1] = ext(sv, 1);
    const [sx0, sx1] = ext(skin, 0), [sz0, sz1] = ext(skin, 2);
    const w = (a: number, b: number) => ((b - a + 1) * VOX_SIZE).toFixed(3);
    console.log(`  ${part}: 布 幅X ${w(cx0, cx1)}m 奥行Z ${w(cz0, cz1)}m 丈Y ${w(cy0, cy1)}m / ${sv.length}ボクセル`);
    console.log(`         素体 幅X ${w(sx0, sx1)}m 奥行Z ${w(sz0, sz1)}m`);
    console.log(`         隙間 X片側 ${(((cx1 - sx1) + (sx0 - cx0)) / 2 * VOX_SIZE * 100).toFixed(1)}cm  Z片側 ${(((cz1 - sz1) + (sz0 - cz0)) / 2 * VOX_SIZE * 100).toFixed(1)}cm`);
  }
}
