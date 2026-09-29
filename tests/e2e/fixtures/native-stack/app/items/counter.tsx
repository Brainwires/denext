"use client";
import { useState } from "denext";

// Its count is the proof that the list screen was kept (a remount resets it).
export function Counter() {
  const [n, setN] = useState(0);
  return (
    <button type="button" data-testid="count" onClick={() => setN((c) => c + 1)}>
      count: {n}
    </button>
  );
}
