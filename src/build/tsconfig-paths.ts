// tsconfig / jsconfig `compilerOptions.paths`: read the way TypeScript does (the nearest config
// that declares them, following relative `extends`, and in a monorepo a parent directory's root
// config), and turned into import-map style aliases. `denext migrate` writes them into the
// import map; the resolvers that pick platform files (./platform-extensions.ts, the esbuild app
// resolver) follow them after the import map's own entries, so an import through a `paths`
// alias takes the target's variant as an import-map alias does.

import { parse as parseJsonc } from "@std/jsonc";
import { dirname, join, resolve } from "@std/path";

/** A config's `paths` and the absolute directory they resolve against. */
export interface TsPaths {
  /** `compilerOptions.paths` as written (`{ "@/*": ["./src/*"] }`). */
  readonly paths: Record<string, string[]>;
  /** The defining file's directory joined with its `baseUrl`. */
  readonly baseDir: string;
}

/** Reads a text file; rejects when it is missing. */
export type ReadText = (path: string) => Promise<string>;

/** The config file names probed in each directory, in order. */
const CONFIG_NAMES = ["tsconfig.json", "jsconfig.json"];

/** How many parent directories the search climbs (a monorepo's root tsconfig). */
const MAX_DEPTH = 6;

/** A JSONC config (comments and trailing commas), or null when missing or unparseable. */
async function readConfig(path: string, read: ReadText): Promise<Record<string, unknown> | null> {
  try {
    const value = parseJsonc(await read(path));
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

/**
 * The `paths` of `file`, or of the first file its relative `extends` chain names that declares
 * them (a package-name `extends`, `@tsconfig/*`, is not followed).
 */
async function pathsOfChain(
  file: string,
  read: ReadText,
  seen = new Set<string>(),
): Promise<TsPaths | null> {
  if (seen.has(file)) return null;
  seen.add(file);
  const cfg = await readConfig(file, read);
  if (!cfg) return null;
  const co = cfg.compilerOptions as { paths?: unknown; baseUrl?: unknown } | undefined;
  if (co?.paths && typeof co.paths === "object" && Object.keys(co.paths).length > 0) {
    const baseUrl = typeof co.baseUrl === "string" ? co.baseUrl : ".";
    return {
      paths: co.paths as Record<string, string[]>,
      baseDir: resolve(dirname(file), baseUrl),
    };
  }
  if (typeof cfg.extends === "string" && cfg.extends.startsWith(".")) {
    const ext = resolve(dirname(file), cfg.extends);
    return await pathsOfChain(ext.endsWith(".json") ? ext : ext + ".json", read, seen);
  }
  return null;
}

/**
 * The effective `compilerOptions.paths` for the project at `dir`: its tsconfig / jsconfig,
 * following `extends`, and — when neither it nor its chain declares any — the nearest parent
 * directory's config that does (monorepos often keep `paths` in a root tsconfig the app's own
 * does not extend). Null when there are none.
 *
 * @param dir The project directory.
 * @param read Reads a file (default `Deno.readTextFile`; `denext migrate` passes its own).
 */
export async function resolveTsPaths(
  dir: string,
  read: ReadText = (p) => Deno.readTextFile(p),
): Promise<TsPaths | null> {
  let cur = resolve(dir);
  for (let i = 0; i < MAX_DEPTH; i++) {
    for (const name of CONFIG_NAMES) {
      const found = await pathsOfChain(join(cur, name), read);
      if (found) return found;
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

/**
 * `paths` as import-map style aliases, each `[key, absolute target]`: a `"@x/*"` pattern is the
 * prefix key `"@x/"` (its target ends in the path separator's `/`), a pattern with no `*` an
 * exact key. Only a pattern's first target is used, and a pattern with a `*` anywhere but a
 * trailing `/*` (which an import map cannot express) is skipped.
 *
 * @param resolved {@linkcode resolveTsPaths}.
 */
export function tsPathAliases(resolved: TsPaths): Array<[key: string, target: string]> {
  const out: Array<[string, string]> = [];
  for (const [pattern, targets] of Object.entries(resolved.paths)) {
    const first = Array.isArray(targets) ? targets[0] : undefined;
    if (typeof first !== "string") continue;
    const prefix = pattern.endsWith("/*");
    const key = prefix ? pattern.slice(0, -1) : pattern;
    const target = prefix && first.endsWith("/*") ? first.slice(0, -2) : first;
    if (key.includes("*") || target.includes("*")) continue;
    const abs = resolve(resolved.baseDir, target);
    out.push([key, prefix ? abs.replace(/[\\/]*$/, "/") : abs]);
  }
  return out;
}

/**
 * The project's tsconfig `paths` aliases ({@linkcode tsPathAliases}), empty when it has none.
 *
 * @param projectDir The project root.
 */
export async function readTsPathAliases(projectDir: string): Promise<Array<[string, string]>> {
  const resolved = await resolveTsPaths(projectDir);
  return resolved ? tsPathAliases(resolved) : [];
}
