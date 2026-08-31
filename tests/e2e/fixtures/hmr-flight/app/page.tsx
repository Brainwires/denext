import { Counter } from "./counter.tsx";

// A SERVER component route with a `"use client"` island — a Flight route. Under the
// unbundled dev loop, the island is served on its own @fs URL so editing it hot-swaps
// a single module in place.
export default function Page() {
  return (
    <section>
      <h1 data-testid="title">FLIGHT_PAGE</h1>
      <Counter />
    </section>
  );
}
