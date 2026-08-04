/**
 * appearance — 「ボーンだけのスケルトン」に後から見た目を与えるための契約。
 *
 * スケルトン（standardSkeleton の標準名で引ける骨組み）と、見た目（通常メッシュ /
 * ボクセル）を分離する。同じスケルトンに対して AppearanceProvider を差し替えれば、
 * モーション側のコードを一切変えずに見た目だけ切り替えられる。
 *
 * このファイルだけ Babylon の型に依存する（実体は持たず型契約のみ）。
 */
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";
import type { StandardBoneName } from "./standardSkeleton";

/** 標準名で骨を引ける、メッシュを持たないスケルトン。 */
export interface SkeletonHandle {
  readonly scene: Scene;
  /** 全体を動かす親ノード。 */
  readonly root: TransformNode;
  /** 標準名 → 実ノード。解決できなければ null。 */
  bone(name: StandardBoneName): TransformNode | null;
  /** 解決済みの標準ボーン一覧。 */
  readonly present: ReadonlySet<StandardBoneName>;
  /**
   * 静止姿勢での「この骨が伸びていく向き」（親ローカル空間の単位ベクトル）。
   * quatFromTo の from に渡す。**モデルから実測した値**であり既定値ではない。
   */
  restDirection(name: StandardBoneName): { x: number; y: number; z: number } | null;
}

/** 見た目の実体。差し替え時は dispose するか、setVisible で切り替える。 */
export interface AppearanceHandle {
  readonly kind: string;
  readonly meshes: readonly AbstractMesh[];
  setVisible(visible: boolean): void;
  dispose(): void;
}

/**
 * スケルトンを受け取って見た目を作る。実装例:
 *   - glTF をロードしてスキニングをバインドする「通常メッシュ」
 *   - .vox を読んで各ボクセルをボーンへ割り当てる「ボクセル」
 *   - 通常メッシュを取り込んでボクセル化し自動スキンする「ボクセル化」
 */
export interface AppearanceProvider {
  readonly kind: string;
  attach(skeleton: SkeletonHandle): Promise<AppearanceHandle> | AppearanceHandle;
}

/**
 * 複数の見た目を保持し、表示を1つだけに切り替える。
 * 生成済みのものは破棄せず隠すだけなので、切り替えは即座に効く。
 */
export class AppearanceSwitcher {
  private readonly handles = new Map<string, AppearanceHandle>();
  private current: string | null = null;

  constructor(private readonly skeleton: SkeletonHandle) {}

  /** provider を実体化して登録する（同じ kind は再利用する）。 */
  async add(provider: AppearanceProvider): Promise<AppearanceHandle> {
    const existing = this.handles.get(provider.kind);
    if (existing) return existing;
    const handle = await provider.attach(this.skeleton);
    handle.setVisible(false);
    this.handles.set(provider.kind, handle);
    return handle;
  }

  /** 指定の見た目だけを表示する。未登録なら false を返す。 */
  show(kind: string): boolean {
    const next = this.handles.get(kind);
    if (!next) return false;
    for (const [k, h] of this.handles) h.setVisible(k === kind);
    this.current = kind;
    return true;
  }

  get shown(): string | null { return this.current; }
  get kinds(): string[] { return [...this.handles.keys()]; }

  dispose(): void {
    for (const h of this.handles.values()) h.dispose();
    this.handles.clear();
    this.current = null;
  }
}
