// `denext migrate` — convert an existing React app (Next.js App Router, or a Vite
// SPA) to run on denext by generating denext config files. Does NOT touch the app's
// source (run the codemod separately to rewrite imports to native denext).
//
// Next path: reads package.json (+ tsconfig paths) and writes a deno.json import map
// that aliases the react/next family to denext, passes other npm deps through, and
// translates path aliases (`@/…`). The next-compat build/SSR pipeline rewrites
// react→denext at bundle time so npm React libraries run on denext's single React.
//
// Vite SPA path: detects a `vite.config.*` (no `next.config.*`) with React, and
// writes a deno.json (react aliases + tsconfig `~/` path alias) + a `denext.config.ts`
// with `mode:"spa"`, `compatibilityMode:true`, the Tailwind and `spa.env` blocks
// derived from the Vite config/usage, and — with `--desktop` — a `desktop.ts` entry
// and `spa.proxy` for a `deno desktop` build.

import { dirname, join, relative, resolve, toFileUrl } from "@std/path";
import { anyExists, exists, firstExisting } from "./migrate-fs.ts";
import { mfs } from "./migrate-io.ts";
import {
  type MappedViteEmitter,
  readViteConfig,
  tanstackRouterFacts,
  viteAssetsDir,
  type ViteEmitterFacts,
  viteEmitterFacts,
  type ViteEmitterFinding,
} from "./migrate-vite-plugins.ts";
import type { SpaTanstackRouterConfig } from "../server/config.ts";
import { evalNextConfigProgram, LOAD_NEXT_CONFIG } from "./next-config-eval.ts";
import { parse as parseJsonc } from "@std/jsonc";
import { readFrameworkJson } from "./bundle.ts";
import { appendGitignore } from "./gitignore.ts";
import { DENEXT_MIN_DEP_AGE, ensureVscodeDeno } from "./scaffold.ts";
import { REACT_FAMILY_CLIENT, REACT_FAMILY_CORE } from "./react-specifiers.ts";
import CATALOG from "../plugin/catalog.json" with { type: "json" };
import { DESKTOP_ICON_FILE, detectIconSource } from "./desktop-icon.ts";
import {
  formatIconSearch,
  type IconSearch,
  mobileIconConfig,
  resolveIconSource,
} from "./mobile-icon-source.ts";
import { isRemix, type RemixMigrateInfo, transformRemixApp } from "./remix-migrate.ts";
import {
  capacitorConfigSource,
  capacitorIdentity,
  expoApiUsage,
  expoConfigScript,
  type ExpoDependencyReport,
  expoDependencyReport,
  expoMobilePlan,
  expoWebEntry,
  type MetroResolution,
  type MobilePlan,
  prebuildFolders,
  readMetroResolution,
} from "./expo-migrate.ts";
import { type ExpoAppConfig, readExpoAppConfig } from "./expo-app-config.ts";
import { findReactNativeWeb } from "./react-native.ts";
import { CAPACITOR_BUILD_IGNORES } from "./capacitor-pins.ts";
import {
  appRouterServerFiles,
  type CapacitorMigrateInfo,
  type CapacitorOptions,
  type CapacitorPlan,
  capacitorTasks,
  planCapacitor,
  validateCapacitorOptions,
} from "./migrate-capacitor.ts";
import { findSqliteWasm } from "./sqlite-wasm.ts";
import {
  detectPrismaWiring,
  isPrismaDep,
  type PrismaMigrateInfo,
  type PrismaWiring,
} from "./prisma-migrate.ts";

/** react/next specifiers aliased to their denext JSR subpath (matches denext's
 * deno.json exports); the subpath equals the specifier. React-family entries come
 * from the single canonical specifier list. */
const DENEXT_ALIAS_SPECS: readonly string[] = [
  ...REACT_FAMILY_CORE,
  "next",
  "next-intl",
  "better-sqlite3",
];
/** react-family specifiers aliased for a client-only Vite SPA (no next/*). */
const SPA_REACT_ALIAS_SPECS: readonly string[] = REACT_FAMILY_CLIENT;

/** Alias `server-only`/`client-only` to denext's inert no-op modules when the app
 * depends on them, so the deno-native SSR import resolves to an inert module instead
 * of the throwing npm package (the build still enforces the boundary). */
function addServerClientStubs(
  imports: Record<string, string>,
  deps: Record<string, string>,
  jsr: (sub: string) => string,
): void {
  for (const poison of ["server-only", "client-only"]) {
    if (poison in deps) imports[poison] = jsr(poison);
  }
}
/** Packages denext provides — never pass to npm. */
const DENEXT_OWNED = new Set([
  "react",
  "react-dom",
  "react-is",
  "next",
  "next-intl",
  "better-sqlite3",
  // denext provides no-op shims for these (aliased below) — never npm-pin them, or the
  // pin overwrites the alias and the throwing real package resurfaces on the native path.
  "server-only",
  "client-only",
]);
/**
 * The published range that pins a first-party package, read out of the generated catalog
 * (`src/plugin/catalog.json`, `deno task gen:plugin-catalog`) rather than hard-coded here,
 * so a package release reaches `denext migrate` by regenerating the catalog. Every range is
 * caret + the package's full current version, which for a 0.x package admits only that
 * minor line.
 */
function catalogSpec(name: string): string {
  const entry = CATALOG.plugins.find((p) => p.name === name);
  if (!entry) throw new Error(`the first-party plugin catalog has no entry for "${name}"`);
  return entry.spec;
}
/**
 * The `@denext/pages-router` range a migrated `pages/` app gets. Must satisfy the workspace
 * package's current version (asserted by tests/plugin-catalog.test.ts) — the plugin tracks
 * denext's barrel surface, so an older 0.x line boots against a barrel it no longer matches.
 */
export const PAGES_ROUTER_SPEC: string = catalogSpec("@denext/pages-router");
/** The `@denext/react-router` package the RR7 framework-mode plugin path pins. */
const REACT_ROUTER_SPEC = catalogSpec("@denext/react-router");
/**
 * The `@denext/effect` bridge specifier, mapped (and its `effect()` plugin wired into the
 * generated `denext.config.ts`) whenever the app depends on the npm `effect` package. The
 * raw `effect` dep still passes through as a pinned `npm:` import for the app's own
 * `import … from "effect"`; this only adds the denext-side bridge (`runEffect`,
 * `effectHandler`, `DenextRequest`, and the ambient-runtime plugin).
 */
const EFFECT_SPEC = catalogSpec("@denext/effect");
/** Native/engine deps denext can't run — flag them. (Prisma is handled specially — see
 * `detectPrismaWiring` — so it is NOT listed here; it's wired to the Deno client + adapter.) */
const HARD_UNSUPPORTED = /^(@swc\/core|node-gyp|canvas$)/;
/** Deps that are no-ops under denext (its own pipeline). */
const SOFT_DROP = new Set([
  "sharp",
  "eslint-config-next",
  "@next/eslint-plugin-next",
  "next",
  // Bundler/toolchain deps denext replaces — never passed through as runtime npm.
  "react-scripts",
  "vite",
  "@vitejs/plugin-react",
  "@vitejs/plugin-react-swc",
  // Vite plugins with no role under denext: Tailwind runs through denext's own pipeline;
  // TanStack's router plugin is denext's own build step (`spa.tanstackRouter`, which migrate
  // sets from its `autoCodeSplitting`; route codegen otherwise runs out-of-band via
  // `tsr generate`), its devtools Vite plugin has no dev server to hook. (`@tanstack/router-cli`
  // stays: the app still runs it.)
  "@tailwindcss/vite",
  "@tanstack/router-plugin",
  "@tanstack/devtools-vite",
]);

/** How a run's dependencies were bucketed (for the CLI summary + the import-map pins). */
interface DepClassification {
  /** Provided by denext — aliased in the import map, never npm. */
  aliased: string[];
  /** Passed through as npm (pinned into `imports` when `pin`). */
  passthrough: string[];
  /** Inert under denext (toolchain/lint/types) — dropped. */
  dropped: string[];
  /** Native/engine deps denext can't run — flagged for the user. */
  flagged: string[];
}

/**
 * Bucket an app's dependencies (shared by the Next, Remix, and SPA paths). Prisma is
 * version-pinned + rewired elsewhere (never re-pinned here); `dropRemix` also drops the
 * `@remix-run/*` / react-router toolchain; `pin` writes a concrete `npm:name@version` for each
 * passthrough dep into `imports` (skipped for a non-numeric `catalog:`/`workspace:*` version,
 * which can't be pinned — left to the installed node_modules + the tolerant resolver).
 */
/** A dep denext drops (inert toolchain/lint/types, or — with `dropRemix` — the Remix toolchain). */
function isDroppedDep(name: string, dropRemix: boolean): boolean {
  if (
    dropRemix &&
    (name.startsWith("@remix-run/") || name.startsWith("@react-router/"))
  ) {
    return true;
  }
  if (SOFT_DROP.has(name)) return true;
  return name.startsWith("@types/") || name.startsWith("eslint");
}

/** Which bucket a single dependency falls into (Prisma is handled by the wiring, so → passthrough). */
function depCategory(
  name: string,
  dropRemix: boolean,
): keyof DepClassification {
  if (DENEXT_OWNED.has(name)) return "aliased";
  if (isPrismaDep(name)) return "passthrough";
  if (HARD_UNSUPPORTED.test(name)) return "flagged";
  if (isDroppedDep(name, dropRemix)) return "dropped";
  return "passthrough";
}

function classifyDeps(
  deps: Record<string, string>,
  imports: Record<string, string>,
  opts: { dropRemix?: boolean; pin: boolean },
): DepClassification {
  const c: DepClassification = {
    aliased: [],
    passthrough: [],
    dropped: [],
    flagged: [],
  };
  for (const [name, version] of Object.entries(deps)) {
    const category = depCategory(name, opts.dropRemix ?? false);
    c[category].push(category === "flagged" ? `${name}@${version}` : name);
    // A pinned passthrough gets a concrete `npm:` entry (skipping non-numeric catalog/workspace).
    if (
      category === "passthrough" && !isPrismaDep(name) && opts.pin &&
      /^\D*\d/.test(version)
    ) {
      imports[name] = `npm:${name}@${version.replace(/^[\^~]/, "")}`;
    }
  }
  return c;
}

/**
 * Build the App-Router import map shared by the Next and Remix paths: the `denext`/`denext/*`
 * entries (plus `denext/remix`(`/server`) for the Remix path), the react/next family aliases,
 * `server-only`/`client-only` no-ops + `mdx/types`, the app's tsconfig path aliases, and — in
 * local-path mode — denext's own framework deps. Classification of the app's own deps + any
 * `npm:` pins is layered on by {@link classifyDeps} afterward.
 */
async function buildAppRouterImports(
  dir: string,
  R: DenextResolver,
  deps: Record<string, string>,
  opts: { remix?: boolean } = {},
): Promise<Record<string, string>> {
  const jsr = R.sub;
  const imports: Record<string, string> = {
    "denext": R.base,
    "denext/jsx-runtime": jsr("jsx-runtime"),
    "denext/server": jsr("server"),
    "denext/client": jsr("client"),
  };
  if (opts.remix) {
    // The Remix compat runtime the generated route wrappers/components import.
    imports["denext/remix"] = jsr("remix");
    imports["denext/remix/server"] = jsr("remix/server");
    // The dropped Remix packages stay resolvable for the npm libraries that import them
    // (`@sentry/remix`, `remix-utils`, `remix-auth`, `@nasa-gcn/remix-seo` all do).
    for (const spec of ["@remix-run/react", "react-router", "react-router-dom"]) {
      imports[spec] = imports["denext/remix"];
    }
    for (const spec of ["@remix-run/node", "@remix-run/server-runtime", "@remix-run/cloudflare"]) {
      imports[spec] = imports["denext/remix/server"];
    }
  }
  for (const spec of DENEXT_ALIAS_SPECS) imports[spec] = jsr(spec);
  // Every `next/*` / `next-intl/*` subpath denext ships gets an EXACT entry: Deno cannot
  // resolve a specifier against a `jsr:` trailing-slash prefix ("could not be URL-parsed"),
  // so a module loaded natively — `middleware.ts`, an instrumentation file — that imports
  // `next/server` failed under the prefix alone. A URL prefix (local checkout) still works and
  // is kept as the catch-all.
  for (const spec of await frameworkSubpaths(["next/", "next-intl/"])) imports[spec] = R.sub(spec);
  for (const prefix of ["next/", "next-intl/"]) {
    const target = R.prefix(prefix);
    if (/^(?:file|https?):/.test(target)) imports[prefix] = target;
  }
  addServerClientStubs(imports, deps, jsr);
  // `/mdx` provides the type-only `mdx/types` module; MDX apps often import it at value syntax.
  if ("@types/mdx" in deps) imports["mdx/types"] = jsr("empty");
  // tsconfig/jsconfig path aliases (follows `extends` + a monorepo-root tsconfig), and — in
  // local-path mode — denext's own deps (`@std/*`, `ws`, …) so `deno desktop` etc. resolve.
  addMissing(imports, await collectTsPathAliases(dir));
  addMissing(imports, frameworkDepsFor(R, deps));
  return imports;
}

/** Add each `[key, value]` to `imports` only when the key isn't already mapped. */
function addMissing(
  imports: Record<string, string>,
  entries: Iterable<[string, string]>,
): void {
  for (const [key, val] of entries) {
    if (!(key in imports)) imports[key] = val;
  }
}

/** Options controlling what a migration run emits. */
export interface MigrateOptions {
  /** Emit `desktop.ts` + a `desktop` task (Vite SPA path); with {@link backend}, also `spa.proxy`. */
  desktop?: boolean;
  /** Backend origin for the desktop reverse proxy (e.g. `"http://127.0.0.1:3773"`). */
  backend?: string;
  /** Proxy path prefixes; when omitted, parsed from a literal `vite.config` proxy, else `["/api"]`. */
  proxyPrefixes?: string[];
  /**
   * Force the source framework instead of auto-detecting (`next` | `remix` | `vite` |
   * `cra` | `generic` | `expo`). Reserved for ambiguous cases; auto-detection is used when
   * omitted.
   */
  from?: string;
  /**
   * Point the generated config at a LOCAL denext checkout (a filesystem path) instead of the
   * published `jsr:@denext/denext`: `denext`/`react`/`next` map to `file://…` under it (resolved
   * via its `deno.json` exports), and the `dev`/`build`/`export`/`start` tasks run its local
   * `cli.ts`. For testing an unreleased/dev denext against a real app without publishing — a dev
   * aid, not the shipped drop-in. When set, no `npm:`/`jsr:` denext pins are emitted.
   */
  denextLocalPath?: string;
  /**
   * `--enable-capacitor`: give the app an iOS / Android Capacitor target (a Vite / CRA /
   * generic SPA, a Next App Router app, or an Expo app): `capacitor.config.ts`, the `mobile:*`
   * tasks, the config keys the shell needs, and the steps the CLI runs (see
   * {@link MigrateResult.capacitor}).
   */
  capacitor?: boolean;
  /** `--app-id`: the Capacitor app id (else derived; see migrate-capacitor.ts). */
  appId?: string;
  /** `--platform`: run `cap add` for these platforms after the install. */
  platforms?: string[];
}

/** SPA-specific portion of a migration result. */
export interface SpaMigrateInfo {
  entry: string;
  title: string;
  envKeys: string[];
  tailwind: boolean;
  /** The Tailwind input stylesheet the config points at (`./`-relative), when detected. */
  tailwindInput?: string;
  /** The mount element id written to `spa.rootId` — only when the app does not render into `#root`. */
  rootId?: string;
  proxy?: { prefixes: string[]; target: string };
  /**
   * The vite.config whose dev proxy is built in code, so its prefixes could not be read and
   * `proxy` fell back to `/api` (unset when `--proxy` was passed or the proxy is a literal).
   */
  proxyUnresolved?: string;
  /** `denext.config.ts` was written (false when one already existed). */
  configWritten: boolean;
  /** `desktop.ts` was written (false when `--desktop` off or one already existed). */
  desktopWritten: boolean;
  /** The `--icon` file the desktop task uses (always `desktop-icon.png` — composed by `export` from `spa.desktop.icon` or an auto-detected web icon); undefined when no icon was detected at migrate time. */
  desktopIcon?: string;
  /** The app icon migrate found for a mobile build, recorded as `mobile.icon` (see {@link AppIconReport}). */
  appIcon?: AppIconReport;
  nodeModulesDir: "manual" | "auto";
  /** `spa.tanstackRouter`, carried from a vite.config running TanStack's `autoCodeSplitting`. */
  tanstackRouter?: SpaTanstackRouterConfig;
  /** File-emitting Vite plugins wired into `denext.config.ts` through `viteEmitterPlugin`. */
  viteEmitters?: MappedViteEmitter[];
  /** File-emitting Vite plugins migrate could not carry over (reported for review). */
  viteEmitterReview?: ViteEmitterFinding[];
  /** `spa.assetsDir`: a Vite app's `build.assetsDir` (Vite's default `"assets"` when unset). */
  assetsDir?: string;
}

/** The app icon migrate found (or did not) for `denext mobile assets` / `mobile build`. */
export interface AppIconReport {
  /** The icon, relative to the project (`./public/apple-touch-icon.png`); null when none was found. */
  icon: string | null;
  /** The rule that picked it (`expo`, `manifest`, `apple-touch-icon`, …). */
  kind: string | null;
  /** Its pixel size (`180×180`). */
  size?: string;
  /** The project is a Capacitor / Expo app, so a missing icon needs a look. */
  mobile: boolean;
  /** `mobile.icon` (and its layers) was written into the generated denext.config.ts. */
  recorded: boolean;
  /** The report lines: the source, a size warning, what was passed over. */
  lines: string[];
}

/** Result of a migration run (for the CLI to print). */
export interface MigrateResult {
  kind: "next" | "spa" | "cra" | "generic" | "remix" | "expo";
  /** Files written by this run (deno.json, and for SPA the config/desktop entries). */
  wrote: string[];
  aliased: string[];
  passthrough: string[];
  dropped: string[];
  flagged: string[];
  pagesRouter: boolean;
  /**
   * The app depends on `effect`, so migrate mapped `@denext/effect` and wired its `effect()`
   * plugin into the generated `denext.config.ts` (or, when a config already existed, the
   * CLI hints to add it by hand). Always false on the SPA path.
   */
  effect: boolean;
  /** A `denext.config.ts` wiring the pages-router plugin was written by migrate. */
  pagesConfigWritten: boolean;
  /** A `denext.config.ts` already existed — the user must add `pagesRouter()` by hand. */
  pagesConfigExists: boolean;
  /**
   * A hand-authored `deno.json` (no migrate sentinel) was found and left untouched.
   * Migrate did NOT write its import map / tasks — the user must merge them by hand.
   */
  denoJsonExists: boolean;
  /** Present when {@link kind} is `"spa"`. */
  spa?: SpaMigrateInfo;
  /** Present when {@link kind} is `"remix"` — the assisted route-tree transform report. */
  remix?: RemixMigrateInfo;
  /** Present when the app uses Prisma — the Deno-client/adapter wiring report. */
  prisma?: PrismaMigrateInfo;
  /** Present when {@link kind} is `"expo"` — the React Native mode + Capacitor report. */
  expo?: ExpoMigrateInfo;
  /** Present when an App Router app has a `next.config.*` — what was carried over and what was not. */
  nextConfig?: NextConfigReport;
  /** Present with `--enable-capacitor`: the Capacitor target written and the steps to run. */
  capacitor?: CapacitorMigrateInfo;
  /** Why `--enable-capacitor` was not applied (a Pages Router or Remix-family app). */
  capacitorSkipped?: string;
}

/** How the app's `next.config.*` translated into `denext.config.ts`. */
export interface NextConfigReport {
  /** The config file that was read (`next.config.ts`, …). */
  file: string;
  /** The config was evaluated; false means every key must be ported by hand. */
  evaluated: boolean;
  /** Why evaluation failed, when it did. */
  reason?: string;
  /** Keys copied into `denext.config.ts` (literal fields and inlined rule functions). */
  carried: string[];
  /** Keys denext does not copy, each with its denext equivalent (empty when none is needed). */
  dropped: Array<{ key: string; note: string }>;
}

/** The {@link NextConfigReport} for a translation, or undefined when the app has no next.config. */
function nextConfigReport(next: NextConfigTranslation | null): NextConfigReport | undefined {
  if (!next?.file) return undefined;
  return {
    file: next.file,
    evaluated: !next.raw,
    ...(next.raw && next.rawReason ? { reason: next.rawReason } : {}),
    carried: [...Object.keys(next.fields), ...Object.keys(next.rules)],
    dropped: next.dropped.map((key) => ({
      key,
      note: Object.hasOwn(NEXT_DROP_GUIDANCE, key) ? NEXT_DROP_GUIDANCE[key] : "",
    })),
  };
}

/** What `denext migrate --from expo` found and wrote, beyond the SPA facts. */
export interface ExpoMigrateInfo {
  /** The app config's static reading (where from, what it could not read, notes). */
  config: Pick<ExpoAppConfig, "source" | "unresolved" | "notes">;
  /** A web entry migrate wrote, and for what (Expo's default `App` entry, or expo-router). */
  generatedEntry?: { path: string; kind: "app" | "expo-router" };
  /** The app uses expo-router. */
  expoRouter: boolean;
  /** The Capacitor shell: its identity and whether `capacitor.config.ts` was written. */
  capacitor: { appId: string; appName: string; placeholderId: boolean; configWritten: boolean };
  /** The `denext mobile add` plan and what it cannot carry over. */
  mobile: MobilePlan;
  /** The `expo-*` shim status and the native-only packages. */
  deps: ExpoDependencyReport;
  /** `ios/` / `android/` folders from an Expo prebuild, which the Capacitor shell also claims. */
  prebuildFolders: string[];
  /** The Tailwind stylesheet the app compiles through uniwind / NativeWind, when detected. */
  tailwindInput?: string;
  /** npm packages the web build needs that the app has not installed. */
  missingPackages: string[];
  /** Module resolution the app's Metro config adds (the denext build does not run it). */
  metro: MetroResolution;
  /**
   * The React Native desktop packages the app depends on (`react-native-macos`,
   * `react-native-windows`). One is written as `reactNative.desktopPackage`; with both the
   * choice is left commented in the config.
   */
  desktopPackages: readonly string[];
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    // tsconfig/jsconfig allow comments + trailing commas (JSONC). Use a real JSONC
    // parser — a naive `//`-stripper corrupts `//` inside string values (e.g. the
    // `"$schema": "https://…"` URL the official Next.js example tsconfigs carry),
    // which silently drops every `paths` alias.
    return parseJsonc(await mfs.readTextFile(path)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Resolve the effective `compilerOptions.paths` (+ `baseUrl`) for the tsconfig/jsconfig at
 * `dir`, following `extends` and — when neither this file nor its extends-chain declares
 * paths — walking up parent directories (monorepos commonly put `paths` in a root tsconfig
 * the app tsconfig doesn't even extend). Returns the paths and the ABSOLUTE base dir they
 * resolve against (the defining file's dir + its `baseUrl`), or null when none are found.
 */
async function resolveTsPaths(
  dir: string,
): Promise<{ paths: Record<string, string[]>; baseDir: string } | null> {
  // Read a config file following its `extends` chain; paths/baseUrl are taken from the
  // nearest file in the chain that declares them, resolved against THAT file's directory.
  const readChain = async (
    file: string,
    seen = new Set<string>(),
  ): Promise<{ paths: Record<string, string[]>; baseDir: string } | null> => {
    if (seen.has(file)) return null;
    seen.add(file);
    const cfg = await readJson(file);
    if (!cfg) return null;
    const co = cfg.compilerOptions as
      | { paths?: Record<string, string[]>; baseUrl?: string }
      | undefined;
    if (co?.paths && Object.keys(co.paths).length) {
      return {
        paths: co.paths,
        baseDir: resolve(dirname(file), co.baseUrl ?? "."),
      };
    }
    if (typeof cfg.extends === "string") {
      const ext = cfg.extends.startsWith(".") ? resolve(dirname(file), cfg.extends) : null; // package-name extends (e.g. @tsconfig/*) aren't followed
      if (ext) {
        const withExt = ext.endsWith(".json") ? ext : ext + ".json";
        return await readChain(withExt, seen);
      }
    }
    return null;
  };

  let cur = dir;
  for (let i = 0; i < 6; i++) {
    const ts = await firstExisting(cur, ["tsconfig.json", "jsconfig.json"]);
    if (ts) {
      const r = await readChain(join(cur, ts));
      if (r) return r;
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

/**
 * tsconfig/jsconfig `paths` → deno.json import entries, as `[key, value]` pairs with the
 * value made RELATIVE to `appDir` (so a monorepo-root tsconfig's `./packages/x/src` becomes
 * `../packages/x/src` for an app in a subdir). A `foo/*` key/target keeps a trailing `/`
 * (prefix map); a bare key maps to the exact file.
 */
async function collectTsPathAliases(
  appDir: string,
): Promise<Array<[string, string]>> {
  const resolved = await resolveTsPaths(appDir);
  if (!resolved) return [];
  const out: Array<[string, string]> = [];
  for (const [k, arr] of Object.entries(resolved.paths)) {
    if (!arr?.length) continue;
    const isPrefix = k.endsWith("/*"); // "@x/*" is a prefix map; "@x" an exact map
    const key = isPrefix ? k.slice(0, -1) : k; // "@x/*" → "@x/"
    const rawTarget = arr[0].endsWith("/*") ? arr[0].slice(0, -2) : arr[0];
    // Absolute target (against the defining tsconfig's baseDir), then relative to appDir.
    const abs = resolve(resolved.baseDir, rawTarget);
    let val = relative(appDir, abs).replace(/\\/g, "/"); // Deno uses forward slashes
    if (!val.startsWith(".")) val = "./" + val;
    // A prefix map's target must keep a trailing slash (`resolve` strips it).
    if (isPrefix && !val.endsWith("/")) val += "/";
    out.push([key, val]);
  }
  return out;
}

/** The framework's exported subpaths under any of `prefixes` (e.g. `next/link`, `next/image`). */
async function frameworkSubpaths(prefixes: string[]): Promise<string[]> {
  const cfg = await readFrameworkJson("deno.json");
  const exports = (cfg.exports ?? {}) as Record<string, string>;
  return Object.keys(exports)
    .map((k) => k.replace(/^\.\//, ""))
    .filter((k) => prefixes.some((p) => k.startsWith(p)))
    .sort();
}

/**
 * The `@^<version>` suffix that pins a migrated app to this framework's release line. Reads
 * the framework's own `deno.json` scheme-agnostically (a local checkout OR the JSR package —
 * `join(frameworkRoot(), …)` corrupts a `https://` root). Throws rather than silently
 * emitting an unpinned `jsr:@denext/denext`.
 */
async function denextVersion(): Promise<string> {
  const cfg = await readFrameworkJson("deno.json");
  const version = typeof cfg.version === "string" ? cfg.version : "";
  if (!version) throw new Error("denext migrate: could not read the framework version");
  return `@^${version}`;
}

/** How the generated config points at denext: published JSR (default) or a local checkout. */
interface DenextResolver {
  /** The bare `denext` specifier. */
  base: string;
  /** `denext/<sub>` (a JSR subpath, or the local file it resolves to). */
  sub: (sub: string) => string;
  /** A trailing-slash prefix specifier (`next/`, `next-intl/`). */
  prefix: (sub: string) => string;
  /** The CLI specifier the `dev`/`build`/… tasks invoke. */
  cli: string;
  /** `@denext/pages-router/<sub>` (exact subpath, e.g. `router`/`link`/`head`). */
  pagesRouter: (sub: string) => string;
  /** The `@denext/pages-router` base + subpath-prefix import-map entries. */
  pagesRouterEntries: () => Record<string, string>;
  /** The `@denext/react-router` base + subpath import-map entries (RR7 framework-mode plugin). */
  reactRouterEntries: () => Record<string, string>;
  /** The `@denext/effect` bridge import-map entry (single `.` export — no subpaths). */
  effectEntry: () => Record<string, string>;
  /**
   * denext's OWN `jsr:`/`npm:` deps (`@std/*`, `ws`, esbuild, …), for **local-path mode
   * only**. A `file://` denext is not a self-contained package, so tools that follow its
   * modules — notably `deno desktop`, which compiles `denext/desktop`'s graph and can't
   * resolve `@std/path` from the app's own import map — need these entries in the app
   * config. Empty for published JSR (the package carries its own deps).
   */
  frameworkDeps: () => Record<string, string>;
}

/**
 * Build a {@link DenextResolver}. Without `localPath` everything points at published JSR. With
 * it (`--denext-local-path`), `denext`/react/next map to `file://` under the local checkout
 * (resolved via its `deno.json` exports) and tasks run its local `cli.ts` — for testing an
 * unreleased/dev denext against a real app without publishing.
 */
/** The resolver for the published JSR package (the package carries its own deps). */
function jsrResolver(V: string): DenextResolver {
  const jsr = (sub: string) => `jsr:@denext/denext${V}/${sub}`;
  return {
    base: `jsr:@denext/denext${V}`,
    sub: jsr,
    prefix: jsr,
    // Pinned to the same range as the import map so the CLI never skews from the runtime.
    cli: `jsr:@denext/denext${V}/cli`,
    pagesRouter: (sub) => (sub ? `${PAGES_ROUTER_SPEC}/${sub}` : PAGES_ROUTER_SPEC),
    pagesRouterEntries: () => ({
      "@denext/pages-router": PAGES_ROUTER_SPEC,
      "@denext/pages-router/": PAGES_ROUTER_SPEC + "/",
    }),
    reactRouterEntries: () => ({
      "@denext/react-router": REACT_ROUTER_SPEC,
      "@denext/react-router/routes": REACT_ROUTER_SPEC + "/routes",
      "@denext/react-router/dom": REACT_ROUTER_SPEC + "/dom",
    }),
    effectEntry: () => ({ "@denext/effect": EFFECT_SPEC }),
    frameworkDeps: () => ({}),
  };
}

/** A package's `deno.json` `exports` map (empty when absent). */
async function packageExports(dir: string): Promise<Record<string, string>> {
  return ((await readJson(join(dir, "deno.json")))?.exports ?? {}) as Record<string, string>;
}

/**
 * denext's own `jsr:`/`npm:` deps from a checkout's `deno.json` — the app config must carry
 * these so `deno desktop` (and any tool following the local file:// denext modules) can
 * resolve `@std/path`, `ws`, … Only the ones denext's own runtime source imports: the root
 * import map also serves the workspace packages and the tests (`effect@^3` for
 * `@denext/effect`, `jsqr` for a test), and mapping those into the app would shadow the app's
 * own versions (T3 Code runs Effect 4).
 */
async function frameworkDepsOf(
  abs: string,
  denoCfg: Record<string, unknown>,
): Promise<Record<string, string>> {
  const used = await denextOwnSpecifiers(abs);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries((denoCfg.imports ?? {}) as Record<string, string>)) {
    if ((v.startsWith("jsr:") || v.startsWith("npm:")) && importsKey(used, k)) out[k] = v;
  }
  return out;
}

/** Static and dynamic import specifiers in module text (statements at a line start). */
const IMPORT_SPECIFIERS = [
  /^[ \t]*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/gm,
  /^[ \t]*import\s*["']([^"']+)["']/gm,
  /\bimport\(\s*["']([^"']+)["']\s*[,)]/g,
];

/** The specifiers each checkout's runtime source imports, cached (the source does not change). */
const ownSpecifiers = new Map<string, Promise<Set<string>>>();

/** Every specifier denext's runtime source (`src/`, `mod.ts`, `cli.ts`) imports. */
function denextOwnSpecifiers(abs: string): Promise<Set<string>> {
  let found = ownSpecifiers.get(abs);
  if (!found) {
    found = (async () => {
      const specs = new Set<string>();
      const scan = (text: string) => {
        for (const re of IMPORT_SPECIFIERS) {
          for (const m of text.matchAll(re)) specs.add(m[1]);
        }
      };
      await walkCode(join(abs, "src"), scan);
      for (const file of ["mod.ts", "cli.ts"]) {
        const text = await mfs.readTextFile(join(abs, file)).catch(() => null);
        if (text) scan(text);
      }
      return specs;
    })();
    ownSpecifiers.set(abs, found);
  }
  return found;
}

/** Whether an import-map key (`ws`, `@std/path`, a `prefix/`) covers one of `specs`. */
function importsKey(specs: Set<string>, key: string): boolean {
  if (key.endsWith("/")) return [...specs].some((s) => s.startsWith(key));
  if (specs.has(key)) return true;
  return [...specs].some((s) => s.startsWith(key + "/"));
}

/**
 * The framework deps an app's import map gets: never one the app depends on itself, which
 * resolves to the app's own version (installed, or pinned by `classifyDeps`).
 */
function frameworkDepsFor(
  R: DenextResolver,
  deps: Record<string, string>,
): Array<[string, string]> {
  return Object.entries(R.frameworkDeps()).filter(([key]) => !(key in deps));
}

/** The resolver: the published JSR package, or a local denext checkout (`--denext-local`). */
async function denextResolver(V: string, localPath?: string): Promise<DenextResolver> {
  if (!localPath) return jsrResolver(V);
  const abs = resolve(localPath);
  const denoCfg = (await readJson(join(abs, "deno.json"))) ?? {};
  const exp = (denoCfg.exports ?? {}) as Record<string, string>;
  const frameworkDeps = await frameworkDepsOf(abs, denoCfg);
  const fileFor = (root: string, rel: string) =>
    toFileUrl(join(root, rel.replace(/^\.\//, ""))).href;
  const local = (sub: string): string => {
    const rel = exp[sub === "" ? "." : "./" + sub];
    return rel ? fileFor(abs, rel) : toFileUrl(join(abs, sub)).href;
  };
  // pages-router and @denext/effect are workspace members at <abs>/packages/* in a checkout.
  const prDir = join(abs, "packages", "pages-router");
  const prExp = await packageExports(prDir);
  const efDir = join(abs, "packages", "effect");
  const efExp = await packageExports(efDir);
  const rrExp = await packageExports(join(abs, "packages", "react-router"));
  return {
    base: local(""),
    sub: local,
    // `next/`, `next-intl/` map to a local source-dir prefix (sloppy-imports adds `.ts`).
    prefix: (sub) => toFileUrl(join(abs, "src", "compat", sub.replace(/\/$/, "")) + "/").href,
    cli: toFileUrl(join(abs, "cli.ts")).href,
    pagesRouter: (sub) => {
      const key = sub === "" ? "." : "./" + sub.replace(/\/$/, "");
      return fileFor(prDir, prExp[key] ?? "./mod.ts");
    },
    // Local mode can't map a `@denext/pages-router/` prefix to one file, so expand each of the
    // package's concrete export subpaths (mirrors JSR's exports-based subpath resolution).
    pagesRouterEntries: () => {
      const out: Record<string, string> = {
        "@denext/pages-router": fileFor(prDir, prExp["."] ?? "./mod.ts"),
      };
      for (const [k, rel] of Object.entries(prExp)) {
        if (k !== ".") {
          out["@denext/pages-router/" + k.slice(2)] = fileFor(prDir, rel);
        }
      }
      return out;
    },
    reactRouterEntries: () => {
      const rrDir = join(abs, "packages", "react-router");
      const out: Record<string, string> = {};
      for (const [k, rel] of Object.entries(rrExp)) {
        const key = k === "." ? "@denext/react-router" : "@denext/react-router/" + k.slice(2);
        out[key] = fileFor(rrDir, rel);
      }
      return out;
    },
    effectEntry: () => ({
      "@denext/effect": fileFor(efDir, efExp["."] ?? "./mod.ts"),
    }),
    frameworkDeps: () => frameworkDeps,
  };
}

/**
 * Detect Prisma in the App-Router/Remix app and, when present, fold its wiring into the
 * import map and return the {@link PrismaWiring} (whose `links`/`tasks`/`nodeModulesDir` the
 * caller merges into the generated deno.json, and whose `finalize()` it runs after writing).
 * A no-op returning null when the app doesn't use Prisma. The compat is bundled from denext's
 * own `better-sqlite3` export — a JSR subpath on the published path, a `file://` locally.
 */
async function applyPrismaImports(
  dir: string,
  deps: Record<string, string>,
  imports: Record<string, string>,
  R: DenextResolver,
): Promise<PrismaWiring | null> {
  const wiring = await detectPrismaWiring(dir, deps, R.sub("better-sqlite3"));
  if (!wiring) return null;
  for (const key of wiring.importsToDelete) delete imports[key];
  Object.assign(imports, wiring.importsToAdd);
  return wiring;
}

/**
 * Write the App-Router-shaped `deno.json` (shared by the Next + Remix paths): the dev/build/
 * start tasks (+ any Prisma `prisma:setup` task), `manual` node_modules + `links` when Prisma
 * is wired (else `auto`), sloppy-imports, and the react-jsx compiler options. Never clobbers a
 * hand-authored config (only writes when absent or previously migrate-generated), then ensures
 * `.gitignore` + the Deno LSP `.vscode` settings. Returns whether a hand-authored `deno.json`
 * already existed (left untouched). Pushes every file it writes onto `written`.
 */
async function writeAppRouterDenoJson(
  dir: string,
  R: DenextResolver,
  imports: Record<string, string>,
  prismaWiring: PrismaWiring | null,
  written: string[],
  cap?: CapacitorPlan,
): Promise<boolean> {
  const denoJson = {
    tasks: appRouterTasks(R, prismaWiring, cap),
    // Prisma needs a real node_modules (the generated client + adapter + `links` shim);
    // otherwise the App-Router native passes resolve npm deps via `auto`.
    nodeModulesDir: prismaWiring?.nodeModulesDir ?? "auto",
    minimumDependencyAge: DENEXT_MIN_DEP_AGE,
    ...(prismaWiring ? { links: prismaWiring.links } : {}),
    unstable: ["sloppy-imports"],
    compilerOptions: {
      jsx: "react-jsx",
      jsxImportSource: "react",
      lib: ["deno.window", "dom", "dom.iterable", "dom.asynciterable"],
      strict: true,
      // npm React libraries ship their own `@types/react`-based `.d.ts`; with `react` aliased
      // to denext they'd be re-checked against denext's type shim and report harmless mismatches
      // deep in node_modules. Skip declaration-file checking (as Next.js/CRA do) so `deno check`
      // validates YOUR code, not the libraries' bundled types — your `.tsx` is still checked.
      skipLibCheck: true,
    },
    imports,
  };
  const denoJsonExists = await writeDenoJsonUnlessAuthored(dir, denoJson, written);
  // Ignore denext's generated build artifacts (`.denext/` build cache, `out/` export), and
  // with a Capacitor target the native build outputs.
  await ensureGitignore(dir, [".denext/", "out/", ...(cap ? cap.ignores : [])], written);
  // Turn on the Deno LSP so editors resolve the `denext` import map like `deno` does.
  await ensureVscodeDeno(dir, written);
  return denoJsonExists;
}

/** An App Router app's tasks: the dev/build/export/start set, Prisma's, and the Capacitor ones. */
function appRouterTasks(
  R: DenextResolver,
  prismaWiring: PrismaWiring | null,
  cap?: CapacitorPlan,
): Record<string, string> {
  return {
    ...spaTasks(false, R.cli, false, prismaWiring?.nodeModulesDir ?? "auto"),
    ...prismaWiring?.tasks,
    ...cap?.tasks,
  };
}

/**
 * Distinctive sentinel marking a file as migrate-generated. Its presence lets a re-run
 * overwrite the file (idempotence) while a hand-authored file of the same name is left
 * untouched — the basis of a PR's commit-parity check (`re-run migrate → git diff` clean).
 * It rides in a `.ts` comment line ({@link GEN_MARKER}) or a deno.json `"//"` key
 * ({@link GEN_MARKER_TEXT}), so deno.json stays valid strict JSON.
 */
const GEN_SENTINEL = "generated by `denext migrate`";
const GEN_MARKER_TEXT = `${GEN_SENTINEL} — safe to edit; re-running may overwrite`;
const GEN_MARKER = `// ${GEN_MARKER_TEXT}`;

/** Whether a path is absent or a previously migrate-generated file (safe to (over)write). */
/**
 * Write the generated `deno.json` unless a hand-authored one exists (never clobbered).
 * Returns whether an authored file was left in place (the CLI's "already exists" hint).
 */
async function writeDenoJsonUnlessAuthored(
  dir: string,
  denoJson: Record<string, unknown>,
  written: string[],
): Promise<boolean> {
  const denoJsonPath = join(dir, "deno.json");
  if (!(await writable(denoJsonPath))) return true;
  await mfs.writeTextFile(denoJsonPath, denoJsonText(denoJson));
  written.unshift(denoJsonPath);
  return false;
}

async function writable(path: string): Promise<boolean> {
  const cur = await mfs.readTextFile(path).catch(() => null);
  return cur === null || cur.includes(GEN_SENTINEL);
}

/** Serialize a generated deno.json with the sentinel in a leading `"//"` key (strict JSON). */
function denoJsonText(obj: Record<string, unknown>): string {
  return JSON.stringify({ "//": GEN_MARKER_TEXT, ...obj }, null, 2) + "\n";
}

/** The next.config.* keys denext honors directly (copied as literals into denext.config). */
interface NextConfigTranslation {
  /** Literal config fields denext consumes as-is (basePath, images, i18n, …). */
  fields: Record<string, unknown>;
  /** Resolved `redirects`/`rewrites`/`headers` arrays (functions called + inlined). */
  rules: Record<string, unknown>;
  /** Recognized-but-unsupported keys (warned + dropped). */
  dropped: string[];
  /** The next.config filename that was read, or null. */
  file: string | null;
  /** True when the config couldn't be evaluated → emit a hand-port note instead. */
  raw: boolean;
  /** Why the evaluation failed (when {@link raw}). */
  rawReason?: string;
  /**
   * True when the next.config wires MDX plugins (`@next/mdx`/`createMDX` with
   * remark/rehype/recma lists). `createMDX` hides those options inside a webpack-loader
   * closure, so the generated `denext.config.ts` recovers them at BUILD time via
   * `resolveNextMdx` (running the app's own next.config with `@next/mdx` captured) rather
   * than serializing the live plugin fns or dropping them.
   */
  mdx?: boolean;
}

/** next.config keys denext maps straight through (same names/shapes as Next). */
const NEXT_PASSTHROUGH_KEYS = [
  "cacheComponents", // Next 16's top-level flag is denext's stable opt-in of the same name
  "basePath",
  "trailingSlash",
  "assetPrefix",
  "images",
  "i18n",
] as const;
/** `() => Rule[]` async config functions denext supports with the same signature. */
const NEXT_RULE_FNS = ["redirects", "rewrites", "headers"] as const;
/**
 * next.config keys denext cannot copy verbatim — reported with per-key guidance so
 * a load-bearing key (e.g. `env`, `transpilePackages`) is never dropped without a
 * pointer to its denext equivalent. Keys map to a one-line note; keys with no note
 * ("") are genuinely inert on denext. Emitted by {@link nextConfigSource}.
 */
const NEXT_DROP_GUIDANCE: Record<string, string> = {
  // Deno transpiles every dependency natively (no Babel/webpack loader chain), so
  // there is nothing to opt into transpiling — this key is simply unnecessary.
  transpilePackages: "not needed — Deno transpiles all dependencies natively.",
  // Next's `env` inlines arbitrary `process.env.X` at build. denext exposes vars a
  // different way: NEXT_PUBLIC_*/publicEnv reach the client, and server code reads
  // `Deno.env`/`process.env` at runtime. Re-express any client-read keys as publicEnv.
  env: "denext reads env at runtime; expose client-visible keys via `publicEnv` (NEXT_PUBLIC_*).",
  // `output: "export"` ≈ `deno task export` (static), `"standalone"` ≈ `deno task build`
  // (prod server) — chosen by which task you run, not a config field.
  output:
    'use the task instead — `deno task export` (≈ "export") or `deno task build` (≈ "standalone").',
  // denext follows React's own StrictMode semantics; wrap a subtree in <StrictMode>
  // where you want the double-invoke dev checks, rather than a global flag.
  reactStrictMode: "wrap a subtree in <StrictMode> where you want dev double-invoke checks.",
  pageExtensions:
    "denext routes .tsx/.ts/.jsx/.js by convention; custom page extensions aren't configurable.",
  webpack: "", // no webpack — Deno + esbuild handle bundling.
  compiler: "", // SWC/Babel compiler options don't apply to Deno's toolchain.
  swcMinify: "", // minification is handled by the denext build, always on for prod.
  experimental:
    "Next experimental flags have no denext equivalent — except `ppr`/`useCache`/`dynamicIO`, which map to top-level `cacheComponents: true`, and `optimizePackageImports`, which is top-level `optimizePackageImports` (lucide-react, date-fns, … are optimized by default).",
  poweredByHeader: "", // denext never emits an X-Powered-By header.
  productionBrowserSourceMaps: "", // source-map emission is governed by the denext build.
};
/** The set of drop keys (derived from {@link NEXT_DROP_GUIDANCE}). */
const NEXT_DROP_KEYS = new Set(Object.keys(NEXT_DROP_GUIDANCE));

/** The line prefix {@link NEXT_EVAL_PROGRAM} prints its JSON result behind. */
const NEXT_EVAL_MARKER = "__DENEXT_NEXT_CONFIG__";

/**
 * The evaluator program run as a SUBPROCESS in the app's own directory (through the shared
 * bounded evaluator, `next-config-eval.ts`), so the config's npm plugin imports (`@next/mdx`,
 * …) and `next` resolve from the app's node_modules — not denext's module graph. It imports
 * the resolved default export, copies the honored literal fields, CALLS
 * `redirects`/`rewrites`/`headers` and inlines their resolved arrays (a function can't be
 * serialized; its result can, and denext's config takes the same shape), lists dropped keys,
 * and prints one JSON line.
 */
const NEXT_EVAL_PROGRAM = `
const PASS = ${JSON.stringify(NEXT_PASSTHROUGH_KEYS)};
const RULES = ${JSON.stringify(NEXT_RULE_FNS)};
const DROP = ${JSON.stringify([...NEXT_DROP_KEYS])};
${LOAD_NEXT_CONFIG}
const out = { fields: {}, rules: {}, dropped: [] };
if (cfg && typeof cfg === "object") {
  for (const k of PASS) if (cfg[k] !== undefined) out.fields[k] = cfg[k];
  for (const fn of RULES) {
    if (typeof cfg[fn] === "function") {
      try { out.rules[fn] = await cfg[fn](); } catch { /* skip a rule fn that throws */ }
    }
  }
  for (const k of Object.keys(cfg)) if (DROP.includes(k)) out.dropped.push(k);
}
console.log(${JSON.stringify(NEXT_EVAL_MARKER)} + JSON.stringify(out));
// Exit NOW: a config wrapper (fumadocs-mdx's createMDX, a plugin spawning a watcher) may keep
// the event loop alive or crash asynchronously after the config object was already handed
// over — that must not turn a successful evaluation into a failed one.
Deno.exit(0);
`;

/**
 * Evaluate the app's `next.config.*` in a subprocess rooted at the app dir (so its npm
 * plugin imports resolve from the app's installed node_modules), returning the honored
 * translation. On any failure (exotic/side-effectful config, missing deps) the caller falls
 * back to a hand-port note. Returns null when there is no next.config at all.
 */
async function readNextConfig(
  dir: string,
): Promise<NextConfigTranslation | null> {
  const file = await firstExisting(dir, [
    "next.config.ts",
    "next.config.mjs",
    "next.config.js",
    "next.config.cjs",
  ]);
  if (!file) return null;
  const base: NextConfigTranslation = {
    fields: {},
    rules: {},
    dropped: [],
    file,
    raw: false,
    mdx: await hasMdxPluginWiring(join(dir, file)),
  };
  return await evalNextConfig(dir, file, base);
}

/**
 * Scan the config SOURCE for MDX-plugin wiring: `createMDX({ options })` buries its
 * remark/recma lists in a webpack-loader closure the subprocess eval can't reach, so a
 * source signal is the only reliable detection. Trigger only when plugins are actually
 * configured (a plain `@next/mdx` with no plugins is covered by the baseline loader).
 */
async function hasMdxPluginWiring(configFile: string): Promise<boolean> {
  try {
    const src = await mfs.readTextFile(configFile);
    return /\b(remark|rehype|recma)Plugins\b/.test(src) ||
      (/@next\/mdx|createMDX/.test(src) && /codehike|remark-|rehype-|recma-/.test(src));
  } catch {
    return false; // unreadable — leave mdx false
  }
}

/**
 * Evaluate the config in a bounded subprocess. A side-effectful next.config (a watcher, a
 * DB connect, an unresolved top-level await) would otherwise hang `denext migrate` forever;
 * on timeout (`DENEXT_NEXT_EVAL_TIMEOUT_MS`, default 15 s — widened by the migrate fixture
 * test so a CPU-starved gate doesn't silently drop to the golden-mismatching raw port) the
 * child is killed and the caller falls back to the hand-port path (raw:true).
 */
async function evalNextConfig(
  dir: string,
  file: string,
  base: NextConfigTranslation,
): Promise<NextConfigTranslation> {
  const result = await evalNextConfigProgram({
    dir,
    file,
    program: NEXT_EVAL_PROGRAM,
    marker: NEXT_EVAL_MARKER,
  });
  if (!result.ok) return { ...base, raw: true, rawReason: result.reason };
  return {
    ...base,
    ...(result.value as Pick<NextConfigTranslation, "fields" | "rules" | "dropped">),
  };
}

/**
 * Detect the source framework (a `--from` override wins) and run the non-Next migration
 * for it, or return null for a Next.js App Router project. CRA, Vite, and generic React
 * apps all take the SPA path — `mode:"spa"` + a generated denext.config.ts, differing only
 * in how the entry/env/proxy are read. Remix must be detected BEFORE Vite (Remix-Vite
 * carries a vite.config that would otherwise capture it as a SPA); it is the one path
 * that transforms the route tree.
 */
async function migrateNonNextProject(
  dir: string,
  deps: Record<string, string>,
  options: MigrateOptions,
): Promise<MigrateResult | null> {
  const from = options.from;
  if (from === "next") return null;
  if (from === "expo" || (!from && await isExpoApp(dir, deps))) {
    return await migrateExpoProject(dir, deps, options);
  }
  return (await migrateRemixFamily(dir, deps, options)) ??
    (await migrateSpaFamily(dir, deps, options));
}

/** Remix v2 (source transform) or React Router v7 framework mode (the plugin). */
async function migrateRemixFamily(
  dir: string,
  deps: Record<string, string>,
  options: MigrateOptions,
): Promise<MigrateResult | null> {
  const from = options.from;
  // RR7 config routing (`app/routes.ts`) runs on the @denext/react-router PLUGIN — sources
  // untouched, unlike the Remix v2 transform.
  if (from === "react-router" || (!from && await isReactRouterFramework(dir))) {
    return await migrateReactRouterProject(dir, deps, options);
  }
  if (from === "remix" || (!from && await isRemix(dir, deps))) {
    return await migrateRemixProject(dir, deps, options);
  }
  return null;
}

/** CRA, Vite or a generic React SPA → SPA mode. */
async function migrateSpaFamily(
  dir: string,
  deps: Record<string, string>,
  options: MigrateOptions,
): Promise<MigrateResult | null> {
  const from = options.from;
  for (const source of ["cra", "vite", "generic"] as const) {
    const detect = source === "cra" ? isCra : source === "vite" ? isViteSpa : isGenericSpa;
    if (from === source || (!from && await detect(dir, deps))) {
      return await migrateSpaProject(dir, deps, options, source);
    }
  }
  return null;
}

/**
 * Pages Router: the app runs on the @denext/pages-router plugin — map its specifier and
 * scaffold a denext.config.ts that registers the plugin (and, when the app uses `effect`,
 * the @denext/effect bridge's effect() plugin; empty layer, the user adds their AppLayer).
 * The Pages Router router/link/head APIs live in the plugin, not denext core, so
 * `next/router`, `next/link`, `next/head` point at the plugin for an UNMODIFIED app (no
 * `--codemod`); these override the App Router `next/*` entries (which don't include
 * `next/router` at all). Returns whether the config was written / already existed.
 */
async function writePagesRouterConfig(
  configPath: string,
  R: DenextResolver,
  imports: Record<string, string>,
  hasEffect: boolean,
  written: string[],
): Promise<{ configWritten: boolean; configExists: boolean }> {
  Object.assign(imports, R.pagesRouterEntries());
  imports["next/router"] = R.pagesRouter("router");
  imports["next/link"] = R.pagesRouter("link");
  imports["next/head"] = R.pagesRouter("head");
  if (!(await writable(configPath))) return { configWritten: false, configExists: true };
  const pluginImports = [`import { pagesRouter } from "@denext/pages-router";`];
  const pluginCalls = ["pagesRouter()"];
  if (hasEffect) {
    pluginImports.push(`import { effect } from "@denext/effect";`);
    pluginCalls.push("effect()");
  }
  await mfs.writeTextFile(
    configPath,
    GEN_MARKER + "\n" +
      pluginImports.join("\n") + "\n\n" +
      `export default {\n` +
      (hasEffect
        ? `  // effect(): pass your app Layer to provide services — effect({ layer: AppLayer }).\n`
        : "") +
      `  plugins: [${pluginCalls.join(", ")}],\n};\n`,
  );
  written.push(configPath);
  return { configWritten: true, configExists: false };
}

/** Where a Next app keeps the stylesheet that pulls Tailwind in, in the order Next projects use. */
const TAILWIND_INPUT_CANDIDATES = [
  "app/globals.css",
  "src/app/globals.css",
  "styles/globals.css",
  "src/styles/globals.css",
  "app/global.css",
  "src/index.css",
];

/**
 * The App Router app's Tailwind input stylesheet: the first candidate that exists and imports
 * Tailwind (`@import "tailwindcss"` — v4 — or a v3 `@tailwind` directive), as a `./`-relative
 * path for the `tailwind` config block. `null` when the app has no such file (a Tailwind dep
 * alone — e.g. only `prettier-plugin-tailwindcss` — configures nothing). Exported for testing.
 */
export async function findTailwindInput(
  dir: string,
  candidates: readonly string[] = TAILWIND_INPUT_CANDIDATES,
): Promise<string | null> {
  for (const rel of candidates) {
    let css: string;
    try {
      css = await mfs.readTextFile(join(dir, rel));
    } catch {
      continue;
    }
    if (TAILWIND_DIRECTIVE.test(css)) return "./" + rel;
  }
  return null;
}

/** Where Vite/CRA templates put the stylesheet that imports Tailwind, most common first. */
const SPA_TAILWIND_INPUT_CANDIDATES = [
  "src/index.css",
  "src/styles.css",
  "src/App.css",
  "src/app.css",
  "src/main.css",
  "src/global.css",
  "src/globals.css",
  "src/styles/index.css",
  "src/styles/globals.css",
  "src/styles/global.css",
  "src/tailwind.css",
];

// The whole-framework import or a v3 directive — not `@import "tailwindcss/theme"` (a
// component stylesheet's reference import) and not `tailwindcss-animate`.
const TAILWIND_DIRECTIVE = /@import\s+["']tailwindcss["']|@tailwind\s+(base|utilities|components)/;

/**
 * The SPA's Tailwind input stylesheet (`./`-relative), or `null`. Vite templates disagree on
 * the name (`index.css`, `styles.css`, `App.css`, …), so after the known candidates every
 * `.css` under `src/` (three levels deep) is scanned for the Tailwind directive — a wrong
 * guess here ships the raw `@import "tailwindcss"` and the migrated app renders unstyled.
 * Exported for testing.
 */
export async function findSpaTailwindInput(dir: string): Promise<string | null> {
  const known = await findTailwindInput(dir, SPA_TAILWIND_INPUT_CANDIDATES);
  if (known) return known;
  for (const rel of await cssFilesUnder(join(dir, "src"), "src", 3)) {
    const css = await mfs.readTextFile(join(dir, rel)).catch(() => "");
    if (TAILWIND_DIRECTIVE.test(css)) return "./" + rel;
  }
  return null;
}

/** `.css` files under `abs` (reported as `rel`-prefixed paths), sorted, at most `depth` deep. */
async function cssFilesUnder(abs: string, rel: string, depth: number): Promise<string[]> {
  if (depth < 0) return [];
  const files: string[] = [];
  const dirs: string[] = [];
  try {
    for await (const e of mfs.readDir(abs)) {
      if (e.isFile && e.name.endsWith(".css")) files.push(`${rel}/${e.name}`);
      else if (e.isDirectory && e.name !== "node_modules") dirs.push(e.name);
    }
  } catch {
    return [];
  }
  files.sort();
  for (const d of dirs.sort()) {
    files.push(...await cssFilesUnder(join(abs, d), `${rel}/${d}`, depth - 1));
  }
  return files;
}

/**
 * App Router: generate a full denext.config.ts (compat mode, Tailwind, next.config
 * translation, publicEnv). Never clobbers a hand-authored one (no marker). MDX-plugin apps
 * get the build-time recovery helper import (see nextConfigSource). Returns whether an
 * authored config was left in place.
 */
async function writeAppRouterConfig(
  dir: string,
  configPath: string,
  deps: Record<string, string>,
  jsr: (sub: string) => string,
  imports: Record<string, string>,
  extra: { effect: boolean; mobileIcon?: MobileIconFacts },
  written: string[],
): Promise<{ exists: boolean; next: NextConfigTranslation | null }> {
  const tailwind = ("tailwindcss" in deps || "@tailwindcss/postcss" in deps)
    ? await findTailwindInput(dir)
    : null;
  const publicEnv = await collectNextPublicEnvKeys(dir);
  const next = await readNextConfig(dir);
  if (next?.mdx) imports["denext/build/next-mdx"] = jsr("build/next-mdx");
  if (!(await writable(configPath))) return { exists: true, next };
  await mfs.writeTextFile(
    configPath,
    nextConfigSource({ tailwind, publicEnv, next, ...extra }),
  );
  written.push(configPath);
  return { exists: false, next };
}

/**
 * Convert the project at `dir` (Next.js, Remix / React Router, a Vite / CRA / generic SPA, or
 * Expo) to denext config files. Returns a summary; throws on an unreadable package.json, and
 * before writing anything on an invalid `--app-id` / `--platform`.
 */
export async function migrateProject(
  dir: string,
  options: MigrateOptions = {},
): Promise<MigrateResult> {
  checkCapacitorFlags(options);
  const r = await migrateAnyProject(dir, options);
  if (!options.capacitor || r.capacitor) return r;
  return { ...r, capacitorSkipped: capacitorSkipReason(r) };
}

/** Refuse a bad `--app-id` / `--platform`, or one given without `--enable-capacitor`. */
function checkCapacitorFlags(options: MigrateOptions): void {
  if (!options.capacitor && (options.appId !== undefined || options.platforms?.length)) {
    throw new Error("--app-id and --platform configure --enable-capacitor; pass it too");
  }
  validateCapacitorOptions(capacitorOptionsOf(options));
}

/** The `--enable-capacitor` options from the migrate options. */
function capacitorOptionsOf(options: MigrateOptions): CapacitorOptions {
  return { appId: options.appId, platforms: options.platforms };
}

/** Why a migration path has no Capacitor target. */
function capacitorSkipReason(r: MigrateResult): string {
  const what = r.kind === "remix"
    ? "a Remix / React Router app (its loaders and actions need a server)"
    : "a Pages Router app";
  return `--enable-capacitor covers SPA, Next App Router and Expo apps; this is ${what}, ` +
    "which it does not cover yet";
}

/** The migration for whichever framework `dir` holds. */
async function migrateAnyProject(dir: string, options: MigrateOptions): Promise<MigrateResult> {
  const deps = await readAppDeps(dir);
  return await migrateNonNextProject(dir, deps, options) ??
    await migrateNextProject(dir, deps, options);
}

/** A Next.js app (App Router, or Pages Router on the plugin). */
async function migrateNextProject(
  dir: string,
  deps: Record<string, string>,
  options: MigrateOptions,
): Promise<MigrateResult> {
  const { pm, pnp } = await detectPackageManager(dir);
  if (pnp) throw pnpUnsupported(dir);
  const R = await denextResolver(await denextVersion(), options.denextLocalPath);
  const jsr = R.sub;
  const { imports, hasEffect, ...classified } = await resolveAppRouterImports(dir, R, deps);

  const pagesRouter = await exists(join(dir, "pages")) ||
    await exists(join(dir, "src/pages"));
  const cap = await appRouterCapacitor(dir, { deps, pm, R, options, pagesRouter });
  const written: string[] = [];
  const { pagesConfigWritten, pagesConfigExists, next } = await writeMigratedConfig(
    dir,
    pagesRouter,
    { R, jsr, deps, imports, hasEffect, mobileIcon: cap.mobileIcon },
    written,
  );

  // Prisma: fold the Deno-client/adapter import pins into the map (and, below, `links` +
  // `manual` node_modules + the `prisma:setup` task). null for non-Prisma apps.
  const prismaWiring = await applyPrismaImports(dir, deps, imports, R);

  const denoJsonExists = await writeAppRouterDenoJson(
    dir,
    R,
    imports,
    prismaWiring,
    written,
    cap.plan,
  );
  const capacitor = await writeCapacitorConfig(dir, cap.plan, written);
  // Prisma source transform (schema + `@prisma/client` imports + adapter injection + patch
  // package + setup script) runs after the config is written.
  const prisma = prismaWiring ? await prismaWiring.finalize() : undefined;
  return {
    kind: "next",
    wrote: written,
    ...classified,
    pagesRouter,
    effect: hasEffect,
    pagesConfigWritten,
    pagesConfigExists,
    denoJsonExists,
    prisma,
    nextConfig: nextConfigReport(next),
    capacitor,
  };
}

/**
 * The Capacitor target of a Next App Router app (`--enable-capacitor`; never a Pages Router
 * app): the plan, and the app icon it records. Empty without one.
 */
async function appRouterCapacitor(
  dir: string,
  app: {
    deps: Record<string, string>;
    pm: PackageManager | null;
    R: DenextResolver;
    options: MigrateOptions;
    pagesRouter: boolean;
  },
): Promise<{ plan?: CapacitorPlan; mobileIcon?: MobileIconFacts }> {
  if (!app.options.capacitor || app.pagesRouter) return {};
  const { deps, pm, R, options } = app;
  const pkgName = (await readJson(join(dir, "package.json")))?.name;
  const packageName = typeof pkgName === "string" ? pkgName : undefined;
  const plan = await planCapacitor({
    dir,
    deps,
    pm,
    cli: R.cli,
    run: MIGRATED_RUN,
    appName: packageName?.replace(/^@[^/]+\//, "") || "app",
    packageName,
    kind: "app-router",
    serverFiles: await appRouterServerFiles(dir),
    options: capacitorOptionsOf(options),
  });
  return { plan, mobileIcon: (await migrateAppIcon(dir, true)).facts.mobileIcon };
}

/**
 * Write the planned `capacitor.config.ts` (unless a hand-authored config is kept), returning
 * the Capacitor report.
 */
async function writeCapacitorConfig(
  dir: string,
  plan: CapacitorPlan | undefined,
  written: string[],
): Promise<CapacitorMigrateInfo | undefined> {
  if (!plan) return undefined;
  const configWritten = plan.writeConfig &&
    await writeIfWritable(
      join(dir, "capacitor.config.ts"),
      () => capacitorConfigSource(GEN_MARKER, plan.info, placeholderNote(plan.info.appIdSource)),
      written,
    );
  return { ...plan.info, configWritten };
}

/** The TODO comment over a placeholder app id, by where it came from. */
function placeholderNote(source: CapacitorMigrateInfo["appIdSource"]): string | undefined {
  return source === "package name"
    ? "derived from the package name; set your bundle id (or --app-id)"
    : undefined;
}

/** The app's dependencies + devDependencies from its package.json (throws if absent). */
async function readAppDeps(dir: string): Promise<Record<string, string>> {
  const pkg = await readJson(join(dir, "package.json"));
  if (!pkg) throw new Error(`no package.json found in ${dir}`);
  return {
    ...(pkg.dependencies as Record<string, string> ?? {}),
    ...(pkg.devDependencies as Record<string, string> ?? {}),
  };
}

/**
 * The generated import map for an App Router app plus the dependency classification.
 * App Router has Deno-native build passes (the boundary/exports reader imports app
 * modules) — not only the esbuild compat bundle — so Deno itself must resolve app npm
 * deps. The proven shape is `nodeModulesDir:"auto"` + a pinned `npm:name@version` per
 * dep (these go in the generated deno.json; package.json/the lockfile are never touched).
 * Deps with an unpinnable `catalog:`/`workspace:*` version are left to the installed
 * node_modules + the default-on tolerant resolver instead of a (bogus) pin.
 *
 * An app depending on the npm `effect` package gets the first-party `@denext/effect`
 * bridge mapped too (its `effect()` plugin is added to the generated denext.config.ts);
 * `effect` itself stays in `passthrough` (pinned) for the app's own `import … from
 * "effect"` — this only adds the denext-side runtime bridge.
 */
async function resolveAppRouterImports(
  dir: string,
  R: DenextResolver,
  deps: Record<string, string>,
): Promise<
  { imports: Record<string, string>; hasEffect: boolean } & ReturnType<typeof classifyDeps>
> {
  const imports = await buildAppRouterImports(dir, R, deps);
  const classified = classifyDeps(deps, imports, { pin: true });
  const hasEffect = "effect" in deps;
  if (hasEffect) Object.assign(imports, R.effectEntry());
  return { imports, hasEffect, ...classified };
}

/**
 * Write `denext.config.ts` for the detected router: the Pages Router plugin config, or
 * the App Router config. Reuses the "config already exists" signal for the CLI hint.
 */
async function writeMigratedConfig(
  dir: string,
  pagesRouter: boolean,
  app: {
    R: DenextResolver;
    jsr: DenextResolver["sub"];
    deps: Record<string, string>;
    imports: Record<string, string>;
    hasEffect: boolean;
    /** The `mobile` block recording the app icon (a Capacitor target). */
    mobileIcon?: MobileIconFacts;
  },
  written: string[],
): Promise<
  {
    pagesConfigWritten: boolean;
    pagesConfigExists: boolean;
    next: NextConfigTranslation | null;
  }
> {
  const configPath = join(dir, "denext.config.ts");
  if (pagesRouter) {
    const r = await writePagesRouterConfig(configPath, app.R, app.imports, app.hasEffect, written);
    return { pagesConfigWritten: r.configWritten, pagesConfigExists: r.configExists, next: null };
  }
  const { exists: pagesConfigExists, next } = await writeAppRouterConfig(
    dir,
    configPath,
    app.deps,
    app.jsr,
    app.imports,
    { effect: app.hasEffect, mobileIcon: app.mobileIcon },
    written,
  );
  return { pagesConfigWritten: false, pagesConfigExists, next };
}

// ── Remix migration (assisted: config + route-tree transform) ─────────────────

/**
 * The shared setup both Remix-family migrations do: reject a pnp tree, resolve denext, and
 * build the App-Router import map with the Remix compat aliases.
 */
async function remixAppBase(
  dir: string,
  deps: Record<string, string>,
  options: MigrateOptions,
): Promise<{ R: DenextResolver; imports: Record<string, string> }> {
  const { pnp } = await detectPackageManager(dir);
  if (pnp) throw pnpUnsupported(dir);
  const R = await denextResolver(await denextVersion(), options.denextLocalPath);
  const imports = await buildAppRouterImports(dir, R, deps, { remix: true });
  return { R, imports };
}

/** True for a React Router v7 framework-mode app: `app/routes.ts` (or `src/app/routes.ts`). */
async function isReactRouterFramework(dir: string): Promise<boolean> {
  return await anyExists(dir, [
    "app/routes.ts",
    "app/routes.tsx",
    "app/routes.js",
    "src/app/routes.ts",
  ]);
}

/**
 * React Router v7 framework mode → the `@denext/react-router` plugin. The app's sources stay
 * untouched: migrate writes a `deno.json` whose import map aliases the RR toolchain to the
 * denext runtimes (`@react-router/dev/routes` → the plugin's config DSL, `react-router`/
 * `react-router-dom` → `denext/remix`, `react-router/dom` → the plugin's inert client shim,
 * `@react-router/node`/`serve`/`express`/`cloudflare` → `denext/remix/server`) and a
 * `denext.config.ts` registering `reactRouter()`. The plugin generates the denext wrappers at
 * build/dev time from `app/routes.ts`.
 */
async function migrateReactRouterProject(
  dir: string,
  deps: Record<string, string>,
  options: MigrateOptions,
): Promise<MigrateResult> {
  const { R, imports } = await remixAppBase(dir, deps, options);
  // Classify first (it npm-pins passthrough deps like `react-router`), THEN assert the aliases
  // so they win over any pin — RR's client/router runtime IS denext's.
  const classified = classifyDeps(deps, imports, { dropRemix: true, pin: true });
  Object.assign(imports, R.reactRouterEntries());
  imports["react-router"] = imports["denext/remix"];
  imports["react-router-dom"] = imports["denext/remix"];
  imports["react-router/dom"] = imports["@denext/react-router/dom"];
  // The RR7 config-routing DSL; the `@react-router/*` server adapters → the remix server runtime.
  imports["@react-router/dev/routes"] = imports["@denext/react-router/routes"];
  for (
    const spec of [
      "@react-router/node",
      "@react-router/server-runtime",
      "@react-router/cloudflare",
      "@react-router/architect",
    ]
  ) {
    imports[spec] = imports["denext/remix/server"];
  }

  const written: string[] = [];
  const prismaWiring = await applyPrismaImports(dir, deps, imports, R);
  const denoJsonExists = await writeAppRouterDenoJson(dir, R, imports, prismaWiring, written);

  const configPath = join(dir, "denext.config.ts");
  const hasEffect = "effect" in deps;
  const pluginImports = [`import { reactRouter } from "@denext/react-router";`];
  const pluginCalls = ["reactRouter()"];
  if (hasEffect) {
    pluginImports.push(`import { effect } from "@denext/effect";`);
    pluginCalls.push("effect()");
    Object.assign(imports, R.effectEntry());
  }
  const pagesConfigExists = !(await writeIfWritable(
    configPath,
    () =>
      GEN_MARKER + "\n" + pluginImports.join("\n") + "\n\n" +
      `export default {\n  plugins: [${pluginCalls.join(", ")}],\n};\n`,
    written,
  ));

  const prisma = prismaWiring ? await prismaWiring.finalize() : undefined;
  return {
    kind: "remix",
    wrote: written,
    ...classified,
    pagesRouter: false,
    effect: hasEffect,
    pagesConfigWritten: !pagesConfigExists,
    pagesConfigExists,
    denoJsonExists,
    prisma,
  };
}

/**
 * Migrate the Remix app at `dir`: write the denext config (import map + tasks +
 * gitignore + vscode, reusing the App Router shape — react→denext, `next/*` compat,
 * pinned npm passthrough) AND transform the route tree in place ({@link transformRemixApp}
 * relocates `app/routes/*` to denext conventions, splitting each route into its data
 * module, client component and page wrapper so loaders/actions keep running on the
 * `denext/remix` runtime). Returns a `"remix"` result carrying the assisted-transform
 * report (structural edge cases are surfaced as review warnings, not applied silently).
 */
async function migrateRemixProject(
  dir: string,
  deps: Record<string, string>,
  options: MigrateOptions,
): Promise<MigrateResult> {
  const { R, imports } = await remixAppBase(dir, deps, options);
  // Classify deps like the Next path, additionally dropping Remix's own `@remix-run/*` /
  // react-router toolchain (its route/data model is ported, not run).
  const classified = classifyDeps(deps, imports, { dropRemix: true, pin: true });

  const written: string[] = [];
  // A compat-mode denext.config.ts (no next.config to translate). Never clobber a
  // hand-authored one.
  const pagesConfigExists = !(await writeIfWritable(
    join(dir, "denext.config.ts"),
    () => nextConfigSource({ tailwind: null, publicEnv: [], next: null, effect: false }),
    written,
  ));

  // Prisma: fold the Deno-client/adapter pins into the map (+ links/manual/setup task below).
  const prismaWiring = await applyPrismaImports(dir, deps, imports, R);

  const denoJsonExists = await writeAppRouterDenoJson(
    dir,
    R,
    imports,
    prismaWiring,
    written,
  );

  // The novel part: physically restructure the route tree + invert loaders/actions.
  const remix = await transformRemixApp(dir);
  // Prisma source transform runs after the route tree is in place (so the `@prisma/client`
  // imports in the relocated `*.server.ts` data modules are rewritten too).
  const prisma = prismaWiring ? await prismaWiring.finalize() : undefined;

  return {
    kind: "remix",
    wrote: written,
    ...classified,
    pagesRouter: false,
    effect: false,
    pagesConfigWritten: false,
    pagesConfigExists,
    denoJsonExists,
    remix,
    prisma,
  };
}

// ── Vite SPA migration ──────────────────────────────────────────────────────

/** True for a Vite React SPA: a `vite.config.*`, no `next.config.*`, React in deps. */
async function isViteSpa(
  dir: string,
  deps: Record<string, string>,
): Promise<boolean> {
  const vite = await anyExists(dir, [
    "vite.config.ts",
    "vite.config.js",
    "vite.config.mts",
  ]);
  if (!vite) return false;
  const next = await anyExists(dir, [
    "next.config.ts",
    "next.config.js",
    "next.config.mjs",
  ]);
  if (next) return false;
  return "react" in deps || "react-dom" in deps;
}

/** The SPA-shaped source frameworks that share {@link migrateSpaProject}. */
type SpaSource = "vite" | "cra" | "generic";

/** True for a Create React App: `react-scripts` in deps, or `public/index.html` + React, no vite/next. */
async function isCra(
  dir: string,
  deps: Record<string, string>,
): Promise<boolean> {
  if ("react-scripts" in deps) return true;
  if (!(await exists(join(dir, "public", "index.html")))) return false;
  if (
    await anyExists(dir, [
      "vite.config.ts",
      "vite.config.js",
      "vite.config.mts",
    ])
  ) return false;
  if (await isNext(dir, deps)) return false;
  return "react" in deps || "react-dom" in deps;
}

/** True for a Next.js app: `next` in deps or a `next.config.*` present. */
async function isNext(
  dir: string,
  deps: Record<string, string>,
): Promise<boolean> {
  if ("next" in deps) return true;
  return await anyExists(dir, [
    "next.config.ts",
    "next.config.js",
    "next.config.mjs",
    "next.config.cjs",
  ]);
}

/** True for a generic React SPA: React + a root `index.html`, and not Vite/CRA/Next. */
async function isGenericSpa(
  dir: string,
  deps: Record<string, string>,
): Promise<boolean> {
  if (!("react" in deps || "react-dom" in deps)) return false;
  if (!(await exists(join(dir, "index.html")))) return false;
  if (
    await anyExists(dir, [
      "vite.config.ts",
      "vite.config.js",
      "vite.config.mts",
    ])
  ) return false;
  if (await isCra(dir, deps)) return false;
  if (await isNext(dir, deps)) return false;
  return true;
}

/** Entry + title for a CRA app: title from `public/index.html`, entry `./src/index.*`. */
async function readCraIndex(
  dir: string,
): Promise<{ entry: string; title: string }> {
  const html = await mfs.readTextFile(join(dir, "public", "index.html")).catch(
    () => null,
  );
  let title = "app";
  if (html) {
    const t = html.match(/<title>([^<]*)<\/title>/i);
    // CRA templates often interpolate `%PUBLIC_URL%`/`%REACT_APP_*%` — strip them.
    if (t) {
      const clean = t[1].replace(/%[A-Za-z0-9_]+%/g, "").trim();
      if (clean) title = clean;
    }
  }
  let entry = "./src/index.tsx";
  for (const cand of ["index.tsx", "index.jsx", "index.ts", "index.js"]) {
    if (await exists(join(dir, "src", cand))) {
      entry = "./src/" + cand;
      break;
    }
  }
  return { entry, title };
}

/**
 * `NEXT_PUBLIC_*` env names referenced in the app — recorded in `publicEnv` so the build
 * ships them to the client even when a reference is computed (which the build's static
 * literal scan would miss). Scans `app/`, `src/`, `pages/`, `components/`, `lib/`.
 */
async function collectNextPublicEnvKeys(dir: string): Promise<string[]> {
  const keys = new Set<string>();
  const scan = (text: string) => {
    for (const m of text.matchAll(/NEXT_PUBLIC_[A-Za-z0-9_]+/g)) keys.add(m[0]);
  };
  for (const sub of ["app", "src", "pages", "components", "lib"]) {
    await walkCode(join(dir, sub), scan);
  }
  return [...keys].sort();
}

/** `process.env.REACT_APP_*` names across `src/` — the seed for a CRA app's `spa.env`. */
async function collectCraEnvKeys(dir: string): Promise<string[]> {
  const keys = new Set<string>();
  const scan = (text: string) => {
    for (const m of text.matchAll(/process\.env\.(REACT_APP_[A-Za-z0-9_]+)/g)) {
      keys.add(m[1]);
    }
  };
  await walkCode(join(dir, "src"), scan);
  return [...keys].sort();
}

/** The app's package manager, inferred from its lockfile (searched here + up to 6 parents). */
type PackageManager = "pnpm" | "yarn" | "npm" | "bun";

/** PM detection result. `pnp` = a Yarn Plug'n'Play install (no `node_modules` tree). */
interface PmInfo {
  pm: PackageManager | null;
  pnp: boolean;
}

/**
 * Detect the app's package manager by lockfile, walking up to 6 dirs (monorepo-aware),
 * and whether it is a Yarn PnP install. denext consumes the app's own installed
 * `node_modules`, so the PM choice only affects `nodeModulesDir` and whether the build
 * relies on a prior install — it never changes which PM the consumer runs.
 */
async function detectPackageManager(dir: string): Promise<PmInfo> {
  let cur = dir;
  let pm: PackageManager | null = null;
  let pnp = false;
  for (let i = 0; i < 6; i++) {
    // PnP ships no node_modules — resolution goes through .pnp.cjs, which denext's
    // file-based resolver cannot read. Flag it so migrate can guide the user.
    if (!pnp && await anyExists(cur, [".pnp.cjs", ".pnp.loader.mjs"])) {
      pnp = true;
    }
    if (pm === null) {
      if (await anyExists(cur, ["pnpm-lock.yaml", "pnpm-workspace.yaml"])) {
        pm = "pnpm";
      } else if (await anyExists(cur, ["bun.lockb", "bun.lock"])) pm = "bun";
      else if (await exists(join(cur, "yarn.lock"))) pm = "yarn";
      else if (await exists(join(cur, "package-lock.json"))) pm = "npm";
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return { pm, pnp };
}

/** Message thrown when the app uses Yarn PnP (unsupported — needs a real node_modules). */
function pnpUnsupported(dir: string): Error {
  return new Error(
    `${dir} is a Yarn Plug'n'Play install (.pnp.cjs) — denext resolves the app's ` +
      `node_modules on disk, which PnP does not create.\n` +
      `Fix: add \`nodeLinker: node-modules\` to .yarnrc.yml and re-run \`yarn install\`, ` +
      `then \`denext migrate\` again.`,
  );
}

/**
 * Entry module + title from `index.html`, PLUS the boot content a Vite/CRA app puts there:
 * the `#root` inner markup (a splash/spinner shown before the bundle loads) → `spa.loading`,
 * and the `<head>` content minus charset/title/the entry `<script>` (a theme pre-paint
 * script, boot styles, theme-color/manifest/icon links, a non-default viewport such as
 * `viewport-fit=cover`) → `spa.head`. Carrying
 * these keeps the migrated SPA's instant first paint instead of a blank screen.
 */
async function readIndexHtml(
  dir: string,
): Promise<{ entry: string; title: string; head?: string; loading?: string; rootId?: string }> {
  const html = await mfs.readTextFile(join(dir, "index.html")).catch(() => null);
  if (!html) return { entry: "./src/main.tsx", title: "app" };
  const { entry, title } = parseEntryAndTitle(html);
  const rootId = await mountElementId(dir, entry, html);
  return {
    entry,
    title,
    head: extractBootHead(html) || undefined,
    loading: extractRootInner(html, rootId) || undefined,
    // The shell's default mount element is `#root`; only a different id needs configuring.
    rootId: rootId === "root" ? undefined : rootId,
  };
}

/**
 * The element the app renders into. Vite templates disagree (`#root`, `#app`); the entry
 * module is authoritative (`document.getElementById("app")`), else the first `<div id>` in
 * `<body>`, else `root`. A shell that mounts `#root` for an app rendering into `#app` is a
 * blank page with no error — `createRoot(null)` throws before the first paint.
 */
async function mountElementId(dir: string, entry: string, html: string): Promise<string> {
  const source = await mfs.readTextFile(join(dir, entry)).catch(() => "");
  // The lookup passed to `createRoot`/`hydrateRoot`/`render` first — an entry that removes a
  // `#splash` before mounting `#app` has two lookups and only the mount one counts — then any
  // lookup at all.
  const lookup =
    /(?:getElementById\(\s*["']([^"']+)["']|querySelector\(\s*["']#([A-Za-z_][\w-]*)["'])\s*\)/;
  const fromEntry = source.match(
    new RegExp(`(?:createRoot|hydrateRoot|render)\\(\\s*(?:document\\.)?${lookup.source}`),
  ) ?? source.match(lookup);
  if (fromEntry) return fromEntry[1] ?? fromEntry[2];
  const body = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  return /<div\b[^>]*\bid=["']([^"']+)["']/i.exec(body)?.[1] ?? "root";
}

/** The entry module (`<script type=module src>`, normalized to `./…`) + `<title>`. */
function parseEntryAndTitle(html: string): { entry: string; title: string } {
  const m = html.match(/<script[^>]*type=["']module["'][^>]*src=["']([^"']+)["']/i) ??
    html.match(/<script[^>]*src=["']([^"']+)["'][^>]*type=["']module["']/i);
  const src = m?.[1];
  const entry = !src
    ? "./src/main.tsx"
    : src.startsWith("/")
    ? "." + src
    : src.startsWith(".")
    ? src
    : "./" + src;
  const t = html.match(/<title>([^<]*)<\/title>/i);
  const title = t && t[1].trim() ? t[1].trim() : "app";
  return { entry, title };
}

/** Inner HTML of the mount `<div id="…">…</div>` (balanced-div scan) — the app's boot splash. */
function extractRootInner(html: string, rootId = "root"): string {
  const id = rootId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const open = new RegExp(`<div\\b[^>]*\\bid=["']${id}["'][^>]*>`, "i").exec(html);
  if (!open) return "";
  const start = open.index + open[0].length;
  const tag = /<(\/?)div\b[^>]*>/gi;
  tag.lastIndex = start;
  let depth = 1;
  let m: RegExpExecArray | null;
  while ((m = tag.exec(html)) !== null) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(start, m.index).trim();
  }
  return "";
}

/**
 * `<head>` inner minus the parts denext's shell emits itself (charset/title/entry, and a
 * viewport that asks for nothing beyond the shell's default).
 */
function extractBootHead(html: string): string {
  const hm = /<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(html);
  if (!hm) return "";
  return hm[1]
    .replace(/<meta\b[^>]*charset[^>]*>/gi, "")
    .replace(
      /<meta\b[^>]*name=["']viewport["'][^>]*>/gi,
      (tag) => viewportBeyondDefault(tag) ? tag : "",
    )
    .replace(/<title>[\s\S]*?<\/title>/gi, "")
    .replace(/<script\b[^>]*type=["']module["'][^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Whether a `<meta name="viewport">` asks for more than the SPA shell's default
 * (`width=device-width, initial-scale=1`): `viewport-fit=cover` (iOS safe areas),
 * `interactive-widget`, a zoom lock. Only such a viewport is carried into `spa.head` — the
 * shell then drops its own default — so a stock Vite viewport adds no noise to the config.
 */
function viewportBeyondDefault(tag: string): boolean {
  const content = /\bcontent=["']([^"']*)["']/i.exec(tag)?.[1] ?? "";
  const defaults: Record<string, string> = { width: "device-width", "initial-scale": "1" };
  return content.split(/[,;]/).some((part) => {
    const [rawKey, rawValue = ""] = part.split("=");
    const key = rawKey.trim().toLowerCase();
    if (!key) return false;
    const expected = defaults[key];
    if (expected === undefined) return true;
    const value = rawValue.trim().toLowerCase();
    const numeric = Number(value);
    return Number.isNaN(numeric) ? value !== expected : numeric !== Number(expected);
  });
}

/** `import.meta.env.*` names used across vite.config + `src/` — the seed for `spa.env`. */
async function collectSpaEnvKeys(dir: string): Promise<string[]> {
  const BUILTIN = new Set(["MODE", "DEV", "PROD", "SSR", "BASE_URL"]);
  const keys = new Set<string>();
  const scan = (text: string) => {
    for (
      const m of text.matchAll(/import\.meta\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)
    ) {
      if (!BUILTIN.has(m[1])) keys.add(m[1]);
    }
  };
  for (const f of ["vite.config.ts", "vite.config.js", "vite.config.mts"]) {
    const t = await mfs.readTextFile(join(dir, f)).catch(() => null);
    if (t) scan(t);
  }
  await walkCode(join(dir, "src"), scan);
  return [...keys].sort();
}

/** Recursively feed every code file's text to `scan` (skips node_modules/dist/.denext). */
async function walkCode(
  root: string,
  scan: (text: string) => void,
): Promise<void> {
  // `Deno.readDir` is lazy — a missing/again-unreadable dir throws while iterating, not at
  // the call — so the guard must wrap the whole loop (App Router apps have no `src/`).
  try {
    for await (const e of mfs.readDir(root)) {
      if (e.isDirectory) {
        if (
          e.name === "node_modules" || e.name === "dist" || e.name === ".denext"
        ) continue;
        await walkCode(join(root, e.name), scan);
      } else if (/\.(tsx?|jsx?|mts|mjs)$/.test(e.name)) {
        const t = await mfs.readTextFile(join(root, e.name)).catch(() => null);
        if (t) scan(t);
      }
    }
  } catch {
    // missing dir → nothing to scan
  }
}

/** The top-level `"/prefix":` keys of a literal `proxy: { … }` object (brace-matched). */
function literalProxyKeys(text: string): string[] {
  const m = /\bproxy\s*:\s*\{/.exec(text);
  if (!m) return [];
  let depth = 0;
  let body = "";
  for (let i = m.index + m[0].length - 1; i < text.length; i++) {
    const c = text[i];
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) break;
    // Keep only depth-1 text, so a nested `{ "/x": … }` is not read as a prefix.
    else if (depth === 1) body += c;
  }
  return [...body.matchAll(/["'`](\/[^"'`]+)["'`]\s*:/g)].map((x) => x[1]);
}

/**
 * The vite.config's dev proxy: best-effort prefixes from a *literal* `proxy: { "/api": … }`,
 * else `computed` naming the config file when it HAS a `proxy:` key whose prefixes are built
 * in code (`Object.fromEntries(PREFIXES.map(…))`) and so cannot be read statically.
 */
async function parseViteProxyPrefixes(
  dir: string,
): Promise<{ prefixes?: string[]; computed?: string }> {
  for (const f of ["vite.config.ts", "vite.config.js", "vite.config.mts"]) {
    const t = await mfs.readTextFile(join(dir, f)).catch(() => null);
    if (!t) continue;
    const keys = literalProxyKeys(t);
    if (keys.length) return { prefixes: keys };
    if (/\bproxy\s*:/.test(t)) return { computed: f };
  }
  return {};
}

/**
 * The generated config's `buildEnv` helper: a build-time environment variable (the shell or a
 * `.env` file), "" when unset or when the process may not read it (a desktop runtime with a
 * scoped `--allow-env` imports this config too).
 */
const BUILD_ENV_HELPER =
  `/** A build-time variable (the shell or a .env file), as Vite exposes VITE_*; "" if unset. */\n` +
  `const buildEnv = (key: string): string => {\n` +
  `  try {\n` +
  `    return Deno.env.get(key) ?? "";\n` +
  `  } catch {\n` +
  `    return ""; // no permission to read it\n` +
  `  }\n` +
  `};\n\n`;

/** Source text for the generated `denext.config.ts`. */
function spaConfigSource(o: {
  entry: string;
  title: string;
  envKeys: string[];
  /** The Tailwind input stylesheet (`./`-relative), or null when the app has none. */
  tailwind: string | null;
  proxy?: { prefixes: string[]; target: string };
  desktop?: boolean;
  reactCompiler?: boolean;
  head?: string;
  loading?: string;
  /** The mount element id when it is not the shell's default `root`. */
  rootId?: string;
  /** React Native mode (`reactNative: true`: an Expo / React Native app). */
  reactNative?: boolean;
  /**
   * The React Native desktop packages the app depends on: one becomes
   * `reactNative: { desktopPackage }`; both leave `reactNative: true` with the choice commented.
   */
  desktopPackages?: readonly string[];
  /** Write `spa.precompress: false` (a Capacitor shell never loads `.gz` siblings). */
  noPrecompress?: boolean;
  /** The `mobile` block pinning the app icon migrate found, and the source it came from. */
  mobileIcon?: MobileIconFacts;
  /** `spa.tanstackRouter` (TanStack Router's `autoCodeSplitting`, from vite.config). */
  tanstackRouter?: SpaTanstackRouterConfig;
  /** File-emitting Vite plugins, run through `viteEmitterPlugin`. */
  viteEmitters?: MappedViteEmitter[];
  /** `spa.assetsDir` (a Vite app's `build.assetsDir`). */
  assetsDir?: string;
}): string {
  const needsPkg = o.envKeys.includes("APP_VERSION");
  // Each key reads the build environment (the shell, or a `.env` file the CLI loaded), the
  // way Vite inlines any `VITE_*` set at build time; a literal "" would ignore both.
  const needsBuildEnv = o.envKeys.some((k) => k !== "APP_VERSION");
  const envLines = o.envKeys
    .map((k) =>
      k === "APP_VERSION"
        ? `      APP_VERSION: pkg.version,`
        : `      ${k}: buildEnv(${JSON.stringify(k)}),`
    )
    .join("\n");
  const tailwindBlock = o.tailwind
    ? `  tailwind: { input: ${JSON.stringify(o.tailwind)}, output: ${
      JSON.stringify(tailwindOutputFor(o.tailwind))
    } },\n`
    : "";
  const proxyBlock = o.proxy
    ? `    proxy: {\n      prefixes: [${
      o.proxy.prefixes.map((p) => JSON.stringify(p)).join(", ")
    }],\n      target: ${JSON.stringify(o.proxy.target)},\n    },\n`
    : "";
  return GEN_MARKER + "\n" +
    `import type { DenextConfig } from "denext/server";\n` +
    viteEmitterImports(o.viteEmitters) +
    (needsPkg ? `import pkg from "./package.json" with { type: "json" };\n` : "") +
    `\n` +
    (needsBuildEnv ? BUILD_ENV_HELPER : "") +
    `export default {\n` +
    `  mode: "spa",\n` +
    `  compatibilityMode: true,\n` +
    viteEmitterLines(o.viteEmitters) +
    (o.reactNative ? reactNativeConfigLines(o.desktopPackages ?? []) : "") +
    // The Vite app ran React Compiler (auto-memoization); enable denext's own auto-memo
    // compiler so the migrated SPA keeps that memoization (else components re-render far more).
    (o.reactCompiler ? `  reactCompiler: true,\n` : "") +
    tailwindBlock +
    mobileIconLines(o.mobileIcon) +
    (o.desktop ? desktopConfigLines(desktopAppName(o.title)) : "") +
    `  spa: {\n` +
    `    entry: ${JSON.stringify(o.entry)},\n` +
    `    title: ${JSON.stringify(o.title)},\n` +
    (o.rootId ? `    rootId: ${JSON.stringify(o.rootId)},\n` : "") +
    // Boot content carried from the source index.html so the migrated SPA paints instantly
    // (themed background + splash) instead of a blank screen while the bundle loads.
    (o.head ? `    head: ${JSON.stringify(o.head)},\n` : "") +
    (o.loading ? `    loading: ${JSON.stringify(o.loading)},\n` : "") +
    (o.noPrecompress
      ? `    // The Capacitor shell loads files as they are: no .gz siblings.\n    precompress: false,\n`
      : "") +
    (envLines ? `    env: {\n${envLines}\n    },\n` : "") +
    (o.assetsDir
      ? `    // Vite's build.assetsDir: the client is served from /${o.assetsDir}/ as under Vite.\n` +
        `    assetsDir: ${JSON.stringify(o.assetsDir)},\n`
      : "") +
    tanstackRouterLines(o.tanstackRouter) +
    proxyBlock +
    // Show the desktop-icon override so it's discoverable (commented → auto-detection
    // stays the default). The path can point anywhere; a PNG is composed into the macOS
    // icon template, a value change takes effect on the next `deno task desktop`.
    (o.desktop
      ? `    // desktop: { icon: "./public/apple-touch-icon.png" }, // override the app icon (any PNG path)\n`
      : "") +
    `  },\n` +
    `} satisfies DenextConfig;\n`;
}

/** The generated config's imports for the vite.config's file-emitting plugins. */
function viteEmitterImports(emitters: readonly MappedViteEmitter[] = []): string {
  if (emitters.length === 0) return "";
  return `import { viteEmitterPlugin } from "denext/plugin-kit";\n` +
    emitters.map((e) => `${e.importLine}\n`).join("");
}

/** The generated config's `spa.tanstackRouter` lines (TanStack Router's `autoCodeSplitting`). */
function tanstackRouterLines(tanstackRouter: SpaTanstackRouterConfig | undefined): string {
  if (!tanstackRouter) return "";
  return `    // TanStack Router's autoCodeSplitting (from vite.config): each route's components load\n` +
    `    // as their own chunk.\n    tanstackRouter: ${tsValue(tanstackRouter)},\n`;
}

/** The generated config's `plugins` entry running the vite.config's file-emitting plugins. */
function viteEmitterLines(emitters: readonly MappedViteEmitter[] = []): string {
  if (emitters.length === 0) return "";
  const calls = emitters.map((e) => `    viteEmitterPlugin(${e.call}),\n`).join("");
  return `  // Vite plugins that emit files from generateBundle (from vite.config), run as build steps.\n` +
    `  plugins: [\n${calls}  ],\n`;
}

/** A plain value as TypeScript source: identifier keys unquoted, nested objects inline. */
function tsValue(value: unknown): string {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value).map(([k, v]) =>
      `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}: ${tsValue(v)}`
    );
    return `{ ${entries.join(", ")} }`;
  }
  return JSON.stringify(value);
}

/**
 * The generated config's `mobile` block: the app icon `denext mobile assets` and
 * `denext mobile build` generate from, pinned so a later build does not pick another.
 */
function mobileIconLines(m: MobileIconFacts | undefined): string {
  if (!m) return "";
  const fields = Object.entries(m.config).map(([k, v]) => `    ${k}: ${tsValue(v)},\n`).join("");
  return `  // The app icon \`denext mobile assets\` / \`mobile build\` generate from (found by migrate\n` +
    `  // in ${m.from}); point it at a 1024×1024 PNG for a sharp App Store icon.\n` +
    `  mobile: {\n${fields}  },\n`;
}

/** The `mobile` config block recording an app icon, and the source it came from. */
type MobileIconFacts = { config: Record<string, unknown>; from: string };

/** What {@linkcode migrateAppIcon} found: the report, and the config facts that record it. */
interface MigratedIcon {
  report: AppIconReport;
  /** Spread into the config facts: `mobileIcon` when there is an icon to record. */
  facts: { mobileIcon?: MobileIconFacts };
}

/** No icon to record: the report alone. */
function noIcon(mobile: boolean, lines: string[]): MigratedIcon {
  return { report: { icon: null, kind: null, mobile, recorded: false, lines }, facts: {} };
}

/** The report, saying whether `mobile.icon` landed in a config migrate wrote. */
function appIconInfo(icon: MigratedIcon, configWritten: boolean): AppIconReport {
  return { ...icon.report, recorded: configWritten && icon.facts.mobileIcon !== undefined };
}

/**
 * Find the app icon for the migrated app, and the `mobile` config that records it.
 *
 * @param dir The project.
 * @param mobile The project is a Capacitor / Expo app.
 * @returns The report, and the config block when an icon was found.
 */
async function migrateAppIcon(
  dir: string,
  mobile: boolean,
): Promise<MigratedIcon> {
  let search: IconSearch;
  try {
    search = await resolveIconSource(dir);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return noIcon(mobile, [`icon source: ${message}`]);
  }
  const s = search.source;
  const lines = formatIconSearch(search);
  if (!s) return noIcon(mobile, lines);
  const config = mobileIconConfig(dir, s);
  return {
    report: {
      icon: config.icon as string,
      kind: s.kind,
      size: `${s.width}×${s.height}`,
      mobile,
      recorded: false,
      lines,
    },
    // A `mobile.icon` already in the project's config is not written again.
    facts: s.kind === "config" ? {} : { mobileIcon: { config, from: s.from } },
  };
}

/**
 * The generated config's `desktop` block (a `--desktop` migration). `denoFlags` are the
 * `deno desktop` flags the `desktop` task bakes, so `denext desktop run | dev | package` pass
 * them too: `--node-modules-dir=none` resolves the desktop runtime's npm deps from Deno's cache
 * (a manual or workspace `node_modules` does not carry them, and `deno desktop` would type-check
 * against it and rewrite the root `package.json`); `--exclude-unused-npm` embeds only the npm
 * packages `desktop.ts` reaches. `app.name` names the bundle: `export` copies `desktop.app` into
 * deno.json, where the task's bare `deno desktop` reads the name and the identifier.
 */
function desktopConfigLines(appName: string): string {
  const flags = MIGRATED_DESKTOP_DENO_FLAGS.map((f) => JSON.stringify(f)).join(", ");
  return `  desktop: {\n` +
    `    // \`deno desktop\` flags \`denext desktop run | dev | package\` pass before the entry: npm\n` +
    `    // deps from Deno's cache (not node_modules), and only the npm packages desktop.ts reaches.\n` +
    `    denoFlags: [${flags}],\n` +
    `    // The bundle's name; add \`identifier\` (e.g. "com.example.app") for its bundle id.\n` +
    `    // \`export\` copies this into deno.json, where \`deno task desktop\` reads it.\n` +
    `    app: { name: ${JSON.stringify(appName)} },\n` +
    `  },\n`;
}

/** The `desktop.denoFlags` a `--desktop` migration writes (and its `desktop` task bakes). */
const MIGRATED_DESKTOP_DENO_FLAGS = ["--node-modules-dir=none", "--exclude-unused-npm"];

/**
 * The `reactNative` line(s) of a generated config. A React Native macOS / Windows app imports
 * `react-native` (Metro resolves it to the desktop package), so one desktop package becomes
 * `desktopPackage`, which does the same for the app's source; with both, the choice is left
 * commented (one web build takes one flavor).
 */
function reactNativeConfigLines(desktopPackages: readonly string[]): string {
  if (desktopPackages.length === 1) {
    return `  // The app's \`react-native\` imports resolve as ${
      desktopPackages[0]
    } (as Metro does).\n` +
      `  reactNative: { desktopPackage: ${JSON.stringify(desktopPackages[0])} },\n`;
  }
  if (desktopPackages.length > 1) {
    return `  reactNative: true,\n` +
      `  // Pick the desktop flavor the app's \`react-native\` imports resolve as:\n` +
      desktopPackages.map((p) => `  // reactNative: { desktopPackage: ${JSON.stringify(p)} },\n`)
        .join("");
  }
  return `  reactNative: true,\n`;
}

/** The generated stylesheet beside a Tailwind input: `./src/styles.css` → `./src/styles.gen.css`. */
function tailwindOutputFor(input: string): string {
  return input.replace(/\.css$/, ".gen.css");
}

/**
 * A key the evaluated next.config reported, made safe to write into a `//` comment: the
 * config is untrusted input, so a key carrying a line break (including U+2028 / U+2029,
 * which end a JS line comment too) must not break out of the comment into code.
 */
function commentSafe(key: string): string {
  return JSON.stringify(key).slice(1, -1).replace(
    /[\u2028\u2029]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16)}`,
  );
}

/** A property key for generated source: a bare identifier as is, anything else quoted. */
function propertyKey(key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key);
}

/**
 * Per-key guidance for the dropped next.config keys, so a load-bearing key isn't dropped
 * without a pointer to its denext equivalent. Inert keys (no note) are grouped on one line.
 */
function droppedKeyNotes(dropped: string[]): string[] {
  const notes: string[] = [];
  const inert: string[] = [];
  for (const k of dropped) {
    const note = Object.hasOwn(NEXT_DROP_GUIDANCE, k) ? NEXT_DROP_GUIDANCE[k] : undefined;
    if (note) notes.push(`  // ${commentSafe(k)}: ${note}`);
    else inert.push(commentSafe(k));
  }
  if (inert.length) notes.push(`  // Dropped (no denext equivalent needed): ${inert.join(", ")}.`);
  return notes;
}

/**
 * The honored next.config translation: literal fields inlined into `bodyLines`, the
 * `redirects`/`rewrites`/`headers` rule functions called at migrate time and their RESOLVED
 * arrays inlined (deterministic + self-contained — no import of the app's next.config, which
 * would drag its plugin chain into denext's runtime; env-dependent rules are frozen here),
 * and the hand-port notes returned. An unevaluable config yields only a hand-port note.
 */
function nextConfigTranslationLines(next: NextConfigTranslation, bodyLines: string[]): string[] {
  if (next.raw) {
    return [
      `  // NOTE: your ${next.file} could not be evaluated automatically. Port any`,
      `  // basePath/trailingSlash/assetPrefix/images/i18n/redirects/rewrites/headers by hand.`,
    ];
  }
  const notes: string[] = [];
  for (const [k, v] of Object.entries(next.fields)) {
    bodyLines.push(`  ${propertyKey(k)}: ${JSON.stringify(v)},`);
  }
  const ruleEntries = Object.entries(next.rules);
  if (ruleEntries.length) {
    notes.push(`  // redirects/rewrites/headers inlined from ${next.file} at migrate time.`);
    for (const [fn, arr] of ruleEntries) bodyLines.push(`  ${fn}: () => (${JSON.stringify(arr)}),`);
  }
  if (next.dropped.length) notes.push(...droppedKeyNotes(next.dropped));
  return notes;
}

/**
 * Source text for an App Router app's generated `denext.config.ts`. Carries
 * `compatibilityMode:true`, an optional `tailwind` block, `publicEnv` for statically-seen
 * computed public-env keys, and the honored next.config translation: literal fields inlined,
 * `redirects`/`rewrites`/`headers` re-exported as function refs from the original next.config
 * (preserving dynamic logic), unsupported keys listed in a hand-port comment.
 */
function nextConfigSource(o: {
  /** The Tailwind input stylesheet (project-relative, `./`-prefixed), or null when none. */
  tailwind: string | null;
  publicEnv: string[];
  next: NextConfigTranslation | null;
  /** Wire the `@denext/effect` bridge's `effect()` plugin (app depends on `effect`). */
  effect?: boolean;
  /** The `mobile` block pinning the app icon (a Capacitor target). */
  mobileIcon?: MobileIconFacts;
}): string {
  const bodyLines: string[] = [`  compatibilityMode: true,`];
  const mobile = mobileIconLines(o.mobileIcon);
  if (mobile) bodyLines.push(mobile.replace(/\n$/, ""));

  if (o.tailwind) {
    const output = o.tailwind.replace(/\.css$/, ".gen.css");
    bodyLines.push(
      `  tailwind: { input: ${JSON.stringify(o.tailwind)}, output: ${JSON.stringify(output)} },`,
    );
  }
  if (o.publicEnv.length) {
    bodyLines.push(
      `  publicEnv: [${o.publicEnv.map((k) => JSON.stringify(k)).join(", ")}],`,
    );
  }

  const notes = o.next ? nextConfigTranslationLines(o.next, bodyLines) : [];

  // MDX plugins: `@next/mdx`'s createMDX hides its remark/recma plugin fns in a
  // webpack-loader closure — live function references that can't be serialized into this
  // file. So instead of dropping them (or leaving a hand-port note), recover them at BUILD
  // time: resolveNextMdx runs the app's own next.config with @next/mdx captured and returns
  // the real plugin fns. Deterministic + zero hand-edits — the config stays commit-parity.
  const imports = [`import type { DenextConfig } from "denext/server";`];
  // @denext/effect bridge: register the effect() plugin (empty layer) so the ambient
  // runtime is set up for `runEffect`/`effectHandler`. The user swaps in their AppLayer.
  if (o.effect) {
    imports.push(`import { effect } from "@denext/effect";`);
    bodyLines.push(
      `  // effect(): pass your app Layer to provide services — effect({ layer: AppLayer }).`,
    );
    bodyLines.push(`  plugins: [effect()],`);
  }
  if (o.next?.mdx) {
    imports.push(`import { resolveNextMdx } from "denext/build/next-mdx";`);
    notes.push(
      `  // MDX plugins recovered from ${o.next.file} at build time (createMDX hides them).`,
    );
    bodyLines.push(
      `  mdx: await resolveNextMdx(import.meta.url, ${JSON.stringify("./" + o.next.file)}),`,
    );
  }

  return GEN_MARKER + "\n" +
    imports.join("\n") + "\n\n" +
    `export default {\n` +
    (notes.length ? notes.join("\n") + "\n" : "") +
    bodyLines.join("\n") + "\n" +
    `} satisfies DenextConfig;\n`;
}

/** Source text for the generated `deno desktop` entry (`desktop.ts`). */
function spaDesktopSource(): string {
  // Always read `spa.proxy` from denext.config.ts (harmlessly `undefined` when no
  // proxy is set) so ADDING a backend proxy to the config later just works — no
  // desktop.ts hand-edit or re-migration. `deno desktop` compiles this import in, so
  // the proxy config is baked into the packaged app (which has no config at runtime).
  return GEN_MARKER + "\n" +
    `// Entry for \`deno desktop\` — serves the static export in \`out/\` inside a native\n` +
    `// window (run \`deno task export\` first, or \`deno task desktop\`).\n` +
    `// Backend reverse proxy: set \`spa.proxy\` in denext.config.ts (e.g. to reach a\n` +
    `// local server same-origin so its session cookies persist).\n` +
    `import { resolveDesktopCapabilities, runDesktop } from "denext/desktop";\n` +
    `import config from "./denext.config.ts";\n\n` +
    `await runDesktop({\n` +
    `  importMetaUrl: import.meta.url,\n` +
    `  proxy: config.spa?.proxy,\n` +
    `  // Serve the enabled desktop.capabilities (denext desktop add <cap>); without this spread\n` +
    `  // every bridge call answers \`unavailable\` and \`denext desktop add\` has no runtime effect.\n` +
    `  ...(await resolveDesktopCapabilities(config, { base: import.meta.url })),\n` +
    `});\n`;
}

/**
 * deno.json tasks for a SPA (dev/build/export/start, plus desktop when requested).
 * `hasIcon` wires the desktop task's `--icon` when the app has (or is configured with)
 * an app icon; the icon file itself is composed at build time by `export` — see
 * {@link prepareDesktopIcon} — so `spa.desktop.icon` drives it without re-migration.
 */
/**
 * The desktop bundle name from the SPA title: parentheticals and characters a bundle/Dock
 * name shouldn't carry are dropped (`"T3 Code (Alpha)"` → `"T3 Code"`); falls back to `app`.
 */
export function desktopAppName(title: string): string {
  const name = title.replace(/\([^)]*\)/g, "").replace(/[^A-Za-z0-9 ._-]/g, "").replace(/\s+/g, " ")
    .trim();
  return name || "app";
}

/**
 * How a migrated app's tasks run the denext CLI: outside the app's `node_modules` (see
 * {@link spaTasks}).
 */
const MIGRATED_RUN = "deno run -A --node-modules-dir=none";

function spaTasks(
  desktop: boolean,
  cli: string,
  hasIcon: boolean,
  nodeModulesDir: "manual" | "auto" = "auto",
): Record<string, string> {
  // The CLI PROCESS always runs with `--node-modules-dir=none`, whatever the app's mode:
  // Deno resolves a REMOTE module's npm imports (the JSR-installed CLI's own `esbuild`,
  // `sass`, …) against the nearest config — the app's — and an app
  // `node_modules` carries only the app's deps, so the CLI failed at load ("Could not find a
  // matching package for 'npm:esbuild'"). `none` resolves the CLI's deps from Deno's global
  // cache; the build child the CLI re-execs runs under the merged config (`--config`, which
  // Deno honors verbatim: the app's mode + the framework-deps dir), so the app's own
  // `node_modules` — workspace links included — resolve exactly as before. The flag is also
  // what makes an app inside an npm/pnpm WORKSPACE work: Deno treats the monorepo's root
  // `package.json` (`workspaces`) as the workspace root and IGNORES `nodeModulesDir` in a
  // member `deno.json` ("can only be specified in the workspace root"), so the config value
  // alone would not have applied to the CLI process. It further keeps Deno from "migrating" a
  // pnpm-workspace.yaml into the root package.json on first run.
  void nodeModulesDir;
  const run = MIGRATED_RUN;
  const tasks: Record<string, string> = {
    dev: `${run} ${cli} dev .`,
    build: `${run} ${cli} build .`,
    export: `${run} ${cli} export .`,
    // `-A`: a migrated app's `start` re-execs a child `deno` to apply the CSS shim import map
    // (`maybeReexecForCss`) and, for a manual-`node_modules` app, the merged module config
    // (`maybeReexecForModules`) — so it needs run + write + read + env + net (effectively the
    // full set every denext example's `start` uses). A tighter scope crashes on the re-exec.
    start: `${run} ${cli} start .`,
  };
  if (desktop) {
    // `--node-modules-dir=none` resolves the desktop runtime's npm deps (denext's
    // `ws`, for the proxy's WebSocket bridge) from Deno's global cache rather than the
    // app's `nodeModulesDir:"manual"` tree, which does not carry them.
    //
    // `--exclude-unused-npm` embeds ONLY the npm packages `desktop.ts` actually reaches
    // (denext's runtime + `ws`) instead of the app's entire lockfile snapshot. Without
    // it, a large app's every dependency — React, build tooling, native binaries — is
    // baked into the bundle even though the desktop entry only serves the static `out/`
    // (e.g. a monorepo SPA ballooned to 2.4GB → ~104MB with the flag).
    //
    // `--include out` embeds the static export itself. `desktop.ts` reads `out/` at
    // runtime via dynamic paths (`serveStatic`), so it is NOT in the module graph and
    // would otherwise be left out of the bundle — the packaged app would then serve
    // nothing on another machine.
    //
    // `--icon desktop-icon.png` (when present) is the app icon `export` composes from
    // `spa.desktop.icon` (or an auto-detected web icon) into Apple's macOS template.
    //
    // The permissions are baked into the compiled, distributable app (it runs with none
    // otherwise). `--allow-net` is SCOPED to loopback — `runDesktop` binds `127.0.0.1`
    // and the reverse proxy targets a loopback backend (the `spa.proxy` default; a
    // non-loopback target needs `allowNonLoopback`, and then widening this flag by hand)
    // — so the distributed binary can't reach the wider network. `--allow-read` (serving
    // the embedded `out/`) and `--allow-env` (`PORT` + the app's env) stay broad: a local
    // desktop app legitimately needs them, and narrowing them risks breaking the runtime.
    const iconFlag = hasIcon ? ` --icon ${DESKTOP_ICON_FILE}` : "";
    // No `-o`: `deno desktop` names and identifies the bundle from deno.json `desktop.app`,
    // which `export` fills from `desktop.app` in denext.config.ts (the generated config sets
    // `name` to the title). An `-o` would pin the name and leave a configured one unused.
    //
    // The same two resolution flags are written to the config's `desktop.denoFlags`, which
    // `denext desktop run | dev | package` read; this raw `deno desktop` call reads no config,
    // so it keeps them inline.
    tasks.desktop = `deno task export && deno desktop ` +
      `--allow-net=127.0.0.1,localhost --allow-read --allow-env ` +
      `${MIGRATED_DESKTOP_DENO_FLAGS.join(" ")} --include out${iconFlag} desktop.ts`;
  }
  return tasks;
}

/**
 * Add denext's generated build artifacts to the project's `.gitignore` (creating it if
 * absent; appending only the entries not already present, under a one-line marker).
 * Never reorders or removes the user's existing lines, and is idempotent — a second run
 * adds nothing. Pushes the path to `written` when it changes.
 *
 * @param dir The app directory.
 * @param entries `.gitignore` lines to ensure (e.g. `.denext/`, `out/`).
 * @param written Accumulator the `.gitignore` path is pushed onto when modified.
 */
/** Append `.gitignore` entries (shared, symlink-safe), tracking the path in `written`. */
async function ensureGitignore(
  dir: string,
  entries: string[],
  written: string[],
): Promise<void> {
  const path = await appendGitignore(dir, entries);
  if (path) written.push(path);
}

/**
 * The SPA import map: the denext entries + react-family aliases, the server/client-only
 * stubs, `mdx/types` (MDX apps often import the type-only module at value syntax, so it
 * aliases to an empty module), `denext/desktop`, the tsconfig/jsconfig path aliases
 * (e.g. "~/*": ["./src/*"] → "~/": "./src/", following `extends` + a monorepo-root
 * tsconfig), and — local-path mode only — denext's own deps so `deno desktop` and other
 * tools can resolve the local `file://` denext modules' imports (a no-op for JSR).
 */
async function spaImportMap(
  dir: string,
  deps: Record<string, string>,
  R: DenextResolver,
  desktop: boolean,
): Promise<Record<string, string>> {
  const jsr = R.sub;
  const imports: Record<string, string> = {
    "denext": R.base,
    "denext/jsx-runtime": jsr("jsx-runtime"),
    "denext/jsx-dev-runtime": jsr("jsx-dev-runtime"),
    "denext/server": jsr("server"),
    "denext/client": jsr("client"),
  };
  for (const spec of SPA_REACT_ALIAS_SPECS) imports[spec] = jsr(spec);
  addServerClientStubs(imports, deps, jsr);
  if ("@types/mdx" in deps) imports["mdx/types"] = jsr("empty");
  if (desktop) imports["denext/desktop"] = jsr("desktop");
  for (const [key, val] of await collectTsPathAliases(dir)) {
    if (!(key in imports)) imports[key] = val;
  }
  addMissing(imports, frameworkDepsFor(R, deps));
  return imports;
}

/** The compile-time public env keys for a SPA source (CRA / Vite / the union for generic). */
async function spaEnvKeys(dir: string, source: SpaSource): Promise<string[]> {
  if (source === "cra") return await collectCraEnvKeys(dir);
  if (source === "vite") return await collectSpaEnvKeys(dir);
  return [...new Set([...await collectSpaEnvKeys(dir), ...await collectCraEnvKeys(dir)])].sort();
}

/**
 * The desktop backend proxy (`--desktop --backend`). Only Vite carries a proxy block in
 * its config; CRA/generic rely on `--proxy`, else `/api`.
 */
async function spaProxy(
  dir: string,
  options: MigrateOptions,
  source: SpaSource,
): Promise<{ proxy?: { prefixes: string[]; target: string }; proxyUnresolved?: string }> {
  if (!options.desktop || !options.backend) return {};
  const parsed = source === "vite" ? await parseViteProxyPrefixes(dir) : {};
  const proxy = {
    prefixes: options.proxyPrefixes ?? parsed.prefixes ?? ["/api"],
    target: options.backend,
  };
  // A proxy built in code falls back to `/api`; report it unless --proxy answered it.
  return options.proxyPrefixes || !parsed.computed
    ? { proxy }
    : { proxy, proxyUnresolved: parsed.computed };
}

/** Write `path` from `source()` when absent or previously migrate-generated; true if written. */
async function writeIfWritable(
  path: string,
  source: () => string,
  written: string[],
): Promise<boolean> {
  if (!(await writable(path))) return false;
  await mfs.writeTextFile(path, source());
  written.push(path);
  return true;
}

/**
 * `desktop.ts` (only with --desktop). Also decides whether the desktop task wires `--icon`
 * — the icon file itself is composed by `export` from `spa.desktop.icon` (or an
 * auto-detected web icon), so the icon is config-driven and changeable without re-migrating.
 */
async function writeSpaDesktop(
  dir: string,
  desktop: boolean,
  written: string[],
): Promise<{ desktopWritten: boolean; desktopIcon: string | undefined }> {
  if (!desktop) return { desktopWritten: false, desktopIcon: undefined };
  const desktopWritten = await writeIfWritable(join(dir, "desktop.ts"), spaDesktopSource, written);
  const desktopIcon = (await detectIconSource(dir)) ? DESKTOP_ICON_FILE : undefined;
  return { desktopWritten, desktopIcon };
}

/** The generated SPA `deno.json` (see the Next path for the compilerOptions rationale). */
function spaDenoJson(
  imports: Record<string, string>,
  nodeModulesDir: "manual" | "auto",
  tasks: Record<string, string>,
): Record<string, unknown> {
  return {
    tasks,
    nodeModulesDir,
    minimumDependencyAge: DENEXT_MIN_DEP_AGE,
    unstable: ["sloppy-imports"],
    compilerOptions: {
      jsx: "react-jsx",
      jsxImportSource: "react",
      lib: ["deno.window", "dom", "dom.iterable", "dom.asynciterable"],
      // npm React ships its own types; skip lib-checking so `deno check` validates YOUR
      // code, not the libraries' bundled declarations.
      skipLibCheck: true,
    },
    imports,
  };
}

/**
 * Write the SPA `deno.json` (never clobbering a hand-authored one), ignore denext's
 * generated build artifacts — `.denext/` (build cache), `out/` (the static export),
 * `src/index.gen.css` (the compiled Tailwind output, rebuilt each `dev`/`build`) when
 * Tailwind is used, and for a desktop app the composed `desktop-icon.png` (rebuilt from
 * `spa.desktop.icon` each `export`) — and turn on the Deno LSP so editors resolve the
 * `denext` import map like `deno` does. Returns whether an authored deno.json exists.
 */
async function finishSpaProjectFiles(
  dir: string,
  denoJson: Record<string, unknown>,
  tailwind: string | null,
  desktop: boolean,
  written: string[],
  extraIgnores: readonly string[] = [],
): Promise<boolean> {
  const denoJsonExists = await writeDenoJsonUnlessAuthored(dir, denoJson, written);
  await ensureGitignore(
    dir,
    [
      ".denext/",
      "out/",
      ...(tailwind ? [tailwindOutputFor(tailwind).replace(/^\.\//, "")] : []),
      // `deno task desktop` writes the bundle (`<Name>.app` on macOS) into the project; any
      // name, so renaming `desktop.app.name` needs no new line.
      ...(desktop ? ["desktop-icon.png", "/*.app/"] : []),
      ...extraIgnores,
    ],
    written,
  );
  await ensureVscodeDeno(dir, written);
  return denoJsonExists;
}

/**
 * What the generated SPA config needs to know about the source app. Entry/env/proxy are
 * read per source: CRA from public/index.html + process.env.REACT_APP_*; Vite from
 * index.html + import.meta.env + a literal vite proxy; generic from index.html + the union
 * of both env conventions.
 */
async function spaSourceFacts(
  dir: string,
  deps: Record<string, string>,
  options: MigrateOptions,
  source: SpaSource,
): Promise<{
  entry: string;
  title: string;
  envKeys: string[];
  tailwind: string | null;
  proxy: { prefixes: string[]; target: string } | undefined;
  proxyUnresolved?: string;
  reactCompiler: boolean;
  head?: string;
  loading?: string;
  rootId?: string;
  tanstackRouter?: SpaTanstackRouterConfig;
  viteEmitters: MappedViteEmitter[];
  viteEmitterReview: ViteEmitterFinding[];
  assetsDir?: string;
}> {
  const idx = source === "cra" ? await readCraIndex(dir) : await readIndexHtml(dir);
  const { entry, title } = idx;
  const { head, loading, rootId } = idx as { head?: string; loading?: string; rootId?: string };
  const envKeys = await spaEnvKeys(dir, source);
  const tailwind = ("@tailwindcss/vite" in deps || "tailwindcss" in deps)
    ? await findSpaTailwindInput(dir)
    : null;
  const { proxy, proxyUnresolved } = await spaProxy(dir, options, source);
  const reactCompiler = await spaUsesReactCompiler(dir, source);
  const vite = await viteBuildPluginFacts(dir, source);
  return {
    entry,
    title,
    envKeys,
    tailwind,
    proxy,
    proxyUnresolved,
    reactCompiler,
    head,
    loading,
    rootId,
    tanstackRouter: vite.tanstackRouter,
    viteEmitters: vite.emitters.mapped,
    viteEmitterReview: vite.emitters.review,
    assetsDir: vite.assetsDir,
  };
}

/**
 * The Vite build settings and plugins whose output denext carries over (see
 * migrate-vite-plugins.ts): `build.assetsDir`, TanStack Router's `autoCodeSplitting`, and plugins
 * that emit files from `generateBundle`.
 */
async function viteBuildPluginFacts(
  dir: string,
  source: SpaSource,
): Promise<
  { tanstackRouter?: SpaTanstackRouterConfig; emitters: ViteEmitterFacts; assetsDir?: string }
> {
  const config = source === "vite" ? await readViteConfig(dir) : null;
  // A Vite app builds into `assets/` even with no vite.config.
  const assetsDir = source === "vite" ? viteAssetsDir(config?.text ?? "") : undefined;
  if (!config) return { emitters: { mapped: [], review: [] }, assetsDir };
  return {
    assetsDir,
    tanstackRouter: tanstackRouterFacts(config.text),
    emitters: await viteEmitterFacts(dir),
  };
}

/**
 * Whether the Vite app runs React Compiler (auto-memoization) — the `reactCompilerPreset`
 * (from `@vitejs/plugin-react`) or `babel-plugin-react-compiler`, referenced in a
 * `vite.config.*`. If so, migrate enables denext's own auto-memo compiler
 * (`reactCompiler`), so the migrated SPA keeps the pervasive memoization the app
 * relied on — without it, components that were auto-memoized re-render on every parent render.
 */
async function spaUsesReactCompiler(dir: string, source: SpaSource): Promise<boolean> {
  if (source !== "vite") return false;
  for (const name of ["vite.config.ts", "vite.config.js", "vite.config.mts", "vite.config.mjs"]) {
    try {
      const src = await mfs.readTextFile(join(dir, name));
      if (/react-compiler|reactCompilerPreset|babel-plugin-react-compiler/.test(src)) return true;
    } catch { /* not present — try the next candidate */ }
  }
  return false;
}

/** Generate denext SPA config files (deno.json + denext.config.ts [+ desktop.ts]). */
async function migrateSpaProject(
  dir: string,
  deps: Record<string, string>,
  options: MigrateOptions,
  source: SpaSource,
): Promise<MigrateResult> {
  const V = await denextVersion();
  const R = await denextResolver(V, options.denextLocalPath);
  const { pm, pnp } = await detectPackageManager(dir);
  if (pnp) throw pnpUnsupported(dir);
  // Any real PM install → `manual`: denext resolves deps from the app's own installed
  // node_modules (via the default-on resolver), so no `npm:` entries are pinned and
  // `package.json` is never rewritten. No lockfile → `auto` (Deno materializes deps).
  const manual = pm !== null;

  const imports = await spaImportMap(dir, deps, R, !!options.desktop);

  // Classify deps for the summary. With nodeModulesDir:"manual" (pnpm) the npm deps
  // resolve from the installed node_modules, so no `npm:` import entries are emitted;
  // with "auto" they are pinned as `npm:name@version` like the Next path.
  const classified = classifyDeps(deps, imports, { pin: !manual });

  const facts = await spaSourceFacts(dir, deps, options, source);
  // `viteEmitterPlugin` in the generated config.
  if (facts.viteEmitters.length > 0) imports["denext/plugin-kit"] = R.sub("plugin-kit");
  const cap = options.capacitor
    ? await spaCapacitorPlan(dir, deps, pm, R, options, facts, source)
    : null;
  const icon = await migrateAppIcon(
    dir,
    cap !== null ||
      await anyExists(dir, ["capacitor.config.ts", "capacitor.config.json", "capacitor.config.js"]),
  );

  const nodeModulesDir = manual ? "manual" : "auto";
  const files = await writeSpaProjectFiles(
    dir,
    { ...facts, ...icon.facts, ...(cap ? { noPrecompress: true } : {}) },
    imports,
    nodeModulesDir,
    R,
    { desktop: !!options.desktop, cap },
  );
  const r = spaMigrateResult(source, files.written, classified, files.denoJsonExists, {
    ...facts,
    tailwind: facts.tailwind !== null,
    tailwindInput: facts.tailwind ?? undefined,
    configWritten: files.configWritten,
    desktopWritten: files.desktopWritten,
    desktopIcon: files.desktopIcon,
    appIcon: appIconInfo(icon, files.configWritten),
    nodeModulesDir,
  });
  return files.capacitor ? { ...r, capacitor: files.capacitor } : r;
}

/** The Capacitor target of a SPA: named from its title, reviewed against its env and proxy. */
async function spaCapacitorPlan(
  dir: string,
  deps: Record<string, string>,
  pm: PackageManager | null,
  R: DenextResolver,
  options: MigrateOptions,
  facts: { title: string; envKeys: string[] },
  source: SpaSource,
): Promise<CapacitorPlan> {
  const pkgName = (await readJson(join(dir, "package.json")))?.name;
  return await planCapacitor({
    dir,
    deps,
    pm,
    cli: R.cli,
    run: MIGRATED_RUN,
    appName: desktopAppName(facts.title),
    packageName: typeof pkgName === "string" ? pkgName : undefined,
    kind: "spa",
    envKeys: facts.envKeys,
    devProxy: source === "vite" ? await parseViteProxyPrefixes(dir) : undefined,
    options: capacitorOptionsOf(options),
  });
}

/** Write the SPA project's denext.config.ts, desktop scaffold, deno.json and tailwind bits. */
async function writeSpaProjectFiles(
  dir: string,
  facts: Omit<Parameters<typeof spaConfigSource>[0], "desktop">,
  imports: Record<string, string>,
  nodeModulesDir: "manual" | "auto",
  R: DenextResolver,
  targets: { desktop: boolean; cap: CapacitorPlan | null },
): Promise<{
  written: string[];
  configWritten: boolean;
  desktopWritten: boolean;
  desktopIcon: string | undefined;
  denoJsonExists: boolean;
  capacitor?: CapacitorMigrateInfo;
}> {
  const { desktop, cap } = targets;
  const written: string[] = [];
  const configWritten = await writeIfWritable(
    join(dir, "denext.config.ts"),
    () => spaConfigSource({ ...facts, desktop }),
    written,
  );
  const { desktopWritten, desktopIcon } = await writeSpaDesktop(dir, desktop, written);
  const denoJson = spaDenoJson(
    imports,
    nodeModulesDir,
    { ...spaTasks(desktop, R.cli, !!desktopIcon, nodeModulesDir), ...cap?.tasks },
  );
  const denoJsonExists = await finishSpaProjectFiles(
    dir,
    denoJson,
    facts.tailwind,
    desktop,
    written,
    cap?.ignores,
  );
  const capacitor = await writeCapacitorConfig(dir, cap ?? undefined, written);
  return { written, configWritten, desktopWritten, desktopIcon, denoJsonExists, capacitor };
}

/**
 * The SPA migration report. Vite keeps the historical `"spa"` kind; CRA/generic report
 * themselves. The @denext/effect bridge is server/request-oriented (route handlers, RSC);
 * the SPA path serves a static client bundle with no request context, so it is not
 * auto-wired — an SPA that uses `effect` client-side still gets it via the passthrough pin.
 */
function spaMigrateResult(
  source: SpaSource,
  written: string[],
  classified: ReturnType<typeof classifyDeps>,
  denoJsonExists: boolean,
  spa: NonNullable<MigrateResult["spa"]>,
): MigrateResult {
  return {
    kind: source === "vite" ? "spa" : source,
    wrote: written,
    ...classified,
    pagesRouter: false,
    effect: false,
    pagesConfigWritten: false,
    pagesConfigExists: false,
    denoJsonExists,
    spa,
  };
}

// ── Expo / React Native migration (React Native mode + a Capacitor shell) ─────

/** The React Native desktop packages `reactNative.desktopPackage` can name. */
const RN_DESKTOP_PACKAGES = ["react-native-macos", "react-native-windows"] as const;

/** An Expo app: `expo` is a dependency, with an app config or React Native beside it. */
async function isExpoApp(dir: string, deps: Record<string, string>): Promise<boolean> {
  if (!("expo" in deps)) return false;
  if ("react-native" in deps) return true;
  return await anyExists(dir, ["app.json", "app.config.ts", "app.config.js"]);
}

/**
 * Generate denext files for an Expo / React Native app: `deno.json` (the React family aliased,
 * `nodeModulesDir` as the SPA path sets it, the dev/build/export/start tasks plus the
 * Capacitor `mobile:*` tasks), a `denext.config.ts` in SPA + React Native mode whose entry is
 * the app's own, and a `capacitor.config.ts` from the app config. The app config is read
 * statically (never executed); see expo-migrate.ts for what is carried over.
 */
async function migrateExpoProject(
  dir: string,
  deps: Record<string, string>,
  options: MigrateOptions,
): Promise<MigrateResult> {
  const R = await denextResolver(await denextVersion(), options.denextLocalPath);
  const { pm, pnp } = await detectPackageManager(dir);
  if (pnp) throw pnpUnsupported(dir);
  const manual = pm !== null;
  const pkg = await readJson(join(dir, "package.json")) ?? {};
  const entry = await expoWebEntry(dir, pkg, deps);
  if (!entry) {
    throw new Error(
      `no web entry found in ${dir}: package.json "main" names no file of the app, and there ` +
        "is no App.tsx / App.js for Expo's default entry.",
    );
  }
  const imports = await spaImportMap(dir, deps, R, false);
  const classified = classifyDeps(deps, imports, { pin: !manual });
  const config = await readExpoAppConfig(dir);
  const title = config.name ?? config.slug ?? (typeof pkg.name === "string" ? pkg.name : "App");
  const identity = capacitorIdentity(config, title);
  const desktopPackages = RN_DESKTOP_PACKAGES.filter((p) => p in deps);
  const nodeModulesDir = manual ? "manual" : "auto";
  const written: string[] = [];
  if (entry.generated) {
    await writeIfWritable(
      join(dir, entry.generated.path),
      () => GEN_MARKER + "\n" + entry.generated!.source,
      written,
    );
  }
  const icon = await migrateAppIcon(dir, true);
  const facts = {
    entry: entry.entry,
    title,
    envKeys: [],
    tailwind: null,
    head: expoConfigScript(config.runtimeConfig),
    reactNative: true,
    desktopPackages,
    noPrecompress: true,
    ...icon.facts,
  };
  const configWritten = await writeIfWritable(
    join(dir, "denext.config.ts"),
    () => spaConfigSource(facts),
    written,
  );
  const shell = await writeExpoShell(dir, { deps, pm, R, options, pkg, identity }, written);
  const tasks = {
    ...spaTasks(false, R.cli, false, nodeModulesDir),
    ...capacitorTasks(R.cli, { run: MIGRATED_RUN, installed: pm !== null }),
  };
  const denoJsonExists = await finishSpaProjectFiles(
    dir,
    spaDenoJson(imports, nodeModulesDir, tasks),
    null,
    false,
    written,
    CAPACITOR_BUILD_IGNORES,
  );
  const { tailwindInput, missingPackages } = await expoWebNeeds(dir, deps);
  return {
    capacitor: shell.capacitor,
    kind: "expo",
    wrote: written,
    ...classified,
    pagesRouter: false,
    effect: false,
    pagesConfigWritten: false,
    pagesConfigExists: false,
    denoJsonExists,
    spa: {
      entry: entry.entry,
      title,
      envKeys: [],
      tailwind: false,
      configWritten,
      desktopWritten: false,
      appIcon: appIconInfo(icon, configWritten),
      nodeModulesDir,
    },
    expo: {
      config: { source: config.source, unresolved: config.unresolved, notes: config.notes },
      generatedEntry: entry.generated &&
        { path: entry.generated.path, kind: entry.generated.kind },
      expoRouter: entry.expoRouter,
      capacitor: shell.expo,
      mobile: expoMobilePlan(deps, config, await expoApiUsage(dir)),
      // Runtime dependencies only: the dev toolchain never reaches the bundle.
      deps: await expoDependencyReport(
        dir,
        (pkg.dependencies ?? {}) as Record<string, string>,
      ),
      prebuildFolders: await prebuildFolders(dir),
      tailwindInput,
      missingPackages,
      metro: await readMetroResolution(dir, deps),
      desktopPackages,
    },
  };
}

/**
 * The Expo app's Tailwind input (uniwind / NativeWind keep it at the root as global.css), and
 * the npm packages its web build needs that it has not installed.
 */
async function expoWebNeeds(
  dir: string,
  deps: Record<string, string>,
): Promise<{ tailwindInput?: string; missingPackages: string[] }> {
  const tailwindInput = "tailwindcss" in deps
    ? await findTailwindInput(dir, ["global.css", "app/global.css"]) ??
      await findSpaTailwindInput(dir)
    : null;
  const missingPackages = [
    ...(await findReactNativeWeb(dir) ? [] : ["react-native-web"]),
    ...("expo-sqlite" in deps && !(await findSqliteWasm(dir)) ? ["@sqlite.org/sqlite-wasm"] : []),
  ];
  return { tailwindInput: tailwindInput ?? undefined, missingPackages };
}

/**
 * The Expo app's Capacitor shell: `capacitor.config.ts` from the app config, or with
 * `--enable-capacitor` the planned target (`--app-id` winning, and the steps to run).
 */
async function writeExpoShell(
  dir: string,
  app: {
    deps: Record<string, string>;
    pm: PackageManager | null;
    R: DenextResolver;
    options: MigrateOptions;
    pkg: Record<string, unknown>;
    identity: { appId: string; appName: string; placeholderId: boolean };
  },
  written: string[],
): Promise<{ expo: ExpoMigrateInfo["capacitor"]; capacitor?: CapacitorMigrateInfo }> {
  const { identity } = app;
  if (!app.options.capacitor) {
    const configWritten = await writeIfWritable(
      join(dir, "capacitor.config.ts"),
      () => capacitorConfigSource(GEN_MARKER, identity),
      written,
    );
    return { expo: { ...identity, configWritten } };
  }
  const plan = await planCapacitor({
    dir,
    deps: app.deps,
    pm: app.pm,
    cli: app.R.cli,
    run: MIGRATED_RUN,
    appName: identity.appName,
    packageName: typeof app.pkg.name === "string" ? app.pkg.name : undefined,
    kind: "expo",
    appConfigId: { appId: identity.appId, placeholder: identity.placeholderId },
    options: capacitorOptionsOf(app.options),
  });
  const capacitor = (await writeCapacitorConfig(dir, plan, written))!;
  const { appId, appName, placeholderId, configWritten } = capacitor;
  return { expo: { appId, appName, placeholderId, configWritten }, capacitor };
}
