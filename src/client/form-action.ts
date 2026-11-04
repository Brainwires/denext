// The call side of a function-valued form action (React 19's `<form action={fn}>`,
// `<button formAction={fn}>`, a `useActionState` dispatch): build the form's `FormData`, call the
// action, drive the form-scoped `useFormStatus` signal while it runs, and route a throw or a
// rejection to the nearest error boundary.
//
// Loaded on demand. dom-props.ts intercepts the submit (so it never goes out natively), picks the
// action (the submitter's `formAction`, else the form's own) and imports this module the first
// time it sees a function-valued action; an app with no such form ships none of it. A submit that
// beats this module is held, its `FormData` and pending state taken at the submit (`held`). Two
// rules keep it that way, both because the bundler places code by FILE: nothing in the startup
// graph may import this module statically (that would hoist it back into the chunk every page
// loads), and this module imports no runtime module (a lazy chunk that shares one with the
// startup graph splits the shared chunk in two, ~1.7 KB of cross-chunk bindings). Types only.

import type { FormStatusSignal } from "../runtime/form-status.ts";
import type { FormActionSite, HeldSubmit } from "./dom-props.ts";

/** Notify `signal`'s subscribers. */
function notify(signal: FormStatusSignal): void {
  for (const l of signal.listeners) l();
}

/**
 * Run one submit of a function-valued form action: call it with the submitted `FormData`, keep
 * its form's `useFormStatus` pending until it returns or settles, and route a throw or rejection
 * to the nearest boundary.
 *
 * @param event The submit event.
 * @param form The submitted form.
 * @param site The action, its error route and its host state (the form's status signal).
 * @param held What a submit that waited for this module took at the submit (its pending state
 *   already counted).
 */
export function runFormAction(
  event: Event,
  form: HTMLFormElement,
  [action, onError, state]: FormActionSite,
  held?: HeldSubmit,
): void {
  const data = held ? held.data : submittedData(event, form);
  const sig = state.ext?.formStatus;
  if (sig) {
    if (!held) sig.pending++;
    sig.data = data as FormData | null ?? null;
    sig.method = (form.method || "post").toLowerCase();
    sig.action = action;
    notify(sig);
  }
  let settled = false;
  const done = () => {
    if (settled || !sig) return;
    settled = true;
    sig.pending = Math.max(0, sig.pending - 1);
    if (sig.pending === 0) sig.data = sig.method = sig.action = null;
    notify(sig);
  };
  try {
    const r = action(data) as unknown;
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

/**
 * The submitted form's `FormData`, with the submit button's own name/value as a native submit
 * sends them; `undefined` where there is no `FormData` (a test shim).
 */
function submittedData(event: Event, form: HTMLFormElement): unknown {
  const FormDataCtor = (globalThis as { FormData?: unknown }).FormData as
    | (new (form: unknown, submitter?: unknown) => unknown)
    | undefined;
  if (!FormDataCtor) return undefined;
  try {
    return new FormDataCtor(form, (event as SubmitEvent).submitter ?? null);
  } catch {
    return undefined;
  }
}
