// Resolve the conventional paths and config for a denext project directory.

import { join, toFileUrl } from "@std/path";
import { frameworkRoot } from "./bundle.ts";
import type { I18nConfig } from "../server/i18n.ts";
import type { DenextConfig } from "../server/config.ts";

export interface ProjectPaths {
  projectDir: string;
  appDir: string;
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
  const configPath = (await exists(projectConfig))
    ? projectConfig
    : join(frameworkRoot(), "deno.json");

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

/** Load `denext.config.{ts,js}` (named exports or a default object), if present. */
async function loadDenextConfig(projectDir: string): Promise<DenextConfig | null> {
  for (const name of ["denext.config.ts", "denext.config.js"]) {
    const p = join(projectDir, name);
    if (!(await exists(p))) continue;
    try {
      const mod = await import(toFileUrl(p).href) as
        & DenextConfig
        & { default?: DenextConfig };
      const base = mod.default ?? {};
      // Named exports take precedence over fields on a default-export object.
      const config: DenextConfig = {
        i18n: mod.i18n ?? base.i18n,
        basePath: mod.basePath ?? base.basePath,
        trailingSlash: mod.trailingSlash ?? base.trailingSlash,
        assetPrefix: mod.assetPrefix ?? base.assetPrefix,
        redirects: mod.redirects ?? base.redirects,
        rewrites: mod.rewrites ?? base.rewrites,
        headers: mod.headers ?? base.headers,
        images: mod.images ?? base.images,
        tailwind: mod.tailwind ?? base.tailwind,
        experimental: mod.experimental ?? base.experimental,
      };
      // Validate up front so a malformed field (e.g. `basePath: "docs"`) fails with
      // a clear, field-scoped message at boot rather than misbehaving at request time.
      validateDenextConfig(config, name);
      return config;
    } catch (err) {
      // The config file exists but failed to load. Fail fast rather than boot
      // silently without its basePath/redirects/security headers.
      throw new Error(
        `denext: failed to load ${name}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }
  return null;
}

/** Validate a loaded `denext.config`, throwing a field-scoped error on a bad value. */
export function validateDenextConfig(config: DenextConfig, name = "denext.config"): void {
  const fail = (field: string, msg: string): never => {
    throw new Error(`invalid ${name}: \`${field}\` ${msg}`);
  };
  const { basePath, assetPrefix, trailingSlash, redirects, rewrites, headers, images } = config;

  if (basePath !== undefined) {
    if (typeof basePath !== "string") fail("basePath", "must be a string");
    else if (basePath !== "" && (!basePath.startsWith("/") || basePath.endsWith("/"))) {
      fail("basePath", 'must start with "/" and not end with "/" (e.g. "/docs")');
    }
  }
  if (assetPrefix !== undefined && typeof assetPrefix !== "string") {
    fail("assetPrefix", "must be a string");
  }
  if (trailingSlash !== undefined && typeof trailingSlash !== "boolean") {
    fail("trailingSlash", "must be a boolean");
  }
  // redirects/rewrites/headers are functions that return the rule array at startup.
  for (
    const [field, v] of [
      ["redirects", redirects],
      ["rewrites", rewrites],
      ["headers", headers],
    ] as const
  ) {
    if (v !== undefined && typeof v !== "function") {
      fail(field, "must be a function returning an array (e.g. `redirects: () => [...]`)");
    }
  }
  if (images?.domains !== undefined) {
    if (!Array.isArray(images.domains) || images.domains.some((d) => typeof d !== "string")) {
      fail("images.domains", "must be an array of host strings");
    }
  }
  if (images?.remotePatterns !== undefined) {
    if (!Array.isArray(images.remotePatterns)) {
      fail("images.remotePatterns", "must be an array");
    } else {
      for (const p of images.remotePatterns) {
        if (!p || typeof p.hostname !== "string" || p.hostname === "") {
          fail("images.remotePatterns", "each entry needs a non-empty `hostname` string");
        }
      }
    }
  }
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
