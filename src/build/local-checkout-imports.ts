// The import-map entries an app needs when it runs denext from a local checkout (file paths
// instead of `jsr:@denext/denext`), and the clashes between them and the app's own entries.
//
// A `file://` denext is not a self-contained package: its modules' bare imports (`@std/path`,
// `ws`, …) resolve through the APP's import map, so the app must map them. Two rules keep that
// from breaking the app:
//
// - **Only what the app's graph can load.** The deps come from the modules reachable from
//   denext's public entry points (the `exports` of its `deno.json`), never the CLI's own
//   (`./cli`): a local CLI runs under the checkout's config, so a dependency only the CLI imports
//   (its project UI's headless browser, a build tool) never belongs in the app's map. The
//   checkout's root import map also serves its workspace packages and tests (`effect`, `jsqr`),
//   which nothing reachable imports.
// - **The app's own entry wins.** A key the app already maps (its import map, or a package.json
//   dependency resolved from node_modules) is never overridden: that is the app's version of the
//   package, and denext's would shadow it (an app on Effect 4 vs the checkout's `effect@^3`).
//   When the two disagree on the major, the clash is reported instead.

import { dirname, fromFileUrl, isAbsolute, join, resolve } from "@std/path";
import { parse as parseJsonc } from "@std/jsonc";

/** An app's entry for a package that differs from the one denext's checkout maps. */
export interface ImportClash {
  /** The import-map key (`effect`, `@std/path`). */
  readonly name: string;
  /** What the app maps it to (an import-map value, or a package.json range). */
  readonly app: string;
  /** What denext's checkout maps it to. */
  readonly denext: string;
}

/** The import-map entries a local checkout's deps get in an app, and the clashes found. */
export interface FrameworkDepsPlan {
  /** The entries to put in the app's import map (the app's own value where it maps the key). */
  readonly entries: Array<[string, string]>;
  /** Keys the app maps at another major (or another package) than denext does. */
  readonly clashes: ImportClash[];
}

/** Static and dynamic import specifiers in module text (statements at a line start). */
const IMPORT_SPECIFIERS = [
  /^[ \t]*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/gm,
  /^[ \t]*import\s*["']([^"']+)["']/gm,
  /\bimport\(\s*["']([^"']+)["']\s*[,)]/g,
  // A module loaded by URL (a worker, a runtime entry `deno desktop` compiles).
  /\bnew URL\(\s*["'](\.{1,2}\/[^"']+)["']\s*,\s*import\.meta\.url/g,
];

/** The export subpaths that are the CLI's, not the app's: never a root of the app's graph. */
const CLI_EXPORTS = new Set(["./cli"]);

/** The bare specifiers each checkout's app-reachable modules import, cached per checkout. */
const reachableSpecifiers = new Map<string, Promise<Set<string>>>();

/** Parse a config's JSONC text, or null. */
function parseConfig(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    const doc = parseJsonc(text);
    return doc !== null && typeof doc === "object" && !Array.isArray(doc)
      ? doc as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

/**
 * A project's `deno.json` (else `deno.jsonc`), parsed; null when there is none or it does not
 * parse.
 *
 * @param dir The directory.
 * @returns The config object, or null.
 */
export async function readDenoConfig(dir: string): Promise<Record<string, unknown> | null> {
  for (const name of ["deno.json", "deno.jsonc"]) {
    const text = await Deno.readTextFile(join(dir, name)).catch(() => null);
    if (text !== null) return parseConfig(text);
  }
  return null;
}

/** A config's `imports` as a string map (non-string values dropped). */
export function importsOf(config: Record<string, unknown> | null): Record<string, string> {
  const raw = config?.imports;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).filter((e): e is [string, string] =>
      typeof e[1] === "string"
    ),
  );
}

/** Every bare specifier the modules reachable from the checkout's non-CLI exports import. */
function appReachableSpecifiers(
  checkout: string,
  exportsMap: Record<string, string>,
): Promise<Set<string>> {
  let found = reachableSpecifiers.get(checkout);
  if (!found) {
    found = walkGraph(
      Object.entries(exportsMap)
        .filter(([key]) => !CLI_EXPORTS.has(key))
        .map(([, rel]) => resolve(checkout, rel)),
    );
    reachableSpecifiers.set(checkout, found);
  }
  return found;
}

/** Follow relative imports from `roots`, collecting every non-relative specifier met. */
async function walkGraph(roots: string[]): Promise<Set<string>> {
  const bare = new Set<string>();
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = await Deno.readTextFile(file).catch(() => null);
    if (text === null) continue;
    for (const re of IMPORT_SPECIFIERS) {
      for (const m of text.matchAll(re)) {
        if (m[1].startsWith(".")) queue.push(resolve(dirname(file), m[1]));
        else bare.add(m[1]);
      }
    }
  }
  return bare;
}

/** Whether an import-map key (`ws`, `@std/path`, a `prefix/`) covers one of `specs`. */
function keyCovers(specs: Set<string>, key: string): boolean {
  if (key.endsWith("/")) return [...specs].some((s) => s.startsWith(key));
  return specs.has(key) || [...specs].some((s) => s.startsWith(key + "/"));
}

/**
 * The `jsr:` / `npm:` entries of a denext checkout's import map that the modules an app can load
 * import: what an app running denext from that checkout must map. Never the deps only denext's
 * CLI imports, nor the ones only its workspace packages and tests use.
 *
 * @param checkout The checkout's root (its `deno.json`, `mod.ts`, `src/`).
 * @param config The checkout's parsed `deno.json` (read from `checkout` when omitted).
 * @returns The entries, key → specifier.
 */
export async function frameworkRuntimeDeps(
  checkout: string,
  config?: Record<string, unknown> | null,
): Promise<Record<string, string>> {
  const abs = resolve(checkout);
  const cfg = config ?? await readDenoConfig(abs);
  const exportsMap = (cfg?.exports ?? {}) as Record<string, string>;
  const used = await appReachableSpecifiers(abs, exportsMap);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(importsOf(cfg))) {
    if ((value.startsWith("jsr:") || value.startsWith("npm:")) && keyCovers(used, key)) {
      out[key] = value;
    }
  }
  return out;
}

/** A registry specifier's package and version range: `npm:effect@^3.22.0` → effect, `^3.22.0`. */
function registryParts(spec: string): { name: string; range: string } | null {
  const m = /^(?:jsr|npm):\/?((?:@[^/@]+\/)?[^/@]+)(?:@([^/]+))?/.exec(spec);
  return m ? { name: m[1], range: m[2] ?? "" } : null;
}

/**
 * The major a version range admits, as semver means it (`^0.4.1` → `0.4`): null for a range
 * that names none (`*`, `catalog:`, `workspace:*`, a tag).
 */
function rangeMajor(range: string): string | null {
  const m = /^\s*(?:\^|~|>=|=|v)?\s*(\d+)(?:\.(\d+))?/.exec(range);
  if (!m) return null;
  return m[1] === "0" ? `0.${m[2] ?? "0"}` : m[1];
}

/**
 * Whether an app's value for a key provably resolves to the same major of the same package as
 * denext's. An app value that is not a registry specifier (a path, a URL) or names no major is
 * not provably compatible.
 *
 * @param app The app's value: an import-map specifier, or a package.json range (`fromPackageJson`).
 * @param denext denext's specifier for the key.
 * @param name The key (the package name a package.json range is for).
 * @param fromPackageJson Whether `app` is a package.json range rather than a specifier.
 */
function sameMajor(app: string, denext: string, name: string, fromPackageJson: boolean): boolean {
  const theirs = registryParts(denext);
  const ours = fromPackageJson ? { name, range: app } : registryParts(app);
  if (!theirs || !ours) return false;
  if (!fromPackageJson && ours.name !== theirs.name) return false;
  const [a, b] = [rangeMajor(ours.range), rangeMajor(theirs.range)];
  return a !== null && a === b;
}

/**
 * The entries a local checkout's deps get in an app's import map, keeping every key the app
 * already maps: an import-map entry stays as the app wrote it, and a package.json dependency
 * stays unmapped (it resolves to the app's installed version). A key the app maps at another
 * major (or to another package, or where the major can't be told) is reported as a clash.
 *
 * @param framework The checkout's deps ({@linkcode frameworkRuntimeDeps}).
 * @param app The app's own import map and package.json dependencies.
 * @returns The entries to add and the clashes.
 */
export function planFrameworkDeps(
  framework: Record<string, string>,
  app: { imports?: Record<string, string>; deps?: Record<string, string> },
): FrameworkDepsPlan {
  const imports = app.imports ?? {};
  const deps = app.deps ?? {};
  const entries: Array<[string, string]> = [];
  const clashes: ImportClash[] = [];
  for (const [name, denext] of Object.entries(framework)) {
    if (Object.hasOwn(imports, name)) {
      const own = imports[name];
      entries.push([name, own]);
      if (own !== denext && !sameMajor(own, denext, name, false)) {
        clashes.push({ name, app: own, denext });
      }
    } else if (Object.hasOwn(deps, name)) {
      const range = deps[name];
      if (!sameMajor(range, denext, name, true)) {
        clashes.push({ name, app: `${name}@${range} (package.json)`, denext });
      }
    } else {
      entries.push([name, denext]);
    }
  }
  return { entries, clashes };
}

/**
 * An app's import-map entries that map a package denext's checkout needs at another major (or
 * to another package). Only registry specifiers on both sides are compared: a path or URL the
 * app maps is its own choice.
 *
 * @param appImports The app's import map.
 * @param needed The checkout's deps ({@linkcode frameworkRuntimeDeps}).
 * @returns The clashes, in `needed`'s order.
 */
export function majorClashes(
  appImports: Record<string, string>,
  needed: Record<string, string>,
): ImportClash[] {
  const out: ImportClash[] = [];
  for (const [name, denext] of Object.entries(needed)) {
    if (!Object.hasOwn(appImports, name)) continue;
    const own = appImports[name];
    if (own === denext || !registryParts(own)) continue;
    if (!sameMajor(own, denext, name, false)) out.push({ name, app: own, denext });
  }
  return out;
}

/** A clash as one line: `effect: the app maps npm:effect@^4.0.0, denext's checkout npm:…`. */
export function describeClash(c: ImportClash): string {
  return `${c.name}: the app has ${c.app}, denext's checkout maps ${c.denext}`;
}

/**
 * The denext checkout an app's import map points at (its `"denext"` entry is a path or a
 * `file:` URL rather than `jsr:`), or null. The checkout is the nearest directory above that
 * file whose `deno.json` is the `@denext/denext` package.
 *
 * @param dir The app's directory (relative entries resolve against it).
 * @param imports The app's import map.
 * @returns The checkout's root, or null.
 */
export async function localCheckoutOf(
  dir: string,
  imports: Record<string, string>,
): Promise<string | null> {
  const target = imports["denext"];
  if (!target || /^(?:jsr|npm|https?):/.test(target)) return null;
  let at: string;
  try {
    at = target.startsWith("file:")
      ? fromFileUrl(target)
      : isAbsolute(target)
      ? target
      : resolve(dir, target);
  } catch {
    return null;
  }
  for (let i = 0; i < 8; i++) {
    const parent = dirname(at);
    if (parent === at) return null;
    at = parent;
    if ((await readDenoConfig(at))?.name === "@denext/denext") return at;
  }
  return null;
}
