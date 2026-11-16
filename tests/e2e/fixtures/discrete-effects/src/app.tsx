// A menu that closes on an outside pointerdown or Escape, through `window` capture listeners its
// open-state effect adds. The effect of the click that opened it must be in place before the next
// input event: a browser runs input tasks ahead of timers, so an effect left to a timer misses a
// fast outside click. A search button shows an input its effect focuses, so the next key press
// lands there. Another button bumps a counter inside `startTransition`, whose effect stays
// deferred, and a timer-driven update does the same.
import { startTransition, useEffect, useRef, useState } from "denext";

/** What the effects did, read by the test. */
const seen = { effectRuns: [] as string[] };
(globalThis as unknown as { __seen: typeof seen }).__seen = seen;

/** Whether the event started inside the menu or its trigger. */
const inMenu = (e: Event) => !!(e.target as Element).closest?.("[data-menu]");

export function App() {
  const [open, setOpen] = useState(false);
  const [n, setN] = useState(0);
  const [searching, setSearching] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (searching) search.current!.focus();
  }, [searching]);
  useEffect(() => {
    if (!open) return;
    seen.effectRuns.push("menu");
    const onDown = (e: Event) => void (inMenu(e) || setOpen(false));
    const onKey = (e: KeyboardEvent) => void (e.key === "Escape" && setOpen(false));
    globalThis.addEventListener("pointerdown", onDown, true);
    globalThis.addEventListener("keydown", onKey, true);
    return () => {
      globalThis.removeEventListener("pointerdown", onDown, true);
      globalThis.removeEventListener("keydown", onKey, true);
    };
  }, [open]);
  useEffect(() => {
    if (n > 0) seen.effectRuns.push(`count ${n}`);
  }, [n]);
  return (
    <main>
      <h1 data-ready="1">Discrete effects</h1>
      <button type="button" data-testid="trigger" data-menu onClick={() => setOpen(true)}>
        Menu
      </button>
      {open && (
        <ul data-testid="menu" data-menu>
          <li>Item</li>
        </ul>
      )}
      <button
        type="button"
        data-testid="transition"
        onClick={() => startTransition(() => setN((x) => x + 1))}
      >
        {`Count ${n}`}
      </button>
      <button type="button" data-testid="search-open" onClick={() => setSearching(true)}>
        Search
      </button>
      {searching && <input data-testid="search" ref={search} />}
      <p data-testid="outside">Outside</p>
    </main>
  );
}
