// Signal state transport — the server-side collector, plus adoption of the map
// the client installs before hydration.
//
// A signal is keyed by its `useId()` value (position-derived, so server and client
// agree). On the server, every signal records its value here during render; the
// map is serialized into a `#__denext_state` island. On the client, the generated
// entry installs that map on a well-known GLOBAL (no framework import — so this
// module never enters the shared chunk unless the app actually uses signals), and
// each `useSignal`/`useStore` adopts its value instead of recomputing the initializer.

import { renderScope } from "./render-scope.ts";

/** The global the entry parks the adopted state on (set with no import). */
const GLOBAL_KEY = "__denextSignalState";

// The server-side collector lives on the per-request render scope (see `render-scope.ts`):
// concurrent renders must not record into each other's maps.

/**
 * Begin capturing signal values (server render). Pair with {@link endSignalCollection}, or
 * call the returned finisher — it is bound to the scope that began the collection, so a
 * caller that finishes LATER (after the request's async context is gone, e.g. a PPR resume
 * whose holes settle into the stream) still reads the right map.
 */
export function beginSignalCollection(): () => Record<string, unknown> {
  const scope = renderScope();
  scope.signals = {};
  return () => {
    const out = scope.signals ?? {};
    scope.signals = null;
    return out;
  };
}

/** Finish capturing and return the collected `{ id → value }` map (server render). */
export function endSignalCollection(): Record<string, unknown> {
  const scope = renderScope();
  const out = scope.signals ?? {};
  scope.signals = null;
  return out;
}

/** Record a signal's current value under its id (no-op when not collecting). */
export function recordSignal(id: string, value: unknown): void {
  const { signals } = renderScope();
  if (signals !== null) signals[id] = value;
}

/**
 * Install the adopted signal-state map (used by tests; the generated entry sets
 * the same global directly so this module stays off the shared chunk).
 */
export function setAdoptedSignalState(map: Record<string, unknown> | null): void {
  (globalThis as Record<string, unknown>)[GLOBAL_KEY] = map ?? undefined;
}

/**
 * Adopt a signal-state value parsed from `#__denext_state`, rebuilt into a fresh
 * object with prototype-polluting keys dropped — the same `__proto__`/`constructor`/
 * `prototype` filter `parseFlight` applies to Flight-transported objects, so this
 * (the one other client-adopted payload) doesn't bypass it.
 */
export function adoptSignalState(raw: unknown): void {
  if (!raw || typeof raw !== "object") {
    setAdoptedSignalState(null);
    return;
  }
  const clean: Record<string, unknown> = {};
  for (const k of Object.keys(raw as Record<string, unknown>)) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
    clean[k] = (raw as Record<string, unknown>)[k];
  }
  setAdoptedSignalState(clean);
}

/**
 * The adopted value for `id` boxed in `{ value }`, or `null` if none. Boxed rather
 * than using a module-level sentinel so this module has no top-level side effect
 * and tree-shakes out of apps that never use signals.
 */
export function adoptedSignal(id: string): { value: unknown } | null {
  const map = (globalThis as Record<string, unknown>)[GLOBAL_KEY] as
    | Record<string, unknown>
    | undefined;
  if (map && Object.prototype.hasOwnProperty.call(map, id)) return { value: map[id] };
  return null;
}
