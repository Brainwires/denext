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
  /** The message just saved (drives the enhanced form's confirmation). */
  saved?: string;
}

/** Validate + append. Returns null on success, or an error message. */
function append(name: string, message: string): string | null {
  name = name.trim();
  message = message.trim();
  if (!name || !message) return "Both a name and a message are required.";
  if (name.length > 40 || message.length > 280) return "Name ≤ 40 and message ≤ 280 characters.";
  entries.unshift({ name, message, at: new Date().toISOString() });
  return null;
}

/**
 * Native-form action (single `formData` arg). A `<form action={submitEntry}>`
 * posts here with no client JS; denext then 303-redirects back to the page.
 */
export function submitEntry(formData: FormData): void {
  append(String(formData.get("name") ?? ""), String(formData.get("message") ?? ""));
}

/**
 * `useActionState` action (prevState, formData) → next state. Used by the
 * client-enhanced form so the UI can show validation errors without a reload.
 */
export function addEntry(_prev: FormState, formData: FormData): FormState {
  const message = String(formData.get("message") ?? "").trim();
  const error = append(String(formData.get("name") ?? ""), message);
  return error ? { ok: false, error } : { ok: true, saved: message };
}
