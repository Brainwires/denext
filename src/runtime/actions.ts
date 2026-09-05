// Form actions — the React 19 `useActionState` / `useFormStatus` hooks.
//
// A `<form action={fn}>` is intercepted on the client: submitting it calls
// `fn(formData)`. When `fn` is a `serverAction` (see runtime/server-action.ts),
// that call POSTs to the secure server-action endpoint, and the form also
// carries the endpoint URL in its SSR markup for progressive enhancement.

import {
  startTransition,
  useCallback,
  useContext,
  useRef,
  useState,
  useSyncExternalStore,
} from "./hooks.ts";
import { FormStatusContext } from "./form-status.ts";

/** Status of the enclosing form's action, as returned by {@link useFormStatus}. */
export interface FormStatus {
  /** True while the nearest enclosing `<form>`'s action is running. */
  pending: boolean;
  /** The pending submission's `FormData`, or null when idle. */
  data: FormData | null;
  /** The pending submission's method (`"get"` / `"post"`), or null when idle. */
  method: string | null;
  /** The pending submission's action (function or URL), or null when idle. */
  action: unknown;
}

const IDLE_STATUS: FormStatus = { pending: false, data: null, method: null, action: null };

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
  // One snapshot object per submission, so the store's Object.is re-check sees a stable value.
  const snapshot = useRef<{ data: FormData | null; status: FormStatus } | null>(null);
  return useSyncExternalStore(
    subscribe,
    () => {
      if (!signal || signal.pending === 0) return IDLE_STATUS;
      if (!snapshot.current || snapshot.current.data !== signal.data) {
        snapshot.current = {
          data: signal.data,
          status: {
            pending: true,
            data: signal.data,
            method: signal.method,
            action: signal.action,
          },
        };
      }
      return snapshot.current.status;
    },
    () => IDLE_STATUS,
  );
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
  // React's optional 3rd arg: a permalink (URL) to submit to before hydration, so a
  // form works without JavaScript. denext stamps it as the SSR `<form action>` (see
  // below), and after hydration the client dispatch takes over.
  permalink?: string,
): [State, (payload: Payload) => void, boolean] {
  const [state, setState] = useState(initialState);
  const [isPending, setPending] = useState(false);
  // The latest state and action, read at dispatch time so `dispatch` keeps ONE identity for
  // the component's lifetime (React's does), yet never closes over stale state.
  const latest = useRef({ state, action });
  latest.current = { state, action };

  const dispatch = useCallback((payload: Payload): Promise<void> => {
    setPending(() => true);
    let settle!: () => void;
    const done = new Promise<void>((r) => (settle = r));
    // The action runs inside a transition (React does the same): its state updates are
    // transition-lane, and a `useOptimistic` value applied alongside reverts when the
    // action settles rather than on the next tick.
    startTransition(() => {
      Promise.resolve(latest.current.action(latest.current.state, payload))
        .then((next) => setState(() => next))
        .catch((err) => {
          // React rethrows an action's error into the nearest error boundary: surface it from
          // the next render (a state updater that throws) instead of swallowing it in a log.
          setState(() => {
            throw err;
          });
        })
        .finally(() => {
          setPending(() => false);
          settle();
        });
    });
    return done;
  }, []) as ((payload: Payload) => Promise<void>) & { denextPermalink?: string };

  // Progressive enhancement: tag the dispatch with the permalink so the SSR serializer
  // renders it as the form's `action` URL — a pre-hydration submit navigates there
  // instead of being lost. After hydration the client intercepts the submit.
  if (permalink) dispatch.denextPermalink = permalink;

  return [state, dispatch, isPending];
}

/**
 * Alias of {@link useActionState} — React renamed `useFormState` (react-dom) to
 * `useActionState` (react). Kept so code that still imports the old name resolves.
 * @deprecated Use `useActionState`. Kept through 2.x; removed in 3.0.
 */
export const useFormState: typeof useActionState = useActionState;
