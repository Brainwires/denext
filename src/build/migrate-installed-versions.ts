// The versions a migrated project already has installed. `denext migrate` pins each npm
// dependency as `npm:name@version` in the generated deno.json; the floor of the package.json range
// (`^6.42.0` → `6.42.0`) is usually older than what the package manager installed (`6.48.0`), and
// under `nodeModulesDir: "auto"` Deno then installs a second, older tree into `node_modules/.deno`.
// The installed version comes from the package's own `node_modules/<name>/package.json`, else the
// project's lockfile (`package-lock.json`, `pnpm-lock.yaml`), else the caller keeps the floor.

import { join } from "@std/path";
import { parse as parseYaml } from "@std/yaml";
import { mfs } from "./migrate-io.ts";

/** A plain semver version (what a pin may name). */
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** An `npm:name@version` import-map value: the name and version. */
const NPM_PIN = /^npm:((?:@[^/@]+\/)?[^/@]+)@([^/]+)$/;

/** `text` parsed as JSON, or null. */
function parseJson(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** A file's text, or null when it is absent or unreadable. */
function readText(path: string): Promise<string | null> {
  return mfs.readTextFile(path).catch(() => null);
}

/** `value` when it is a plain semver version, else null. */
function semver(value: unknown): string | null {
  return typeof value === "string" && SEMVER.test(value) ? value : null;
}

/** The version `node_modules/<name>` holds. */
async function fromNodeModules(dir: string, name: string): Promise<string | null> {
  return semver(
    parseJson(await readText(join(dir, "node_modules", name, "package.json")))?.version,
  );
}

/** The version `package-lock.json` (v1–v3) records for the project's own `name`. */
async function fromPackageLock(dir: string, name: string): Promise<string | null> {
  const lock = parseJson(await readText(join(dir, "package-lock.json")));
  if (!lock) return null;
  const packages = lock.packages as Record<string, { version?: unknown }> | undefined;
  const dependencies = lock.dependencies as Record<string, { version?: unknown }> | undefined;
  return semver(packages?.[`node_modules/${name}`]?.version) ??
    semver(dependencies?.[name]?.version);
}

/** A pnpm lockfile entry's version, without its peer suffix (`6.48.0(zod@3.25.76)`). */
function pnpmVersion(entry: unknown): string | null {
  const raw = entry && typeof entry === "object" ? (entry as { version?: unknown }).version : entry;
  return typeof raw === "string" ? semver(raw.replace(/\(.*$/, "")) : null;
}

/** The version `pnpm-lock.yaml` records for the project's own `name` (v5–v9). */
async function fromPnpmLock(dir: string, name: string): Promise<string | null> {
  const text = await readText(join(dir, "pnpm-lock.yaml"));
  if (text === null) return null;
  let lock: Record<string, unknown>;
  try {
    lock = (parseYaml(text) ?? {}) as Record<string, unknown>;
  } catch {
    return null;
  }
  const importers = lock.importers as Record<string, Record<string, unknown>> | undefined;
  const root = importers?.["."] ?? lock;
  for (const group of ["dependencies", "devDependencies", "optionalDependencies"]) {
    const entries = root[group] as Record<string, unknown> | undefined;
    const found = pnpmVersion(entries?.[name]);
    if (found) return found;
  }
  return null;
}

/**
 * The version of the project's dependency `name` its package manager installed: the installed
 * package's own `package.json`, else the lockfile's record; null when neither names a plain
 * version (a `link:` / `file:` / git dependency, or nothing installed).
 *
 * @param dir The project directory.
 * @param name The package name (`openai`, `@scope/pkg`).
 */
export async function installedVersion(dir: string, name: string): Promise<string | null> {
  return await fromNodeModules(dir, name) ?? await fromPackageLock(dir, name) ??
    await fromPnpmLock(dir, name);
}

/**
 * Rewrite every `npm:name@version` pin in `imports` to the version the project installed (see
 * {@link installedVersion}); a dependency with no installed version keeps its pin.
 *
 * @param dir The project directory.
 * @param imports The generated import map (changed in place).
 */
export async function pinInstalledVersions(
  dir: string,
  imports: Record<string, string>,
): Promise<void> {
  await Promise.all(
    Object.entries(imports).map(async ([key, value]) => {
      const pin = NPM_PIN.exec(value);
      if (!pin || pin[1] !== key) return;
      const version = await installedVersion(dir, pin[1]);
      if (version) imports[key] = `npm:${pin[1]}@${version}`;
    }),
  );
}

/**
 * The `nodeModulesDir` for a migrated project: `"manual"` — the package manager's existing
 * `node_modules` is the one tree — when it holds every `npm:` pin of `imports` at exactly the
 * pinned version (Deno refuses a pin `node_modules` does not hold), else `"auto"`.
 *
 * @param dir The project directory.
 * @param imports The generated import map.
 */
export async function nodeModulesDirFor(
  dir: string,
  imports: Record<string, string>,
): Promise<"manual" | "auto"> {
  const exists = await mfs.stat(join(dir, "node_modules")).then((s) => s.isDirectory, () => false);
  if (!exists) return "auto";
  for (const value of Object.values(imports)) {
    const pin = NPM_PIN.exec(value);
    if (pin && await fromNodeModules(dir, pin[1]) !== pin[2]) return "auto";
  }
  return "manual";
}
