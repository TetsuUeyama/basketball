// 床のルーズボールを拾うモーションの実測: 所要時間(技術で短縮)と、しゃがみの深さ・
// 手とボールの位置を追う。
import "./stubs";
import { NullEngine, Scene, Vector3 } from "@babylonjs/core";
import { Game } from "../src/game";
import { Player } from "../src/objects/player/player";
import { buildCourt } from "../src/objects/court";
Player.HEADLESS = false;
import { clubTeam } from "../src/roster";
import { secureLoose } from "../src/core/looseball";

const engine = new NullEngine();
const scene = new Scene(engine);
const hoops = buildCourt(scene);
const game = new Game(scene);
(game as unknown as { attachHoops(h: unknown): void }).attachHoops(hoops);
clubTeam(0, 0); clubTeam(1, 1);
const g = game as unknown as { applyRoster(): void; reset(): void; update(dt: number): void };
g.applyRoster();
g.reset();

function nodeY(p: Player, bone: string): number {
  const n = p.vox!.rig.node(bone as never)!;
  n.computeWorldMatrix(true);
  return n.getAbsolutePosition().y;
}

// 床のボールを拾わせる。ballY=拾い始めの高さ。
function pickup(p: Player, ballY: number, trace: boolean): number {
  p.stand(); p.resetFacing();
  p.pos.set(0, 0, 0);
  p.scoopLoad = 0; p.pickupT = 0; p.coolT = 0; p.landT = 0;
  game.ball.pos.set(0.35, ballY, 0.2);
  game.ball.vel.setAll(0);
  game.ballMode = "loose";
  game.looseOff = p.team; game.looseIsRebound = false;
  secureLoose(game, p);
  const dur = p.pickupDur;
  if (trace) {
    console.log("  t     ボールY  しゃがみ  腰Y    手Y(L/R)");
    let t = 0;
    for (let i = 0; i < 40 && (p.pickupT > 0 || p.scoopLoad > 0.02); i++) {
      g.update(1 / 60); t += 1 / 60;
      p.root.computeWorldMatrix(true);
      if (i % 3 === 0) {
        console.log(`  ${t.toFixed(2)}  ${game.ball.pos.y.toFixed(3)}   ${p.scoopLoad.toFixed(2)}`
          + `      ${nodeY(p, "Hips").toFixed(2)}   肩${nodeY(p, "RightUpperArm").toFixed(2)} 肘${nodeY(p, "RightLowerArm").toFixed(2)} 手${nodeY(p, "RightHand").toFixed(2)}`);
      }
    }
  }
  return dur;
}

const p = game.roster[0][0];
console.log(`技術(handling)=${p.attr.handling} の選手が床(y=0.12)のボールを拾う:`);
pickup(p, 0.12, true);

console.log("\n技術 → 拾うのにかかる時間(秒)");
const base = p.attr.handling;
for (const h of [10, 30, 50, 70, 99]) {
  (p.attr as { handling: number }).handling = h;
  const low = pickup(p, 0.12, false);
  const mid = pickup(p, 0.85, false);
  console.log(`  技術 ${String(h).padStart(2)}:  床から ${low.toFixed(3)}s  /  腰の高さから ${mid.toFixed(3)}s`);
}
(p.attr as { handling: number }).handling = base;
void Vector3;

// 最深部の1フレームを詳細に(腕がボールの方を向いているか)
{
  const q = game.roster[0][1];
  (q.attr as { handling: number }).handling = 50;
  q.stand(); q.resetFacing(); q.pos.set(0, 0, 0);
  q.scoopLoad = 0; q.pickupT = 0; q.coolT = 0; q.landT = 0;
  game.ball.pos.set(0.30, 0.12, 0.25);
  game.ball.vel.setAll(0);
  game.ballMode = "loose"; game.looseOff = q.team; game.looseIsRebound = false;
  secureLoose(game, q);
  for (let i = 0; i < 14; i++) g.update(1 / 60);
  q.root.computeWorldMatrix(true);
  const w = (b: string): Vector3 => {
    const n = q.vox!.rig.node(b as never)!; n.computeWorldMatrix(true); return n.getAbsolutePosition();
  };
  const f = (v: Vector3) => `(${v.x.toFixed(2)},${v.y.toFixed(2)},${v.z.toFixed(2)})`;
  console.log(`\n[最深部] しゃがみ=${q.scoopLoad.toFixed(2)} yaw=${q.root.rotation.y.toFixed(2)}`
    + ` numberSide=${q.numberSide} ik(L/R)=${q.ikL}/${q.ikR} 両手=${q.grabTwoHand}`);
  console.log(`  ボール ${f(game.ball.pos)}`);
  console.log(`  右: 肩${f(w("RightUpperArm"))} 肘${f(w("RightLowerArm"))} 手${f(w("RightHand"))}`);
  console.log(`  左: 肩${f(w("LeftUpperArm"))} 肘${f(w("LeftLowerArm"))} 手${f(w("LeftHand"))}`);
}

// クリップ登録の確認と、クリップ自身が持つボール軌道の高さ
{
  const { motionClip, motionDuration, ballPosition, MOTION_NAMES } = await import("@objcts/player/motion/clip");
  const c = motionClip("pickup");
  console.log(`\nクリップ登録: ${c ? "あり" : "なし"} / 一覧 ${MOTION_NAMES.length}種`);
  if (c) {
    const q = game.roster[0][2];
    q.stand(); q.resetFacing(); q.pos.set(0, 0, 0); q.lastDt = 1 / 60;
    q.scoopLoad = 1; q.pickupDur = 1; q.clipName = "";
    console.log("  位相  ボールY(クリップ)  足Y");
    for (const ph of [0, 0.3, 0.45, 0.72, 1]) {
      q.pickupT = 1 - ph;
      for (let i = 0; i < 3; i++) q.sync();
      q.root.computeWorldMatrix(true);
      const bp = ballPosition(q.vox!.rig, c, ph * motionDuration(c));
      const nf = q.vox!.rig.node("LeftFoot" as never)!; nf.computeWorldMatrix(true);
      console.log(`  ${ph.toFixed(2)}   ${bp ? bp.y.toFixed(3) : "-"}             ${nf.getAbsolutePosition().y.toFixed(3)}`);
    }
  }
}
