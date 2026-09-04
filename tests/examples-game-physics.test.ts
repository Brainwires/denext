// The game example's pure simulation (examples/game/app/physics.ts): walking, jumping and
// landing, ladders, barrel spawning/rolling/despawning, scoring, lives and the win check —
// driven directly with stub sound + meshes, no WebGL.

import { assert, assertEquals } from "@std/assert";
import {
  BARREL_LIFE,
  type BarrelMesh,
  createWorld,
  type GameState,
  GOAL_X,
  JUMP_V,
  ladderAt,
  LADDERS,
  linkLadders,
  MAX_BARRELS,
  PLATFORMS,
  platformUnder,
  ROLL,
  spawnBarrel,
  startRun,
  step,
  surfaceY,
  type World,
} from "../examples/game/app/physics.ts";

linkLadders();

function stubMesh(): BarrelMesh & { at: number[] } {
  const mesh = {
    visible: false,
    at: [] as number[],
    position: {
      set(x: number, y: number) {
        mesh.at = [x, y];
      },
    },
    rotation: { z: 0 },
  };
  return mesh;
}

function world(): World & { log: string[]; states: GameState[]; livesSeen: number[] } {
  const log: string[] = [];
  const states: GameState[] = [];
  const livesSeen: number[] = [];
  const fx = (name: string) => () => log.push(name);
  const w = createWorld(
    {
      roll: fx("roll"),
      climb: fx("climb"),
      jump: fx("jump"),
      land: fx("land"),
      point: fx("point"),
      hit: fx("hit"),
      lose: fx("lose"),
      win: fx("win"),
    },
    { onScore: () => {}, onLives: (n) => livesSeen.push(n), onState: (s) => states.push(s) },
    stubMesh,
  );
  return Object.assign(w, { log, states, livesSeen });
}

/** Advance `seconds` in 1/120 s steps (the engine's fixed step). */
function run(w: World, seconds: number): void {
  for (let t = 0; t < seconds; t += 1 / 120) step(w, 1 / 120);
}

Deno.test("level geometry: surfaces, platform lookup and ladders", () => {
  const ground = PLATFORMS[0];
  assertEquals(surfaceY(ground, 3), 1);
  assertEquals(platformUnder(0, 1.0), ground, "standing on the ground");
  assertEquals(platformUnder(0, 4), null, "mid-air");
  // The higher of two overlapping beams wins.
  assertEquals(platformUnder(0, surfaceY(PLATFORMS[1], 0)), PLATFORMS[1]);
  const l = LADDERS[0];
  assert(l.yTop > l.yBot, "ladder spans were linked from the platforms");
  assertEquals(ladderAt(l.x, l.yBot + 0.5), l);
  assertEquals(ladderAt(l.x + 2, l.yBot + 0.5), null);
});

Deno.test("startRun resets the run; walking moves and faces; the level clamps x", () => {
  const w = world();
  startRun(w);
  assertEquals(w.state, "playing");
  assertEquals(w.states, ["playing"]);
  assertEquals([w.hero.pos.x, w.hero.pos.y], [-9, 1]);
  w.invuln = 0;
  w.input.right = true;
  run(w, 0.5);
  assert(w.hero.pos.x > -9, "walked right");
  assertEquals(w.hero.facing, 1);
  assert(w.hero.onGround);
  w.input.right = false;
  w.input.left = true;
  run(w, 3);
  assertEquals(w.hero.facing, -1);
  assertEquals(w.hero.pos.x, -11.5, "clamped at the left edge");
});

Deno.test("a jump fires once per press, arcs, and lands back on the beam", () => {
  const w = world();
  startRun(w);
  w.input.jump = true;
  step(w, 1 / 120);
  assertEquals(w.hero.vel.y, JUMP_V - 42 / 120);
  assert(!w.hero.onGround);
  assert(w.log.includes("jump"));
  run(w, 0.3);
  assert(w.hero.pos.y > 1.5, "airborne");
  run(w, 1);
  assert(w.hero.onGround, "landed");
  assertEquals(w.hero.pos.y, 1);
  assertEquals(w.log.filter((s) => s === "jump").length, 1, "held jump does not re-fire");
});

Deno.test("climbing a ladder carries the hero to the beam above", () => {
  const w = world();
  startRun(w);
  const l = LADDERS[0];
  w.hero.pos.x = l.x;
  w.input.up = true;
  step(w, 1 / 120);
  assertEquals(w.hero.onLadder, l);
  run(w, 3);
  assertEquals(w.hero.onLadder, null, "stepped off at the top");
  assertEquals(w.hero.pos.y, l.yTop);
  assert(w.hero.onGround);
});

Deno.test("barrels spawn on a cadence up to the cap, roll off the ape's beam, and despawn", () => {
  const w = world();
  startRun(w);
  w.hero.pos.x = 11; // out of the way
  run(w, 1.3);
  assertEquals(w.barrels.filter((b) => b.alive).length, 1, "first barrel after the initial timer");
  const b = w.barrels[0];
  assert(b.x > -8, "rolled right from the ape");
  assertEquals(b.mesh.visible, true);
  assertEquals(b.vx > 0 && b.vx <= ROLL, true);
  b.age = BARREL_LIFE + 1;
  step(w, 1 / 120);
  assertEquals(b.alive, false);
  assertEquals(b.mesh.visible, false);
  for (let i = 0; i < MAX_BARRELS + 3; i++) spawnBarrel(w);
  assertEquals(w.barrels.length, MAX_BARRELS + 3, "spawnBarrel itself is uncapped; the cadence is");
});

Deno.test("clearing a barrel scores; touching one costs a life; three hits lose the run", () => {
  const w = world();
  startRun(w);
  w.invuln = 0;
  w.spawnTimer = 1e9; // no automatic spawns
  spawnBarrel(w);
  const b = w.barrels[0];
  // Hero airborne just above the barrel → cleared.
  w.hero.onGround = false;
  w.hero.pos.x = b.x;
  w.hero.pos.y = b.y + 2;
  w.hero.vel.y = 0;
  step(w, 1 / 120);
  assertEquals(w.score, 100);
  assert(w.log.includes("point"));
  // Now put the hero on the barrel → hit, life lost, hero reset with invulnerability.
  w.hero.pos.x = b.x;
  w.hero.pos.y = b.y;
  step(w, 1 / 120);
  assertEquals(w.lives, 2);
  assertEquals(w.livesSeen.at(-1), 2);
  assert(w.invuln > 0);
  w.lives = 1;
  w.invuln = 0;
  w.hero.pos.x = b.x;
  w.hero.pos.y = b.y;
  step(w, 1 / 120);
  assertEquals(w.state, "lost");
  assert(w.log.includes("lose"));
});

Deno.test("falling off the level costs a life; reaching the cat wins", () => {
  const w = world();
  startRun(w);
  w.invuln = 0;
  w.hero.pos.y = -3;
  step(w, 1 / 120);
  assertEquals(w.lives, 2);
  w.invuln = 0;
  w.hero.pos.x = GOAL_X;
  w.hero.pos.y = surfaceY(PLATFORMS[5], GOAL_X);
  w.hero.vel.y = 0;
  step(w, 1 / 120);
  assertEquals(w.state, "won");
  assertEquals(w.score, 1000);
  step(w, 1 / 120); // a finished run no longer simulates
  assertEquals(w.score, 1000);
});
