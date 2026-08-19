"use server";

// A "use server" module. Every exported async function is auto-registered as a
// Server Action: it runs only on the server, and denext generates a secure POST
// endpoint for it. A `<form action={addEntry}>` renders that endpoint's URL into
// its SSR markup, so the form works even with JavaScript disabled — and the
// endpoint enforces a same-origin check (CSRF defense) before running.

export interface Entry {
  name: string;
  message: string;
  at: string;
}

// Process-local store standing in for a database. Newest first.
const entries: Entry[] = [
  {
    name: "denext",
    message: "Server Actions work with zero client JavaScript.",
    at: new Date(0).toISOString(),
  },
];

/** Current guestbook entries (read during server render). */
export function getEntries(): Entry[] {
  return entries;
}

export interface FormState {
  ok: boolean;
  error?: string;
  /** The entry just saved — the client commits it to its live list. */
  entry?: Entry;
}

/** Validate + append. Returns the created entry, or an error message. */
function append(
  name: string,
  message: string,
): { entry: Entry } | { error: string } {
  name = name.trim();
  message = message.trim();
  if (!name || !message) {
    return { error: "Both a name and a message are required." };
  }
  if (name.length > 40 || message.length > 280) {
    return { error: "Name ≤ 40 and message ≤ 280 characters." };
  }
  const entry: Entry = { name, message, at: new Date().toISOString() };
  entries.unshift(entry);
  return { entry };
}

/**
 * Native-form action (single `formData` arg). A `<form action={submitEntry}>`
 * posts here with no client JS; denext then 303-redirects back to the page.
 */
export function submitEntry(formData: FormData): void {
  append(
    String(formData.get("name") ?? ""),
    String(formData.get("message") ?? ""),
  );
}

/**
 * `useActionState` action (prevState, formData) → next state. Used by the
 * client-enhanced form so the UI can show validation errors without a reload
 * and reconcile its optimistic row against the entry the server actually saved.
 */
export function addEntry(_prev: FormState, formData: FormData): FormState {
  const result = append(
    String(formData.get("name") ?? ""),
    String(formData.get("message") ?? ""),
  );
  return "error" in result ? { ok: false, error: result.error } : { ok: true, entry: result.entry };
}
