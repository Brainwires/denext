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
  ].join("|"),
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
export function stripLiteralsAndComments(src: string): string {
  const n = src.length;
  const out: string[] = [];
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) out.push(src[k] === "\n" ? "\n" : " ");
  };
  while (i < n) {
    const c = src[i];
    // Line comment.
    if (c === "/" && src[i + 1] === "/") {
      const start = i;
      i += 2;
      while (i < n && src[i] !== "\n") i++;
      blank(start, i);
      continue;
    }
    // Block comment.
    if (c === "/" && src[i + 1] === "*") {
      const start = i;
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i = Math.min(n, i + 2);
      blank(start, i);
      continue;
    }
    // String or template literal.
    if (c === '"' || c === "'" || c === "`") {
      out.push(c);
      const quote = c;
      i++;
      while (i < n) {
        if (src[i] === "\\") { // escape — blank the pair
          blank(i, Math.min(n, i + 2));
          i += 2;
          continue;
        }
        if (src[i] === quote) {
          out.push(quote);
          i++;
          break;
        }
        out.push(src[i] === "\n" ? "\n" : " ");
        i++;
      }
      continue;
    }
    out.push(c);
    i++;
  }
  return out.join("");
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
