"use client";
import { useState } from "denext";

// A client island with local state. Editing the rendered marker below must hot-swap
// only this module and preserve the `count` state (single-island HMR). (Keep the
// marker token out of comments so a test's string replace only hits the JSX.)
export function Counter() {
  const [count, setCount] = useState(0);
  return (
    <button type="button" data-testid="island" onClick={() => setCount((c) => c + 1)}>
      ISLAND_V1 count: {count}
    </button>
  );
}
