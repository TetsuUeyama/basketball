import { Scene, Mesh, MeshBuilder, Color3, Vector3 } from "@babylonjs/core";
import { makeMat } from "./materials";

// ボール本体オブジェクト。位置(pos)と自由飛行時の速度(vel)を持ち、sync でメッシュへ反映。
export class Ball {
  readonly mesh: Mesh;
  readonly pos = new Vector3(0, 1, 0);
  readonly vel = new Vector3();   // ルーズボール(自由飛行)中に使用

  constructor(scene: Scene) {
    this.mesh = MeshBuilder.CreateSphere("ball", { diameter: 0.24, segments: 12 }, scene);
    this.mesh.material = makeMat(scene, "ballmat",
      { diffuse: new Color3(0.85, 0.4, 0.12), spec: new Color3(0.25, 0.2, 0.15) });
  }

  sync(): void {
    this.mesh.position.copyFrom(this.pos);
  }
}
