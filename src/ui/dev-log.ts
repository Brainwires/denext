// What `denext dev` has printed, kept per project so a page can render it.
//
// The UI streams a dev server's output to every open page as SSE `dev-output` frames, but a
// frame only reaches a page that is *already* listening. Three ordinary things end that
// listening, and each one used to lose the output entirely:
//
//   * a no-JS form post, which navigates and rebuilds the document (and with it `ui.js`'s one
//     `EventSource`);
//   * a JS-on post, where `swapPanel` replaces `#panel` and the `<pre class="out">` inside it;
//   * opening the wizard in a second tab, or reloading the first.
//
// So the lines are also kept here and rendered into the panel on every request. The SSE frames
// stay — they are what makes the output live — but they are no longer the only copy, which is
// what made starting a dev server look like it did nothing at all.
//
// In memory on purpose: this is a view of a running child, not a record. It is not written to
// `.denext/` (the UI does not create files in a project to serve its own UI), and a restarted
// UI starts empty — it can still discover and stop the dev server through `.denext/dev.json`.

/**
 * Lines kept per project. A dev server is chatty (every request, every rebuild), and the panel
 * shows a scrolling tail, so an unbounded buffer would retain megabytes for output nobody can
 * read. This is the tail worth rendering.
 */
const MAX_LINES = 500;

/** Project directory → its dev server's recent output. */
const logs = new Map<string, string[]>();

/**
 * Append one line of a dev server's output.
 *
 * @param dir The project directory.
 * @param line The line, as `runDeno` decoded it.
 */
export function recordDevLine(dir: string, line: string): void {
  const lines = logs.get(dir) ?? [];
  lines.push(line);
  if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
  logs.set(dir, lines);
}

/**
 * The output kept for a project.
 *
 * @param dir The project directory.
 * @returns The retained lines, oldest first (empty when nothing has been recorded).
 */
export function devLog(dir: string): readonly string[] {
  return logs.get(dir) ?? [];
}

/**
 * The output as one block of text, for a `<pre>`.
 *
 * @param dir The project directory.
 * @returns The lines joined by newlines, or `""` when there are none.
 */
export function devLogText(dir: string): string {
  return devLog(dir).join("\n");
}

/**
 * Forget a project's output — when a dev server is stopped from the UI, so the next one starts
 * against a clean panel rather than appending to a dead server's log.
 *
 * @param dir The project directory.
 */
export function clearDevLog(dir: string): void {
  logs.delete(dir);
}
