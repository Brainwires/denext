"use client";
import { useEffect, useState } from "denext";

// Client state that must survive a Server Action refresh of the page: the island is adopted,
// not remounted. It also counts document `ping` events, so a leaked (un-cleaned) listener after
// the island is gone would show up in `__pings`.
export function Counter() {
  const [n, setN] = useState(0);
  useEffect(() => {
    const on = () => {
      (globalThis as { __pings?: number }).__pings =
        ((globalThis as { __pings?: number }).__pings ?? 0) + 1;
    };
    document.addEventListener("ping", on);
    return () => document.removeEventListener("ping", on);
  }, []);
  return (
    <button type="button" data-testid="count" onClick={() => setN((c) => c + 1)}>
      count: {n}
    </button>
  );
}
