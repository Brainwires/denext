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
import {
  type App,
  type AppHandler,
  type AppPageRoute,
  type AppRouteObject,
  constructedApps,
  underPattern,
} from "./app.ts";
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
  /**
   * The internal path of the generated page that renders what `main.ts` registered in code: an
   * `app.route()` page, a handler's `ctx.render()` / `page()`, an `app.onError()` component.
   */
  appRoute?: string;
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
export function appOf(main: unknown): App<unknown> | null {
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

/** Each lazy `app.route()` route, once loaded. */
const loadedRoutes = new WeakMap<AppPageRoute, AppRouteObject>();

/** A code page route's route object (loading a lazy one). */
async function loadPageRoute(p: AppPageRoute): Promise<AppRouteObject> {
  if (typeof p.route !== "function") return p.route;
  let loaded = loadedRoutes.get(p);
  if (!loaded) loadedRoutes.set(p, loaded = await p.route());
  return loaded;
}

/** A route object as a route module (`component` is the page, `handler` its handler). */
function routeModule(route: AppRouteObject, config?: RouteConfig): FreshModule {
  return { default: route.component, handler: route.handler, config: config ?? route.config };
}

/**
 * A route registered in code, as a file route entry: a page renders at the generated app-route
 * page (`spec.appRoute`), a handler-only route is answered by the middleware.
 */
function codeEntry(spec: FreshAppSpec, id: string, pattern: string, mod: FreshModule) {
  const page = typeof mod.default === "function";
  const where = page ? (spec.appRoute ? { internal: spec.appRoute } : {}) : { inMiddleware: true };
  return { id, pattern, mod, page, middlewares: [], layouts: [], ...where } as FreshRouteEntry;
}

/**
 * The URL pattern of a code page route: its `routeOverride` (from the config beside it, or a
 * loaded route's own), else its path.
 */
function pagePattern(p: AppPageRoute): string {
  const own = typeof p.route === "function" ? undefined : p.route.config;
  return (p.config ?? own)?.routeOverride ?? p.pattern;
}

/** The first `app.route()` page route matching `pathname`, with its parameters. */
async function matchPageRoute(
  spec: FreshAppSpec,
  app: App<unknown> | null,
  pathname: string,
): Promise<{ entry: FreshRouteEntry; params: Record<string, string> } | null> {
  for (const p of app?._pages ?? []) {
    const pattern = pagePattern(p);
    const params = matchPattern(pattern, pathname);
    if (!params) continue;
    const route = await loadPageRoute(p);
    const mod = routeModule(route, p.config);
    return { entry: codeEntry(spec, `app:${pattern}`, pattern, mod), params };
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

/** Whether a code handler rendered a page (`ctx.render(<jsx />)`, `page(data)`). */
function renderedPage(fr: FreshRequest, out: unknown): boolean {
  return isPageResponse(out) || (out instanceof Response && isContinue(fr, out));
}

/**
 * A handler registered in code (`app.get()`, …), after its route middleware. A page it renders
 * goes to the generated app-route page.
 */
function dispatchAppRoute(
  fr: FreshRequest,
  spec: FreshAppSpec,
  appRoute: NonNullable<ReturnType<typeof matchAppRoute>>,
): Promise<Response> {
  const v1 = spec.v1 === true;
  const handler = appRoute.fns.at(-1) as AnyFn | undefined;
  const before = appRoute.fns.slice(0, -1) as AnyFn[];
  return runChain(fr.ctx, before, v1, () => appHandlerResult(fr, spec, appRoute.pattern, handler));
}

/** What a code handler answers: its Response, or the page it rendered (at the app-route page). */
async function appHandlerResult(
  fr: FreshRequest,
  spec: FreshAppSpec,
  pattern: string,
  handler: AnyFn | undefined,
): Promise<Response> {
  const out = handler ? await call(handler, fr.ctx, spec.v1 === true) : undefined;
  if (spec.appRoute && renderedPage(fr, out)) {
    adoptCodePage(fr, spec, `app:${pattern}`, pattern, {});
    return out instanceof Response ? out : pageResult(fr, entries.get(fr)!, out);
  }
  if (out instanceof Response) return out;
  throw new Error(`app route ${pattern}: a handler registered in code must return a Response`);
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
  if (appRoute) return await dispatchAppRoute(fr, spec, appRoute);
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

/** The `app.onError()` handler for `pathname`: the one with the most specific path. */
function errorRouteFor(app: App<unknown> | null, pathname: string): AppRouteObject | null {
  let best: { route: AppRouteObject; depth: number } | null = null;
  for (const e of app?._errors ?? []) {
    if (!underPattern(pathname, e.path)) continue;
    const depth = e.path.replace(/\/?\*$/, "").split("/").filter(Boolean).length;
    if (!best || depth >= best.depth) best = { route: e.route, depth };
  }
  return best?.route ?? null;
}

/**
 * Answer an error with `main.ts`'s `app.onError()` handler (a 404 renders the not-found page
 * instead): its handler's Response, else what it rendered or its component (with `ctx.error`) at
 * the generated app-route page. Null: no handler applies.
 */
async function codeErrorResult(
  fr: FreshRequest,
  spec: FreshAppSpec,
  builder: App<unknown> | null,
  error: unknown,
  rc: RequestContext | undefined,
): Promise<MiddlewareResult | null> {
  const status = error instanceof HttpError ? error.status : 500;
  const route = status === 404 ? null : errorRouteFor(builder, fr.ctx.url.pathname);
  if (!route) return null;
  if (!(error instanceof HttpError)) console.error(error);
  fr.ctx.error = error;
  const out = await callRouteObject(fr, route, spec.v1 === true);
  if (out instanceof Response && !isContinue(fr, out)) return out;
  const rendered = out instanceof Response; // `ctx.render(<jsx />)`: the outcome is set
  if (!spec.appRoute || (!rendered && typeof route.component !== "function")) return null;
  const outcome = fr.outcome;
  adoptCodePage(fr, spec, "app:error", fr.ctx.url.pathname, routeModule(route));
  fr.outcome = rendered ? outcome : { kind: "page", data: pageData(out) };
  return finish(fr, continueResponse(fr, status), rc);
}

/** Call a route object's handler for the request's method (undefined: it has none). */
async function callRouteObject(fr: FreshRequest, route: AppRouteObject, v1: boolean) {
  const fn = handlerFor({ handler: route.handler }, fr.ctx.req.method.toUpperCase());
  return fn ? await call(fn, fr.ctx, v1) : undefined;
}

/** The page data a handler returned: `page(data)`'s data, else the value itself. */
function pageData(out: unknown): unknown {
  return isPageResponse(out) ? out.data : out;
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
  const matched = appRoute
    ? null
    : (await matchPageRoute(app, builder, pathname)) ?? matchRoute(app, pathname);
  if (appRoute) setRoute(fr.ctx, appRoute.params, appRoute.pattern);
  else if (matched) recordMatch(fr, app, matched.entry, matched.params);
  const fns = chainFor(app, builder, matched?.entry, pathname);
  try {
    const route = () => dispatchRoute(fr, app, appRoute, matched?.entry);
    return finish(fr, await runChain(fr.ctx, fns, app.v1 === true, route), rc);
  } catch (error) {
    if (isControlSignal(error)) throw error;
    return (await codeErrorResult(fr, app, builder, error, rc)) ?? errorResult(fr, error, rc);
  }
}

/** Point the request at a page registered in code, rendered at the generated app-route page. */
function adoptCodePage(
  fr: FreshRequest,
  spec: FreshAppSpec,
  id: string,
  pattern: string,
  mod: FreshModule,
): void {
  const entry = codeEntry(spec, id, pattern, mod);
  entry.page = true;
  entry.internal = spec.appRoute;
  delete entry.inMiddleware;
  const params = fr.ctx.params;
  recordMatch(fr, spec, entry, params);
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
    skipLayouts: (entry.mod.config as RouteConfig | undefined)?.skipInheritedLayouts === true,
    code: entry.id.startsWith("app:"),
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
    if (underPattern(pathname, m.path)) fns.push(...(m.fns as AnyFn[]));
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
  /** This is the root layout: the `_app` wrapper, `main.ts`'s app wrapper and code layouts. */
  app?: boolean;
  /** The `main.ts` module (Fresh 2), for its `app.appWrapper()` and `app.layout()`. */
  main?: unknown;
}

/** The `app.layout()` layouts wrapping this request's page, and whether they skip the wrapper. */
function codeLayouts(
  builder: App<unknown> | null,
  pathname: string,
  match: MatchedRoute | undefined,
): { layouts: unknown[]; skipApp: boolean } {
  let layouts: unknown[] = [];
  let skipApp = false;
  const applying = match?.skipLayouts ? [] : builder?._layouts ?? [];
  for (const l of applying.filter((l) => underPattern(pathname, l.path))) {
    const config = l.config ?? {};
    if (config.skipInheritedLayouts) layouts = [];
    skipApp ||= config.skipAppWrapper === true;
    layouts.push(l.component);
  }
  return { layouts, skipApp };
}

/** `children` inside `layouts` (outermost first), each given the content as `Component`. */
async function wrapIn(
  layouts: unknown[],
  children: unknown,
  ctx: Context,
  v1: boolean,
): Promise<unknown> {
  let content = children;
  for (const layout of layouts.toReversed()) {
    const inner = content;
    content = await renderComponent(layout, ctx, v1, { Component: () => inner });
  }
  return content;
}

/**
 * A generated `layout.tsx`: renders a Fresh `_layout` (or, with `app`, the root: `main.ts`'s
 * `app.layout()` layouts inside the `_app` wrapper or `app.appWrapper()`) around the page, as
 * its `Component`. A route (or a layout) whose config skips it renders without it.
 *
 * @param mod The layout module (the root layout of an app with no `_app`: `{}`).
 * @param opts The layout's id.
 * @returns The layout component.
 */
export function freshLayout(
  mod: FreshModule,
  opts: FreshLayoutOptions,
): (props: { children?: unknown }) => Promise<unknown> {
  return async function FreshLayout(props) {
    const fr = freshRequest(opts.v1);
    const v1 = opts.v1 === true;
    const match = fr.dispatched ? fr.match : undefined;
    if (!opts.app) {
      if (match && !match.layouts.includes(opts.id)) return props.children;
      const children = props.children;
      return await renderComponent(mod.default, fr.ctx, v1, { Component: () => children });
    }
    const builder = appOf(opts.main);
    const code = codeLayouts(builder, fr.ctx.url.pathname, match);
    const children = await wrapIn(code.layouts, props.children, fr.ctx, v1);
    const wrapper = mod.default ?? builder?._appWrapper;
    if (wrapper === undefined || match?.skipApp || code.skipApp) return children;
    return await renderComponent(wrapper, fr.ctx, v1, { Component: () => children });
  };
}

/**
 * The generated `app/fresh-app-route/page.tsx`: renders a page `main.ts` registered in code —
 * an `app.route()` page, what a code handler rendered (`ctx.render()`), an `app.onError()`
 * component. The middleware rewrites those requests here; a direct visit is a 404.
 *
 * @param opts Whether the app is a Fresh 1.x app.
 * @returns The page component.
 */
export function freshAppPage(opts: { v1?: boolean } = {}): () => Promise<unknown> {
  return async function FreshAppPage() {
    const fr = freshRequest(opts.v1);
    const match = fr.dispatched ? fr.match : undefined;
    if (!match?.code) notFound();
    return await renderOutcome(fr, match.mod, { id: match.id, v1: opts.v1 });
  };
}

/** Options of the generated not-found page. */
export interface FreshNotFoundOptions extends FreshFileOptions {
  /** The `main.ts` module (Fresh 2), for its `app.notFound()`. */
  main?: unknown;
}

/**
 * Render `main.ts`'s `app.notFound()` route: its handler first (a redirect is followed; another
 * Response's text is the page's content, at its status), then its component.
 */
async function renderNotFoundRoute(
  fr: FreshRequest,
  route: AppRouteObject,
  v1: boolean,
): Promise<unknown> {
  const out = await callRouteObject(fr, route, v1);
  if (out instanceof Response && !isContinue(fr, out)) {
    const location = out.headers.get("location");
    if (location && out.status >= 300 && out.status < 400) componentResponse(out);
    setStatus(out.status);
    return await out.text();
  }
  if (fr.outcome?.kind === "vnode") return fr.outcome.vnode;
  fr.ctx.data = pageData(out);
  return await renderComponent(route.component, fr.ctx, v1);
}

/**
 * The generated `not-found.tsx`: renders the app's `_404` page (or its `_error` page with a 404
 * `HttpError`), else `main.ts`'s `app.notFound()`.
 *
 * @param mod The `_404` or `_error` module (none: only `app.notFound()`).
 * @param opts The page's id and the `main.ts` module.
 * @returns The not-found component.
 */
export function freshNotFound(
  mod: FreshModule | undefined,
  opts: FreshNotFoundOptions,
): () => Promise<unknown> {
  return async function FreshNotFound() {
    const fr = freshRequest(opts.v1);
    fr.ctx.error = new HttpError(404);
    const route = mod?.default === undefined ? appOf(opts.main)?._notFound : undefined;
    if (route) return await renderNotFoundRoute(fr, route, opts.v1 === true);
    return await renderComponent(mod?.default, fr.ctx, opts.v1 === true);
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
