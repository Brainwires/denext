// Rivet Rumble — an original barrel-climber built on vanilla Three.js (WebGL).
// A homage to the arcade climb-and-dodge genre with all-original characters
// (built from low-poly primitives), art, and sound — no copyrighted assets.
//
// This module is pure engine: it owns the WebGL canvas, meshes, physics, input,
// and the render loop, and reports game events back through callbacks. React
// (app/page.tsx) owns the HUD/overlays. `createGame` is called from a client-only
// useEffect, so importing `three` here never touches WebGL on the server.
import * as THREE from "three";
import type { Sound } from "./audio.ts";

export type GameState = "ready" | "playing" | "won" | "lost";
export type InputKey = "left" | "right" | "up" | "down" | "jump";

export interface GameCallbacks {
  onScore: (n: number) => void;
  onLives: (n: number) => void;
  onState: (s: GameState) => void;
}

export interface GameHandle {
  start: () => void;
  setInput: (k: InputKey, down: boolean) => void;
  dispose: () => void;
}

// ── Level: girders (sloped platforms) + ladders, bottom → top ────────────────
interface Platform {
  left: number;
  right: number;
  y: number;
  slope: number;
}
interface Ladder {
  x: number;
  yBot: number;
  yTop: number;
}
// Beams are STAGGERED: each one extends under the low-end drop point of the beam
// above it, so a barrel rolling off an edge lands on the beam directly below and
// only ever falls ONE row. Rows alternate which side they overhang; slopes
// alternate so the barrels zig-zag down.
const PLATFORMS: Platform[] = [
  { left: -12, right: 12, y: 1.0, slope: 0 }, // ground (full width)
  { left: -10, right: 6, y: 5.5, slope: -0.08 }, // A: rolls right → drops at +6
  { left: -6, right: 10, y: 9.5, slope: 0.08 }, // B: rolls left  → drops at -6
  { left: -10, right: 6, y: 13.5, slope: -0.08 }, // C: rolls right → drops at +6
  { left: -6, right: 10, y: 17.5, slope: 0.08 }, // D: rolls left  → drops at -6
  { left: -10, right: 6, y: 21.5, slope: -0.06 }, // top: rolls right → drops at +6
];
const cx = (p: Platform) => (p.left + p.right) / 2;
const surfaceY = (p: Platform, x: number) => p.y + p.slope * (x - cx(p));
const onSpan = (p: Platform, x: number) => x >= p.left && x <= p.right;

// Ladders sit where consecutive beams overlap. The hero climbs them; barrels may
// (randomly) take one down too.
const LADDERS: Ladder[] = [
  { x: -8, yBot: 0, yTop: 1 }, // G→A
  { x: 4, yBot: 0, yTop: 1 }, // A→B
  { x: -4, yBot: 0, yTop: 1 }, // B→C
  { x: 4, yBot: 0, yTop: 1 }, // C→D
  { x: 3, yBot: 0, yTop: 1 }, // D→T (arrive top, walk right to the cat)
];

const G = 42; // gravity
const MOVE = 5.2;
const CLIMB = 4.2;
const JUMP_V = 12.2;
const HERO_H = 1.5;
const HERO_R = 0.55;
const BARREL_R = 0.6;
const ROLL = 4.6;
const MAX_BARRELS = 8; // hard cap on concurrent barrels (perf + fairness)
const BARREL_LIFE = 16; // seconds before a barrel despawns no matter what

export function createGame(
  container: HTMLElement,
  sound: Sound,
  cb: GameCallbacks,
): GameHandle {
  // Fill ladder spans from the platforms they connect.
  for (let i = 0; i < LADDERS.length; i++) {
    LADDERS[i].yBot = surfaceY(PLATFORMS[i], LADDERS[i].x);
    LADDERS[i].yTop = surfaceY(PLATFORMS[i + 1], LADDERS[i].x);
  }

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(2, globalThis.devicePixelRatio || 1));
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(47, 1, 0.1, 200);

  // Lighting.
  scene.add(new THREE.AmbientLight(0x8090b0, 1.5));
  const key = new THREE.DirectionalLight(0xfff0dd, 1.6);
  key.position.set(6, 14, 12);
  scene.add(key);
  const rim = new THREE.PointLight(0xffcf66, 60, 40);
  rim.position.set(-8, 22, 6);
  scene.add(rim);

  // Textures.
  const tl = new THREE.TextureLoader();
  const girderTex = tl.load("/assets/girder.png");
  girderTex.wrapS = girderTex.wrapT = THREE.RepeatWrapping;
  const barrelTex = tl.load("/assets/barrel.png");
  barrelTex.wrapS = barrelTex.wrapT = THREE.RepeatWrapping;
  barrelTex.repeat.set(2, 1);

  // Background.
  const bgTex = tl.load("/assets/bg.jpg");
  const bg = new THREE.Mesh(
    new THREE.PlaneGeometry(90, 60),
    new THREE.MeshBasicMaterial({ map: bgTex }),
  );
  bg.position.set(0, 11, -14);
  scene.add(bg);

  // Girder platforms.
  for (const p of PLATFORMS) {
    const len = p.right - p.left;
    const g = new THREE.BoxGeometry(len, 0.6, 2.4);
    const t = girderTex.clone();
    t.needsUpdate = true;
    t.repeat.set(len / 2.2, 1);
    const mesh = new THREE.Mesh(
      g,
      new THREE.MeshStandardMaterial({ map: t, roughness: 0.7 }),
    );
    mesh.position.set(cx(p), p.y - 0.3, 0);
    mesh.rotation.z = Math.atan(p.slope);
    scene.add(mesh);
  }

  // Ladders (two rails + rungs).
  const ladderMat = new THREE.MeshStandardMaterial({
    color: 0xffd166,
    roughness: 0.5,
  });
  for (const l of LADDERS) {
    const h = l.yTop - l.yBot;
    const grp = new THREE.Group();
    for (const dx of [-0.35, 0.35]) {
      const rail = new THREE.Mesh(
        new THREE.BoxGeometry(0.14, h, 0.14),
        ladderMat,
      );
      rail.position.set(dx, 0, 0);
      grp.add(rail);
    }
    const rungs = Math.max(2, Math.floor(h / 0.7));
    for (let i = 0; i <= rungs; i++) {
      const rung = new THREE.Mesh(
        new THREE.BoxGeometry(0.84, 0.12, 0.12),
        ladderMat,
      );
      rung.position.set(0, -h / 2 + (i / rungs) * h, 0);
      grp.add(rung);
    }
    grp.position.set(l.x, (l.yBot + l.yTop) / 2, 0.9);
    scene.add(grp);
  }

  // Hero (original low-poly explorer).
  const hero = new THREE.Group();
  const heroMat = new THREE.MeshStandardMaterial({
    color: 0x2dd4bf,
    roughness: 0.5,
  });
  const skin = new THREE.MeshStandardMaterial({
    color: 0xffd9b3,
    roughness: 0.6,
  });
  const capMat = new THREE.MeshStandardMaterial({
    color: 0xf59e0b,
    roughness: 0.5,
  });
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.75, 0.5), heroMat);
  torso.position.y = 0.85;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.34, 16, 12), skin);
  head.position.y = 1.5;
  const cap = new THREE.Mesh(
    new THREE.SphereGeometry(0.37, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2),
    capMat,
  );
  cap.position.y = 1.55;
  const legL = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.55, 0.3), heroMat);
  const legR = legL.clone();
  legL.position.set(-0.18, 0.32, 0);
  legR.position.set(0.18, 0.32, 0);
  const armL = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.55, 0.22), skin);
  const armR = armL.clone();
  armL.position.set(-0.48, 0.9, 0);
  armR.position.set(0.48, 0.9, 0);
  hero.add(torso, head, cap, legL, legR, armL, armR);
  scene.add(hero);

  // The ape (original, top-left) — raises arms to roll barrels.
  const ape = new THREE.Group();
  const apeMat = new THREE.MeshStandardMaterial({
    color: 0x5b4636,
    roughness: 0.8,
  });
  const apeDark = new THREE.MeshStandardMaterial({
    color: 0x3e2f24,
    roughness: 0.8,
  });
  const apeBody = new THREE.Mesh(new THREE.SphereGeometry(1.2, 16, 12), apeMat);
  apeBody.scale.set(1, 0.95, 0.9);
  apeBody.position.y = 1.2;
  const apeChest = new THREE.Mesh(
    new THREE.SphereGeometry(0.8, 16, 12),
    new THREE.MeshStandardMaterial({ color: 0x8a6b4f }),
  );
  apeChest.scale.set(0.9, 1, 0.5);
  apeChest.position.set(0, 1.1, 0.6);
  const apeHead = new THREE.Mesh(
    new THREE.SphereGeometry(0.7, 16, 12),
    apeDark,
  );
  apeHead.position.y = 2.5;
  const apeArmL = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.4, 0.5), apeMat);
  const apeArmR = apeArmL.clone();
  apeArmL.geometry.translate(0, -0.7, 0);
  apeArmR.geometry.translate(0, -0.7, 0);
  apeArmL.position.set(-1.2, 2.0, 0.2);
  apeArmR.position.set(1.2, 2.0, 0.2);
  ape.add(apeBody, apeChest, apeHead, apeArmL, apeArmR);
  ape.position.set(-8, surfaceY(PLATFORMS[5], -8) + 0.3, 0);
  scene.add(ape);

  // The goal — a little caged cat to rescue (original, top-right).
  const goal = new THREE.Group();
  const catMat = new THREE.MeshStandardMaterial({
    color: 0xf2a44b,
    roughness: 0.6,
  });
  const catBody = new THREE.Mesh(new THREE.SphereGeometry(0.4, 14, 10), catMat);
  catBody.scale.set(1.2, 0.9, 0.9);
  const catHead = new THREE.Mesh(new THREE.SphereGeometry(0.3, 14, 10), catMat);
  catHead.position.set(0.35, 0.25, 0);
  for (const s of [-1, 1]) {
    const ear = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.2, 4), catMat);
    ear.position.set(0.4, 0.5, s * 0.12);
    goal.add(ear);
  }
  goal.add(catBody, catHead);
  const cageMat = new THREE.MeshStandardMaterial({
    color: 0xcbd5e1,
    roughness: 0.3,
    metalness: 0.6,
  });
  for (let i = 0; i < 6; i++) {
    const bar = new THREE.Mesh(
      new THREE.CylinderGeometry(0.03, 0.03, 1.4, 6),
      cageMat,
    );
    const a = (i / 6) * Math.PI * 2;
    bar.position.set(Math.cos(a) * 0.6, 0.1, Math.sin(a) * 0.6);
    goal.add(bar);
  }
  const GOAL_X = 5;
  goal.position.set(GOAL_X, surfaceY(PLATFORMS[5], GOAL_X) + 0.7, 0);
  scene.add(goal);

  // Barrel pool.
  interface Barrel {
    mesh: THREE.Mesh;
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
  const barrelGeo = new THREE.CylinderGeometry(BARREL_R, BARREL_R, 1.0, 18);
  barrelGeo.rotateX(Math.PI / 2); // axis along z → rolls around z as it moves in x
  const barrelMat = new THREE.MeshStandardMaterial({
    map: barrelTex,
    roughness: 0.6,
  });
  const barrels: Barrel[] = [];

  const spawnBarrel = () => {
    let b = barrels.find((k) => !k.alive);
    if (!b) {
      const mesh = new THREE.Mesh(barrelGeo, barrelMat);
      b = {
        mesh,
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
      barrels.push(b);
      scene.add(mesh);
    }
    b.x = -8;
    b.y = surfaceY(PLATFORMS[5], -8) + BARREL_R;
    b.vx = ROLL;
    b.vy = 0;
    b.alive = true;
    b.scored = false;
    b.descend = null;
    b.noLadder = 0.6;
    b.age = 0;
    b.mesh.visible = true;
    apeThrow = 0.35;
    sound.roll();
  };

  // ── Hero state ──
  const heroPos = { x: 0, y: 0 };
  const heroVel = { x: 0, y: 0 };
  let onGround = false;
  let onLadder: Ladder | null = null;
  let facing = 1;
  let walkPhase = 0;

  const input: Record<InputKey, boolean> = {
    left: false,
    right: false,
    up: false,
    down: false,
    jump: false,
  };
  let jumpLatch = false;

  let state: GameState = "ready";
  let score = 0;
  let lives = 3;
  let spawnTimer = 0;
  let apeThrow = 0;
  let invuln = 0;

  const setState = (s: GameState) => {
    state = s;
    cb.onState(s);
  };

  const resetHero = () => {
    heroPos.x = -9;
    heroPos.y = surfaceY(PLATFORMS[0], -9);
    heroVel.x = heroVel.y = 0;
    onGround = true;
    onLadder = null;
    invuln = 1.0;
  };

  const start = () => {
    score = 0;
    lives = 3;
    cb.onScore(0);
    cb.onLives(3);
    for (const b of barrels) {
      b.alive = false;
      b.mesh.visible = false;
    }
    spawnTimer = 1.2;
    resetHero();
    setState("playing");
  };

  // ── Physics step (fixed dt) ──
  const platformUnder = (x: number, y: number): Platform | null => {
    let best: Platform | null = null;
    for (const p of PLATFORMS) {
      if (!onSpan(p, x)) continue;
      const sy = surfaceY(p, x);
      if (y >= sy - 0.35 && y <= sy + 0.6) {
        if (!best || sy > surfaceY(best, x)) best = p;
      }
    }
    return best;
  };

  const ladderAt = (x: number, y: number): Ladder | null => {
    for (const l of LADDERS) {
      if (Math.abs(x - l.x) < 0.6 && y > l.yBot - 0.3 && y < l.yTop + 0.4) {
        return l;
      }
    }
    return null;
  };

  const step = (dt: number) => {
    if (state !== "playing") return;
    if (invuln > 0) invuln -= dt;
    if (apeThrow > 0) apeThrow -= dt;

    // Spawn barrels on a cadence that tightens with score.
    spawnTimer -= dt;
    if (spawnTimer <= 0) {
      let liveCount = 0;
      for (const k of barrels) if (k.alive) liveCount++;
      if (liveCount < MAX_BARRELS) spawnBarrel();
      spawnTimer = Math.max(1.3, 2.6 - score / 5000);
    }

    // ── Hero ──
    const climbing = ladderAt(heroPos.x, heroPos.y);
    if (climbing && (input.up || input.down)) {
      onLadder = climbing;
      heroPos.x += (climbing.x - heroPos.x) * 0.4; // snap to rail
      heroVel.y = input.up ? CLIMB : -CLIMB;
      heroVel.x = 0;
      heroPos.y += heroVel.y * dt;
      walkPhase += dt * 8;
      if (Math.random() < 0.06) sound.climb();
      if (heroPos.y >= climbing.yTop) {
        heroPos.y = climbing.yTop;
        onLadder = null;
        onGround = true;
      }
      if (heroPos.y <= climbing.yBot) {
        heroPos.y = climbing.yBot;
        onLadder = null;
      }
    } else {
      onLadder = null;
      const dir = (input.right ? 1 : 0) - (input.left ? 1 : 0);
      heroVel.x = dir * MOVE;
      if (dir !== 0) facing = dir;
      if (onGround && input.jump && !jumpLatch) {
        heroVel.y = JUMP_V;
        onGround = false;
        jumpLatch = true;
        sound.jump();
      }
      if (!input.jump) jumpLatch = false;

      heroVel.y -= G * dt;
      heroPos.x += heroVel.x * dt;
      heroPos.y += heroVel.y * dt;

      // Land on / stick to a platform.
      const p = platformUnder(heroPos.x, heroPos.y);
      if (p && heroVel.y <= 0) {
        const sy = surfaceY(p, heroPos.x);
        if (heroPos.y <= sy + 0.05) {
          if (!onGround) sound.land();
          heroPos.y = sy;
          heroVel.y = 0;
          onGround = true;
        }
      } else {
        onGround = false;
      }
      if (onGround && Math.abs(heroVel.x) > 0.1) walkPhase += dt * 10;
    }

    heroPos.x = Math.max(-11.5, Math.min(11.5, heroPos.x));
    if (heroPos.y < -2) {
      loseLife();
    }

    // ── Barrels ──
    for (const b of barrels) {
      if (!b.alive) continue;
      b.age += dt;
      if (b.age > BARREL_LIFE) {
        b.alive = false;
        b.mesh.visible = false;
        continue;
      }
      if (b.noLadder > 0) b.noLadder -= dt;

      if (b.descend) {
        // Riding a ladder down: slide onto the rail and drop one row.
        b.x += (b.descend.x - b.x) * Math.min(1, dt * 10);
        b.vx = 0;
        b.y -= 5.5 * dt;
        b.mesh.rotation.z += dt * 4;
        if (b.y <= b.descend.yBot + BARREL_R) {
          b.y = b.descend.yBot + BARREL_R;
          b.descend = null;
          b.noLadder = 1.0;
          b.vx = 0; // the beam it lands on decides the new roll direction
        }
      } else {
        const p = platformUnder(b.x, b.y - BARREL_R + 0.35);
        if (p) {
          const sy = surfaceY(p, b.x) + BARREL_R;
          if (b.y <= sy + 0.1) {
            b.y = sy;
            b.vy = 0;
            const dirWanted = p.slope === 0
              ? Math.sign(b.vx) || 1
              : (p.slope > 0 ? -1 : 1);
            b.vx += (dirWanted * ROLL - b.vx) * Math.min(1, dt * 6);
            // Classic wrinkle: a barrel may (not must) take a ladder DOWN from
            // this beam. Ladders whose top sits on this beam are candidates.
            if (b.noLadder <= 0) {
              for (const l of LADDERS) {
                if (
                  Math.abs(b.x - l.x) < 0.5 &&
                  Math.abs(l.yTop - surfaceY(p, l.x)) < 0.3 &&
                  Math.random() < 0.02
                ) {
                  b.descend = l;
                  break;
                }
              }
            }
          } else {
            b.vy -= G * dt;
          }
        } else {
          b.vy -= G * dt;
        }
        b.x += b.vx * dt;
        b.y += b.vy * dt;
        b.mesh.rotation.z -= (b.vx / BARREL_R) * dt;
      }
      b.mesh.position.set(b.x, b.y, 0.2);
      if (b.x < -13 || b.x > 13 || b.y < -3) {
        b.alive = false;
        b.mesh.visible = false;
      }

      // Scoring: hero clears a barrel by jumping over it.
      if (
        !b.scored && !onGround && Math.abs(b.x - heroPos.x) < 0.9 &&
        heroPos.y > b.y + 0.4
      ) {
        b.scored = true;
        score += 100;
        cb.onScore(score);
        sound.point();
      }
      // Hit.
      if (
        invuln <= 0 &&
        Math.hypot(b.x - heroPos.x, (b.y) - (heroPos.y + HERO_H * 0.4)) <
          BARREL_R + HERO_R
      ) {
        loseLife();
      }
    }

    // ── Win ──
    if (
      Math.abs(heroPos.x - GOAL_X) < 1.2 &&
      heroPos.y > surfaceY(PLATFORMS[5], GOAL_X) - 0.4
    ) {
      score += 1000;
      cb.onScore(score);
      sound.win();
      setState("won");
    }
  };

  const loseLife = () => {
    if (invuln > 0 || state !== "playing") return;
    lives -= 1;
    cb.onLives(lives);
    sound.hit();
    if (lives <= 0) {
      sound.lose();
      setState("lost");
    } else {
      resetHero();
    }
  };

  // ── Render / animation ──
  const clock = new THREE.Clock();
  let acc = 0;
  let raf = 0;
  let disposed = false;

  const fit = () => {
    const w = container.clientWidth || globalThis.innerWidth;
    const h = container.clientHeight || globalThis.innerHeight;
    renderer.setSize(w, h);
    const aspect = w / h;
    camera.aspect = aspect;
    const vfov = (47 * Math.PI) / 180;
    const needH = Math.max(13, 12 / aspect);
    camera.position.set(0, 11, needH / Math.tan(vfov / 2));
    camera.lookAt(0, 11, 0);
    camera.updateProjectionMatrix();
  };
  fit();
  globalThis.addEventListener("resize", fit);

  const loop = () => {
    if (disposed) return;
    raf = requestAnimationFrame(loop);
    const dt = Math.min(0.05, clock.getDelta());
    acc += dt;
    const fixed = 1 / 120;
    let n = 0;
    while (acc >= fixed && n++ < 8) {
      step(fixed);
      acc -= fixed;
    }

    // Hero transform + limb animation.
    hero.position.set(heroPos.x, heroPos.y, 0.2);
    hero.rotation.y = facing < 0 ? Math.PI : 0;
    const swing = Math.sin(walkPhase) * 0.5;
    legL.rotation.x = swing;
    legR.rotation.x = -swing;
    if (onLadder) {
      armL.rotation.x = Math.sin(walkPhase) * 0.9 - 1.2;
      armR.rotation.x = -Math.sin(walkPhase) * 0.9 - 1.2;
    } else {
      armL.rotation.x = -swing * 0.6;
      armR.rotation.x = swing * 0.6;
    }
    hero.visible = state === "playing"
      ? (invuln > 0 ? Math.floor(invuln * 12) % 2 === 0 : true)
      : true;

    // Ape idle + throw.
    const t = clock.elapsedTime;
    ape.position.y = surfaceY(PLATFORMS[5], -8) + 0.3 + Math.sin(t * 2) * 0.05;
    apeArmL.rotation.x = apeArmR.rotation.x = apeThrow > 0
      ? -1.4
      : Math.sin(t * 2) * 0.2 - 0.1;

    // Goal cat bob.
    goal.position.y = surfaceY(PLATFORMS[5], GOAL_X) + 0.7 +
      Math.sin(t * 3) * 0.05;

    renderer.render(scene, camera);
  };
  loop();

  // ── Keyboard input ──
  const KEYMAP: Record<string, InputKey> = {
    ArrowLeft: "left",
    KeyA: "left",
    ArrowRight: "right",
    KeyD: "right",
    ArrowUp: "up",
    KeyW: "up",
    ArrowDown: "down",
    KeyS: "down",
    Space: "jump",
    KeyZ: "jump",
    KeyK: "jump",
  };
  const setInput = (k: InputKey, down: boolean) => {
    input[k] = down;
  };
  const onKey = (e: KeyboardEvent, down: boolean) => {
    const k = KEYMAP[e.code];
    if (!k) return;
    e.preventDefault();
    setInput(k, down);
  };
  const kd = (e: KeyboardEvent) => onKey(e, true);
  const ku = (e: KeyboardEvent) => onKey(e, false);
  globalThis.addEventListener("keydown", kd);
  globalThis.addEventListener("keyup", ku);

  return {
    start,
    setInput,
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      globalThis.removeEventListener("resize", fit);
      globalThis.removeEventListener("keydown", kd);
      globalThis.removeEventListener("keyup", ku);
      renderer.dispose();
      if (renderer.domElement.parentElement === container) {
        container.removeChild(renderer.domElement);
      }
    },
  };
}
