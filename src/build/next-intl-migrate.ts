// What `denext migrate` does for an app's next-intl request config. On Next.js,
// `createNextIntlPlugin()` in next.config points next-intl at `i18n/request.ts` (an alias the
// server APIs import); denext's next-intl compat has no such alias: `getRequestConfig()` registers
// the loader when the module runs, so something the server renders must import it. Migrate adds a
// side-effect import of the request config to each root layout — bundled with the routes, so it
// registers on the same `next-intl/server` the pages call. The import is harmless on Next.js too.

import { dirname, join, relative, resolve } from "@std/path";
import { mfs } from "./migrate-io.ts";
import { exists } from "./migrate-fs.ts";

/** The next-intl report of a migration. */
export interface NextIntlMigrateInfo {
  /** The request config (project-relative), or null when none was found. */
  requestConfig: string | null;
  /** The root layouts (project-relative) that now import it. */
  wired: string[];
  /** What to check by hand. */
  notes: string[];
}

/** A config plugin call recorded by the next.config evaluator. */
export interface ConfigPluginCall {
  /** The plugin's module (`"next-intl/plugin"`). */
  name: string;
  /** What the config passed it. */
  arg?: unknown;
}

/** The plugin's module. */
const PLUGIN = "next-intl/plugin";

/** next-intl's default request config locations, in its own lookup order. */
const DEFAULT_REQUEST_CONFIGS = ["i18n/request", "src/i18n/request"].flatMap((base) =>
  [".ts", ".tsx", ".js", ".jsx"].map((ext) => base + ext)
);

/** The layout file names, by Next.js's precedence. */
const LAYOUT_NAMES = ["layout.tsx", "layout.ts", "layout.jsx", "layout.js"];

/**
 * The request config path `createNextIntlPlugin(arg)` names: a path string, or
 * `{ requestConfig }`; undefined for the default lookup.
 */
function requestConfigArg(arg: unknown): string | undefined {
  if (typeof arg === "string") return arg;
  if (arg && typeof arg === "object") {
    const value = (arg as { requestConfig?: unknown }).requestConfig;
    if (typeof value === "string") return value;
  }
  return undefined;
}

/** `rel` resolved against `dir`, when it stays inside it and names a file. */
async function fileInside(dir: string, rel: string): Promise<string | null> {
  const path = resolve(dir, rel);
  const back = relative(dir, path);
  if (back.startsWith("..") || resolve(dir, back) !== path) return null;
  return await exists(path) ? path : null;
}

/** The request config the plugin call points at (absolute), or null. */
async function findRequestConfig(dir: string, arg: unknown): Promise<string | null> {
  const named = requestConfigArg(arg);
  if (named !== undefined) return await fileInside(dir, named);
  for (const candidate of DEFAULT_REQUEST_CONFIGS) {
    const found = await fileInside(dir, candidate);
    if (found) return found;
  }
  return null;
}

/** The first layout file in `dir`, or null. */
async function layoutIn(dir: string): Promise<string | null> {
  for (const name of LAYOUT_NAMES) {
    if (await exists(join(dir, name))) return join(dir, name);
  }
  return null;
}

/**
 * The root layouts under `appDir`: the layout of `appDir` itself, else the top-most layout down
 * each branch (`app/[locale]/layout.tsx`, one per route group).
 */
async function rootLayouts(appDir: string): Promise<string[]> {
  const own = await layoutIn(appDir);
  if (own) return [own];
  const out: string[] = [];
  const entries: string[] = [];
  try {
    for await (const e of Deno.readDir(appDir)) {
      // Private folders (`_components`) and parallel slots (`@modal`) hold no root layout.
      if (e.isDirectory && !/^[_@.]/.test(e.name)) entries.push(e.name);
    }
  } catch {
    return out;
  }
  for (const name of entries.sort()) out.push(...await rootLayouts(join(appDir, name)));
  return out;
}

/** `source` with `import "<spec>";` after its directive prologue and leading comments. */
function withSideEffectImport(source: string, spec: string): string {
  const prologue = /^(?:\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/|["']use [a-z ]+["'];?[^\S\n]*\n))*/
    .exec(source)?.[0] ?? "";
  const line = `import ${JSON.stringify(spec)}; // next-intl request config (denext migrate)\n`;
  return source.slice(0, prologue.length) + line + source.slice(prologue.length);
}

/** The extensionless relative specifier from `fromFile` to `target` (Next resolves it too). */
function relativeSpecifier(fromFile: string, target: string): string {
  const rel = relative(dirname(fromFile), target).replaceAll("\\", "/").replace(/\.[jt]sx?$/, "");
  return rel.startsWith(".") ? rel : `./${rel}`;
}

/** Whether `source` already imports the request config (any spelling of its path). */
function importsRequestConfig(source: string, requestConfig: string, dir: string): boolean {
  const rel = relative(dir, requestConfig).replaceAll("\\", "/").replace(/\.[jt]sx?$/, "");
  const tail = rel.replace(/^src\//, "");
  return new RegExp(`["'][^"']*${tail.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}(?:\\.[jt]sx?)?["']`)
    .test(source);
}

/**
 * Wire an app's next-intl request config: when its next.config wraps the config with
 * `createNextIntlPlugin` (a recorded plugin call, or — when the config could not be evaluated —
 * an import of `next-intl/plugin` in its source), import the request config from each root layout.
 *
 * @param dir The app root.
 * @param deps The app's dependencies.
 * @param next The evaluated plugin calls (`null` when the config could not be evaluated) and the
 *   next.config file name.
 * @param written The written-files list to extend.
 * @returns The report, or undefined for an app that uses no next-intl plugin.
 */
export async function wireNextIntlRequestConfig(
  dir: string,
  deps: Record<string, string>,
  next: { file: string | null; plugins: ConfigPluginCall[] | null } | null,
  written: string[],
): Promise<NextIntlMigrateInfo | undefined> {
  if (!("next-intl" in deps) || !next?.file) return undefined;
  let call = next.plugins?.find((p) => p.name === PLUGIN);
  if (!call && next.plugins === null) {
    const source = await mfs.readTextFile(join(dir, next.file)).catch(() => "");
    if (source.includes(PLUGIN)) call = { name: PLUGIN };
  }
  if (!call) return undefined;
  const requestConfig = await findRequestConfig(dir, call.arg);
  if (!requestConfig) {
    return {
      requestConfig: null,
      wired: [],
      notes: [
        "createNextIntlPlugin's request config (i18n/request.ts) was not found; import yours " +
        "from the root layout so getRequestConfig() registers",
      ],
    };
  }
  const appDir = await exists(join(dir, "app")) ? join(dir, "app") : join(dir, "src", "app");
  const layouts = await rootLayouts(appDir);
  const wired: string[] = [];
  for (const layout of layouts) {
    const source = await mfs.readTextFile(layout);
    if (importsRequestConfig(source, requestConfig, dir)) continue;
    await mfs.writeTextFile(
      layout,
      withSideEffectImport(source, relativeSpecifier(layout, requestConfig)),
    );
    written.push(layout);
    wired.push(relative(dir, layout).replaceAll("\\", "/"));
  }
  const rel = relative(dir, requestConfig).replaceAll("\\", "/");
  const notes = layouts.length === 0
    ? [`no root layout found; import ${rel} from the module that renders your pages`]
    : [];
  return { requestConfig: rel, wired, notes };
}
