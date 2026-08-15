"use client";

// A hydrated client island layering the React 19 form hooks over the same Server
// Action. `useActionState` wraps the action so its return value becomes state
// (surfacing validation errors inline, no reload); `useFormStatus` reads the
// nearest form's in-flight status for a disabled/pending button; `useOptimistic`
// echoes the just-submitted message instantly, before the server responds.

import { useActionState, useOptimistic } from "denext";
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
  const [optimistic, addOptimistic] = useOptimistic<string[], string>(
    [],
    (prev, name) => [...prev, name],
  );

  return (
    <div class="live">
      <form
        action={formAction}
        onSubmit={(e: { currentTarget: HTMLFormElement }) => {
          const name = new FormData(e.currentTarget).get("name");
          if (typeof name === "string" && name.trim()) addOptimistic(name.trim());
        }}
      >
        <div class="fields">
          <input name="name" placeholder="Your name" aria-label="Your name" />
          <input name="message" placeholder="A short message" aria-label="Message" />
        </div>
        <SubmitButton />
      </form>

      {state.ok === false && state.error && <p class="err">{state.error}</p>}
      {optimistic.length > 0 && (
        <p class="hint">Optimistically added for: {optimistic.join(", ")}</p>
      )}
    </div>
  );
}
