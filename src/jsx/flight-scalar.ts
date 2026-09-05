// Shared scalar (leaf) serialization for denext's Flight serializers.
//
// The streaming Flight, HTML-flight, and PPR renderers each serialize props into a
// FlightValue tree. Their per-node structure differs (host nodes, client references,
// `$`-key escaping, PPR provider scopes), but the LEAF cascade — primitives, a
// server-action / qrl reference, a dropped function, a Date, and a thenable (a Remix
// `defer()` field / promise passed as data) — is identical across all three. This
// module owns that cascade so a fix for a leaf case (e.g. resolving a deferred promise)
// lands in ONE place and can't drift between the serializers.

import { isServerAction } from "../runtime/server-action.ts";
import { isAsyncProps } from "../runtime/async-props.ts";
import { isQrl } from "../runtime/qrl.ts";
import { isThenable } from "../runtime/suspense.ts";
import type { FlightValue } from "./render-to-flight.ts";

/**
 * The outcome of serializing a leaf value. `compound` hands an array / VNode / plain
 * object back to the caller (whose structure is serializer-specific); `thenable` asks
 * the caller to resolve the promise and re-serialize the result.
 */
export type ScalarResult =
  | { kind: "value"; value: FlightValue }
  | { kind: "skip" }
  | { kind: "thenable"; promise: PromiseLike<unknown> }
  | { kind: "compound" };

const SKIP_RESULT: ScalarResult = { kind: "skip" };
const COMPOUND_RESULT: ScalarResult = { kind: "compound" };

/**
 * Serialize the leaf-value cases every Flight serializer shares. Returns `skip`
 * (`undefined` or a function — dropped), a serialized `value` (null, a primitive, a
 * server-action / qrl reference, or a Date), a `thenable` the caller must resolve and
 * re-serialize (a Remix `defer()` field / promise data), or `compound` — an array,
 * VNode, or plain object the caller serializes itself.
 */
export function serializeScalar(value: unknown): ScalarResult {
  if (value === undefined) return SKIP_RESULT;
  if (value === null) return { kind: "value", value: null };
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") {
    return { kind: "value", value: value as FlightValue };
  }
  if (isServerAction(value)) return { kind: "value", value: { $: "a", i: value.denextActionId } };
  if (isQrl(value)) return { kind: "value", value: { $: "e", i: value.denextQrlId } };
  if (t === "function") return SKIP_RESULT;
  if (value instanceof Date) return { kind: "value", value: { $: "D", v: value.toISOString() } };
  // A thenable (a Remix `defer()` field / promise data): the caller resolves it and
  // re-serializes the result, so deferred data crosses the boundary as its value.
  // `params`/`searchParams` are awaitable-to-themselves (Next 15 shape); they are DATA, not
  // deferred values — resolving them as a thenable would recurse forever.
  if (isAsyncProps(value)) return COMPOUND_RESULT;
  if (isThenable(value)) return { kind: "thenable", promise: value };
  return COMPOUND_RESULT;
}

/**
 * The marker a REJECTED `defer()` value serializes to. It is plain data (no `$` discriminant,
 * so the client Flight parser passes it through untouched) with a distinctive key; a migrated
 * Remix `<Await>` recognizes it and renders `errorElement` (with the error via `useAsyncError`)
 * rather than its children with `null`. The message is carried so the client gets a real
 * `Error` (the raw rejection isn't serializable). Shared by every Flight serializer so the
 * behavior is identical on the streaming and buffered paths.
 */
export function deferErrorMarker(err: unknown): { __dnxAwaitError: true; message: string } {
  return { __dnxAwaitError: true, message: err instanceof Error ? err.message : String(err) };
}

/**
 * Resolve a `defer()` thenable and serialize its value through the caller's `serialize`
 * (each Flight serializer's own recursive step). A rejection serializes to the error marker
 * so `<Await>` renders its `errorElement`. Shared so the streaming and buffered paths behave
 * identically. `T` is the serializer's value type (a `FlightValue`, or one plus a SKIP sentinel).
 */
export async function serializeThenable<T>(
  promise: PromiseLike<unknown>,
  serialize: (value: unknown) => T | Promise<T>,
): Promise<T> {
  try {
    return await serialize(await promise);
  } catch (err) {
    return await serialize(deferErrorMarker(err));
  }
}
