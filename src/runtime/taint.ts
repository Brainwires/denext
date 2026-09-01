// React `taint*` (experimental): mark values that must never cross the server→client
// (RSC/Flight) boundary. `taintObjectReference` blocks a specific object reference;
// `taintUniqueValue` blocks a specific secret string/bigint. Enforcement lives in the
// Flight serializer (`src/jsx/render-to-html-flight.ts`), which calls
// {@linkcode taintMessageFor} before serializing any value and throws when it is tainted.
//
// This is defense-in-depth — a guardrail against *accidentally* passing a secret to a
// client component — not a substitute for not handing secrets to the client in the first
// place (React documents the same). When nothing is tainted, the check is two empty-map
// lookups per serialized value.

const DEFAULT_MESSAGE =
  "A tainted value was about to be sent to the client. Do not pass it across the " +
  "server/client boundary.";

/** Object references that must not be serialized to the client. Weak → auto-released. */
const taintedObjects = new WeakMap<object, string>();
/** Unique secret values (string/bigint) that must not be serialized to the client. */
const taintedValues = new Map<string | bigint, string>();
/** Release a tainted value when its `lifetime` object is garbage-collected. */
const lifetimeRegistry = new FinalizationRegistry<string | bigint>((value) => {
  taintedValues.delete(value);
});

/**
 * `experimental_taintObjectReference(message, object)` — block a specific object reference
 * from being serialized to a client component. The taint is tied to the reference (a
 * structurally-identical copy is a different reference and is not blocked).
 */
export function experimental_taintObjectReference(
  message: string | undefined,
  object: object,
): void {
  if (object === null || (typeof object !== "object" && typeof object !== "function")) {
    throw new TypeError(
      "taintObjectReference: expected an object reference (use taintUniqueValue for a " +
        "string/bigint).",
    );
  }
  taintedObjects.set(object, message || DEFAULT_MESSAGE);
}

/**
 * `experimental_taintUniqueValue(message, lifetime, value)` — block a specific secret
 * **value** (a string or bigint, e.g. an API key or session token) from being serialized
 * to a client component. The taint lives as long as `lifetime` is reachable (when
 * `lifetime` is garbage-collected the taint is released), matching React's contract.
 */
export function experimental_taintUniqueValue(
  message: string | undefined,
  lifetime: object,
  value: string | bigint,
): void {
  if (lifetime === null || (typeof lifetime !== "object" && typeof lifetime !== "function")) {
    throw new TypeError("taintUniqueValue: `lifetime` must be an object.");
  }
  if (typeof value !== "string" && typeof value !== "bigint") {
    // React also accepts a TypedArray; for those taint the reference instead.
    throw new TypeError(
      "taintUniqueValue: `value` must be a string or bigint (use taintObjectReference " +
        "for an object or a typed array).",
    );
  }
  taintedValues.set(value, message || DEFAULT_MESSAGE);
  lifetimeRegistry.register(lifetime, value);
}

/**
 * The taint message for `value` if it is tainted, else `undefined`. Called by the Flight
 * serializer before a value crosses to the client; a defined result means "refuse to send
 * this — throw the message". Two empty-map lookups when nothing is tainted.
 */
export function taintMessageFor(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const t = typeof value;
  if (t === "object" || t === "function") return taintedObjects.get(value as object);
  if (t === "string" || t === "bigint") return taintedValues.get(value as string | bigint);
  return undefined;
}
