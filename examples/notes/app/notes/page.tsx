// The signed-in user's notes, plus a create form and per-note edit/delete. This
// route is gated by middleware.ts — an unauthenticated request never reaches here.

import { currentUser } from "../../lib/auth.ts";
import { listUserNotes } from "../../lib/db.ts";
import { create, remove } from "../actions.ts";

export default async function MyNotes() {
  const user = await currentUser();
  // middleware guarantees a session, but satisfy the types (and defend in depth).
  const notes = user ? listUserNotes(user.id) : [];
  return (
    <section>
      <h1>My notes</h1>

      <form action={create} method="post" class="stack card">
        <h2>New note</h2>
        <label>
          Title
          <input
            name="title"
            required
            maxLength={80}
            placeholder="A short title"
          />
        </label>
        <label>
          Body
          <textarea name="body" rows={3} placeholder="Write something…" />
        </label>
        <label class="checkbox">
          <input type="checkbox" name="visibility" value="public" />
          Public (show on the home feed)
        </label>
        <button type="submit">Add note</button>
      </form>

      {notes.length === 0 ? <p class="empty">No notes yet — add one above.</p> : (
        <ul class="feed">
          {notes.map((n) => (
            <li key={n.id} class="card">
              <h2>{n.title}</h2>
              <p>{n.body}</p>
              <footer class="row">
                <span
                  class={n.visibility === "public" ? "tag pub" : "tag priv"}
                >
                  {n.visibility}
                </span>
                <span class="grow" />
                <a href={`/notes/${n.id}/edit`} class="linkbtn">Edit</a>
                <form action={remove} method="post" class="inline">
                  <input type="hidden" name="id" value={String(n.id)} />
                  <button type="submit" class="linkbtn danger">Delete</button>
                </form>
              </footer>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
