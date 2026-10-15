// Lexical helpers over the source a diagnostic points into. Deliberately small and
// forgiving: they read just enough of the file to name a property path or find a switch, and
// return nothing rather than guess when the text isn't shaped as expected.

/** The 0-based offset of a 1-based `line`/`column`, or -1 when out of range. */
export function offsetOf(source: string, line: number, column: number): number {
  let offset = 0;
  for (let l = 1; l < line; l++) {
    const nl = source.indexOf("\n", offset);
    if (nl < 0) return -1;
    offset = nl + 1;
  }
  return offset + column - 1;
}

/** The text of a 1-based line (`""` when out of range). */
export function lineText(source: string, line: number): string {
  return source.split("\n")[line - 1] ?? "";
}

const CLOSE: Record<string, string> = { "}": "{", ")": "(", "]": "[" };
const OPEN = new Set(["{", "(", "["]);
const QUOTES = new Set(['"', "'", "`"]);

/** Index of the opening quote matching the closing one at `i`, scanning backwards. */
function skipStringBack(source: string, i: number): number {
  const q = source[i];
  for (let j = i - 1; j >= 0; j--) {
    if (source[j] === q && source[j - 1] !== "\\") return j;
  }
  return 0;
}

/** The unmatched opening bracket before `from` (and its index), skipping balanced pairs. */
function openerBefore(source: string, from: number): { ch: string; at: number } | null {
  let depth = 0;
  for (let i = from; i >= 0; i--) {
    const ch = source[i];
    if (QUOTES.has(ch)) i = skipStringBack(source, i);
    else if (CLOSE[ch]) depth++;
    else if (OPEN.has(ch) && depth-- === 0) return { ch, at: i };
  }
  return null;
}

/** The property key written just before index `colon` (`key:` / `"key":`), or null. */
function keyBefore(source: string, colon: number): { key: string; at: number } | null {
  const m = /(["']?)([\w$-]+)\1\s*$/.exec(source.slice(Math.max(0, colon - 200), colon));
  if (!m) return null;
  return { key: m[2], at: colon - m[0].length };
}

/** Is the identifier at `[start, end)` written as an object key (`key:` or a shorthand)? */
function isKeyAt(source: string, start: number, end: number): boolean {
  const after = source.slice(end).trimStart();
  if (after.startsWith(":") && !after.startsWith("::")) return true;
  const before = source.slice(0, start).trimEnd();
  return /[{,]$/.test(before) && /^[,}]/.test(after) && openerBefore(source, start - 1)?.ch === "{";
}

/**
 * The object-literal key path that leads to the key at `offset` — `theme.mode` for the `mode`
 * in `{ theme: { mode: "blue" } }` — or `[]` when the span isn't an object key.
 *
 * @param source The file text.
 * @param offset The 0-based offset of the span.
 * @param span The span text (the key itself, when it is one).
 * @returns The keys, outermost first.
 */
export function keyPathAt(source: string, offset: number, span: string): string[] {
  if (!/^[\w$]+$/.test(span) || !isKeyAt(source, offset, offset + span.length)) return [];
  const path = [span];
  let from = offset - 1;
  for (let guard = 0; guard < 32; guard++) {
    const open = openerBefore(source, from);
    if (!open || open.ch !== "{") break;
    const before = source.slice(0, open.at).trimEnd();
    if (!before.endsWith(":")) break;
    const key = keyBefore(source, before.length - 1);
    if (!key) break;
    path.unshift(key.key);
    from = key.at - 1;
  }
  return path;
}

/** The typed API client call around `offset`: its route path and method, when written inline. */
export function apiCallAt(
  source: string,
  offset: number,
): { path: string; method: string } | null {
  const start = Math.max(0, offset - 600);
  const window = source.slice(start, offset);
  const re = /\b[\w$.]+\(\s*["'`](\/[^"'`]*)["'`]\s*,\s*["'`]([A-Z]+)["'`]/g;
  let last: RegExpExecArray | null = null;
  for (let m = re.exec(window); m; m = re.exec(window)) last = m;
  if (!last) return null;
  // The span must sit inside that call's parentheses (not in a later statement).
  const paren = start + last.index + last[0].indexOf("(");
  return insideOpener(source, paren, offset) ? { path: last[1], method: last[2] } : null;
}

/** Is `offset` nested (at any depth) inside the bracket opened at `opener`? */
function insideOpener(source: string, opener: number, offset: number): boolean {
  for (let at = offset - 1;;) {
    const found = openerBefore(source, at);
    if (!found || found.at < opener) return false;
    if (found.at === opener) return true;
    at = found.at - 1;
  }
}

/**
 * The text from `start` to the end of the statement that begins there: the first `;` (or blank
 * line) outside any brackets.
 */
export function statementFrom(source: string, start: number): string {
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{" || ch === "(" || ch === "[") depth++;
    else if (ch === "}" || ch === ")" || ch === "]") depth--;
    else if (depth === 0 && (ch === ";" || source.startsWith("\n\n", i))) {
      return source.slice(start, i);
    }
  }
  return source.slice(start);
}

/** The body of the `{ … }` block opening at or after `from` (balanced), or `""`. */
export function blockAfter(source: string, from: number): string {
  const open = source.indexOf("{", from);
  if (open < 0) return "";
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(open + 1, i);
  }
  return source.slice(open + 1);
}

/** The initializer of `const|let|var name = …` declared before `offset`, if any. */
export function initializerOf(source: string, name: string, offset: number): string | null {
  const escaped = name.replace(/[$]/g, "\\$");
  const re = new RegExp(`\\b(?:const|let|var)\\s+${escaped}\\s*(?::[^=]+)?=\\s*`, "g");
  let found: string | null = null;
  for (let m = re.exec(source); m && m.index < offset; m = re.exec(source)) {
    found = statementFrom(source, m.index + m[0].length).trim();
  }
  return found;
}
