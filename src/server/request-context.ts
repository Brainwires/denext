// Per-request async context, so server components and route handlers can call
// `cookies()` / `headers()` without prop-drilling the Request. Backed by Deno's
// built-in AsyncLocalStorage (survives `await` in async components).

import { awaitable } from "../runtime/async-props.ts";
import type { RenderScope } from "../runtime/render-scope.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import { deleteCookie, getCookies, getSetCookies, setCookie } from "@std/http/cookie";
import { postponeDynamic, shouldPostpone } from "../runtime/prerender.ts";
import type { SegmentConfig } from "./segment-config.ts";
import { currentCacheScope } from "./cache-scope.ts";

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
  return cookieStoreOver({}, () => {}, () => {});
}

/**
 * A {@linkcode CookieStore} over a name→value map (Next.js's `cookies()` shape: `get()`
 * returns `{ name, value }`, `getAll()` an array, and the store iterates).
 */
function cookieStoreOver(
  incoming: Record<string, string>,
  set: (name: string, value: string, options?: CookieSetOptions) => void,
  del: (name: string, options?: { path?: string; domain?: string }) => void,
): CookieStore {
  const all = () => Object.entries(incoming).map(([name, value]) => ({ name, value }));
  const store: CookieStore = {
    get: (name) => (name in incoming ? { name, value: incoming[name] } : undefined),
    getAll: (name) => (name === undefined ? all() : all().filter((c) => c.name === name)),
    has: (name) => name in incoming,
    get size() {
      return Object.keys(incoming).length;
    },
    // Next accepts `set(name, value, options)` AND `set({ name, value, ...options })`.
    set(
      name: string | ({ name: string; value: string } & CookieSetOptions),
      value?: string,
      options?: CookieSetOptions,
    ) {
      if (typeof name === "string") set(name, value ?? "", options);
      else {
        const { name: n, value: v, ...rest } = name;
        set(n, v, rest);
      }
      return store;
    },
    delete(
      name: string | { name: string; path?: string; domain?: string },
      options?: { path?: string; domain?: string },
    ) {
      if (typeof name === "string") del(name, options);
      else {
        const { name: n, ...rest } = name;
        del(n, rest);
      }
      return store;
    },
    toString: () => all().map((c) => `${c.name}=${c.value}`).join("; "),
    [Symbol.iterator]: () =>
      all().map((c) => [c.name, c] as [string, RequestCookie])[Symbol.iterator](),
  };
  return store;
}

/**
 * Cookies queued on the response so far (`cookies().set()` / `.delete()`, middleware
 * `Set-Cookie`), overlaid on the request's — so a cookie set earlier in the same request
 * is what `cookies().get()` sees, as in Next.js.
 */
function effectiveCookies(ctx: RequestContext): Record<string, string> {
  const incoming: Record<string, string> = {};
  for (const [name, value] of Object.entries(getCookies(ctx.request.headers))) {
    if (typeof value === "string") incoming[name] = value;
  }
  for (const c of getSetCookies(ctx.outgoingHeaders)) {
    const expired = (c.maxAge !== undefined && c.maxAge <= 0) ||
      (c.expires !== undefined && new Date(c.expires).getTime() <= Date.now());
    if (expired) delete incoming[c.name];
    else incoming[c.name] = c.value;
  }
  return incoming;
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
  /** Headers accumulated to attach to the response (e.g. Set-Cookie, loader-set headers). */
  outgoingHeaders: Headers;
  /** Per-request render collectors (signal state, `useServerInsertedHTML`) — see `render-scope.ts`. */
  renderScope?: RenderScope;
  /** Routing facts the pipeline resolved (`NextRequest.nextUrl.basePath` / `.locale` read them). */
  routing?: { basePath: string; locale?: string };
  /** Memoized read-only view handed out by {@linkcode headers}. */
  readonlyHeaders?: Headers;
  /**
   * An explicit response status a loader/action requested for this request (e.g. Remix
   * `data(value, { status })`). Applied by the request handler's `finalize` over the
   * render's own status. Absent on a normal render (keeps the render's status).
   */
  responseStatus?: number;
  /**
   * The parsed JSON body of a soft-navigation POST (a client soft nav that carries a payload
   * too large for request headers — e.g. the Remix `shouldRevalidate` prior-data echo). Opaque
   * to the core dispatch; the feature that sent it interprets it. Absent on normal requests.
   */
  softNavBody?: unknown;
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
  /**
   * Set by the request handler when `cacheKeyParams` narrows the ISR cache key, so
   * the render props' `searchParams` is wrapped to record which param names the
   * render actually read (see {@link trackSearchParamReads}). Off by default — the
   * normal render path is untouched unless the key is narrowed.
   */
  trackParamReads?: boolean;
  /**
   * The `searchParams` names read during this render, recorded only while
   * {@link trackParamReads} is set. The page cache dev-warns
   * ({@link warnUnkeyedParamReads}) if a whole-body-cached render read a name the
   * narrowed key ignores — a value that would otherwise bleed across requests.
   */
  paramReads?: Set<string>;
  /** Guards {@link warnUnkeyedParamReads} so the dev warning fires at most once. */
  warnedUnkeyedParams?: boolean;
}

/** Whether this process is in dev (enables render-correctness dev warnings). */
function isDev(): boolean {
  return (globalThis as { __denextDev?: boolean }).__denextDev === true;
}

/**
 * Wrap a request's `searchParams` so reads of individual param names are recorded
 * on the ambient request context — but ONLY when the context opted into tracking
 * (`trackParamReads`, set when `cacheKeyParams` narrows the ISR key). When tracking
 * is off (the default) the original object is returned untouched, so the normal
 * render path is byte-for-byte unchanged.
 *
 * Name-specific reads (`get`/`getAll`/`has`) record that name; whole-collection
 * reads (iteration/`keys`/`entries`/`values`/`forEach`/`toString`) record every
 * present name, since the render observed all of them. Backs the page cache's
 * dev-warn for a value that a narrowed key would drop.
 */
export function trackSearchParamReads(searchParams: URLSearchParams): URLSearchParams {
  const ctx = storage.getStore();
  if (!ctx?.trackParamReads) return searchParams;
  const reads = (ctx.paramReads ??= new Set<string>());
  const recordAll = () => {
    for (const name of searchParams.keys()) reads.add(name);
  };
  return new Proxy(searchParams, {
    get(target, prop) {
      if (prop === "get" || prop === "getAll" || prop === "has") {
        return (name: string, ...rest: unknown[]) => {
          reads.add(name);
          return (target[prop] as (...a: unknown[]) => unknown).call(target, name, ...rest);
        };
      }
      if (
        prop === "forEach" || prop === "entries" || prop === "keys" ||
        prop === "values" || prop === "toString" || prop === Symbol.iterator
      ) {
        recordAll();
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * Detect whether a page cached as a whole body under a NARROWED ISR key
 * (`cacheKeyParams`) read a `searchParams` name that the narrowed key ignores. Such
 * a value is baked into the shared cached render and would be served to other
 * requests — the one genuine Cache-Components correctness edge. Called only from the
 * no-hole store sites, where the entire body is cached and any non-allowlisted read
 * unambiguously bleeds (a with-holes PPR shell can escape the read into a per-request
 * hole, so those sites rely on the documented boundary instead).
 *
 * Returns `true` when such a leak occurred, so the caller **refuses to store** the
 * render (fail-safe in every environment — a per-request value must never be shared);
 * dev additionally logs a one-time warning naming the offending params. Returns
 * `false` (safe to cache) when no non-allowlisted param was read.
 */
export function warnUnkeyedParamReads(ctx: RequestContext, allowParams: string[]): boolean {
  const reads = ctx.paramReads;
  if (!reads || reads.size === 0) return false;
  const allow = new Set(allowParams);
  const leaked = [...reads].filter((name) => !allow.has(name));
  if (leaked.length === 0) return false;
  if (isDev() && !ctx.warnedUnkeyedParams) {
    ctx.warnedUnkeyedParams = true;
    console.warn(
      `denext: this route is page-cached with cacheKeyParams narrowing the key to ` +
        `[${allowParams.join(", ")}], but its cached render read searchParams outside ` +
        `that allowlist: [${leaked.join(", ")}]. Those values are baked into the shared ` +
        `cached render and can be served to other requests — refusing to cache this ` +
        `render. Read them inside a Suspense/PPR hole, or add them to cacheKeyParams.`,
    );
  }
  return true;
}

// The request-context store lives on globalThis (keyed by a global Symbol), not in a
// module-local — the SAME reason the hooks dispatcher does (see src/runtime/hooks.ts).
// A next-compat server bundle INLINES its own copy of the denext runtime, so there are
// two request-context module instances in one process: denext's source renderer (which
// calls `runWithContext`) and the compat-bundled route (which calls `cookies()`/
// `headers()`/`after()`). A module-local `storage` would give them separate
// AsyncLocalStorage instances — the store set by the renderer would be invisible to the
// bundled `cookies()`, throwing "must be called during a request". Sharing one instance
// via `Symbol.for` makes the Next surface API work across that boundary. For a normal
// single-instance app this is equivalent to a module-local.
const REQUEST_STORAGE_KEY = Symbol.for("denext.requestContextStorage");
interface StorageHolder {
  [REQUEST_STORAGE_KEY]?: AsyncLocalStorage<RequestContext>;
}
const storage: AsyncLocalStorage<RequestContext> = ((globalThis as StorageHolder)[
  REQUEST_STORAGE_KEY
] ??= new AsyncLocalStorage<RequestContext>());

/** Create a fresh context for a request. */
export function createRequestContext(
  request: Request,
  signal?: AbortSignal,
): RequestContext {
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
    signal,
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

/**
 * Read the current request's headers. Read-only, as in Next.js: `set`/`append`/`delete`
 * throw (the request's headers are shared by middleware, auth and the rest of the pipeline).
 */
export function headers(): AwaitableHeaders {
  const ctx = requireContext("headers");
  assertNotInCacheScope("headers");
  assertNotDynamicError(ctx, "headers");
  // force-static: return empty headers and keep the render static/cacheable.
  if (isForceStatic(ctx)) return awaitable(readonlyHeaders(new Headers()));
  // PPR: reading request headers during a prerender (outside `use cache`) can't
  // be resolved — postpone so the enclosing Suspense becomes a dynamic hole.
  if (shouldPostpone()) postponeDynamic("headers");
  ctx.usedDynamicApi = true; // reading request headers makes the render dynamic
  return awaitable(ctx.readonlyHeaders ??= readonlyHeaders(ctx.request.headers));
}

/** `headers()`'s return: usable synchronously AND awaitable (`await headers()`, Next 15). */
export type AwaitableHeaders = Headers & PromiseLike<Headers>;
/** `cookies()`'s return: usable synchronously AND awaitable (`await cookies()`, Next 15). */
export type AwaitableCookieStore = CookieStore & PromiseLike<CookieStore>;
/** `draftMode()`'s return: usable synchronously AND awaitable (`await draftMode()`, Next 15). */
export type AwaitableDraftMode = DraftMode & PromiseLike<DraftMode>;

const HEADER_MUTATORS = new Set(["set", "append", "delete"]);

/** A live, read-only view of `source` whose mutators throw (Next.js `ReadonlyHeaders`). */
export function readonlyHeaders(source: Headers): Headers {
  return new Proxy(source, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && HEADER_MUTATORS.has(prop)) {
        return () => {
          throw new TypeError(`headers() is read-only: cannot call ${prop}()`);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * Opt the current render out of the page cache (Next's `unstable_noStore()` /
 * `connection()` intent): a route with `export const revalidate = N` that calls this is
 * rendered per request instead of being stored and served to other visitors.
 */
export function noStore(): void {
  const ctx = storage.getStore();
  if (ctx) ctx.usedDynamicApi = true;
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

/** A single cookie as `cookies().get()` / `.getAll()` return it (Next.js's shape). */
export interface RequestCookie {
  /** The cookie name. */
  name: string;
  /** The cookie value. */
  value: string;
}

/**
 * A read/write view of the request/response cookies, shaped like Next.js's `cookies()`:
 * `get(name)?.value`, `getAll()` as an array, `has`, `set`, `delete`, iteration.
 */
export interface CookieStore {
  /** The named request cookie (`{ name, value }`), or `undefined`. */
  get(name: string): RequestCookie | undefined;
  /** All request cookies (or the 0–1 named `name`). */
  getAll(name?: string): RequestCookie[];
  /** True if the named request cookie is present. */
  has(name: string): boolean;
  /** Number of request cookies. */
  readonly size: number;
  /** Queue a Set-Cookie on the response (`set(name, value, options)` or `set({ name, value, …})`). */
  set(name: string, value: string, options?: CookieSetOptions): CookieStore;
  /** Object form: `set({ name, value, path, maxAge, … })`. Returns the store (chainable). */
  set(cookie: { name: string; value: string } & CookieSetOptions): CookieStore;
  /** Queue a cookie deletion on the response (by name, or `{ name, path?, domain? }`). */
  delete(name: string, options?: { path?: string; domain?: string }): CookieStore;
  /** Object form: `delete({ name, path, domain })`. Returns the store (chainable). */
  delete(cookie: { name: string; path?: string; domain?: string }): CookieStore;
  /** The request cookies as a `Cookie` header value. */
  toString(): string;
  /** Iterate `[name, cookie]` pairs. */
  [Symbol.iterator](): Iterator<[string, RequestCookie]>;
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
/** Draft tokens live this long (a preview session), then expire even if never disabled. */
const DRAFT_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
/** Bound on live draft tokens — a hammered `enable()` endpoint cannot grow the heap. */
const DRAFT_TOKEN_MAX = 10_000;

function inMemoryDraftTokenStore(): DraftTokenStore {
  const tokens = new Map<string, number>(); // token → expiresAt (insertion order = age)
  const sweep = () => {
    const now = Date.now();
    for (const [t, exp] of tokens) if (exp <= now) tokens.delete(t);
    while (tokens.size > DRAFT_TOKEN_MAX) tokens.delete(tokens.keys().next().value as string);
  };
  return {
    has: (t) => {
      const exp = tokens.get(t);
      if (exp === undefined) return false;
      if (exp <= Date.now()) {
        tokens.delete(t);
        return false;
      }
      return true;
    },
    add: (t) => {
      tokens.set(t, Date.now() + DRAFT_TOKEN_TTL_MS);
      sweep();
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
export function draftMode(): AwaitableDraftMode {
  const store = cookies();
  const token = store.get(DRAFT_COOKIE)?.value;
  return awaitable({
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
  });
}

/** Access the current request's cookies (reads incoming, writes Set-Cookie). */
export function cookies(): AwaitableCookieStore {
  const ctx = requireContext("cookies");
  assertNotInCacheScope("cookies");
  assertNotDynamicError(ctx, "cookies");
  // force-static: an empty, write-ignoring store; the render stays static/cacheable.
  if (isForceStatic(ctx)) return awaitable(emptyCookieStore());
  // PPR: reading cookies during a prerender (outside `use cache`) postpones so
  // the enclosing Suspense boundary becomes a per-request dynamic hole.
  if (shouldPostpone()) postponeDynamic("cookies");
  ctx.usedDynamicApi = true; // reading/writing cookies makes the render dynamic
  const incoming = effectiveCookies(ctx);
  // Secure-by-default: over HTTPS (directly or behind a TLS-terminating proxy that
  // sets x-forwarded-proto), new cookies are marked `Secure` unless overridden.
  const requestIsHttps = new URL(ctx.request.url).protocol === "https:" ||
    ctx.request.headers.get("x-forwarded-proto")?.split(",")[0].trim() === "https";
  return awaitable(cookieStoreOver(
    incoming,
    (name, value, options = {}) => {
      incoming[name] = value; // visible to later `cookies().get()` in this request
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
    (name, options = {}) => {
      delete incoming[name];
      deleteCookie(ctx.outgoingHeaders, name, {
        path: options.path ?? "/",
        domain: options.domain,
      });
    },
  ));
}
