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
import { NEXT_AUTH_PROVIDER_MODULES } from "../../src/build/next-auth-providers.ts";
import type { Baseline, Surface } from "./types.ts";

/**
 * Preact and its ecosystem — what `denext/preact`, `denext/preact/*`, `denext/preact-iso` and
 * `denext/signals` mirror (each ships its own `.d.ts`). Their surfaces live in their own baseline
 * ({@linkcode PREACT_BASELINE}), so the React/Next baseline stays as it is.
 */
export const PREACT_PACKAGES = [
  "preact",
  "preact-render-to-string",
  "preact-iso",
  "@preact/signals",
] as const;

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
  // Auth.js v5 for Next.js — what `denext/next-auth` (the `next-auth` shim) mirrors. v5 ships
  // under npm's `beta` tag (`latest` is still v4), see REAL_PACKAGE_TAGS.
  "next-auth",
  // NextAuth.js v4 — the line most Next apps still run — installed beside v5 under an npm
  // alias (REAL_PACKAGE_ALIASES), since the shim serves v4's server API too.
  "next-auth-v4",
  ...PREACT_PACKAGES,
  "@types/react",
  "@types/react-dom",
  "@types/react-is",
] as const;

/**
 * The npm dist-tag each real package installs at when it isn't `latest` — `next-auth`'s v5,
 * the line denext's shim mirrors, is published as `beta`.
 */
export const REAL_PACKAGE_TAGS: Readonly<Record<string, string>> = {
  "next-auth": "beta",
  "next-auth-v4": "4",
};

/**
 * Real packages installed under another name (`"<name>": "npm:<package>@<version>"`), so two
 * release lines of one package sit side by side: `next-auth-v4` is `next-auth@4`.
 */
export const REAL_PACKAGE_ALIASES: Readonly<Record<string, string>> = {
  "next-auth-v4": "next-auth",
};

/**
 * The `package.json` dependency spec that installs `pkg` at `version` (a version, range or
 * dist-tag): an aliased package becomes `npm:<package>@<version>`.
 *
 * @param pkg A {@linkcode REAL_PACKAGES} name.
 * @param version The version, range or dist-tag to install.
 * @returns The dependency spec.
 */
export function realDependencySpec(pkg: string, version: string): string {
  const target = REAL_PACKAGE_ALIASES[pkg];
  return target ? `npm:${target}@${version}` : version;
}

/**
 * Release lines the committed BASELINE is held to (`parity:refresh`), while `parity:drift`
 * still installs `latest` and reports what a newer release adds. Empty: the baseline follows
 * each package's latest release. A line goes here (`react: "~19.2"`) only while denext lacks a
 * behaviour the newer release ships, as React 19.3's Fragment refs once held React to 19.2.
 */
export const BASELINE_HOLDS: Readonly<Record<string, string>> = {};

/**
 * The NextAuth.js v4 subpaths an app imports, checked against `next-auth@4` (each against the
 * shim file that serves it). A provider v4 doesn't ship resolves to nothing and requires nothing.
 */
export const NEXT_AUTH_V4_SUBPATHS: ReadonlyArray<readonly [subpath: string, file: string]> = [
  ["", "index.ts"],
  ["/next", "next.ts"],
  ["/middleware", "middleware.ts"],
  ["/react", "react.ts"],
  ["/jwt", "jwt.ts"],
  ["/adapters", "adapters.ts"],
];

/**
 * The `next-auth/providers/*` modules the shim ships (each one's default export is checked):
 * the hand-written and generated ones, from `deno task gen:auth-providers`'s list.
 */
export const NEXT_AUTH_PROVIDERS: readonly string[] = NEXT_AUTH_PROVIDER_MODULES;

/** The Preact specifiers checked, each against the `src/compat/preact/` file that serves it. */
export const PREACT_SPECIFIERS: ReadonlyArray<readonly [specifier: string, file: string]> = [
  ["preact", "mod.ts"],
  ["preact/hooks", "hooks.ts"],
  ["preact/compat", "compat.ts"],
  ["preact/jsx-runtime", "jsx-runtime.ts"],
  ["preact-render-to-string", "render-to-string.ts"],
  ["preact-render-to-string/stream", "render-to-string.ts"],
  ["preact-iso", "iso.ts"],
  ["@preact/signals", "signals.ts"],
];

/** One React/Next(-adjacent) specifier and the two files that must agree on it. */
export interface SpecEntry {
  /** The public bare specifier, e.g. `react` or `next/navigation`. */
  specifier: string;
  /** The real npm import used to source the authoritative surface. */
  real: string;
  /** denext's backing file, repo-root-relative (the `deno doc` input). */
  denext: string;
  /** Package family, for grouping the test output. */
  group:
    | "react"
    | "react-dom"
    | "next"
    | "next-intl"
    | "pages-router"
    | "remix"
    | "next-auth"
    | "next-auth-v4"
    | "preact";
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
  {
    specifier: "react/compiler-runtime",
    real: "react/compiler-runtime",
    denext: "src/compat/react-compiler-runtime.ts",
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
  // Auth.js v5 (`next-auth@beta`): the shim's entry points and every provider it ships.
  {
    specifier: "next-auth",
    real: "next-auth",
    denext: "packages/auth/next-auth/index.ts",
    group: "next-auth",
  },
  {
    specifier: "next-auth/react",
    real: "next-auth/react",
    denext: "packages/auth/next-auth/react.ts",
    group: "next-auth",
  },
  {
    specifier: "next-auth/webauthn",
    real: "next-auth/webauthn",
    denext: "packages/auth/next-auth/webauthn.ts",
    group: "next-auth",
  },
  {
    specifier: "next-auth/jwt",
    real: "next-auth/jwt",
    denext: "packages/auth/next-auth/jwt.ts",
    group: "next-auth",
  },
  ...NEXT_AUTH_PROVIDERS.map((p) => ({
    specifier: `next-auth/providers/${p}`,
    real: `next-auth/providers/${p}`,
    denext: `packages/auth/next-auth/providers/${p}.ts`,
    group: "next-auth" as const,
  })),
  // NextAuth.js v4 (`next-auth@4`, installed as `next-auth-v4`): the same shim files, held to
  // v4's surface. The specifier carries `@4` so the two lines stay separate in the baseline.
  ...NEXT_AUTH_V4_SUBPATHS.map(([sub, file]) => ({
    specifier: `next-auth@4${sub}`,
    real: `next-auth-v4${sub}`,
    denext: `packages/auth/next-auth/${file}`,
    group: "next-auth-v4" as const,
  })),
  ...NEXT_AUTH_PROVIDERS.map((p) => ({
    specifier: `next-auth@4/providers/${p}`,
    real: `next-auth-v4/providers/${p}`,
    denext: `packages/auth/next-auth/providers/${p}.ts`,
    group: "next-auth-v4" as const,
  })),
  // Preact (`denext migrate` maps each specifier to the denext module beside it).
  ...PREACT_SPECIFIERS.map(([specifier, file]) => ({
    specifier,
    real: specifier,
    denext: `src/compat/preact/${file}`,
    group: "preact" as const,
  })),
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

/** The React/Next baseline (repo-relative). */
export const REACT_BASELINE = "tests/fixtures/react-surface.baseline.json";
/** The Preact baseline (repo-relative): the `preact` group's surfaces and package versions. */
export const PREACT_BASELINE = "tests/fixtures/preact-surface.baseline.json";

/** Whether a baseline surface belongs to the Preact baseline. */
function isPreactSurface(s: Surface): boolean {
  return PREACT_SPECIFIERS.some(([specifier]) => specifier === s.specifier);
}

/**
 * Split a captured baseline into the React/Next one and the Preact one.
 *
 * @param all The whole capture.
 * @returns Each baseline, versions and surfaces partitioned by package / specifier.
 */
export function splitBaseline(all: Baseline): { react: Baseline; preact: Baseline } {
  const preactPkgs = new Set<string>(PREACT_PACKAGES);
  const pick = (preact: boolean): Baseline => ({
    versions: Object.fromEntries(
      Object.entries(all.versions).filter(([p]) => preactPkgs.has(p) === preact),
    ),
    capturedAt: all.capturedAt,
    surfaces: all.surfaces.filter((s) => isPreactSurface(s) === preact),
  });
  return { react: pick(false), preact: pick(true) };
}

/**
 * Read the committed baselines as one: the React/Next baseline plus the Preact one (when present).
 *
 * @param root Repo root (absolute).
 * @returns The merged baseline.
 */
export async function readBaselines(root: string): Promise<Baseline> {
  const react = JSON.parse(await Deno.readTextFile(`${root}/${REACT_BASELINE}`)) as Baseline;
  const preact = await Deno.readTextFile(`${root}/${PREACT_BASELINE}`).then(
    (t) => JSON.parse(t) as Baseline,
    () => null,
  );
  if (!preact) return react;
  return {
    versions: { ...react.versions, ...preact.versions },
    capturedAt: react.capturedAt,
    surfaces: [...react.surfaces, ...preact.surfaces],
  };
}
