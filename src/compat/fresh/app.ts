// Fresh 2's `App` on denext. A migrated app's `main.ts` still builds one (`new App()`,
// `app.use(…)`, `app.get(…)`, `app.layout(…)`, `app.fsRoutes()`); this class records what it
// registers, and the generated files run it: `middleware.ts` its middleware, handlers, code routes
// and error handlers, the root layout its app wrapper and layouts, the not-found page its
// `notFound()`. denext serves the app, so `listen()` does nothing.

import type { Context } from "./context.ts";
import type {
  HandlerFn,
  LayoutConfig,
  ListenOptions,
  Method,
  RouteConfig,
  WebSocketHandlers,
  WebSocketUpgradeOptions,
} from "./types.ts";

/** A middleware or a route handler registered on an {@link App}. */
export type AppHandler = (ctx: Context<never>) => unknown;

/** A middleware registered with `use()`. */
export interface AppMiddleware {
  /** The path pattern it applies under (`/`, `*`, `/admin/*`: every path under it). */
  path: string;
  /** The middleware functions, in order. */
  fns: AppHandler[];
}

/** A route registered with `app.get()` / `app.post()` / … / `app.all()`. */
export interface AppRoute {
  /** The method (`ALL` for any). */
  method: Method | "ALL";
  /** The URL pattern (`/api/:name`). */
  pattern: string;
  /** Route-level middleware, then the handler. */
  fns: AppHandler[];
}

/** A Fresh route object (`{ handler, component, config }`), as `app.route()` takes it. */
export interface AppRouteObject {
  /** The handler (one function, or one per method). */
  handler?: unknown;
  /** The page component. */
  component?: unknown;
  /** The route config. */
  config?: RouteConfig;
}

/** A page route registered with `app.route()` (a lazy one is loaded on its first request). */
export interface AppPageRoute {
  /** The URL pattern. */
  pattern: string;
  /** The route, or a function loading it. */
  route: AppRouteObject | (() => Promise<AppRouteObject>);
  /** The config given beside the route. */
  config?: RouteConfig;
}

/** A layout registered with `app.layout()`. */
export interface AppLayout {
  /** The path pattern it wraps the pages under. */
  path: string;
  /** The layout component. */
  component: unknown;
  /** Its config (skip the app wrapper, or the layouts registered before it). */
  config?: LayoutConfig;
}

/** An error handler registered with `app.onError()`. */
export interface AppErrorRoute {
  /** The path pattern it handles errors under. */
  path: string;
  /** The route (a middleware is `{ handler }`). */
  route: AppRouteObject;
}

/** Something an app registered that denext does not run, for the migration report. */
export interface AppIgnored {
  /** The method called (`islands`). */
  call: string;
  /** Its path argument, when it took one. */
  path?: string;
}

/** Where the most recently constructed apps are kept, so `middleware.ts` finds an unexported one. */
const APPS_KEY = Symbol.for("denext.fresh.apps");

/** The apps constructed in this process, newest last. */
export function constructedApps(): App<unknown>[] {
  return (globalThis as { [APPS_KEY]?: App<unknown>[] })[APPS_KEY] ?? [];
}

/** Coerce `app.use()`'s arguments: an optional path, then middleware (or arrays of them). */
function middlewareArgs(args: unknown[]): AppMiddleware {
  const path = typeof args[0] === "string" ? args.shift() as string : "*";
  const fns = (args as unknown[]).flat().filter((f): f is AppHandler => typeof f === "function");
  return { path, fns };
}

/** A middleware or a route object as the route object Fresh normalizes it to. */
function routeObject(value: unknown): AppRouteObject {
  return typeof value === "function" ? { handler: value } : (value ?? {}) as AppRouteObject;
}

/** `sub` mounted under `prefix` (`mountApp`): `/api` + `/users/:id` → `/api/users/:id`. */
function joinPath(prefix: string, sub: string): string {
  const base = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  if (sub === "" || sub === "/") return base || "/";
  return base + (sub.startsWith("/") ? sub : `/${sub}`);
}

const patternCache = new Map<string, URLPattern>();

/**
 * Whether `pathname` is at or under a Fresh path pattern, the way `use()`, `layout()` and
 * `onError()` scope theirs: `*` and `/` cover every path, `/admin` and `/admin/*` cover `/admin`
 * and everything below it, and a pattern with parameters (`/blog/:id/*`) matches by its segments.
 *
 * @param pathname The request path.
 * @param pattern The pattern.
 * @returns Whether the pattern covers the path.
 */
export function underPattern(pathname: string, pattern: string): boolean {
  const base = pattern.replace(/\/?\*$/, "").replace(/\/$/, "");
  if (base === "") return true;
  if (!/[:*({]/.test(base)) return pathname === base || pathname.startsWith(base + "/");
  let p = patternCache.get(base);
  if (!p) patternCache.set(base, p = new URLPattern({ pathname: `${base}{/*}?` }));
  return p.test({ pathname });
}

/**
 * Fresh 2's app builder. On denext it records what `main.ts` registers; the generated
 * `middleware.ts`, root layout and not-found page run it, as Fresh does.
 */
export class App<State = Record<string, unknown>> {
  /** @internal Middleware registered with `use()`, in order. */
  readonly _middlewares: AppMiddleware[] = [];
  /** @internal Handlers registered in code (`get()`, `post()`, …), in order. */
  readonly _routes: AppRoute[] = [];
  /** @internal Page routes registered with `route()`, in order. */
  readonly _pages: AppPageRoute[] = [];
  /** @internal Layouts registered with `layout()`, outermost first. */
  readonly _layouts: AppLayout[] = [];
  /** @internal Error handlers registered with `onError()`. */
  readonly _errors: AppErrorRoute[] = [];
  /** @internal The app wrapper registered with `appWrapper()`. */
  _appWrapper: unknown = undefined;
  /** @internal The not-found route registered with `notFound()`. */
  _notFound: AppRouteObject | undefined = undefined;
  /** @internal Calls denext does not run. */
  readonly _ignored: AppIgnored[] = [];
  /** The app's configuration. */
  readonly config: { root: string; basePath: string; mode: "development" | "production" };

  /**
   * Create the app (`new App()` in `main.ts`).
   *
   * @param config The app configuration (`basePath` is not applied: set denext's `basePath`).
   */
  constructor(
    config: { root?: string; basePath?: string; mode?: "development" | "production" } = {},
  ) {
    this.config = {
      root: config.root ?? ".",
      basePath: config.basePath ?? "",
      mode: config.mode ?? "production",
    };
    const holder = globalThis as { [APPS_KEY]?: App<unknown>[] };
    (holder[APPS_KEY] ??= []).push(this as App<unknown>);
  }

  /**
   * Add middleware, for every path or under `path`.
   *
   * @param args An optional path pattern, then middleware functions (or arrays of them).
   * @returns The app.
   */
  use(...args: unknown[]): this {
    this._middlewares.push(middlewareArgs(args));
    return this;
  }

  #route(method: Method | "ALL", pattern: string, fns: unknown[]): this {
    const handlers = fns.flat().filter((f): f is AppHandler => typeof f === "function");
    this._routes.push({ method, pattern, fns: handlers });
    return this;
  }

  /** Route GET requests to `pattern`. */
  get(pattern: string, ...fns: HandlerFn<unknown, State>[] | unknown[]): this {
    return this.#route("GET", pattern, fns);
  }
  /** Route POST requests to `pattern`. */
  post(pattern: string, ...fns: HandlerFn<unknown, State>[] | unknown[]): this {
    return this.#route("POST", pattern, fns);
  }
  /** Route PUT requests to `pattern`. */
  put(pattern: string, ...fns: HandlerFn<unknown, State>[] | unknown[]): this {
    return this.#route("PUT", pattern, fns);
  }
  /** Route PATCH requests to `pattern`. */
  patch(pattern: string, ...fns: HandlerFn<unknown, State>[] | unknown[]): this {
    return this.#route("PATCH", pattern, fns);
  }
  /** Route DELETE requests to `pattern`. */
  delete(pattern: string, ...fns: HandlerFn<unknown, State>[] | unknown[]): this {
    return this.#route("DELETE", pattern, fns);
  }
  /** Route HEAD requests to `pattern`. */
  head(pattern: string, ...fns: HandlerFn<unknown, State>[] | unknown[]): this {
    return this.#route("HEAD", pattern, fns);
  }
  /** Route requests of any method to `pattern`. */
  all(pattern: string, ...fns: HandlerFn<unknown, State>[] | unknown[]): this {
    return this.#route("ALL", pattern, fns);
  }

  /**
   * A WebSocket endpoint at `path` (works where denext has the raw request: `denext start` and
   * `denext dev`).
   *
   * @param path The URL pattern.
   * @param handlers The socket's handlers.
   * @param options The upgrade options.
   * @returns The app.
   */
  ws(path: string, handlers: WebSocketHandlers, options?: WebSocketUpgradeOptions): this {
    return this.get(path, (ctx: Context<never>) => ctx.upgrade(handlers, options));
  }

  /**
   * Fresh's file routes. denext serves them from `app/` (the migration generated it), so this
   * records nothing.
   *
   * @param _pattern The prefix the routes mount under.
   * @returns The app.
   */
  fsRoutes(_pattern?: string): this {
    return this;
  }

  /**
   * The component every page renders inside (as `routes/_app` does); the generated root layout
   * renders it.
   *
   * @param component The app wrapper.
   * @returns The app.
   */
  appWrapper(component: unknown): this {
    this._appWrapper = component;
    return this;
  }

  /**
   * A layout for the pages under `path`, inside the ones registered before it.
   *
   * @param path The path pattern.
   * @param component The layout component.
   * @param config Skip the app wrapper, or the layouts registered before it.
   * @returns The app.
   */
  layout(path: string, component: unknown, config?: LayoutConfig): this {
    this._layouts.push({ path, component, config });
    return this;
  }

  /**
   * The error handler for errors raised under `path` (the most specific one answers).
   *
   * @param path The path pattern.
   * @param route A route (its component renders with `ctx.error`) or a middleware.
   * @returns The app.
   */
  onError(path: string, route?: unknown): this {
    this._errors.push({ path, route: routeObject(route) });
    return this;
  }

  /**
   * What a request no route matches answers with: a route (its component renders as the
   * not-found page) or a middleware.
   *
   * @param route The route or middleware.
   * @returns The app.
   */
  notFound(route?: unknown): this {
    this._notFound = routeObject(route);
    return this;
  }

  /**
   * A page route registered in code: its handler runs in `middleware.ts`, its component renders
   * inside the app wrapper and the code layouts.
   *
   * @param path The URL pattern.
   * @param route The route, or a function loading it.
   * @param config The route config.
   * @returns The app.
   */
  route(path: string, route?: unknown, config?: RouteConfig): this {
    const loaded = typeof route === "function"
      ? route as () => Promise<AppRouteObject>
      : routeObject(route);
    this._pages.push({ pattern: path, route: loaded, config });
    return this;
  }

  /**
   * Merge another app's middleware, routes, layouts and error handlers under `path` (its app
   * wrapper and not-found route replace this one's).
   *
   * @param path The prefix.
   * @param app The app.
   * @returns The app.
   */
  mountApp(path: string, app?: unknown): this {
    if (!(app instanceof App)) return this;
    for (const m of app._middlewares) {
      this._middlewares.push({ ...m, path: joinPath(path, m.path) });
    }
    for (const r of app._routes) this._routes.push({ ...r, pattern: joinPath(path, r.pattern) });
    for (const r of app._pages) this._pages.push({ ...r, pattern: joinPath(path, r.pattern) });
    for (const l of app._layouts) this._layouts.push({ ...l, path: joinPath(path, l.path) });
    for (const e of app._errors) this._errors.push({ ...e, path: joinPath(path, e.path) });
    if (app._appWrapper !== undefined) this._appWrapper = app._appWrapper;
    if (app._notFound !== undefined) this._notFound = app._notFound;
    return this;
  }

  /** Not run on denext (islands are the `"use client"` files); listed in the migration report. */
  islands(..._args: unknown[]): this {
    this._ignored.push({ call: "islands" });
    return this;
  }

  /**
   * denext serves the app (`denext start` / `denext dev`), so this does nothing.
   *
   * @param _options The listen options.
   */
  listen(_options?: ListenOptions): Promise<void> {
    return Promise.resolve();
  }

  /**
   * A request handler for the app. Not available on denext, which serves the app itself.
   *
   * @throws Always.
   */
  handler(): (request: Request) => Promise<Response> {
    throw new Error(
      "denext/fresh: app.handler() is not available; denext serves the app (denext start)",
    );
  }
}
