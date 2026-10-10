// Capacitor's iOS shell links each native plugin into `CapApp-SPM/Package.swift` as a local
// Swift package, by the path Capacitor's CLI resolved for the npm package: its real path. Under
// pnpm that is the content-addressed store (`node_modules/.pnpm/<name>@<version>_<peer
// hash>/node_modules/<name>`), which changes with every version or peer change and does not
// exist under another package manager or layout, so a committed shell stops building on the next
// machine. `stabilizeSpmPluginPaths` rewrites each such path to the package's own
// `node_modules/<name>` entry visible from the Capacitor project (the one Node resolution finds;
// a pnpm symlink to the same folder), which every install of the same dependencies recreates.
// `denext mobile add`, `mobile sync` and `mobile build` run it after `cap sync`.

import { dirname, join, relative, resolve, SEPARATOR } from "@std/path";
import { capacitorConfigFile, readCapacitorConfig } from "./capacitor-config.ts";

/** One `.package(name: …, path: "…")` entry of a Package.swift. */
const LOCAL_PACKAGE = /(\.package\(\s*name:\s*"[^"]*",\s*path:\s*")([^"]+)("\s*\))/g;

/** The iOS project folder of the Capacitor project at `root` (`ios.path`, default `ios`). */
export async function capacitorIosDir(root: string): Promise<string> {
  const file = await capacitorConfigFile(root);
  const config = file ? await readCapacitorConfig(file, await Deno.readTextFile(file)) : null;
  const ios = config?.ios as { path?: unknown } | undefined;
  return join(root, typeof ios?.path === "string" ? ios.path : "ios");
}

/** The name in the package.json of the folder `dir`, or null. */
async function packageName(dir: string): Promise<string | null> {
  try {
    const name = (JSON.parse(await Deno.readTextFile(join(dir, "package.json"))) as {
      name?: unknown;
    }).name;
    return typeof name === "string" ? name : null;
  } catch {
    return null;
  }
}

/** The realpath of `path`, or null when it does not exist. */
async function realPath(path: string): Promise<string | null> {
  try {
    return await Deno.realPath(path);
  } catch {
    return null;
  }
}

/**
 * The `node_modules/<name>` folder visible from `root` (walking up, without resolving
 * symlinks) whose real path is `real`, or null.
 */
async function visibleEntry(root: string, name: string, real: string): Promise<string | null> {
  for (let dir = root;;) {
    const entry = join(dir, "node_modules", name);
    if (await realPath(entry) === real) return entry;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** A Package.swift path to use instead of `path` (relative to `spmDir`), or null to keep it. */
async function stablePath(root: string, spmDir: string, path: string): Promise<string | null> {
  const abs = resolve(spmDir, path);
  if (!abs.split(SEPARATOR).includes(".pnpm")) return null;
  const real = await realPath(abs);
  const name = real ? await packageName(real) : null;
  if (!real || !name) return null;
  const entry = await visibleEntry(root, name, real);
  return entry ? relative(spmDir, entry).replaceAll("\\", "/") : null;
}

/**
 * Rewrite the local plugin paths of the iOS shell's `CapApp-SPM/Package.swift` from pnpm's store
 * to the packages' `node_modules/<name>` entries (see the module comment). Paths already through
 * a `node_modules/<name>` entry, and packages not visible from the project, are left alone.
 *
 * @param root The Capacitor project (the folder with capacitor.config.*).
 * @returns The rewritten paths (`[before, after]`), empty when nothing changed or there is no
 *   Package.swift.
 */
export async function stabilizeSpmPluginPaths(root: string): Promise<Array<[string, string]>> {
  const file = join(await capacitorIosDir(root), "App", "CapApp-SPM", "Package.swift");
  let source: string;
  try {
    source = await Deno.readTextFile(file);
  } catch {
    return [];
  }
  const spmDir = dirname(file);
  const changed: Array<[string, string]> = [];
  const replacements = new Map<string, string>();
  for (const match of source.matchAll(LOCAL_PACKAGE)) {
    const next = await stablePath(root, spmDir, match[2]);
    if (next && next !== match[2]) replacements.set(match[2], next);
  }
  if (replacements.size === 0) return [];
  const updated = source.replace(LOCAL_PACKAGE, (all, head: string, path: string, tail: string) => {
    const next = replacements.get(path);
    if (!next) return all;
    changed.push([path, next]);
    return head + next + tail;
  });
  await Deno.writeTextFile(file, updated);
  return changed;
}
