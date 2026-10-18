// The notes' store: a `*.server.*` module, so TanStack Start's import protection keeps it out of
// the browser. Only the server functions' handlers in ./notes.ts use it; Start's compiler removes
// those handlers from the browser build, and this module with them. Importing it from code the
// browser runs fails the build with Start's `[import-protection]` error.

/** A note, kept in this server process's memory (the example needs no database). */
export interface Note {
  id: number;
  text: string;
  /** Where the function ran — always the server. */
  ranOn: string;
}

const notes: Note[] = [{
  id: 1,
  text: "Server functions run on the server",
  ranOn: "server",
}];

/** Every note. */
export function readNotes(): Note[] {
  return notes;
}

/** Add a note: the store's only write path. */
export function saveNote(text: string, ranOn: string): Note {
  const note = { id: notes.length + 1, text, ranOn };
  notes.push(note);
  console.log(`notes.server.ts stored note ${note.id}`);
  return note;
}
