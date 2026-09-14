// Comment stripping for source text that is scanned rather than parsed.
//
// A few build/CLI passes only need to know whether some text *contains* a token
// (a `Deno.env.get("X")` call, a separator comma) and must not be fooled by a
// commented-out occurrence — parsing the whole module would be overkill. This is
// the shared regex pass: string and template literals survive intact, `//` line
// comments and `/* … */` block comments are removed.

/** Strings and template literals survive; `//` and block comments are dropped. */
const COMMENT_OR_STRING =
  /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;

/**
 * Remove JavaScript/TypeScript comments from `src`, leaving string and template
 * literals (and everything else, including whitespace) untouched.
 *
 * Regex-based, not a parser: a `//` inside a regex literal (`/a\/\/b/`) is treated
 * as a comment. That is harmless for the scanning callers this exists for.
 *
 * @param src Source text to scan.
 * @returns The same text with every comment removed.
 */
export function stripComments(src: string): string {
  return src.replace(
    COMMENT_OR_STRING,
    (m) => (m.startsWith("//") || m.startsWith("/*") ? "" : m),
  );
}
