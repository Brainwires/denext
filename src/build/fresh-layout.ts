// `denext migrate --from fresh`: where a Fresh app keeps its files. Fresh's defaults are
// `routes/`, `islands/`, `static/`, `main.ts` and `client.ts`; a Fresh 2 Vite app may move each
// with `fresh({ routeDir, islandsDir, staticDir, serverEntry, clientEntry })` in its
// `vite.config.*`, skip files with `ignore`, and name more island modules with
// `islandSpecifiers`; a Fresh 1.x app sets `staticDir` and `router` in `fresh.config.ts`. The
// migration reads them here (literal values only) and carries every one it can.

import { join } from "@std/path";
import { mfs } from "./migrate-io.ts";
import { readFresh1Config, readFreshViteOptions } from "./fresh-config-read.ts";

/** Fresh's default `ignore`: test files beside the routes and islands (`TEST_FILE_PATTERN`). */
const FRESH_TEST_FILE = /[._]test\.(?:[tj]sx?|[mc][tj]s)$/;

/** The Vite config names Fresh 2 apps use. */
export const VITE_CONFIGS = [
  "vite.config.ts",
  "vite.config.js",
  "vite.config.mts",
  "vite.config.mjs",
];

/** Where a Fresh app keeps its files, and the router options it sets. */
export interface FreshLayout {
  /** The routes directory, project-relative, `/`-separated (`routes`). */
  routes: string;
  /** The islands directory (`islands`). */
  islands: string;
  /** The static directories, searched in order (`static`). */
  statics: string[];
  /** The server entry (`main.ts`). */
  serverEntry: string;
  /** The client entry (`client.ts`), or null for Fresh's default candidates. */
  clientEntry: string | null;
  /** Paths the route and island crawl skips. */
  ignore: RegExp[];
  /** Modules (local paths or package specifiers) whose exports are islands (`islandSpecifiers`). */
  islandSpecifiers: string[];
  /** Fresh 1.x `router.basePath`. */
  basePath?: string;
  /** Fresh 1.x `router.trailingSlash`. */
  trailingSlash?: boolean;
  /** The Vite config read (its name and source), if any. */
  vite: { name: string; source: string } | null;
  /** Options that were set to something the migration could not read, by name. */
  unread: string[];
}

/** A path option as a project-relative, `/`-separated path (`./src/routes/` → `src/routes`). */
function normalize(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "") || ".";
}

/** The first Vite config in `dir`, with its source. */
async function readVite(dir: string): Promise<{ name: string; source: string } | null> {
  for (const name of VITE_CONFIGS) {
    const source = await mfs.readTextFile(join(dir, name)).catch(() => null);
    if (source !== null) return { name, source };
  }
  return null;
}

/**
 * The layout of the Fresh app at `dir`: Fresh's defaults, overridden by `fresh({ … })` in its
 * Vite config and (Fresh 1.x) `fresh.config.ts`.
 *
 * @param dir The app directory.
 * @returns Where it keeps its files.
 */
export async function readFreshLayout(dir: string): Promise<FreshLayout> {
  const vite = await readVite(dir);
  const v = vite ? readFreshViteOptions(vite.source) : { unread: [] as string[] };
  const layout: FreshLayout = {
    routes: normalize(v.routeDir ?? "routes"),
    islands: normalize(v.islandsDir ?? "islands"),
    statics: (v.staticDir ?? ["static"]).map(normalize),
    serverEntry: normalize(v.serverEntry ?? "main.ts"),
    clientEntry: v.clientEntry ? normalize(v.clientEntry) : null,
    ignore: v.ignore ?? [FRESH_TEST_FILE],
    islandSpecifiers: v.islandSpecifiers ?? [],
    vite,
    unread: v.unread.map((k) => `fresh({ ${k} })`),
  };
  const fresh1 = await mfs.readTextFile(join(dir, "fresh.config.ts")).catch(() => null);
  if (fresh1 !== null) {
    const c = readFresh1Config(fresh1);
    if (c.staticDir) layout.statics = [normalize(c.staticDir)];
    layout.basePath = c.basePath;
    layout.trailingSlash = c.trailingSlash;
    layout.unread.push(...c.unread.map((k) => `fresh.config.ts: ${k}`));
  }
  return layout;
}

/**
 * Whether the crawl skips a file (Fresh tests `ignore` against the path it walks; the
 * project-relative path and the path below the crawled directory are both tried).
 *
 * @param layout The app's layout.
 * @param rel The project-relative path.
 * @param below The path below the crawled directory.
 * @returns Whether an `ignore` pattern matches.
 */
export function ignoredByFresh(layout: FreshLayout, rel: string, below: string): boolean {
  return layout.ignore.some((re) => {
    re.lastIndex = 0;
    const hit = re.test(rel) || (re.lastIndex = 0, re.test(below));
    return hit;
  });
}
