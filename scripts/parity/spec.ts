// The specifier catalog for the React/ReactDOM/Next signature-parity tool.
//
// Each entry pairs a public bare specifier (what apps `import ... from`) with the
// real npm module that defines its authoritative surface and the denext compat file
// that must mirror it. The diff (`diff.ts`) compares, per specifier, the real
// surface (extracted via the TypeScript compiler API in `extract-real.ts`) against
// denext's (extracted via `deno doc` in `extract-denext.ts`).
//
// The denext file column is cross-checked against `deno.json` `exports` /
// `packages/pages-router/deno.json` by `assertCatalogMatchesExports()` so this list
// can never silently drift from what the package actually ships.

/** The npm packages installed (with their `@types`) to source the real surface. */
export const REAL_PACKAGES = [
  "react",
  "react-dom",
  "react-is",
  "next",
  "next-intl",
  // Remix v2 (the last `@remix-run/*` line before it merged into React Router v7) —
  // what `denext migrate --from remix` targets and `denext/remix` mirrors. These ship
  // their own `.d.ts`, so no separate `@types/*`.
  "@remix-run/react",
  "@remix-run/node",
  "@types/react",
  "@types/react-dom",
  "@types/react-is",
] as const;

/** One React/Next(-adjacent) specifier and the two files that must agree on it. */
export interface SpecEntry {
  /** The public bare specifier, e.g. `react` or `next/navigation`. */
  specifier: string;
  /** The real npm import used to source the authoritative surface. */
  real: string;
  /** denext's backing file, repo-root-relative (the `deno doc` input). */
  denext: string;
  /** Package family, for grouping the test output. */
  group: "react" | "react-dom" | "next" | "next-intl" | "pages-router" | "remix";
}

/**
 * The full catalog. `react-dom/server{,.browser,.edge}` intentionally fan three real
 * specifiers onto one denext file — denext must cover the union (each passes when its
 * denext surface is a superset). Real subpaths that a given upstream version no longer
 * ships (e.g. `react-dom/test-utils` on React 19) resolve to an empty real surface and
 * simply have nothing to require.
 */
export const CATALOG: SpecEntry[] = [
  // React
  { specifier: "react", real: "react", denext: "src/compat/react.ts", group: "react" },
  {
    specifier: "react/jsx-runtime",
    real: "react/jsx-runtime",
    denext: "src/jsx/jsx-runtime.ts",
    group: "react",
  },
  {
    specifier: "react/jsx-dev-runtime",
    real: "react/jsx-dev-runtime",
    denext: "src/jsx/jsx-runtime.ts",
    group: "react",
  },
  // ReactDOM
  {
    specifier: "react-dom",
    real: "react-dom",
    denext: "src/compat/react-dom.ts",
    group: "react-dom",
  },
  {
    specifier: "react-dom/client",
    real: "react-dom/client",
    denext: "src/compat/react-dom-client.ts",
    group: "react-dom",
  },
  {
    specifier: "react-dom/server",
    real: "react-dom/server",
    denext: "src/compat/react-dom-server.ts",
    group: "react-dom",
  },
  {
    specifier: "react-dom/server.browser",
    real: "react-dom/server.browser",
    denext: "src/compat/react-dom-server.ts",
    group: "react-dom",
  },
  {
    specifier: "react-dom/server.edge",
    real: "react-dom/server.edge",
    denext: "src/compat/react-dom-server.ts",
    group: "react-dom",
  },
  {
    specifier: "react-dom/test-utils",
    real: "react-dom/test-utils",
    denext: "src/compat/test-utils.ts",
    group: "react-dom",
  },
  { specifier: "react-is", real: "react-is", denext: "src/compat/react-is.ts", group: "react" },
  // Next (App Router)
  { specifier: "next", real: "next", denext: "src/compat/next/index.ts", group: "next" },
  { specifier: "next/link", real: "next/link", denext: "src/compat/next/link.ts", group: "next" },
  { specifier: "next/head", real: "next/head", denext: "src/compat/next/head.ts", group: "next" },
  {
    specifier: "next/image",
    real: "next/image",
    denext: "src/compat/next/image.ts",
    group: "next",
  },
  {
    specifier: "next/script",
    real: "next/script",
    denext: "src/compat/next/script.ts",
    group: "next",
  },
  {
    specifier: "next/dynamic",
    real: "next/dynamic",
    denext: "src/compat/next/dynamic.ts",
    group: "next",
  },
  { specifier: "next/form", real: "next/form", denext: "src/compat/next/form.ts", group: "next" },
  {
    specifier: "next/navigation",
    real: "next/navigation",
    denext: "src/compat/next/navigation.ts",
    group: "next",
  },
  {
    specifier: "next/headers",
    real: "next/headers",
    denext: "src/compat/next/headers.ts",
    group: "next",
  },
  {
    specifier: "next/cache",
    real: "next/cache",
    denext: "src/compat/next/cache.ts",
    group: "next",
  },
  {
    specifier: "next/server",
    real: "next/server",
    denext: "src/compat/next/server.ts",
    group: "next",
  },
  { specifier: "next/og", real: "next/og", denext: "src/compat/next/og.ts", group: "next" },
  {
    specifier: "next/font/google",
    real: "next/font/google",
    denext: "src/compat/next/font/google.ts",
    group: "next",
  },
  {
    specifier: "next/font/local",
    real: "next/font/local",
    denext: "src/compat/next/font/local.ts",
    group: "next",
  },
  // Next Pages Router (a separate denext workspace package)
  {
    specifier: "next/router",
    real: "next/router",
    denext: "packages/pages-router/router.ts",
    group: "pages-router",
  },
  {
    specifier: "next/document",
    real: "next/document",
    denext: "packages/pages-router/src/document.ts",
    group: "pages-router",
  },
  // next-intl
  {
    specifier: "next-intl",
    real: "next-intl",
    denext: "src/compat/next-intl/index.ts",
    group: "next-intl",
  },
  {
    specifier: "next-intl/server",
    real: "next-intl/server",
    denext: "src/compat/next-intl/server.ts",
    group: "next-intl",
  },
  {
    specifier: "next-intl/navigation",
    real: "next-intl/navigation",
    denext: "src/compat/next-intl/navigation.ts",
    group: "next-intl",
  },
  {
    specifier: "next-intl/middleware",
    real: "next-intl/middleware",
    denext: "src/compat/next-intl/middleware.ts",
    group: "next-intl",
  },
  {
    specifier: "next-intl/routing",
    real: "next-intl/routing",
    denext: "src/compat/next-intl/routing.ts",
    group: "next-intl",
  },
  // Remix (the `denext/remix` runtime — `@remix-run/react` client surface ↔ client.ts,
  // `@remix-run/node` data/cookies/sessions surface ↔ server.ts). Apps `import` these
  // via the migration-rewritten `denext/remix` / `denext/remix/server` specifiers.
  {
    specifier: "@remix-run/react",
    real: "@remix-run/react",
    denext: "src/compat/remix/mod.ts",
    group: "remix",
  },
  {
    specifier: "@remix-run/node",
    real: "@remix-run/node",
    denext: "src/compat/remix/server.ts",
    group: "remix",
  },
];

/**
 * Cross-check every catalog entry's denext file against the package export maps so the
 * catalog cannot silently drift from what denext actually ships. Reads the root
 * `deno.json` and `packages/pages-router/deno.json` and verifies each denext path is a
 * declared export target (the `react/jsx-*` runtimes and the pages-router files
 * resolve through their own maps). Throws with a full list on any mismatch.
 *
 * @param root Repo root (absolute).
 */
export async function assertCatalogMatchesExports(root: string): Promise<void> {
  const read = async (p: string): Promise<Record<string, string>> => {
    const json = JSON.parse(await Deno.readTextFile(p)) as { exports?: Record<string, string> };
    const out: Record<string, string> = {};
    for (const target of Object.values(json.exports ?? {})) {
      out[target.replace(/^\.\//, "")] = target;
    }
    return out;
  };
  const rootTargets = new Set(Object.keys(await read(`${root}/deno.json`)));
  const prTargets = new Set(
    Object.keys(await read(`${root}/packages/pages-router/deno.json`)).map((t) =>
      `packages/pages-router/${t}`
    ),
  );
  const missing: string[] = [];
  for (const e of CATALOG) {
    const known = rootTargets.has(e.denext) || prTargets.has(e.denext);
    if (!known) missing.push(`${e.specifier} -> ${e.denext}`);
  }
  if (missing.length) {
    throw new Error(
      "parity catalog is out of sync with deno.json exports; these denext files are not declared exports:\n  " +
        missing.join("\n  "),
    );
  }
}
