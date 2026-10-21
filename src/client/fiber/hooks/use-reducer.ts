// useReducer on the client fiber dispatcher, in its own module so an app that never calls it
// ships none of it (see ../hooks-dispatcher.ts). Linked by the public hook,
// src/runtime/hooks/use-reducer.ts.
// It imports nothing of the reconciler: what it needs is the client dispatcher's
// {@linkcode ClientHookHost} members, which the public hook hands it.

import type { HookCell } from "../fiber.ts";
import { HK_REDUCER } from "../hook-kinds.ts";
import type { ClientHookHost } from "../hooks-dispatcher.ts";

/** useReducer's dispatch for `cell` (created once per cell); applies the latest reducer. */
function reducerDispatch(host: ClientHookHost, cell: HookCell): (action: unknown) => void {
  return (action) => host.commitCell(cell, cell.reducer!(cell.value, action));
}

/**
 * `useReducer` for the component the client reconciler is rendering.
 *
 * @param host The client dispatcher.
 * @param reducer The reducer; the latest one is applied to each dispatched action.
 * @param initialArg The initial state, or `init`'s argument.
 * @param init Optional lazy initializer.
 * @returns The state and a dispatch of stable identity.
 */
export function clientUseReducer<S, A, I>(
  host: ClientHookHost,
  reducer: (s: S, a: A) => S,
  initialArg: I,
  init?: (arg: I) => S,
): [S, (action: A) => void] {
  const hook = host.cell(HK_REDUCER);
  if (!hook.inited) hook.value = init ? init(initialArg) : initialArg;
  const cell = host.stateCell(hook);
  cell.reducer = reducer as (s: unknown, a: unknown) => unknown; // always use the latest reducer
  // Stable dispatch identity (React guarantee), created once; uses the latest reducer.
  cell.updater ??= reducerDispatch(host, cell);
  return [cell.value as S, cell.updater as (a: A) => void];
}
