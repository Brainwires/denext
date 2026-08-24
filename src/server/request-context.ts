// Per-request async context, so server components and route handlers can call
// `cookies()` / `headers()` without prop-drilling the Request. Backed by Deno's
// built-in AsyncLocalStorage (survives `await` in async components).

import { AsyncLocalStorage } from "node:async_hooks";
import { deleteCookie, getCookies, setCookie } from "@std/http/cookie";
import { postponeDynamic, shouldPostpone } from "../runtime/prerender.ts";
import type { SegmentConfig } from "./segment-config.ts";
// Function-level cyclic import (cache.ts imports currentContext from here); safe
// because neither side calls the other at module-init time.
import { currentCacheScope } from "./cache.ts";

/**
 * Reading request-specific data (`cookies()`/`headers()`/`connection()`) inside a
 * `"use cache"` function is unsafe: the cached result would be keyed only on the
 * function's args and then served to other requests — a cross-request data leak.
 * Next.js errors on this; so do we (loud, not silent).
 */
function assertNotInCacheScope(api: string): void {
  if (currentCacheScope()) {
    throw new Error(
      `\`${api}()\` cannot be read inside a "use cache" function: its value is ` +
        `request-specific and would be cached and served to other requests. Read ` +
        `it outside the cached function and pass the result in as an argument.`,
    );
  }
}

/**
 * `export const dynamic = "error"`: the route opted into static rendering and
 * declared that any dynamic-API use is a mistake. Reading `cookies()`/`headers()`/
 * `connection()` under it throws (Next.js parity — a render error, not a silent
 * downgrade to dynamic). No-op unless the effective segment config sets it.
 */
function assertNotDynamicError(ctx: RequestContext | undefined, api: string): void {
  if (ctx?.segmentConfig?.dynamic === "error") {
    throw new Error(
      `\`${api}()\` was used, but this route sets \`export const dynamic = "error"\`, ` +
        `which forbids dynamic rendering. Remove the dynamic API, or change the ` +
        `\`dynamic\` segment config to "force-dynamic"/"auto".`,
    );
  }
}

/**
 * `export const dynamic = "force-static"`: dynamic request APIs return empty values
 * and do NOT mark the render dynamic, so the page still caches. True when the
 * effective segment config forces static rendering.
 */
function isForceStatic(ctx: RequestContext | undefined): boolean {
  return ctx?.segmentConfig?.dynamic === "force-static";
}

/** A no-op {@link CookieStore}: reads are empty, writes are ignored (force-static). */
function emptyCookieStore(): CookieStore {
  return {
    get: () => undefined,
    getAll: () => ({}),
    has: () => false,
    set: () => {},
    delete: () => {},
  };
}

/** Ambient state for the request currently being handled. */
export interface RequestContext {
  /** The incoming request. */
  request: Request;
  /**
   * Correlation id for this request. Surfaced in the request log and the
   * server-side error log, and echoed as the `x-request-id` response header on an
   * error, so a client-visible 500 can be traced back to its logged detail. Honors
   * an inbound `x-request-id` (from an upstream proxy) or mints a fresh UUID.
   */
  requestId: string;
  /**
   * Per-request abort signal — fires on client disconnect or request timeout.
   * Thread it into outgoing `fetch()`es for cooperative cancellation. Set by the
   * request handler; absent when running outside a request.
   */
  signal?: AbortSignal;
  /** Headers accumulated to attach to the response (e.g. Set-Cookie). */
  outgoingHeaders: Headers;
  /** Per-request memoization store backing {@link cache}, keyed by function. */
  memo: Map<unknown, Map<string, unknown>>;
  /**
   * Set when the render read a dynamic request API (`cookies()`/`headers()`),
   * implying per-request output. The page cache checks this and refuses to cache
   * such a render even when the route opts in via `revalidate`.
   */
  usedDynamicApi?: boolean;
  /**
   * Dev-only render-mode telemetry for the first-party devtools glass-box
   * (`denext/devtools`). `renderStreamed` is set true just before a streamed response
   * is constructed; `renderCache` records this route's page-cache outcome. The
   * document renderer serializes them (with `usedDynamicApi`) into a dev-only
   * `#__denext_render_modes` JSON island the devtools panel reads. Ignored in
   * production (the island is emitted only when `__denextDev` is set).
   */
  renderStreamed?: boolean;
  /** This request's page-cache outcome (see {@link renderStreamed}). */
  renderCache?: "HIT" | "STALE" | "MISS";
  /**
   * The effective route {@link SegmentConfig} for the page being rendered, set by
   * `buildPageContext` once the layout→page chain is merged. The dynamic-API guards
   * read it: `dynamic:"error"` makes `cookies()`/`headers()`/`connection()` throw,
   * and `dynamic:"force-static"` makes them return empty without marking the render
   * dynamic (so it caches). Absent outside a page render (e.g. a route handler).
   */
  segmentConfig?: SegmentConfig;
  /**
   * Tags accrued from cached data read during this render (via
   * {@link unstable_cache}/{@link cachedFetch} `tags`). The page cache attaches
   * them to the stored render so {@link revalidateTag} can purge the page, not
   * just the underlying data. Populated lazily on first tagged read.
   */
  collectedTags?: Set<string>;
  /**
   * Tags a Server Action expired **this request** via `updateTag` (read-your-writes).
   * A same-request cache read whose entry carries one of these treats it as a miss and
   * recomputes, so the acting user sees their own write immediately. Also surfaced to
   * the client so its router can refresh the affected content.
   */
  updatedTags?: Set<string>;
  /**
   * Set when a Server Action called `refresh()` — a request to re-fetch the
   * uncached data on the current route. Surfaced to the client in the action
   * response so its router refreshes (complements `updateTag`).
   */
  refreshRequested?: boolean;
  /** Callbacks registered via {@link after}, drained after the response. */
  deferred: Array<() => unknown>;
  /**
   * Serialized `<link>`/`<script>` resource hints emitted during SSR by
   * `preload`/`preinit`/`preconnect`/`prefetchDNS` (React's resource-hint APIs).
   * Merged into the document `<head>` by the page renderer. Populated lazily via
   * {@link addResourceHint}; deduped by exact tag string.
   */
  resourceHints?: string[];
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Create a fresh context for a request. */
export function createRequestContext(request: Request): RequestContext {
  // Reuse an upstream correlation id when the proxy set one; otherwise mint a
  // fresh UUID. The inbound value is untrusted — it is echoed into logs and the
  // `x-request-id` response header, so strip anything but safe token characters
  // (blocks log-forging CRLF/control chars and header-injection) and bound the
  // length so a hostile header can't bloat every log line.
  const inbound = request.headers.get("x-request-id");
  const sanitized = inbound?.replace(/[^\x21-\x7E]/g, "").slice(0, 200);
  const requestId = sanitized && sanitized.length > 0 ? sanitized : crypto.randomUUID();
  return {
    request,
    requestId,
    outgoingHeaders: new Headers(),
    memo: new Map(),
    deferred: [],
  };
}

/**
 * Schedule work to run after the response is produced (Next.js `after()`).
 * Useful for logging, analytics, or cache warm-up that should not delay the
 * response. Callbacks run once the handler returns; a throw is logged, not
 * propagated. Outside a request, the callback runs immediately.
 *
 * @param callback The work to run after the response.
 */
export function after(callback: () => unknown): void {
  const ctx = storage.getStore();
  if (ctx) ctx.deferred.push(callback);
  else void callback();
}

/**
 * `connection()` (Next.js) — an explicit dynamic-rendering signal. Awaiting it
 * marks the current render as dynamic (per-request), opting the route out of
 * static generation/caching, without reading any specific request data (unlike
 * `cookies()`/`headers()`). Resolves once the runtime is ready to handle the
 * request; outside a request it resolves immediately.
 *
 * @returns A promise that resolves when the request connection is available.
 */
export function connection(): Promise<void> {
  assertNotInCacheScope("connection");
  const ctx = storage.getStore();
  assertNotDynamicError(ctx, "connection");
  // force-static: connection() is inert — do NOT mark the render dynamic, so the
  // page still caches (Next.js: dynamic APIs are empty/no-op under force-static).
  if (isForceStatic(ctx)) return Promise.resolve();
  // During a PPR prerender, `connection()` is an explicit dynamic signal: it
  // postpones so its subtree becomes a per-request hole (outside `use cache`).
  if (shouldPostpone()) postponeDynamic("connection");
  if (ctx) ctx.usedDynamicApi = true;
  return Promise.resolve();
}

/** Run all {@link after} callbacks registered on `ctx` (errors are swallowed). */
export async function runDeferred(ctx: RequestContext): Promise<void> {
  if (ctx.deferred.length === 0) return;
  const tasks = ctx.deferred.splice(0);
  await Promise.allSettled(tasks.map(async (fn) => {
    try {
      await fn();
    } catch (err) {
      console.error("denext: after() callback threw:", err);
    }
  }));
}

/** Run `fn` with `ctx` as the ambient request context. */
export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** The current request context, or undefined if none is active. */
export function currentContext(): RequestContext | undefined {
  return storage.getStore();
}

// Bridge for client-safe modules (e.g. the `react` compat shim's request-scoped
// `cache`) to reach the current request context WITHOUT statically importing this
// server module (which would pull `node:async_hooks` into a browser/compat bundle).
// Installed on the server only; absent in a client bundle.
(globalThis as { __denextCurrentRequestContext?: () => RequestContext | undefined })
  .__denextCurrentRequestContext = currentContext;

/**
 * Record a serialized SSR resource-hint `<link>`/`<script>` on the current request
 * (deduped by exact tag string), for the page renderer to hoist into `<head>`.
 * Backs the server side of `preload`/`preinit`/`preconnect`/`prefetchDNS`. A no-op
 * (returns `false`) outside a request — e.g. a hint emitted during module load.
 *
 * @param tag The fully serialized `<link …>` / `<script …></script>` string.
 * @returns Whether the hint was recorded (i.e. a request context was active).
 */
export function addResourceHint(tag: string): boolean {
  const ctx = storage.getStore();
  if (!ctx) return false;
  ctx.resourceHints ??= [];
  if (!ctx.resourceHints.includes(tag)) ctx.resourceHints.push(tag);
  return true;
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
  const ctx = requireContext("headers");
  assertNotInCacheScope("headers");
  assertNotDynamicError(ctx, "headers");
  // force-static: return empty headers and keep the render static/cacheable.
  if (isForceStatic(ctx)) return new Headers();
  // PPR: reading request headers during a prerender (outside `use cache`) can't
  // be resolved — postpone so the enclosing Suspense becomes a dynamic hole.
  if (shouldPostpone()) postponeDynamic("headers");
  ctx.usedDynamicApi = true; // reading request headers makes the render dynamic
  return ctx.request.headers;
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

/**
 * Backing store for server-minted draft tokens. Draft mode is "on" only when the
 * request cookie holds a token this server issued via `enable()`; a forged or
 * guessed value is not in the store, so it cannot turn draft mode on.
 *
 * The default store is in-memory (per-process, resets on restart). A
 * multi-instance deployment can inject a store backed by a shared cache
 * (Redis/KV) via {@linkcode setDraftTokenStore} so a token minted on one
 * instance is honored on another. The store is synchronous to keep
 * {@linkcode draftMode}'s `isEnabled` synchronous; back an async store with a
 * synchronously-readable cache, or mint signed/stateless tokens instead.
 */
export interface DraftTokenStore {
  /** Is `token` a currently-valid server-minted token? */
  has(token: string): boolean;
  /** Record `token` as valid (called by `enable()`). */
  add(token: string): void;
  /** Invalidate `token` (called by `disable()`). */
  delete(token: string): void;
}

/** The default per-process, in-memory {@link DraftTokenStore}. */
function inMemoryDraftTokenStore(): DraftTokenStore {
  const tokens = new Set<string>();
  return {
    has: (t) => tokens.has(t),
    add: (t) => {
      tokens.add(t);
    },
    delete: (t) => {
      tokens.delete(t);
    },
  };
}

let draftTokenStore: DraftTokenStore = inMemoryDraftTokenStore();

/**
 * Replace the {@link DraftTokenStore} backing draft mode. Use this to share draft
 * sessions across instances (back it with Redis/KV). The server-minted-token
 * security property is preserved: only tokens added via `enable()` validate.
 *
 * @param store The store to use for all subsequent draft-token operations.
 */
export function setDraftTokenStore(store: DraftTokenStore): void {
  draftTokenStore = store;
}

/** Generate an unguessable draft-session token. */
function newDraftToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Draft (preview) mode state and controls, returned by {@link draftMode}. */
export interface DraftMode {
  /** Whether draft mode is currently enabled for this request. */
  isEnabled: boolean;
  /** Enable draft mode: mint a token and set it as an httpOnly cookie. */
  enable(): void;
  /** Disable draft mode: invalidate the token and clear the cookie. */
  disable(): void;
}

/**
 * Read and control draft (preview) mode for the current request. Backed by an
 * httpOnly cookie holding a **server-minted random token** — a forged cookie
 * value cannot enable draft mode. Still gate `enable()` behind your own
 * authorization in a route handler (defense in depth); only that authorized call
 * mints a valid token.
 */
export function draftMode(): DraftMode {
  const store = cookies();
  const token = store.get(DRAFT_COOKIE);
  return {
    isEnabled: token !== undefined && draftTokenStore.has(token),
    enable: () => {
      const t = newDraftToken();
      draftTokenStore.add(t);
      store.set(DRAFT_COOKIE, t, { httpOnly: true, path: "/", sameSite: "Lax" });
    },
    disable: () => {
      if (token) draftTokenStore.delete(token);
      store.delete(DRAFT_COOKIE, { path: "/" });
    },
  };
}

/** Access the current request's cookies (reads incoming, writes Set-Cookie). */
export function cookies(): CookieStore {
  const ctx = requireContext("cookies");
  assertNotInCacheScope("cookies");
  assertNotDynamicError(ctx, "cookies");
  // force-static: an empty, write-ignoring store; the render stays static/cacheable.
  if (isForceStatic(ctx)) return emptyCookieStore();
  // PPR: reading cookies during a prerender (outside `use cache`) postpones so
  // the enclosing Suspense boundary becomes a per-request dynamic hole.
  if (shouldPostpone()) postponeDynamic("cookies");
  ctx.usedDynamicApi = true; // reading/writing cookies makes the render dynamic
  const incoming = getCookies(ctx.request.headers);
  // Secure-by-default: over HTTPS (directly or behind a TLS-terminating proxy that
  // sets x-forwarded-proto), new cookies are marked `Secure` unless overridden.
  const requestIsHttps = new URL(ctx.request.url).protocol === "https:" ||
    ctx.request.headers.get("x-forwarded-proto")?.split(",")[0].trim() === "https";
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
        // Secure defaults (opt out explicitly): httpOnly so client JS can't read
        // the cookie (XSS-theft defense), SameSite=Lax for CSRF defense, and Secure
        // over HTTPS. A cookie a client needs to read → pass `{ httpOnly: false }`.
        httpOnly: options.httpOnly ?? true,
        secure: options.secure ?? requestIsHttps,
        sameSite: options.sameSite ?? "Lax",
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
