// The public `useDeferredValue`: the installed dispatcher's own (the server's), else the client fiber
// dispatcher's, which lives in src/client/fiber/hooks/use-deferred-value.ts so a bundle carries it only when
// the app calls `useDeferredValue` (see src/client/fiber/hooks-dispatcher.ts).

import type { ClientHookHost } from "../../client/fiber/hooks-dispatcher.ts";
import { activeDispatcher } from "../hooks.ts";
import { clientUseDeferredValue } from "../../client/fiber/hooks/use-deferred-value.ts";

/**
 * Return a deferred copy of `value` that lags behind during rapid updates, letting
 * urgent renders finish first. On the client this is a true **render-phase**
 * deferral (React-accurate): during an urgent render the hook returns the previous
 * value and schedules a low-priority transition to catch up, so the deferred
 * update is time-sliced and interruptible and the value never trails by an extra
 * commit. The optional `initialValue` (React 19) is returned on the first render,
 * with a transition scheduled to reach `value`. On the server (no lane scheduler)
 * it returns `initialValue ?? value`.
 *
 * @param value The value to defer.
 * @param initialValue Optional value to show on the first render before deferral.
 * @returns The value this render shows.
 */
export function useDeferredValue<T>(value: T, initialValue?: T): T {
  const d = activeDispatcher();
  return d.useDeferredValue
    ? d.useDeferredValue(value, initialValue)
    : clientUseDeferredValue(d as ClientHookHost, value, initialValue);
}
