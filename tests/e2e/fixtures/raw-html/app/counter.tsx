"use client";
import { useState } from "denext";

// A stateful client island: clicking it proves the page hydrated.
export function Counter() {
  const [n, setN] = useState(0);
  return (
    <button type="button" data-testid="count" onClick={() => setN((v) => v + 1)}>
      count: {n}
    </button>
  );
}
