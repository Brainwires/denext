import { useContext, useEffect, useState } from "denext";
import { Theme } from "./theme.ts";

const w = globalThis as unknown as { __hydrated?: string[]; __loaded?: string[] };
// Runs when this module's chunk is evaluated: the page bundle does not carry it.
(w.__loaded ??= []).push("counter");

/** A counter that records when it hydrates (its effect runs). */
export function Counter({ label, start = 0 }: { label: string; start?: number }) {
  const [n, setN] = useState(start);
  const theme = useContext(Theme);
  useEffect(() => void (w.__hydrated ??= []).push(label), []);
  return (
    <button type="button" data-testid={label} onClick={() => setN(n + 1)}>
      {label} {theme} {n}
    </button>
  );
}
