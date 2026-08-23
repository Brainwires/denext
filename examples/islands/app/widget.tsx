"use client";

// One ordinary client component, reused with every directive. It renders the same
// markup on the server and the client (no hydration mismatch). The proof that a
// given island has hydrated is the effect: `useEffect` runs only after this island's
// strategy fires, so the badge flips from "SSR (inert)" to "hydrated ✓" and the
// console logs exactly once — per island, on its own schedule. The counter button
// proves the island is actually interactive once awake.

import { useEffect, useState } from "denext";

export function Widget({ label }: { label: string }) {
  const [hydrated, setHydrated] = useState(false);
  const [n, setN] = useState(0);

  useEffect(() => {
    setHydrated(true);
    console.log(`island:${label} hydrated`);
  }, []);

  return (
    <div class="island" data-label={label}>
      <div class="island-head">
        <code class="tag">client:{label}</code>
        <span class={hydrated ? "badge live" : "badge"}>
          {hydrated ? "hydrated ✓" : "SSR (inert)"}
        </span>
      </div>
      <button type="button" onClick={() => setN((c) => c + 1)}>
        clicked {n}×
      </button>
    </div>
  );
}
