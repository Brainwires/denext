import { Counter } from "./counter.tsx";

const w = globalThis as unknown as { __loaded?: string[] };
// Runs when this module's chunk is evaluated: not until the island scrolls into view.
(w.__loaded ??= []).push("far");

/** The below-the-fold island: its own module, so its own chunk. */
export function Far({ label, start }: { label: string; start: number }) {
  return <Counter label={label} start={start} />;
}
