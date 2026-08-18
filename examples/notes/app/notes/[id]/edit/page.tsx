// Edit a note. This route CAN fail, on purpose, to show the error boundary:
//   - a note id that doesn't exist  → notFound()  (renders not-found.tsx, 404)
//   - a note owned by someone else  → throws       (renders error.tsx, 500)
// The thrown authorization error is the realistic failure the boundary catches.

import type { PageProps } from "denext/server";
import { notFound } from "denext";
import { currentUser } from "../../../../lib/auth.ts";
import { getNote } from "../../../../lib/db.ts";
import { update } from "../../../actions.ts";

export default async function EditNote({ params }: PageProps) {
  const id = Number(params.id);
  const note = getNote(id);
  if (!note) notFound();

  const user = await currentUser();
  if (!user || note!.user_id !== user.id) {
    throw new Error("You don't have permission to edit this note.");
  }

  return (
    <section>
      <h1>Edit note</h1>
      <form action={update} method="post" class="stack card">
        <input type="hidden" name="id" value={String(note!.id)} />
        <label>
          Title
          <input name="title" required maxLength={80} value={note!.title} />
        </label>
        <label>
          Body
          <textarea name="body" rows={4}>{note!.body}</textarea>
        </label>
        <label class="checkbox">
          <input
            type="checkbox"
            name="visibility"
            value="public"
            checked={note!.visibility === "public"}
          />
          Public (show on the home feed)
        </label>
        <div class="row">
          <button type="submit">Save changes</button>
          <a href="/notes" class="linkbtn">Cancel</a>
        </div>
      </form>
    </section>
  );
}
