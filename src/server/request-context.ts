// Per-request async context, so server components and route handlers can call
// `cookies()` / `headers()` without prop-drilling the Request. Backed by Deno's
// built-in AsyncLocalStorage (survives `await` in async components).

import { AsyncLocalStorage } from "node:async_hooks";
import { deleteCookie, getCookies, setCookie } from "@std/http/cookie";

/** Ambient state for the request currently being handled. */
export interface RequestContext {
  /** The incoming request. */
  request: Request;
  /** Headers accumulated to attach to the response (e.g. Set-Cookie). */
  outgoingHeaders: Headers;
  /** Per-request memoization store backing {@link cache}, keyed by function. */
  memo: Map<unknown, Map<string, unknown>>;
  /** True when draft/preview mode is active for this request. */
  draft?: boolean;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Create a fresh context for a request. */
export function createRequestContext(request: Request): RequestContext {
  return { request, outgoingHeaders: new Headers(), memo: new Map() };
}

/** Run `fn` with `ctx` as the ambient request context. */
export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** The current request context, or undefined if none is active. */
export function currentContext(): RequestContext | undefined {
  return storage.getStore();
}

function requireContext(who: string): RequestContext {
  const ctx = storage.getStore();
  if (!ctx) {
    throw new Error(
      `${who}() must be called during a request (inside a server component, ` +
        `route handler, or middleware).`,
    );
  }
  return ctx;
}

/** Read the current request's headers (read-only). */
export function headers(): Headers {
  return requireContext("headers").request.headers;
}

/** Options accepted when setting a cookie. */
export interface CookieSetOptions {
  /** Cookie path scope; defaults to "/". */
  path?: string;
  /** Cookie domain scope. */
  domain?: string;
  /** Max age in seconds. */
  maxAge?: number;
  /** Absolute expiry as a Date or epoch milliseconds. */
  expires?: Date | number;
  /** Restrict the cookie to HTTP(S) requests (not readable from JS). */
  httpOnly?: boolean;
  /** Only send the cookie over HTTPS. */
  secure?: boolean;
  /** SameSite policy. */
  sameSite?: "Strict" | "Lax" | "None";
}

/** A read/write view of the request/response cookies. */
export interface CookieStore {
  /** Read a request cookie by name. */
  get(name: string): string | undefined;
  /** All request cookies as a name→value record. */
  getAll(): Record<string, string>;
  /** True if the named request cookie is present. */
  has(name: string): boolean;
  /** Queue a Set-Cookie on the response. */
  set(name: string, value: string, options?: CookieSetOptions): void;
  /** Queue a cookie deletion on the response. */
  delete(name: string, options?: { path?: string; domain?: string }): void;
}

/** The cookie name backing {@link draftMode}. */
const DRAFT_COOKIE = "__denext_draft";

/** Draft (preview) mode state and controls, returned by {@link draftMode}. */
export interface DraftMode {
  /** Whether draft mode is currently enabled for this request. */
  isEnabled: boolean;
  /** Enable draft mode (sets an httpOnly cookie). Call from a route handler. */
  enable(): void;
  /** Disable draft mode (clears the cookie). */
  disable(): void;
}

/**
 * Read and control draft (preview) mode for the current request, backed by an
 * httpOnly cookie. Gate `enable()` behind your own authorization (e.g. a secret
 * token) in a route handler — anyone who can enable it sees draft content.
 */
export function draftMode(): DraftMode {
  const store = cookies();
  return {
    isEnabled: store.get(DRAFT_COOKIE) === "1",
    enable: () => store.set(DRAFT_COOKIE, "1", { httpOnly: true, path: "/", sameSite: "Lax" }),
    disable: () => store.delete(DRAFT_COOKIE, { path: "/" }),
  };
}

/** Access the current request's cookies (reads incoming, writes Set-Cookie). */
export function cookies(): CookieStore {
  const ctx = requireContext("cookies");
  const incoming = getCookies(ctx.request.headers);
  return {
    get: (name) => incoming[name],
    getAll: () => Object.assign({}, incoming) as Record<string, string>,
    has: (name) => name in incoming,
    set: (name, value, options = {}) => {
      setCookie(ctx.outgoingHeaders, {
        name,
        value,
        path: options.path ?? "/",
        domain: options.domain,
        maxAge: options.maxAge,
        expires: options.expires,
        httpOnly: options.httpOnly,
        secure: options.secure,
        sameSite: options.sameSite,
      });
    },
    delete: (name, options = {}) => {
      deleteCookie(ctx.outgoingHeaders, name, {
        path: options.path ?? "/",
        domain: options.domain,
      });
    },
  };
}
