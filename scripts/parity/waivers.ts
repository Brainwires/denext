// Intentional, documented parity deviations. A waiver suppresses one finding so the
// parity test stays green on *known* differences while still failing the moment a
// NEW, unexplained deviation appears. Every waiver carries a reason.
//
// Two kinds:
//   • categorical patterns (below) — whole classes denext deliberately does not mirror
//     (unstable_/experimental_/internal APIs, the generative per-font exports, removed
//     legacy APIs). These are policy, keyed by a name pattern, optionally cross-specifier.
//   • specific waivers — one named symbol denext intentionally omits or shapes
//     differently, each with a note. Add these as denext's scope is deliberately fixed.
//
// Keep this honest: waive a real React/Next runtime export only when denext genuinely
// does not implement it on purpose, never to hide a bug. Mirrors the
// "scan → assert invariant → waive the known" pattern of `src/build/audit.ts`.

import type { Category } from "./diff.ts";

/** One suppressed deviation. `symbol` xor `pattern`; omit both to match every symbol. */
export interface Waiver {
  /** Restrict to this specifier; omit to apply across all specifiers. */
  specifier?: string;
  /** Exact symbol name to suppress. */
  symbol?: string;
  /** Regex (source string) matched against the symbol name — for whole classes. */
  pattern?: string;
  /** Categories to suppress; omit to suppress every category. */
  categories?: Category[];
  /** Why this deviation is intentional (required). */
  reason: string;
}

export const WAIVERS: Waiver[] = [
  // ── Categorical policy ────────────────────────────────────────────────────────
  {
    pattern: "^unstable_",
    categories: ["MISSING_VALUE", "ARITY_MISMATCH"],
    reason:
      "unstable_* are unstable React/Next APIs; denext does not guarantee their presence or shape.",
  },
  {
    pattern: "^experimental_",
    categories: ["MISSING_VALUE", "ARITY_MISMATCH"],
    reason:
      "experimental_* (incl. taint APIs) are experimental React APIs; denext does not guarantee shape.",
  },
  {
    pattern: "^_",
    categories: ["MISSING_VALUE"],
    reason: "Underscore-prefixed exports are library internals, not public surface.",
  },
  {
    specifier: "next/font/google",
    pattern: ".",
    categories: ["MISSING_VALUE"],
    reason:
      "next/font/google exposes ~1.8k per-font named exports (ABeeZee, Roboto, …); denext exposes the " +
      "documented font-loader factory shape instead. Loader behavior is covered by tests/next-font.test.ts.",
  },
  {
    specifier: "next/font/local",
    pattern: ".",
    categories: ["MISSING_VALUE"],
    reason:
      "next/font/local's real surface is font-name factories; denext exposes the loader factory shape.",
  },
  // ── Spurious / non-public exports leaking through module resolution ───────────
  {
    specifier: "react-dom",
    symbol: "browser",
    categories: ["MISSING_VALUE"],
    reason:
      "`browser` is not a documented react-dom export (absent from @types/react-dom); it leaks " +
      "from the runtime package entry through `import * as`. Not a real public API to mirror.",
  },
  {
    specifier: "next/server",
    symbol: "ImageResponse",
    categories: ["ARITY_MISMATCH"],
    reason:
      "Real-side extraction artifact: Next's ImageResponse is a class (`new ImageResponse(element, " +
      "options?)`, element required), but the TS-API real surface captured a spurious 0-arg call " +
      "signature for it; denext's ImageResponse correctly requires the element. Presence matches.",
  },
  {
    specifier: "next-intl",
    symbol: "useExtracted",
    categories: ["MISSING_VALUE"],
    reason:
      "useExtracted backs next-intl's experimental compile-time message extraction (a build " +
      "step denext does not run); no stable runtime contract to mirror.",
  },
  {
    specifier: "next-intl/server",
    symbol: "getExtracted",
    categories: ["MISSING_VALUE"],
    reason: "getExtracted is the server half of next-intl's experimental compile-time message " +
      "extraction (no build step in denext); no stable runtime contract to mirror.",
  },
  // ── Removed / legacy React concepts ───────────────────────────────────────────
  {
    specifier: "react-is",
    pattern: "^(isAsyncMode|AsyncMode|isConcurrentMode|ConcurrentMode)$",
    categories: ["MISSING_VALUE"],
    reason:
      "AsyncMode/ConcurrentMode are removed legacy React modes; denext targets the modern surface.",
  },
  // ── Remix (`@remix-run/react` client / `@remix-run/node` data) ─────────────────
  {
    specifier: "@remix-run/react",
    pattern:
      "^(createPath|createRoutesFromChildren|createRoutesFromElements|createSearchParams|generatePath|matchPath|matchRoutes|parsePath|renderMatches|resolvePath|Navigate|NavigationType|Route|Routes|useInRouterContext|useLinkClickHandler|useMatch|useNavigationType|useOutlet|useRoutes|useViewTransitionState|useBeforeUnload)$",
    categories: ["MISSING_VALUE"],
    reason:
      "react-router-dom route-config/matching primitives that Remix re-exports (`<Routes>`/`<Route>`, " +
      "matchRoutes/useRoutes, generatePath/…). denext migrates the Remix route tree to the file-based " +
      "App Router, so the imperative route-config API has no denext equivalent by design.",
  },
  {
    specifier: "@remix-run/react",
    pattern: "^(Scripts|PrefetchPageLinks|LiveReload|ScrollRestoration|Meta|Links)$",
    categories: ["MISSING_VALUE", "ARITY_MISMATCH"],
    reason:
      "Remix document components. `denext migrate --from remix` strips them (denext owns the " +
      "`<html>`/document and its script/style injection), so denext ships inert stubs, not the " +
      "React-Router-shaped components.",
  },
  {
    specifier: "@remix-run/react",
    pattern: "^UNSAFE_",
    categories: ["MISSING_VALUE", "ARITY_MISMATCH"],
    reason: "UNSAFE_* are react-router/Remix internals, not public runtime surface.",
  },
  {
    specifier: "@remix-run/react",
    pattern: "^(json|redirect|redirectDocument|defer)$",
    categories: ["MISSING_VALUE"],
    reason:
      "Server data helpers. Remix re-exports them from `@remix-run/react`, but denext exposes them on " +
      "`denext/remix/server` (where the migration routes them) — never on the client `denext/remix` " +
      "module — so importing a server helper can't poison the client bundle.",
  },
  {
    specifier: "@remix-run/node",
    pattern:
      "^(installGlobals|NodeOnDiskFile|createReadableStreamFromReadable|readableStreamToString|writeAsyncIterableToWritable|writeReadableStreamToWritable|createRequestHandler|broadcastDevReady|logDevReady|MaxPartSizeExceededError|createFileSessionStorage)$",
    categories: ["MISSING_VALUE"],
    reason:
      "Node/Express-adapter + Node-filesystem runtime utilities (global installers, node:stream " +
      "bridges, the Express request handler, dev-ready signals, on-disk file/session storage). denext " +
      "runs on Deno web standards (Request/Response/ReadableStream), so these have no place in the runtime.",
  },
];

/** Whether a given finding is covered by a waiver. */
export function isWaived(
  specifier: string,
  symbol: string,
  category: Category,
  waivers: Waiver[] = WAIVERS,
): boolean {
  return waivers.some((w) => {
    if (w.specifier && w.specifier !== specifier) return false;
    if (w.categories && !w.categories.includes(category)) return false;
    if (w.symbol && w.symbol !== symbol) return false;
    if (w.pattern && !new RegExp(w.pattern).test(symbol)) return false;
    return true;
  });
}
