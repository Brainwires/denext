// What the `next.config.*` evaluator takes from a project's `deno.json`. Deno reads that file
// outside the permission sandbox and before any project code runs, so a hostile repository's
// config could reach past `--allow-read`: `importMap` and `links` load files from anywhere and
// hand their values to `import.meta.resolve`, `lock` rewrites any valid lockfile on the machine,
// and `unstable` turns on APIs. The evaluator therefore never lets Deno discover it. A config's
// imports still have to resolve, so the entries are read here and passed as a generated import
// map: resolution data only, with every module they name still loaded under `--allow-read`.

import { parse as parseJsonc } from "@std/jsonc";
import { dirname, join, resolve, toFileUrl } from "@std/path";
import { inside } from "./contained-read.ts";
import {
  absoluteImports,
  CONFIG_NAMES,
  workspaceImports,
  workspaceOf,
} from "./workspace-imports.ts";

/** An import map's two fields, with no entry relative to the file that declared it. */
interface ImportMap {
  readonly imports: Record<string, string>;
  readonly scopes: Record<string, Record<string, string>>;
}

/** The flags that replace Deno's config discovery, and what cleans up after them. */
export interface ConfigIsolation {
  /** Flags for the evaluator's `deno run`. */
  readonly flags: readonly string[];
  /** Removes the generated import map, if one was written. */
  readonly dispose: () => Promise<void>;
}

/** Whether `path` names something, a dangling symlink included (Deno would try to read it). */
function exists(path: string): Promise<boolean> {
  return Deno.lstat(path).then(() => true, (err) => !(err instanceof Deno.errors.NotFound));
}

/**
 * Whether Deno would discover a config for a process started in `dir`: it looks in the
 * directory and in every directory above it.
 *
 * @param dir The child's working directory.
 * @returns True when a `deno.json` or `deno.jsonc` is there or above.
 */
export async function discoversDenoConfig(dir: string): Promise<boolean> {
  for (let at = resolve(dir), below = ""; at !== below; below = at, at = dirname(at)) {
    for (const name of CONFIG_NAMES) {
      if (await exists(join(at, name))) return true;
    }
  }
  return false;
}

/** Whether `path`, with every symlink resolved, is `root` or under it. */
async function resolvesInside(root: string, path: string): Promise<boolean> {
  const real = await Deno.realPath(path).catch(() => null);
  return real !== null && inside(root, real);
}

/** The JSON(C) object in `path`, when the file really is inside `root`. */
async function readContained(root: string, path: string): Promise<Record<string, unknown> | null> {
  if (!await resolvesInside(root, path)) return null;
  try {
    const value = parseJsonc(await Deno.readTextFile(path));
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

/** The config file in `dir`, parsed, when it is inside `root`. */
async function configIn(root: string, dir: string): Promise<Record<string, unknown> | null> {
  for (const name of CONFIG_NAMES) {
    if (await exists(join(dir, name))) return await readContained(root, join(dir, name));
  }
  return null;
}

/** `value`'s `scopes`, keys and targets made absolute against `dir`. */
function absoluteScopes(
  value: Record<string, unknown>,
  dir: string,
): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  const scopes = value.scopes;
  if (!scopes || typeof scopes !== "object") return out;
  for (const [scope, imports] of Object.entries(scopes as Record<string, unknown>)) {
    const key = /^\.\.?\//.test(scope)
      ? `${toFileUrl(resolve(dir, scope)).href}${scope.endsWith("/") ? "/" : ""}`
      : scope;
    out[key] = absoluteImports({ imports }, dir);
  }
  return out;
}

/** One config's import-map entries: its `imports` and `scopes`, or its contained `importMap`. */
async function ownEntries(
  root: string,
  dir: string,
  config: Record<string, unknown>,
): Promise<ImportMap> {
  // Only a file in the project, by a relative path: a URL or a path out of it is never read.
  const external = typeof config.importMap === "string" && /^\.\.?\//.test(config.importMap)
    ? await readContained(root, resolve(dir, config.importMap))
    : null;
  const [value, base] = external && !config.imports
    ? [external, dirname(resolve(dir, config.importMap as string))]
    : [config, dir];
  return { imports: absoluteImports(value, base), scopes: absoluteScopes(value, base) };
}

/** Whether a config of the workspace `dir` belongs to resolves outside `root`. */
async function workspaceLeaves(root: string, dir: string): Promise<boolean> {
  const members = (await workspaceOf(dir).catch(() => null))?.members ?? [];
  for (const member of [root, ...members]) {
    for (const name of CONFIG_NAMES) {
      const path = join(member, name);
      if (await exists(path) && !await resolvesInside(root, path)) return true;
    }
  }
  return false;
}

/**
 * The import map that stands in for the `deno.json` of the project at `dir`: its own `imports`
 * and `scopes` over its workspace's (the root's imports, each member by name, each member's own
 * imports). A config that a symlink leads out of `root` contributes nothing, and a workspace
 * with one contributes nothing at all, so a link can't copy a file from elsewhere into the map.
 *
 * @param dir The project directory, every symlink in its path resolved.
 * @param root Its containment root, resolved the same way.
 * @returns The entries, empty when the project declares none.
 */
export async function projectImportMap(dir: string, root: string): Promise<ImportMap> {
  const config = await configIn(root, dir);
  const own: ImportMap = config ? await ownEntries(root, dir, config) : { imports: {}, scopes: {} };
  if (await workspaceLeaves(root, dir)) return own;
  const ws = await workspaceImports(join(dir, "deno.json")).catch(() => null);
  return {
    imports: { ...ws?.imports, ...own.imports },
    scopes: { ...ws?.scopes, ...own.scopes },
  };
}

/** No lockfile is read or written, wherever a config or a project's own `deno.lock` would put it. */
const NO_LOCK = "--no-lock";

/**
 * The flags that keep a project's `deno.json` away from the evaluator. A project without one
 * keeps Deno's discovery, since its `package.json` and `tsconfig.json` are what select the
 * Node-style resolution a Next config expects (extensionless imports, `paths`), and neither can
 * name a file outside the read grant. A project with one gets `--no-config`, a generated import
 * map, and the two resolution modes a config could otherwise only ask for through `unstable`:
 * they widen what resolves, never what may be read.
 *
 * @param dir The project directory, every symlink in its path resolved.
 * @param root Its containment root, resolved the same way.
 * @returns The flags, and how to clean up after the evaluation.
 */
export async function configIsolation(dir: string, root: string): Promise<ConfigIsolation> {
  const nothing = () => Promise.resolve();
  if (!await discoversDenoConfig(dir)) return { flags: [NO_LOCK], dispose: nothing };
  const flags = [
    NO_LOCK,
    "--no-config",
    "--unstable-sloppy-imports",
    "--unstable-bare-node-builtins",
  ];
  const map = await projectImportMap(dir, root);
  if (Object.keys(map.imports).length + Object.keys(map.scopes).length === 0) {
    return { flags, dispose: nothing };
  }
  // A file, not a `data:` URL: a migrated app's alias map can pass Windows' command-line limit.
  // Nothing in the evaluator may write, and the grant doesn't reach this file unless the project
  // itself is under the temp directory, where a config reads only what its own project declared.
  const path = await Deno.makeTempFile({ prefix: "denext-next-eval-", suffix: ".json" })
    .catch(() => null);
  if (path === null) return { flags, dispose: nothing };
  await Deno.writeTextFile(path, JSON.stringify(map));
  return {
    flags: [...flags, `--import-map=${path}`],
    dispose: () => Deno.remove(path).catch(() => {}),
  };
}
