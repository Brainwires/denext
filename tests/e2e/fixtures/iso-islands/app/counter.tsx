import { useEffect, useState } from "denext";

const w = globalThis as unknown as { __hydrated?: string[] };

/** A counter that records when it hydrates (its effect runs). */
export function Counter({ label }: { label: string }) {
  const [n, setN] = useState(0);
  useEffect(() => void (w.__hydrated ??= []).push(label), []);
  return (
    <button type="button" data-testid={label} onClick={() => setN(n + 1)}>
      {label} {n}
    </button>
  );
}
