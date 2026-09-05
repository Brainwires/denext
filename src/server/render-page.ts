// Compose a matched page with its layout chain plus the App Router special
// files (loading -> Suspense fallback, error -> error boundary, not-found ->
// 404 UI), render to HTML, and resolve metadata.

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode } from "../jsx/types.ts";
import { collapseHeadTags, type HeadCollector, renderToString } from "../jsx/render-to-string.ts";
import { renderShell, type ShellRender } from "../jsx/render-to-stream.ts";
import { renderFontStyles } from "../compat/next/font/registry.ts";
import { type IslandPayload, renderToHtmlFlight } from "../jsx/render-to-html-flight.ts";
import { type FlightShellRender, renderFlightShell } from "../jsx/render-to-flight-stream.ts";
import type { FlightNode } from "../jsx/render-to-flight.ts";
import { prerenderToShell, type ResumedHole, resumeShellHoles } from "../jsx/render-to-ppr.ts";
import {
  prerenderToShellFlight,
  type ResumedFlightHole,
  resumeShellHolesFlight,
} from "../jsx/render-to-ppr-flight.ts";
import { withPrerender } from "../runtime/prerender.ts";
import { Suspense } from "../runtime/suspense.ts";
import {
  ErrorBoundary,
  isForbidden,
  isNotFound,
  isUnauthorized,
  notFound,
  toClientError,
} from "../runtime/error-boundary.ts";
import { matchSlot, type PageMatch } from "../router/match.ts";
import type { RouteManifest, SegmentLevel, SlotRoutes } from "../router/manifest.ts";
import { provideLayoutSegments } from "../runtime/layout-segments.ts";
import { paramPath, type RouteParams } from "../router/segments.ts";
import { asyncProps, type SearchParams, searchParamsRecord } from "../runtime/async-props.ts";
import { enumerateStaticParams } from "./static-params.ts";
import { type Messages, provideMessages } from "../runtime/i18n-messages.ts";
import type {
  LayoutModule,
  Metadata,
  ModuleLoader,
  PageModule,
  PageProps,
  Viewport,
} from "./types.ts";
import {
  DEFAULT_SEGMENT_CONFIG,
  mergeSegmentConfig,
  readSegmentConfig,
  type SegmentConfig,
} from "./segment-config.ts";
import { addResourceHint, currentContext, trackSearchParamReads } from "./request-context.ts";
import { setSsrHintSink } from "../compat/react-dom-preload.ts";

// Route SSR resource hints (preload/preinit/preconnect/prefetchDNS) into the active
// request's head. Installed once here — a server-only module — so the client-shipped
// preload module never imports `node:async_hooks`.
setSsrHintSink(addResourceHint);

/** The result of rendering a page: its HTML fragment, resolved metadata, and status. */
export interface RenderedPage {
  /** HTML for the hydration root's inner content. */
  html: string;
  /** Merged metadata resolved from the page and its layout chain. */
  metadata: Metadata;
  /** Merged viewport/theme metadata from the page and its layout chain. */
  viewport?: Viewport;
  /** HTTP status (200, or 404 when notFound() was called). */
  status: number;
  /** Effective route segment config (page merged over its layout chain). */
  config: SegmentConfig;
  /**
   * `html` is a COMPLETE document (`global-error.tsx` renders its own `<html>`/`<body>`,
   * replacing the root layout) — the response must not wrap it in denext's shell.
   */
  ownsDocument?: boolean;
  /**
   * The Flight payload for the rendered tree, present only when the route uses
   * the client/server boundary (a `"use client"` module is involved) and flight
   * was requested. The browser hydrates from this instead of a re-imported tree.
   */
  flight?: FlightNode;
  /**
   * Lazy (`client:*`) islands carved out of the Flight tree for deferred
   * per-island hydration. Emitted as the `#__denext_islands` document island.
   */
  islands?: IslandPayload[];
  /**
   * Serialized signal state (`useId → value`), emitted as the `#__denext_state`
   * document island and adopted by the client on resume.
   */
  signalState?: Record<string, unknown>;
}

/** Options controlling how a page is rendered. */
export interface RenderPageOptions {
  /**
   * When true, render the tree to Flight (in addition to HTML) so client
   * islands can hydrate as references. Requires client modules to be tagged
   * (see {@link tagClientExports}) — typically via a tagging module loader.
   */
  flight?: boolean;
  /**
   * The active locale's message catalog. When present, the tree is wrapped in a
   * messages provider so `useTranslations()` resolves during server rendering.
   */
  messages?: Messages;
  /**
   * The per-request abort signal. Checked cooperatively between module loads and
   * before the (expensive) render, so a client disconnect or request timeout stops
   * the render instead of running it to completion and discarding the result.
   */
  signal?: AbortSignal;
  /**
   * Invoked with the **raw** error each time an `error.tsx` boundary catches during
   * this render. A caught boundary renders its fallback and the render succeeds, so
   * the error would otherwise be swallowed — the caller uses this to report it to
   * `onRequestError` and log it. Called during rendering; keep it non-throwing and
   * cheap (defer any async reporting).
   */
  onCaughtError?: (error: unknown) => void;
}

/** The composed page tree plus its resolved metadata/config, before rendering. */
export interface PageContext {
  /** The full VNode tree (page wrapped in loading/error/templates/layouts/messages). */
  tree: VNode;
  /** Merged metadata (page over layout chain), before in-tree `<title>` hoisting. */
  metadata: Metadata;
  /** Merged viewport. */
  viewport: Viewport;
  /** Effective route segment config. */
  config: SegmentConfig;
  /**
   * True when `dynamicParams:false` should 404 this request (params not enumerated
   * by `generateStaticParams`). The render entries throw `notFound()` for it inside
   * their try/catch so it becomes the 404 UI. See {@link isStaticParamDisallowed}.
   */
  staticParamsNotFound?: boolean;
}

/**
 * Enumerated `generateStaticParams` sets, memoized per route file so the enforcement
 * below (and repeated requests) don't re-run the generator. A route with no
 * `generateStaticParams` memoizes `null`.
 */
const staticParamsCache = new Map<string, RouteParams[] | null>();

/**
 * Whether `export const dynamicParams = false` should 404 this request: a dynamic
 * route may only serve the param sets its `generateStaticParams` enumerates; any
 * other params are "not found" (Next.js parity). A route with dynamic segments but
 * no `generateStaticParams` disallows every param. Static routes (no params) are
 * always allowed. Returns true when the request should 404.
 *
 * Computed in {@link buildPageContext} (which has the loaded module) but NOT thrown
 * there — the render entries throw `notFound()` inside their own try/catch, where
 * it is turned into the 404 UI, so it never escapes as an uncaught signal.
 */
async function isStaticParamDisallowed(
  match: PageMatch,
  load: ModuleLoader,
): Promise<boolean> {
  const params = match.params;
  const keys = Object.keys(params);
  if (keys.length === 0) return false; // static route: dynamicParams is irrelevant

  const filePath = match.route.filePath;
  let known = staticParamsCache.get(filePath);
  if (known === undefined) {
    known = await enumerateStaticParams(match.route, load);
    staticParamsCache.set(filePath, known);
  }
  // No generateStaticParams → no params are known → every dynamic param 404s.
  if (known === null) return true;
  // Allowed only if this request's params match an enumerated set (each key equal).
  return !known.some((set) => keys.every((k) => paramPath(set[k]) === paramPath(params[k])));
}

/**
 * The page's props in Next.js 15's shape: `params` and `searchParams` are records that are
 * ALSO awaitable (`await params` works), `searchParams` is the query as a record with the
 * `URLSearchParams` on `.raw`. Reads are tracked only when `cacheKeyParams` narrows the
 * ISR key (the page cache's cross-request-bleed dev-warn).
 */
function pageProps(params: RouteParams, search: URLSearchParams): PageProps {
  const tracked = trackSearchParamReads(search);
  // Built from the PLAIN params (iterating the tracker would count every name as read).
  const record = trackRecordReads(searchParamsRecord(search, tracked), tracked);
  return { params: asyncProps({ ...params }), searchParams: asyncProps(record) };
}

/**
 * Route a record's property reads through the tracked `URLSearchParams` so the ISR
 * narrowed-key dev-warn sees them (a `Proxy` is only installed when tracking is on —
 * `trackSearchParamReads` returns its input untouched otherwise).
 */
function trackRecordReads(
  record: SearchParams & { readonly raw: URLSearchParams },
  tracked: URLSearchParams,
): SearchParams & { readonly raw: URLSearchParams } {
  if (!currentContext()?.trackParamReads) return record;
  return new Proxy(record, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && prop !== "raw" && prop !== "then") tracked.has(prop);
      return Reflect.get(target, prop, receiver);
    },
  });
}

/**
 * Compose a matched page with its layout chain, loading/error boundaries,
 * templates, and locale messages into a render-ready VNode tree, and resolve its
 * metadata/viewport/segment-config. Shared by the normal render, the PPR
 * prerender, and the PPR resume so all three build an identical tree.
 */
export async function buildPageContext(
  match: PageMatch,
  request: Request,
  load: ModuleLoader,
  options: RenderPageOptions,
): Promise<PageContext> {
  const url = new URL(request.url);
  // `request` is intentionally NOT placed on props — per-request data flows
  // through cookies()/headers() (which mark the render dynamic). See PageProps.
  const props = pageProps(match.params, url.searchParams);

  options.signal?.throwIfAborted();
  const pageModule = (await load(match.route.filePath)) as PageModule;
  if (typeof pageModule.default !== "function") {
    throw new Error(
      `Page module ${match.route.filePath} has no default export component.`,
    );
  }
  const config = await resolveSegmentConfig(match, pageModule, load);
  // `dynamicParams = false`: a param not enumerated by generateStaticParams 404s.
  // Decided here (module is loaded); the render entries throw notFound() for it.
  const staticParamsNotFound = config.dynamicParams === false &&
    await isStaticParamDisallowed(match, load);

  const page = h(pageModule.default, props as never);
  options.signal?.throwIfAborted();
  const soft = request.headers.get("x-denext-nav") === "1";
  const wrapped = match.route.levels
    ? await wrapLevels(match, page, load, options, url.pathname, soft, props)
    : await wrapLayouts(
      match,
      await wrapBoundaries(match, page, load, options),
      load,
      url.pathname,
      soft,
      props,
    );
  // Provide the active locale's messages so useTranslations() resolves in SSR
  // (server components and SSR'd client islands); the client reads the same
  // catalog from the hydration payload.
  const tree = options.messages ? provideMessages(options.messages, wrapped.tree) : wrapped.tree;
  const metadata = mergeMetadata([
    ...wrapped.layoutMetas,
    await resolvePageMetadata(pageModule, props, wrapped.layoutMetas),
  ]);
  const viewport = mergeViewport([
    ...wrapped.layoutViewports,
    await resolvePageViewport(pageModule, props, wrapped.layoutViewports),
  ]);
  return { tree, metadata, viewport, config, staticParamsNotFound };
}

/**
 * The effective route segment config: layout chain (outer→inner) then the page,
 * exposed to the dynamic-API guards (cookies()/headers()/connection()) — `dynamic:
 * "error"` makes them throw, `force-static` makes them return empty without marking
 * the render dynamic. Set before generateMetadata / the render, both of which may
 * read a dynamic API.
 */
async function resolveSegmentConfig(
  match: PageMatch,
  pageModule: PageModule,
  load: ModuleLoader,
): Promise<SegmentConfig> {
  let config = DEFAULT_SEGMENT_CONFIG;
  for (const layoutPath of match.route.layoutChain) {
    config = mergeSegmentConfig(config, readSegmentConfig(await load(layoutPath)));
  }
  config = mergeSegmentConfig(config, readSegmentConfig(pageModule));
  const reqCtx = currentContext();
  if (reqCtx) reqCtx.segmentConfig = config;
  return config;
}

/**
 * Wrap the page element in its `loading` (Suspense) and `error` boundaries, then its
 * templates. Templates wrap like layouts but conceptually re-mount on navigation
 * (which, in denext, always happens because soft navigation re-runs the route bundle).
 */
async function wrapBoundaries(
  match: PageMatch,
  page: VNode,
  load: ModuleLoader,
  options: RenderPageOptions,
): Promise<VNode> {
  let content = page;
  if (match.route.loading) {
    const loadingMod = (await load(match.route.loading)) as { default: () => VNode };
    content = h(Suspense, {
      fallback: h(loadingMod.default, {}),
      children: content,
    });
  }
  if (match.route.error) {
    const errorMod = (await load(match.route.error)) as { default: never };
    content = h(ErrorBoundary, {
      fallback: errorMod.default,
      children: content,
      onCaught: options.onCaughtError,
    });
  }
  for (let i = match.route.templateChain.length - 1; i >= 0; i--) {
    const tpl = (await load(match.route.templateChain[i])) as LayoutModule;
    if (typeof tpl.default !== "function") {
      throw new Error(`Template module ${match.route.templateChain[i]} has no default.`);
    }
    content = h(
      tpl.default,
      { children: content, params: asyncProps({ ...match.params }) } as never,
    );
  }
  return content;
}

/** Page metadata: static `metadata`, `metadata` fn, or `generateMetadata(props, parent)`. */
async function resolvePageMetadata(
  pageModule: PageModule,
  props: PageProps,
  layoutMetas: Metadata[] = [],
): Promise<Metadata> {
  if (typeof pageModule.generateMetadata === "function") {
    return await pageModule.generateMetadata(props, Promise.resolve(mergeMetadata(layoutMetas)));
  }
  if (typeof pageModule.metadata === "function") return await pageModule.metadata(props);
  return pageModule.metadata ?? {};
}

/** Page viewport: `generateViewport(props, parent)` or static `viewport`. */
async function resolvePageViewport(
  pageModule: PageModule,
  props: PageProps,
  layoutViewports: Viewport[] = [],
): Promise<Viewport> {
  if (typeof pageModule.generateViewport === "function") {
    return await pageModule.generateViewport(
      props,
      Promise.resolve(mergeViewport(layoutViewports)),
    );
  }
  return pageModule.viewport ?? {};
}

/** Render a matched page (with layouts + boundaries) to an HTML fragment. */
export async function renderPage(
  match: PageMatch,
  request: Request,
  load: ModuleLoader,
  options: RenderPageOptions = {},
  prebuilt?: PageContext,
): Promise<RenderedPage> {
  const ctx = prebuilt ?? await buildPageContext(match, request, load, options);
  const { tree, metadata, viewport, config } = ctx;

  options.signal?.throwIfAborted();
  try {
    // dynamicParams:false with a param outside generateStaticParams → 404 (caught
    // just below and rendered as the notFound UI).
    if (ctx.staticParamsNotFound) notFound();
    // Hoist any in-tree <title>/<meta>/<link> into the document metadata.
    const head: HeadCollector = { tags: [] };
    let html: string;
    let flight: FlightNode | undefined;
    let islands: IslandPayload[] | undefined;
    let signalState: Record<string, unknown> | undefined;
    if (options.flight) {
      // Single-pass: emit HTML and Flight together so useId stays aligned.
      const r = await renderToHtmlFlight(tree, { head, resumable: config.resumable });
      html = r.html;
      flight = r.flight;
      if (r.islands.length > 0) islands = r.islands;
      if (Object.keys(r.signalState).length > 0) signalState = r.signalState;
    } else {
      html = await renderToString(tree, { head });
    }
    hoistHeadIntoMetadata(head, metadata);
    return { html, metadata, status: 200, config, flight, islands, signalState, viewport };
  } catch (err) {
    const signal = signalUiFor(err, match);
    if (!signal) throw err;
    return renderSignalUI(match, load, metadata, config, signal.route, signal);
  }
}

/** The built-in UI for each control signal, keyed by the predicate that detects it. */
const SIGNAL_UIS: Array<
  [
    (err: unknown) => boolean,
    keyof Pick<PageMatch["route"], "notFound" | "forbidden" | "unauthorized">,
    SignalUI,
  ]
> = [
  [isNotFound, "notFound", {
    status: 404,
    title: "404 — Not Found",
    heading: "404",
    message: "This page could not be found.",
  }],
  [isForbidden, "forbidden", {
    status: 403,
    title: "403 — Forbidden",
    heading: "403",
    message: "You don't have access to this resource.",
  }],
  [isUnauthorized, "unauthorized", {
    status: 401,
    title: "401 — Unauthorized",
    heading: "401",
    message: "You must be signed in to view this page.",
  }],
];

/**
 * Classify a thrown control signal (notFound/forbidden/unauthorized): its UI text and
 * the route's own file for it, or `null` for redirect() and real errors (which bubble).
 */
function signalUiFor(err: unknown, match: PageMatch): (SignalUI & { route: string | null }) | null {
  for (const [is, file, ui] of SIGNAL_UIS) {
    if (is(err)) return { ...ui, route: match.route[file] };
  }
  return null;
}

/**
 * The result of {@link renderPageShell}: either a streamable shell (`shell` set,
 * status 200) or a buffered page produced when a control signal
 * (`notFound`/`forbidden`/`unauthorized`) fired during the shell render (`html`
 * set, non-200 status). Exactly one of `shell`/`html` is present.
 */
export interface PageShellResult {
  /** The rendered shell + hole drainer, for streaming (present on a 200 render). */
  shell?: ShellRender;
  /** Buffered HTML for a control-signal page (404/403/401), if that fired. */
  html?: string;
  /** Merged metadata, with in-tree `<title>`/head tags hoisted from the shell. */
  metadata: Metadata;
  /** Merged viewport. */
  viewport: Viewport;
  /** Effective route segment config. */
  config: SegmentConfig;
  /** HTTP status (200 for a normal render; 404/403/401 for a control signal). */
  status: number;
}

/**
 * Hoist everything a shell render collects into the page metadata's `<head>`:
 * an in-tree `<title>` (wins over route metadata), `<meta>`/`<link>` tags,
 * server-inserted HTML (CSS-in-JS registries via `useServerInsertedHTML`),
 * request resource hints, and font `@font-face` CSS. Shared verbatim by the HTML
 * ({@link renderPageShell}) and Flight ({@link renderPageFlightShell}) shells.
 */
function hoistHeadIntoMetadata(head: HeadCollector, metadata: Metadata): void {
  if (head.title !== undefined) metadata.title = head.title; // in-tree title wins
  // Collect every head contribution, then append once: in-tree `<meta>`/`<link>`
  // tags (next/head dedup: same `key`/charset/viewport → last wins), server-inserted
  // HTML (CSS-in-JS via `useServerInsertedHTML`), imperative
  // SSR resource hints (preload/preinit/preconnect/prefetchDNS), and next/font CSS
  // (localFont/google register at module load; this injects their `@font-face`).
  const parts = [
    collapseHeadTags(head.tags),
    head.serverInserted?.join("") ?? "",
    currentContext()?.resourceHints?.join("") ?? "",
    renderFontStyles(),
  ];
  const extra = parts.join("");
  if (extra) metadata.head = (metadata.head ?? "") + extra;
}

/**
 * Turn a control signal (`notFound`/`forbidden`/`unauthorized`) thrown during a
 * pre-flush shell render into a buffered signal-UI page (the status can still
 * change because nothing has flushed yet). `redirect()` and real errors are
 * rethrown to the caller. Shared by the HTML and Flight shell renderers; a
 * control signal thrown inside a Suspense boundary resolves after the flush and
 * is handled as a failed hole instead.
 */
async function bufferedSignalPage(
  err: unknown,
  match: PageMatch,
  load: ModuleLoader,
  metadata: Metadata,
  viewport: Viewport,
  config: SegmentConfig,
): Promise<{
  html: string;
  metadata: Metadata;
  viewport: Viewport;
  config: SegmentConfig;
  status: number;
}> {
  const signal = signalUiFor(err, match);
  if (!signal) throw err; // redirect() and real errors bubble to the caller
  const ui = await renderSignalUI(match, load, metadata, config, signal.route, signal);
  return { html: ui.html, metadata: ui.metadata, viewport, config: ui.config, status: ui.status };
}

/**
 * The shared shell-render envelope behind {@link renderPageShell} and
 * {@link renderPageFlightShell} (identical apart from which inner shell they
 * render): build the page context, render the shell via `renderInner`, hoist
 * in-tree `<title>`/`<meta>`/`<link>` into the metadata, and turn a control
 * signal thrown before any flush into a buffered signal-UI page. Returns the
 * rendered inner shell as `inner` on a 200, or `html` for a buffered signal page;
 * `redirect()` and real errors bubble to the caller.
 */
async function renderShellEnvelope<R>(
  match: PageMatch,
  request: Request,
  load: ModuleLoader,
  options: RenderPageOptions,
  prebuilt: PageContext | undefined,
  renderInner: (tree: VNode, head: HeadCollector, config: SegmentConfig) => Promise<R>,
): Promise<
  & { metadata: Metadata; viewport: Viewport; config: SegmentConfig; status: number }
  & ({ inner: R; html?: undefined } | { inner?: undefined; html: string })
> {
  const ctx = prebuilt ?? await buildPageContext(match, request, load, options);
  const { tree, metadata, viewport, config } = ctx;
  options.signal?.throwIfAborted();
  const head: HeadCollector = { tags: [] };
  try {
    // dynamicParams:false with an unenumerated param → 404 (turned into the
    // buffered signal-UI page by the catch below, before any bytes flush).
    if (ctx.staticParamsNotFound) notFound();
    const inner = await renderInner(tree, head, config);
    hoistHeadIntoMetadata(head, metadata);
    return { inner, metadata, viewport, config, status: 200 };
  } catch (err) {
    return await bufferedSignalPage(err, match, load, metadata, viewport, config);
  }
}

/**
 * Render a matched page's **shell** for incremental streaming: compose the tree
 * (as {@link renderPage} does) and render its shell eagerly, hoisting in-tree
 * `<title>`/`<meta>`/`<link>` from the shell into the metadata. A control signal
 * thrown during the shell render is turned into a buffered signal-UI page here
 * (before any bytes flush); `redirect()` and real errors bubble to the caller.
 * Suspense holes are left pending on the returned `shell` for the document
 * assembler to stream.
 */
export async function renderPageShell(
  match: PageMatch,
  request: Request,
  load: ModuleLoader,
  options: RenderPageOptions = {},
  prebuilt?: PageContext,
): Promise<PageShellResult> {
  // Dev-only: collect per-Suspense-boundary server timing for the DevTools
  // per-boundary timeline (emitted as a JSON island by `streamHoles`).
  const collectTiming = (globalThis as { __denextDev?: boolean }).__denextDev === true;
  const r = await renderShellEnvelope(
    match,
    request,
    load,
    options,
    prebuilt,
    (tree, head) => renderShell(tree, head, collectTiming),
  );
  const { metadata, viewport, config, status } = r;
  return r.inner !== undefined
    ? { shell: r.inner, metadata, viewport, config, status }
    : { html: r.html, metadata, viewport, config, status };
}

/** Result of {@link renderPageFlightShell}: the Flight shell drainer, or a signal page. */
export interface PageFlightShellResult {
  /** The rendered Flight shell + hole/tail drainer (present on a 200 render). */
  flightShell?: FlightShellRender;
  /** Buffered HTML for a control-signal page (404/403/401), if that fired. */
  html?: string;
  /** Merged metadata, with in-tree `<title>`/head tags hoisted from the shell. */
  metadata: Metadata;
  /** Merged viewport. */
  viewport: Viewport;
  /** Effective route segment config. */
  config: SegmentConfig;
  /** HTTP status (200 for a normal render; 404/403/401 for a control signal). */
  status: number;
}

/**
 * Render a Flight route's **shell** for incremental streaming: the Flight analogue
 * of {@link renderPageShell}. Composes the tree with `flight: true`, renders the
 * Flight shell eagerly (hoisting in-tree head tags), and returns the pending
 * holes + the trailing Flight/islands/signal-state payload via `flightShell`. A
 * control signal thrown before any flush becomes a buffered signal-UI page here;
 * `redirect()` and real errors bubble to the caller.
 */
export async function renderPageFlightShell(
  match: PageMatch,
  request: Request,
  load: ModuleLoader,
  options: RenderPageOptions = {},
  prebuilt?: PageContext,
): Promise<PageFlightShellResult> {
  const r = await renderShellEnvelope(
    match,
    request,
    load,
    options,
    prebuilt,
    (tree, head, config) => renderFlightShell(tree, config.resumable, head),
  );
  const { metadata, viewport, config, status } = r;
  return r.inner !== undefined
    ? { flightShell: r.inner, metadata, viewport, config, status }
    : { html: r.html, metadata, viewport, config, status };
}

/**
 * The result of a PPR prerender: a request-independent static shell plus the ids
 * of its dynamic holes. `dynamic` is true when the page cannot be prerendered
 * (a dynamic read escaped every Suspense boundary, or the prerender hit a control
 * signal/error) — the caller renders it normally via {@link renderPage} instead.
 */
export interface PrerenderedPage {
  /** True ⇒ no static shell; render this request via {@link renderPage}. */
  dynamic: boolean;
  /** The static shell body (holes shown as marker-wrapped fallbacks). */
  shellBody: string;
  /** Dynamic-hole ids, in order. Empty ⇒ a fully static page (cache as usual). */
  holeIds: string[];
  /** Merged metadata, with in-tree `<title>`/head tags hoisted from the shell. */
  metadata: Metadata;
  /** Merged viewport. */
  viewport: Viewport;
  /**
   * Static head extras that the shell prerender appended to `metadata.head`
   * (in-tree `<meta>`/`<link>`, SSR resource hints, font CSS). These come from the
   * cached shell — a per-request resume can't recompute them — so a PPR cache hit
   * re-runs `generateMetadata` per request and re-merges these to rebuild the head.
   */
  headExtras: string;
  /** An in-tree `<title>` hoisted from the shell (wins over `generateMetadata`), if any. */
  inTreeTitle?: string;
  /** HTTP status (always 200 for a successful prerender). */
  status: number;
  /** Effective route segment config. */
  config: SegmentConfig;
}

/**
 * Prerender a matched page (Cache Components / PPR): produce a cacheable static
 * shell plus its dynamic-hole ids. Dynamic reads outside a `use cache` scope
 * postpone, turning the nearest Suspense boundary into a per-request hole. If the
 * page cannot be prerendered, returns `{ dynamic: true }` so the caller falls back
 * to the normal render. Must run inside the request context.
 */
export async function prerenderPage(
  match: PageMatch,
  request: Request,
  load: ModuleLoader,
  options: RenderPageOptions = {},
): Promise<PrerenderedPage> {
  const ctx = await buildPageContext(match, request, load, options);
  const { tree, metadata, viewport, config } = ctx;
  const bail = (): PrerenderedPage => dynamicPrerender(ctx);

  // dynamicParams:false with an unenumerated param: fall back to the normal render,
  // which throws notFound() and serves the 404 UI.
  if (ctx.staticParamsNotFound) return bail();

  options.signal?.throwIfAborted();
  try {
    const head: HeadCollector = { tags: [] };
    const result = await withPrerender(() => prerenderToShell(tree, { head }));
    if (result.dynamic) return bail();
    return {
      dynamic: false,
      shellBody: result.shell,
      holeIds: result.postponedIds,
      metadata,
      viewport,
      ...hoistStaticHead(head, metadata, true),
      status: 200,
      config,
    };
  } catch {
    // A control signal (notFound/redirect/…) or any error during prerender: fall
    // back to the proven normal render for this request rather than mis-cache a
    // shell. renderPage will re-encounter and handle it correctly.
    return bail();
  }
}

/** The `{ dynamic: true }` prerender result: the caller falls back to the normal render. */
function dynamicPrerender(ctx: PageContext): PrerenderedPage {
  return {
    dynamic: true,
    shellBody: "",
    holeIds: [],
    metadata: ctx.metadata,
    viewport: ctx.viewport,
    headExtras: "",
    status: 200,
    config: ctx.config,
  };
}

/**
 * Hoist what the (cached) shell prerender collected — in-tree `<title>`/tags, server-
 * inserted HTML (HTML prerender only), SSR resource hints, font CSS — onto `metadata`,
 * and return the STATIC head extras tracked separately from generateMetadata's
 * per-request output, so a cache hit can re-merge them onto freshly-resolved metadata.
 */
function hoistStaticHead(
  head: HeadCollector,
  metadata: Metadata,
  withServerInserted: boolean,
): { headExtras: string; inTreeTitle?: string } {
  const inTreeTitle = head.title;
  if (inTreeTitle !== undefined) metadata.title = inTreeTitle; // in-tree title wins
  const parts = [
    collapseHeadTags(head.tags),
    withServerInserted ? (head.serverInserted ?? []).join("") : "",
    (currentContext()?.resourceHints ?? []).join(""),
    renderFontStyles(),
  ];
  const headExtras = parts.join("");
  if (headExtras) metadata.head = (metadata.head ?? "") + headExtras;
  return { headExtras, inTreeTitle };
}

/**
 * The result of a Flight PPR prerender: everything {@link PrerenderedPage} carries
 * PLUS the request-independent Flight shell payload (Flight tree with unfilled holes,
 * shell islands, shell signal state). These are cached alongside the shell body so a
 * per-request resume can fill the holes and merge in its own islands/signals, emitting
 * the same trailing payload a non-PPR streamed Flight route emits.
 */
export interface PrerenderedFlightPage extends PrerenderedPage {
  /** The shell Flight tree (holes as `{$:"$",r:id}`), filled per request on resume. */
  flightShell: FlightNode;
  /** `client:*` islands in the static shell, keyed by tree-path id. */
  flightIslands: IslandPayload[];
  /** Signal state (`useId → value`) captured in the static shell. */
  flightSignalState: Record<string, unknown>;
}

/**
 * Prerender a matched Flight ("use client") page (Cache Components / PPR): the Flight
 * analogue of {@link prerenderPage}. Produces a cacheable static shell — HTML body +
 * Flight tree + islands + signal state — plus its dynamic-hole ids. If the page cannot
 * be prerendered, returns `{ dynamic: true }` so the caller falls back to the normal
 * render. Must run inside the request context.
 */
export async function prerenderPageFlight(
  match: PageMatch,
  request: Request,
  load: ModuleLoader,
  options: RenderPageOptions = {},
): Promise<PrerenderedFlightPage> {
  const ctx = await buildPageContext(match, request, load, options);
  const { tree, metadata, viewport, config } = ctx;
  const bail = (): PrerenderedFlightPage => ({
    ...dynamicPrerender(ctx),
    flightShell: null,
    flightIslands: [],
    flightSignalState: {},
  });

  // dynamicParams:false with an unenumerated param: fall back to the normal render.
  if (ctx.staticParamsNotFound) return bail();

  options.signal?.throwIfAborted();
  try {
    const head: HeadCollector = { tags: [] };
    const result = await withPrerender(() =>
      prerenderToShellFlight(tree, { head, resumable: config.resumable })
    );
    if (result.dynamic) return bail();
    return {
      dynamic: false,
      shellBody: result.shell,
      holeIds: result.postponedIds,
      metadata,
      viewport,
      ...hoistStaticHead(head, metadata, false),
      status: 200,
      config,
      flightShell: result.flight,
      flightIslands: result.islands,
      flightSignalState: result.signalState,
    };
  } catch {
    // A control signal or any error during prerender: fall back to the proven normal
    // render for this request rather than mis-cache a shell.
    return bail();
  }
}

/** A streamed Flight resume: holes (unawaited) + live island/signal accumulators. */
export interface StreamedFlightPage {
  /** Each dynamic hole (html + Flight subtree, both possibly resolving). */
  holes: ResumedFlightHole[];
  /** Islands discovered inside the holes — complete once every hole is awaited. */
  islands: IslandPayload[];
  /** Close signal collection (call after draining all holes) → the resume signal map. */
  finishSignals(): Record<string, unknown>;
  /** Metadata resolved for THIS request (see {@link ResumedPage.metadata}). */
  metadata: Metadata;
  /** Viewport resolved for THIS request. */
  viewport: Viewport;
}

/**
 * Resume a Flight PPR page's dynamic holes for the current request: rebuild the
 * (same) tree and render only `holeIds` with the real request context, returning each
 * hole's HTML + Flight subtree (unawaited, to stream) plus the islands/signals found
 * inside them and the per-request metadata/viewport. The Flight analogue of
 * {@link resumePageHolesStream}. Must run inside the request context.
 */
export async function resumePageHolesFlightStream(
  match: PageMatch,
  request: Request,
  load: ModuleLoader,
  holeIds: string[],
  options: RenderPageOptions = {},
): Promise<StreamedFlightPage> {
  const ctx = await buildPageContext(match, request, load, options);
  const { tree, metadata, viewport, config } = ctx;
  const res = await resumeShellHolesFlight(tree, new Set(holeIds), {
    resumable: config.resumable,
  });
  return {
    holes: res.holes,
    islands: res.islands,
    finishSignals: res.finishSignals,
    metadata,
    viewport,
  };
}

/** A resumed PPR request: the holes to splice, plus this request's metadata. */
export interface ResumedPage {
  /** Each dynamic hole's rendered HTML, by id. */
  holes: Map<string, string>;
  /**
   * Metadata resolved for THIS request (its `generateMetadata` ran in the real
   * request context, so it reflects per-request cookies/headers). Static in-tree
   * head extras from the cached shell are NOT re-included here — the caller merges
   * {@link PrerenderedPage.headExtras} back on before rebuilding the head.
   */
  metadata: Metadata;
  /** Viewport resolved for THIS request. */
  viewport: Viewport;
}

/**
 * Resume a PPR page's dynamic holes for the current request: rebuild the (same)
 * tree and render only the given `holeIds` with the real request context. Returns
 * each hole's HTML by id (to splice into the cached shell) plus the per-request
 * metadata/viewport (so the cache hit can rebuild the head — `generateMetadata`
 * may read cookies/headers). Must run inside the request context.
 */
export async function resumePageHoles(
  match: PageMatch,
  request: Request,
  load: ModuleLoader,
  holeIds: string[],
  options: RenderPageOptions = {},
): Promise<ResumedPage> {
  const { tree, metadata, viewport } = await buildPageContext(match, request, load, options);
  const { holes } = await resumeShellHoles(tree, new Set(holeIds));
  const out = new Map<string, string>();
  await Promise.all(holes.map(async (hole) => {
    out.set(hole.id, await hole.html);
  }));
  return { holes: out, metadata, viewport };
}

/** A streamed resume: the holes as they resolve (unawaited), plus per-request metadata. */
export interface StreamedPage {
  /** Each dynamic hole (its `html` may still be resolving) — streamed as it settles. */
  holes: ResumedHole[];
  /** Metadata resolved for THIS request (see {@link ResumedPage.metadata}). */
  metadata: Metadata;
  /** Viewport resolved for THIS request. */
  viewport: Viewport;
}

/**
 * Like {@link resumePageHoles}, but returns the holes **unawaited** so they can be
 * streamed into the cached shell as each resolves (see `streamPprDocument`). Must
 * run inside the request context.
 */
export async function resumePageHolesStream(
  match: PageMatch,
  request: Request,
  load: ModuleLoader,
  holeIds: string[],
  options: RenderPageOptions = {},
): Promise<StreamedPage> {
  const { tree, metadata, viewport } = await buildPageContext(match, request, load, options);
  const { holes } = await resumeShellHoles(tree, new Set(holeIds));
  return { holes, metadata, viewport };
}

interface SignalUI {
  status: number;
  title: string;
  heading: string;
  message: string;
}

/** Render a control-signal UI (not-found/forbidden/unauthorized) within layouts. */
async function renderSignalUI(
  match: PageMatch,
  load: ModuleLoader,
  metadata: Metadata,
  config: SegmentConfig,
  file: string | null,
  ui: SignalUI,
): Promise<RenderedPage> {
  let content: VNode;
  if (file) {
    const mod = (await load(file)) as { default: () => VNode };
    content = h(mod.default, {});
  } else {
    content = h("div", { class: "denext-status" }, [
      h("h1", null, ui.heading),
      h("p", null, ui.message),
    ]);
  }
  // Signal UI (404/403/…): render slot defaults (no URL to match against).
  const signalProps: PageProps = pageProps(match.params, new URLSearchParams());
  const { tree } = await wrapLayouts(match, content, load, "", false, signalProps);
  const html = await renderToString(tree);
  return {
    html,
    metadata: { ...metadata, title: metadata.title ?? ui.title },
    status: ui.status,
    config,
  };
}

/** Wrap a content node in the page's layout chain (innermost -> outermost). */
async function wrapLayouts(
  match: PageMatch,
  content: VNode,
  load: ModuleLoader,
  pathname: string,
  soft: boolean,
  props: PageProps,
): Promise<{ tree: VNode; layoutMetas: Metadata[]; layoutViewports: Viewport[] }> {
  let tree = content;
  const { layoutMetas, layoutViewports } = await resolveLayoutMetadata(match, load, props);
  const layoutSlots = match.route.layoutSlots;
  const innermost = match.route.layoutChain.length - 1;
  for (let i = innermost; i >= 0; i--) {
    const layoutModule = (await load(match.route.layoutChain[i])) as LayoutModule;
    if (typeof layoutModule.default !== "function") {
      throw new Error(`Layout module ${match.route.layoutChain[i]} has no default.`);
    }

    // Parallel-route slots declared at this layout's level render into it as
    // named props, matched against the current URL (so a slot spans children).
    const slotMap = layoutSlots?.[i];
    const slotProps = slotMap
      ? await renderSlotMap(slotMap, match.params, load, pathname, soft)
      : {};
    tree = h(layoutModule.default, {
      children: tree,
      params: props.params,
      ...slotProps,
    } as never);
    // Provide this layout's segment depth so descendant `useSelectedLayoutSegment(s)`
    // calls resolve relative to its level (Next.js layout-relative semantics).
    tree = provideLayoutSegments(
      { pathname, depth: match.route.layoutDepths?.[i] ?? 0 },
      tree,
    );
  }
  return { tree, layoutMetas, layoutViewports };
}

/**
 * Next.js's per-segment nesting: for each route directory level (innermost first)
 * `layout( template( error( loading( children ) ) ) )`, so a segment's `error.tsx` catches
 * throws from everything BELOW it (nested layouts included) and an outer `error.tsx` is the
 * fallback for an inner one. Layout metadata/viewport and slot props are collected exactly
 * as {@linkcode wrapLayouts} does.
 */
async function wrapLevels(
  match: PageMatch,
  page: VNode,
  load: ModuleLoader,
  options: RenderPageOptions,
  pathname: string,
  soft: boolean,
  props: PageProps,
): Promise<{ tree: VNode; layoutMetas: Metadata[]; layoutViewports: Viewport[] }> {
  const levels = match.route.levels ?? [];
  const { layoutMetas, layoutViewports } = await resolveLayoutMetadata(match, load, props);
  let layoutIdx = match.route.layoutChain.length - 1;
  let tree = page;
  for (let i = levels.length - 1; i >= 0; i--) {
    const level = levels[i];
    tree = await wrapLevelBoundaries(level, tree, load, options);
    if (level.template) tree = await wrapTemplate(level.template, tree, match.params, load);
    if (level.layout) {
      tree = await wrapOneLayout(match, layoutIdx--, tree, load, pathname, soft, props);
    }
  }
  return { tree, layoutMetas, layoutViewports };
}

/**
 * Layout metadata/viewport outer→inner, each generator receiving `parent` — the merge of
 * the layouts ABOVE it (Next.js `generateMetadata(props, parent)`).
 */
async function resolveLayoutMetadata(
  match: PageMatch,
  load: ModuleLoader,
  props: PageProps,
): Promise<{ layoutMetas: Metadata[]; layoutViewports: Viewport[] }> {
  const layoutMetas: Metadata[] = [];
  const layoutViewports: Viewport[] = [];
  for (const file of match.route.layoutChain) {
    const mod = (await load(file)) as LayoutModule;
    const meta = typeof mod.generateMetadata === "function"
      ? await mod.generateMetadata(props, Promise.resolve(mergeMetadata(layoutMetas)))
      : mod.metadata;
    if (meta) layoutMetas.push(meta);
    const viewport = typeof mod.generateViewport === "function"
      ? await mod.generateViewport(props, Promise.resolve(mergeViewport(layoutViewports)))
      : mod.viewport;
    if (viewport) layoutViewports.push(viewport);
  }
  return { layoutMetas, layoutViewports };
}

/** `error( loading( content ) )` for one level's own boundary files. */
async function wrapLevelBoundaries(
  level: SegmentLevel,
  content: VNode,
  load: ModuleLoader,
  options: RenderPageOptions,
): Promise<VNode> {
  let tree = content;
  if (level.loading) {
    const loadingMod = (await load(level.loading)) as { default: () => VNode };
    tree = h(Suspense, { fallback: h(loadingMod.default, {}), children: tree });
  }
  if (level.error) {
    const errorMod = (await load(level.error)) as { default: never };
    tree = h(ErrorBoundary, {
      fallback: errorMod.default,
      children: tree,
      onCaught: options.onCaughtError,
    });
  }
  return tree;
}

async function wrapTemplate(
  file: string,
  content: VNode,
  params: RouteParams,
  load: ModuleLoader,
): Promise<VNode> {
  const tpl = (await load(file)) as LayoutModule;
  if (typeof tpl.default !== "function") throw new Error(`Template module ${file} has no default.`);
  return h(tpl.default, { children: content, params: asyncProps({ ...params }) } as never);
}

/** One layout (by index into `layoutChain`) wrapped around `content`, with its slots. */
async function wrapOneLayout(
  match: PageMatch,
  i: number,
  content: VNode,
  load: ModuleLoader,
  pathname: string,
  soft: boolean,
  props: PageProps,
): Promise<VNode> {
  const file = match.route.layoutChain[i];
  const layoutModule = (await load(file)) as LayoutModule;
  if (typeof layoutModule.default !== "function") {
    throw new Error(`Layout module ${file} has no default.`);
  }
  const slotMap = match.route.layoutSlots?.[i];
  const slotProps = slotMap ? await renderSlotMap(slotMap, match.params, load, pathname, soft) : {};
  const tree = h(layoutModule.default, {
    children: content,
    params: props.params,
    ...slotProps,
  } as never);
  return provideLayoutSegments({ pathname, depth: match.route.layoutDepths?.[i] ?? 0 }, tree);
}

/**
 * Render a slot map into named-prop VNodes: match each slot subtree against the
 * current URL (intercept-aware on soft navigation), render the matched page with
 * its slot-internal layout chain, or fall back to the slot's `default`. Unmatched
 * slots with no default are omitted.
 */
async function renderSlotMap(
  slots: Record<string, SlotRoutes>,
  params: Record<string, string | string[]>,
  load: ModuleLoader,
  pathname: string,
  soft: boolean,
): Promise<Record<string, VNode>> {
  const out: Record<string, VNode> = {};
  for (const [name, slot] of Object.entries(slots)) {
    const slotMatch = matchSlot(slot, pathname, { soft });
    if (slotMatch) {
      out[name] = await composeSlotPage(slotMatch, load);
    } else if (slot.default) {
      const mod = (await load(slot.default)) as { default?: (p: unknown) => VNode };
      if (typeof mod.default === "function") {
        out[name] = h(mod.default, { params } as never);
      }
    }
  }
  return out;
}

/** Compose a matched slot page with its slot-internal layout/loading/error chain. */
async function composeSlotPage(m: PageMatch, load: ModuleLoader): Promise<VNode> {
  const mod = (await load(m.route.filePath)) as { default: (p: unknown) => VNode };
  let tree: VNode = h(mod.default, { params: m.params } as never);
  if (m.route.loading) {
    const l = (await load(m.route.loading)) as { default: () => VNode };
    tree = h(Suspense, { fallback: h(l.default, {}), children: tree });
  }
  if (m.route.error) {
    const e = (await load(m.route.error)) as { default: never };
    tree = h(ErrorBoundary, { fallback: e.default, children: tree });
  }
  for (let i = m.route.layoutChain.length - 1; i >= 0; i--) {
    const lm = (await load(m.route.layoutChain[i])) as LayoutModule;
    if (typeof lm.default === "function") {
      tree = h(lm.default, { children: tree, params: m.params } as never);
    }
  }
  return tree;
}

/**
 * Render the root not-found UI (for otherwise-unmatched routes), wrapped in the
 * root layout when present. Returns a 404.
 */
export async function renderRootNotFound(
  manifest: RouteManifest,
  load: ModuleLoader,
): Promise<RenderedPage> {
  let content: VNode;
  if (manifest.rootNotFound) {
    const nf = (await load(manifest.rootNotFound)) as { default: () => VNode };
    content = h(nf.default, {});
  } else {
    content = h("div", { class: "denext-not-found" }, [
      h("h1", null, "404"),
      h("p", null, "This page could not be found."),
    ]);
  }

  const layoutMetas: Metadata[] = [];
  if (manifest.rootLayout) {
    const layout = (await load(manifest.rootLayout)) as LayoutModule;
    if (typeof layout.default === "function") {
      if (layout.metadata) layoutMetas.push(layout.metadata);
      content = h(layout.default, { children: content, params: {} } as never);
    }
  }

  const html = await renderToString(content);
  const metadata = mergeMetadata([...layoutMetas, { title: "404 — Not Found" }]);
  return { html, metadata, status: 404, config: DEFAULT_SEGMENT_CONFIG };
}

/**
 * Render the root `global-error.tsx` UI, which replaces the entire tree
 * (including the root layout) when an uncaught error escapes page rendering.
 * Returns a 500. Falls back to `null` when no `global-error.tsx` exists so the
 * caller can use its default error response.
 */
export async function renderGlobalError(
  manifest: RouteManifest,
  load: ModuleLoader,
  error: unknown,
): Promise<RenderedPage | null> {
  if (!manifest.rootGlobalError) return null;
  const mod = (await load(manifest.rootGlobalError)) as {
    default: (p: { error: Error; reset: () => void }) => VNode;
  };
  // In production the error handed to the component is REDACTED (a generic message
  // + an opaque digest) so a `{error.message}` in global-error.tsx can't leak
  // internal detail (DB DSNs, stack) to every client; the full error goes to the
  // log, correlatable by digest. In dev the real error is passed for debugging.
  const err = toClientError(error);
  // Next.js: global-error REPLACES the root layout and renders its own <html>/<body>. It is
  // server-rendered here (no hydration), so `reset` is a no-op on the server — the rendered
  // markup gets a full-page reload via a minimal inline handler on `[data-reset]` buttons.
  const body = await renderToString(h(mod.default, { error: err, reset: () => {} }));
  const html = /<html[\s>]/i.test(body) ? `<!DOCTYPE html>${body}` : body;
  return {
    html,
    metadata: { title: "Error" },
    status: 500,
    config: DEFAULT_SEGMENT_CONFIG,
    ownsDocument: /<html[\s>]/i.test(body),
  };
}

/** Metadata fields where the innermost segment's value simply wins. */
const OVERRIDE_FIELDS = [
  "description",
  "keywords",
  "metadataBase",
  "robots",
  "canonical",
  "icon",
  "authors",
  "applicationName",
  "generator",
  "referrer",
  "creator",
  "publisher",
  "category",
  "classification",
  "manifest",
  "archives",
  "assets",
  "bookmarks",
  "appleWebApp",
  "formatDetection",
] as const satisfies readonly (keyof Metadata)[];

/** Metadata object fields merged shallowly (inner keys over outer). */
const SHALLOW_MERGE_FIELDS = [
  "alternates",
  "openGraph",
  "twitter",
  "icons",
  "verification",
  "meta",
  "other",
  "itemProp",
  "appLinks",
] as const satisfies readonly (keyof Metadata)[];

/**
 * Next.js title semantics across the segment chain (outer→inner): a segment's
 * `title.template` applies to DESCENDANTS' string/default titles (not itself);
 * `title.default` is that segment's own title; `title.absolute` ignores any ancestor
 * template. Returns the resolved string for this segment (or the previous one).
 */
function mergeTitle(
  state: { resolved: string | undefined; template: string | undefined },
  t: NonNullable<Metadata["title"]>,
): void {
  if (typeof t === "string") {
    state.resolved = state.template ? state.template.replace(/%s/g, () => t) : t;
    return;
  }
  if (t.absolute !== undefined) state.resolved = t.absolute;
  else if (t.default !== undefined) {
    // Next applies the ANCESTOR template to a child's `default` too (only `absolute` opts out).
    const d = t.default;
    state.resolved = state.template ? state.template.replace(/%s/g, () => d) : d;
  }
  if (t.template !== undefined) state.template = t.template;
}

/** JSON-LD accumulates rather than overrides: a layout's Organization and a page's Article are both emitted. */
function mergeJsonLd(prev: Metadata["jsonLd"], next: NonNullable<Metadata["jsonLd"]>): unknown[] {
  const before = prev === undefined ? [] : Array.isArray(prev) ? prev : [prev];
  return [...before, ...(Array.isArray(next) ? next : [next])];
}

type TitleState = { resolved: string | undefined; template: string | undefined };

/** Fold one segment's metadata into `out` (override / shallow-merge / accumulate fields). */
function mergeSegment(out: Metadata, m: Metadata, title: TitleState): void {
  const o = out as Record<string, unknown>;
  if (m.title !== undefined) mergeTitle(title, m.title);
  for (const k of OVERRIDE_FIELDS) if (m[k] !== undefined) o[k] = m[k];
  for (const k of SHALLOW_MERGE_FIELDS) {
    if (m[k]) o[k] = { ...(o[k] as object | undefined), ...(m[k] as object) };
  }
  if (m.jsonLd) out.jsonLd = mergeJsonLd(out.jsonLd, m.jsonLd) as Metadata["jsonLd"];
  if (m.head) out.head = (out.head ?? "") + m.head; // accumulates, like jsonLd
}

/** Merge metadata objects left-to-right (later entries override earlier). */
export function mergeMetadata(metas: Metadata[]): Metadata {
  const out: Metadata = {};
  const title: TitleState = { resolved: undefined, template: undefined };
  for (const m of metas) mergeSegment(out, m, title);
  if (title.resolved !== undefined) out.title = title.resolved;
  return out;
}

/** Merge viewport objects left-to-right (later entries override earlier). */
export function mergeViewport(viewports: Viewport[]): Viewport {
  return Object.assign({}, ...viewports);
}
