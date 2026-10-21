// useInsertionEffect on the client fiber dispatcher, in its own module so an app that never
// calls it ships none of it (see ../hooks-dispatcher.ts). Linked by the public hook,
// src/runtime/hooks/use-insertion-effect.ts.
// It imports nothing of the reconciler: what it needs is the client dispatcher's
// {@linkcode ClientHookHost} members, which the public hook hands it.

import type { DependencyList } from "../../../compat/react-types.ts";
import type { EffectCleanup } from "../../../runtime/hooks.ts";
import { HK_INSERTION } from "../hook-kinds.ts";
import type { ClientHookHost } from "../hooks-dispatcher.ts";

/**
 * `useInsertionEffect` for the component the client reconciler is rendering: the effect runs
 * in its own pre-mutation commit phase, before any DOM mutation and before layout effects, so
 * CSS-in-JS style insertion precedes layout reads (React's order).
 *
 * @param host The client dispatcher.
 * @param effect The insertion effect; may return a cleanup.
 * @param deps Dependency array controlling when it re-runs.
 */
export function clientUseInsertionEffect(
  host: ClientHookHost,
  effect: () => EffectCleanup,
  deps?: DependencyList,
): void {
  host.insertion(host.cell(HK_INSERTION), effect, deps);
}
