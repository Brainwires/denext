// Decide whether a page route needs a client hydration bundle — so a fully
// static route can ship ZERO JavaScript (no entry, no runtime, no hydration
// script). A route is "static" when nothing in its client tree is interactive:
// no state/effect/ref/context hooks, no DOM event handlers, and no ssr:false
// `dynamic()` island. Plain `<Link>`/anchor navigation does NOT count — it works
// without JS (and a soft client navigation INTO a static page, from an
// interactive one, still works because the source page's runtime drives the DOM).
//
// The check is deliberately CONSERVATIVE. It scans the route's whole transitive
// LOCAL import graph (so interactivity inside an imported component is caught),
// and errs toward hydrating on ANY signal — or ANY uncertainty (an unreadable
// module, a failed crawl). A false "interactive" only ships a tiny unnecessary
// bundle; a false "static" would ship a broken, non-interactive page.

import type { PageRoute } from "../router/manifest.ts";
import { crawlLocalModules } from "./module-graph.ts";
import { frameworkRoot, routeSourceFiles } from "./bundle.ts";

/**
 * Source tokens that require the client runtime. Note `useMemo`/`useCallback`/
 * `useId` are intentionally absent — they are pure and run only during render, so
 * a page using just those still needs no hydration. `<Link>` is absent too (it is
 * a plain anchor without JS).
 */
const INTERACTIVITY = new RegExp(
  [
    // State / effect / ref / context / concurrent hooks.
    "\\buse(State|Reducer|Effect|LayoutEffect|Ref|Context|Transition|DeferredValue|" +
    "SyncExternalStore|Optimistic|ActionState|FormStatus|ImperativeHandle|ErrorBoundary)\\b",
    // A JSX event-handler prop: onClick=, onInput=, onSubmit=, …
    "\\bon[A-Z][A-Za-z]*\\s*=",
    // Imperative navigation and ssr:false lazy islands.
    "\\b(useRouter|navigate|prefetch|dynamic)\\s*\\(",
    // Interactive Remix (denext/remix) hooks — action submission, navigation
    // state, fetchers, revalidation, deferred values — each backed by client
    // state/subscription, so a route using one must hydrate. The framework
    // modules that DEFINE them are excluded from the crawl (they would flag every
    // route), so these names are matched only where an app module uses them. The
    // read-only hooks (useLoaderData/useParams/useMatches/useLocation) are pure
    // server-renderable reads and intentionally absent.
    "\\buse(ActionData|Navigation|Navigate|Fetchers?|Submit|Revalidator|AsyncValue|AsyncError|Blocker)\\b",
    // Interactive Remix components: <Form> (submits / soft search-nav) and
    // <Await> (client-resolved deferred data).
    "<(Form|Await)\\b",
  ].join("|"),
);

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

/**
 * Blank the CONTENT of string/template literals and comments (preserving structure),
 * so the interactivity scan never trips on a token that only appears inside a string
 * — e.g. a documentation page rendering a `"use client"` / `onClick=` code sample
 * through a `<Code>{`…`}</Code>` literal. Real interactivity (hooks, JSX event
 * props) is written as code and survives, so the scan stays conservative for it.
 *
 * The stripper errs toward blanking: an unterminated literal blanks to end-of-input.
 * That can only REMOVE a signal from a stretch the author wrote as a string anyway,
 * never fabricate one, so a genuinely interactive module is never hidden by it.
 *
 * @param src Module source text.
 * @returns The source with literal/comment interiors replaced by spaces (newlines kept).
 */
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

function stripLiteralsAndComments(src: string): string {
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

/** Options for {@linkcode routeNeedsHydration}. */
export interface HydrationCheckOptions {
  /**
   * Read a module's source (defaults to `Deno.readTextFile`). Injectable for tests.
   */
  readFile?: (path: string) => Promise<string>;
  /**
   * Crawl the transitive local import graph of the given roots (defaults to
   * {@linkcode crawlLocalModules}). Injectable for tests.
   */
  crawl?: (roots: string[]) => Promise<string[]>;
}

/**
 * Does `route` need a client hydration bundle, or can it ship as pure server-
 * rendered HTML with no JavaScript? Returns `true` (needs hydration) if any
 * module in its client tree shows an interactivity signal, or if the graph cannot
 * be crawled/read (fail safe).
 *
 * @param route The page route to classify.
 * @param opts Injectable file reader / crawler (for tests).
 * @returns `true` if the route must hydrate; `false` if it is provably static.
 */
export async function routeNeedsHydration(
  route: PageRoute,
  opts: HydrationCheckOptions = {},
): Promise<boolean> {
  const readFile = opts.readFile ?? Deno.readTextFile;
  const roots = routeSourceFiles(route);
  if (roots.length === 0) return false; // nothing in the tree → nothing to hydrate

  let graph: string[];
  try {
    if (opts.crawl) {
      graph = await opts.crawl(roots);
    } else {
      const fw = frameworkRoot();
      // Exclude framework internals: they DEFINE the hooks, so scanning them would
      // flag every route. We only care about the app's own interactivity.
      graph = await crawlLocalModules(roots, { exclude: (p) => p.startsWith(fw) });
    }
  } catch {
    return true; // couldn't determine the graph → hydrate to be safe
  }

  for (const file of new Set([...roots, ...graph])) {
    let src: string;
    try {
      src = await readFile(file);
    } catch {
      return true; // couldn't read a module → hydrate to be safe
    }
    // Scan code only — a token inside a string/comment (e.g. a `<Code>` sample on
    // a docs page) is not real interactivity and must not force hydration.
    if (INTERACTIVITY.test(stripLiteralsAndComments(src))) return true;
  }
  return false; // provably static
}
