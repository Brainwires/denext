// Find the project module that exports a value `denext.config.*` imported — so a schema OBJECT
// passed to `graphql({ schema })` can be re-imported from its module after an edit under
// `denext dev`, as the module-path form is. Internal to `mod.ts`.
//
// The walk starts at the config file and follows its static RELATIVE imports (`./`, `../`),
// breadth-first, inside the project. Each module is imported by its plain `file:` URL — the URL
// the config's own relative import resolved to — so the module comes from Deno's cache and is
// never evaluated a second time; its exports are compared to the value by identity.

import { dirname, fromFileUrl, isAbsolute, join, resolve, toFileUrl } from "@std/path";
import * as posix from "@std/path/posix";
import * as windows from "@std/path/windows";

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

/** Which OS's paths: `"windows"` (drive letters, `\`, case-insensitive) or `"posix"`. */
export type PathFlavor = "posix" | "windows";

/** This OS's path flavor. */
const OS_FLAVOR: PathFlavor = Deno.build.os === "windows" ? "windows" : "posix";

/** A path normalized for `flavor`: on Windows without the verbatim `\\?\` prefix, `/` as `\`. */
function normalized(path: string, flavor: PathFlavor): string {
  if (flavor === "posix") return posix.normalize(path);
  return windows.normalize(path.replace(/^\\\\\?\\(?!UNC\\)/, "").replaceAll("/", "\\"));
}

/** A normalized path's comparison key: Windows paths compare case-insensitively. */
function key(path: string, flavor: PathFlavor): string {
  return flavor === "windows" ? path.toLowerCase() : path;
}

/**
 * The segments of `file` below the first of `roots` that holds it (in the file's own spelling),
 * or `null` when none does (another drive included).
 */
function segmentsBelow(
  file: string,
  roots: readonly string[],
  flavor: PathFlavor,
): string[] | null {
  const api = flavor === "windows" ? windows : posix;
  for (const root of roots) {
    const rel = api.relative(key(root, flavor), key(file, flavor));
    if (rel === "" || rel.startsWith("..") || api.isAbsolute(rel)) continue;
    const count = rel.split(api.SEPARATOR).length;
    return file.split(api.SEPARATOR).slice(-count);
  }
  return null;
}

/**
 * Watch globs for module files, relative to the project and always written with `/` (the
 * prepare-step watcher joins them onto the project root itself): the directory of each module
 * inside one of `roots` (its scripts and SDL files, below it too), the shallowest directories
 * only; a module at the project root is watched as itself. `configs`, `node_modules` and
 * dot-folders (`.denext`) are left out. Paths compare in `flavor`'s terms, so a Windows path's
 * drive-letter case, folder case and verbatim prefix don't matter, and a module on another drive
 * is outside.
 *
 * @param files Each module's absolute path, or several spellings of it (as given, real path).
 * @param roots The project root's spellings (as given, and its real path).
 * @param configs The config file's spellings.
 * @param flavor Whose paths these are (default: this OS's).
 * @returns The globs, sorted.
 */
export function watchGlobs(
  files: readonly (string | readonly string[])[],
  roots: readonly string[],
  configs: readonly string[],
  flavor: PathFlavor = OS_FLAVOR,
): string[] {
  const rootPaths = roots.map((r) => normalized(r, flavor));
  const configKeys = new Set(configs.map((c) => key(normalized(c, flavor), flavor)));
  const top = new Set<string>();
  const dirs = new Set<string>();
  for (const spellings of files) {
    const paths = (typeof spellings === "string" ? [spellings] : spellings)
      .map((f) => normalized(f, flavor));
    if (paths.some((p) => configKeys.has(key(p, flavor)))) continue;
    const parts = paths.map((p) => segmentsBelow(p, rootPaths, flavor)).find((x) => x !== null);
    if (!parts || parts.some((p) => p === "node_modules" || p.startsWith("."))) continue;
    if (parts.length === 1) top.add(parts[0]);
    else dirs.add(parts.slice(0, -1).join("/"));
  }
  const shallowest = [...dirs].filter((d) =>
    ![...dirs].some((o) => o !== d && d.startsWith(o + "/"))
  );
  return [...top, ...shallowest.map((d) => `${d}/**/${SCHEMA_FILES}`)].sort();
}

/**
 * Watch globs (project-relative, written with `/`) for the project modules the config's import
 * graph reaches, alias imports included ({@linkcode watchGlobs}). Empty when it reaches none.
 *
 * @param config The config file's absolute path.
 * @param projectRoot The project root.
 * @returns The globs, sorted.
 */
export async function configGraphWatch(config: string, projectRoot: string): Promise<string[]> {
  // `deno info` names modules by their real path (`/private/var/…` for `/var/…` on macOS; a
  // long name for a Windows 8.3 one), so each path is compared as given and as its real path.
  const real = (p: string) => Deno.realPath(p).catch(() => p);
  const root = isAbsolute(projectRoot) ? projectRoot : resolve(projectRoot);
  const realConfig = await real(config);
  const modules = await localModules(realConfig, root);
  const files = await Promise.all(modules.map(async (f) => [f, await real(f)]));
  return watchGlobs(files, [root, await real(root)], [config, realConfig]);
}
