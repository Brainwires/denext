// Form-scoped pending signal backing React 19's `useFormStatus`.
//
// A host `<form action={fn}>` establishes a per-form signal that the client
// reconciler seeds into its descendants' context map. `setFormAction` bumps the
// signal while the form's action is in flight, and `useFormStatus` reads the
// nearest one — so multiple concurrent forms report independent status (unlike a
// single global flag).

import { createContext } from "./context.ts";
import type { Context } from "./hooks.ts";

/** Per-form in-flight state: a submission count plus change listeners. */
export interface FormStatusSignal {
  /** Number of in-flight submissions for this form (0 = idle). */
  pending: number;
  /** The in-flight submission's `FormData` (React's `useFormStatus().data`), or null. */
  data: FormData | null;
  /** The in-flight submission's method (`"get"` / `"post"`), or null when idle. */
  method: string | null;
  /** The in-flight submission's action (the function or URL), or null when idle. */
  action: unknown;
  /** Subscribers notified when {@link FormStatusSignal.pending} changes. */
  listeners: Set<() => void>;
}

/** The submission details React exposes on `useFormStatus()` while it is pending. */
export interface FormSubmission {
  data?: FormData | null;
  method?: string | null;
  action?: unknown;
}

/**
 * Context carrying the nearest enclosing form's {@link FormStatusSignal} (or
 * `null` when not inside a `<form>` with a function action). Seeded by the
 * reconciler onto a host `<form>` fiber's descendants; read by `useFormStatus`.
 */
export const FormStatusContext: Context<FormStatusSignal | null> = createContext<
  FormStatusSignal | null
>(null);

/** Create an idle form-status signal. */
export function createFormStatusSignal(): FormStatusSignal {
  return { pending: 0, data: null, method: null, action: null, listeners: new Set() };
}

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
