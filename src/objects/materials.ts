import { Color3, Scene, StandardMaterial } from "@babylonjs/core";

// StandardMaterial 生成の共通ファクトリ。未指定のプロパティはBabylonの既定値のまま。
export interface MatOpts {
  diffuse?: Color3;   // 拡散色
  spec?: Color3;      // スペキュラ色
  emissive?: Color3;  // 自己発光色
  alpha?: number;     // 不透明度
  cull?: boolean;     // backFaceCulling（false=両面描画）
  unlit?: boolean;    // true=ライティング無効
}

export function makeMat(scene: Scene, name: string, opts: MatOpts = {}): StandardMaterial {
  const m = new StandardMaterial(name, scene);
  if (opts.diffuse) m.diffuseColor = opts.diffuse;
  if (opts.spec) m.specularColor = opts.spec;
  if (opts.emissive) m.emissiveColor = opts.emissive;
  if (opts.alpha !== undefined) m.alpha = opts.alpha;
  if (opts.cull !== undefined) m.backFaceCulling = opts.cull;
  if (opts.unlit) m.disableLighting = true;
  return m;
}
