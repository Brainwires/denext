// `@react-router/dev/routes` on denext: the config-routing DSL a React Router v7
// framework-mode app's `app/routes.ts` imports — `route()`, `index()`, `layout()`,
// `prefix()`, `relative()` and the `RouteConfig`/`RouteConfigEntry` types. Same shapes and
// semantics as upstream (a route config entry is `{ path?, file, index?, id?, caseSensitive?,
// children? }`), so an app's `routes.ts` evaluates unchanged when the migrator aliases
// `@react-router/dev/routes` to this module. The plugin turns the resulting tree into denext
// routes (`src/route-tree.ts`).

/** One route of a React Router v7 config (`app/routes.ts`). */
export interface RouteConfigEntry {
  /** A unique id (default: the file path, extension-less, relative to the app dir). */
  id?: string;
  /** The URL segment(s) this route adds under its parent (`teams/:id`, `*`); absent for a layout or an index. */
  path?: string;
  /** An index route: renders at the parent's own URL. */
  index?: boolean;
  /** Match `path` case-sensitively. */
  caseSensitive?: boolean;
  /** The route module, relative to the app directory (`routes/home.tsx`). */
  file: string;
  /** Nested routes rendered through this route's `<Outlet />`. */
  children?: RouteConfigEntry[];
}

/** What `app/routes.ts` default-exports: the entries, or a promise of them. */
export type RouteConfig = RouteConfigEntry[] | Promise<RouteConfigEntry[]>;

/** The per-entry options `route()`/`index()`/`layout()` accept. */
export interface RouteOptions {
  id?: string;
  caseSensitive?: boolean;
}

/**
 * A route at `path` rendered by `file`, optionally with `children`.
 *
 * @example route("teams/:id", "./routes/team.tsx", [index("./routes/team-home.tsx")])
 */
export function route(
  path: string | null | undefined,
  file: string,
  options?: RouteOptions | RouteConfigEntry[],
  children?: RouteConfigEntry[],
): RouteConfigEntry {
  if (Array.isArray(options)) {
    children = options;
    options = undefined;
  }
  const entry: RouteConfigEntry = { path: path ?? undefined, file };
  if (options?.id !== undefined) entry.id = options.id;
  if (options?.caseSensitive !== undefined) {
    entry.caseSensitive = options.caseSensitive;
  }
  if (children) entry.children = children;
  return entry;
}

/** An index route: rendered at the parent's URL. */
export function index(file: string, options?: RouteOptions): RouteConfigEntry {
  const entry: RouteConfigEntry = { file, index: true };
  if (options?.id !== undefined) entry.id = options.id;
  return entry;
}

/** A pathless layout route wrapping `children`. */
export function layout(
  file: string,
  options?: RouteOptions | RouteConfigEntry[],
  children?: RouteConfigEntry[],
): RouteConfigEntry {
  if (Array.isArray(options)) {
    children = options;
    options = undefined;
  }
  const entry: RouteConfigEntry = { file };
  if (options?.id !== undefined) entry.id = options.id;
  if (children) entry.children = children;
  return entry;
}

/**
 * Prefix `routes`' paths with `prefixPath`: a routed or index entry gets the joined path
 * (an index under a prefix becomes a route AT the prefix); a pathless layout passes the
 * prefix down to its children.
 */
export function prefix(
  prefixPath: string,
  routes: RouteConfigEntry[],
): RouteConfigEntry[] {
  return routes.map((r) => {
    if (r.index || typeof r.path === "string") {
      return {
        ...r,
        path: r.path ? joinRoutePaths(prefixPath, r.path) : prefixPath,
      };
    }
    if (r.children) return { ...r, children: prefix(prefixPath, r.children) };
    return r;
  });
}

function joinRoutePaths(a: string, b: string): string {
  return `${a.replace(/\/+$/, "")}/${b.replace(/^\/+/, "")}`;
}

/** The DSL bound to a directory: every `file` is resolved relative to `directory`. */
export function relative(directory: string): {
  route: typeof route;
  index: typeof index;
  layout: typeof layout;
  prefix: typeof prefix;
} {
  const rel = (file: string) => `${directory.replace(/\/+$/, "")}/${file.replace(/^\.?\/+/, "")}`;
  return {
    route: (path, file, options, children) => route(path, rel(file), options, children),
    index: (file, options) => index(rel(file), options),
    layout: (file, options, children) => layout(rel(file), options, children),
    prefix,
  };
}
