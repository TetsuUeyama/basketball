// ジャンプクリップの滞空区間の後ろに、着地フレームがどれだけ残っているかを見る。
import "./stubs";
import { motionClip, motionDuration } from "@objcts/player/motion/clip";
for (const n of ["jump", "jumpF", "jumpB", "jumpL", "jumpR"]) {
  const c = motionClip(n);
  if (!c) { console.log(`${n}: なし`); continue; }
  const dur = motionDuration(c);
  const g = c.groundLock;
  let lo = -1, hi = -1;
  if (g) for (let i = 0; i < g.length; i++) if (g[i] < 0.5) { if (lo < 0) lo = i; hi = i; }
  if (lo < 0) { console.log(`${n}: 滞空区間なし (dur ${dur.toFixed(2)}s)`); continue; }
  const a0 = lo / c.fps, a1 = (hi + 1) / c.fps;
  console.log(`${n}: 全長 ${dur.toFixed(2)}s / 滞空 ${a0.toFixed(2)}〜${a1.toFixed(2)}s / 着地フレーム ${(dur - a1).toFixed(2)}s`);
}
