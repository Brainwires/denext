import { createMiddleware, createServerFn } from "@tanstack/react-start";

/** A note, kept in this server process's memory (the example needs no database). */
interface Note {
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

/** Function middleware: its server half adds context the handler reads. */
const where = createMiddleware({ type: "function" }).server(({ next }) =>
  next({
    context: { ranOn: typeof document === "undefined" ? "server" : "browser" },
  })
);

/** GET: called by the route loader (on the server for a page, over RPC after hydration). */
export const listNotes = createServerFn({ method: "GET" }).handler(() => notes);

/** POST: validated input, middleware context, a mutation. */
export const addNote = createServerFn({ method: "POST" })
  .middleware([where])
  .validator((data: { text: string }) => {
    const text = typeof data?.text === "string" ? data.text.trim() : "";
    if (!text) throw new Error("A note needs some text");
    return { text: text.slice(0, 200) };
  })
  .handler(({ data, context }) => {
    const note = {
      id: notes.length + 1,
      text: data.text,
      ranOn: context.ranOn,
    };
    notes.push(note);
    return note;
  });
