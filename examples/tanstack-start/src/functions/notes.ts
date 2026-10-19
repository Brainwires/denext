import { createMiddleware, createServerFn } from "@tanstack/react-start";
// A `*.server.*` module: only the handlers below use it, so it never reaches the browser.
import { readNotes, saveNote } from "./notes.server.ts";

/** Function middleware: its server half adds context the handler reads. */
const where = createMiddleware({ type: "function" }).server(({ next }) =>
  next({
    context: { ranOn: typeof document === "undefined" ? "server" : "browser" },
  })
);

/** GET: called by the route loader (on the server for a page, over RPC after hydration). */
export const listNotes = createServerFn({ method: "GET" }).handler(() => readNotes());

/** POST: validated input, middleware context, a mutation. */
export const addNote = createServerFn({ method: "POST" })
  .middleware([where])
  .validator((data: { text: string }) => {
    const text = typeof data?.text === "string" ? data.text.trim() : "";
    if (!text) throw new Error("A note needs some text");
    return { text: text.slice(0, 200) };
  })
  .handler(({ data, context }) => saveNote(data.text, context.ranOn));
