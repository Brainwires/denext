// Signal state transport — the server-side collector, plus adoption of the map
// the client installs before hydration.
//
// A signal is keyed by its `useId()` value (position-derived, so server and client
// agree). On the server, every signal records its value here during render; the
// map is serialized into a `#__denext_state` island. On the client, the generated
// entry installs that map on a well-known GLOBAL (no framework import — so this
// module never enters the shared chunk unless the app actually uses signals), and
// each `useSignal`/`useStore` adopts its value instead of recomputing the initializer.

/** The global the entry parks the adopted state on (set with no import). */
const GLOBAL_KEY = "__denextSignalState";

/** Server-side collector, active only during a render that captures signal state. */
let collector: Record<string, unknown> | null = null;

/** Begin capturing signal values (server render). Pair with {@link endSignalCollection}. */
export function beginSignalCollection(): void {
  collector = {};
}

/** Finish capturing and return the collected `{ id → value }` map (server render). */
export function endSignalCollection(): Record<string, unknown> {
  const out = collector ?? {};
  collector = null;
  return out;
}

/** Record a signal's current value under its id (no-op when not collecting). */
export function recordSignal(id: string, value: unknown): void {
  if (collector !== null) collector[id] = value;
}

/**
 * Install the adopted signal-state map (used by tests; the generated entry sets
 * the same global directly so this module stays off the shared chunk).
 */
export function setAdoptedSignalState(map: Record<string, unknown> | null): void {
  (globalThis as Record<string, unknown>)[GLOBAL_KEY] = map ?? undefined;
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
