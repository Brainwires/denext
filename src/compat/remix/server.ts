/**
 * `denext/remix/server` — the server half of the Remix compat layer (the surface a Remix
 * app imports from `@remix-run/node` / `@remix-run/cloudflare` / `@remix-run/server-runtime`),
 * plus the runners the generated `page.tsx`/`layout.tsx` wrappers use to execute a Remix
 * route on denext.
 *
 * A Remix `loader`/`action` receives `{ request, params, context }` and returns either a
 * plain value or a `Response` (`json()`/`redirect()`); {@link runLoader}/{@link runAction}
 * synthesize the args from denext's request context, call it, and unwrap the result
 * (parsing a `json()` body, turning a `redirect()` into a denext redirect). The data then
 * crosses the Flight boundary into the client `RemixRouteProvider` as a prop.
 *
 * @module
 */

import { h } from "../../../mod.ts";
import { fromBase64Url, hmacSign, hmacVerify, toBase64Url } from "../../server/session.ts";
import { currentContext } from "../../server/request-context.ts";
import {
  EXPOSE_ERROR,
  isControlSignal,
  redirect as denextRedirect,
  RedirectError,
  RedirectType,
} from "../../runtime/error-boundary.ts";
import { serverAction } from "../../runtime/server-action.ts";
import { registerServerMatch } from "./matches-server.ts";
import { serverRenderMatches } from "./matches-bridge.ts";
import { setDocumentAttrsSink } from "./document.ts";
import { type AppLoadContext, loadContext } from "./load-context.ts";
import type { RemixMatch } from "./client.ts";
import {
  FORM_ACTION_HEADER,
  FORM_METHOD_HEADER,
  FROM_HEADER,
  LOADER_DATA_HEADER,
  PARAMS_HEADER,
  REVALIDATE_HEADER,
  type ShouldRevalidateArgs,
  type ShouldRevalidateFunction,
} from "./revalidation.ts";
import type { Metadata } from "../../server/types.ts";
import type { VNode, VNodeChildren } from "../../jsx/types.ts";

/**
 * Remix `@remix-run/css-bundle`'s `cssBundleHref` — always `undefined` on denext, which
 * bundles and serves CSS itself (there is no separate Remix CSS bundle to link). A migrated
 * root's `links` (`cssBundleHref ? [{ rel: "stylesheet", href: cssBundleHref }] : []`) thus
 * contributes nothing, and the `@remix-run/css-bundle` npm dep is dropped. The migration
 * rewrites the specifier to `denext/remix/server`.
 */
export const cssBundleHref: string | undefined = undefined;

// ── The app load context (`getLoadContext`) + the synthesized ServerBuild ──────────
export {
  type AppLoadContext,
  defineLoadContext,
  type LoadContextArgs,
  type LoadContextProvider,
} from "./load-context.ts";
export {
  type RemixRouteExport,
  remixServerBuild,
  type ServerBuild,
  type ServerRoute,
  type ServerRouteModule,
} from "./server-build.ts";

// ── Remix data helpers (json / redirect / data) — see responses.ts (isomorphic) ────
export {
  data,
  DataWithResponseInit,
  json,
  redirect,
  redirectDocument,
  replace,
} from "./responses.ts";
import { DataWithResponseInit, REDIRECT_MODE_HEADER } from "./responses.ts";

/** Apply a `data()`/response `init` (status + headers) onto the current request's response. */
function applyResponseInit(init: ResponseInit | null): void {
  const ctx = currentContext();
  if (!init || !ctx) return;
  if (init.status !== undefined) ctx.responseStatus = init.status;
  if (!init.headers) return;
  const h = new Headers(init.headers);
  for (const [k, v] of h) {
    if (k.toLowerCase() !== "set-cookie") ctx.outgoingHeaders.set(k, v);
  }
  for (const c of h.getSetCookie()) ctx.outgoingHeaders.append("set-cookie", c);
}

/** Turn a loader/action redirect `Response` into denext's redirect signal (always throws),
 * honoring a `replace()` marker as a soft-nav history-replace. */
function redirectFromResponse(location: string, status: number, response: Response): never {
  if (response.headers.get(REDIRECT_MODE_HEADER) === "replace") {
    throw new RedirectError(location, status, RedirectType.replace);
  }
  denextRedirect(location, status); // throws denext's redirect control signal
}

/** Build a resource-route `Response` from a loader/action result (Response | data() | value). */
function toResourceResponse(result: unknown): Response {
  if (result instanceof Response) return result;
  if (result instanceof DataWithResponseInit) {
    return Response.json((result.data ?? null) as unknown, result.init ?? undefined);
  }
  return Response.json((result ?? null) as unknown);
}

/**
 * Remix `defer()` — return a data object whose promise-valued fields stream. denext resolves
 * them client-side via `<Await>`/`use()`, so this passes the object through unchanged. The
 * optional `init` (Remix's `ResponseInit` for status/headers) is accepted for signature
 * compatibility; denext threads the deferred data across the Flight boundary rather than a
 * `Response`, so `init` is not applied.
 */
export function defer<T extends Record<string, unknown>>(data: T, _init?: ResponseInit): T {
  return data;
}

/** Whether a value is a `Response` (a loader/action returning `json()`/`redirect()`). */
function isResponse(value: unknown): value is Response {
  return typeof Response !== "undefined" && value instanceof Response;
}

/**
 * Forward a loader/action `Response`'s `Set-Cookie` header(s) onto denext's outgoing
 * response headers. Without this, converting the Response to a redirect/JSON payload
 * would drop them — breaking the canonical Remix login (`session.set(...)` then
 * `redirect(url, { headers: { "Set-Cookie": await commitSession(session) } })`), whose
 * whole point is to set the session cookie alongside the redirect.
 */
function forwardResponseCookies(response: Response): void {
  const outgoing = currentContext()?.outgoingHeaders;
  if (!outgoing) return;
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const setCookies = typeof headers.getSetCookie === "function"
    ? headers.getSetCookie()
    : (headers.get("set-cookie") ? [headers.get("set-cookie") as string] : []);
  for (const cookie of setCookies) outgoing.append("set-cookie", cookie);
}

/** Unwrap a loader/action return value: `data()` value + init, a `json()` body, a redirect, else pass through. */
async function unwrap(value: unknown): Promise<unknown> {
  if (value instanceof DataWithResponseInit) {
    applyResponseInit(value.init); // status/headers → the response; value passes through
    return value.data;
  }
  if (!isResponse(value)) return value;
  forwardResponseCookies(value); // preserve Set-Cookie (session commit) across the unwrap
  const status = value.status;
  if (status >= 300 && status < 400) {
    redirectFromResponse(value.headers.get("Location") ?? "/", status, value); // throws
  }
  return await responseBody(value);
}

/** Read a `Response`'s body as parsed JSON or text (shared by unwrap paths). */
async function responseBody(response: Response): Promise<unknown> {
  const type = response.headers.get("Content-Type") ?? "";
  if (type.includes("application/json")) return await response.json();
  const text = await response.text();
  return text.length ? text : null;
}

/**
 * A Remix route-error-response raised by a loader/action that **threw** a non-redirect
 * `Response` (`throw json(data, { status })` / `throw new Response(...)`). Carries the
 * `__remixErrorResponse` brand + status/data so the nearest `ErrorBoundary` sees it via
 * `useRouteError()` and `isRouteErrorResponse()` recognizes it.
 */
class RemixRouteErrorResponse extends Error {
  readonly __remixErrorResponse = true as const;
  /** Rendered by the boundary as-is (status + data), never redacted or logged as a failure. */
  readonly [EXPOSE_ERROR] = true;
  constructor(readonly status: number, readonly statusText: string, readonly data: unknown) {
    super(`Route error ${status}`);
    this.name = "RemixRouteErrorResponse";
  }
}

/**
 * Handle a value **thrown** by a loader/action. Remix uses thrown `Response`s as control
 * flow: `throw redirect(url)` (the ubiquitous auth-guard pattern) and `throw json()/new
 * Response()` for error states. A thrown redirect becomes denext's redirect control
 * signal; a thrown non-redirect `Response` becomes a {@link RemixRouteErrorResponse} for
 * the error boundary. Anything else (a real error) re-throws unchanged. Always throws.
 */
async function unwrapThrown(thrown: unknown): Promise<never> {
  if (!isResponse(thrown)) throw thrown;
  forwardResponseCookies(thrown); // a thrown redirect may also commit/destroy the session
  const status = thrown.status;
  if (status >= 300 && status < 400) {
    redirectFromResponse(thrown.headers.get("Location") ?? "/", status, thrown); // throws
  }
  // Remix answers with the thrown Response's status (the splat route's `throw new
  // Response("Not found", { status: 404 })`) even though the ErrorBoundary renders inline.
  setErrorStatus(status);
  throw new RemixRouteErrorResponse(status, thrown.statusText, await responseBody(thrown));
}

/**
 * The status the document should carry when a route's ErrorBoundary renders: a thrown
 * Response's own, `500` for a real error (Remix semantics). Applied by denext's request
 * finalizer over the render's 200. Only the OUTERMOST failure wins per request.
 */
function setErrorStatus(status: number): void {
  const ctx = currentContext();
  if (ctx && ctx.responseStatus === undefined) ctx.responseStatus = status;
}

// ── The request/params/context passed to a loader/action ──────────────────────

/** Remix `LoaderFunctionArgs` — synthesized from denext's request context. */
export interface LoaderFunctionArgs {
  request: Request;
  params: Record<string, string>;
  /** The app load context — what {@link defineLoadContext}'s provider returned for this request. */
  context: AppLoadContext;
}
/** Remix `ActionFunctionArgs` — identical shape to {@link LoaderFunctionArgs}. */
export type ActionFunctionArgs = LoaderFunctionArgs;

/** A Remix `loader` export. */
export type LoaderFunction = (args: LoaderFunctionArgs) => unknown | Promise<unknown>;

/**
 * Remix's `SerializeFrom<typeof loader>` — the data a loader/action hands the client:
 * the awaited return value, unwrapped from `data()` / `json()` (a `Response` return is
 * opaque → `unknown`). Use it to type `useLoaderData<SerializeFrom<typeof loader>>()`.
 */
export type SerializeFrom<T> = T extends (...args: never[]) => infer R ? Unwrapped<Awaited<R>>
  : Unwrapped<T>;
type Unwrapped<V> = V extends DataWithResponseInit<infer D> ? D
  : V extends Response ? unknown
  : V;
/** A Remix `action` export. */
export type ActionFunction = (args: ActionFunctionArgs) => unknown | Promise<unknown>;

/** Build the `{ request, params, context }` a loader/action receives. */
async function loaderArgs(params: Record<string, string>): Promise<LoaderFunctionArgs> {
  const ctx = currentContext();
  const request = ctx?.request ??
    new Request("http://localhost/"); // export/prerender fallback (no live request)
  return { request, params, context: await loadContext(request, params) };
}

/** Per-request memo key for loader results ({@link runLoaderOnce}). */
const LOADER_MEMO = Symbol.for("denext.remix.loaderMemo");

/**
 * Run a route's loader at most ONCE per request: the `meta` bridge needs its data before
 * the tree renders and the route wrapper needs it again when it renders — Remix runs a
 * loader once per request, so the second caller reuses the first result (a DB query is
 * not repeated). Outside a request (export/prerender) it simply runs.
 */
export async function runLoaderOnce(
  id: string,
  loader: LoaderFunction | undefined,
  params: Record<string, string>,
): Promise<unknown> {
  const memo = currentContext()?.memo;
  if (!memo || !loader) return runLoader(loader, params);
  let byId = memo.get(LOADER_MEMO);
  if (!byId) memo.set(LOADER_MEMO, byId = new Map());
  if (byId.has(id)) return byId.get(id);
  const pending = runLoader(loader, params);
  byId.set(id, pending);
  try {
    const data = await pending;
    byId.set(id, data);
    return data;
  } catch (err) {
    byId.delete(id); // a throw (redirect/404) is re-raised by whoever asks next
    throw err;
  }
}

/** Run a Remix `loader` and return its unwrapped data (or `undefined` when absent). */
export async function runLoader(
  loader: LoaderFunction | undefined,
  params: Record<string, string>,
): Promise<unknown> {
  if (!loader) return undefined;
  try {
    return await unwrap(await loader(await loaderArgs(params)));
  } catch (thrown) {
    // A loader that THREW (`throw redirect()` / `throw json()`): honor it as Remix would.
    // A returned redirect's signal (a RedirectError, not a Response) falls through unchanged.
    if (isResponse(thrown)) return await unwrapThrown(thrown);
    if (!isControlSignal(thrown)) setErrorStatus(500); // a real error → the boundary at 500
    throw thrown;
  }
}

/**
 * Wrap a Remix `action` as a denext Server Action bound to `routeId`. The returned ref is
 * callable from `<Form>`/`useSubmit` and, on the server, runs the action with a synthesized
 * `{ request, params, context }` (the params captured at render). Returns `undefined` when
 * the route has no action.
 */
export function bindAction(
  action: ActionFunction | undefined,
  routeId: string,
  params: Record<string, string>,
): ((formData: FormData) => Promise<unknown>) | undefined {
  if (!action) return undefined;
  return serverAction(`remix:${routeId}#action`, async (formData: FormData) => {
    // Rebuild a request carrying the submitted FormData for the action to read.
    const base = currentContext()?.request;
    const url = base?.url ?? "http://localhost/";
    // Carry the viewer's request headers (Cookie, Authorization, Accept-Language) — an
    // action reads the session from `request.headers` exactly like a Remix POST — minus
    // the body framing, which the FormData body sets itself.
    const headers = new Headers(base?.headers);
    headers.delete("content-type");
    headers.delete("content-length");
    const request = new Request(url, { method: "POST", body: formData, headers });
    try {
      const context = await loadContext(request, params);
      return await unwrap(await action({ request, params, context }));
    } catch (thrown) {
      // `throw redirect()` / `throw json()` from an action — honored like a return.
      if (isResponse(thrown)) return await unwrapThrown(thrown);
      throw thrown;
    }
  });
}

/** Run a resource-route `loader` and return its raw `Response` (Remix resource route). */
export async function runLoaderResponse(
  loader: LoaderFunction | undefined,
  request: Request,
): Promise<Response> {
  if (!loader) return new Response("Not Found", { status: 404 });
  const url = new URL(request.url);
  const params: Record<string, string> = Object.fromEntries(url.searchParams);
  try {
    const context = await loadContext(request, params);
    return toResourceResponse(await loader({ request, params, context }));
  } catch (thrown) {
    return thrownToResourceResponse(thrown); // a thrown redirect/Response IS the response
  }
}

/**
 * Run a Remix `action` and return its raw `Response` — for a resource route
 * (`route.ts`), and for the `route.ts` a page route with an `action` also gets so a
 * plain POST to its URL runs the action (cross-route `fetcher.submit`/`<Form action>`
 * to a page, and the no-JS progressive-enhancement post). `params` are the route's
 * URL params (denext threads them from the matched pattern); a resource route with
 * no dynamic segments passes none.
 */
export async function runActionResponse(
  action: ActionFunction | undefined,
  request: Request,
  params: Record<string, string> = {},
): Promise<Response> {
  if (!action) return new Response("Method Not Allowed", { status: 405 });
  try {
    const context = await loadContext(request, params);
    return toResourceResponse(await action({ request, params, context }));
  } catch (thrown) {
    return thrownToResourceResponse(thrown); // a thrown redirect/Response IS the response
  }
}

/**
 * Map a value thrown by a resource-route loader/action to its `Response`. A thrown
 * `Response` (a redirect, or `throw json()/new Response()`) is the response itself, with
 * its `Set-Cookie` forwarded; anything else re-throws as a real error (→ 500).
 */
function thrownToResourceResponse(thrown: unknown): Response {
  if (isResponse(thrown)) {
    forwardResponseCookies(thrown);
    return thrown;
  }
  throw thrown;
}

// ── Route wrappers rendered by the generated page.tsx / layout.tsx ────────────

/**
 * The generated client route boundary (`page.client.tsx` default) — a `"use client"`
 * component that composes `RemixRouteProvider` + the user's Remix component and receives
 * its loader data as a **prop** (which crosses the Flight boundary), so `useLoaderData`
 * resolves within one client unit on SSR and hydrate.
 */
export type RemixRouteBoundary = (props: {
  id: string;
  loaderData: unknown;
  params: Record<string, string>;
  handle?: unknown;
  formAction?: (formData: FormData) => Promise<unknown>;
  children?: VNodeChildren;
}) => VNode;

/** Props the generated `page.tsx` passes to {@link RemixRoute}. */
export interface RemixRouteOptions {
  /** The route id (app-relative path). */
  id: string;
  /** The route's `loader` export. */
  loader?: LoaderFunction;
  /** The route's `action` export. */
  action?: ActionFunction;
  /** The route's `handle` export. */
  handle?: unknown;
  /** The generated client boundary (`page.client.tsx` default export). */
  Route: RemixRouteBoundary;
  /** URL params from denext `PageProps`. */
  params: Record<string, string>;
  /** The route's `shouldRevalidate` export — lets a client revalidation SKIP this loader. */
  shouldRevalidate?: ShouldRevalidateFunction;
}

/**
 * Resolve a migrated Remix route's data + action for the client boundary: run the loader
 * (or SKIP it, emitting a keep-marker, when a client revalidation's `shouldRevalidate` opts
 * out — the client then fills the data from its own cache), bind the action, and record the
 * match in the render-scoped store. Shared by {@link RemixRoute} and {@link RemixLayout}.
 */
async function resolveRouteRender(
  options: RemixRouteOptions,
): Promise<{ loaderData: unknown; formAction: ((fd: FormData) => Promise<unknown>) | undefined }> {
  const kept = keptLoaderData(options);
  const loaderData = kept.kept
    ? kept.data
    : await runLoaderOnce(options.id, options.loader, options.params);
  const formAction = bindAction(options.action, options.id, options.params);
  recordServerMatch(options.id, options.params, loaderData, options.handle);
  return { loaderData, formAction };
}

/** Parse a JSON request header into an object map, or `{}` when absent/malformed. */
function jsonHeader(req: Request, name: string): Record<string, unknown> {
  try {
    const raw = req.headers.get(name);
    return raw ? JSON.parse(raw) as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/** The client's echoed prior-render state for a revalidation (per route: params + loader data). */
interface RevalidationInput {
  from: string | null;
  params: Record<string, Record<string, string>>;
  data: Record<string, unknown>;
  formMethod?: string;
  formAction?: string;
}

/**
 * Read the client's revalidation echo for THIS request from whichever transport carried it: a
 * soft-nav POST body ({@link RequestContext.softNavBody}, used when the echo is too large for
 * headers) or, on a GET, the request headers. Returns null when this isn't a revalidation.
 */
function revalidationInput(req: Request): RevalidationInput | null {
  const body = currentContext()?.softNavBody;
  if (body && typeof body === "object") return fromBody(body as Record<string, unknown>);
  if (req.headers.get(REVALIDATE_HEADER) === null) return null;
  return {
    from: req.headers.get(FROM_HEADER),
    params: jsonHeader(req, PARAMS_HEADER) as RevalidationInput["params"],
    data: jsonHeader(req, LOADER_DATA_HEADER),
    formMethod: req.headers.get(FORM_METHOD_HEADER) ?? undefined,
    formAction: req.headers.get(FORM_ACTION_HEADER) ?? undefined,
  };
}

/** Coerce a soft-nav POST body (untrusted JSON) into a {@link RevalidationInput}. */
function fromBody(b: Record<string, unknown>): RevalidationInput {
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  return {
    from: str(b.from) ?? null,
    params: (b.params as RevalidationInput["params"]) ?? {},
    data: (b.data as Record<string, unknown>) ?? {},
    formMethod: str(b.formMethod),
    formAction: str(b.formAction),
  };
}

/**
 * Decide whether this route's loader can be SKIPPED on a client revalidation, reusing the
 * client's echoed prior data. Skips only when: this is a revalidation (soft nav / refresh), the
 * client echoed prior data for THIS route, and its `shouldRevalidate` returns `false`. Otherwise
 * the loader runs (first paint, hard nav, no `shouldRevalidate`, or an explicit `true`) — never
 * stale. The echo travels in request headers, or a POST body when it's too large for headers.
 */
function keptLoaderData(
  options: RemixRouteOptions,
): { kept: true; data: unknown } | { kept: false } {
  if (!options.shouldRevalidate) return { kept: false };
  const req = currentContext()?.request;
  if (!req) return { kept: false };
  const input = revalidationInput(req);
  if (!input || !(options.id in input.data)) return { kept: false }; // no echo → must revalidate
  // `shouldRevalidate` returns TRUE to re-run; keep prior data ONLY when it returns false.
  const revalidate = options.shouldRevalidate(revalidateArgs(req, options, input));
  return revalidate === false ? { kept: true, data: input.data[options.id] } : { kept: false };
}

/** Build the `shouldRevalidate` argument from the client's echoed input + this route's options. */
function revalidateArgs(
  req: Request,
  options: RemixRouteOptions,
  input: RevalidationInput,
): ShouldRevalidateArgs {
  const nextUrl = new URL(req.url);
  return {
    currentUrl: new URL(input.from ?? nextUrl.pathname + nextUrl.search, nextUrl.origin),
    nextUrl,
    currentParams: input.params[options.id] ?? options.params,
    nextParams: options.params,
    formMethod: input.formMethod,
    formAction: input.formAction,
    actionResult: undefined,
    defaultShouldRevalidate: true,
  };
}

/**
 * Run a migrated Remix route's loader server-side, bind its action, and render the client
 * boundary with the loader data threaded as a **prop** (it crosses Flight; the client
 * boundary establishes `useLoaderData`/matches/action context in one unit). Awaited by the
 * generated server `page.tsx`.
 */
export async function RemixRoute(options: RemixRouteOptions): Promise<VNode> {
  const { loaderData, formAction } = await resolveRouteRender(options);
  return h(options.Route, {
    id: options.id,
    loaderData,
    params: options.params,
    handle: options.handle,
    formAction,
  });
}

/**
 * Register this route's match in the render-scoped store as it renders (outer→inner), so a
 * nested route can read an ancestor's loader data (`useMatches`/`useRouteLoaderData`/
 * `useUser`) even in the Flight-serialization pass where React context is missing. See
 * `matches-bridge.ts`.
 */
function recordServerMatch(
  id: string,
  params: Record<string, string>,
  data: unknown,
  handle: unknown,
): void {
  const req = currentContext()?.request;
  const pathname = req ? new URL(req.url).pathname : "";
  registerServerMatch({ id, pathname, params, data, handle: handle ?? undefined });
}

/** Props the generated `layout.tsx` passes to {@link RemixLayout}. */
export interface RemixLayoutOptions extends RemixRouteOptions {
  /** The nested route subtree (denext `children`), threaded to the layout's `<Outlet/>`. */
  children: VNodeChildren;
}

/** Like {@link RemixRoute}, but threads the nested-route `children` to the layout's `<Outlet/>`. */
export async function RemixLayout(options: RemixLayoutOptions): Promise<VNode> {
  const { loaderData, formAction } = await resolveRouteRender(options);
  return h(options.Route, {
    id: options.id,
    loaderData,
    params: options.params,
    handle: options.handle,
    formAction,
    children: options.children,
  });
}

// ── Metadata bridge (Remix `meta` export → denext `generateMetadata`) ─────────

/** A Remix meta descriptor (a subset denext maps to its `Metadata`). */
export interface RemixMetaDescriptor {
  title?: string;
  name?: string;
  property?: string;
  content?: string;
  charSet?: string;
  tagName?: string;
  [key: string]: unknown;
}
/** A Remix `meta` export. */
export type MetaFunction = (args: MetaArgs) => RemixMetaDescriptor[];
/** A Remix `links` export. */
export type LinksFunction = () => Array<Record<string, unknown>>;
/** A Remix `headers` export. */
export type HeadersFunction = (
  args: { loaderHeaders: Headers; parentHeaders: Headers },
) => HeadersInit;

/** Remix `MetaArgs`: what a `meta` export receives. */
export interface MetaArgs {
  data: unknown;
  params: Record<string, string>;
  location: { pathname: string; search: string; hash: string };
  /** Every matched route outer→inner (ancestors' loader data included), like Remix. */
  matches: RemixMatch[];
  error?: unknown;
}

/**
 * Adapt a Remix `meta` export to a denext `generateMetadata`. Maps `{ title }` to
 * `metadata.title`, `{ name: "description" }` to `metadata.description`, and other
 * name/property descriptors into `openGraph`/`other` best-effort. Runs the route loader
 * (once per request — the render reuses the result) to supply `data`, and registers the
 * route's match so a NESTED route's `meta` sees it in `matches` (`matches.find(m => m.id ===
 * "routes/users+/$username_+/notes")` reads an ancestor's loader data). With `id`, a route
 * without a `meta` export still registers — Remix's `matches` carries every level.
 */
export function remixMeta(
  meta: MetaFunction | undefined,
  loader: LoaderFunction | undefined,
  id?: string,
  handle?: unknown,
  links?: LinksFunction,
):
  | ((
    props: { params: Record<string, string>; searchParams: URLSearchParams },
  ) => Promise<Metadata>)
  | undefined {
  if (!meta && !id && !links) return undefined;
  return async (props) => {
    // Remix `links()` (stylesheets, icons, preloads) → raw `<link>` tags in the head.
    const head = links ? linkTags(links()) : "";
    let data: unknown;
    try {
      data = id
        ? await runLoaderOnce(id, loader, props.params)
        : await runLoader(loader, props.params);
    } catch (err) {
      // Metadata resolves BEFORE the tree renders — outside every ErrorBoundary. A redirect
      // is a control signal the pipeline honors from here; anything else (a thrown 404
      // Response, a real error) is left for the render, which re-runs the loader inside the
      // route's boundary and answers with the right status.
      if (isControlSignal(err)) throw err;
      return {};
    }
    if (id) recordServerMatch(id, props.params, data, handle);
    if (!meta) return head ? { head } : {};
    const descriptors = meta({
      data,
      params: props.params,
      location: requestLocation(),
      matches: serverRenderMatches() ?? [],
    }) ?? [];
    const metadata = metadataFromDescriptors(descriptors);
    if (head) metadata.head = head;
    return metadata;
  };
}

/** Remix link descriptors as `<link …>` tags (attribute values HTML-escaped). */
function linkTags(descriptors: Array<Record<string, unknown>>): string {
  const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  return descriptors.map((d) => {
    const attrs = Object.entries(d)
      .filter(([, v]) => v !== undefined && v !== null && v !== false)
      .map(([k, v]) => {
        const name = k === "crossOrigin" ? "crossorigin" : k === "imageSrcSet" ? "imagesrcset" : k;
        return v === true ? name : `${name}="${esc(String(v))}"`;
      });
    return `<link ${attrs.join(" ")}>`;
  }).join("");
}

/** Remix `MetaArgs.location` for the current request (empty outside one: export/prerender). */
function requestLocation(): MetaArgs["location"] {
  const req = currentContext()?.request;
  if (!req) return { pathname: "", search: "", hash: "" };
  const url = new URL(req.url);
  return { pathname: url.pathname, search: url.search, hash: "" };
}

/** Map Remix meta descriptors onto denext `Metadata` (title/description/keywords + `meta`). */
function metadataFromDescriptors(descriptors: RemixMetaDescriptor[]): Metadata {
  const metadata: Metadata = {};
  const extra: Record<string, string> = {};
  for (const d of descriptors) {
    const content = typeof d.content === "string" ? d.content : undefined;
    if (typeof d.title === "string") metadata.title = d.title;
    else if (content === undefined) continue;
    else if (d.name === "description") metadata.description = content;
    else if (d.name === "keywords") {
      metadata.keywords = content.split(",").map((k: string) => k.trim()).filter(Boolean);
    } else if (typeof d.name === "string") extra[d.name] = content;
    else if (typeof d.property === "string") extra[d.property] = content;
  }
  if (Object.keys(extra).length) metadata.meta = extra;
  return metadata;
}

// ── Cookies (`createCookie`) ──────────────────────────────────────────────────

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Remix cookie serialization attributes. */
export interface CookieSerializeOptions {
  domain?: string;
  expires?: Date;
  httpOnly?: boolean;
  maxAge?: number;
  path?: string;
  sameSite?: "lax" | "strict" | "none" | boolean;
  secure?: boolean;
}
/** Options for {@link createCookie} (serialization + optional signing secrets). */
export interface CookieOptions extends CookieSerializeOptions {
  /** HMAC signing secrets — the first signs, all verify (rotate by prepending). */
  secrets?: string[];
}
/** A Remix cookie: parse a `Cookie` header value / serialize a value to a `Set-Cookie`. */
export interface Cookie {
  readonly name: string;
  readonly isSigned: boolean;
  parse(cookieHeader: string | null, options?: CookieSerializeOptions): Promise<unknown>;
  serialize(value: unknown, options?: CookieSerializeOptions): Promise<string>;
}

/** Read a single cookie's raw value out of a `Cookie` request header. */
function readCookie(header: string, name: string): string | null {
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** The MAC domain of Remix cookie sessions — distinct from denext's own session cookie. */
const REMIX_MAC_DOMAIN = "denext.remix-session.v1";

/** JSON→base64url the value, appending an HMAC signature when secrets are configured. */
async function encodeCookieValue(value: unknown, secrets: string[]): Promise<string> {
  const encoded = toBase64Url(encoder.encode(JSON.stringify(value)));
  return secrets.length
    ? `${encoded}.${await hmacSign(encoded, secrets[0], REMIX_MAC_DOMAIN)}`
    : encoded;
}

/** Verify (if signed) and decode a cookie value back to its JSON payload, or `null`. */
async function decodeCookieValue(raw: string, secrets: string[]): Promise<unknown> {
  let payload = raw;
  if (secrets.length) {
    const dot = raw.lastIndexOf(".");
    if (dot < 0) return null;
    payload = raw.slice(0, dot);
    if (!(await hmacVerify(payload, raw.slice(dot + 1), secrets, REMIX_MAC_DOMAIN))) return null;
  }
  try {
    return JSON.parse(decoder.decode(fromBase64Url(payload)));
  } catch {
    return null;
  }
}

/** The `Set-Cookie` attribute each option contributes (a data table keeps each case tiny). */
const COOKIE_ATTRS: Array<(o: CookieSerializeOptions) => string | undefined> = [
  (o) => `Path=${o.path ?? "/"}`,
  (o) => (o.maxAge != null ? `Max-Age=${Math.floor(o.maxAge)}` : undefined),
  (o) => (o.expires ? `Expires=${o.expires.toUTCString()}` : undefined),
  (o) => (o.domain ? `Domain=${o.domain}` : undefined),
  (o) => ((o.httpOnly ?? true) ? "HttpOnly" : undefined),
  (o) => (o.secure ? "Secure" : undefined),
  (o) => (o.sameSite ? `SameSite=${sameSiteValue(o.sameSite)}` : undefined),
];

/** Normalize a truthy Remix `sameSite` option to its `Set-Cookie` token. */
function sameSiteValue(ss: "lax" | "strict" | "none" | true): string {
  return ss === true ? "Strict" : ss[0].toUpperCase() + ss.slice(1);
}

/** Serialize a `Set-Cookie` string (value is already cookie-safe base64url). */
function serializeCookie(name: string, value: string, o: CookieSerializeOptions): string {
  const parts = [`${name}=${value}`];
  for (const attr of COOKIE_ATTRS) {
    const part = attr(o);
    if (part) parts.push(part);
  }
  return parts.join("; ");
}

/**
 * Remix `createCookie` — a first-class cookie that JSON-encodes its value and, when
 * given `secrets`, signs it with HMAC-SHA256 (tamper-evident; the first secret signs,
 * all verify). `parse` reads it from a `Cookie` header; `serialize` produces a
 * `Set-Cookie` string. HttpOnly + `Path=/` default on; pass `secure`/`sameSite` etc.
 */
export function createCookie(name: string, cookieOptions: CookieOptions = {}): Cookie {
  const { secrets = [], ...options } = cookieOptions;
  return {
    name,
    isSigned: secrets.length > 0,
    async parse(cookieHeader, _options) {
      if (!cookieHeader) return null;
      const raw = readCookie(cookieHeader, name);
      return raw == null ? null : await decodeCookieValue(raw, secrets);
    },
    async serialize(value, serializeOptions) {
      const encoded = await encodeCookieValue(value, secrets);
      return serializeCookie(name, encoded, { ...options, ...serializeOptions });
    },
  };
}

/** Remix `isCookie` — whether `value` is a {@link Cookie} (has `serialize` + a `name`). */
export function isCookie(value: unknown): value is Cookie {
  return !!value && typeof (value as Cookie).serialize === "function" &&
    typeof (value as Cookie).name === "string";
}

/** Resolve a `cookie` option (a {@link Cookie}, or options to build one) to a {@link Cookie}. */
function resolveCookie(
  cookie: Cookie | (CookieOptions & { name?: string }) | undefined,
  defaultName: string,
): Cookie {
  if (isCookie(cookie)) return cookie;
  return createCookie(cookie?.name ?? defaultName, cookie ?? {});
}

// ── Sessions (createCookieSessionStorage / createSessionStorage / memory) ─────

/** A session's key/value data. */
export type SessionData = Record<string, unknown>;

/** A Remix `Session` — data plus one-shot `flash` values (read once, then cleared). */
export interface Session<Data extends SessionData = SessionData> {
  readonly id: string;
  readonly data: Data;
  has(name: string): boolean;
  get(name: string): unknown;
  set(name: string, value: unknown): void;
  flash(name: string, value: unknown): void;
  unset(name: string): void;
}

const flashKey = (name: string) => `__flash_${name}`;

/** Remix `isSession` — whether `value` is a {@link Session} (its get/set/flash surface). */
export function isSession(value: unknown): value is Session {
  const s = value as Session;
  return !!value && typeof s.get === "function" && typeof s.set === "function" &&
    typeof s.flash === "function" && typeof s.unset === "function" &&
    typeof s.has === "function" && typeof s.id === "string";
}

/**
 * Remix `createSession` — build a standalone {@link Session} over `initialData` (flash
 * values live under a reserved prefix, read once then cleared). The session-storage
 * factories build their sessions through this.
 */
export function createSession(initialData: SessionData = {}, id = ""): Session {
  const map = new Map(Object.entries(initialData));
  return {
    get id() {
      return id;
    },
    get data() {
      return Object.fromEntries(map) as SessionData;
    },
    has: (name) => map.has(name) || map.has(flashKey(name)),
    get(name) {
      if (map.has(name)) return map.get(name);
      const fk = flashKey(name);
      if (!map.has(fk)) return undefined;
      const value = map.get(fk);
      map.delete(fk); // flash values are read once
      return value;
    },
    set: (name, value) => void map.set(name, value),
    flash: (name, value) => void map.set(flashKey(name), value),
    unset: (name) => void map.delete(name),
  };
}

/** A Remix session storage — read a session from a request, commit/destroy it to a cookie. */
export interface SessionStorage<Data extends SessionData = SessionData> {
  getSession(
    cookieHeader?: string | null,
    options?: CookieSerializeOptions,
  ): Promise<Session<Data>>;
  commitSession(session: Session<Data>, options?: CookieSerializeOptions): Promise<string>;
  destroySession(session: Session<Data>, options?: CookieSerializeOptions): Promise<string>;
}

/** An expired `Set-Cookie` options set (destroy a session cookie). */
function expiredOptions(options?: CookieSerializeOptions): CookieSerializeOptions {
  return { ...options, maxAge: undefined, expires: new Date(0) };
}

/**
 * Remix `createCookieSessionStorage` — the whole session lives in the (optionally
 * signed) cookie. Data over ~4 KB throws (use a server-side store instead).
 */
export function createCookieSessionStorage(
  { cookie }: { cookie?: Cookie | (CookieOptions & { name?: string }) } = {},
): SessionStorage {
  const c = resolveCookie(cookie, "__session");
  return {
    async getSession(cookieHeader) {
      const parsed = cookieHeader ? await c.parse(cookieHeader) : null;
      return createSession((parsed as SessionData) ?? {});
    },
    async commitSession(session, options) {
      const serialized = await c.serialize(session.data, options);
      if (serialized.length > 4096) {
        throw new Error(
          "createCookieSessionStorage: session data exceeds 4096 bytes — use a server-side store.",
        );
      }
      return serialized;
    },
    destroySession: (_session, options) => c.serialize("", expiredOptions(options)),
  };
}

/** A pluggable server-side session store (Remix `createSessionStorage`). */
export interface SessionIdStorageStrategy {
  cookie?: Cookie | (CookieOptions & { name?: string });
  createData(data: SessionData, expires?: Date): Promise<string>;
  readData(id: string): Promise<SessionData | null>;
  updateData(id: string, data: SessionData, expires?: Date): Promise<void>;
  deleteData(id: string): Promise<void>;
}

/**
 * Remix `createSessionStorage` — the session id lives in the cookie; the data lives in
 * a custom store the caller supplies (DB, KV, …).
 */
export function createSessionStorage(strategy: SessionIdStorageStrategy): SessionStorage {
  const c = resolveCookie(strategy.cookie, "__session");
  const expiresFrom = (o?: CookieSerializeOptions) =>
    o?.expires ?? (o?.maxAge != null ? new Date(Date.now() + o.maxAge * 1000) : undefined);
  return {
    async getSession(cookieHeader, options) {
      const id = cookieHeader ? (await c.parse(cookieHeader, options)) as string | null : null;
      const data = id ? await strategy.readData(id) : null;
      return createSession(data ?? {}, id ?? "");
    },
    async commitSession(session, options) {
      let id = session.id;
      if (id) await strategy.updateData(id, session.data, expiresFrom(options));
      else id = await strategy.createData(session.data, expiresFrom(options));
      return await c.serialize(id, options);
    },
    async destroySession(session, options) {
      if (session.id) await strategy.deleteData(session.id);
      return await c.serialize("", expiredOptions(options));
    },
  };
}

/**
 * Remix `createMemorySessionStorage` — {@link createSessionStorage} backed by an
 * in-process `Map`. For dev/tests/single-instance only (data is lost on restart and
 * not shared across instances).
 */
export function createMemorySessionStorage(
  { cookie }: { cookie?: Cookie | (CookieOptions & { name?: string }) } = {},
): SessionStorage {
  const store = new Map<string, { data: SessionData; expires?: Date }>();
  return createSessionStorage({
    cookie,
    createData(data, expires) {
      let id = crypto.randomUUID();
      while (store.has(id)) id = crypto.randomUUID();
      store.set(id, { data, expires });
      return Promise.resolve(id);
    },
    readData(id) {
      const rec = store.get(id);
      if (!rec) return Promise.resolve(null);
      if (rec.expires && rec.expires.getTime() < Date.now()) {
        store.delete(id);
        return Promise.resolve(null);
      }
      return Promise.resolve(rec.data);
    },
    updateData(id, data, expires) {
      store.set(id, { data, expires });
      return Promise.resolve();
    },
    deleteData(id) {
      store.delete(id);
      return Promise.resolve();
    },
  });
}

// ── Multipart uploads (unstable_parseMultipartFormData) ───────────────────────

/** One part of a multipart body, as passed to an {@link UploadHandler}. */
export interface UploadHandlerPart {
  name: string;
  filename?: string;
  contentType: string;
  data: AsyncIterable<Uint8Array>;
}
/** A Remix upload handler — returns the value to store for a part (a `File`/string), or skips it. */
export type UploadHandler = (
  part: UploadHandlerPart,
) => Promise<File | string | null | undefined> | File | string | null | undefined;

async function* fileChunks(file: File): AsyncIterable<Uint8Array> {
  const reader = file.stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    yield value;
  }
}

/**
 * Remix `unstable_parseMultipartFormData` — parse a multipart request into `FormData`.
 * Deno parses the multipart body natively; when an `uploadHandler` is given, each file
 * part is streamed through it and its return value stored under the field name.
 */
export async function unstable_parseMultipartFormData(
  request: Request,
  uploadHandler?: UploadHandler,
): Promise<FormData> {
  const form = await request.formData();
  if (!uploadHandler) return form;
  const out = new FormData();
  for (const [name, value] of form) {
    if (typeof value === "string") {
      out.append(name, value);
      continue;
    }
    const file = value as File;
    const result = await uploadHandler({
      name,
      filename: file.name || undefined,
      contentType: file.type,
      data: fileChunks(file),
    });
    if (typeof result === "string") out.append(name, result);
    else if (result) out.append(name, result, (result as File).name);
  }
  return out;
}
/** Alias for {@link unstable_parseMultipartFormData} (React Router v7 stabilized name). */
export const parseMultipartFormData = unstable_parseMultipartFormData;

/**
 * Remix `unstable_createMemoryUploadHandler` — buffer each part in memory: a file part
 * becomes a `File`, a plain field becomes its string value.
 */
export function unstable_createMemoryUploadHandler(): UploadHandler {
  return async (part) => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of part.data) chunks.push(chunk);
    const blob = new Blob(chunks as BlobPart[]);
    if (!part.filename) return decoder.decode(await blob.arrayBuffer());
    return new File([blob], part.filename, { type: part.contentType });
  };
}

// The root's `<html>`/`<body>` attributes (see `document.ts`) land on this request's context;
// the document assembler merges them onto denext's own tags.
setDocumentAttrsSink((part, attrs) => {
  const ctx = currentContext();
  if (ctx) (ctx.documentAttrs ??= {})[part] = attrs;
});
