// Rivet Rumble — the pure simulation: level geometry, hero and barrel physics, scoring and
// lives. No Three.js and no DOM in here: `engine.ts` drives it from the render loop and
// mirrors the state into meshes, and `tests/examples-game-physics.test.ts` drives it directly.
//
// Coordinates: world units, y up. Platforms are sloped girders (`surfaceY(p, x)` gives the
// walking surface at x); ladders connect consecutive platforms.

export type GameState = "ready" | "playing" | "won" | "lost";
export type InputKey = "left" | "right" | "up" | "down" | "jump";

export interface GameCallbacks {
  onScore: (n: number) => void;
  onLives: (n: number) => void;
  onState: (s: GameState) => void;
}

// ── Level: girders (sloped platforms) + ladders, bottom → top ────────────────
export interface Platform {
  left: number;
  right: number;
  y: number;
  slope: number;
}
export interface Ladder {
  x: number;
  yBot: number;
  yTop: number;
}
// Beams are STAGGERED: each one extends under the low-end drop point of the beam
// above it, so a barrel rolling off an edge lands on the beam directly below and
// only ever falls ONE row. Rows alternate which side they overhang; slopes
// alternate so the barrels zig-zag down.
export const PLATFORMS: Platform[] = [
  { left: -12, right: 12, y: 1.0, slope: 0 }, // ground (full width)
  { left: -10, right: 6, y: 5.5, slope: -0.08 }, // A: rolls right → drops at +6
  { left: -6, right: 10, y: 9.5, slope: 0.08 }, // B: rolls left  → drops at -6
  { left: -10, right: 6, y: 13.5, slope: -0.08 }, // C: rolls right → drops at +6
  { left: -6, right: 10, y: 17.5, slope: 0.08 }, // D: rolls left  → drops at -6
  { left: -10, right: 6, y: 21.5, slope: -0.06 }, // top: rolls right → drops at +6
];
export const cx = (p: Platform) => (p.left + p.right) / 2;
export const surfaceY = (p: Platform, x: number) => p.y + p.slope * (x - cx(p));
const onSpan = (p: Platform, x: number) => x >= p.left && x <= p.right;

// Ladders sit where consecutive beams overlap. The hero climbs them; barrels may
// (randomly) take one down too.
export const LADDERS: Ladder[] = [
  { x: -8, yBot: 0, yTop: 1 }, // G→A
  { x: 4, yBot: 0, yTop: 1 }, // A→B
  { x: -4, yBot: 0, yTop: 1 }, // B→C
  { x: 4, yBot: 0, yTop: 1 }, // C→D
  { x: 3, yBot: 0, yTop: 1 }, // D→T (arrive top, walk right to the cat)
];

const G = 42; // gravity
const MOVE = 5.2;
const CLIMB = 4.2;
export const JUMP_V = 12.2;
const HERO_H = 1.5;
const HERO_R = 0.55;
export const BARREL_R = 0.6;
export const ROLL = 4.6;
export const MAX_BARRELS = 8; // hard cap on concurrent barrels (perf + fairness)
export const BARREL_LIFE = 16; // seconds before a barrel despawns no matter what
export const GOAL_X = 5;
export const APE_X = -8;

/** Fill ladder spans from the platforms they connect. */
export function linkLadders(): void {
  for (let i = 0; i < LADDERS.length; i++) {
    LADDERS[i].yBot = surfaceY(PLATFORMS[i], LADDERS[i].x);
    LADDERS[i].yTop = surfaceY(PLATFORMS[i + 1], LADDERS[i].x);
  }
}

// ── World state ───────────────────────────────────────────────────────────────

/** The part of a Three.js mesh the simulation touches (so a test can pass a stub). */
export interface BarrelMesh {
  visible: boolean;
  position: { set(x: number, y: number, z: number): unknown };
  rotation: { z: number };
}

export interface Barrel {
  mesh: BarrelMesh;
  x: number;
  y: number;
  vx: number;
  vy: number;
  alive: boolean;
  scored: boolean;
  descend: Ladder | null; // non-null while taking a ladder down
  noLadder: number; // cooldown before it may grab another ladder
  age: number; // seconds alive (despawn safety)
}

export interface Hero {
  pos: { x: number; y: number };
  vel: { x: number; y: number };
  onGround: boolean;
  onLadder: Ladder | null;
  facing: number;
  walkPhase: number;
  jumpLatch: boolean;
}

/** The sound effects the simulation triggers (the `Sound` class satisfies this). */
export interface SoundFx {
  roll(): void;
  climb(): void;
  jump(): void;
  land(): void;
  point(): void;
  hit(): void;
  lose(): void;
  win(): void;
}

/** Everything the physics step reads and writes. */
export interface World {
  sound: SoundFx;
  cb: GameCallbacks;
  /** Make the mesh for a new barrel (the engine adds it to the scene). */
  newBarrelMesh: () => BarrelMesh;
  hero: Hero;
  input: Record<InputKey, boolean>;
  barrels: Barrel[];
  state: GameState;
  score: number;
  lives: number;
  spawnTimer: number;
  apeThrow: number; // seconds the ape keeps its arms up after a throw
  invuln: number; // seconds of post-hit invulnerability
}

export function createWorld(
  sound: SoundFx,
  cb: GameCallbacks,
  newBarrelMesh: () => BarrelMesh,
): World {
  return {
    sound,
    cb,
    newBarrelMesh,
    hero: {
      pos: { x: 0, y: 0 },
      vel: { x: 0, y: 0 },
      onGround: false,
      onLadder: null,
      facing: 1,
      walkPhase: 0,
      jumpLatch: false,
    },
    input: { left: false, right: false, up: false, down: false, jump: false },
    barrels: [],
    state: "ready",
    score: 0,
    lives: 3,
    spawnTimer: 0,
    apeThrow: 0,
    invuln: 0,
  };
}

function setState(w: World, s: GameState): void {
  w.state = s;
  w.cb.onState(s);
}

function addScore(w: World, points: number): void {
  w.score += points;
  w.cb.onScore(w.score);
}

function resetHero(w: World): void {
  const h = w.hero;
  h.pos.x = -9;
  h.pos.y = surfaceY(PLATFORMS[0], -9);
  h.vel.x = h.vel.y = 0;
  h.onGround = true;
  h.onLadder = null;
  w.invuln = 1.0;
}

/** Begin a run: fresh score/lives, no barrels, hero at the bottom-left. */
export function startRun(w: World): void {
  w.score = 0;
  w.lives = 3;
  w.cb.onScore(0);
  w.cb.onLives(3);
  for (const b of w.barrels) {
    b.alive = false;
    b.mesh.visible = false;
  }
  w.spawnTimer = 1.2;
  resetHero(w);
  setState(w, "playing");
}

/** Roll a new barrel from the ape (reusing a dead one from the pool when possible). */
export function spawnBarrel(w: World): void {
  let b = w.barrels.find((k) => !k.alive);
  if (!b) {
    b = {
      mesh: w.newBarrelMesh(),
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      alive: false,
      scored: false,
      descend: null,
      noLadder: 0,
      age: 0,
    };
    w.barrels.push(b);
  }
  b.x = APE_X;
  b.y = surfaceY(PLATFORMS[5], APE_X) + BARREL_R;
  b.vx = ROLL;
  b.vy = 0;
  b.alive = true;
  b.scored = false;
  b.descend = null;
  b.noLadder = 0.6;
  b.age = 0;
  b.mesh.visible = true;
  w.apeThrow = 0.35;
  w.sound.roll();
}

function loseLife(w: World): void {
  if (w.invuln > 0 || w.state !== "playing") return;
  w.lives -= 1;
  w.cb.onLives(w.lives);
  w.sound.hit();
  if (w.lives <= 0) {
    w.sound.lose();
    setState(w, "lost");
  } else {
    resetHero(w);
  }
}

// ── Physics step (fixed dt) ───────────────────────────────────────────────────

/** The highest platform whose surface is within reach of (x, y), or null. */
export function platformUnder(x: number, y: number): Platform | null {
  let best: Platform | null = null;
  for (const p of PLATFORMS) {
    if (!onSpan(p, x) || !nearSurface(p, x, y)) continue;
    if (!best || surfaceY(p, x) > surfaceY(best, x)) best = p;
  }
  return best;
}

/** Within 0.35 below or 0.6 above the platform's surface at x. */
function nearSurface(p: Platform, x: number, y: number): boolean {
  const sy = surfaceY(p, x);
  return y >= sy - 0.35 && y <= sy + 0.6;
}

export function ladderAt(x: number, y: number): Ladder | null {
  return LADDERS.find((l) => Math.abs(x - l.x) < 0.6 && y > l.yBot - 0.3 && y < l.yTop + 0.4) ??
    null;
}

/** Advance the simulation by `dt` seconds (a no-op unless a run is in progress). */
export function step(w: World, dt: number): void {
  if (w.state !== "playing") return;
  tickTimers(w, dt);
  spawnOnCadence(w, dt);
  stepHero(w, dt);
  for (const b of w.barrels) {
    if (b.alive) stepBarrel(w, b, dt);
  }
  checkWin(w);
}

function tickTimers(w: World, dt: number): void {
  w.invuln = Math.max(0, w.invuln - dt);
  w.apeThrow = Math.max(0, w.apeThrow - dt);
}

/** Spawn barrels on a cadence that tightens with score. */
function spawnOnCadence(w: World, dt: number): void {
  w.spawnTimer -= dt;
  if (w.spawnTimer > 0) return;
  const liveCount = w.barrels.filter((k) => k.alive).length;
  if (liveCount < MAX_BARRELS) spawnBarrel(w);
  w.spawnTimer = Math.max(1.3, 2.6 - w.score / 5000);
}

function stepHero(w: World, dt: number): void {
  const h = w.hero;
  const climbing = ladderAt(h.pos.x, h.pos.y);
  if (climbing && (w.input.up || w.input.down)) climbStep(w, climbing, dt);
  else walkStep(w, dt);
  h.pos.x = Math.max(-11.5, Math.min(11.5, h.pos.x));
  if (h.pos.y < -2) loseLife(w);
}

/** On a ladder: snap to the rail and move vertically; step off at either end. */
function climbStep(w: World, ladder: Ladder, dt: number): void {
  const h = w.hero;
  h.onLadder = ladder;
  h.pos.x += (ladder.x - h.pos.x) * 0.4; // snap to rail
  h.vel.y = w.input.up ? CLIMB : -CLIMB;
  h.vel.x = 0;
  h.pos.y += h.vel.y * dt;
  h.walkPhase += dt * 8;
  if (Math.random() < 0.06) w.sound.climb();
  stepOffLadder(h, ladder);
}

/** Leave the ladder at its top (onto the beam) or bottom. */
function stepOffLadder(h: Hero, ladder: Ladder): void {
  if (h.pos.y >= ladder.yTop) {
    h.pos.y = ladder.yTop;
    h.onLadder = null;
    h.onGround = true;
  } else if (h.pos.y <= ladder.yBot) {
    h.pos.y = ladder.yBot;
    h.onLadder = null;
  }
}

/** Walking/jumping: horizontal input, a latched jump, gravity, and platform landing. */
function walkStep(w: World, dt: number): void {
  const h = w.hero;
  h.onLadder = null;
  const dir = (w.input.right ? 1 : 0) - (w.input.left ? 1 : 0);
  h.vel.x = dir * MOVE;
  if (dir !== 0) h.facing = dir;
  tryJump(w);
  h.vel.y -= G * dt;
  h.pos.x += h.vel.x * dt;
  h.pos.y += h.vel.y * dt;
  landHero(w);
  if (h.onGround && Math.abs(h.vel.x) > 0.1) h.walkPhase += dt * 10;
}

/** A jump fires once per press (the latch clears when the key is released). */
function tryJump(w: World): void {
  const h = w.hero;
  if (!w.input.jump) {
    h.jumpLatch = false;
    return;
  }
  if (!h.onGround || h.jumpLatch) return;
  h.vel.y = JUMP_V;
  h.onGround = false;
  h.jumpLatch = true;
  w.sound.jump();
}

/** Land on / stick to a platform when falling onto its surface. */
function landHero(w: World): void {
  const h = w.hero;
  const p = platformUnder(h.pos.x, h.pos.y);
  if (!p || h.vel.y > 0) {
    h.onGround = false;
    return;
  }
  const sy = surfaceY(p, h.pos.x);
  if (h.pos.y > sy + 0.05) return;
  if (!h.onGround) w.sound.land();
  h.pos.y = sy;
  h.vel.y = 0;
  h.onGround = true;
}

function stepBarrel(w: World, b: Barrel, dt: number): void {
  b.age += dt;
  b.noLadder = Math.max(0, b.noLadder - dt);
  if (b.descend) rideLadder(b, dt);
  else rollBarrel(b, dt);
  b.mesh.position.set(b.x, b.y, 0.2);
  if (barrelGone(b)) return killBarrel(b);
  scoreOrHit(w, b);
}

/** Despawned by age, or rolled off the level. */
function barrelGone(b: Barrel): boolean {
  return b.age > BARREL_LIFE || b.x < -13 || b.x > 13 || b.y < -3;
}

function killBarrel(b: Barrel): void {
  b.alive = false;
  b.mesh.visible = false;
}

/** Riding a ladder down: slide onto the rail and drop one row. */
function rideLadder(b: Barrel, dt: number): void {
  const l = b.descend!;
  b.x += (l.x - b.x) * Math.min(1, dt * 10);
  b.vx = 0;
  b.y -= 5.5 * dt;
  b.mesh.rotation.z += dt * 4;
  if (b.y <= l.yBot + BARREL_R) {
    b.y = l.yBot + BARREL_R;
    b.descend = null;
    b.noLadder = 1.0;
    b.vx = 0; // the beam it lands on decides the new roll direction
  }
}

/** Rolling: settle onto the beam under the barrel (or fall), then integrate. */
function rollBarrel(b: Barrel, dt: number): void {
  const p = platformUnder(b.x, b.y - BARREL_R + 0.35);
  if (p && b.y <= surfaceY(p, b.x) + BARREL_R + 0.1) rollOnBeam(b, p, dt);
  else b.vy -= G * dt;
  b.x += b.vx * dt;
  b.y += b.vy * dt;
  b.mesh.rotation.z -= (b.vx / BARREL_R) * dt;
}

/** On a beam: stick to its surface and roll downhill (or keep going on a flat one). */
function rollOnBeam(b: Barrel, p: Platform, dt: number): void {
  b.y = surfaceY(p, b.x) + BARREL_R;
  b.vy = 0;
  b.vx += (rollDirection(b, p) * ROLL - b.vx) * Math.min(1, dt * 6);
  if (b.noLadder <= 0) maybeTakeLadder(b, p);
}

/** Downhill on a slope; on a flat beam keep the current direction (right when at rest). */
function rollDirection(b: Barrel, p: Platform): number {
  if (p.slope === 0) return Math.sign(b.vx) || 1;
  return p.slope > 0 ? -1 : 1;
}

/**
 * Classic wrinkle: a barrel may (not must) take a ladder DOWN from this beam. Ladders
 * whose top sits on this beam are candidates.
 */
function maybeTakeLadder(b: Barrel, p: Platform): void {
  const candidate = LADDERS.find((l) =>
    Math.abs(b.x - l.x) < 0.5 && Math.abs(l.yTop - surfaceY(p, l.x)) < 0.3
  );
  if (candidate && Math.random() < 0.02) b.descend = candidate;
}

/** Scoring: the hero clears a barrel by jumping over it; touching one costs a life. */
function scoreOrHit(w: World, b: Barrel): void {
  if (clearedBarrel(w.hero, b)) {
    b.scored = true;
    addScore(w, 100);
    w.sound.point();
  }
  if (w.invuln <= 0 && touchesHero(w.hero, b)) loseLife(w);
}

function clearedBarrel(h: Hero, b: Barrel): boolean {
  return !b.scored && !h.onGround && Math.abs(b.x - h.pos.x) < 0.9 &&
    h.pos.y > b.y + 0.4;
}

function touchesHero(h: Hero, b: Barrel): boolean {
  return Math.hypot(b.x - h.pos.x, b.y - (h.pos.y + HERO_H * 0.4)) <
    BARREL_R + HERO_R;
}

/** Reaching the caged cat on the top girder wins the run. */
function checkWin(w: World): void {
  const h = w.hero;
  if (Math.abs(h.pos.x - GOAL_X) >= 1.2) return;
  if (h.pos.y <= surfaceY(PLATFORMS[5], GOAL_X) - 0.4) return;
  addScore(w, 1000);
  w.sound.win();
  setState(w, "won");
}
