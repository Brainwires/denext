// The signal brand and the server→client hand-off of a signal passed as a client component's
// prop. A reactive signal (`denext/signals`, Preact Signals' API) carries the same brand as
// `@preact/signals` (`Symbol.for("preact-signals")`). The Flight serializers write such a prop as
// `{ $: "sg", i, v }` (its id and current value); the client revives it as a live signal through
// the reviver `denext/signals` installs when it loads, so two islands handed the same server
// signal share one client signal, as they do in Fresh. Without the module the value arrives
// plain.

/** The brand every Preact-compatible signal carries (`signal.brand`). */
export const SIGNAL_BRAND: symbol = /* @__PURE__ */ Symbol.for("preact-signals");

/** Where `denext/signals` installs its reviver (a global slot: no client import is needed). */
const REVIVER_KEY = /* @__PURE__ */ Symbol.for("denext.signals.revive");

/** A branded signal, as far as serialization needs it. */
export interface BrandedSignal {
  /** The brand ({@link SIGNAL_BRAND}). */
  brand: symbol;
  /** The current value, read without subscribing. */
  peek(): unknown;
}

/**
 * Whether `value` is a branded signal.
 *
 * @param value Any value.
 * @returns True for a `denext/signals` or `@preact/signals` signal.
 */
export function isSignal(value: unknown): value is BrandedSignal {
  return typeof value === "object" && value !== null &&
    (value as { brand?: unknown }).brand === SIGNAL_BRAND;
}

/** Ids handed out to serialized signals (one per signal object, process-wide). */
const wireIds = new WeakMap<object, number>();
let nextWireId = 0;

/**
 * The stable id a signal crosses the wire with: the same signal passed to two client components
 * gets the same id, so the client revives one shared signal for both.
 *
 * @param signal A branded signal.
 * @returns Its id.
 */
export function signalWireId(signal: object): number {
  let id = wireIds.get(signal);
  if (id === undefined) wireIds.set(signal, id = nextWireId++);
  return id;
}

/** The reviver `denext/signals` installs: a decoded value + wire id → a live signal. */
export type SignalReviver = (value: unknown, id: number | undefined) => unknown;

/**
 * Install the reviver the decoders call for a serialized signal (`denext/signals` does this when
 * it loads).
 *
 * @param reviver The reviver.
 */
export function setSignalReviver(reviver: SignalReviver): void {
  (globalThis as { [REVIVER_KEY]?: SignalReviver })[REVIVER_KEY] = reviver;
}

/**
 * Revive a decoded `{ $: "sg" }` value: a live signal when `denext/signals` has loaded, else the
 * plain value.
 *
 * @param value The decoded value.
 * @param id The wire id.
 * @returns The signal, or `value`.
 */
export function reviveSignal(value: unknown, id: unknown): unknown {
  const reviver = (globalThis as { [REVIVER_KEY]?: SignalReviver })[REVIVER_KEY];
  return reviver ? reviver(value, typeof id === "number" ? id : undefined) : value;
}
