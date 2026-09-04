// The desk cat's simulation: rabbits that hop, rest and flee; a cat that chases the pointer
// (or waits at the wall for it), hunts rabbits, corners and catches them. Pure functions
// over a `CatWorld` of mutable cells (the component's refs), reading the viewport from
// `globalThis` — so `tests/examples-native-cat-sim.test.ts` can drive it without a DOM.

export const RABBIT_COUNT = 4;
const POINTER_GRACE = 1800; // ms since the last pointer move that still counts as "you're driving"
const SCARE = 88; // cat within this many px of the hunted rabbit → it bolts
const RETARGET_MS = 5000; // how often the cat picks a fresh rabbit to hunt
export const FOLLOW = 44; // rest ring: park this far from the target
const START = 26; // only (re)start chasing once the target is this far past FOLLOW
export const CAT_W = 74; // on-screen sprite size (px)
export const CAT_H = 72;
export const RAB_W = 26;
export const RAB_H = 31;
const CORNER = 150; // a rabbit within this of BOTH a side and top/bottom wall is cornered
const CAPTURE = 50; // once cornered, the cat catches it at this range (just past its rest ring)

export interface Rabbit {
  x: number;
  y: number;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  hopStart: number;
  hopDur: number;
  restUntil: number;
  facing: number;
  hopping: boolean;
}

// ── Simulation ─────────────────────────────────────────────────────────────────

const vw = () => globalThis.innerWidth || 360;
const vh = () => globalThis.innerHeight || 640;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** The DOM surface the simulation writes: a transform, and (for the cat) run/nap classes. */
export interface SpriteEl {
  style: { transform: string };
  /** The rabbit's flip wrapper (an element with a `style`); typed loosely to accept a real DOM node. */
  firstElementChild?: unknown;
  classList?: { toggle(name: string, on: boolean): unknown };
}

/** A mutable cell (a React ref). */
export interface Cell<T> {
  current: T;
}

/** Everything one animation frame reads and writes. */
export interface CatWorld {
  /** Top-left of the cat sprite (a new object on `summon`, so read through the cell). */
  pos: Cell<{ x: number; y: number }>;
  facing: Cell<number>;
  /** Hysteresis: are we currently walking to the target? */
  chasing: Cell<boolean>;
  pointer: Cell<{ x: number; y: number }>;
  lastPointerMove: Cell<number>;
  rabbits: Cell<Rabbit[]>;
  rabbitEls: Cell<(SpriteEl | null)[]>;
  /** Index of the rabbit the cat is currently hunting. */
  hunt: Cell<number>;
  retargetAt: Cell<number>;
  /** Sitting at the wall, waiting for the mouse to come back. */
  waiting: Cell<boolean>;
  waitUntil: Cell<number>;
  speed: Cell<number>;
  napping: Cell<boolean>;
  ignoreMouse: Cell<boolean>;
  scorePoint: () => void;
}

export function seedRabbits(): Rabbit[] {
  const out: Rabbit[] = [];
  for (let i = 0; i < RABBIT_COUNT; i++) {
    const x = 40 + Math.random() * (vw() - 80);
    const y = 90 + Math.random() * (vh() - 180);
    out.push({
      x,
      y,
      fromX: x,
      fromY: y,
      toX: x,
      toY: y,
      hopStart: 0,
      hopDur: 1,
      restUntil: performance.now() + Math.random() * 1400,
      facing: 1,
      hopping: false,
    });
  }
  return out;
}

function startHop(
  r: Rabbit,
  tx: number,
  ty: number,
  now: number,
  dur: number,
): void {
  r.fromX = r.x;
  r.fromY = r.y;
  r.toX = clamp(tx, 24, vw() - 24);
  r.toY = clamp(ty, 80, vh() - 32);
  r.hopStart = now;
  r.hopDur = dur;
  r.hopping = true;
  if (Math.abs(r.toX - r.fromX) > 4) r.facing = r.toX < r.fromX ? -1 : 1;
}

/** Idle: a rabbit just mills — short, lazy hops. Only a chase makes it bolt. */
function idleHop(r: Rabbit, now: number): void {
  const a = Math.random() * Math.PI * 2;
  const rad = 26 + Math.random() * 60; // short
  startHop(
    r,
    r.x + Math.cos(a) * rad,
    r.y + Math.sin(a) * rad,
    now,
    420 + Math.random() * 220,
  );
}

function fleeHop(r: Rabbit, fromX: number, fromY: number, now: number): void {
  const a = Math.atan2(r.y - fromY, r.x - fromX) + (Math.random() - 0.5) * 0.7;
  const rad = 130 + Math.random() * 90; // long bolt
  startHop(
    r,
    r.x + Math.cos(a) * rad,
    r.y + Math.sin(a) * rad,
    now,
    300 + Math.random() * 140,
  );
}

/**
 * A caught rabbit respawns somewhere fresh, well inset from every wall so it
 * doesn't reappear already cornered.
 */
function respawn(r: Rabbit, now: number): void {
  const m = 110;
  r.x = m + Math.random() * Math.max(1, vw() - 2 * m);
  r.y = m + Math.random() * Math.max(1, vh() - 2 * m);
  r.fromX = r.toX = r.x;
  r.fromY = r.toY = r.y;
  r.hopping = false;
  r.restUntil = now + 500 + Math.random() * 900;
  r.facing = Math.random() < 0.5 ? -1 : 1;
}

/** A rabbit's pose mid-hop: arc height, vertical stretch, and the lean along its hop vector. */
interface HopPose {
  hopY: number;
  sy: number;
  /** Degrees: pitch up/down from the 2D hop vector. */
  lean: number;
}

/** Advance a hopping rabbit along its eased arc; lands it when the hop completes. */
function advanceHop(r: Rabbit, now: number): HopPose {
  const p = (now - r.hopStart) / r.hopDur;
  if (p >= 1) {
    r.x = r.toX;
    r.y = r.toY;
    r.hopping = false;
    r.restUntil = now + 1000 + Math.random() * 2400; // lazy pauses between idle hops
    return { hopY: 0, sy: 1, lean: 0 };
  }
  const e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2; // easeInOutQuad
  r.x = r.fromX + (r.toX - r.fromX) * e;
  r.y = r.fromY + (r.toY - r.fromY) * e;
  // Orient along the actual 2D hop vector: horizontal → facing (flip), vertical → a lean
  // (capped so it never goes fully upright/vertical), eased over the hop so it leans into
  // the leap and lands level.
  const vx = r.toX - r.fromX;
  const vy = r.toY - r.fromY;
  const pitch = Math.atan2(vy, Math.abs(vx) || 1) * (180 / Math.PI);
  return {
    hopY: Math.sin(p * Math.PI) * 24, // arc height
    sy: 1 + Math.sin(p * Math.PI) * 0.14, // stretch up mid-hop
    lean: clamp(pitch, -46, 46) * Math.sin(p * Math.PI),
  };
}

/** Rabbits: hop with an eased arc + squash, rest, repeat. */
export function stepRabbits(w: CatWorld, now: number): void {
  for (let i = 0; i < w.rabbits.current.length; i++) {
    const r = w.rabbits.current[i];
    let pose: HopPose = { hopY: 0, sy: 1, lean: 0 };
    if (r.hopping) pose = advanceHop(r, now);
    else if (now > r.restUntil) idleHop(r, now);
    const el = w.rabbitEls.current[i];
    if (!el) continue;
    el.style.transform = `translate3d(${r.x - RAB_W / 2}px, ${r.y - RAB_H - pose.hopY}px, 0)`;
    const fl = el.firstElementChild as
      | { style: { transform: string } }
      | null
      | undefined;
    if (fl) {
      fl.style.transform = `scaleX(${r.facing}) rotate(${pose.lean}deg) scaleY(${pose.sy})`;
    }
  }
}

/**
 * Pick what to chase: sit where the mouse left (waiting for it to return), else the
 * pointer while you're moving it, else hunt a rabbit. "Ignore mouse" mode → the
 * pointer and wall-waiting are skipped entirely, so the cat only ever hunts rabbits.
 */
function chaseTarget(
  w: CatWorld,
  catCx: number,
  catCy: number,
  now: number,
): { x: number; y: number } {
  if (w.napping.current) return { x: catCx, y: catCy }; // nap: stay put
  const heedMouse = !w.ignoreMouse.current;
  const waitingNow = heedMouse && w.waiting.current;
  const pointerActive = heedMouse &&
    now - w.lastPointerMove.current < POINTER_GRACE;
  // Waiting walks to where the mouse left the window, then sits.
  if (waitingNow || pointerActive) {
    return { x: w.pointer.current.x, y: w.pointer.current.y };
  }
  if (w.rabbits.current.length) return huntRabbit(w, catCx, catCy, now);
  return { x: catCx, y: catCy };
}

/**
 * Lock onto a rabbit for a while (re-pick the nearest on a timer) so the cat commits to
 * a hunt instead of flip-flopping between two rabbits. A rabbit trapped in a corner is
 * caught (a point for the cat; it respawns fresh elsewhere); one in the open bolts away
 * (staying > FOLLOW), so the cat keeps chasing without parking — a wild rabbit generally
 * out-runs it.
 */
function huntRabbit(
  w: CatWorld,
  catCx: number,
  catCy: number,
  now: number,
): { x: number; y: number } {
  const rabbits = w.rabbits.current;
  if (now > w.retargetAt.current) {
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < rabbits.length; i++) {
      const d = Math.hypot(rabbits[i].x - catCx, rabbits[i].y - catCy);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    w.hunt.current = best;
    w.retargetAt.current = now + RETARGET_MS;
  }
  const r = rabbits[w.hunt.current];
  const d = Math.hypot(r.x - catCx, r.y - catCy);
  const cornered = (r.x < CORNER || r.x > vw() - CORNER) &&
    (r.y < CORNER || r.y > vh() - CORNER);
  if (cornered && d < CAPTURE) {
    respawn(r, now);
    w.scorePoint();
    w.retargetAt.current = 0;
  } else if (!r.hopping && d < SCARE) {
    fleeHop(r, catCx, catCy, now);
  }
  return { x: r.x, y: r.y };
}

/**
 * Chase with start/stop hysteresis so it parks cleanly (no walking in place): start
 * only when the target pulls clearly away, stop the instant we're inside the rest ring.
 */
function updateChase(w: CatWorld, dist: number): boolean {
  if (w.napping.current) w.chasing.current = false;
  else if (w.chasing.current) {
    if (dist <= FOLLOW) w.chasing.current = false;
  } else if (dist > FOLLOW + START) w.chasing.current = true;
  return w.chasing.current;
}

/** Move the cat toward its target and write its transform + run/nap classes. */
export function stepCat(
  w: CatWorld,
  root: SpriteEl,
  flip: SpriteEl | null,
  now: number,
): void {
  const pos = w.pos.current;
  const catCx = pos.x + CAT_W / 2;
  const catCy = pos.y + CAT_H / 2;
  if (w.waiting.current && now >= w.waitUntil.current) {
    w.waiting.current = false; // waited long enough → go play
  }
  const target = chaseTarget(w, catCx, catCy, now);
  const dx = target.x - catCx;
  const dy = target.y - catCy;
  const dist = Math.hypot(dx, dy) || 1;
  const running = updateChase(w, dist);
  if (running) {
    const step = Math.min(w.speed.current, dist - FOLLOW);
    pos.x += (dx / dist) * step;
    pos.y += (dy / dist) * step;
    if (Math.abs(dx) > 8) w.facing.current = dx < 0 ? -1 : 1;
  }
  // Collision with the window edges: keep the cat fully on-screen so it presses up
  // against the wall instead of wandering out of view.
  pos.x = clamp(pos.x, -6, vw() - CAT_W + 6);
  pos.y = clamp(pos.y, -6, vh() - CAT_H + 6);
  root.style.transform = `translate3d(${pos.x}px, ${pos.y}px, 0)`;
  if (flip) flip.style.transform = `scaleX(${w.facing.current})`;
  root.classList?.toggle("run", running);
  root.classList?.toggle("nap", w.napping.current);
}
