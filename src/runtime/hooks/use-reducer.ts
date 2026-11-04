// The public `useReducer`: the installed dispatcher's own (the server's), else the client fiber
// dispatcher's, which lives in src/client/fiber/hooks/use-reducer.ts so a bundle carries it only when
// the app calls `useReducer` (see src/client/fiber/hooks-dispatcher.ts).

import type { ClientHookHost } from "../../client/fiber/hooks-dispatcher.ts";
import { activeDispatcher } from "../hooks.ts";
import { clientUseReducer } from "../../client/fiber/hooks/use-reducer.ts";

/**
 * Manage component state with a reducer, returning the state and a dispatch.
 * With a lazy `init`, the initial state is `init(initialArg)` (React parity).
 *
 * @param reducer Computes the next state from the current one and an action.
 * @param initialArg The initial state, or `init`'s argument.
 * @param init Optional lazy initializer.
 * @returns The state and a dispatch of stable identity.
 */
export function useReducer<S, A, I = S>(
  reducer: (state: S, action: A) => S,
  initialArg: I,
  init?: (arg: I) => S,
): [S, (action: A) => void] {
  const d = activeDispatcher();
  return d.useReducer
    ? d.useReducer(reducer, initialArg, init)
    : clientUseReducer(d as ClientHookHost, reducer, initialArg, init);
}
