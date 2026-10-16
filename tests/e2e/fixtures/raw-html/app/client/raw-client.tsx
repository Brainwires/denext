"use client";
import { useState } from "denext";
import { RAW } from "../raw.ts";

// A client component that renders the raw-HTML host itself, and re-renders on a click (a fresh
// `{ __html }` object of the same markup each time).
export function RawClient() {
  const [n, setN] = useState(0);
  return (
    <div>
      <div id="raw" dangerouslySetInnerHTML={{ __html: RAW }} />
      <button type="button" data-testid="count" onClick={() => setN((v) => v + 1)}>
        count: {n}
      </button>
    </div>
  );
}
