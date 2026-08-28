// Form actions — the React 19 `useActionState` / `useFormStatus` hooks.
//
// A `<form action={fn}>` is intercepted on the client: submitting it calls
// `fn(formData)`. When `fn` is a `serverAction` (see runtime/server-action.ts),
// that call POSTs to the secure server-action endpoint, and the form also
// carries the endpoint URL in its SSR markup for progressive enhancement.

import { useCallback, useContext, useState, useSyncExternalStore } from "./hooks.ts";
import { FormStatusContext } from "./form-status.ts";

/** Status of the enclosing form's action, as returned by {@link useFormStatus}. */
export interface FormStatus {
  /** True while the nearest enclosing `<form>`'s action is running. */
  pending: boolean;
}

/**
 * Read whether the **nearest enclosing** `<form action={fn}>`'s action is in
 * flight (React 19 `useFormStatus`). Scoped per form — two concurrent forms
 * report independent status. Returns `{ pending: false }` outside a form and
 * during server rendering.
 */
export function useFormStatus(): FormStatus {
  const signal = useContext(FormStatusContext);
  const subscribe = useCallback((onChange: () => void) => {
    if (!signal) return () => {};
    signal.listeners.add(onChange);
    return () => signal.listeners.delete(onChange);
  }, [signal]);
  const pending = useSyncExternalStore(
    subscribe,
    () => (signal ? signal.pending > 0 : false),
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
 * `dispatch` can also be called directly with a payload. `dispatch` returns the
 * action's promise so the enclosing form's {@link useFormStatus} tracks it.
 */
export function useActionState<State, Payload = FormData>(
  action: (state: State, payload: Payload) => State | Promise<State>,
  initialState: State,
  // React's optional 3rd arg: a permalink for progressive-enhancement form submits
  // before hydration. denext hydrates its actions client-side, so it is accepted for
  // signature parity and currently unused.
  _permalink?: string,
): [State, (payload: Payload) => void, boolean] {
  const [state, setState] = useState(initialState);
  const [isPending, setPending] = useState(false);

  const dispatch = useCallback((payload: Payload): Promise<void> => {
    setPending(() => true);
    return Promise.resolve(action(state, payload))
      .then((next) => setState(() => next))
      .catch((err) => {
        console.error("denext: action failed:", err);
      })
      .finally(() => {
        setPending(() => false);
      });
  }, [action, state]);

  return [state, dispatch, isPending];
}

/**
 * Deprecated alias of {@link useActionState} — React renamed `useFormState`
 * (react-dom) to `useActionState` (react). Kept so code that still imports the old
 * name resolves; prefer `useActionState`.
 */
export const useFormState: typeof useActionState = useActionState;
