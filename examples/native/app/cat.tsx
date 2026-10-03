// An animated cat that runs around ON TOP of everything. It chases your pointer
// while you're moving it; when the pointer goes quiet it hunts one of the rabbits
// that hop around the screen — and the rabbits bolt when it gets close. Toggle
// "nap" and it curls up with zzz's while the rabbits keep hopping.
//
// The whole simulation (cat + rabbits) runs in one requestAnimationFrame loop (with a
// timer fallback while frames are held back) that writes transforms straight to the
// DOM — never React state — so nothing here re-renders the tree while it moves.
//
// Hooks on show: useRef, useState, useEffect, useEffectEvent (stable pointer
// handler that always sees the latest props), and useImperativeHandle (the page
// calls `catRef.current.summon(x, y)`). denext threads `ref` through props
// (React-19 style), so a plain function component takes it directly — no forwardRef.
import { useEffect, useEffectEvent, useImperativeHandle, useRef } from "denext";
import type { Ref } from "denext";
import {
  CAT_H,
  CAT_W,
  type CatWorld,
  fitToViewport,
  RAB_H,
  RAB_W,
  RABBIT_COUNT,
  spawn,
  type SpriteEl,
  stepCat,
  stepRabbits,
} from "./cat-sim.ts";

/** Imperative handle the page/controls can call on the cat. */
export interface CatHandle {
  /** Teleport the cat to viewport coords and have it dash from there. */
  summon(x: number, y: number): void;
}

interface CatProps {
  enabled: boolean;
  napping: boolean;
  /** Chase speed in px/frame (~60fps). */
  speed: number;
  /** When true, the cat ignores the pointer and only hunts rabbits. */
  ignoreMouse: boolean;
  /** Called each time the cat corners and catches a rabbit (a point). */
  onCapture?: () => void;
  ref?: Ref<CatHandle>;
}

export function Cat(
  { enabled, napping, speed, ignoreMouse, onCapture, ref }: CatProps,
) {
  const rootRef = useRef<HTMLDivElement>(null); // gets the cat's translate + run/nap classes
  const flipRef = useRef<HTMLDivElement>(null); // gets the cat's facing scaleX
  const world = useCatWorld({ napping, speed, ignoreMouse, onCapture });
  useImperativeHandle(
    ref,
    () => ({ summon: (x, y) => summonCat(world, x, y) }),
    [],
  );
  useCatLoop(enabled, world, rootRef, flipRef);

  if (!enabled) return null;

  return (
    <div class="cat-layer" aria-hidden="true">
      <div class="cat" ref={rootRef}>
        <div class="flip" ref={flipRef}>
          <div class="gait">
            <img
              src="/cat.png"
              alt=""
              width={CAT_W}
              height={CAT_H}
              draggable={false}
            />
          </div>
        </div>
        <span class="zzz">z</span>
      </div>

      <Rabbits els={world.rabbitEls} />
    </div>
  );
}

/** The running loop's stop function, on `globalThis` so it survives a hot-reloaded copy of this module. */
const ACTIVE_LOOP = Symbol.for("denext.examples.native.catLoop");
type LoopHost = { [ACTIVE_LOOP]?: () => void };

/**
 * If no animation frame arrives within this long, step on a timer instead. A WebView can hold
 * `requestAnimationFrame` back for seconds (or indefinitely) while it decides the window is not
 * visible — a freshly launched desktop window that has not been activated, say — and the sprites
 * would sit at their off-screen CSS default until it does.
 */
const FRAME_FALLBACK_MS = 34;

/**
 * Drive the simulation every animation frame (or on a timer while frames are held back); returns
 * the stop function. Nothing spawns until the window reports a real size ({@link spawn}), and a
 * `resize` pulls every sprite back inside. Only one loop ever runs: starting one stops any previous
 * loop, including one a hot reload orphaned.
 */
function runLoop(
  world: CatWorld,
  rootRef: { current: HTMLDivElement | null },
  flipRef: { current: HTMLDivElement | null },
): () => void {
  const host = globalThis as LoopHost;
  host[ACTIVE_LOOP]?.();
  let raf = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const tick = (now: number) => {
    cancelAnimationFrame(raf);
    clearTimeout(timer);
    if (stopped) return;
    if (spawn(world)) {
      stepRabbits(world, now);
      const root = rootRef.current;
      if (root) stepCat(world, root, flipRef.current, now);
    }
    schedule();
  };
  // Whichever comes first — the next frame, or the fallback timer — steps once and re-arms both.
  const schedule = () => {
    raf = requestAnimationFrame(tick);
    timer = setTimeout(() => tick(performance.now()), FRAME_FALLBACK_MS);
  };
  const onResize = () => fitToViewport(world);
  globalThis.addEventListener("resize", onResize);
  schedule();
  const stop = () => {
    stopped = true;
    cancelAnimationFrame(raf);
    clearTimeout(timer);
    globalThis.removeEventListener("resize", onResize);
    if (host[ACTIVE_LOOP] === stop) delete host[ACTIVE_LOOP];
  };
  host[ACTIVE_LOOP] = stop;
  return stop;
}

/**
 * Track the pointer, and when the mouse leaves the window leave the cat at the wall — it
 * sits and waits (up to 5s) for the mouse to come back, like it's watching the door. Mouse
 * pointers only: touch has no persistent hover, so a tap "leaving" shouldn't strand the
 * cat. Returns the detach function.
 */
function installPointerListeners(
  onPoint: (x: number, y: number) => void,
  napping: { current: boolean },
  waiting: { current: boolean },
  waitUntil: { current: number },
): () => void {
  const move = (e: PointerEvent) => onPoint(e.clientX, e.clientY);
  const onLeave = (e: PointerEvent) => {
    if (napping.current || e.pointerType !== "mouse") return;
    waiting.current = true;
    waitUntil.current = performance.now() + 5000;
  };
  const onEnter = () => {
    waiting.current = false;
  };
  const html = document.documentElement;
  globalThis.addEventListener("pointermove", move, { passive: true });
  html.addEventListener("pointerleave", onLeave);
  html.addEventListener("pointerenter", onEnter);
  return () => {
    globalThis.removeEventListener("pointermove", move);
    html.removeEventListener("pointerleave", onLeave);
    html.removeEventListener("pointerenter", onEnter);
  };
}

/** The rabbit sprites; each registers its element in `els` by index for the loop. */
function Rabbits({ els }: { els: { current: (SpriteEl | null)[] } }) {
  return (
    <>
      {Array.from({ length: RABBIT_COUNT }, (_, i) => (
        <div
          class="rabbit"
          key={i}
          ref={(el: HTMLDivElement | null) => {
            els.current[i] = el;
          }}
        >
          <div class="rflip">
            <img
              src="/rabbit.png"
              alt=""
              width={RAB_W}
              height={RAB_H}
              draggable={false}
            />
          </div>
        </div>
      ))}
    </>
  );
}

/**
 * The simulation's mutable cells (plain refs → no re-renders per frame), created once,
 * with the latest props mirrored in so the long-lived rAF loop always reads current
 * values without being torn down and recreated every render.
 */
function useCatWorld(
  props: {
    napping: boolean;
    speed: number;
    ignoreMouse: boolean;
    onCapture?: () => void;
  },
): CatWorld {
  const speed = useRef(props.speed);
  speed.current = props.speed;
  const napping = useRef(props.napping);
  napping.current = props.napping;
  const ignoreMouse = useRef(props.ignoreMouse);
  ignoreMouse.current = props.ignoreMouse;
  // Stable "score a point" callback that always calls the latest prop.
  const scorePoint = useEffectEvent(() => props.onCapture?.());
  const world = useRef<CatWorld | null>(null);
  world.current ??= {
    pos: { current: { x: NaN, y: NaN } }, // unplaced until the viewport is known (see spawn)
    facing: { current: 1 },
    chasing: { current: false },
    pointer: { current: { x: -100, y: -100 } },
    lastPointerMove: { current: 0 },
    rabbits: { current: [] },
    rabbitEls: { current: [] },
    hunt: { current: 0 },
    retargetAt: { current: 0 },
    waiting: { current: false },
    waitUntil: { current: 0 },
    speed,
    napping,
    ignoreMouse,
    scorePoint,
  };
  return world.current;
}

/** The pointer moved: chase it (a napping cat does not), and stop waiting at the wall. */
function pointTo(world: CatWorld, x: number, y: number): void {
  if (world.napping.current) return;
  world.pointer.current = { x, y };
  world.lastPointerMove.current = performance.now();
  world.waiting.current = false; // the mouse is here → nothing to wait for
}

/** `CatHandle.summon`: pop in nearby, then dash to the point. */
function summonCat(world: CatWorld, x: number, y: number): void {
  world.pos.current = { x: x - 80, y };
  world.pointer.current = { x, y };
  world.lastPointerMove.current = performance.now();
}

/** While enabled: listen to the pointer and run the frame loop (which spawns the world). */
function useCatLoop(
  enabled: boolean,
  world: CatWorld,
  rootRef: { current: HTMLDivElement | null },
  flipRef: { current: HTMLDivElement | null },
): void {
  useEffect(() => {
    if (!enabled) return;
    // The loop spawns the cat and rabbits on its first frame with a non-zero viewport
    // (client-only — they're positioned by JS, so there's no SSR markup to mismatch).
    const detachPointer = installPointerListeners(
      (x, y) => pointTo(world, x, y),
      world.napping,
      world.waiting,
      world.waitUntil,
    );
    const stopLoop = runLoop(world, rootRef, flipRef);
    return () => {
      stopLoop();
      detachPointer();
    };
  }, [enabled]);
}
