// シーンの照明と影。addShadows は選手/ボールのメッシュに依存するため game 生成後に呼ぶ。
import { Scene, HemisphericLight, DirectionalLight, ShadowGenerator, Vector3, Color3 } from "@babylonjs/core";
import { Game } from "./game";
import { setVoxelShadowHook } from "./objects/player/player-voxel";
import { Player } from "./objects/player/player";

// ベンチの選手を影から外すために保持する（コート上10人だけが影を落とす）。
let shadowGen: ShadowGenerator | null = null;
/** 影キャスターの登録/解除。ベンチ入り(sit)/出場(stand)で切り替える。 */
export function setPlayerShadow(p: Player, on: boolean): void {
  if (!shadowGen) return;
  for (const m of p.vox?.shadowMeshes ?? []) {
    if (on) shadowGen.addShadowCaster(m, false); else shadowGen.removeShadowCaster(m, false);
  }
}

// 照明: hemi（上向き面）+ groundColor（下向き面のアンビエント）+ sun + fill。
export function addLights(scene: Scene): { sun: DirectionalLight } {
  const hemi = new HemisphericLight("hemi", new Vector3(0, 1, 0), scene);
  hemi.intensity = 0.8;
  hemi.groundColor = new Color3(0.42, 0.4, 0.38);

  const sun = new DirectionalLight("sun", new Vector3(-0.4, -1, 0.3), scene);
  sun.position = new Vector3(8, 18, -6);
  sun.intensity = 0.9;

  // 前方からのフィルライト（影なし）。
  const fill = new DirectionalLight("fill", new Vector3(0.3, 0.35, -1), scene);
  fill.intensity = 0.35;

  return { sun };
}

// 選手の体メッシュとボールを影キャスターに登録する。
export function addShadows(sun: DirectionalLight, game: Game): void {
  const shadow = new ShadowGenerator(1024, sun);
  shadowGen = shadow;
  shadow.useBlurExponentialShadowMap = true;
  shadow.blurScale = 2;
  for (let t = 0; t < 2; t++) {
    for (const p of game.allPlayers(t)) {
      if (!p.seated) for (const m of p.vox?.shadowMeshes ?? []) shadow.addShadowCaster(m, false);
    }
  }
  // ボクセルは着替え・髪型・ロースター入替で作り直すので、その都度登録し直す
  setVoxelShadowHook((ms) => { for (const m of ms) shadow.addShadowCaster(m, false); });
  shadow.addShadowCaster(game.ball.mesh);
}
