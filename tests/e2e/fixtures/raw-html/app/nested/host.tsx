"use client";
import { useState } from "denext";
import { Inner } from "./inner.tsx";

// A client component rendering another client component that owns the raw-HTML host; the
// parent's own state re-renders the child.
export function Host() {
  const [n, setN] = useState(0);
  return (
    <section>
      <button type="button" data-testid="count" onClick={() => setN((v) => v + 1)}>
        count: {n}
      </button>
      <Inner n={n} />
    </section>
  );
}
