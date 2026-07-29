import { Scene, Mesh, MeshBuilder, Color3, Vector3, StandardMaterial } from "@babylonjs/core";
import { makeMat } from "./materials";

// ボール本体オブジェクト。位置(pos)と自由飛行時の速度(vel)を持ち、sync でメッシュへ反映。
export class Ball {
  readonly mesh: Mesh;
  readonly mat: StandardMaterial;   // 発光演出(flashBall)で emissiveColor を触る
  readonly halo: Mesh;              // 発光演出で膨らんで消える光の殻
  readonly haloMat: StandardMaterial;
  readonly pos = new Vector3(0, 1, 0);
  readonly vel = new Vector3();   // ルーズボール(自由飛行)中に使用

  constructor(scene: Scene) {
    this.mesh = MeshBuilder.CreateSphere("ball", { diameter: 0.24, segments: 12 }, scene);
    this.mat = makeMat(scene, "ballmat",
      { diffuse: new Color3(0.85, 0.4, 0.12), spec: new Color3(0.25, 0.2, 0.15) });
    this.mesh.material = this.mat;
    // 光の殻: ライティング無効・両面・半透明。演出中だけ表示して膨らませる。
    this.halo = MeshBuilder.CreateSphere("ballhalo", { diameter: 0.24, segments: 12 }, scene);
    this.haloMat = makeMat(scene, "ballhalomat",
      { emissive: new Color3(1, 1, 1), unlit: true, alpha: 0, cull: false });
    this.halo.material = this.haloMat;
    this.halo.isVisible = false;
    this.halo.isPickable = false;
  }

  sync(): void {
    this.mesh.position.copyFrom(this.pos);
    if (this.halo.isVisible) this.halo.position.copyFrom(this.pos);
  }
}
