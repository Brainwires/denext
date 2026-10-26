// The call side of a function-valued form action (React 19's `<form action={fn}>`,
// `<button formAction={fn}>`, a `useActionState` dispatch): call the action with what was
// submitted, end the form-scoped `useFormStatus` pending state when it settles, and route a throw
// or a rejection to the nearest error boundary.
//
// Loaded on demand. dom-props.ts intercepts the submit (so it never goes out natively), takes its
// `FormData` and starts `useFormStatus`'s pending state at the submit itself, and imports this
// module the first time it sees a function-valued action; an app with no such form ships none of
// it. Two rules keep it that way, both because the bundler places code by FILE: nothing in the
// startup graph may import this module statically (that would hoist it back into the chunk every
// page loads), and this module imports no runtime module (a lazy chunk that shares one with the
// startup graph splits the shared chunk in two, ~1.7 KB of cross-chunk bindings). Types only.

import type { FormActionSubmit } from "./dom-props.ts";

/**
 * Run one submit of a function-valued form action: call it with the submitted `FormData`, end
 * its pending state when it returns or settles, and route a throw or rejection to the boundary.
 *
 * @param submit The submit, as dom-props.ts took it.
 */
export function runFormAction({ action, onError, data, done }: FormActionSubmit): void {
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
