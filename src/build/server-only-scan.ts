// Server-only leak detection for a browser bundle — a leaf module (no framework imports),
// shared by the bundler (`bundle.ts`, which fails a bundle that shipped a leak) and the
// hydration scan (`hydration.ts`, which reuses the literal stripper).
//
// A hydrating route with no `"use client"` boundary bundles its WHOLE tree — page, layouts
// and everything they import — for the browser, and a `"use client"` island ships with its
// imports. `deno bundle --platform=browser` emits a `node:` import or a `Deno.env.get`
// verbatim, so a `lib/db.ts` reached from either graph ships to the browser and fails only
// when the page runs there. These helpers make that a build-time error naming the module,
// the entry that pulled it in, and the fix.

import { relative } from "@std/path";

// ---- Literal / comment stripping -----------------------------------------------------------

// Previous-token context in which a `/` legally begins a REGEX literal (rather than
// division). Deliberately excludes `<`, `>`, and `}` so JSX `</div>`, `/>`, and
// `{a}/{b}` are never misread as a regex — the safe direction is to treat an
// ambiguous `/` as division (emit it as code) rather than blank real markup.
const REGEX_PREV_CHARS = new Set(
  ["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", ";", "+", "-", "*", "%", "^", "~"],
);
// Keywords after which a `/` begins a regex (e.g. `return /re/`).
const REGEX_PREV_KEYWORDS = new Set(
  [
    "return",
    "typeof",
    "instanceof",
    "in",
    "of",
    "new",
    "delete",
    "void",
    "do",
    "else",
    "yield",
    "await",
    "case",
  ],
);

/** The stripper's cursor + regex-vs-division disambiguation state. */
interface StripState {
  readonly src: string;
  readonly n: number;
  i: number;
  readonly out: string[];
  /** The last significant (non-space) code char emitted. */
  prevSig: string;
  /** The identifier token that ended at `prevSig` (for keyword checks). */
  lastWord: string;
  curWord: string;
}

function isIdentChar(ch: string): boolean {
  return (ch >= "0" && ch <= "9") || (ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z") ||
    ch === "_" || ch === "$";
}

/** Blank `[from, to)` to spaces, keeping newlines so line numbers survive. */
function blank(st: StripState, from: number, to: number): void {
  for (let k = from; k < to; k++) st.out.push(st.src[k] === "\n" ? "\n" : " ");
}

/**
 * A comment is transparent to token state (it separates tokens like whitespace), so it
 * ends the current word but keeps prevSig/lastWord.
 */
function stripLineComment(st: StripState): void {
  const start = st.i;
  st.i += 2;
  while (st.i < st.n && st.src[st.i] !== "\n") st.i++;
  blank(st, start, st.i);
  st.curWord = "";
}

function stripBlockComment(st: StripState): void {
  const start = st.i;
  st.i += 2;
  while (st.i < st.n && !(st.src[st.i] === "*" && st.src[st.i + 1] === "/")) st.i++;
  st.i = Math.min(st.n, st.i + 2);
  blank(st, start, st.i);
  st.curWord = "";
}

/**
 * The index just past a regex literal's closing `/` + flags when one starts at `i`, or
 * -1 when no closing `/` occurs on the line (it was division after all). Tracks `[…]`
 * classes (a `/` inside one does not close) and `\\` escapes.
 */
function regexEnd(src: string, i: number): number {
  const n = src.length;
  let j = i + 1;
  let inClass = false;
  while (j < n) {
    const ch = src[j];
    if (ch === "\n") return -1; // a regex literal cannot span a line
    if (ch === "\\") {
      j += 2;
      continue;
    }
    if (inClass) inClass = ch !== "]";
    else if (ch === "[") inClass = true;
    else if (ch === "/") return skipRegexFlags(src, j + 1);
    j++;
  }
  return -1;
}

/** The index past the trailing regex flags starting at `j`. */
function skipRegexFlags(src: string, j: number): number {
  while (j < src.length && isIdentChar(src[j])) j++;
  return j;
}

/**
 * Regex literal — only where a `/` can legally begin one (never a JSX `</`, `/>`, or a
 * division). Its interior is blanked like a string so an interactivity token, or a
 * stray quote, inside it can't leak into the scan. Returns false to fall through (the
 * `/` is division).
 */
function tryStripRegex(st: StripState): boolean {
  const { prevSig, lastWord } = st;
  const regexAllowed = prevSig === "" || REGEX_PREV_CHARS.has(prevSig) ||
    (isIdentChar(prevSig) && REGEX_PREV_KEYWORDS.has(lastWord));
  if (!regexAllowed) return false;
  const end = regexEnd(st.src, st.i);
  if (end === -1) return false;
  blank(st, st.i, end);
  st.prevSig = ")"; // a regex is a value → a following `/` is division
  st.lastWord = "";
  st.curWord = "";
  st.i = end;
  return true;
}

/** A string or template literal: keep the quotes, blank the interior (escape pairs too). */
function stripStringLiteral(st: StripState): void {
  const { src, n, out } = st;
  const quote = src[st.i];
  out.push(quote);
  st.i++;
  while (st.i < n) {
    if (src[st.i] === "\\") {
      blank(st, st.i, Math.min(n, st.i + 2));
      st.i += 2;
      continue;
    }
    if (src[st.i] === quote) {
      out.push(quote);
      st.i++;
      break;
    }
    out.push(src[st.i] === "\n" ? "\n" : " ");
    st.i++;
  }
  st.prevSig = quote; // the string is a value → a following `/` is division
  st.lastWord = "";
  st.curWord = "";
}

/** Emit one code char, tracking token state for the regex check. */
function emitCodeChar(st: StripState, c: string): void {
  st.out.push(c);
  if (c === " " || c === "\t" || c === "\n" || c === "\r") {
    st.curWord = ""; // whitespace ends the current word; prevSig/lastWord persist
  } else if (isIdentChar(c)) {
    st.curWord += c;
    st.lastWord = st.curWord;
    st.prevSig = c;
  } else {
    st.prevSig = c;
    st.lastWord = "";
    st.curWord = "";
  }
  st.i++;
}

/**
 * Blank the CONTENT of string/template literals and comments (preserving structure),
 * so a source scan — the hydration check, the server-only signals — never trips on a
 * token that only appears inside a string, e.g. a documentation page rendering a
 * `"use client"` / `onClick=` / `node:sqlite` code sample through a `<Code>{`…`}</Code>`
 * literal. Real code (a hook, a JSX event prop, a `node:` import, a `Deno.` access)
 * survives, so a scan stays conservative for it. Every blanked span keeps its length, so
 * an offset into the result indexes the original source.
 *
 * The stripper errs toward blanking: an unterminated literal blanks to end-of-input.
 * That can only REMOVE a signal from a stretch the author wrote as a string anyway,
 * never fabricate one, so a genuinely interactive module is never hidden by it.
 *
 * @param src Module source text.
 * @returns The source with literal/comment interiors replaced by spaces (newlines kept).
 */
export function stripLiteralsAndComments(src: string): string {
  const st: StripState = {
    src,
    n: src.length,
    i: 0,
    out: [],
    prevSig: "",
    lastWord: "",
    curWord: "",
  };
  while (st.i < st.n) {
    const c = src[st.i];
    const next = src[st.i + 1];
    if (c === "/" && next === "/") stripLineComment(st);
    else if (c === "/" && next === "*") stripBlockComment(st);
    else if (c === "/" && tryStripRegex(st)) continue;
    else if (c === '"' || c === "'" || c === "`") stripStringLiteral(st);
    else emitCodeChar(st, c);
  }
  return st.out.join("");
}

// ---- Server-only signals --------------------------------------------------------------------

/** Why a module is server-only (see {@link serverOnlySignals}). */
export type ServerOnlySignal = "node-import" | "server-only-marker" | "deno-global";

/** `import`/`export` keywords — the statement heads {@link staticImportSpecifiers} walks. */
const STATEMENT_HEAD = /\b(import|export)\b/g;

/**
 * The specifier of every STATIC import / re-export in a module: `import … from "x"`,
 * `import "x"`, `export … from "x"`. A type-only statement (`import type`, or an import
 * list whose every name is `type`-prefixed) is elided by the bundler and is not reported;
 * a dynamic `import("x")` is skipped too (it loads nothing at link time, and a guarded one
 * is the idiomatic isomorphic pattern). `code` is `src` with literal/comment interiors
 * blanked (same length), so a specifier is read from `src` only where `code` shows a
 * real import — one quoted inside a string or comment is never seen.
 */
function staticImportSpecifiers(src: string, code: string): string[] {
  const heads = [...code.matchAll(STATEMENT_HEAD)];
  const out: string[] = [];
  heads.forEach((m, i) => {
    const at = m.index + m[1].length;
    // The statement's own text: up to its `;` or the next statement head (ASI style).
    const semi = code.indexOf(";", at);
    const nextHead = heads[i + 1]?.index ?? code.length;
    const stmt = code.slice(at, Math.min(nextHead, semi === -1 ? code.length : semi));
    const quote = importQuoteIndex(stmt, m[1] === "import");
    if (quote === -1) return;
    const q = at + quote;
    const end = src.indexOf(src[q], q + 1);
    if (end > q) out.push(src.slice(q + 1, end));
  });
  return out;
}

/**
 * Where the specifier's opening quote sits in one import/export statement's text, or -1
 * when the statement imports no runtime value: a bare `import "x"` (side effect), or a
 * `from "x"` clause — unless the statement is `import type` / `export type`, or its
 * `{ … }` list names only `type` members.
 */
function importQuoteIndex(stmt: string, isImport: boolean): number {
  const body = stmt.replace(/^\s+/, "");
  const lead = stmt.length - body.length;
  if (isImport && (body[0] === '"' || body[0] === "'")) return lead;
  if (/^type[\s{]/.test(body)) return -1;
  const from = /\bfrom\s*(["'])/.exec(body);
  if (!from) return -1;
  const list = /\{([^}]*)\}/.exec(body.slice(0, from.index));
  if (list) {
    const names = list[1].split(",").map((n) => n.trim()).filter(Boolean);
    if (names.length > 0 && names.every((n) => /^type\s/.test(n))) return -1;
  }
  return lead + from.index + from[0].length - 1;
}

/** `server-only` in every spelling denext resolves: the bare package, `denext/server-only`, or its module path. */
function isServerOnlyMarker(spec: string): boolean {
  return spec === "server-only" || spec.endsWith("/server-only") ||
    spec.endsWith("/compat/server-only.ts");
}

/**
 * The server-only signals in a module's source: a static `node:` import (a type-only one
 * is elided by the bundler and does not count), the `server-only` marker (`import
 * "server-only"` / `denext/server-only`, or a `serverOnly()` call), and an unguarded
 * `Deno.` member access — a module that tests `typeof Deno` is isomorphic by intent and
 * is exempt. Strings and comments are blanked first, so a docs page quoting `node:sqlite`
 * or `Deno.env` in a code sample is clean.
 *
 * @param src Module source text.
 * @returns The distinct signals found (empty for a browser-safe module).
 */
export function serverOnlySignals(src: string): ServerOnlySignal[] {
  const code = stripLiteralsAndComments(src);
  const out = new Set<ServerOnlySignal>();
  for (const spec of staticImportSpecifiers(src, code)) {
    if (spec.startsWith("node:")) out.add("node-import");
    else if (isServerOnlyMarker(spec)) out.add("server-only-marker");
  }
  if (/\bserverOnly\s*\(/.test(code)) out.add("server-only-marker");
  if (/\bDeno\./.test(code) && !/\btypeof\s+Deno\b/.test(code)) out.add("deno-global");
  return [...out];
}

// ---- Leaks in a bundle ----------------------------------------------------------------------

/** A server-only module that a browser bundle shipped. */
export interface ServerOnlyLeak {
  /** Absolute path of the server-only module. */
  module: string;
  /** Why it is server-only. */
  signals: ServerOnlySignal[];
}

/**
 * Whether a shipped source is one of the app's own modules — under `projectDir` (already
 * realpath'd) and not a vendored `node_modules` package. Framework source, npm/jsr caches,
 * and the bundler's temp entry/stub files all fall outside.
 */
function isAppModule(path: string, projectDir: string): boolean {
  return path.startsWith(projectDir + "/") && !path.includes("/node_modules/");
}

/**
 * The server-only modules a browser bundle shipped: every app module among `shipped` (the
 * bundle's source-map `sources` — what survived tree-shaking, so a pure helper the entry
 * never used is not a leak) whose source carries a {@link ServerOnlySignal}.
 *
 * @param shipped Realpath'd absolute paths of the modules the bundle emitted.
 * @param projectDir The app's project directory (the boundary of "app module").
 * @param readFile Read a module's source (defaults to `Deno.readTextFile`).
 * @returns The leaks, in `shipped` order.
 */
export async function findServerOnlyLeaks(
  shipped: Iterable<string>,
  projectDir: string,
  readFile: (path: string) => Promise<string> = Deno.readTextFile,
): Promise<ServerOnlyLeak[]> {
  let root = projectDir;
  try {
    root = await Deno.realPath(projectDir);
  } catch { /* keep the logical path */ }
  const leaks: ServerOnlyLeak[] = [];
  for (const path of shipped) {
    if (!isAppModule(path, root)) continue;
    let src: string;
    try {
      src = await readFile(path);
    } catch {
      continue;
    }
    const signals = serverOnlySignals(src);
    if (signals.length > 0) leaks.push({ module: path, signals });
  }
  return leaks;
}

/** A one-phrase reading of each signal for the leak report. */
const SIGNAL_TEXT: Record<ServerOnlySignal, string> = {
  "node-import": "imports a node: built-in",
  "server-only-marker": "is marked server-only",
  "deno-global": "uses the Deno global",
};

/**
 * The error message for a bundle's leaks: each module, why it is server-only, which entries
 * shipped it, and the fix. Paths are shown relative to `projectDir`.
 *
 * @param leaks Module path → its leak and the labels of the entries that shipped it.
 * @param projectDir The directory paths are made relative to.
 */
export function formatServerOnlyLeaks(
  leaks: Map<string, { leak: ServerOnlyLeak; entries: string[] }>,
  projectDir: string,
): string {
  const show = (p: string) => {
    const rel = relative(projectDir, p);
    return rel.startsWith("..") ? p : rel;
  };
  const lines = [...leaks.values()].map(({ leak, entries }) =>
    `  ${show(leak.module)} — ${leak.signals.map((s) => SIGNAL_TEXT[s]).join("; ")}\n` +
    `    shipped by ${entries.join(", ")}`
  );
  return `denext: server-only code would ship to the browser.\n\n${lines.join("\n")}\n\n` +
    `A route with a hook or event handler and no "use client" boundary hydrates as a whole, ` +
    `so its page, layouts and everything they import are bundled for the browser; a ` +
    `"use client" island ships with its imports too. Fix: move the interactive part into ` +
    `a "use client" component so the route stays a Server Component (its imports then never ` +
    `leave the server), and keep the module marked server-only — \`import "server-only"\` ` +
    `at its top, or \`serverOnly()\` from denext — so a future leak fails here too.`;
}
