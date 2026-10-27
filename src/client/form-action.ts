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

/** A submit button (or input) with a function `formAction`, armed by its click. */
type Submitter = Element & {
  form?: HTMLFormElement | null;
  type?: string;
  /** The clicked button's action and its error route, read by the submit that follows. */
  __dnxFA?: [(payload: unknown) => void, ErrorRouter];
};

/** A form readied for its submit buttons' `formAction`s (one listener per form). */
type ArmedForm = HTMLFormElement & { __dnxFS?: true };

/**
 * Run a function-valued form action for one event: a form's submit (its own `action`, or the
 * `formAction` of the button that submitted it, React's rule), or a submit button's click, which
 * readies its form so the submit that follows runs the button's action.
 *
 * @param event The submit (at a form) or click (at a submit button) event.
 * @param state The element's host state (a form's `useFormStatus` signal rides `state.ext`).
 * @param action The element's own action.
 * @param onError Routes a thrown or rejected action to the nearest boundary.
 * @param el The element the action is set on.
 * @param held The event waited for this module to load (its default action was prevented).
 */
export function runFormAction(
  event: Event,
  state: HostState,
  action: (payload: unknown) => void,
  onError: ErrorRouter,
  el: Element,
  held?: boolean,
): void {
  if (event.type === "click") return armSubmitter(el as Submitter, action, onError, held);
  event.preventDefault();
  const own = claimSubmit(event);
  if (own === null) return; // the button's own listener ran it
  dispatchFormAction(event, state, own?.[0] ?? action, own?.[1] ?? onError);
}

/**
 * A submit button's click: record its action for the submit that follows and make sure its form
 * listens for it (a form with no function `action` of its own has no listener). A click that waited
 * for this module had its default prevented, so the form is submitted again here, through the
 * button (validation included).
 */
function armSubmitter(
  el: Submitter,
  action: (payload: unknown) => void,
  onError: ErrorRouter,
  held?: boolean,
): void {
  const form = el.form as ArmedForm | null | undefined;
  if (!form) return;
  el.__dnxFA = [action, onError];
  if (!form.__dnxFS) {
    form.__dnxFS = true;
    form.addEventListener("submit", submitterSubmit);
  }
  if (held && (el.type === "submit" || el.type === "image")) form.requestSubmit(el as HTMLElement);
}

/** The armed form's own listener: run the submitting button's `formAction`, if it has one. */
function submitterSubmit(event: Event): void {
  if (!((event as SubmitEvent).submitter as Submitter | null)?.__dnxFA) return;
  const own = claimSubmit(event);
  if (!own) return;
  event.preventDefault();
  dispatchFormAction(event, {}, own[0], own[1]);
}

/**
 * Claim `event` for one action run (a form's own listener and its armed submitter listener both
 * see it): `null` when the other already did, else the submitting button's `formAction` (taken,
 * so a later submit without a click doesn't reuse it), or `undefined` when it has none.
 */
function claimSubmit(event: Event): Submitter["__dnxFA"] | null {
  const claimed = event as Event & { __dnxFA?: true };
  if (claimed.__dnxFA) return null;
  claimed.__dnxFA = true;
  const submitter = (event as SubmitEvent).submitter as Submitter | null | undefined;
  const own = submitter?.__dnxFA;
  if (own) delete submitter!.__dnxFA;
  return own;
}

/** Call `action` with the submitted form's `FormData` (the submitter's name/value included). */
function dispatchFormAction(
  event: Event,
  state: HostState,
  action: (payload: unknown) => void,
  onError: ErrorRouter,
): void {
  const payload = submittedData(event);
  // Drive the form-scoped pending signal (useFormStatus) for the duration of
  // the action, and route thrown/rejected errors to the nearest boundary.
  const sig = state.ext?.formStatus;
  if (sig) {
    const el = event.target as { method?: string } | null;
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

/**
 * The submitted form's `FormData`, with the submit button's own name/value as a native submit
 * sends them; `undefined` where there is no `FormData` or the target is no form (a test shim).
 */
function submittedData(event: Event): unknown {
  const FormDataCtor = (globalThis as { FormData?: unknown }).FormData as
    | (new (form: unknown, submitter?: unknown) => unknown)
    | undefined;
  if (!FormDataCtor || !event.target) return undefined;
  try {
    return new FormDataCtor(event.target, (event as SubmitEvent).submitter ?? null);
  } catch {
    return undefined;
  }
}
