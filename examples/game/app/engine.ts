// Rivet Rumble — the game engine. Owns the WebGL scene and the render loop; the React/denext
// page owns the HUD + overlays + touch controls and talks to the engine through `createGame`'s
// callback API. The simulation itself (level geometry, physics, scoring) lives in
// `physics.ts`; this module builds the scene (`buildScene`), steps the world in fixed
// increments (`simulate`), mirrors the world into meshes (`animateHero` / `animateScenery`),
// and wires keyboard input.

import * as THREE from "three";
import type { Sound } from "./audio.ts";
import {
  APE_X,
  BARREL_R,
  createWorld,
  cx,
  type GameCallbacks,
  GOAL_X,
  type InputKey,
  LADDERS,
  linkLadders,
  PLATFORMS,
  startRun,
  step,
  surfaceY,
  type World,
} from "./physics.ts";

export type { GameCallbacks, GameState, InputKey } from "./physics.ts";

export interface GameHandle {
  /** Start (or restart) a run. Also unlocks audio — call it from a user gesture. */
  start: () => void;
  setInput: (k: InputKey, down: boolean) => void;
  /** Mute/unmute the synthesized sound and music. */
  setMuted: (muted: boolean) => void;
  dispose: () => void;
}

// ── Scene ─────────────────────────────────────────────────────────────────────

/** The hero rig: the group plus the limbs the animation swings. */
interface HeroRig {
  group: THREE.Group;
  legL: THREE.Mesh;
  legR: THREE.Mesh;
  armL: THREE.Mesh;
  armR: THREE.Mesh;
}

/** The ape rig: the group plus the arms it raises to roll a barrel. */
interface ApeRig {
  group: THREE.Group;
  armL: THREE.Mesh;
  armR: THREE.Mesh;
}

/** Everything the renderer draws, built once by `buildScene`. */
interface Scene {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  hero: HeroRig;
  ape: ApeRig;
  goal: THREE.Group;
  barrelGeo: THREE.CylinderGeometry;
  barrelMat: THREE.MeshStandardMaterial;
}

function buildScene(container: HTMLElement): Scene {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(2, globalThis.devicePixelRatio || 1));
  container.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(47, 1, 0.1, 200);
  addLighting(scene);
  const tl = new THREE.TextureLoader();
  addBackground(scene, tl);
  addGirders(scene, tl);
  addLadders(scene);
  const hero = buildHero();
  scene.add(hero.group);
  const ape = buildApe();
  scene.add(ape.group);
  const goal = buildGoal();
  scene.add(goal);
  const barrelTex = tl.load("/assets/barrel.png");
  barrelTex.wrapS = barrelTex.wrapT = THREE.RepeatWrapping;
  barrelTex.repeat.set(2, 1);
  const barrelGeo = new THREE.CylinderGeometry(BARREL_R, BARREL_R, 1.0, 18);
  barrelGeo.rotateX(Math.PI / 2); // axis along z → rolls around z as it moves in x
  const barrelMat = new THREE.MeshStandardMaterial({
    map: barrelTex,
    roughness: 0.6,
  });
  return { renderer, scene, camera, hero, ape, goal, barrelGeo, barrelMat };
}

function addLighting(scene: THREE.Scene): void {
  scene.add(new THREE.AmbientLight(0x8090b0, 1.5));
  const key = new THREE.DirectionalLight(0xfff0dd, 1.6);
  key.position.set(6, 14, 12);
  scene.add(key);
  const rim = new THREE.PointLight(0xffcf66, 60, 40);
  rim.position.set(-8, 22, 6);
  scene.add(rim);
}

function addBackground(scene: THREE.Scene, tl: THREE.TextureLoader): void {
  const bg = new THREE.Mesh(
    new THREE.PlaneGeometry(90, 60),
    new THREE.MeshBasicMaterial({ map: tl.load("/assets/bg.jpg") }),
  );
  bg.position.set(0, 11, -14);
  scene.add(bg);
}

/** Girder platforms: a textured box per platform, tilted to its slope. */
function addGirders(scene: THREE.Scene, tl: THREE.TextureLoader): void {
  const girderTex = tl.load("/assets/girder.png");
  girderTex.wrapS = girderTex.wrapT = THREE.RepeatWrapping;
  for (const p of PLATFORMS) {
    const len = p.right - p.left;
    const t = girderTex.clone();
    t.needsUpdate = true;
    t.repeat.set(len / 2.2, 1);
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(len, 0.6, 2.4),
      new THREE.MeshStandardMaterial({ map: t, roughness: 0.7 }),
    );
    mesh.position.set(cx(p), p.y - 0.3, 0);
    mesh.rotation.z = Math.atan(p.slope);
    scene.add(mesh);
  }
}

/** Ladders: two rails + rungs each. */
function addLadders(scene: THREE.Scene): void {
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
}

/** The hero: an original low-poly explorer. */
function buildHero(): HeroRig {
  const group = new THREE.Group();
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
  group.add(torso, head, cap, legL, legR, armL, armR);
  return { group, legL, legR, armL, armR };
}

/** The ape (original, top-left) — raises arms to roll barrels. */
function buildApe(): ApeRig {
  const group = new THREE.Group();
  const apeMat = new THREE.MeshStandardMaterial({
    color: 0x5b4636,
    roughness: 0.8,
  });
  const apeDark = new THREE.MeshStandardMaterial({
    color: 0x3e2f24,
    roughness: 0.8,
  });
  const body = new THREE.Mesh(new THREE.SphereGeometry(1.2, 16, 12), apeMat);
  body.scale.set(1, 0.95, 0.9);
  body.position.y = 1.2;
  const chest = new THREE.Mesh(
    new THREE.SphereGeometry(0.8, 16, 12),
    new THREE.MeshStandardMaterial({ color: 0x8a6b4f }),
  );
  chest.scale.set(0.9, 1, 0.5);
  chest.position.set(0, 1.1, 0.6);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.7, 16, 12), apeDark);
  head.position.y = 2.5;
  const armL = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.4, 0.5), apeMat);
  const armR = armL.clone();
  armL.geometry.translate(0, -0.7, 0);
  armR.geometry.translate(0, -0.7, 0);
  armL.position.set(-1.2, 2.0, 0.2);
  armR.position.set(1.2, 2.0, 0.2);
  group.add(body, chest, head, armL, armR);
  group.position.set(APE_X, surfaceY(PLATFORMS[5], APE_X) + 0.3, 0);
  return { group, armL, armR };
}

/** The goal — a little caged cat to rescue (original, top-right). */
function buildGoal(): THREE.Group {
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
  goal.position.set(GOAL_X, surfaceY(PLATFORMS[5], GOAL_X) + 0.7, 0);
  return goal;
}

// ── Render / animation ────────────────────────────────────────────────────────

/** Size the renderer to the container and frame the whole tower in the camera. */
function fitCamera(container: HTMLElement, gfx: Scene): void {
  const w = container.clientWidth || globalThis.innerWidth;
  const h = container.clientHeight || globalThis.innerHeight;
  gfx.renderer.setSize(w, h);
  const aspect = w / h;
  gfx.camera.aspect = aspect;
  const vfov = (47 * Math.PI) / 180;
  const needH = Math.max(13, 12 / aspect);
  gfx.camera.position.set(0, 11, needH / Math.tan(vfov / 2));
  gfx.camera.lookAt(0, 11, 0);
  gfx.camera.updateProjectionMatrix();
}

/** Pose the hero from its state: position, facing, limb swing, and the hit blink. */
function animateHero(w: World, gfx: Scene): void {
  const { hero } = gfx;
  const h = w.hero;
  hero.group.position.set(h.pos.x, h.pos.y, 0.2);
  hero.group.rotation.y = h.facing < 0 ? Math.PI : 0;
  const swing = Math.sin(h.walkPhase) * 0.5;
  hero.legL.rotation.x = swing;
  hero.legR.rotation.x = -swing;
  const [armL, armR] = h.onLadder
    ? [Math.sin(h.walkPhase) * 0.9 - 1.2, -Math.sin(h.walkPhase) * 0.9 - 1.2]
    : [-swing * 0.6, swing * 0.6];
  hero.armL.rotation.x = armL;
  hero.armR.rotation.x = armR;
  hero.group.visible = heroVisible(w);
}

/** Blink while invulnerable after a hit (12 Hz); otherwise visible. */
function heroVisible(w: World): boolean {
  if (w.state !== "playing" || w.invuln <= 0) return true;
  return Math.floor(w.invuln * 12) % 2 === 0;
}

/** The ape's idle bob + throw pose, and the goal cat's bob. */
function animateScenery(w: World, gfx: Scene, t: number): void {
  const { ape, goal } = gfx;
  ape.group.position.y = surfaceY(PLATFORMS[5], APE_X) + 0.3 +
    Math.sin(t * 2) * 0.05;
  ape.armL.rotation.x = ape.armR.rotation.x = w.apeThrow > 0 ? -1.4 : Math.sin(t * 2) * 0.2 - 0.1;
  goal.position.y = surfaceY(PLATFORMS[5], GOAL_X) + 0.7 +
    Math.sin(t * 3) * 0.05;
}

/** Advance the simulation in fixed 1/120 s steps (at most 8 per frame) for `dt` seconds. */
function simulate(w: World, acc: number): number {
  const fixed = 1 / 120;
  let n = 0;
  while (acc >= fixed && n++ < 8) {
    step(w, fixed);
    acc -= fixed;
  }
  return acc;
}

// ── Keyboard input ────────────────────────────────────────────────────────────

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

/** Map key events to inputs; returns the listeners so `dispose` can detach them. */
function installKeyboard(
  w: World,
): { kd: (e: KeyboardEvent) => void; ku: (e: KeyboardEvent) => void } {
  const onKey = (e: KeyboardEvent, down: boolean) => {
    const k = KEYMAP[e.code];
    if (!k) return;
    e.preventDefault();
    w.input[k] = down;
  };
  const kd = (e: KeyboardEvent) => onKey(e, true);
  const ku = (e: KeyboardEvent) => onKey(e, false);
  globalThis.addEventListener("keydown", kd);
  globalThis.addEventListener("keyup", ku);
  return { kd, ku };
}

// ── Entry ─────────────────────────────────────────────────────────────────────

export function createGame(
  container: HTMLElement,
  sound: Sound,
  cb: GameCallbacks,
): GameHandle {
  linkLadders();
  const gfx = buildScene(container);
  const w = createWorld(sound, cb, () => {
    const mesh = new THREE.Mesh(gfx.barrelGeo, gfx.barrelMat);
    gfx.scene.add(mesh);
    return mesh;
  });
  const fit = () => fitCamera(container, gfx);
  fit();
  globalThis.addEventListener("resize", fit);

  const clock = new THREE.Clock();
  let acc = 0;
  let raf = 0;
  let disposed = false;
  const loop = () => {
    if (disposed) return;
    raf = requestAnimationFrame(loop);
    acc = simulate(w, acc + Math.min(0.05, clock.getDelta()));
    animateHero(w, gfx);
    animateScenery(w, gfx, clock.elapsedTime);
    gfx.renderer.render(gfx.scene, gfx.camera);
  };
  loop();
  const keys = installKeyboard(w);

  // The engine owns the audio lifecycle: `start` runs from the Play gesture, which is
  // what the Web Audio API needs to unlock the context, and the mute toggle lands here.
  let muted = false;
  return {
    start() {
      sound.ensure();
      if (!muted) sound.startMusic();
      startRun(w);
    },
    setInput(k, down) {
      w.input[k] = down;
    },
    setMuted(v) {
      muted = v;
      sound.setMuted(v);
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      globalThis.removeEventListener("resize", fit);
      globalThis.removeEventListener("keydown", keys.kd);
      globalThis.removeEventListener("keyup", keys.ku);
      gfx.renderer.dispose();
      if (gfx.renderer.domElement.parentElement === container) {
        container.removeChild(gfx.renderer.domElement);
      }
    },
  };
}
