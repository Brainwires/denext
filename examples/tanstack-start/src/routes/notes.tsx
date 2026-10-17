import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { addNote, listNotes } from "../functions/notes.ts";

// The loader calls a server function: in-process for the server render, over Start's RPC after
// a client navigation. The button calls a POST server function from the browser.
export const Route = createFileRoute("/notes")({
  loader: () => listNotes(),
  component: Notes,
});

function Notes() {
  const notes = Route.useLoaderData();
  const router = useRouter();
  const [text, setText] = useState("");
  const [status, setStatus] = useState("");
  const add = async () => {
    try {
      const note = await addNote({ data: { text } });
      setStatus(`added #${note.id} on the ${note.ranOn}`);
      setText("");
      await router.invalidate();
    } catch (err) {
      setStatus(`error: ${(err as Error).message}`);
    }
  };
  return (
    <section id="notes">
      <h1>Notes</h1>
      <ul>
        {notes.map((n) => <li key={n.id}>{n.text}</li>)}
      </ul>
      <input
        id="note-text"
        value={text}
        onChange={(e) => setText(e.currentTarget.value)}
      />
      <button type="button" id="add-note" onClick={add}>Add</button>
      <p id="note-status">{status}</p>
    </section>
  );
}
