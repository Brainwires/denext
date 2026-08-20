"use client";

// This island is interactive via an EFFECT, so resumable mode wakes it on idle (not
// on a click) — the framework picks the right moment with no directive. Its time is a
// `useSignal`, so the server's value is ADOPTED on resume: the first client render
// matches the server HTML (no hydration mismatch), then the interval ticks it.

import { useEffect, useSignal } from "denext";

let logged = false;

export function Clock() {
  if (typeof document !== "undefined" && !logged) {
    logged = true;
    console.log("⏱ clock resumed on idle (effect island)");
  }

  const now = useSignal(new Date().toLocaleTimeString());
  useEffect(() => {
    const t = setInterval(() => {
      now.value = new Date().toLocaleTimeString();
    }, 1000);
    return () => clearInterval(t);
  }, []);

  return (
    <div class="card">
      <div class="card-head">
        <span class="tag">clock (useEffect)</span>
        <span class="badge idle">useSignal · idle</span>
      </div>
      <time class="clock">{now.value}</time>
      <p class="hint">Ticks on its own — hydrated on idle, no click needed.</p>
    </div>
  );
}
