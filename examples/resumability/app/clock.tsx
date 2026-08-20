"use client";

// This island is interactive via an EFFECT, not a handler — it must run to start its
// interval. Resumable mode notices the effect and wakes it on idle (not on click), so
// it ticks on its own shortly after load, while the counters stay dormant until you
// touch them. No directive needed — the framework picks the right moment.

import { useEffect, useState } from "denext";

// The clock re-renders every second (its interval updates the time), so log its
// resume just once — not on every tick.
let logged = false;

export function Clock() {
  const resumed = typeof document !== "undefined";
  if (resumed && !logged) {
    logged = true;
    console.log("⏱ clock resumed on idle (effect island)");
  }

  const [now, setNow] = useState(() => new Date().toLocaleTimeString());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date().toLocaleTimeString()), 1000);
    return () => clearInterval(t);
  }, []);

  return (
    <div class="card">
      <div class="card-head">
        <span class="tag">clock (useEffect)</span>
        <span class={resumed ? "badge on" : "badge idle"}>
          {resumed ? "resumed on idle ✅" : "dormant · server HTML"}
        </span>
      </div>
      <time class="clock">{now}</time>
      <p class="hint">
        {resumed ? "Ticking — hydrated on idle, no click needed." : "Waiting to hydrate on idle…"}
      </p>
    </div>
  );
}
