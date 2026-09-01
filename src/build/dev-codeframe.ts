// Dev error-overlay helpers (pure, unit-tested): find the first stack frame that
// points inside the project, and render a codeframe (source snippet with a caret at
// the error column) around a line. Used by the dev server to enrich a build/SSR error
// with a clickable, source-mapped-ish frame + snippet in the browser overlay.

import { fromFileUrl } from "@std/path";

/** A source location parsed out of a stack trace. */
export interface StackFrame {
  /** Absolute filesystem path. */
  file: string;
  /** 1-based line number. */
  line: number;
  /** 1-based column number. */
  column: number;
}

// Matches `file:///abs/x.ts:12:34` and bare `/abs/x.ts:12:34` occurrences in a stack.
const FRAME_RE = /(file:\/\/\/[^\s():]+|\/[^\s():]+):(\d+):(\d+)/g;

/** Whether a frame path belongs to app source (not a dep cache / build output). */
function isAppFrame(file: string, rootDir: string): boolean {
  if (!file.startsWith(rootDir)) return false;
  // Skip generated/vendored trees even when they live under the project root.
  return !file.includes("/.denext/") && !file.includes("/node_modules/");
}

/**
 * The first stack frame that resolves to a file **inside `rootDir`** (skipping
 * `node_modules`/`.denext`), or `null` when the trace has none — so the overlay links
 * to the developer's own code, not framework or dependency internals.
 *
 * @param stack An `Error.stack` string.
 * @param rootDir The project root; only frames under it are considered.
 */
export function parseStackFrame(stack: string | undefined, rootDir: string): StackFrame | null {
  if (!stack) return null;
  for (const m of stack.matchAll(FRAME_RE)) {
    const raw = m[1];
    let file: string;
    try {
      file = raw.startsWith("file://") ? fromFileUrl(raw) : raw;
    } catch {
      continue;
    }
    if (isAppFrame(file, rootDir)) {
      return { file, line: Number(m[2]), column: Number(m[3]) };
    }
  }
  return null;
}

/**
 * A codeframe: `context` lines on each side of `line`, gutter-numbered, with a `>`
 * marker on the error line and a caret `^` under `column`. Returns `""` when the line
 * is out of range. Pure over the given source text (the caller reads the file).
 *
 * @param source The full source text.
 * @param line 1-based error line.
 * @param column 1-based error column (the caret position).
 * @param context Lines of context on each side (default 2).
 */
export function codeframe(source: string, line: number, column: number, context = 2): string {
  const lines = source.split("\n");
  if (line < 1 || line > lines.length) return "";
  const start = Math.max(1, line - context);
  const end = Math.min(lines.length, line + context);
  const gutterW = String(end).length;
  const out: string[] = [];
  for (let n = start; n <= end; n++) {
    const marker = n === line ? ">" : " ";
    const gutter = String(n).padStart(gutterW);
    out.push(`${marker} ${gutter} | ${lines[n - 1]}`);
    if (n === line && column >= 1) {
      // Align the caret: marker(1) + space(1) + gutter + " | " = gutterW + 4 cols.
      const pad = " ".repeat(gutterW + 4 + (column - 1));
      out.push(`${pad}^`);
    }
  }
  return out.join("\n");
}
