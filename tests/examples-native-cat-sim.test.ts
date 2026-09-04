// The native example's desk-cat simulation (examples/native/app/cat-sim.ts): rabbits hop
// and rest, the cat chases the pointer with start/stop hysteresis, waits at the wall, naps,
// hunts the nearest rabbit, and catches one that is cornered — driven with plain cells and
// stub sprites, no DOM.

import { assert, assertEquals } from "@std/assert";
import {
  CAT_H,
  CAT_W,
  type CatWorld,
  type Cell,
  FOLLOW,
  RABBIT_COUNT,
  seedRabbits,
  type SpriteEl,
  stepCat,
  stepRabbits,
} from "../examples/native/app/cat-sim.ts";

// deno-lint-ignore no-explicit-any
const g = globalThis as any;
g.innerWidth = 1000;
g.innerHeight = 800;

const cell = <T>(current: T): Cell<T> => ({ current });

function sprite(): SpriteEl & { classes: Record<string, boolean> } {
  const classes: Record<string, boolean> = {};
  return {
    style: { transform: "" },
    firstElementChild: { style: { transform: "" } },
    classList: {
      toggle(name, on) {
        classes[name] = on;
      },
    },
    classes,
  };
}

function world(): CatWorld & { points: number } {
  const w = {
    pos: cell({ x: 500, y: 400 }),
    facing: cell(1),
    chasing: cell(false),
    pointer: cell({ x: 500, y: 400 }),
    lastPointerMove: cell(-1e9), // no recent pointer activity unless a test says so
    rabbits: cell(seedRabbits()),
    rabbitEls: cell(Array.from({ length: RABBIT_COUNT }, () => sprite())),
    hunt: cell(0),
    retargetAt: cell(0),
    waiting: cell(false),
    waitUntil: cell(0),
    speed: cell(6),
    napping: cell(false),
    ignoreMouse: cell(false),
    points: 0,
    scorePoint: () => {
      w.points++;
    },
  };
  return w;
}

Deno.test("rabbits seed inside the viewport, rest, then hop and get a transform", () => {
  const w = world();
  assertEquals(w.rabbits.current.length, RABBIT_COUNT);
  for (const r of w.rabbits.current) {
    assert(r.x > 0 && r.x < 1000 && r.y > 0 && r.y < 800);
    assert(!r.hopping);
  }
  const start = performance.now();
  stepRabbits(w, start + 5000); // past every restUntil → each rabbit starts a hop
  assert(w.rabbits.current.every((r) => r.hopping));
  stepRabbits(w, start + 5100); // mid-hop: positioned along the eased arc
  const el = w.rabbitEls.current[0]!;
  assert(el.style.transform.startsWith("translate3d("));
  const flip = el.firstElementChild as { style: { transform: string } };
  assert(flip.style.transform.includes("rotate("));
  stepRabbits(w, start + 9000); // landed
  assert(w.rabbits.current.every((r) => !r.hopping));
});

Deno.test("the cat runs to a freshly moved pointer and parks inside its rest ring", () => {
  const w = world();
  const root = sprite();
  const now = performance.now();
  w.pointer.current = { x: 900, y: 400 };
  w.lastPointerMove.current = now;
  stepCat(w, root, null, now);
  assert(w.chasing.current, "target well past FOLLOW+START → chasing");
  assertEquals(root.classes.run, true);
  assertEquals(w.facing.current, 1);
  const x0 = w.pos.current.x;
  for (let i = 0; i < 200; i++) stepCat(w, root, null, now);
  assert(w.pos.current.x > x0, "moved toward the pointer");
  const dist = Math.hypot(900 - (w.pos.current.x + CAT_W / 2), 400 - (w.pos.current.y + CAT_H / 2));
  assert(dist <= FOLLOW + 0.01 && dist > 0, `parked at the rest ring (${dist})`);
  assert(root.style.transform.startsWith("translate3d("));
  // Once the target is inside the ring the chase stops (and restarts only past START).
  w.pointer.current = { x: w.pos.current.x + CAT_W / 2 + 10, y: w.pos.current.y + CAT_H / 2 };
  stepCat(w, root, null, now);
  assert(!w.chasing.current, "stops inside the rest ring");
  assertEquals(root.classes.run, false);
});

Deno.test("napping freezes the cat; ignore-mouse skips the pointer; the cat stays on-screen", () => {
  const w = world();
  const root = sprite();
  const now = performance.now();
  w.pointer.current = { x: 900, y: 400 };
  w.lastPointerMove.current = now;
  w.napping.current = true;
  const before = { ...w.pos.current };
  stepCat(w, root, null, now);
  assertEquals(w.pos.current, before);
  assertEquals(root.classes.nap, true);
  w.napping.current = false;
  w.ignoreMouse.current = true;
  w.rabbits.current = []; // nothing to hunt either → stays put
  stepCat(w, root, null, now);
  assertEquals(w.pos.current, before);
  // Pinned past the right edge, the clamp pulls it back on-screen.
  w.pos.current = { x: 5000, y: 5000 };
  stepCat(w, root, null, now);
  assertEquals(w.pos.current, { x: 1000 - CAT_W + 6, y: 800 - CAT_H + 6 });
});

Deno.test("waiting at the wall ends after the timeout; then the cat hunts the nearest rabbit", () => {
  const w = world();
  const root = sprite();
  const now = performance.now();
  w.waiting.current = true;
  w.waitUntil.current = now - 1; // already waited long enough
  w.rabbits.current = [
    {
      x: 100,
      y: 100,
      fromX: 100,
      fromY: 100,
      toX: 100,
      toY: 100,
      hopStart: 0,
      hopDur: 1,
      restUntil: now + 1e6,
      facing: 1,
      hopping: false,
    },
    {
      x: 520,
      y: 420,
      fromX: 520,
      fromY: 420,
      toX: 520,
      toY: 420,
      hopStart: 0,
      hopDur: 1,
      restUntil: now + 1e6,
      facing: 1,
      hopping: false,
    },
  ];
  stepCat(w, root, null, now);
  assertEquals(w.waiting.current, false);
  assertEquals(w.hunt.current, 1, "locked onto the nearest rabbit");
  assert(w.rabbits.current[1].hopping, "a rabbit in the open bolts when the cat is close");
});

Deno.test("a cornered rabbit within capture range is caught, scored and respawned inset", () => {
  const w = world();
  const root = sprite();
  const now = performance.now();
  w.pos.current = { x: 30 - CAT_W / 2, y: 30 - CAT_H / 2 }; // cat centered at (30, 30)
  w.rabbits.current = [
    {
      x: 40,
      y: 40,
      fromX: 40,
      fromY: 40,
      toX: 40,
      toY: 40,
      hopStart: 0,
      hopDur: 1,
      restUntil: now + 1e6,
      facing: 1,
      hopping: false,
    },
  ];
  stepCat(w, root, null, now);
  assertEquals(w.points, 1);
  const r = w.rabbits.current[0];
  assert(r.x >= 110 && r.x <= 890 && r.y >= 110 && r.y <= 690, "respawned well inside the walls");
  assertEquals(w.retargetAt.current, 0, "re-picks a target next frame");
});
