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
import { crawlLocalModules, isFrameworkSource } from "./module-graph.ts";
import { routeSourceFiles } from "./bundle.ts";
import { stripLiteralsAndComments } from "./server-only-scan.ts";

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
      // Exclude framework internals (`src/`, `packages/`, the root barrels): they DEFINE
      // the hooks, so scanning them would flag every route. Only the framework SOURCE is
      // excluded, not everything under the repo root — an app that lives inside the
      // framework checkout (apps/web, examples/*) still has its own modules scanned.
      graph = await crawlLocalModules(roots, { exclude: isFrameworkSource });
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
