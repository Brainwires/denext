// "Smoothness under load" — a demo of denext's fiber concurrency that exercises
// exactly what the old cooperative scheduler could NOT do:
//
//   • Time-slicing: re-rendering a huge grid inside a transition is split across
//     frames, so a requestAnimationFrame-driven spinner and a frame counter keep
//     advancing during the render (the main thread is never blocked for a whole
//     render). Flip to "Blocking" mode to feel the difference — the same update as
//     a plain setState freezes the spinner until it finishes.
//   • Interruption: dragging the slider fast starts many transition renders but
//     only the latest commits — the "started / committed" counter shows the work
//     the reconciler threw away by interrupting in-flight renders.
//
// The spinner, FPS, and started/committed counters are driven directly from the
// rAF loop (not React state), so they never themselves interrupt the transition —
// they are a truthful probe of whether the main thread stayed free.
import { useEffect, useRef, useState, useTransition } from "react";

// Deterministic per-cell hue so a new count visibly repaints the whole grid.
function hue(i: number, count: number): number {
  return ((i * 2654435761) ^ (count * 40503)) % 360;
}

export default function ConcurrencyPage() {
  const [input, setInput] = useState(""); // urgent: proves the field stays typable
  const [slider, setSlider] = useState(6000); // urgent: the slider thumb + label
  const [count, setCount] = useState(6000); // drives the heavy grid render
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
  // it keeps ticking between transition slices and reports the truth.
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
    cells.push(
      <div
        key={i}
        style={`background:hsl(${hue(i, count)} 70% 55%);width:6px;height:6px`}
      />,
    );
  }

  return (
    <main style="font-family:system-ui,sans-serif;max-width:52rem;margin:2rem auto;padding:0 1rem">
      <h1>denext × concurrent rendering</h1>
      <p>
        The slider re-renders a grid of <strong>{count.toLocaleString()}</strong> cells. In{" "}
        <strong>Concurrent</strong>{" "}
        mode that render is time-sliced, so the spinner and FPS below keep moving and the text field
        stays typable while it renders. Switch to <strong>Blocking</strong>{" "}
        mode and drag — the spinner freezes until each render finishes.
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
        Blocking mode (plain setState — no transition)
      </label>

      <input
        type="range"
        min={1000}
        max={25000}
        step={1000}
        value={slider}
        onInput={onSlider}
        style="width:100%"
      />
      <p style="min-height:1.5em;color:#6d28d9">
        {isPending
          ? "rendering grid… (UI still responsive)"
          : `grid: ${count.toLocaleString()} cells`}
      </p>

      <input
        type="text"
        value={input}
        onInput={(e: Event) => setInput((e.currentTarget as HTMLInputElement).value)}
        placeholder="type here while dragging — stays responsive in Concurrent mode"
        style="font:inherit;padding:.5rem .75rem;width:100%;box-sizing:border-box;margin-bottom:1rem"
      />

      <div style="display:flex;flex-wrap:wrap;gap:2px">
        {cells}
      </div>
    </main>
  );
}
