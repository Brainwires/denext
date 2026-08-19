// A Server Component: it awaits the Prisma query on the server and renders the rows.
// The <form> posts a Server Action (app/actions.ts) that inserts through the same
// Prisma client — typed models over Deno's built-in node:sqlite, Rust-free.

import { listNotes } from "../lib/db.ts";
import { createNote } from "./actions.ts";

export default async function Home() {
  const notes = await listNotes();
  return (
    <main>
      <h1>Prisma on denext</h1>
      <p class="lede">
        Typed models over Deno's built-in{" "}
        <code>node:sqlite</code>, via the Prisma driver adapter + denext's{" "}
        <code>better-sqlite3</code> compat. No native addon, no Rust query engine.
      </p>

      <form action={createNote} class="add">
        <input name="title" placeholder="New note…" aria-label="Note title" required />
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
