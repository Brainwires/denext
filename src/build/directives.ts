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
function scanDirectiveCore(source: string): DirectiveScan {
  let i = 0;
  const n = source.length;

  // Skip a shebang line if present.
  if (source.startsWith("#!")) {
    while (i < n && source[i] !== "\n") i++;
  }

  // Skip whitespace and comments.
  const skipTrivia = (): void => {
    while (i < n) {
      const c = source[i];
      if (c === " " || c === "\t" || c === "\r" || c === "\n") {
        i++;
      } else if (c === "/" && source[i + 1] === "/") {
        i += 2;
        while (i < n && source[i] !== "\n") i++;
      } else if (c === "/" && source[i + 1] === "*") {
        i += 2;
        while (i < n && !(source[i] === "*" && source[i + 1] === "/")) i++;
        i += 2;
      } else {
        break;
      }
    }
  };

  while (i < n) {
    skipTrivia();
    if (i >= n) break; // ran out inside trivia — need more source
    const quote = source[i];
    // First non-string statement: the prologue is definitively over.
    if (quote !== '"' && quote !== "'") return { directive: null, truncated: false };

    // Read the string literal (no escapes are valid inside a real directive, but
    // handle them so an escaped quote does not end the scan early).
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
    if (i >= n) break; // unterminated string in this window — need more source
    i++; // closing quote

    // Look ahead (same-line trivia) to confirm this string is a standalone
    // statement and not the start of an expression.
    let j = i;
    while (j < n) {
      const c = source[j];
      if (c === " " || c === "\t") {
        j++;
      } else if (c === "/" && source[j + 1] === "/") {
        j += 2;
        while (j < n && source[j] !== "\n") j++;
      } else if (c === "/" && source[j + 1] === "*") {
        j += 2;
        while (j < n && !(source[j] === "*" && source[j + 1] === "/")) j++;
        j += 2;
      } else {
        break;
      }
    }
    const after = source[j];
    // A string used as an expression ends the prologue (conclusive).
    if (j < n && EXPR_CONTINUATION.has(after)) return { directive: null, truncated: false };

    // Committed directive statement. Classify it.
    if (value === "use client") return { directive: "client", truncated: false };
    if (value === "use server") return { directive: "server", truncated: false };

    // Some other directive (e.g. "use strict") — advance past a terminator and
    // keep scanning the prologue for a boundary directive.
    i = j;
    if (source[i] === ";") i++;
  }

  // Consumed everything without a definitive end: the answer may lie further in.
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
