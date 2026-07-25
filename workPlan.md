# workPlan.md — basketball-sim

## Project Goal

Babylon.js 製フルコート 5対5 の**観戦バスケットボールシミュレーション**。
剛体物理を使わず全て決定論的なコード制御で、**選手の能力値とチーム戦術が試合展開・スタッツに
目に見えて反映される「見て楽しい」試合**を作る。ユーザー操作は不要（観戦専用）。

- 前身 `basketball-game` は Havok 物理でボールが暴れた反省から、物理エンジン不使用が大前提。
- soccer-sim と同系統の作り（状態機械 + 軌道計算 + DOMオーバーレイUI）。

## 現状（実装済み / commit `3347268` 時点）

### コアシミュレーション（src/game.ts, 1837行）
- 状態機械: オフェンス判断（ドライブ/パス/シュート/ポストアップ）、マンツーマンディフェンス
- ティップオフ、クォーター制、ハーフタイムでのコートチェンジ、ショットクロック、センターイン
- シュート: 距離+密着度から成功確率を事前抽選 → 軌道アニメ。ブロック（swat）、コンテストジャンプ
- ファウル → フリースロー（並び・複数投）、サイドインバウンド
- スティール → ルーズボール（最寄り数人だけが争奪、他は次のプレーへ展開）
- リバウンド（距離+守備側ボーナスの重み付き抽選）、アシスト判定
- 筋力ベースの接触/押し合い（holdWeight）、守備のクッション距離（ポストのみタイト）

### 能力値・戦術（src/attributes.ts）— 2026-07-05 全面刷新
- **ユーザー指定の25項目スキーマ**（0..100）+ 身長(m)。全項目が game.ts に配線済み:
  - 攻判断(オフェンス)/守判断(ディフェンス)/バランス/スタミナ/速度/加速/反応/敏捷
  - D精度/D速度/P精度/P速度/L精度/L距離(L速度)/S精度/S威力/S技術/FK/カーブ/ヘッド/ジャンプ
  - 技術/攻撃性/精神/連携
- 新システム: **疲労**（effort比例ドレイン、スタミナで軽減、デッドボールで回復、速度-20%/精度低下）、
  **加速モデル**（実測速度からのランプアップ、加速力でm/s²可変）、**クラッチ**（劣勢/4Q終盤接戦/疲労
  ×精神耐性で精度低下）、**バンク角度ボーナス**（カーブ）、**連携による戦術遂行度**（戦術項の重み0.35..1）
- チーム戦術 `TACTICS`（pace/threeBias/driveBias/ballMovement + pressure/help）→ 個人の連携で重み付け
- ポジション別オフェンス比重（roleOffense）+ 個人優先度（priority、エディタで上書き可）
- **特殊能力21種**（持つ/持たないのブール、`PlayerDef.abilities`）: ドリブラー/ドリブルキープ/
  ポジショニング/飛び出し/司令塔/スルーパス/ストライカー/1対1シュート/ポスト/ラインポジ/ミドル/
  サイド/センター/PKキッカー/ダイレクトプレイ/アウトサイド/マンマーク/スライディング/カバーリング/
  DFライン/ロング。エディタの選手行下にトグルチップ。デフォルト全員なし。
- **13人ロスター（先発5+ベンチ8）と自動交代**: デッドボール時に疲労・低貢献・Q4ブローアウトで
  ベンチと交代（ポジション適合/鮮度/総合力で選出、再出場可）。ベンチはコート脇で高速回復。
  リザルトに全13人+MIN列。名前タグ下にスタミナゲージ。
- 詳細な配線対応表（能力値・特殊能力とも）は work-record.md 2026-07-05 参照

### UI（src/ui.ts）
- 試合前ロスターエディタ（名前/身長/ポジション/能力値バー/優先度、ツールチップ付き）
- スコアボード、再生速度 1x/2x/4x、RESTART
- リザルト画面: 選手別ボックススコア（PTS/REB/AST/STL/BLK/TO）
- レスポンシブ（モバイルはテーブル横スクロール）

## ⚠️ 既知の未完了・要注意

1. **ROSTER がテスト用の極端値のまま**（attributes.ts の NOTE 明記）
   - BLAZE(RED) = 全能力10・全員1.85m / WAVE(BLUE) = 全能力99・全員2.10m
   - 能力値の効果確認用セットアップ。**現実的な値への再調整が必須**。
2. README の「構成」「選手パラメータ」節が古い。
3. 実機（WebGL, `npm run dev`）での見た目・バランスの playtest 調整。
   headless harness でロジックは実測済みだが、**見た目・演出は未検証**（soccer-sim と同じ注意）。
4. バランス調整ノブ（headless実測で判明）: 疲労ドレイン `(0.002+effort*0.012)*(1.3-stamina)`
   は極端値でRED飽和（peak 1.0）。現実ロスターで再計測要。カーブ/バンクは精度ボーナスのみで
   軌道演出（ボード反射）は未実装。

## フェーズ計画

### Phase 2 — 現実的ロスターと playtest（次にやる）
- [ ] ROSTER を現実的な値に再調整（ポジションらしい分布、チーム間は個性差レベル）
- [ ] headless harness（scratchpad に作成済み、手順は work-record.md）でスタッツ分布を再計測
- [ ] `npm run dev` playtest でスコアレンジ・見た目（加速・疲労の挙動）確認

### Phase 3 — 戦術の拡張
- [ ] 戦術（TACTICS）を試合前エディタで編集可能に
- [ ] pace（時間の使い方/速攻）の効果検証、必要なら速攻ロジック強化

### Phase 4 — 見た目・演出（任意）
- [ ] バンクシュートのボード反射軌道（現状は精度ボーナスのみ）
- [ ] 選手モデル/モーションの強化（soccer-sim の腕・体の向きの知見を流用可）
- [ ] リプレイ・ハイライト演出

## game.ts 分割計画（レイヤード・ドメイン設計 / 2026-07-22 着手）

`src/game.ts`（約6700行・単一 `class Game`・フィールド114個）を機能別に段階分割する。
公開API（`update`/`reset`/`applyRoster`/`syncVisuals` と `score`/`state`/`players`/`ball`/`lastEvent` 等、
ui.ts / main.ts が参照）は維持する。

### 目標アーキテクチャ（層 / 2026-07-25 ユーザー合意で改訂・実装済み）
```
src/
  ai/          試合中の判断を集約。offense(ハンドラー判断)/defense(マン守備)/
               defense-schemes(ゾーン・プレス)/offball(オフボール)/reads(状況の読み)/
               lineups(先発・適格のコーチング判断)
  animation/   アニメ。basic=部位の定義と基本ルール(joints/rotate/arms/torso/legs)、
               action=アクション毎(locomotion/dribble/hold/reach/guard/sit)、
               reaction=リアクション毎(foul-react/defwin/dejected/bench-idle)
  move/        ムーブ実行。basic=移動物理(run/jump/turn)+ボール挙動ベース(ball)、
               action=シュート/パス/liveball(held統合tick)、
               reaction=判定ルール(shot-outcome/contest-block/pass-risk/foul/rebound)
  data/        生成データ（club/ 実クラブ、player-data/ 選手DB4015人）
  objects/     実体（Player/Ball/court/materials）
  core/        共有状態を操作する手続き（collision/looseball/deadball/gameflow/poses/visuals/bench）
  systems/     状態を持つ機能クラス（FT/tipoff/inbound/screen/subs）
  eval.ts      層をまたぐ純粋な評価プリミティブ
```
- ai/ 未集約の判断（今後の移設候補）: passing.chooseReceiver（受け手選択）、subs の
  subDesire/planSubs（交代判断、実行と同居）、game.ts の steerAround/pickSide/
  setDriveSide/crashBoards/formationSpots（Phase 3〜4 の状態集約と同時に）。
設計の肝: (1) アニメは選手オブジェクトに残し、発動と効果を分離。(2) 114フィールドは `core/game-state.ts`
に集約し各層へ渡す（層分けと直交する土台）。

### 移行順（都度 tsc＋vite build＋ヘッドレスで挙動不変を確認）
- [x] Phase 0: 現状コミット（fe0cafc）
- [ ] Phase 1: 純粋な評価プリミティブを `eval.ts` へ（着手中）:
      rimProtect / perimContest / palmRadius / twWeight / reactionLag /
      shootRangeOf / gatherFor / deepThreeOK / effShootRange / shotWindupFor / wontLoadUp
- [ ] Phase 2a: `resolution/`（効果）を純粋な確率計算から抽出（shot make% / block / intercept / foul）
- [ ] Phase 2b: 独立性の高いステートフル機能を移設（交代/ベンチ → FT → スクリーン → インバウンド/ティップ → ポーズ）
- [ ] Phase 3: `core/game-state.ts` に状態集約 → cognition/tactics を関数モジュール化
- [ ] Phase 4: 中核の密結合（decide/runDefense/loose/update ループ）を最後に整理

## 設計上の前提（変更しないこと）

- **物理エンジン不使用**。ボールは軌道計算のみ。
- 座標系: X=幅 / Z=長さ / Y=上。Team0 → +Z 攻め、Team1 → -Z 攻め（config.ts 冒頭に明記）。
  手続きメッシュのみでインポートモデル無し = グローバルrule6のforward/回転懸念は対象外。
- パラメータは `src/config.ts` に集約、能力値/戦術は `src/attributes.ts` に集約。
- 高速再生はメインループの整数サブステップで実現（dt を大きくしない）。

## バランス検証の手段

- 頻度・スタッツ分布の検証は headless sim harness（中央メモリ
  `reference_headless_sim_harness.md`）の方式が使える可能性あり（Babylonスタブ + esbuild alias で
  GPU 無し Node 実測）。見た目の検証はブラウザ実機のみ。
