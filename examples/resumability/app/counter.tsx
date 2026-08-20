"use client";

// A perfectly ordinary client component — useState + onClick, no qrl, no directive.
// In a resumable route it is NOT hydrated on load: the server sends its HTML and
// nothing runs. The component body executes only when the island wakes (here, on the
// first click), so `resumed` is false in the server HTML and true once it resumes —
// and the console.log fires exactly once, for the counter you actually clicked.

import { useState } from "denext";

export function Counter({ id }: { id: number }) {
  // `document` exists only in the browser, so this is false in the server HTML and
  // true once this island's component runs on the client (i.e. once it resumes).
  const resumed = typeof document !== "undefined";
  if (resumed) {
    console.log(`▶ counter ${id} resumed — only this island hydrated`);
  }

  const [n, setN] = useState(0);
  return (
    <div class="card">
      <div class="card-head">
        <span class="tag">counter {id}</span>
        <span class={resumed ? "badge on" : "badge off"}>
          {resumed ? "resumed ✅" : "dormant · server HTML"}
        </span>
      </div>
      <button type="button" onClick={() => setN((c) => c + 1)}>
        Clicked {n} {n === 1 ? "time" : "times"}
      </button>
      <p class="hint">
        {resumed
          ? "This island is live now."
          : "Not hydrated. The first click wakes it and is replayed to the handler."}
      </p>
    </div>
  );
}
