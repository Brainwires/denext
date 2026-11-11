// Find the project module that exports a value `denext.config.*` imported — so a schema OBJECT
// passed to `graphql({ schema })` can be re-imported from its module after an edit under
// `denext dev`, as the module-path form is. Internal to `mod.ts`.
//
// The walk starts at the config file and follows its static RELATIVE imports (`./`, `../`),
// breadth-first, inside the project. Each module is imported by its plain `file:` URL — the URL
// the config's own relative import resolved to — so the module comes from Deno's cache and is
// never evaluated a second time; its exports are compared to the value by identity.

import {
  dirname,
  fromFileUrl,
  isAbsolute,
  join,
  relative,
  resolve,
  SEPARATOR,
  toFileUrl,
} from "@std/path";

/** A value's exporting module and export name. */
export interface TracedExport {
  /** The module's absolute path. */
  file: string;
  /** The export holding the value. */
  name: string;
}

/** The config file names, in the loader's order (`src/build/config-files.ts`). */
const CONFIG_FILES = [
  "denext.config.ts",
  "denext.config.mts",
  "denext.config.js",
  "denext.config.mjs",
];

/** The script and SDL files a schema's directory holds (a watch glob's last segment). */
export const SCHEMA_FILES = "*.{ts,tsx,js,jsx,mts,mjs,graphql,gql}";

/** How long `deno info` may take to list the config's module graph. */
const INFO_TIMEOUT_MS = 60_000;

/** The most modules one trace imports. */
const MAX_MODULES = 200;

/**
 * Static relative import / re-export statements in a module's source (group 1: `type`, so a
 * type-only one — never evaluated at runtime — is skipped; group 2: the specifier).
 */
const IMPORT = /\b(?:import|export)\s+(type\s+)?(?:[^"';]*?\bfrom\s*)?["'](\.{1,2}\/[^"'\n]+)["']/g;

/** The existing config file of the project, if any. */
export async function configFileOf(projectRoot: string): Promise<string | null> {
  for (const name of CONFIG_FILES) {
    const file = join(projectRoot, name);
    if (await isFile(file)) return file;
  }
  return null;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch {
    return false;
  }
}

/** The project files `file` imports relatively (static imports only). */
async function relativeImports(file: string, projectRoot: string): Promise<string[]> {
  let source: string;
  try {
    source = await Deno.readTextFile(file);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const match of source.matchAll(IMPORT)) {
    if (match[1]) continue;
    const target = resolve(dirname(file), match[2]);
    if (target.startsWith(projectRoot) && await isFile(target)) out.push(target);
  }
  return out;
}

/** The export of `mod` that is `value`, if any. */
function exportNameOf(mod: Record<string, unknown>, value: unknown): string | null {
  for (const [name, exported] of Object.entries(mod)) if (exported === value) return name;
  return null;
}

/**
 * The project module (other than the config itself) that exports `value`, reached from
 * `denext.config.*` through static relative imports; `null` when none does.
 *
 * @param value The object (or function) to find.
 * @param projectRoot The project root (where the config lives).
 * @returns The module and export name.
 */
export async function traceExport(
  value: unknown,
  projectRoot: string,
): Promise<TracedExport | null> {
  const root = isAbsolute(projectRoot) ? projectRoot : resolve(projectRoot);
  const config = await configFileOf(root);
  if (!config) return null;
  const seen = new Set([config]);
  const queue = await relativeImports(config, root);
  for (let i = 0; i < queue.length && seen.size <= MAX_MODULES; i++) {
    const file = queue[i];
    if (seen.has(file)) continue;
    seen.add(file);
    let mod: Record<string, unknown>;
    try {
      mod = await import(toFileUrl(file).href);
    } catch {
      continue;
    }
    const name = exportNameOf(mod, value);
    if (name) return { file, name };
    queue.push(...await relativeImports(file, root));
  }
  return null;
}

/** The local `file:` modules of `entry`'s module graph, as `deno info` resolves it. */
async function localModules(entry: string, cwd: string): Promise<string[]> {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["info", "--json", "--no-lock", entry],
    cwd,
    stdin: "null",
    stdout: "piped",
    stderr: "null",
    signal: AbortSignal.timeout(INFO_TIMEOUT_MS),
  }).output().catch(() => null);
  if (!out?.success) return [];
  try {
    const graph = JSON.parse(new TextDecoder().decode(out.stdout)) as {
      modules?: { specifier?: string }[];
    };
    return (graph.modules ?? [])
      .map((m) => m.specifier ?? "")
      .filter((s) => s.startsWith("file:"))
      .map((s) => fromFileUrl(s));
  } catch {
    return [];
  }
}

/**
 * Watch globs (project-relative) for the project modules the config's import graph reaches, alias
 * imports included: the directory of each (its scripts and SDL files, below it too), the
 * shallowest directories only; a module at the project root is watched as itself. The config,
 * `node_modules` and dot-folders (`.denext`) are left out. Empty when the graph reaches none.
 *
 * @param config The config file's absolute path.
 * @param projectRoot The project root.
 * @returns The globs, sorted.
 */
export async function configGraphWatch(config: string, projectRoot: string): Promise<string[]> {
  // `deno info` names modules by their real path (`/private/var/…` for `/var/…` on macOS).
  const real = (p: string) => Deno.realPath(p).catch(() => p);
  const root = await real(isAbsolute(projectRoot) ? projectRoot : resolve(projectRoot));
  const configFile = await real(config);
  const files = new Set<string>();
  const dirs = new Set<string>();
  for (const file of await localModules(configFile, root)) {
    const rel = relative(root, file);
    const parts = rel.split(SEPARATOR);
    if (file === configFile || rel.startsWith("..") || isAbsolute(rel)) continue;
    if (parts.some((p) => p === "node_modules" || p.startsWith("."))) continue;
    if (parts.length === 1) files.add(rel);
    else dirs.add(dirname(rel));
  }
  const shallowest = [...dirs].filter((d) =>
    ![...dirs].some((o) => o !== d && d.startsWith(o + SEPARATOR))
  );
  return [...files, ...shallowest.map((d) => join(d, "**", SCHEMA_FILES))].sort();
}
