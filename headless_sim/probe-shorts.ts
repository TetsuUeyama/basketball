// 見えているズボン（シャツの裾より下）と脚の素体の余裕を高さごとに測る。
import "./stubs";
import { uniformVoxels, bodyData, uniformData, partStretch, applyStretch, VoxRole, VOX_SIZE,
  DEFAULT_WIDTH_EXPONENT, DEFAULT_HEAD_EXPONENT, variantFor } from "@objcts/player/voxel/voxelBody";
const we = DEFAULT_WIDTH_EXPONENT, he = DEFAULT_HEAD_EXPONENT;
const height = 1.95, variant = variantFor(50);
const cl = uniformData(variant), bd = bodyData(variant);
const st = partStretch(variant, height, we, he);
const rows: string[] = [];
for (const part of ["hips", "thighL"]) {
  const pd = cl.parts[part], bp = bd.parts[part];
  if (!pd || !bp) continue;
  const cloth = uniformVoxels(variant, part, height, we).filter((v) => cl.palette[v[3]][3] === VoxRole.Shorts);
  const skin = applyStretch(bp.voxels, st[part] ?? { x: 0, y: 0, z: 0 });
  if (!cloth.length) { rows.push(`  ${part}: ショーツの布なし`); continue; }
  // 骨ローカルの y 層ごとに、幅Xの半径を比べる
  const layers = new Map<number, { c: number; s: number }>();
  for (const v of cloth) { const l = layers.get(v[1]) ?? { c: 0, s: 0 }; l.c = Math.max(l.c, Math.abs(v[0])); layers.set(v[1], l); }
  for (const v of skin) { const l = layers.get(v[1]); if (l) l.s = Math.max(l.s, Math.abs(v[0])); }
  const ys = [...layers.keys()].sort((a, b) => b - a);
  const pick = [ys[0], ys[Math.floor(ys.length * 0.35)], ys[Math.floor(ys.length * 0.7)], ys[ys.length - 1]];
  rows.push(`  ${part}:`);
  for (const y of pick) {
    const l = layers.get(y)!;
    const gap = (l.c - l.s) * VOX_SIZE * 100;
    rows.push(`    層y=${String(y).padStart(3)}  布半径 ${(l.c * VOX_SIZE).toFixed(3)}m  素体 ${(l.s * VOX_SIZE).toFixed(3)}m  余裕 ${gap.toFixed(1)}cm`);
  }
  const ext = (a: number[][], ax: number): number => {
    let lo = Infinity, hi = -Infinity;
    for (const v of a) { if (v[ax] < lo) lo = v[ax]; if (v[ax] > hi) hi = v[ax]; }
    return (hi - lo + 1) * VOX_SIZE;
  };
  rows.push(`    全体 幅X ${ext(cloth, 0).toFixed(3)}m 奥行Z ${ext(cloth, 2).toFixed(3)}m / ${cloth.length}ボクセル`);
}
console.log(rows.join("\n"));
