import { useState } from "denext";

(globalThis as { __loaded?: Record<string, boolean> }).__loaded ??= {};
(globalThis as unknown as { __loaded: Record<string, boolean> }).__loaded.panel = true;

// Mounted by the click on its placeholder (same shape: a section holding the button), which is
// replayed on this button: the first click already counts.
export function Panel(props: { label?: string; title?: string; count?: number }) {
  const [clicks, setClicks] = useState(0);
  return (
    <section data-testid="panel">
      Panel {props.label ?? props.title ?? ""} {props.count ?? ""}
      <button type="button" data-testid="panel-btn" onClick={() => setClicks((c) => c + 1)}>
        clicked {clicks}
      </button>
    </section>
  );
}
