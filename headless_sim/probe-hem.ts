// シャツの裾とショーツの腰の高さ関係、そして裾の下に地肌が出ていないかを見る。
import "./stubs";
import { uniformData, bodyData, VoxRole, VOX_SIZE, variantFor } from "@objcts/player/voxel/voxelBody";

const variant = variantFor(50);
const cl = uniformData(variant), bd = bodyData(variant);
function qrot(q: number[], v: number[]): number[] {
  const [x, y, z, w] = q;
  const t = [2 * (y * v[2] - z * v[1]), 2 * (z * v[0] - x * v[2]), 2 * (x * v[1] - y * v[0])];
  return [v[0] + w * t[0] + (y * t[2] - z * t[1]), v[1] + w * t[1] + (z * t[0] - x * t[2]), v[2] + w * t[2] + (x * t[1] - y * t[0])];
}
function world(d: typeof cl, part: string): number[][] {
  const pd = d.parts[part];
  if (!pd?.voxels.length) return [];
  const q = pd.restRot ?? [0, 0, 0, 1];
  return pd.voxels.map((v) => {
    const l = qrot(q, [(v[0] + .5) * VOX_SIZE, (v[1] + .5) * VOX_SIZE, (v[2] + .5) * VOX_SIZE]);
    return [pd.pivot[0] + l[0], pd.pivot[1] + l[1], pd.pivot[2] + l[2], v[3]];
  });
}
const roleOf = (i: number): number => cl.palette[i][3];
let jerseyLo = Infinity, shortsHi = -Infinity, shortsLo = Infinity;
for (const part of ["torso", "hips", "thighL", "thighR"]) {
  for (const p of world(cl, part)) {
    const r = roleOf(p[3]);
    if (r === VoxRole.Jersey) jerseyLo = Math.min(jerseyLo, p[1]);
    if (r === VoxRole.Shorts) { shortsHi = Math.max(shortsHi, p[1]); shortsLo = Math.min(shortsLo, p[1]); }
  }
}
console.log(`シャツの裾（最下端） y=${jerseyLo.toFixed(3)}m`);
console.log(`ショーツの腰（最上端） y=${shortsHi.toFixed(3)}m  裾 y=${shortsLo.toFixed(3)}m`);
const gap = jerseyLo - shortsHi;
console.log(gap > 0 ? `→ 重なりなし。${(gap * 100).toFixed(1)}cm のすき間（地肌が出る）` : `→ ${(-gap * 100).toFixed(1)}cm 重なっている`);

// その帯に地肌（素体メッシュ）が残っているか
const lo = Math.min(jerseyLo, shortsHi) - 0.02, hi = Math.max(jerseyLo, shortsHi) + 0.02;
let skin = 0;
for (const part of ["torso", "hips"]) for (const p of world(bd as typeof cl, part)) if (p[1] > lo && p[1] < hi) skin++;
console.log(`すき間の帯 (y ${lo.toFixed(2)}..${hi.toFixed(2)}) にある素体ボクセル: ${skin}`);

// 重なっている帯で、どちらが外側にあるか（体の軸からの距離）
console.log("\n高さ    シャツ最大半径  ショーツ最大半径  外側");
for (let y = 0.98; y <= 1.10; y += 0.02) {
  let jr = 0, sr = 0, jn = 0, sn = 0;
  for (const part of ["torso", "hips", "thighL", "thighR"]) {
    for (const p of world(cl, part)) {
      if (Math.abs(p[1] - y) > 0.011) continue;
      const r = Math.hypot(p[0], p[2] - 0.03);
      if (roleOf(p[3]) === VoxRole.Jersey) { jr = Math.max(jr, r); jn++; }
      if (roleOf(p[3]) === VoxRole.Shorts) { sr = Math.max(sr, r); sn++; }
    }
  }
  const who = jn && sn ? (jr > sr ? "シャツ" : "ショーツ") : jn ? "シャツのみ" : sn ? "ショーツのみ" : "-";
  console.log(`y=${y.toFixed(2)}  ${jr.toFixed(3)}(${String(jn).padStart(3)}個)   ${sr.toFixed(3)}(${String(sn).padStart(3)}個)   ${who}`);
}
