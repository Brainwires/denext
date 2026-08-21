"use client";

// A perfectly ordinary client component — useState + onClick, no qrl, no directive.
// It renders identically on the server and the client (so there is no hydration
// mismatch): resumption is transparent, which is the whole point. The proof it did
// NOT hydrate on load is the console — the body runs only when the island wakes, so
// each counter logs exactly once, for the one you click.

import { useRef, useState } from "denext";

// Guarded so the body re-running (on each click) logs the resume only once.
const logged = new Set<number>();

export function Counter({ id }: { id: number }) {
  // A side effect, not render output — so it never causes a hydration mismatch. It
  // runs only in the browser, the first time this island's component executes.
  if (typeof document !== "undefined" && !logged.has(id)) {
    logged.add(id);
    console.log(`▶ counter ${id} resumed — only this island hydrated`);
  }

  // Total renders. It is 1 after the single server render AND 1 after the single
  // hydration render (they match — no mismatch); it climbs only on real re-renders.
  const renders = useRef(0);
  renders.current++;

  const [n, setN] = useState(0);
  return (
    <div class="card">
      <div class="card-head">
        <span class="tag">counter {id}</span>
        <span class="badge live">renders: {renders.current}</span>
      </div>
      <button type="button" onClick={() => setN((c) => c + 1)}>
        Clicked {n} {n === 1 ? "time" : "times"}
      </button>
      <p class="hint">
        Frozen at <strong>1</strong>{" "}
        (the server render) until you click — then it resumes and re-renders. The counters you never
        touch stay at 1: zero client work.
      </p>
    </div>
  );
}
