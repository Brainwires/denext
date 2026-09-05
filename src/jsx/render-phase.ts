// Render-phase state on the server — a leaf module (no imports) shared by the string renderer
// and the renderer base, so neither has to import the other.
//
// React re-renders a component in place when it calls `setState` DURING its own render (the
// "derive state from props" idiom); the server must converge the same way or SSR and
// hydration disagree. A synchronous component invocation owns one slot list; its hooks read
// and write those slots and a write marks the pass dirty, which re-invokes the component.

interface RenderPhase {
  slots: unknown[];
  cursor: number;
  dirty: boolean;
}

let renderPhase: RenderPhase | null = null;

/** React's limit before "Maximum update depth exceeded". */
const MAX_SSR_RENDER_PASSES = 25;

/** Run `fn` (a component call) with render-phase state, re-invoking until it stabilizes. */
export function invokeWithRenderPhase(fn: () => unknown): unknown {
  const prev = renderPhase;
  const phase: RenderPhase = { slots: [], cursor: 0, dirty: false };
  renderPhase = phase;
  try {
    let result = fn();
    let passes = 0;
    // An async component (a Promise) cannot be re-run synchronously; its post-await setState
    // calls are ignored (the setter checks it still owns the live phase).
    while (phase.dirty && !(result instanceof Promise)) {
      if (++passes > MAX_SSR_RENDER_PASSES) {
        throw new Error(
          "denext: Maximum update depth exceeded. A component repeatedly schedules an " +
            "update during its own render (e.g. calling setState unconditionally while rendering).",
        );
      }
      phase.dirty = false;
      phase.cursor = 0;
      result = fn();
    }
    return result;
  } finally {
    renderPhase = prev;
  }
}

/**
 * A `useState`/`useReducer` slot for the component being rendered on the server: the value
 * persists across that component's render-phase passes, and the setter re-runs the render.
 * Outside a synchronous invocation the value is fresh and the setter a no-op (as before).
 */
export function ssrStateSlot<S>(init: () => S): [S, (next: S | ((prev: S) => S)) => void] {
  const phase = renderPhase;
  if (!phase) return [init(), () => {}];
  const i = phase.cursor++;
  if (!(i in phase.slots)) phase.slots[i] = init();
  const value = phase.slots[i] as S;
  return [value, (next) => {
    if (renderPhase !== phase) return; // after the sync pass (an async continuation): ignore
    const prevValue = phase.slots[i] as S;
    const resolved = typeof next === "function" ? (next as (p: S) => S)(prevValue) : next;
    if (Object.is(resolved, prevValue)) return;
    phase.slots[i] = resolved;
    phase.dirty = true;
  }];
}
