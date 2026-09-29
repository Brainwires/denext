"use client";
import { useState } from "denext";

// Rendered only as a `client:load` island on /islands: the page the soft nav lands on must
// mount it even though the page the nav started from never loaded the islands runtime.
export function IslandCounter() {
  const [n, setN] = useState(0);
  return (
    <button type="button" data-testid="islandcount" onClick={() => setN((c) => c + 1)}>
      island: {n}
    </button>
  );
}
