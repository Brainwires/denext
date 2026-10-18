/**
 * `denext/fresh` — Fresh's server API (`fresh` / `jsr:@fresh/core`, and 1.x's
 * `$fresh/server.ts`) for an app `denext migrate --from fresh` converted: `page`,
 * `createDefine`, `HttpError`, the `App` builder a `main.ts` uses, Fresh's middleware
 * (`staticFiles`, `trailingSlashes`, `csrf`, `cors`, `csp`, `ipFilter`), Fresh 1.x's
 * `defineRoute` / `defineApp` / `defineLayout` / `defineConfig`, and the Fresh types.
 *
 * The routes keep their Fresh shape: the generated `app/` files and `middleware.ts` run them
 * through `denext/fresh/server`.
 *
 * @module
 */

import type { Context } from "./context.ts";
import type {
  HandlerByMethod,
  HandlerFn,
  Middleware,
  PageProps,
  PageResponse,
  RouteHandler,
} from "./types.ts";

export { App } from "./app.ts";
export { HttpError } from "./http-error.ts";
export {
  cors,
  type CORSOptions,
  csp,
  type CSPOptions,
  csrf,
  type CsrfOptions,
  ipFilter,
  type IpFilterOptions,
  type IpFilterRules,
  staticFiles,
  trailingSlashes,
} from "./middlewares.ts";
export type { Context, Context as FreshContext } from "./context.ts";
export type * from "./types.ts";

/**
 * What a page handler returns to render the page with `data` (and an optional status and
 * headers).
 *
 * @param data The page data (`props.data`).
 * @param options The response status and headers.
 * @returns The page response.
 */
export function page<T>(
  data: T,
  options?: { headers?: HeadersInit; status?: number },
): PageResponse<T>;
/**
 * Render the page with no data.
 *
 * @returns The page response.
 */
export function page(): PageResponse<undefined>;
export function page<T>(
  data?: T,
  options?: { headers?: HeadersInit; status?: number },
): PageResponse<T> {
  return { data: data as T, headers: options?.headers, status: options?.status };
}

/** The typed identity helpers {@link createDefine} returns. */
export interface Define<State> {
  /** Type a route's handlers. */
  handlers<Data, Handlers extends RouteHandler<Data, State> = RouteHandler<Data, State>>(
    handlers: Handlers,
  ): Handlers;
  /** Type a page component (`define.page<typeof handler>(…)` types `props.data`). */
  page<
    // deno-lint-ignore no-explicit-any
    Handler extends RouteHandler<any, State> = never,
    Data = Handler extends HandlerFn<infer D, State> ? D
      : Handler extends HandlerByMethod<infer D, State> ? D
      : never,
  >(render: (props: PageProps<Data, State>) => unknown): (props: PageProps<Data, State>) => unknown;
  /** Type a middleware (or a list of them). */
  middleware<M extends Middleware<State> | Middleware<State>[]>(middleware: M): M;
  /** Type a layout component. */
  layout(
    render: (props: PageProps<unknown, State>) => unknown,
  ): (props: PageProps<unknown, State>) => unknown;
}

/**
 * Typed identity helpers for handlers, pages, layouts and middleware, all sharing the app's
 * `State` type (`export const define = createDefine<State>()`).
 *
 * @returns The helpers.
 */
export function createDefine<State>(): Define<State> {
  return {
    handlers: (handlers) => handlers,
    page: (render) => render,
    middleware: (middleware) => middleware,
    layout: (render) => render,
  };
}

/** A Fresh 1.x async route / layout / app component `(req, ctx)`. */
export type AsyncRoute<T = unknown, State = Record<string, unknown>> = (
  req: Request,
  ctx: Context<State, T>,
) => Promise<unknown>;

/** Make `fn` async, as Fresh 1.x's define helpers do (it is then called with `(req, ctx)`). */
function asAsync<T, S>(
  fn: (req: Request, ctx: Context<S, T>) => unknown,
): AsyncRoute<T, S> {
  if (fn.constructor.name === "AsyncFunction") return fn as AsyncRoute<T, S>;
  // deno-lint-ignore require-await
  return async (req, ctx) => fn(req, ctx);
}

/**
 * Fresh 1.x: an async route component, called with `(req, ctx)`.
 *
 * @param fn The route component.
 * @returns The async component.
 */
export function defineRoute<T, S = Record<string, unknown>>(
  fn: (req: Request, ctx: Context<S, T>) => unknown,
): AsyncRoute<T, S> {
  return asAsync(fn);
}

/**
 * Fresh 1.x: an async layout component, called with `(req, ctx)`.
 *
 * @param fn The layout component.
 * @returns The async component.
 */
export function defineLayout<T, S = Record<string, unknown>>(
  fn: (req: Request, ctx: Context<S, T>) => unknown,
): AsyncRoute<T, S> {
  return asAsync(fn);
}

/**
 * Fresh 1.x: an async `_app` component, called with `(req, ctx)`.
 *
 * @param fn The app component.
 * @returns The async component.
 */
export function defineApp<T, S = Record<string, unknown>>(
  fn: (req: Request, ctx: Context<S, T>) => unknown,
): AsyncRoute<T, S> {
  return asAsync(fn);
}

/**
 * Fresh 1.x: the app configuration (`fresh.config.ts`). Returned as is; denext reads its own
 * `denext.config.ts`.
 *
 * @param config The configuration.
 * @returns The configuration.
 */
export function defineConfig<C>(config: C): C {
  return config;
}

/**
 * Fresh 1.x: `start(manifest, config)` served the app. denext serves it (`denext start`), so
 * calling this is an error.
 *
 * @throws Always.
 */
export function start(_manifest?: unknown, _config?: unknown): Promise<never> {
  return Promise.reject(
    new Error("denext/fresh: start() is not available; run the app with `denext start`"),
  );
}

/** Fresh 1.x's status-code names (`STATUS_CODE.NotFound`). */
export const STATUS_CODE = {
  OK: 200,
  Created: 201,
  Accepted: 202,
  NoContent: 204,
  MovedPermanently: 301,
  Found: 302,
  SeeOther: 303,
  NotModified: 304,
  TemporaryRedirect: 307,
  PermanentRedirect: 308,
  BadRequest: 400,
  Unauthorized: 401,
  Forbidden: 403,
  NotFound: 404,
  MethodNotAllowed: 405,
  Conflict: 409,
  Gone: 410,
  UnprocessableEntity: 422,
  TooManyRequests: 429,
  InternalServerError: 500,
  NotImplemented: 501,
  BadGateway: 502,
  ServiceUnavailable: 503,
} as const;
