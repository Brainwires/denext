// A plain `.ts` client module (a hook, not a component file): its awaited transition must keep
// its scope too, so the AsyncContext pass instruments it as it does `.tsx` modules.
import { useState, useTransition } from "denext";

/** A counter whose `run(gate, by)` adds `by` in an async transition once `gate` resolves. */
export function useGatedCounter() {
  const [n, setN] = useState(0);
  const [pending, start] = useTransition();
  const run = (gate: Promise<void>, by: number) =>
    start(async () => {
      await gate;
      setN((x) => x + by);
    });
  return { n, setN, pending, run };
}
