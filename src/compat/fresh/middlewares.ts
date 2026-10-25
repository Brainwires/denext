// Fresh 2's built-in middleware (`staticFiles`, `trailingSlashes`, `csrf`, `cors`, `csp`,
// `ipFilter`) for a migrated app's `main.ts`. They run in the generated `middleware.ts`, but stay
// importable from the browser (an island may import `fresh`): no static server import.

import type { RequestContext } from "../../server/request-context.ts";
import type { Context } from "./context.ts";
import { CONTINUE_HEADER } from "./constants.ts";
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
  /** Send the policy as `Content-Security-Policy-Report-Only` (nothing is enforced). */
  reportOnly?: boolean;
  /** Where violations are reported (`report-to` / `report-uri`, `Reporting-Endpoints`). */
  reportTo?: string;
  /** Directives that add to or replace the defaults (`"img-src 'self' https://cdn.example"`). */
  csp?: string[];
  /**
   * Fresh: replace `'unsafe-inline'` with a per-request nonce. denext allows its own inline
   * styles by hash and runs no inline script, so this drops `'unsafe-inline'`.
   */
  useNonce?: boolean;
}

/**
 * Fresh's default directives. `script-src` / `style-src` carry `'unsafe-inline'` for Fresh's own
 * inline boot script; denext needs none (see {@link mergeCsp}).
 */
const FRESH_CSP_DEFAULTS = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data:",
  "media-src 'self' data: blob:",
  "worker-src 'self' blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "upgrade-insecure-requests",
];

/** A directive's name (its first token). */
const directiveName = (d: string): string => d.trim().split(/\s+/)[0];

/** The directives a {@link csp} middleware sends: the defaults, overridden by `options.csp`. */
function freshDirectives(options: CSPOptions): { defaults: string[]; own: string[] } {
  const own = options.csp ?? [];
  const named = new Set(own.map(directiveName));
  const defaults = FRESH_CSP_DEFAULTS.filter((d) => !named.has(directiveName(d)));
  if (options.reportTo) own.push("report-to csp-endpoint", `report-uri ${options.reportTo}`);
  return { defaults, own };
}

/** A fetch directive (`*-src`), whose sources add to denext's own. */
const isSourceList = (name: string): boolean => name.endsWith("-src");

/**
 * Sources merged: denext's, then the new ones. A list allowing `'unsafe-inline'` drops its
 * hashes and nonces, which would switch `'unsafe-inline'` off (CSP Level 2).
 */
function unionSources(base: string[], extra: string[]): string[] {
  const out = [...base];
  for (const s of extra) if (!out.includes(s)) out.push(s);
  return out.includes("'unsafe-inline'")
    ? out.filter((s) => !s.startsWith("'sha256-") && !s.startsWith("'nonce-"))
    : out;
}

/**
 * Merge Fresh's directives into the policy denext computed for a page: a `*-src` directive adds
 * its sources to denext's (which keep the page's own scripts and styles working), any other
 * replaces denext's (`frame-ancestors`, `form-action`, …) or is added. Fresh's default
 * `'unsafe-inline'` is left out (denext allows its own inline styles by hash), as is every
 * `'unsafe-inline'` under `useNonce`. With no denext policy (`csp: "off"`, or a response a
 * handler made), the policy is Fresh's own.
 *
 * @param policy The policy denext computed (undefined: none).
 * @param options The `csp()` options.
 * @returns The policy to send.
 */
export function mergeCsp(policy: string | undefined, options: CSPOptions = {}): string {
  const { defaults, own } = freshDirectives(options);
  const inline = (d: string) => options.useNonce ? d.replaceAll(" 'unsafe-inline'", "") : d;
  if (policy === undefined) return [...defaults, ...own].map(inline).join("; ");
  const merged = new Map<string, string[]>();
  for (const d of policy.split(";").map((p) => p.trim()).filter(Boolean)) {
    merged.set(directiveName(d), d.split(/\s+/).slice(1));
  }
  const fresh = [...defaults.map((d) => d.replaceAll(" 'unsafe-inline'", "")), ...own];
  for (const d of fresh.map(inline)) {
    const [name, ...sources] = d.trim().split(/\s+/);
    const base = merged.get(name);
    merged.set(
      name,
      base && isSourceList(name) && !sources.includes("'none'")
        ? unionSources(base, sources)
        : sources,
    );
  }
  return [...merged].map(([name, sources]) => [name, ...sources].join(" ")).join("; ");
}

/** The server's current request context, through the bridge it installs (none in a browser). */
function requestContext(): RequestContext | undefined {
  return (globalThis as { __denextCurrentRequestContext?: () => RequestContext | undefined })
    .__denextCurrentRequestContext?.();
}

/**
 * Fresh's content-security-policy middleware. A page denext renders gets denext's own policy
 * (strict by default, the `csp` config key) with these directives merged in ({@link mergeCsp});
 * any other response gets Fresh's policy as Fresh sends it. `reportOnly` sends it as
 * `Content-Security-Policy-Report-Only` instead, and `reportTo` adds the reporting endpoint.
 *
 * @param options The policy.
 * @returns The middleware.
 */
export function csp<State>(options: CSPOptions = {}): Mw<State> {
  const header = options.reportOnly
    ? "content-security-policy-report-only"
    : "content-security-policy";
  return async (ctx) => {
    const res = await ctx.next();
    if (options.reportTo) {
      res.headers.set("reporting-endpoints", `csp-endpoint="${options.reportTo}"`);
    }
    const rc = requestContext();
    if (!res.headers.has(CONTINUE_HEADER) || !rc) {
      res.headers.set(header, mergeCsp(undefined, options));
      return res;
    }
    // The page renders after this middleware: adjust the policy denext computes for it.
    rc.cspTransform = (policy) => {
      const merged = mergeCsp(policy, options);
      if (!options.reportOnly) return merged;
      rc.outgoingHeaders.set(header, merged);
      return undefined;
    };
    return res;
  };
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
