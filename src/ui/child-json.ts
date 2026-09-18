// Reading a JSON document back out of a `deno` child's combined output.
//
// Two panels discover by spawning a CLI verb with `--json` and parsing what it printed
// (`denext commands --json`, `denext task --list --json`). Neither gets a clean stdout: Deno
// itself may write a `Download …` line, a warning, or a permission prompt around the document.
// Both verbs pretty-print, so the document reliably opens on a bare `{` line and closes on the
// last bare `}` line — everything outside that span is noise and is dropped.

/**
 * Extract and parse the JSON document a child process printed.
 *
 * @param output Everything the child wrote, newline-joined.
 * @returns The parsed object, or `null` when there was no parsable document. A non-object
 * document (a bare array, a number) is `null` too: every caller here expects an object.
 */
export function parseJsonDocument<T>(output: string): T | null {
  const lines = output.split("\n").map((line) => line.replace(/\r$/, ""));
  const open = lines.indexOf("{");
  const close = lines.lastIndexOf("}");
  if (open < 0 || close < open) return null;
  try {
    const parsed = JSON.parse(lines.slice(open, close + 1).join("\n"));
    return parsed !== null && typeof parsed === "object" ? parsed as T : null;
  } catch {
    return null;
  }
}
