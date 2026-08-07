// Form actions — the React 19 `useActionState` / `useFormStatus` hooks.
//
// denext runs actions on the client (they typically call a route handler or an
// external API); it does not implement Next.js's bundler-transformed "use
// server" RPC. A `<form action={fn}>` is intercepted on the client: submitting
// it calls `fn(formData)`. Progressive enhancement (no-JS form posts to a server
// action endpoint) is not provided.

import { useCallback, useState, useSyncExternalStore } from "./hooks.ts";

// ---- Global "is any action pending" signal (backs useFormStatus) -----------

let pendingCount = 0;
const pendingListeners = new Set<() => void>();

function notifyPending(): void {
  for (const l of pendingListeners) l();
}

/** Mark an action as started (increments the global pending count). */
export function beginAction(): void {
  pendingCount++;
  notifyPending();
}

/** Mark an action as finished (decrements the global pending count). */
export function endAction(): void {
  pendingCount = Math.max(0, pendingCount - 1);
  notifyPending();
}

function subscribePending(onChange: () => void): () => void {
  pendingListeners.add(onChange);
  return () => pendingListeners.delete(onChange);
}

/** Status of the enclosing form's action, as returned by {@link useFormStatus}. */
export interface FormStatus {
  /** True while an action is running. */
  pending: boolean;
}

/**
 * Read whether a form action is currently pending. Simplified relative to React:
 * it reflects whether *any* denext action is in flight (not scoped to the
 * nearest `<form>`), which is correct for the common single-form case.
 */
export function useFormStatus(): FormStatus {
  const pending = useSyncExternalStore(
    subscribePending,
    () => pendingCount > 0,
    () => false,
  );
  return { pending };
}

/**
 * Manage state driven by a form action (React 19 `useActionState`).
 *
 * Returns `[state, dispatch, isPending]`. Pass `dispatch` as a form's `action`
 * (`<form action={dispatch}>`) — submitting the form calls
 * `action(currentState, formData)` and stores the result as the new state.
 * `dispatch` can also be called directly with a payload.
 */
export function useActionState<State, Payload = FormData>(
  action: (state: State, payload: Payload) => State | Promise<State>,
  initialState: State,
): [State, (payload: Payload) => void, boolean] {
  const [state, setState] = useState(initialState);
  const [isPending, setPending] = useState(false);

  const dispatch = useCallback((payload: Payload) => {
    setPending(() => true);
    beginAction();
    Promise.resolve(action(state, payload))
      .then((next) => setState(() => next))
      .catch((err) => {
        console.error("denext: action failed:", err);
      })
      .finally(() => {
        setPending(() => false);
        endAction();
      });
  }, [action, state]);

  return [state, dispatch, isPending];
}
