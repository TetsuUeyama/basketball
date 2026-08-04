# 選手をボクセルモデルへ入れ替える手順

`objcts/player`（標準スケルトン＋ボクセル素体）を basketball-sim のコート上の選手に使うための手順書。

- 調査日: 2026-08-04（`work-record.md` #497）
- **実装済み: 2026-08-04（#499）。既定モデルが `voxel`。実装の結果と残課題は末尾の「6. 実装後の実測と残課題」を見ること。**
- ボクセル側の実体: `C:\Users\user\developsecond\objcts\player\`
- 動いている参考実装: `C:\Users\user\developsecond\function-lab\src\demos\player.ts`
- basketball-sim 側の実体: `src/objects/player/player-voxel.ts`

---

## 0. 前提 — いまの選手は3Dモデルではない

GLB/glTF の読み込みは**一切していない**。`src/objects/player/player.ts` が Babylon の
プリミティブ（`CreateLathe` / `CreateRibbon` / 球 / 円柱 / 手書き `VertexData`）を毎回
組み立てている。human と acorn の2体型を同時に作り、表示だけ切り替えている（`applyModel`）。

骨（`Skeleton`）もスキニングも使っていない。`chestTwist` / `headTurn` / `elbow` / `hip` /
`knee` / `acornFoot` という名前の `TransformNode` を毎フレーム直接回す方式
（可動域と速度は `src/animation/basic/joints.ts`）。

つまりこの作業は「モデルファイルの差し替え」ではなく、**見た目の作り方の置換**になる。

---

## 1. 入れ替えるもの・残すもの

| | 扱い |
|---|---|
| 選手のメッシュ生成（`player.ts` の 330〜770 行あたり） | ボクセル素体＋ユニフォームへ置換 |
| 関節を回すアニメーション（`src/animation/` 一式） | **残す**。ノード名を標準ボーン名へ読み替えて流す |
| 試合ロジック・AI・ボール | 触らない |
| 背番号・ネームタグ・スタミナゲージ | 残す（取り付け先のノードだけ変える） |
| クラブ別キットの再着色（`applyUniform`） | ボクセル側の `Recolor` へ移植 |
| 髪型0〜12（`player-look.ts`） | ボクセル髪138種へ対応付け |

---

## 2. 手順

### Step 1. ビルド設定を作る（これが無いと `@objcts` が解決できない）

basketball-sim には **`vite.config.ts` が無く**、`tsconfig.json` に `paths` も無い。
function-lab と同じものを新設する。

`vite.config.ts`（新規）:

```ts
import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

const objctsDir = fileURLToPath(new URL('../objcts', import.meta.url));
// ⚠️ objcts 配下のファイルは basketball-sim の node_modules を辿れないので、
//    @babylonjs/core をここの node_modules へ明示エイリアスして解決させる。
const babylonCore = fileURLToPath(new URL('./node_modules/@babylonjs/core', import.meta.url));

export default defineConfig({
  resolve: {
    dedupe: ['@babylonjs/core'],
    alias: { '@objcts': objctsDir, '@babylonjs/core': babylonCore },
  },
  // basketball-sim の外から .ts を直接 import するため許可する
  server: { fs: { allow: [fileURLToPath(new URL('.', import.meta.url)), objctsDir] } },
});
```

`tsconfig.json` に追加:

```jsonc
"baseUrl": ".",
"paths": {
  "@objcts/*": ["../objcts/*"],
  "@babylonjs/core": ["./node_modules/@babylonjs/core"],
  "@babylonjs/core/*": ["./node_modules/@babylonjs/core/*"]
},
// include に "../objcts" を足す
```

⚠️ basketball-sim の `npm run build` は `tsc && vite build`。`../objcts` を include に入れると
objcts 側の型エラーもここで出る。`skipLibCheck` は既に true。

### Step 2. まず1体だけ差し替えて確認する

いきなり26人を置き換えない。試合前のプレビュー（`src/main.ts:85` 付近）か、コート上の1体だけを
ボクセルにして、**見た目と実フレームレートを先に測る**。ここで描画量の見通しが立たなければ Step 5 へ。

最小の組み立て（function-lab のデモと同じ）:

```ts
import { bodyRestPose } from '@objcts/player/voxel/voxelBody';
import { buildRig } from '@objcts/player/rig';
import { buildSkinnedBody, buildSkinnedUniform } from '@objcts/player/voxel/uniformSkin';

const rest = bodyRestPose('normal', height, widthExponent, headExponent);
const rig = buildRig(scene, rest, { name: `p_${team}_${idx}`, allowMissing: true, parent: root });
const body = buildSkinnedBody(scene, 'normal', rig, recolor, height, widthExponent,
                              handCurl, { eye: 0, brow: 0, mouth: 0 }, hairStyle);
const uni  = buildSkinnedUniform(scene, 'normal', rig, recolor, height, widthExponent, body.skin);
```

- `rig.root` が位置・向きを動かす親。いまの `p_${team}_${idx}` の代わりになる。
- 素体とユニフォームは**同じ `SkinRig` を共有**すること（`body.skin` を渡す）。別々に作ると
  変形の規則が食い違って地肌が服から出る。
- 手を握った形は焼き込み済み。ボール保持中だけ `handCurl = 0.75` の2枚目を作って表示を切り替える
  （デモの `setGrip` と同じ）。

### Step 3. 関節名を標準ボーン名へ読み替える

既存アニメーションは作り直さない。`Player` が持つ関節ノードの参照を、`rig.node(標準名)` に
差し替える対応表を1か所に作る。

| いまのノード | 標準ボーン | 備考 |
|---|---|---|
| `torsoTwist_*`（`chestTwist`） | `Spine` | ヨー。root に対する上半身のツイスト |
| `headYaw_*`（`headTurn`） | `Head` | ヨー |
| 肩ピボット `arm_L/R_*` | `LeftUpperArm` / `RightUpperArm` | 下記⚠️ |
| 肘（`elbow`） | `LeftLowerArm` / `RightLowerArm` | 曲げ |
| `hip_L/R_*`（`hip`） | `LeftUpperLeg` / `RightUpperLeg` | 前後振り |
| 膝（`knee`） | `LeftLowerLeg` / `RightLowerLeg` | 曲げ |
| `acornFoot_L/R_*` | `LeftFoot` / `RightFoot` | どんぐり体型専用。ボクセルでは不要 |

⚠️ **一番の落とし穴は腕**。`src/objects/player/player.ts:19` の `aimDownTo()` は
**「腕は (0,-1,0) に垂れている」前提**で回転を作っている。ボクセル素体の静止時の上腕は
**ほぼ真横**（仰角 -27.5° / 方位 94°）なので、そのまま使うと腕がまったく違う方向を向く。

`objcts` の規約どおり、静止方向との**差分**で作り直すこと:

```ts
// 旧: easeArm(pivot, aimDownTo(dx, dy, dz))
// 新: 静止時の向きを実測値から取り、そこから目標方向への差分回転にする
const rest = rig.restDirection('LeftUpperArm')!;      // モデルごとに違う
easeArm(node, quatFromTo(rest, new Vector3(dx, dy, dz)));
```

`quatFromTo` は `objcts/player` 側の考え方（README「リグ規約を焼き込まない」）。同等の実装が
無ければ `Quaternion.RotationAxis(Vector3.Cross(rest, target), angle)` で作る。

⚠️ 胸の前方は「ローカル `-numberSide·Z`」という規約が既存コードに散らばっている
（`src/animation/basic/torso.ts:99-107`）。ボクセル素体の forward は **+Z**。符号の扱いを
`numberSide` に寄せるのか +Z に寄せるのか、**先に決めてから**着手する。

### Step 4. 見た目の機能を移す

| 機能 | いまの場所 | 移し方 |
|---|---|---|
| 肌の色 | `player-look.ts` `SKIN_HEX`（8色） | `Recolor` の `VoxRole.Skin`。**基準色 (226,166,138) に対する倍率**で塗る（単色で潰すと陰影が消える） |
| 髪の色 | `player-look.ts` `HAIR_HEX`（11色） | `Recolor` の `VoxRole.Hair`。眉も同じ役割なので一緒に変わる |
| 髪型 | 0〜12（`player-visual.ts` で球/トーラス/円柱を組む） | `hairStyles()` の138種へ対応付ける表を作る。今の13種に近いものを選ぶか、13種に絞る |
| キット4パーツ | `config.ts` `UNIFORMS` / `clubkits.ts` / `applyUniform` | `Recolor` の `VoxRole.Jersey` / `Shorts` / `Shoes`。**メッシュを作り直さずに色だけ変える経路が要る**（今は再着色でメッシュを作り直す作り） |
| 背番号 | 曲面リボン＋`DynamicTexture`（`player.ts:613-660`） | そのまま。取り付け先を `rig.node('Spine')` などに変える |
| ネームタグ / スタミナ | `player-visual.ts:309` | そのまま。`rig.root` の子に |
| 身長 | `root.scaling.y = height/1.95` | **スケールをやめて** `bodyRestPose(v, height, ...)` で骨組みごと作る（頭の大きさの扱いが別なので見た目が変わる） |
| 体型 | `attr.balance` で胴の奥行き 0.667〜1.0 | 体型3種（skinny / normal / muscle）＋`widthExponent` へ対応付ける |
| 審判の「R」 | `setJerseyMark()` | そのまま |
| 顔 | 球＋小球2つ | ボクセル側に焼き込み済み（白目3×2＋黒目1マス、眉、口の横一文字）。切り替えは無い |

⚠️ 色の役割は `VoxRole = { Skin, Hair, Jersey, Shorts, Shoes, Face }`。**目と口は `Face`** で、
肌や髪の色を変えても影響されない。

### Step 5. 描画量の対策（実測値）

身長 1.95m・髪あり・normal で計測（`NullEngine`）:

| | 三角形 |
|---|---|
| 素体＋髪 | 45,838 |
| ユニフォーム | 53,428 |
| 1体合計 | 99,266 |
| **26人** | **約258万** |

骨は16本×26体。いまのプリミティブ選手は1体数千程度なので **10〜20倍**。そのままでは
中位のGPUで厳しい可能性が高い。対策の候補:

1. **ゲーム用に粗く焼き直す**（2cm格子 → 三角形は約1/4）。`objcts/player/voxel/tools/buildParts.mjs` の
   ボクセル辺長を変えて別データを出す。見た目は粗くなる。
2. **LOD**。近い数人だけボクセル、遠い選手は今のプリミティブのまま。両方の見た目を持つことになる。
3. **ユニフォームを別メッシュにしない**。素体に服の色を塗った1枚にすれば約半分。着替えの自由度は落ちる。

⚠️ 素体とユニフォームは頂点数がほぼ同じ。**服だけでも半分**を占めるので、まずここを見直すのが効く。

---

## 3. API 早見表（`objcts/player`）

```ts
// 骨組み
import { buildRig, type RigHandle } from '@objcts/player/rig';
buildRig(scene, restPose, { name, allowMissing, parent }): RigHandle
rig.root                         // 位置・向きを動かす親
rig.node('LeftUpperArm')         // 標準ボーン名 → TransformNode
rig.restDirection('LeftUpperArm')// 静止時にその骨が向いている方向（回転の差分計算に使う）
rig.restPosition('Head')         // 静止姿勢でのワールド位置

// ボクセル素体
import {
  bodyRestPose, uniformSizeFor, hairStyles, hairColor, skinBaseColor,
  handCurlSteps, VoxRole, type BodyVariant, type Recolor,
} from '@objcts/player/voxel/voxelBody';
bodyRestPose(variant, height, widthExponent?, headExponent?)
hairStyles(): string[]           // 138種
skinBaseColor(variant): number[] // 基準の肌色（塗り替えの分母）

import { buildSkinnedBody, buildSkinnedUniform, type FaceStyle }
  from '@objcts/player/voxel/uniformSkin';
buildSkinnedBody(scene, variant, rig, recolor, height, we, handCurl, face, hair, sk?)
  // → { mesh, skin }   sk を渡すと骨組みを共有する
buildSkinnedUniform(scene, variant, rig, recolor, height, we, sk?)
  // → { mesh, skeleton }

// モーション（使うなら）
import { motionClip, applyMotion, MOTION_NAMES, resetPose, ballPosition }
  from '@objcts/player/motion/clip';
applyMotion(rig, clip, timeSec, { rootMotion, weight, groundFeet, hipSplayDeg, leanDeg, armAim })
```

`MOTION_NAMES` に idle / walk / run / サイドステップ / バック / ジャンプ / ドリブル各種 /
パス各種 / シュート各種の**焼き込み済みクリップ35本**がある。ただし basketball-sim は
状態からポーズを毎フレーム作る方式なので、**クリップ再生に寄せるなら試合ロジック側の
書き換えが必要**。最初は使わず、既存アニメーションを標準ボーンへ流すだけにするのが安全。

---

## 4. 落とし穴（作業中に実際に踏んだもの）

- **`applyStretch` は伸縮量が0のとき入力の配列をそのまま返す。** 戻り値を加工すると
  読み込んだ JSON の素体データを直接書き換えてしまう。必ず複製してから触る。
  （髪を切り替えても前の髪が残る不具合の原因だった。#495）
- **素体の色は目も口も眉も全部 `Skin` 役で焼いてある。** 役割を振り直さずに肌を塗り替えると
  目や口まで肌色に染まる。`buildSkinnedBody` の中で眉→`Hair`、目と口→`Face` に振り直している。（#496）
- **顔は平らな板で、本物の額のように後退していない。** 髪をそのまま乗せると前髪が顔を横切る。
  髪データは焼く時点で顔の板にかかる分を削ってある。（#493）
- **元の髪データ（Man_Hair_Collection.obj）は顔が +z、こちらも +z。** 180度回すと前後が逆になる。
  左右だけ反転する（元は Y-up 右手系、こちらは左手系で +x がモデルの右）。（#494）
- **腕は X軸回転では上がらない。** 静止時の上腕がほぼ真横なので、角度ではなく**方向**で指定する。
- 髪データは 1.20MB（箱の中のビットマスクを base64 で持つ）。並びのまま持つと 8.6MB になる。

---

## 5. 検証のやり方

ブラウザを開かずに数値で確かめられる。`NullEngine` を使い、esbuild で実 TS をそのまま束ねる。

```bash
npx esbuild test.ts --bundle --platform=node --format=cjs --outfile=test.js \
  --alias:@babylonjs/core=C:/Users/user/developsecond/function-lab/node_modules/@babylonjs/core
node test.js
```

⚠️ **データを焼き直したら必ず束ね直すこと**。忘れて「変化なし」と誤読した事故が何度もある。

見るべき値の例:
- 三角形数（`mesh.getIndices().length / 3`）
- 色ごとの頂点数（`mesh.getVerticesData('color')` を数える）→ 着色が効いているか
- ボーンのワールド位置（`rig.node(b).getAbsolutePosition()`）→ 関節の読み替えが合っているか

最後は**必ずブラウザで目視確認する**。ヘッドレスの数値だけでは向き・食い込み・ちらつきは分からない。

---

## 6. 実装後の実測と残課題（2026-08-04 / #499）

実装は上の計画とは **1点だけ違う道**を採った。既存の関節ノードを標準ボーンへ「置き換える」のではなく、
**既存ノードを仮想の骨組みとして残し、その回転を毎フレーム標準ボーンへ転写する**方式にした
（`src/objects/player/player-voxel.ts` の `syncVoxelPose`）。理由は2つ:

- `animation/` 一式（22ファイル・282箇所）を書き換えずに済む。人型・どんぐりもそのまま残る。
- Step 3 の「腕の落とし穴」を、アニメ側ではなく転写側の1箇所で吸収できる。

### 回転の読み替え（ここが要）

ボクセルの部位は「骨が -Y」の骨ローカルで持ち、焼き込みの `restRot` で元の角度へ戻す。
一方リグの**子関節のオフセットは元の静止姿勢のまま**なので、ノードの回転を素直に
「(0,-1,0) を目標へ向ける回転 V」にすると**関節位置とメッシュの向きが食い違う**。正しくは:

```
メッシュ  … ノードの子として restRot(部位) を自分で持つ
ノード    … restRot(親の部位) ⊗ V ⊗ restRot(自分の部位)⁻¹
```

- 仮想側にノードが無いボーン（`Hips` / `LeftHand` / `RightHand` / `LeftFoot` / `RightFoot`）は
  **回転を入れない（Identity）**。入れるとその部位の焼き込み向きが二重に効いてズレる。
- 前後の規約差（既存 = 前方 `-numberSide·Z` / ボクセル = 前方 `+Z`）は、`numberSide > 0` のとき
  骨組みを Y に 180° 回し、流す回転を `Ry(π)` で共役（x,z を反転）し、左右の腕・脚を入れ替えて吸収する。

### 腕は「外向き角の下限」で胴から逃がす

ボクセル素体は肩の関節が胴の内側（x=±0.12、胴の半幅 0.21）にあるので、既存の休めポーズ
（腕クォータニオン = 単位）をそのまま流すと**腕が胴に埋まる**。`MIN_ARM_SPLAY = 0.61rad(35°)` を
下限として、下向きの腕だけ外へ逃がしている。上げた腕・広げた腕には効かない。

### 手のひらの位置（IK）

⚠️ 手首ボーンは前腕の中ほどに立っていて、手のボクセルはそこから外へ 0.14〜0.32m はみ出す
（objcts 側の既知のズレ）。素直に組むと IK がボールに手を乗せられない（実測ズレ 0.27〜0.47m）。
対処: 「肘 → 手のひらの重心」を前腕の実効長（**0.427m**、骨の 0.204m ではない）とし、その向きが
前腕の軸に乗るよう前腕へ補正回転（実測 5.7°）を掛けた。結果、届く範囲でのズレは **0.008〜0.11m**。

### 実測値（NullEngine・ROSTER 26人×2チーム＋審判）

| | 値 |
|---|---|
| 生成 | **約4.1秒**（プロトタイプ共有あり。共有なしだと8.5秒） |
| 表示メッシュ | 1,202 |
| 三角形 | **約415万** |
| 30秒ぶんの更新 | 512ms（姿勢転写のコストは無視できる） |
| `npm run build` の bundle | 14.4MB（gzip 3.1MB。ボクセルの JSON が約7.5MB） |
| モデル切替 | 11〜16ms（例外なし） |

姿勢の実測（身長1.85m・skinny・`numberSide=+1`）:

| ポーズ | 結果 |
|---|---|
| 休め | 肩(0.12,1.42) → 肘(0.27,1.20) → 手のひら(0.51,0.86)。真下から35°外向き＝胴を外している |
| 両手上げ | 手のひら ±0.22, y=2.11（左右対称） |
| 腕を広げる | 手のひら ±0.78, y=1.19（左右対称） |
| 前方リーチ | 手が -Z（＝前方）へ出る |
| 歩行 | `hipL` を +0.5 振った側の足が -Z（前）へ出る |
| 着席 | root.y=-0.505 で股関節が座面 0.46 に乗る |

### 残課題（目視で詰めるもの）

1. **ブラウザでの目視確認が未了。** 色味・関節の隙間・服の突き抜け・影は数値では分からない。
2. **髪型は138種を選手データへ均等配分済み**（`identity.ts` の look 4つ目 = `hairNo`、
   1種あたり26〜27人）。3Dの髪型Noと、HUDの2D顔アイコンのカテゴリ(`style` 0..12)は**別物**なので、
   両者は一致しない。ヘッドバンド（アイコンの髪型4）のバンド自体は未実装。
3. **両手保持（`holdBallHands`）の手がボールを 0.25m ほど行き過ぎる。** FK（腕を目標方向へ向ける）
   なので、腕が 0.50m → 0.70m と長くなったぶん行き過ぎが増えた。肘の曲げ量の定数
   （`bend = clamp(1.2 - l*1.5, 0, 0.55)`）は 0.5m の腕に合わせた調整値。目視してから直すこと。
4. **利き手の左右が既存の規約どおり反転している。** 既存モデルは `numberSide=+1` のとき
   「+X が体の右」としているが、実際に +Z を向いた人体の右は +X・-Z を向いた人体の右は -X。
   既存コード（`shoot.ts` など）と揃えたので**シミュレーション上の矛盾はない**が、
   ボクセルの人体としては右利きが左手で放つ形になる。直すなら鏡映（`scaling.x = -1`）が要る
   ＝面の巻き方が反転するので、透け（`voxel/README.md` の警告）を目視で確認すること。
5. **描画量は 1cm 格子のまま。** 重ければ `objcts/player/voxel/tools/buildParts.mjs` を
   `VOX_SIZE=0.02` で焼き直せば三角形・メモリとも約1/4になる（objcts の共有データが粗くなる）。
6. **ボールは差し替えていない。** `objcts/ball` のメッシュは basketball-sim と同一（直径0.24m の球・
   同じ色）で、物理定数はもともと basketball-sim から移植したもの。見た目の変化がゼロな一方、
   発光演出（`flashBall`）の作り直しが要るため今回は触っていない。
