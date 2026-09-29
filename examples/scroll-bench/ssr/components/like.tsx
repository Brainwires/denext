"use client";

// The per-row control: a like toggle. An ordinary client component (state + onClick), so the
// same code runs as a client:load island, a resumable island (wakes on the first click) and a
// row of the VirtualList island.

import { useEffect, useState } from "denext";
import { markHydrated } from "./hydrated.ts";

/** A like toggle. No effect: in a resumable route it stays asleep until clicked. */
export function Like() {
  const [on, setOn] = useState(false);
  return (
    <button
      type="button"
      className="sb-like"
      aria-pressed={on ? "true" : "false"}
      aria-label="Like"
      onClick={() => setOn(!on)}
    >
      {on ? "♥" : "♡"}
    </button>
  );
}

/** {@link Like} that reports its hydration (the `client:load` islands impl). */
export function TrackedLike() {
  useEffect(() => markHydrated(), []);
  return <Like />;
}
