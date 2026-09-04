// Resolve the conventional paths and config for a denext project directory.

import { join, toFileUrl } from "@std/path";
import { frameworkFileUrl } from "./bundle.ts";
import type { I18nConfig } from "../server/i18n.ts";
import type { DenextConfig } from "../server/config.ts";
import { validateDenextConfig, warnUnknownConfigKeys } from "../server/config-validate.ts";

// Re-export so build-side importers keep resolving the validator from `paths.ts`.
export { validateDenextConfig };

/** The conventional directories, config, and root modules resolved for a denext project. */
export interface ProjectPaths {
  /** The project root directory. */
  projectDir: string;
  /** The App Router directory (`app/` or `src/app/`). */
  appDir: string;
  /** The static assets directory (`public/`). */
  publicDir: string;
  /** deno.json used for bundling (project's own, else the framework's). */
  configPath: string;
  /** Build output directory. */
  outDir: string;
  /** Root middleware module path (middleware.ts / proxy.ts), or null. */
  middlewarePath: string | null;
  /** Root instrumentation module path (instrumentation.{ts,js}), or null. */
  instrumentationPath: string | null;
  /** i18n config from `denext.config.{ts,js}`, or null when absent. */
  i18n: I18nConfig | null;
  /** Full `denext.config.{ts,js}` export, or null when absent. */
  config: DenextConfig | null;
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function resolveProject(projectDir: string): Promise<ProjectPaths> {
  // Optional `src/` layout (Next.js parity): when `src/app` exists, the app,
  // middleware, and instrumentation live under `src/` — while `public/`,
  // `deno.json`/`denext.config`, and `.denext` stay at the project root. `src/app`
  // wins if a top-level `app/` also exists.
  const srcBase = (await exists(join(projectDir, "src", "app")))
    ? join(projectDir, "src")
    : projectDir;

  const appDir = join(srcBase, "app");
  const publicDir = join(projectDir, "public");

  const projectConfig = join(projectDir, "deno.json");
  // Fall back to the framework's own deno.json when the project has none. frameworkFileUrl
  // handles both a local checkout (file://) and a remote (JSR) framework — `join` would
  // corrupt a URL.
  const configPath = (await exists(projectConfig)) ? projectConfig : frameworkFileUrl("deno.json");

  // middleware.ts is the canonical name; proxy.ts is an accepted alias.
  const candidates = ["middleware.ts", "middleware.js", "proxy.ts", "proxy.js"];
  let middlewarePath: string | null = null;
  for (const name of candidates) {
    const p = join(srcBase, name);
    if (await exists(p)) {
      middlewarePath = p;
      break;
    }
  }

  let instrumentationPath: string | null = null;
  for (const name of ["instrumentation.ts", "instrumentation.js"]) {
    const p = join(srcBase, name);
    if (await exists(p)) {
      instrumentationPath = p;
      break;
    }
  }

  const config = await loadDenextConfig(projectDir);

  return {
    projectDir,
    appDir,
    publicDir,
    configPath,
    outDir: join(projectDir, ".denext"),
    middlewarePath,
    instrumentationPath,
    i18n: config?.i18n ?? null,
    config,
  };
}

/** Every `DenextConfig` field a config module may export (named export or default-object key). */
const CONFIG_KEYS = [
  "mode",
  "spa",
  "i18n",
  "basePath",
  "trailingSlash",
  "assetPrefix",
  "redirects",
  "rewrites",
  "headers",
  "images",
  "tailwind",
  "mdx",
  "cache",
  "streaming",
  "live",
  "experimental",
  "plugins",
  "csp",
  "hsts",
  "publicEnv",
  "compatibilityMode",
  "classComponents",
] as const satisfies readonly (keyof DenextConfig)[];

type ConfigModule = DenextConfig & { default?: DenextConfig };

/**
 * Merge a config module's named exports over its default-export object (named exports
 * take precedence). `??` (not `||`) so an explicit `false` (e.g. `streaming`) survives.
 */
function mergeConfigModule(mod: ConfigModule): DenextConfig {
  const base = mod.default ?? {};
  const config: Record<string, unknown> = {};
  for (const key of CONFIG_KEYS) config[key] = mod[key] ?? base[key];
  return config as DenextConfig;
}

/**
 * Import one config file. Unknown keys on a plain `export default {…}` object are warned
 * (the field whitelist silently drops them otherwise; `defineConfig` warns at its call
 * site), and the result is validated up front so a malformed field (e.g. `basePath:
 * "docs"`) fails with a clear, field-scoped message at boot rather than misbehaving at
 * request time. A config that exists but fails to load throws — booting silently
 * without its basePath/redirects/security headers would be worse.
 */
async function importConfigFile(path: string, name: string): Promise<DenextConfig> {
  try {
    const mod = await import(toFileUrl(path).href) as ConfigModule;
    const config = mergeConfigModule(mod);
    const base = mod.default;
    if (base && typeof base === "object") warnUnknownConfigKeys(base, name);
    validateDenextConfig(config, name);
    return config;
  } catch (err) {
    throw new Error(
      `denext: failed to load ${name}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

/** Load `denext.config.{ts,js}` (named exports or a default object), if present. */
async function loadDenextConfig(projectDir: string): Promise<DenextConfig | null> {
  for (const name of ["denext.config.ts", "denext.config.js"]) {
    const p = join(projectDir, name);
    if (await exists(p)) return await importConfigFile(p, name);
  }
  return null;
}

/** Stable per-route id used in client bundle URLs and filenames. */
export function routeId(routePath: string): string {
  if (routePath === "/") return "index";
  return routePath
    .slice(1)
    .replace(/\//g, "__")
    .replace(/\[\[?\.\.\./g, "catchall_")
    .replace(/[\[\]]/g, "_");
}
