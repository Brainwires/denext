// Fresh 2's `App` on denext. A migrated app's `main.ts` still builds one (`new App()`,
// `app.use(…)`, `app.get(…)`, `app.fsRoutes()`); this class records the middleware and routes it
// registers, and the generated `middleware.ts` runs them. denext serves the app, so `listen()` and
// `handler()` do nothing.

import type { Context } from "./context.ts";
import type { HandlerFn, ListenOptions, Method } from "./types.ts";

/** A middleware or a route handler registered on an {@link App}. */
export type AppHandler = (ctx: Context<never>) => unknown;

/** A middleware registered with `app.use()`. */
export interface AppMiddleware {
  /** The path prefix it applies under (`/` for every path). */
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

/** Something an app registered that denext does not run, for the migration report. */
export interface AppIgnored {
  /** The method called (`appWrapper`, `layout`, `onError`, `notFound`, `mountApp`, `route`). */
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
  const path = typeof args[0] === "string" ? args.shift() as string : "/";
  const fns = (args as unknown[]).flat().filter((f): f is AppHandler => typeof f === "function");
  return { path, fns };
}

/**
 * Fresh 2's app builder. On denext it records `use()` middleware and the routes registered in
 * code; the generated `middleware.ts` runs them before the file routes, as Fresh does.
 */
export class App<State = Record<string, unknown>> {
  /** @internal Middleware registered with `use()`, in order. */
  readonly _middlewares: AppMiddleware[] = [];
  /** @internal Routes registered in code, in order. */
  readonly _routes: AppRoute[] = [];
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
   * @param args An optional path prefix, then middleware functions (or arrays of them).
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
   * Fresh's file routes. denext serves them from `app/` (the migration generated it), so this
   * records nothing.
   *
   * @param _pattern The prefix the routes mount under.
   * @returns The app.
   */
  fsRoutes(_pattern?: string): this {
    return this;
  }

  /** Not run on denext (the `_app` route is `app/layout.tsx`); listed in the migration report. */
  appWrapper(_component: unknown): this {
    this._ignored.push({ call: "appWrapper" });
    return this;
  }
  /** Not run on denext (use a `_layout` file); listed in the migration report. */
  layout(path: string, _component: unknown, _config?: unknown): this {
    this._ignored.push({ call: "layout", path });
    return this;
  }
  /** Not run on denext (use an `_error` file); listed in the migration report. */
  onError(path: string, _route?: unknown): this {
    this._ignored.push({ call: "onError", path });
    return this;
  }
  /** Not run on denext (use a `_404` file); listed in the migration report. */
  notFound(_route?: unknown): this {
    this._ignored.push({ call: "notFound" });
    return this;
  }
  /** Not run on denext; listed in the migration report. */
  route(path: string, _route?: unknown, _config?: unknown): this {
    this._ignored.push({ call: "route", path });
    return this;
  }
  /** Not run on denext; listed in the migration report. */
  mountApp(path: string, _app?: unknown): this {
    this._ignored.push({ call: "mountApp", path });
    return this;
  }
  /** Not run on denext; listed in the migration report. */
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
