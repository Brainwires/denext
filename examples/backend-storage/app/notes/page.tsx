import { storage } from "@denext/backend/server";
import { saveNote } from "./actions.ts";

export const dynamic = "force-dynamic";

/** A versioned note: every save keeps the previous text as a noncurrent version. */
export default async function Notes() {
  const notes = storage.bucket("notes");
  const current = await notes.download("note.txt");
  const text = current ? await new Response(current.body).text() : "";
  // Versions of note.txt: the current one first, then the noncurrent ones, newest first.
  const history = (await notes.listFolder("", { versions: "include" }))
    .filter((entry) => entry.name === "note.txt");
  return (
    <main>
      <h1>A versioned note</h1>
      <form action={saveNote}>
        <textarea name="text" rows={6} cols={60}>{text}</textarea>
        <button type="submit">Save</button>
      </form>
      <h2>History</h2>
      <ol>
        {history.map((v) => <li key={v.id}>{v.updatedAt} — {v.metadata?.size} bytes</li>)}
      </ol>
      <p>
        <a href="/">Back</a>
      </p>
    </main>
  );
}
