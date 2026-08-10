// "Smoothness under load" — a demo of denext's fiber concurrency that exercises
// exactly what the old cooperative scheduler could NOT do.
//
// The key to making the difference VISIBLE (and the trap the first version of
// this demo fell into) is *where* the cost lives:
//
//   • Only the RENDER phase is time-sliced — commitRoot() runs synchronously in
//     both modes. So the load has to be in rendering, not in mutating tens of
//     thousands of DOM nodes (that commit can't be sliced and would stall both
//     modes equally). We keep the grid modest and instead give each cell a
//     tunable synthetic render cost.
//   • That cost has to sit in a CHILD component so the reconciler can yield
//     between cells. Work done in the parent's render loop is one indivisible
//     unit and can't be interrupted. Hence the <Cell/> component below.
//
// With that, the two modes diverge sharply:
//   • Concurrent: the grid re-render is split across frames, so the rAF-driven
//     spinner and FPS counter keep advancing and the field stays typable while
//     it renders.
//   • Blocking: the same update is a plain setState — one unsliceable render —
//     so the spinner freezes and typing stalls until it finishes.
import { memo, useEffect, useRef, useState, useTransition } from "react";

// How hard each cell works during render. This is the knob that makes the
// difference perceptible — raise it if your machine is fast enough that even
// Blocking mode stays smooth, lower it if Concurrent mode also stutters.
const CELL_WORK = 12000;

// Deterministic per-cell hue, computed the slow way on purpose: the busy loop is
// the synthetic render cost, and returning a live value keeps the JIT from
// eliminating it. A new `count` shifts every hue, so the whole grid visibly
// repaints on each committed update.
function heavyHue(i: number, count: number): number {
  let h = (i * 2654435761) ^ (count * 40503);
  for (let k = 0; k < CELL_WORK; k++) h = (h ^ (h << 1) ^ k) >>> 0;
  return h % 360;
}

// A child component so each cell is its own unit of work the scheduler can yield
// between. (Do the same work in the parent's loop and it becomes one giant
// un-sliceable unit — Concurrent mode would stall just like Blocking.)
//
// memo() is essential, not an optimization: dragging the slider fires an urgent
// setSlider() that synchronously re-renders this page. Without memo, that sync
// render would drag all the heavy cells with it every drag event — so the grid
// would re-render on the blocking path in BOTH modes and neither would be
// smooth. With memo, a slider-only render skips every cell (their props are
// unchanged) and the heavy re-render happens ONLY when `count` changes — which
// in Concurrent mode is the time-sliced transition.
const Cell = memo(function Cell({ index, count }: { index: number; count: number }) {
  const h = heavyHue(index, count);
  return <div style={`background:hsl(${h} 70% 55%);width:8px;height:8px`} />;
});

export default function ConcurrencyPage() {
  const [input, setInput] = useState(""); // urgent: proves the field stays typable
  const [slider, setSlider] = useState(2500); // urgent: the slider thumb + label
  const [count, setCount] = useState(2500); // drives the heavy grid render
  const [blocking, setBlocking] = useState(false);
  const [isPending, startTransition] = useTransition();

  // Probes updated only from the rAF loop (never React state).
  const spinnerRef = useRef<HTMLDivElement>(null);
  const statsRef = useRef<HTMLPreElement>(null);
  const started = useRef(0); // transition renders kicked off
  const committed = useRef(0); // heavy grid commits that actually landed
  const frames = useRef(0); // rAF ticks (stalls if the main thread is blocked)

  // committed counter: a passive effect that runs once per committed `count`.
  useEffect(() => {
    committed.current++;
  }, [count]);

  // The animation + live probe. Runs entirely off React state via direct DOM, so
  // it keeps ticking between transition slices and reports the truth: if the
  // spinner stalls, the main thread was blocked.
  useEffect(() => {
    let raf = 0;
    let angle = 0;
    let last = performance.now();
    let fps = 0;
    const tick = (now: number) => {
      frames.current++;
      angle = (angle + 6) % 360;
      const dt = now - last;
      last = now;
      // Exponential moving average of instantaneous FPS.
      fps = fps === 0 ? 1000 / dt : fps * 0.9 + (1000 / dt) * 0.1;
      const spinner = spinnerRef.current;
      if (spinner) spinner.style.transform = `rotate(${angle}deg)`;
      const stats = statsRef.current;
      if (stats) {
        stats.textContent = `frames: ${frames.current}   ~fps: ${fps.toFixed(0)}\n` +
          `transition renders started:   ${started.current}\n` +
          `transition renders committed: ${committed.current}` +
          (started.current > committed.current
            ? `   (interrupted/coalesced ${started.current - committed.current})`
            : "");
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const onSlider = (e: Event) => {
    const v = Number((e.currentTarget as HTMLInputElement).value);
    setSlider(v); // urgent — the control stays responsive
    if (blocking) {
      setCount(v); // plain update: blocks the frame until the grid re-renders
    } else {
      started.current++;
      startTransition(() => setCount(v)); // time-sliced, interruptible
    }
  };

  const cells = [];
  for (let i = 0; i < count; i++) {
    cells.push(<Cell key={i} index={i} count={count} />);
  }

  return (
    <main style="font-family:system-ui,sans-serif;max-width:52rem;margin:2rem auto;padding:0 1rem">
      <h1>denext × concurrent rendering</h1>
      <p>
        The slider re-renders a grid of <strong>{count.toLocaleString()}</strong>{" "}
        cells, and each cell is deliberately slow to render. Watch the <strong>spinner</strong> and
        {" "}
        <strong>~fps</strong> as you drag:
      </p>
      <ul style="color:#374151;line-height:1.5">
        <li>
          <strong>Concurrent</strong>{" "}
          (default): the render is time-sliced, so the spinner keeps spinning and fps stays high —
          the grid catches up a frame or two behind your drag.
        </li>
        <li>
          <strong>Blocking</strong>{" "}
          (check the box): the same update runs in one shot, so the spinner freezes and fps craters
          until each render finishes.
        </li>
      </ul>
      <p style="color:#374151;line-height:1.5">
        Neither is strictly better — it's a trade-off. <strong>Blocking</strong>{" "}
        gets the grid to its final state sooner (one uninterrupted pass, no wasted work) but freezes
        everything else while it does; <strong>Concurrent</strong>{" "}
        keeps the UI alive at the cost of the grid trailing your drag, and does more total work
        (renders it starts then throws away — see started vs committed below).
      </p>

      <div style="display:flex;gap:1.5rem;align-items:center;margin:1rem 0">
        <div
          ref={spinnerRef}
          style="width:40px;height:40px;border:5px solid #ddd;border-top-color:#6d28d9;border-radius:50%"
        />
        <pre
          ref={statsRef}
          style="margin:0;font-size:.85rem;color:#374151;line-height:1.4"
        />
      </div>

      <label style="display:block;margin:.75rem 0">
        <input
          type="checkbox"
          checked={blocking}
          onChange={(e: Event) => setBlocking((e.currentTarget as HTMLInputElement).checked)}
        />{" "}
        Blocking mode — plain setState, one un-interruptible render
      </label>

      <input
        type="range"
        min={500}
        max={5000}
        step={250}
        value={slider}
        onInput={onSlider}
        style="width:100%"
      />
      <p style="min-height:1.5em;color:#6d28d9">
        {isPending
          ? "rendering grid… (spinner still moving → main thread free)"
          : `grid: ${count.toLocaleString()} cells`}
      </p>

      <p style="color:#374151;margin:.25rem 0 .5rem">
        The urgent-input test: drag to the far right and{" "}
        <em>release</em>, then immediately type below. In Concurrent mode your keystrokes appear
        instantly while the grid renders in the background; in Blocking mode the field is frozen
        until it finishes.
      </p>
      <input
        type="text"
        value={input}
        onInput={(e: Event) => setInput((e.currentTarget as HTMLInputElement).value)}
        placeholder="type here right after releasing the slider"
        style="font:inherit;padding:.5rem .75rem;width:100%;box-sizing:border-box;margin-bottom:1rem"
      />

      <div style="display:flex;flex-wrap:wrap;gap:2px">
        {cells}
      </div>
    </main>
  );
}
