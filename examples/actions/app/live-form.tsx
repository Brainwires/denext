"use client";

// A hydrated client island layering the React 19 form hooks over the same Server
// Action. `useActionState` wraps the action so its return value becomes state
// (an inline confirmation or validation error, no reload); `useFormStatus` reads
// the nearest form's in-flight status for a disabled/pending button.

import { useActionState } from "denext";
import { useFormStatus } from "denext";
import { addEntry, type FormState } from "./actions.ts";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending}>
      {pending ? "Signing…" : "Sign the guestbook"}
    </button>
  );
}

export default function LiveForm() {
  const [state, formAction] = useActionState<FormState>(addEntry, { ok: true });

  return (
    <div class="live">
      <form action={formAction}>
        <div class="fields">
          <input name="name" placeholder="Your name" aria-label="Your name" />
          <input name="message" placeholder="A short message" aria-label="Message" />
        </div>
        <SubmitButton />
      </form>

      {state.ok === false && state.error && <p class="err">{state.error}</p>}
      {state.ok && state.saved && <p class="ok" data-saved>Saved: {state.saved}</p>}
    </div>
  );
}
