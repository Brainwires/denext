// useDeferredValue on the client fiber dispatcher, in its own module so an app that never calls
// it ships none of it (see ../hooks-dispatcher.ts). Linked by the public hook,
// src/runtime/hooks/use-deferred-value.ts.
// It imports nothing of the reconciler: what it needs is the client dispatcher's
// {@linkcode ClientHookHost} members, which the public hook hands it.

import { HK_DEFERRED } from "../hook-kinds.ts";
import type { ClientHookHost } from "../hooks-dispatcher.ts";

/**
 * `useDeferredValue` for the component the client reconciler is rendering: a render-phase
 * deferral on the transition lane.
 *
 * @param host The client dispatcher.
 * @param value The value to defer.
 * @param initialValue Shown on the first render, with a transition scheduled to reach `value`.
 * @returns The value this render shows.
 */
export function clientUseDeferredValue<T>(host: ClientHookHost, value: T, initialValue?: T): T {
  const inst = host.fiber();
  const cell = host.cell(HK_DEFERRED);
  if (!cell.inited) {
    cell.inited = true;
    // First render: show initialValue (if given and different) and schedule a
    // transition to catch up to the real value; otherwise show value.
    if (initialValue !== undefined && !Object.is(initialValue, value)) {
      cell.value = initialValue;
      host.deferUpdate(inst);
      return initialValue;
    }
    cell.value = value;
    return value;
  }
  // A transition render accepts the latest value; an urgent render where the
  // value changed returns the previous value and schedules the catch-up
  // transition (so the deferred update is time-sliced, not blocking).
  if (host.inTransition()) {
    cell.value = value;
    return value;
  }
  if (!Object.is(value, cell.value)) host.deferUpdate(inst);
  return cell.value as T;
}
