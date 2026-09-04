"use client";

// A hydrated client island layering the React 19 form hooks over the same Server
// Action. `useActionState` wraps the action so its return value becomes state (a
// validation error, no reload); `useOptimistic` shows the just-submitted row
// instantly — before the server round-trip finishes — then reconciles it against
// the entry the server actually saved; `useFormStatus` reads the nearest form's
// in-flight status for a disabled/pending button.

import { useActionState, useFormStatus, useOptimistic, useState } from "denext";
import { addEntry, type Entry, type FormState } from "./actions.ts";

/** An entry plus a client-only flag marking it as not-yet-confirmed. */
type OptimisticEntry = Entry & { pending?: boolean };

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending}>
      {pending ? "Signing…" : "Sign the guestbook"}
    </button>
  );
}

/** The entry the form is about to submit, as the optimistic row shows it. */
function draftEntry(formData: FormData): Entry {
  return {
    name: String(formData.get("name") ?? ""),
    message: String(formData.get("message") ?? ""),
    at: new Date().toISOString(),
  };
}

export default function LiveForm(
  { initialEntries }: { initialEntries: Entry[] },
) {
  // The committed list, seeded from the server render. It grows as the server
  // confirms each save; `useOptimistic` layers the in-flight row on top and
  // resets to this list the moment it changes (so no duplicate, no flicker).
  const [entries, setEntries] = useState(initialEntries);
  const [optimisticEntries, addOptimistic] = useOptimistic(
    entries as OptimisticEntry[],
    (
      list: OptimisticEntry[],
      entry: Entry,
    ) => [{ ...entry, pending: true }, ...list],
  );

  const [state, formAction] = useActionState<FormState>(
    async (prev, formData) => {
      // Show the row before awaiting the server.
      addOptimistic(draftEntry(formData));
      const result = await addEntry(prev, formData);
      // On success, commit the server's entry — this resets the optimistic overlay.
      const saved = result.ok ? result.entry : undefined;
      if (saved) setEntries((cur) => [saved, ...cur]);
      return result;
    },
    { ok: true },
  );

  return (
    <div class="live">
      <form action={formAction}>
        <div class="fields">
          <input name="name" placeholder="Your name" aria-label="Your name" />
          <input
            name="message"
            placeholder="A short message"
            aria-label="Message"
          />
        </div>
        <SubmitButton />
      </form>

      {state.ok === false && state.error && <p class="err">{state.error}</p>}

      <Entries entries={optimisticEntries} />
    </div>
  );
}

/** The committed entries with the in-flight optimistic row (marked pending) on top. */
function Entries({ entries }: { entries: OptimisticEntry[] }) {
  return (
    <>
      <h2>Entries</h2>
      <ul class="entries">
        {entries.map((e, i) => (
          <li
            key={`${e.at}-${i}`}
            class={e.pending ? "pending" : undefined}
            aria-busy={e.pending || undefined}
          >
            <strong>{e.name}</strong>
            <span>{e.message}</span>
            <time>{e.at}</time>
          </li>
        ))}
      </ul>
    </>
  );
}
