// `denext migrate` for a Preact app — a Vite app on `@preact/preset-vite` (create-preact),
// a preact-cli app, or a WMR / esbuild one. It takes the Vite SPA path (`mode: "spa"`) with the
// shared Preact layer (`preact-layer.ts`): Preact, its hooks / compat / JSX runtime and Preact
// Signals point at denext, in the import map and — for npm packages that import them — through
// `resolveAlias`. preact-iso maps to `denext/preact-iso`, which implements its router on denext;
// preact-router and wouter-preact keep running as they are, on the aliases, and are reported.

import { join } from "@std/path";
import { anyExists, exists } from "./migrate-fs.ts";
import { mfs } from "@denext/denext/internal/migrate-host";
import { readViteConfig, withoutComments } from "./migrate-vite-plugins.ts";
import {
  PREACT_ALIASES,
  PREACT_SOURCE_RULES,
  type PreactFinding,
  scanSourceRules,
} from "./preact-layer.ts";

/** How the Preact app was built. */
export type PreactTooling = "vite" | "preact-cli" | "wmr" | "esbuild";

/** What `denext migrate` found in a Preact app. */
export interface PreactMigrateInfo {
  /** How it was built. */
  tooling: PreactTooling;
  /** The router packages it uses (`preact-iso`, `preact-router`, `wouter-preact`). */
  routers: string[];
  /** What does not migrate, and why. */
  wontMigrate: PreactFinding[];
  /** What migrates but needs a look. */
  review: PreactFinding[];
}

/** The router packages a Preact app may use. */
const ROUTERS = ["preact-iso", "preact-router", "wouter-preact"] as const;

/** The preact-iso entry points denext implements (`denext/preact-iso`). */
const PREACT_ISO_SPECIFIERS = [
  "preact-iso",
  "preact-iso/router",
  "preact-iso/lazy",
  "preact-iso/prerender",
  "preact-iso/hydrate",
];

/** A `vite.config` that runs `@preact/preset-vite`. */
async function presetVite(dir: string): Promise<boolean> {
  const vite = await readViteConfig(dir);
  return vite !== null && /["']@preact\/preset-vite["']/.test(withoutComments(vite.text));
}

/** A config file (tsconfig / jsconfig / an esbuild script) compiling JSX for Preact. */
async function preactJsxConfig(dir: string): Promise<boolean> {
  for (
    const name of [
      "tsconfig.json",
      "jsconfig.json",
      "esbuild.config.js",
      "esbuild.config.mjs",
      "build.js",
      "build.mjs",
    ]
  ) {
    const text = await mfs.readTextFile(join(dir, name)).catch(() => "");
    if (/jsxImportSource["']?\s*:\s*["']preact["']|jsxFactory["']?\s*:\s*["']h["']/.test(text)) {
      return true;
    }
  }
  return false;
}

/**
 * How a Preact app is built, or null when `dir` is not one: `preact` in its dependencies plus
 * Vite's `@preact/preset-vite`, preact-cli, WMR, or esbuild compiling JSX for Preact.
 *
 * @param dir The app directory.
 * @param deps Its dependencies (name → version spec).
 * @returns The tooling, or null.
 */
export async function preactTooling(
  dir: string,
  deps: Record<string, string>,
): Promise<PreactTooling | null> {
  if (!("preact" in deps)) return null;
  if ("@preact/preset-vite" in deps || await presetVite(dir)) return "vite";
  if ("preact-cli" in deps) return "preact-cli";
  if ("wmr" in deps) return "wmr";
  if ("esbuild" in deps && await preactJsxConfig(dir)) return "esbuild";
  return null;
}

/**
 * The import-map entries a Preact app gets on top of the shared Preact layer: preact-iso's entry
 * points → `denext/preact-iso`, and Preact's debug add-ons → an empty module.
 *
 * @param sub Resolves a `denext/<sub>` entry (`R.sub`).
 * @param deps The app's dependencies.
 * @returns The entries.
 */
export function preactRouterImports(
  sub: (s: string) => string,
  deps: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {
    "denext/preact-iso": sub("preact-iso"),
    "preact/debug": sub("empty"),
    "preact/devtools": sub("empty"),
  };
  if ("preact-iso" in deps) { for (const s of PREACT_ISO_SPECIFIERS) out[s] = sub("preact-iso"); }
  return out;
}

/**
 * The `resolveAlias` entries for the generated config: an npm package that imports Preact (a
 * router, a component library) gets denext's, not its own copy.
 *
 * @param deps The app's dependencies.
 * @returns Specifier → `denext/*` target.
 */
export function preactResolveAlias(deps: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [spec, target] of Object.entries(PREACT_ALIASES)) out[spec] = `denext/${target}`;
  if ("preact-iso" in deps) { for (const s of PREACT_ISO_SPECIFIERS) out[s] = "denext/preact-iso"; }
  return out;
}

/** Source files under `src/` (and the root), skipping installed and built trees. */
async function sourceFiles(dir: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  const entries: Deno.DirEntry[] = [];
  try {
    for await (const e of mfs.readDir(rel ? join(dir, rel) : dir)) entries.push(e);
  } catch {
    return out;
  }
  for (const e of entries) {
    const path = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory && !/^(node_modules|dist|build|\.git|\.denext|public)$/.test(e.name)) {
      out.push(...await sourceFiles(dir, path));
    } else if (e.isFile && /\.[jt]sx?$/.test(e.name)) out.push(path);
  }
  return out.sort();
}

/** What the build tooling leaves behind. */
async function toolingFindings(dir: string, tooling: PreactTooling): Promise<PreactFinding[]> {
  const out: PreactFinding[] = [];
  const vite = await readViteConfig(dir);
  if (vite && /\bprerender\s*:\s*\{[^}]*enabled\s*:\s*true/.test(withoutComments(vite.text))) {
    out.push({
      item: `${vite.name}: preact({ prerender })`,
      reason: "denext's SPA mode does not prerender pages; the app renders in the browser. " +
        "For HTML at build time, move the pages to denext's App Router and `denext export`",
    });
  }
  if (tooling === "preact-cli" && await anyExists(dir, ["preact.config.js", "preact.config.cjs"])) {
    out.push({
      item: "preact.config.js",
      reason:
        "preact-cli's webpack configuration is not run; port what it adds to denext.config.ts",
    });
  }
  if (tooling === "wmr" && await exists(join(dir, "wmr.config.mjs"))) {
    out.push({
      item: "wmr.config.mjs",
      reason: "WMR plugins are not run; port them to denext.config.ts",
    });
  }
  return out;
}

/**
 * What a Preact app leaves to the user: router packages that keep running on the aliases, the
 * tooling's own configuration, and the Preact patterns denext does not run (`useErrorBoundary`,
 * `options` hooks, …).
 *
 * @param dir The app directory.
 * @param deps Its dependencies.
 * @param tooling How it was built.
 * @returns The findings.
 */
export async function preactMigrateInfo(
  dir: string,
  deps: Record<string, string>,
  tooling: PreactTooling,
): Promise<PreactMigrateInfo> {
  const routers = ROUTERS.filter((r) => r in deps);
  const review: PreactFinding[] = routers.filter((r) => r !== "preact-iso").map((r) => ({
    item: r,
    reason: "keeps running as it is, on the denext/preact aliases (resolveAlias): its links and " +
      "route() navigate on the client as before; check the navigation and redirects",
  }));
  const tool = await toolingFindings(dir, tooling);
  const scan = await scanSourceRules(dir, await sourceFiles(dir), PREACT_SOURCE_RULES);
  return {
    tooling,
    routers,
    wontMigrate: [...(tooling === "preact-cli" ? tool : []), ...scan.wont],
    review: [...review, ...(tooling === "preact-cli" ? [] : tool), ...scan.review],
  };
}
