// Detect leading `"use client"` / `"use server"` module directives.
//
// denext has no bundler transform, so the client/server boundary is discovered
// by reading each module's directive prologue: the run of leading string-literal
// statements at the very top of a module (JS directive-prologue semantics, the
// same mechanism as `"use strict"`). A whole-file regex would be wrong — it would
// match a `"use client"` string appearing anywhere in code or JSX — so this uses
// a tiny hand tokenizer that only inspects the prologue.

/** Which boundary a module declares, or null when it declares none. */
export type Directive = "client" | "server" | null;

// Characters that, appearing right after a leading string literal, mean the
// string is part of a larger expression (`"x" + y`, `"x".length`) rather than a
// standalone directive statement — which ends the directive prologue.
const EXPR_CONTINUATION = new Set([
  "+",
  "-",
  "*",
  "/",
  "%",
  "<",
  ">",
  "=",
  "&",
  "|",
  "^",
  "?",
  ".",
  ",",
  "(",
  "[",
  "`",
  ":",
]);

/** The outcome of scanning a (possibly partial) module source for a directive. */
interface DirectiveScan {
  /** The boundary directive found in the prologue, or null. */
  directive: Directive;
  /**
   * True when the scan consumed all of `source` without conclusively ending the
   * directive prologue (it ran out of input inside leading trivia, an unterminated
   * string, or right after a non-boundary directive). More source is needed to be
   * sure — {@link readDirective} grows its read window when this is set, so a
   * large license banner before `"use server"` cannot hide the directive.
   */
  truncated: boolean;
}

/**
 * Core prologue scan reporting whether the result is conclusive for the given
 * `source`. The prologue definitively ends (conclusive) at the first non-string
 * statement or when a string is used as an expression; a boundary directive is
 * likewise conclusive. Running off the end of `source` is inconclusive.
 */
/**
 * Skip whitespace and comments from `i`, returning the index of the next significant
 * char (or `n`). With `newlines: false` only same-line whitespace is skipped (the
 * look-ahead after a string statement), though a comment may still span lines.
 */
function skipTrivia(source: string, i: number, newlines: boolean): number {
  const n = source.length;
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];
    if (c === " " || c === "\t" || (newlines && (c === "\r" || c === "\n"))) i++;
    else if (c === "/" && next === "/") i = skipLineComment(source, i);
    else if (c === "/" && next === "*") i = skipBlockComment(source, i);
    else break;
  }
  return i;
}

/** The index of the newline ending the `//` comment at `i` (or `n`). */
function skipLineComment(source: string, i: number): number {
  const n = source.length;
  i += 2;
  while (i < n && source[i] !== "\n") i++;
  return i;
}

/** The index just past the close of the block comment at `i` (unterminated → past `n`). */
function skipBlockComment(source: string, i: number): number {
  const n = source.length;
  i += 2;
  while (i < n && !(source[i] === "*" && source[i + 1] === "/")) i++;
  return i + 2;
}

/**
 * Read the string literal opening at `i` (its quote char at `source[i]`). No escapes are
 * valid inside a real directive, but they are handled so an escaped quote does not end
 * the scan early. Returns null when the string is unterminated in this window.
 */
function readStringLiteral(source: string, i: number): { value: string; end: number } | null {
  const n = source.length;
  const quote = source[i];
  let value = "";
  i++; // opening quote
  while (i < n && source[i] !== quote) {
    if (source[i] === "\\" && i + 1 < n) {
      value += source[i + 1];
      i += 2;
    } else {
      value += source[i];
      i++;
    }
  }
  if (i >= n) return null;
  return { value, end: i + 1 }; // past the closing quote
}

/** One prologue statement's outcome: conclusive, keep scanning from `i`, or out of input. */
type PrologueStep =
  | { kind: "conclusive"; directive: Directive }
  | { kind: "next"; i: number }
  | { kind: "truncated" };

const TRUNCATED: PrologueStep = { kind: "truncated" };

function conclusive(directive: Directive): PrologueStep {
  return { kind: "conclusive", directive };
}

/**
 * Scan one prologue statement starting at `i`. The prologue definitively ends at the first
 * non-string statement or when a string is used as an expression (the same-line look-ahead
 * confirms the string is a standalone statement); a boundary directive is likewise
 * conclusive. Some other directive (e.g. "use strict") advances past its terminator so the
 * scan continues. Running out of input inside trivia or a string is inconclusive.
 */
function scanPrologueStatement(source: string, i: number): PrologueStep {
  const n = source.length;
  i = skipTrivia(source, i, true);
  if (i >= n) return TRUNCATED;
  const quote = source[i];
  if (quote !== '"' && quote !== "'") return conclusive(null);
  const lit = readStringLiteral(source, i);
  if (!lit) return TRUNCATED;
  const j = skipTrivia(source, lit.end, false);
  if (j < n && EXPR_CONTINUATION.has(source[j])) return conclusive(null);
  if (lit.value === "use client") return conclusive("client");
  if (lit.value === "use server") return conclusive("server");
  return { kind: "next", i: source[j] === ";" ? j + 1 : j };
}

/**
 * Core prologue scan reporting whether the result is conclusive for the given
 * `source`. Running off the end of `source` is inconclusive (the answer may lie further in).
 */
function scanDirectiveCore(source: string): DirectiveScan {
  // Skip a shebang line if present.
  let i = source.startsWith("#!") ? skipLineComment(source, 0) : 0;
  while (i < source.length) {
    const step = scanPrologueStatement(source, i);
    if (step.kind === "conclusive") return { directive: step.directive, truncated: false };
    if (step.kind === "truncated") break;
    i = step.i;
  }
  return { directive: null, truncated: true };
}

/**
 * Scan a module's source for a leading `"use client"` / `"use server"` directive.
 * Only the directive prologue is inspected; returns the first boundary directive
 * found there, or null. `"use client"` wins over a later `"use server"` in the
 * (invalid) case both appear — the linter flags mixing separately. `source` is
 * treated as the complete module text.
 *
 * @param source The module source text.
 * @returns `"client"`, `"server"`, or `null`.
 */
export function scanDirective(source: string): Directive {
  return scanDirectiveCore(source).directive;
}

/**
 * Read a module file and return its boundary directive. Reads the head of the
 * file (a directive prologue is always at the very top) but **grows the read
 * window** while the scan is inconclusive — so an arbitrarily large leading
 * license banner or block comment cannot hide a `"use server"` directive and
 * silently leak the module into the client bundle (a fail-open the fixed 1KB
 * head permitted). Reading stops as soon as the prologue conclusively ends or
 * the file is exhausted.
 *
 * @param filePath Absolute path to the module.
 * @param headBytes Initial number of leading bytes to read (default 1024).
 * @returns `"client"`, `"server"`, or `null` (also `null` if the file is unreadable).
 */
export async function readDirective(filePath: string, headBytes = 1024): Promise<Directive> {
  try {
    const file = await Deno.open(filePath, { read: true });
    try {
      const decoder = new TextDecoder();
      let source = "";
      let chunkSize = Math.max(1, headBytes);
      for (;;) {
        const buf = new Uint8Array(chunkSize);
        const read = await file.read(buf);
        if (read === null || read === 0) {
          // EOF: the accumulated source is the complete module.
          return scanDirective(source);
        }
        source += decoder.decode(buf.subarray(0, read), { stream: true });
        const scan = scanDirectiveCore(source);
        if (!scan.truncated) return scan.directive; // conclusive — stop reading
        // Inconclusive (still inside leading trivia/a long banner): read more,
        // doubling the window (bounded) to keep the read count small.
        chunkSize = Math.min(chunkSize * 2, 64 * 1024);
      }
    } finally {
      file.close();
    }
  } catch {
    return null;
  }
}
