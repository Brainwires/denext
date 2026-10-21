// The submit side of a function-valued form action (React 19's `<form action={fn}>`,
// `<button formAction={fn}>`, a `useActionState` dispatch): build the form's `FormData`, call the
// action, drive the form-scoped `useFormStatus` signal while it runs, and route a throw or a
// rejection to the nearest error boundary.
//
// Loaded on demand. dom-props.ts wires the submit listener (so a submit never goes out natively)
// and imports this module the first time it sees a function-valued action; an app with no such
// form ships none of it. Two rules keep it that way, both because the bundler places code by
// FILE: nothing in the startup graph may import this module statically (that would hoist it back
// into the chunk every page loads), and this module imports no runtime module (a lazy chunk that
// shares one with the startup graph splits the shared chunk in two, ~1.7 KB of cross-chunk
// bindings). Types only.

import type { FormStatusSignal, FormSubmission } from "../runtime/form-status.ts";
import type { ErrorRouter, HostState } from "./dom-props.ts";

/** Mark a submission started on `signal` (recording what was submitted) and notify subscribers. */
export function beginFormAction(signal: FormStatusSignal, submission: FormSubmission = {}): void {
  signal.pending++;
  signal.data = submission.data ?? null;
  signal.method = submission.method ?? "post";
  signal.action = submission.action ?? null;
  for (const l of signal.listeners) l();
}

/** Mark a submission finished on `signal` and notify subscribers. */
export function endFormAction(signal: FormStatusSignal): void {
  signal.pending = Math.max(0, signal.pending - 1);
  if (signal.pending === 0) {
    signal.data = null;
    signal.method = null;
    signal.action = null;
  }
  for (const l of signal.listeners) l();
}

/**
 * Run a function-valued form action for one (already `preventDefault`ed) submit event.
 *
 * @param event The submit event.
 * @param state The form's host state (its `useFormStatus` signal rides `state.ext`).
 * @param action The action to call with the form's `FormData`.
 * @param onError Routes a thrown or rejected action to the nearest boundary.
 */
export function runFormAction(
  event: Event,
  state: HostState,
  action: (payload: unknown) => void,
  onError: ErrorRouter,
): void {
  const form = event.target;
  // Build FormData from the real form element when possible.
  const FormDataCtor = (globalThis as { FormData?: unknown }).FormData as
    | (new (form: unknown) => unknown)
    | undefined;
  let payload: unknown;
  try {
    payload = FormDataCtor && form ? new FormDataCtor(form) : undefined;
  } catch {
    payload = undefined; // non-form element (e.g. test shim)
  }
  // Drive the form-scoped pending signal (useFormStatus) for the duration of
  // the action, and route thrown/rejected errors to the nearest boundary.
  const sig = state.ext?.formStatus;
  if (sig) {
    const el = form as { method?: string } | null;
    beginFormAction(sig, {
      data: payload as FormData | undefined,
      method: (el?.method || "post").toLowerCase(),
      action,
    });
  }
  let settled = false;
  const done = () => {
    if (settled) return;
    settled = true;
    if (sig) endFormAction(sig);
  };
  try {
    const r = action(payload) as unknown;
    if (r && typeof (r as { then?: unknown }).then === "function") {
      (r as Promise<unknown>).then(done, (err) => {
        done();
        onError(err);
      });
    } else {
      done(); // synchronous action: already finished
    }
  } catch (err) {
    done();
    onError(err);
  }
}
