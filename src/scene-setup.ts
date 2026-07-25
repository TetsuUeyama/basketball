// シーンの照明と影。addShadows は選手/ボールのメッシュに依存するため game 生成後に呼ぶ。
import { Scene, HemisphericLight, DirectionalLight, ShadowGenerator, Vector3, Color3 } from "@babylonjs/core";
import { Game } from "./game";

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
  shadow.useBlurExponentialShadowMap = true;
  shadow.blurScale = 2;
  for (let t = 0; t < 2; t++) {
    for (const p of game.allPlayers(t)) {
      // includeDescendants=false: 体メッシュのみ。子（髪/目）からは影を落とさない。
      for (const m of p.meshes) shadow.addShadowCaster(m, false);
    }
  }
  shadow.addShadowCaster(game.ball.mesh);
}
