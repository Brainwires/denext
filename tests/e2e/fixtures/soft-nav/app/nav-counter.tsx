"use client";
import { useEffect, useState } from "denext";

// Lives in the layout: its state is the proof that a soft nav preserved the layout
// (a full reload or a layout remount would reset it to 0). `data-hydrated` appears once its
// effect has run: a click before then lands on the server's markup and is lost.
export function NavCounter() {
  const [n, setN] = useState(0);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  return (
    <button
      type="button"
      data-testid="navcount"
      data-hydrated={hydrated ? "" : undefined}
      onClick={() => setN((c) => c + 1)}
    >
      count: {n}
    </button>
  );
}
