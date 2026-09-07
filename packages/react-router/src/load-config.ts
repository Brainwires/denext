// Reading a React Router v7 app's routing config: `app/routes.ts` default-exports a
// `RouteConfig` (an entry array, or a promise of one — RR allows an async config), and
// `react-router.config.ts` default-exports the framework options. Both are plain modules the
// plugin `import()`s through the app's module loader; the values are validated just enough to
// fail loudly on the mistakes a migration is likely to make.

import type { RouteConfig, RouteConfigEntry } from "../routes.ts";

/** The subset of `react-router.config.ts` denext honors. */
export interface ReactRouterConfig {
  /** Where `root.tsx` and `routes.ts` live, relative to the project (default `app`). */
  appDirectory?: string;
  /** URL prefix the app is served under (→ denext `basePath`). */
  basename?: string;
  /** Server-render (default true). `false` is RR's SPA mode — not what this plugin serves. */
  ssr?: boolean;
  /** Static prerender list / resolver — noted, not applied (denext prerenders static routes itself). */
  prerender?: boolean | string[] | (() => unknown);
}

/**
 * The entries of a `routes.ts` module namespace: awaits an async config and checks the shape.
 *
 * @param mod The imported `app/routes.ts` module (its default export is the config).
 * @param file The module's path, for the error message.
 * @returns The route config entries.
 */
export async function resolveRouteConfig(
  mod: unknown,
  file = "app/routes.ts",
): Promise<RouteConfigEntry[]> {
  const config = (mod as { default?: RouteConfig }).default;
  const entries = await config;
  if (!Array.isArray(entries)) {
    throw new Error(
      `react-router: ${file} must default-export a route config (an array from route()/index()/layout(), or a promise of one)`,
    );
  }
  entries.forEach((e, i) => validateEntry(e, `${file}[${i}]`));
  return entries;
}

function validateEntry(entry: unknown, at: string): void {
  if (
    typeof entry !== "object" || entry === null ||
    typeof (entry as RouteConfigEntry).file !== "string"
  ) {
    throw new Error(
      `react-router: ${at} is not a route entry — every entry needs a \`file\``,
    );
  }
  const e = entry as RouteConfigEntry;
  if (e.index && e.children?.length) {
    throw new Error(
      `react-router: ${at} (${e.file}) is an index route and cannot have children`,
    );
  }
  e.children?.forEach((c, i) => validateEntry(c, `${at}.children[${i}]`));
}

/** The framework options of a `react-router.config.ts` module namespace (defaults applied). */
export function resolveReactRouterConfig(
  mod: unknown,
):
  & Required<Pick<ReactRouterConfig, "appDirectory" | "ssr">>
  & ReactRouterConfig {
  const cfg = ((mod as { default?: ReactRouterConfig }).default ??
    {}) as ReactRouterConfig;
  return {
    ...cfg,
    appDirectory: cfg.appDirectory ?? "app",
    ssr: cfg.ssr ?? true,
  };
}
