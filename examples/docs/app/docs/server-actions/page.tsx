import { Callout, Code, DocsShell } from "../../../components/ui.tsx";

export default function ServerActions() {
  return (
    <DocsShell
      active="server-actions"
      title="Server Actions"
      lead="Server-side functions you can call straight from a form or a client event — no API route, no fetch boilerplate. CSRF-defended and progressively enhanced."
    >
      <h2>Write an action</h2>
      <p>
        Mark a module (or a single function) with <code>"use server"</code>{" "}
        and export an async function. It runs only on the server; the client gets a typed stub that
        posts to a generated same-origin endpoint.
      </p>
      <Code lang="tsx">
        {`// app/actions.ts
"use server";
import { revalidatePath } from "denext/server";

export async function createNote(formData: FormData) {
  const title = String(formData.get("title") ?? "");
  await db.notes.insert({ title });
  revalidatePath("/notes"); // re-render the list on the next load
}`}
      </Code>

      <h2>Use it from a form</h2>
      <p>
        Pass the action to a{" "}
        <code>{"<form action={...}>"}</code>. With JavaScript it posts in the background;{" "}
        <strong>with JavaScript disabled it still works</strong>{" "}
        — the form posts normally and the page reloads.
      </p>
      <Code lang="tsx">
        {`import { createNote } from "./actions.ts";

export default function NewNote() {
  return (
    <form action={createNote}>
      <input name="title" required />
      <button>Add note</button>
    </form>
  );
}`}
      </Code>

      <Callout kind="note">
        Every action request is verified same-origin (Origin/Referer) before it runs, so an action
        can't be triggered cross-site — CSRF defense is built in. Actions are POST-only.
      </Callout>

      <h2>Return values &amp; redirects</h2>
      <p>
        Call an action from a client component and <code>await</code> its return value, or{" "}
        <code>redirect()</code> from inside it (forced to a safe same-origin 303 for no-JS posts).
      </p>
      <Code lang="tsx">
        {`"use server";
import { redirect } from "denext/navigation";

export async function signIn(formData: FormData) {
  const user = await authenticate(formData);
  if (!user) return { error: "Invalid credentials" };
  redirect("/dashboard");
}`}
      </Code>

      <h2>Refreshing cached data</h2>
      <p>
        After a write, tell the framework what to invalidate. All are importable from{" "}
        <code>denext/server</code>:
      </p>
      <ul>
        <li>
          <code>revalidatePath(path)</code> / <code>revalidateTag(tag)</code>{" "}
          — purge cached renders or tagged data.
        </li>
        <li>
          <code>updateTag(tag)</code>{" "}
          — read-your-writes: the same request recomputes so the response reflects the write.
        </li>
        <li>
          <code>refresh()</code>{" "}
          — re-fetch the current route's uncached data without touching the cache.
        </li>
      </ul>

      <Callout kind="warn">
        Actions receive the visitor's cookies. Treat every argument as untrusted input — validate on
        the server, and never trust a hidden form field for authorization.
      </Callout>
    </DocsShell>
  );
}
