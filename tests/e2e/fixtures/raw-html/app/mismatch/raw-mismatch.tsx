"use client";
import { useState } from "denext";
import { RAW } from "../raw.ts";

// A client component whose `__html` differs between the server render and the browser (a
// server/client branch). As in React 19, hydration keeps the server's markup — it is not
// patched up — and a re-render with the same client `__html` leaves it alone too.
export function RawMismatch() {
  const [n, setN] = useState(0);
  const html = typeof document === "undefined" ? RAW : "<u>client</u>";
  return (
    <div>
      <div id="raw" dangerouslySetInnerHTML={{ __html: html }} />
      <button type="button" data-testid="count" onClick={() => setN((v) => v + 1)}>
        count: {n}
      </button>
    </div>
  );
}
