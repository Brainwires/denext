// An animated cat that runs around ON TOP of everything. It chases your pointer
// while you're moving it; when the pointer goes quiet it hunts one of the rabbits
// that hop around the screen — and the rabbits bolt when it gets close. Toggle
// "nap" and it curls up with zzz's while the rabbits keep hopping.
//
// The whole simulation (cat + rabbits) runs in one requestAnimationFrame loop that
// writes transforms straight to the DOM — never React state — so nothing here
// re-renders the tree while it moves.
//
// Hooks on show: useRef, useState, useEffect, useEffectEvent (stable pointer
// handler that always sees the latest props), and useImperativeHandle (the page
// calls `catRef.current.summon(x, y)`). denext threads `ref` through props
// (React-19 style), so a plain function component takes it directly — no forwardRef.
import { useEffect, useEffectEvent, useImperativeHandle, useRef } from "denext";
import type { Ref } from "denext";

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

const RABBIT_COUNT = 4;
const POINTER_GRACE = 1800; // ms since the last pointer move that still counts as "you're driving"
const SCARE = 88; // cat within this many px of the hunted rabbit → it bolts
const RETARGET_MS = 5000; // how often the cat picks a fresh rabbit to hunt
const FOLLOW = 44; // rest ring: park this far from the target
const START = 26; // only (re)start chasing once the target is this far past FOLLOW
const CAT_W = 74; // on-screen sprite size (px)
const CAT_H = 72;
const RAB_W = 26;
const RAB_H = 31;
const CORNER = 150; // a rabbit within this of BOTH a side and top/bottom wall is cornered
const CAPTURE = 50; // once cornered, the cat catches it at this range (just past its rest ring)

interface Rabbit {
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

export function Cat(
  { enabled, napping, speed, ignoreMouse, onCapture, ref }: CatProps,
) {
  const rootRef = useRef<HTMLDivElement>(null); // gets the cat's translate + run/nap classes
  const flipRef = useRef<HTMLDivElement>(null); // gets the cat's facing scaleX

  // Mutable simulation state (refs → no re-renders per frame).
  const pos = useRef({ x: -100, y: -100 });
  const facing = useRef(1);
  const chasing = useRef(false); // hysteresis: are we currently walking to the target?
  const pointer = useRef({ x: -100, y: -100 });
  const lastPointerMove = useRef(0);
  const rabbits = useRef<Rabbit[]>([]);
  const rabbitEls = useRef<(HTMLDivElement | null)[]>([]);
  const hunt = useRef(0); // index of the rabbit the cat is currently hunting
  const retargetAt = useRef(0);
  const waiting = useRef(false); // sitting at the wall, waiting for the mouse to come back
  const waitUntil = useRef(0);

  // Mirror the latest props into refs so the long-lived rAF loop always reads
  // current values without being torn down and recreated every render.
  const speedRef = useRef(speed);
  speedRef.current = speed;
  const napRef = useRef(napping);
  napRef.current = napping;
  const ignoreRef = useRef(ignoreMouse);
  ignoreRef.current = ignoreMouse;

  // A stable pointer handler that still sees the latest state — this is exactly
  // what useEffectEvent is for (no deps, never stale, never re-subscribes).
  const onPoint = useEffectEvent((x: number, y: number) => {
    if (napRef.current) return; // napping cats do not chase
    pointer.current = { x, y };
    lastPointerMove.current = performance.now();
    waiting.current = false; // the mouse is here → nothing to wait for
  });

  // Stable "score a point" callback that always calls the latest prop.
  const scorePoint = useEffectEvent(() => onCapture?.());

  useImperativeHandle(ref, () => ({
    summon(x: number, y: number) {
      pos.current = { x: x - 80, y }; // pop in nearby, then dash to the point
      pointer.current = { x, y };
      lastPointerMove.current = performance.now();
    },
  }), []);

  useEffect(() => {
    if (!enabled) return;
    const vw = () => globalThis.innerWidth || 360;
    const vh = () => globalThis.innerHeight || 640;
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

    if (pos.current.x < 0) {
      pos.current = { x: vw() * 0.5, y: vh() * 0.4 };
    }
    // Seed the rabbits once, at random spots (client-only — they're positioned by
    // JS, so there's no SSR markup to mismatch).
    if (rabbits.current.length === 0) {
      for (let i = 0; i < RABBIT_COUNT; i++) {
        const x = 40 + Math.random() * (vw() - 80);
        const y = 90 + Math.random() * (vh() - 180);
        rabbits.current.push({
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
    }

    const startHop = (
      r: Rabbit,
      tx: number,
      ty: number,
      now: number,
      dur: number,
    ) => {
      r.fromX = r.x;
      r.fromY = r.y;
      r.toX = clamp(tx, 24, vw() - 24);
      r.toY = clamp(ty, 80, vh() - 32);
      r.hopStart = now;
      r.hopDur = dur;
      r.hopping = true;
      if (Math.abs(r.toX - r.fromX) > 4) r.facing = r.toX < r.fromX ? -1 : 1;
    };
    // Idle: a rabbit just mills — short, lazy hops. Only a chase makes it bolt.
    const idleHop = (r: Rabbit, now: number) => {
      const a = Math.random() * Math.PI * 2;
      const rad = 26 + Math.random() * 60; // short
      startHop(
        r,
        r.x + Math.cos(a) * rad,
        r.y + Math.sin(a) * rad,
        now,
        420 + Math.random() * 220,
      );
    };
    const fleeHop = (r: Rabbit, fromX: number, fromY: number, now: number) => {
      const a = Math.atan2(r.y - fromY, r.x - fromX) +
        (Math.random() - 0.5) * 0.7;
      const rad = 130 + Math.random() * 90; // long bolt
      startHop(
        r,
        r.x + Math.cos(a) * rad,
        r.y + Math.sin(a) * rad,
        now,
        300 + Math.random() * 140,
      );
    };
    // A caught rabbit respawns somewhere fresh, well inset from every wall so it
    // doesn't reappear already cornered.
    const respawn = (r: Rabbit, now: number) => {
      const m = 110;
      r.x = m + Math.random() * Math.max(1, vw() - 2 * m);
      r.y = m + Math.random() * Math.max(1, vh() - 2 * m);
      r.fromX = r.toX = r.x;
      r.fromY = r.toY = r.y;
      r.hopping = false;
      r.restUntil = now + 500 + Math.random() * 900;
      r.facing = Math.random() < 0.5 ? -1 : 1;
    };

    const move = (e: PointerEvent) => onPoint(e.clientX, e.clientY);
    globalThis.addEventListener("pointermove", move, { passive: true });

    // When the mouse leaves the window, the cat is left at the wall — have it sit
    // and wait (up to 5s) for the mouse to come back, like it's watching the door.
    // Mouse pointers only: touch has no persistent hover, so a tap "leaving"
    // shouldn't strand the cat.
    const html = document.documentElement;
    const onLeave = (e: PointerEvent) => {
      if (napRef.current || e.pointerType !== "mouse") return;
      waiting.current = true;
      waitUntil.current = performance.now() + 5000;
    };
    const onEnter = () => {
      waiting.current = false;
    };
    html.addEventListener("pointerleave", onLeave);
    html.addEventListener("pointerenter", onEnter);

    let raf = 0;
    const tick = (now: number) => {
      // ── Rabbits: hop with an eased arc + squash, rest, repeat ──
      for (let i = 0; i < rabbits.current.length; i++) {
        const r = rabbits.current[i];
        let hopY = 0;
        let sy = 1;
        let lean = 0; // degrees: pitch up/down from the 2D hop vector
        if (r.hopping) {
          const p = (now - r.hopStart) / r.hopDur;
          if (p >= 1) {
            r.x = r.toX;
            r.y = r.toY;
            r.hopping = false;
            r.restUntil = now + 1000 + Math.random() * 2400; // lazy pauses between idle hops
          } else {
            const e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2; // easeInOutQuad
            r.x = r.fromX + (r.toX - r.fromX) * e;
            r.y = r.fromY + (r.toY - r.fromY) * e;
            hopY = Math.sin(p * Math.PI) * 24; // arc height
            sy = 1 + Math.sin(p * Math.PI) * 0.14; // stretch up mid-hop
            // Orient along the actual 2D hop vector: horizontal → facing (flip),
            // vertical → a lean (capped so it never goes fully upright/vertical),
            // eased over the hop so it leans into the leap and lands level.
            const vx = r.toX - r.fromX;
            const vy = r.toY - r.fromY;
            const pitch = Math.atan2(vy, Math.abs(vx) || 1) * (180 / Math.PI);
            lean = clamp(pitch, -46, 46) * Math.sin(p * Math.PI);
          }
        } else if (now > r.restUntil) {
          idleHop(r, now);
        }
        const el = rabbitEls.current[i];
        if (el) {
          el.style.transform = `translate3d(${r.x - RAB_W / 2}px, ${r.y - RAB_H - hopY}px, 0)`;
          const fl = el.firstElementChild as HTMLElement | null;
          if (fl) {
            fl.style.transform = `scaleX(${r.facing}) rotate(${lean}deg) scaleY(${sy})`;
          }
        }
      }

      const root = rootRef.current;
      if (root) {
        const catCx = pos.current.x + CAT_W / 2;
        const catCy = pos.current.y + CAT_H / 2;

        if (waiting.current && now >= waitUntil.current) {
          waiting.current = false; // waited long enough → go play
        }

        // Pick what to chase: sit where the mouse left (waiting for it to return),
        // else the pointer while you're moving it, else hunt a rabbit.
        let tx: number;
        let ty: number;
        // "Ignore mouse" mode → the pointer and wall-waiting are skipped entirely,
        // so the cat only ever hunts rabbits.
        const heedMouse = !napRef.current && !ignoreRef.current;
        const waitingNow = heedMouse && waiting.current;
        const pointerActive = heedMouse &&
          now - lastPointerMove.current < POINTER_GRACE;
        if (napRef.current) {
          tx = catCx; // nap: stay put
          ty = catCy;
        } else if (waitingNow) {
          tx = pointer.current.x; // walk to where the mouse left the window, then sit
          ty = pointer.current.y;
        } else if (pointerActive) {
          tx = pointer.current.x;
          ty = pointer.current.y;
        } else if (rabbits.current.length) {
          // Lock onto a rabbit for a while (re-pick the nearest on a timer) so the
          // cat commits to a hunt instead of flip-flopping between two rabbits.
          if (now > retargetAt.current) {
            let best = 0;
            let bd = Infinity;
            for (let i = 0; i < rabbits.current.length; i++) {
              const r = rabbits.current[i];
              const d = Math.hypot(r.x - catCx, r.y - catCy);
              if (d < bd) {
                bd = d;
                best = i;
              }
            }
            hunt.current = best;
            retargetAt.current = now + RETARGET_MS;
          }
          const r = rabbits.current[hunt.current];
          tx = r.x;
          ty = r.y;
          const d = Math.hypot(r.x - catCx, r.y - catCy);
          const cornered = (r.x < CORNER || r.x > vw() - CORNER) &&
            (r.y < CORNER || r.y > vh() - CORNER);
          if (cornered && d < CAPTURE) {
            // Trapped in a corner — the cat's agility wins. Point for the cat;
            // that rabbit respawns fresh elsewhere, and we re-pick a target.
            respawn(r, now);
            scorePoint();
            retargetAt.current = 0;
          } else if (!r.hopping && d < SCARE) {
            // In the open it bolts away (staying > FOLLOW), so the cat keeps
            // chasing without parking — a wild rabbit generally out-runs it.
            fleeHop(r, catCx, catCy, now);
          }
        } else {
          tx = catCx;
          ty = catCy;
        }

        // ── Chase with start/stop hysteresis so it parks cleanly (no walking in
        // place): start only when the target pulls clearly away, stop the instant
        // we're inside the rest ring. ──
        const dx = tx - catCx;
        const dy = ty - catCy;
        const dist = Math.hypot(dx, dy) || 1;
        if (napRef.current) {
          chasing.current = false;
        } else if (chasing.current) {
          if (dist <= FOLLOW) chasing.current = false;
        } else if (dist > FOLLOW + START) {
          chasing.current = true;
        }
        const running = chasing.current;
        if (running) {
          const step = Math.min(speedRef.current, dist - FOLLOW);
          pos.current.x += (dx / dist) * step;
          pos.current.y += (dy / dist) * step;
          if (Math.abs(dx) > 8) facing.current = dx < 0 ? -1 : 1;
        }
        // Collision with the window edges: keep the cat fully on-screen so it
        // presses up against the wall instead of wandering out of view.
        pos.current.x = clamp(pos.current.x, -6, vw() - CAT_W + 6);
        pos.current.y = clamp(pos.current.y, -6, vh() - CAT_H + 6);
        root.style.transform = `translate3d(${pos.current.x}px, ${pos.current.y}px, 0)`;
        const flip = flipRef.current;
        if (flip) flip.style.transform = `scaleX(${facing.current})`;
        root.classList.toggle("run", running);
        root.classList.toggle("nap", napRef.current);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      globalThis.removeEventListener("pointermove", move);
      html.removeEventListener("pointerleave", onLeave);
      html.removeEventListener("pointerenter", onEnter);
    };
  }, [enabled]);

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

      {Array.from({ length: RABBIT_COUNT }, (_, i) => (
        <div
          class="rabbit"
          key={i}
          ref={(el: HTMLDivElement | null) => {
            rabbitEls.current[i] = el;
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
    </div>
  );
}
