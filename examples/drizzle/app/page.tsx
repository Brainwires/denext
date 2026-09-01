// A Server Component: it runs the Drizzle query on the server and renders the
// rows. The <form> posts a Server Action (app/actions.ts) that inserts through
// the same Drizzle handle — the whole read/write path is typed SQL over Deno's
// built-in node:sqlite, no native addon.

import { listNotes } from "../lib/db.ts";
import { createNote } from "./actions.ts";

export default function Home() {
  const notes = listNotes();
  return (
    <main>
      <h1>Drizzle ORM on denext</h1>
      <p class="lede">
        Typed SQL over Deno's built-in <code>node:sqlite</code>, via denext's{" "}
        <code>better-sqlite3</code> compat. No native addon, no query engine.
      </p>

      <form action={createNote} class="add">
        <input
          name="title"
          placeholder="New note…"
          aria-label="Note title"
          required
        />
        <button type="submit">Add (no-JS)</button>
      </form>

      <ul id="notes">
        {notes.map((n) => (
          <li key={n.id} data-id={n.id}>
            {n.title}
          </li>
        ))}
      </ul>
    </main>
  );
}
