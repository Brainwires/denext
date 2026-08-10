// A useTransition demo on denext's cooperative priority scheduler. Typing updates
// the input urgently (the field stays responsive), while filtering a large list is
// scheduled as a low-priority transition — so `isPending` shows and the browser can
// paint/handle input before the heavy list re-render commits.
import { useMemo, useState, useTransition } from "react";

const ITEMS: string[] = Array.from(
  { length: 8000 },
  (_, i) => `Item ${i} — ${((i * 2654435761) % 1000000).toString(36)}`,
);

export default function TransitionsPage() {
  const [input, setInput] = useState(""); // urgent: keeps the input responsive
  const [query, setQuery] = useState(""); // deferred: drives the expensive filter
  const [isPending, startTransition] = useTransition();

  const results = useMemo(
    () => (query ? ITEMS.filter((s) => s.includes(query)) : ITEMS).slice(0, 200),
    [query],
  );

  const onInput = (e: Event) => {
    const value = (e.currentTarget as HTMLInputElement).value;
    setInput(value); // urgent — the field updates immediately
    startTransition(() => setQuery(value)); // low priority — the big list re-render
  };

  return (
    <main style="font-family:system-ui,sans-serif;max-width:44rem;margin:3rem auto;padding:0 1rem">
      <h1>denext × useTransition</h1>
      <p>
        Filtering {ITEMS.length.toLocaleString()} items. The input is an <strong>urgent</strong>
        {" "}
        update (stays responsive); the filtered list is a <strong>transition</strong>{" "}
        (low priority), so the browser paints and handles your keystrokes before the heavy re-render
        commits.
      </p>
      <input
        type="text"
        value={input}
        onInput={onInput}
        placeholder="type to filter…"
        style="font:inherit;padding:.5rem .75rem;width:100%;box-sizing:border-box"
      />
      <p style="min-height:1.5em;color:#6d28d9">
        {isPending ? "updating list…" : `${results.length} shown`}
      </p>
      <ul>
        {results.map((s) => <li key={s}>{s}</li>)}
      </ul>
    </main>
  );
}
