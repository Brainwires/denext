/**
 * `denext/fresh/server` — the runtime behind the files `denext migrate --from fresh` generates:
 * the root `middleware.ts` ({@link freshMiddleware}) and the `app/` pages
 * ({@link freshPage}), layouts ({@link freshLayout}), not-found page ({@link freshNotFound})
 * and route handlers ({@link freshRouteHandler}) that run the app's Fresh route modules.
 *
 * A request runs the way Fresh runs it. The middleware builds the Fresh `ctx`, matches the
 * route, and runs `main.ts`'s `app.use()` middleware and the `_middleware` files around the
 * route's handler. A handler's `Response` is the answer; `page(data)` (Fresh 1.x:
 * `ctx.render(data)`) hands the data to the page, which denext renders inside the layouts —
 * with the status and headers `page()` and the middleware set, the state middleware set, and
 * for any method (a form POST that re-renders the page). `ctx.next()` resolves with a stand-in
 * response for the page (its status and headers; no body). An `HttpError` renders the
 * not-found page (404) or the route's `_error` page.
 *
 * @module
 */

import { h } from "../../jsx/jsx-runtime.ts";
import { currentContext, type RequestContext } from "../../server/request-context.ts";
import { type MiddlewareResult, next, rewrite } from "../../server/middleware.ts";
import { isControlSignal, notFound, redirect } from "../../runtime/error-boundary.ts";
import { type App, type AppHandler, constructedApps } from "./app.ts";
import {
  type Context,
  CONTINUE_HEADER,
  continueResponse,
  createFreshRequest,
  type FreshModule,
  type FreshOutcome,
  type FreshRequest,
  freshRequest,
  isContinue,
  isPageResponse,
  type MatchedRoute,
} from "./context.ts";
import { HttpError } from "./http-error.ts";
import type { LayoutConfig, RouteConfig } from "./types.ts";
import type { Component } from "../../jsx/types.ts";

export type { FreshModule } from "./context.ts";

/** A `_middleware` file. */
export interface FreshMiddlewareEntry {
  /** Its id (its directory under `routes/`). */
  id: string;
  /**
   * The URL prefix it covers when no route matched (null for a directory whose path holds a
   * route group or a parameter: it runs only for the routes inside it).
   */
  prefix: string | null;
  /** The module. */
  mod: FreshModule;
}

/** A `_layout` file. */
export interface FreshLayoutEntry {
  /** Its id (its directory under `routes/`). */
  id: string;
  /** The module (its `config` may skip the app wrapper or the layouts above it). */
  mod: FreshModule;
}

/** A file route. */
export interface FreshRouteEntry {
  /** Its id (its path under `routes/`, without the extension). */
  id: string;
  /** Its URL pattern (Fresh's, a `URLPattern` pathname; a `routeOverride` when it has one). */
  pattern: string;
  /** The module. */
  mod: FreshModule;
  /** It has a page component. */
  page: boolean;
  /** The `_middleware` files that wrap it, outermost first (indices into `middlewares`). */
  middlewares: number[];
  /** The `_layout` files that wrap it, outermost first (their ids). */
  layouts: string[];
  /**
   * A page whose URL pattern the `app/` folder tree cannot express (a `routeOverride`, an
   * optional or partial-segment parameter): the path its generated page lives at, which the
   * middleware rewrites the request to.
   */
  internal?: string;
  /** A handler-only route the folder tree cannot express: answered by the middleware itself. */
  inMiddleware?: boolean;
}

/** What the generated `middleware.ts` passes to {@link freshMiddleware}. */
export interface FreshAppSpec {
  /** The app is a Fresh 1.x app (handlers and middleware take `(req, ctx)`). */
  v1?: boolean;
  /** The `main.ts` module (Fresh 2): its `App`'s `use()` middleware and code routes run first. */
  main?: unknown;
  /** The `_middleware` files. */
  middlewares: FreshMiddlewareEntry[];
  /** The `_layout` files. */
  layouts: FreshLayoutEntry[];
  /** The file routes, in Fresh's match order. */
  routes: FreshRouteEntry[];
}

type AnyFn = (...args: unknown[]) => unknown;

/** The handler a module has for `method` (HEAD falls back to GET), or null. */
function handlerFor(mod: FreshModule, method: string): AnyFn | null {
  const handlers = mod.handlers ?? mod.handler;
  if (typeof handlers === "function") return handlers as AnyFn;
  if (typeof handlers !== "object" || handlers === null || Array.isArray(handlers)) return null;
  const byMethod = handlers as Record<string, AnyFn | undefined>;
  const fn = byMethod[method] ?? (method === "HEAD" ? byMethod.GET : undefined);
  return typeof fn === "function" ? fn : null;
}

/** A module's middleware functions (`handler` / `handlers` / default; one or a list). */
function middlewareFns(mod: FreshModule): AnyFn[] {
  const value = mod.handlers ?? mod.handler ?? mod.default;
  const list = Array.isArray(value) ? value : [value];
  return list.filter((f): f is AnyFn => typeof f === "function");
}

/** Call a handler or middleware the way the app's Fresh version does. */
function call(fn: AnyFn, ctx: Context, v1: boolean): unknown {
  return v1 ? fn(ctx.req, ctx) : fn(ctx);
}

const patterns = new Map<string, URLPattern>();

/** Match `pathname` against a Fresh pattern; its parameters, or null. */
function matchPattern(pattern: string, pathname: string): Record<string, string> | null {
  let p = patterns.get(pattern);
  if (!p) patterns.set(pattern, p = new URLPattern({ pathname: pattern }));
  const m = p.exec({ pathname });
  if (!m) return null;
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(m.pathname.groups)) {
    if (v !== undefined) params[k] = decodeURIComponent(v);
  }
  return params;
}

/** Whether `pathname` is at or under the prefix `prefix`. */
function underPrefix(pathname: string, prefix: string): boolean {
  if (prefix === "" || prefix === "/") return true;
  const base = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  return pathname === base || pathname.startsWith(base + "/");
}

/** The `App` a `main.ts` module built: its `app` / default export, else the last one constructed. */
function appOf(main: unknown): App<unknown> | null {
  if (main === undefined) return null;
  const mod = main as { app?: unknown; default?: unknown };
  for (const candidate of [mod.app, mod.default]) {
    if (candidate && typeof candidate === "object" && "_middlewares" in candidate) {
      return candidate as App<unknown>;
    }
  }
  const apps = constructedApps();
  return apps.length ? apps[apps.length - 1] : null;
}

/** The layouts that wrap a route, and whether the app wrapper does, after the skip configs. */
function wrapping(
  spec: FreshAppSpec,
  entry: FreshRouteEntry,
): { layouts: string[]; skipApp: boolean } {
  const config = entry.mod.config as RouteConfig | undefined;
  let skipApp = config?.skipAppWrapper === true;
  if (config?.skipInheritedLayouts) return { layouts: [], skipApp };
  let layouts: string[] = [];
  for (const id of entry.layouts) {
    const lc = spec.layouts.find((l) => l.id === id)?.mod.config as LayoutConfig | undefined;
    if (lc?.skipInheritedLayouts) layouts = [];
    if (lc?.skipAppWrapper) skipApp = true;
    layouts.push(id);
  }
  return { layouts, skipApp };
}

/** The first file route matching `pathname`, with its parameters. */
function matchRoute(
  spec: FreshAppSpec,
  pathname: string,
): { entry: FreshRouteEntry; params: Record<string, string> } | null {
  for (const entry of spec.routes) {
    const params = matchPattern(entry.pattern, pathname);
    if (params) return { entry, params };
  }
  return null;
}

/** The first code route (`app.get(…)`) matching the request. */
function matchAppRoute(
  app: App<unknown> | null,
  method: string,
  pathname: string,
): { fns: AppHandler[]; params: Record<string, string>; pattern: string } | null {
  for (const r of app?._routes ?? []) {
    const methodOk = r.method === "ALL" || r.method === method ||
      (method === "HEAD" && r.method === "GET");
    if (!methodOk) continue;
    const params = matchPattern(r.pattern, pathname);
    if (params) return { fns: r.fns, params, pattern: r.pattern };
  }
  return null;
}

/**
 * Run `fns` as a middleware chain around `terminal`: each one's `ctx.next()` runs the rest. A
 * middleware that returns no response continues with the rest of the chain.
 */
function runChain(
  ctx: Context,
  fns: AnyFn[],
  v1: boolean,
  terminal: () => Promise<Response>,
): Promise<Response> {
  const step = (i: number): () => Promise<Response> => {
    let pending: Promise<Response> | undefined;
    return () =>
      pending ??= (async () => {
        if (i >= fns.length) return await terminal();
        const rest = step(i + 1);
        ctx.next = rest;
        const result = await call(fns[i], ctx, v1);
        return result instanceof Response ? result : await rest();
      })();
  };
  return step(0)();
}

/** What a page route's handler returned, as the response the middleware chain sees. */
function pageResult(fr: FreshRequest, route: FreshRouteEntry, result: unknown): Response {
  if (result instanceof Response) return result;
  if (isPageResponse(result)) {
    if (!route.page) {
      throw new Error(`routes/${route.id}: page() returned by a route without a page component`);
    }
    fr.outcome = { kind: "page", data: result.data };
    return continueResponse(fr, result.status, result.headers);
  }
  fr.outcome = { kind: "page", data: result };
  return continueResponse(fr);
}

/** The route step of the chain: a code route, a file route's handler, or the page / 404. */
async function dispatchRoute(
  fr: FreshRequest,
  spec: FreshAppSpec,
  appRoute: ReturnType<typeof matchAppRoute>,
  route: FreshRouteEntry | undefined,
): Promise<Response> {
  const { ctx } = fr;
  const v1 = spec.v1 === true;
  if (appRoute) {
    const handler = appRoute.fns.at(-1) as AnyFn | undefined;
    const before = appRoute.fns.slice(0, -1) as AnyFn[];
    return await runChain(ctx, before, v1, async () => {
      const out = handler ? await call(handler, ctx, v1) : undefined;
      if (out instanceof Response) return out;
      throw new Error(
        `app route ${appRoute.pattern}: a handler registered in code must return a Response`,
      );
    });
  }
  if (!route) return continueResponse(fr);
  // A handler-only route the `app/` tree holds runs in its generated `route.ts`.
  if (!route.page && !route.inMiddleware) return continueResponse(fr);
  const method = ctx.req.method.toUpperCase();
  const fn = handlerFor(route.mod, method);
  if (!fn) {
    if (!route.page) return new Response("Method Not Allowed", { status: 405 });
    if (method === "GET" || method === "HEAD") fr.outcome = { kind: "page", data: undefined };
    return continueResponse(fr);
  }
  return pageResult(fr, route, await call(fn, ctx, v1));
}

/** The answer to an error thrown by a handler or middleware. */
function errorResult(fr: FreshRequest, error: unknown, rc: RequestContext | undefined) {
  const status = error instanceof HttpError ? error.status : 500;
  if (!(error instanceof HttpError)) console.error(error);
  if (fr.match?.page || !fr.match) {
    // A page renders its error page (or the not-found page); with no route, denext's 404.
    fr.outcome = { kind: "error", error, status };
    return finish(fr, continueResponse(fr, status), rc);
  }
  const message = error instanceof HttpError ? error.message : "Internal Server Error";
  return new Response(message, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

/** Turn the chain's response into the middleware result: continue to the page, or answer. */
function finish(
  fr: FreshRequest,
  res: Response,
  rc: RequestContext | undefined,
): MiddlewareResult {
  if (!isContinue(fr, res)) return res;
  const headers = new Headers(res.headers);
  for (const name of [CONTINUE_HEADER, "content-type", "content-length"]) {
    headers.delete(name);
  }
  if (rc) {
    if (res.status !== 200) rc.responseStatus = res.status;
    const method = fr.ctx.req.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD" && fr.match?.page && fr.outcome) {
      rc.renderPageForMethod = true;
    }
  }
  const init = [...headers.keys()].length > 0 ? { headers } : undefined;
  const internal = entries.get(fr)?.internal;
  if (internal) return rewrite(internal, init);
  return next(init);
}

/** The route entry each request matched (for the rewrite to an internal page). */
const entries = new WeakMap<FreshRequest, FreshRouteEntry>();

/**
 * The root middleware of a migrated Fresh app (the generated `middleware.ts` default-exports
 * it): it runs `main.ts`'s middleware and code routes, the `_middleware` files and the matched
 * route's handler, as Fresh does.
 *
 * @param app The app's middleware, layouts and routes.
 * @returns The middleware.
 */
export function freshMiddleware(
  app: FreshAppSpec,
): (request: Request) => Promise<MiddlewareResult> {
  return (request) => runFresh(app, request);
}

/** One request through the Fresh pipeline (see {@link freshMiddleware}). */
async function runFresh(app: FreshAppSpec, request: Request): Promise<MiddlewareResult> {
  const rc = currentContext();
  const fr = createFreshRequest(request, app.v1 === true);
  fr.dispatched = true;
  const builder = appOf(app.main);
  const pathname = fr.ctx.url.pathname;
  const appRoute = matchAppRoute(builder, request.method.toUpperCase(), pathname);
  const matched = appRoute ? null : matchRoute(app, pathname);
  if (appRoute) setRoute(fr.ctx, appRoute.params, appRoute.pattern);
  else if (matched) recordMatch(fr, app, matched.entry, matched.params);
  const fns = chainFor(app, builder, matched?.entry, pathname);
  try {
    const route = () => dispatchRoute(fr, app, appRoute, matched?.entry);
    return finish(fr, await runChain(fr.ctx, fns, app.v1 === true, route), rc);
  } catch (error) {
    if (isControlSignal(error)) throw error;
    return errorResult(fr, error, rc);
  }
}

/** Point the context at a matched route. */
function setRoute(ctx: Context, params: Record<string, string>, pattern: string): void {
  ctx.params = params;
  ctx.route = pattern;
  ctx.destination = "route";
}

/** Record the file route a request matched, with the layouts that wrap it. */
function recordMatch(
  fr: FreshRequest,
  app: FreshAppSpec,
  entry: FreshRouteEntry,
  params: Record<string, string>,
): void {
  const wrap = wrapping(app, entry);
  fr.match = {
    id: entry.id,
    pattern: entry.pattern,
    mod: entry.mod,
    page: entry.page,
    layouts: wrap.layouts,
    skipApp: wrap.skipApp,
  } satisfies MatchedRoute;
  entries.set(fr, entry);
  setRoute(fr.ctx, params, entry.pattern);
}

/**
 * The middleware a request runs through, in order: `main.ts`'s `app.use()` ones under its path,
 * then the `_middleware` files wrapping the matched route (with no route, those whose directory
 * prefixes the path).
 */
function chainFor(
  app: FreshAppSpec,
  builder: App<unknown> | null,
  entry: FreshRouteEntry | undefined,
  pathname: string,
): AnyFn[] {
  const fns: AnyFn[] = [];
  for (const m of builder?._middlewares ?? []) {
    if (underPrefix(pathname, m.path)) fns.push(...(m.fns as AnyFn[]));
  }
  const files = entry
    ? entry.middlewares.map((i) => app.middlewares[i])
    : app.middlewares.filter((m) => m.prefix !== null && underPrefix(pathname, m.prefix));
  for (const m of files) fns.push(...middlewareFns(m.mod));
  return fns;
}

// ── Rendering ────────────────────────────────────────────────────────────────

/** The props a Fresh component receives: the request context's fields, plus `extra`. */
function propsOf(ctx: Context, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    config: ctx.config,
    url: ctx.url,
    req: ctx.req,
    params: ctx.params,
    info: ctx.info,
    state: ctx.state,
    isPartial: ctx.isPartial,
    Component: ctx.Component,
    error: ctx.error,
    route: ctx.route,
    data: ctx.data,
    ...extra,
  };
}

/** Set the response status (unless a handler or middleware already did). */
function setStatus(status: number): void {
  const rc = currentContext();
  if (rc && rc.responseStatus === undefined) rc.responseStatus = status;
}

/** A component returned a Response: follow a redirect (keeping its cookies) or a 404. */
function componentResponse(res: Response): never {
  const rc = currentContext();
  for (const cookie of res.headers.getSetCookie()) rc?.outgoingHeaders.append("set-cookie", cookie);
  const location = res.headers.get("location");
  if (location && res.status >= 300 && res.status < 400) redirect(location, res.status);
  if (res.status === 404) notFound();
  throw new HttpError(res.status, "a component returned a Response denext cannot render in place");
}

/**
 * Render a Fresh component: an async one is called (Fresh 2 with the props, Fresh 1.x with
 * `(req, ctx)`), any other through JSX.
 */
async function renderComponent(
  component: unknown,
  ctx: Context,
  v1: boolean,
  extra: Record<string, unknown> = {},
): Promise<unknown> {
  if (typeof component !== "function") {
    return extra.Component ? h(extra.Component as Component, null) : null;
  }
  const props = propsOf(ctx, extra);
  if (component.constructor.name === "AsyncFunction") {
    const routeCtx = Object.assign(Object.create(ctx), extra);
    const out = v1 ? await component(ctx.req, routeCtx) : await component(props);
    return out instanceof Response ? componentResponse(out) : out;
  }
  return h(component as Component, props);
}

/** Options of a generated page, layout or route handler. */
export interface FreshFileOptions {
  /** The route / layout id (its path under `routes/`). */
  id: string;
  /** The app is a Fresh 1.x app. */
  v1?: boolean;
}

/** Options of a generated page. */
export interface FreshPageOptions extends FreshFileOptions {
  /** The nearest `_error` (or 1.x `_500`) page module. */
  error?: FreshModule;
  /** The page lives at an internal path the middleware rewrites to (direct visits are 404s). */
  internal?: boolean;
}

/** URL parameters as Fresh has them (a catch-all's segments joined with `/`). */
async function plainParams(params: unknown): Promise<Record<string, string>> {
  const resolved = await params as Record<string, string | string[]> | undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(resolved ?? {})) out[k] = Array.isArray(v) ? v.join("/") : v;
  return out;
}

/**
 * Run the page's GET handler in the page itself — for a render no middleware ran for (an export
 * render, a direct call). A redirect or a 404 is honored; another response cannot be.
 */
async function handleInPage(
  fr: FreshRequest,
  mod: FreshModule,
  opts: FreshPageOptions,
  params: unknown,
): Promise<void> {
  fr.ctx.params = await plainParams(params);
  fr.outcome = undefined;
  const fn = handlerFor(mod, "GET");
  if (!fn) return;
  try {
    const out = await call(fn, fr.ctx, opts.v1 === true);
    if (out instanceof Response && !isContinue(fr, out)) componentResponse(out);
    if (isPageResponse(out)) fr.outcome = { kind: "page", data: out.data };
    else if (!(out instanceof Response)) fr.outcome = { kind: "page", data: out };
  } catch (error) {
    if (isControlSignal(error)) throw error;
    fr.outcome = { kind: "error", error, status: error instanceof HttpError ? error.status : 500 };
  }
}

/** Render the error a handler raised: the not-found page for a 404, else the `_error` page. */
async function renderError(
  fr: FreshRequest,
  outcome: Extract<FreshOutcome, { kind: "error" }>,
  opts: FreshPageOptions,
): Promise<unknown> {
  if (outcome.status === 404) notFound();
  if (!opts.error?.default) throw outcome.error;
  fr.ctx.error = outcome.error;
  setStatus(outcome.status);
  return await renderComponent(opts.error.default, fr.ctx, opts.v1 === true);
}

/**
 * A generated `page.tsx`: renders a Fresh route's page component with what its handler returned
 * (the middleware ran the handler).
 *
 * @param mod The route module.
 * @param opts The route's id and its error page.
 * @returns The page component.
 */
export function freshPage(
  mod: FreshModule,
  opts: FreshPageOptions,
): (props: { params?: unknown }) => Promise<unknown> {
  return async function FreshPage(props) {
    const fr = freshRequest(opts.v1);
    const ours = fr.dispatched && fr.match?.id === opts.id;
    if (opts.internal && !ours) notFound();
    if (!ours) await handleInPage(fr, mod, opts, props.params);
    return await renderOutcome(fr, mod, opts);
  };
}

/** Render what the handler decided: the error page, the JSX it rendered, or the page with data. */
async function renderOutcome(
  fr: FreshRequest,
  mod: FreshModule,
  opts: FreshPageOptions,
): Promise<unknown> {
  const outcome = fr.outcome;
  if (outcome?.kind === "error") return await renderError(fr, outcome, opts);
  if (outcome?.kind === "vnode") return outcome.vnode;
  fr.ctx.data = outcome?.kind === "page" ? outcome.data : undefined;
  return await renderComponent(mod.default, fr.ctx, opts.v1 === true);
}

/** Options of a generated layout. */
export interface FreshLayoutOptions extends FreshFileOptions {
  /** This is the `_app` wrapper (the root layout). */
  app?: boolean;
}

/**
 * A generated `layout.tsx`: renders a Fresh `_layout` (or the `_app` wrapper) around the page,
 * as its `Component`. A route (or a layout) whose config skips it renders without it.
 *
 * @param mod The layout module.
 * @param opts The layout's id.
 * @returns The layout component.
 */
export function freshLayout(
  mod: FreshModule,
  opts: FreshLayoutOptions,
): (props: { children?: unknown }) => Promise<unknown> {
  return async function FreshLayout(props) {
    const fr = freshRequest(opts.v1);
    const children = props.children;
    const match = fr.dispatched ? fr.match : undefined;
    const applies = !match || (opts.app ? !match.skipApp : match.layouts.includes(opts.id));
    if (!applies) return children;
    const Component = () => children;
    return await renderComponent(mod.default, fr.ctx, opts.v1 === true, { Component });
  };
}

/**
 * The generated `not-found.tsx`: renders the app's `_404` page (or its `_error` page with a 404
 * `HttpError`).
 *
 * @param mod The `_404` or `_error` module.
 * @param opts The page's id.
 * @returns The not-found component.
 */
export function freshNotFound(
  mod: FreshModule,
  opts: FreshFileOptions,
): () => Promise<unknown> {
  return async function FreshNotFound() {
    const fr = freshRequest(opts.v1);
    fr.ctx.error = new HttpError(404);
    return await renderComponent(mod.default, fr.ctx, opts.v1 === true);
  };
}

/**
 * A generated `route.ts` handler: runs a handler-only Fresh route (an API route) for any method
 * its module handles. An `HttpError` answers with its status.
 *
 * @param mod The route module.
 * @param opts The route's id.
 * @returns The route handler.
 */
export function freshRouteHandler(
  mod: FreshModule,
  opts: FreshFileOptions,
): (request: Request, init?: { params?: unknown }) => Promise<Response> {
  return (request, init) => runRouteHandler(mod, opts, request, init);
}

/** One request to a handler-only route (see {@link freshRouteHandler}). */
async function runRouteHandler(
  mod: FreshModule,
  opts: FreshFileOptions,
  request: Request,
  init?: { params?: unknown },
): Promise<Response> {
  const fr = freshRequest(opts.v1);
  fr.ctx.req = request;
  if (!(fr.dispatched && fr.match?.id === opts.id)) {
    fr.ctx.params = await plainParams(init?.params);
  }
  const fn = handlerFor(mod, request.method.toUpperCase());
  if (!fn) return new Response("Method Not Allowed", { status: 405 });
  try {
    return routeResponse(opts, await call(fn, fr.ctx, opts.v1 === true));
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    return new Response(error.message, {
      status: error.status,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
}

/** A handler-only route's result: it must be a Response. */
function routeResponse(opts: FreshFileOptions, out: unknown): Response {
  if (out instanceof Response) return out;
  throw new Error(`routes/${opts.id}: a route without a page component must return a Response`);
}
