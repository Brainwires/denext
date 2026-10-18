// Fresh 2's built-in middleware (`staticFiles`, `trailingSlashes`, `csrf`, `cors`, `csp`,
// `ipFilter`) for a migrated app's `main.ts`. Isomorphic: they only touch `ctx`.

import type { Context } from "./context.ts";
import { HttpError } from "./http-error.ts";
import type { MiddlewareFn as Mw } from "./types.ts";

/**
 * Fresh's static-file middleware. denext serves `public/` itself (the migration moved
 * `static/` there), so this only continues.
 *
 * @returns The middleware.
 */
export function staticFiles<State>(): Mw<State> {
  return (ctx) => ctx.next();
}

/**
 * Redirect to the URL with (`"always"`) or without (`"never"`) a trailing slash.
 *
 * @param mode Which form is canonical.
 * @returns The middleware.
 */
export function trailingSlashes<State>(mode: "always" | "never"): Mw<State> {
  return (ctx) => {
    const { pathname, search } = ctx.url;
    if (pathname !== "/") {
      if (mode === "always" && !pathname.endsWith("/")) {
        return ctx.redirect(`${pathname}/${search}`);
      }
      if (mode === "never" && pathname.endsWith("/")) {
        return ctx.redirect(`${pathname.slice(0, -1)}${search}`);
      }
    }
    return ctx.next();
  };
}

/** {@link csrf} options. */
export interface CsrfOptions<State = unknown> {
  /** The origins allowed to send state-changing requests (default: the request's own). */
  origin?: string | string[] | ((origin: string, ctx: Context<State>) => boolean);
}

/**
 * Refuse a cross-site state-changing request (anything but GET / HEAD / OPTIONS) with a 403, by
 * `Sec-Fetch-Site` and `Origin`.
 *
 * @param options The allowed origins.
 * @returns The middleware.
 */
export function csrf<State>(options?: CsrfOptions<State>): Mw<State> {
  const allowed = (origin: string | null, ctx: Context<State>): boolean => {
    if (origin === null) return false;
    const rule = options?.origin;
    if (!rule) return origin === ctx.url.origin;
    if (typeof rule === "string") return origin === rule;
    if (typeof rule === "function") return rule(origin, ctx);
    return rule.includes(origin);
  };
  return (ctx) => {
    const { method, headers } = ctx.req;
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") return ctx.next();
    const site = headers.get("sec-fetch-site");
    const origin = headers.get("origin");
    if (site !== null) {
      if (site === "same-origin" || site === "none" || allowed(origin, ctx)) return ctx.next();
      throw new HttpError(403);
    }
    if (origin === null || allowed(origin, ctx)) return ctx.next();
    throw new HttpError(403);
  };
}

/** {@link cors} options. */
export interface CORSOptions<State = unknown> {
  /** The allowed origin(s), `"*"`, or a function choosing the `Access-Control-Allow-Origin`. */
  origin: string | string[] | ((origin: string, ctx: Context<State>) => string | undefined | null);
  /** Methods a preflight allows. */
  allowMethods?: string[];
  /** Request headers a preflight allows (default: those asked for). */
  allowHeaders?: string[];
  /** Seconds a preflight may be cached. */
  maxAge?: number;
  /** Allow credentials. */
  credentials?: boolean;
  /** Response headers the page may read. */
  exposeHeaders?: string[];
}

/** The `Access-Control-Allow-Origin` value for this request (null: none). */
function corsOrigin<State>(opts: CORSOptions<State>, ctx: Context<State>): string | null {
  const requestOrigin = ctx.req.headers.get("origin") ?? "";
  const rule = opts.origin;
  if (typeof rule === "string") return rule === "*" || rule === requestOrigin ? rule : null;
  if (typeof rule === "function") return rule(requestOrigin, ctx) ?? null;
  return rule.includes(requestOrigin) ? requestOrigin : null;
}

/** The CORS headers every answer carries. */
function corsHeaders<State>(opts: CORSOptions<State>, origin: string | null): Headers {
  const headers = new Headers();
  if (origin) headers.set("access-control-allow-origin", origin);
  if (opts.credentials) headers.set("access-control-allow-credentials", "true");
  if (opts.exposeHeaders?.length) {
    headers.set("access-control-expose-headers", opts.exposeHeaders.join(","));
  }
  if (origin && origin !== "*" && opts.origin !== "*") headers.set("vary", "Origin");
  return headers;
}

/** A preflight's answer. */
function preflight<State>(opts: CORSOptions<State>, origin: string | null, ctx: Context<State>) {
  const headers = corsHeaders(opts, origin);
  if (opts.maxAge != null) headers.set("access-control-max-age", String(opts.maxAge));
  if (opts.allowMethods?.length) {
    headers.set("access-control-allow-methods", opts.allowMethods.join(","));
  }
  const asked = ctx.req.headers.get("access-control-request-headers");
  const allowHeaders = opts.allowHeaders?.length ? opts.allowHeaders : asked?.split(/\s*,\s*/);
  if (allowHeaders?.length) {
    headers.set("access-control-allow-headers", allowHeaders.join(","));
    headers.append("vary", "Access-Control-Request-Headers");
  }
  return new Response(null, { status: 204, headers });
}

/**
 * Answer CORS preflights and add the CORS headers to every response.
 *
 * @param options The policy (default: any origin).
 * @returns The middleware.
 */
export function cors<State>(options?: CORSOptions<State>): Mw<State> {
  const opts: CORSOptions<State> = {
    origin: "*",
    allowMethods: ["GET", "HEAD", "PUT", "POST", "DELETE", "PATCH"],
    ...options,
  };
  return async (ctx) => {
    const origin = corsOrigin(opts, ctx);
    if (ctx.req.method === "OPTIONS") return preflight(opts, origin, ctx);
    const res = await ctx.next();
    for (const [k, v] of corsHeaders(opts, origin)) res.headers.set(k, v);
    return res;
  };
}

/** {@link csp} options. */
export interface CSPOptions {
  /** Report-only. */
  reportOnly?: boolean;
  /** Where violations are reported. */
  reportTo?: string;
  /** Extra directives. */
  csp?: string[];
}

/**
 * Fresh's content-security-policy middleware. denext sends its own policy (the `csp` config
 * key, strict by default), so this only continues; set the directives there instead.
 *
 * @param _options The policy (unused).
 * @returns The middleware.
 */
export function csp<State>(_options?: CSPOptions): Mw<State> {
  return (ctx) => ctx.next();
}

/** {@link ipFilter} rules: addresses or IPv4 CIDR ranges. */
export interface IpFilterRules {
  /** Refused. */
  denyList?: string[];
  /** The only ones accepted, when given. */
  allowList?: string[];
}

/** {@link ipFilter} options. */
export interface IpFilterOptions {
  /** The answer to a refused client (default: a 403). */
  onBlocked?: <State>(
    remote: { addr: string; type: "IPv4" | "IPv6" },
    ctx: Context<State>,
  ) => Response | Promise<Response>;
}

/** An IPv4 address as a 32-bit number (null for anything else). */
function ipv4(addr: string): number | null {
  const parts = addr.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!/^\d{1,3}$/.test(p) || v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

/** Whether `addr` is `rule` or inside the IPv4 range `rule` (`10.0.0.0/8`). */
function ipMatches(addr: string, rule: string): boolean {
  if (addr === rule) return true;
  const [net, bits] = rule.split("/");
  const a = ipv4(addr);
  const b = ipv4(net);
  if (a === null || b === null || bits === undefined) return false;
  const size = Number(bits);
  if (!(size >= 0 && size <= 32)) return false;
  const shift = 32 - size;
  return Math.floor(a / 2 ** shift) === Math.floor(b / 2 ** shift);
}

/**
 * Accept or refuse a client by its address.
 *
 * @param rules The deny / allow lists.
 * @param options The refusal answer.
 * @returns The middleware.
 */
export function ipFilter<State>(rules: IpFilterRules, options?: IpFilterOptions): Mw<State> {
  return (ctx) => {
    const addr = ctx.info.remoteAddr.transport === "tcp"
      ? (ctx.info.remoteAddr as Deno.NetAddr).hostname
      : "";
    const denied = rules.denyList?.some((r) => ipMatches(addr, r)) ?? false;
    const allowed = rules.allowList ? rules.allowList.some((r) => ipMatches(addr, r)) : true;
    if (!denied && allowed) return ctx.next();
    const type = addr.includes(":") ? "IPv6" : "IPv4";
    return options?.onBlocked?.({ addr, type }, ctx) ??
      new Response("Forbidden", { status: 403 });
  };
}
