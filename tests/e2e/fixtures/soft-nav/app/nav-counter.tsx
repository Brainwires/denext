"use client";
import { useState } from "denext";

// Lives in the layout: its state is the proof that a soft nav preserved the layout
// (a full reload or a layout remount would reset it to 0).
export function NavCounter() {
  const [n, setN] = useState(0);
  return (
    <button type="button" data-testid="navcount" onClick={() => setN((c) => c + 1)}>
      count: {n}
    </button>
  );
}
