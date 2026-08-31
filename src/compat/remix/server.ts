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
import { currentContext } from "../../server/request-context.ts";
import { redirect as denextRedirect } from "../../runtime/error-boundary.ts";
import { serverAction } from "../../runtime/server-action.ts";
import type { Metadata } from "../../server/types.ts";
import type { VNode, VNodeChildren } from "../../jsx/types.ts";

// ── Remix data helpers (json / redirect / defer) ──────────────────────────────

/** Remix `json()` — a JSON `Response` (unwrapped back to its value by {@link runLoader}). */
export function json<T>(data: T, init?: number | ResponseInit): Response {
  const responseInit: ResponseInit = typeof init === "number" ? { status: init } : { ...init };
  const headers = new Headers(responseInit.headers);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { ...responseInit, headers });
}

/** Remix `redirect()` — a redirect `Response` (turned into a denext redirect by the runner). */
export function redirect(url: string, init?: number | ResponseInit): Response {
  const responseInit: ResponseInit = typeof init === "number" ? { status: init } : { ...init };
  const status = responseInit.status ?? 302;
  const headers = new Headers(responseInit.headers);
  headers.set("Location", url);
  return new Response(null, { ...responseInit, status, headers });
}

/** Remix `redirectDocument()` — a hard redirect (same as {@link redirect} here). */
export const redirectDocument = redirect;

/**
 * Remix `defer()` — return a data object whose promise-valued fields stream. denext resolves
 * them client-side via `<Await>`/`use()`, so this passes the object through unchanged.
 */
export function defer<T extends Record<string, unknown>>(data: T): T {
  return data;
}

/** Whether a value is a `Response` (a loader/action returning `json()`/`redirect()`). */
function isResponse(value: unknown): value is Response {
  return typeof Response !== "undefined" && value instanceof Response;
}

/** Unwrap a loader/action return value: parse a `json()` body, honor a redirect, else pass through. */
async function unwrap(value: unknown): Promise<unknown> {
  if (!isResponse(value)) return value;
  const status = value.status;
  if (status >= 300 && status < 400) {
    const location = value.headers.get("Location") ?? "/";
    denextRedirect(location, status); // throws — denext control-flow signal
  }
  const type = value.headers.get("Content-Type") ?? "";
  if (type.includes("application/json")) return await value.json();
  const text = await value.text();
  return text.length ? text : null;
}

// ── The request/params/context passed to a loader/action ──────────────────────

/** Remix `LoaderFunctionArgs` — synthesized from denext's request context. */
export interface LoaderFunctionArgs {
  request: Request;
  params: Record<string, string>;
  context: Record<string, unknown>;
}
/** Remix `ActionFunctionArgs` — identical shape to {@link LoaderFunctionArgs}. */
export type ActionFunctionArgs = LoaderFunctionArgs;

/** A Remix `loader` export. */
export type LoaderFunction = (args: LoaderFunctionArgs) => unknown | Promise<unknown>;
/** A Remix `action` export. */
export type ActionFunction = (args: ActionFunctionArgs) => unknown | Promise<unknown>;

/** Build the `{ request, params, context }` a loader/action receives. */
function loaderArgs(params: Record<string, string>): LoaderFunctionArgs {
  const ctx = currentContext();
  const request = ctx?.request ??
    new Request("http://localhost/"); // export/prerender fallback (no live request)
  return { request, params, context: {} };
}

/** Run a Remix `loader` and return its unwrapped data (or `undefined` when absent). */
export async function runLoader(
  loader: LoaderFunction | undefined,
  params: Record<string, string>,
): Promise<unknown> {
  if (!loader) return undefined;
  return await unwrap(await loader(loaderArgs(params)));
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
    const request = new Request(url, { method: "POST", body: formData });
    return await unwrap(await action({ request, params, context: {} }));
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
  const result = await loader({ request, params, context: {} });
  return result instanceof Response ? result : Response.json(result ?? null);
}

/** Run a resource-route `action` and return its raw `Response`. */
export async function runActionResponse(
  action: ActionFunction | undefined,
  request: Request,
): Promise<Response> {
  if (!action) return new Response("Method Not Allowed", { status: 405 });
  const result = await action({ request, params: {}, context: {} });
  return result instanceof Response ? result : Response.json(result ?? null);
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
}

/**
 * Run a migrated Remix route's loader server-side, bind its action, and render the client
 * boundary with the loader data threaded as a **prop** (it crosses Flight; the client
 * boundary establishes `useLoaderData`/matches/action context in one unit). Awaited by the
 * generated server `page.tsx`.
 */
export async function RemixRoute(options: RemixRouteOptions): Promise<VNode> {
  const loaderData = await runLoader(options.loader, options.params);
  const formAction = bindAction(options.action, options.id, options.params);
  return h(options.Route, {
    id: options.id,
    loaderData,
    params: options.params,
    handle: options.handle,
    formAction,
  });
}

/** Props the generated `layout.tsx` passes to {@link RemixLayout}. */
export interface RemixLayoutOptions extends RemixRouteOptions {
  /** The nested route subtree (denext `children`), threaded to the layout's `<Outlet/>`. */
  children: VNodeChildren;
}

/** Like {@link RemixRoute}, but threads the nested-route `children` to the layout's `<Outlet/>`. */
export async function RemixLayout(options: RemixLayoutOptions): Promise<VNode> {
  const loaderData = await runLoader(options.loader, options.params);
  const formAction = bindAction(options.action, options.id, options.params);
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
export type MetaFunction = (
  args: { data: unknown; params: Record<string, string>; location: { pathname: string } },
) => RemixMetaDescriptor[];
/** A Remix `links` export. */
export type LinksFunction = () => Array<Record<string, unknown>>;
/** A Remix `headers` export. */
export type HeadersFunction = (
  args: { loaderHeaders: Headers; parentHeaders: Headers },
) => HeadersInit;

/**
 * Adapt a Remix `meta` export to a denext `generateMetadata`. Maps `{ title }` to
 * `metadata.title`, `{ name: "description" }` to `metadata.description`, and other
 * name/property descriptors into `openGraph`/`other` best-effort. Runs the route loader
 * to supply `data` (Remix meta receives loader data).
 */
export function remixMeta(
  meta: MetaFunction | undefined,
  loader: LoaderFunction | undefined,
):
  | ((
    props: { params: Record<string, string>; searchParams: URLSearchParams },
  ) => Promise<Metadata>)
  | undefined {
  if (!meta) return undefined;
  return async (props) => {
    const data = await runLoader(loader, props.params);
    const descriptors = meta({ data, params: props.params, location: { pathname: "" } }) ?? [];
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
  };
}

// ── Session/cookie stubs (flagged — not wired to a store) ─────────────────────

/**
 * Remix `createCookie` — a minimal shim. denext manages cookies via `cookies()` from
 * `denext/server`; this returns a compatible-shaped object for code that constructs cookies
 * directly, but does not integrate with a session store (port sessions by hand).
 */
export function createCookie(name: string, _options?: unknown): {
  name: string;
  parse: (header: string | null) => Promise<unknown>;
  serialize: (value: unknown) => Promise<string>;
} {
  return {
    name,
    parse: (header) => {
      const match = header?.match(new RegExp(`${name}=([^;]+)`));
      return Promise.resolve(match ? decodeURIComponent(match[1]) : null);
    },
    serialize: (value) => Promise.resolve(`${name}=${encodeURIComponent(String(value))}; Path=/`),
  };
}
