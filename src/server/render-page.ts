// Compose a matched page with its layout chain plus the App Router special
// files (loading -> Suspense fallback, error -> error boundary, not-found ->
// 404 UI), render to HTML, and resolve metadata.

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode } from "../jsx/types.ts";
import { type HeadCollector, renderToString } from "../jsx/render-to-string.ts";
import { renderShell, type ShellRender } from "../jsx/render-to-stream.ts";
import { renderFontStyles } from "../compat/next/font/registry.ts";
import { type IslandPayload, renderToHtmlFlight } from "../jsx/render-to-html-flight.ts";
import type { FlightNode } from "../jsx/render-to-flight.ts";
import { prerenderToShell, type ResumedHole, resumeShellHoles } from "../jsx/render-to-ppr.ts";
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
import type { RouteManifest, SlotRoutes } from "../router/manifest.ts";
import { provideLayoutSegments } from "../runtime/layout-segments.ts";
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
import { addResourceHint, currentContext } from "./request-context.ts";
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
const staticParamsCache = new Map<string, Array<Record<string, string>> | null>();

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
  pageModule: PageModule,
): Promise<boolean> {
  const params = match.params;
  const keys = Object.keys(params);
  if (keys.length === 0) return false; // static route: dynamicParams is irrelevant

  const filePath = match.route.filePath;
  let known = staticParamsCache.get(filePath);
  if (known === undefined) {
    known = typeof pageModule.generateStaticParams === "function"
      ? await pageModule.generateStaticParams()
      : null;
    staticParamsCache.set(filePath, known);
  }
  // No generateStaticParams → no params are known → every dynamic param 404s.
  if (known === null) return true;
  // Allowed only if this request's params match an enumerated set (each key equal).
  return !known.some((set) => keys.every((k) => String(set[k]) === params[k]));
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
  const props: PageProps = {
    params: match.params,
    searchParams: url.searchParams,
  };

  options.signal?.throwIfAborted();
  const pageModule = (await load(match.route.filePath)) as PageModule;
  if (typeof pageModule.default !== "function") {
    throw new Error(
      `Page module ${match.route.filePath} has no default export component.`,
    );
  }

  // Effective route segment config: layout chain (outer→inner) then the page.
  let config = DEFAULT_SEGMENT_CONFIG;
  for (const layoutPath of match.route.layoutChain) {
    config = mergeSegmentConfig(config, readSegmentConfig(await load(layoutPath)));
  }
  config = mergeSegmentConfig(config, readSegmentConfig(pageModule));

  // Expose the effective config to the dynamic-API guards (cookies()/headers()/
  // connection()): `dynamic:"error"` makes them throw, `force-static` makes them
  // return empty without marking the render dynamic. Set before generateMetadata /
  // the render, both of which may read a dynamic API.
  const reqCtx = currentContext();
  if (reqCtx) reqCtx.segmentConfig = config;

  // `dynamicParams = false`: a param not enumerated by generateStaticParams 404s.
  // Decided here (module is loaded); the render entries throw notFound() for it.
  const staticParamsNotFound = config.dynamicParams === false &&
    await isStaticParamDisallowed(match, pageModule);

  // Innermost -> page, optionally wrapped by loading (Suspense) and error.
  let content: VNode = h(pageModule.default, props as never);

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

  // Templates wrap like layouts but conceptually re-mount on navigation (which,
  // in denext, always happens because soft navigation re-runs the route bundle).
  for (let i = match.route.templateChain.length - 1; i >= 0; i--) {
    const tpl = (await load(match.route.templateChain[i])) as LayoutModule;
    if (typeof tpl.default !== "function") {
      throw new Error(`Template module ${match.route.templateChain[i]} has no default.`);
    }
    content = h(tpl.default, { children: content, params: match.params } as never);
  }

  options.signal?.throwIfAborted();
  const soft = request.headers.get("x-denext-nav") === "1";
  const wrapped = await wrapLayouts(match, content, load, url.pathname, soft, props);
  const layoutMetas = wrapped.layoutMetas;
  // Provide the active locale's messages so useTranslations() resolves in SSR
  // (server components and SSR'd client islands); the client reads the same
  // catalog from the hydration payload.
  const tree = options.messages ? provideMessages(options.messages, wrapped.tree) : wrapped.tree;

  // Resolve page metadata: static `metadata`, `metadata` fn, or `generateMetadata`.
  let pageMeta: Metadata = {};
  if (typeof pageModule.generateMetadata === "function") {
    pageMeta = await pageModule.generateMetadata(props);
  } else if (typeof pageModule.metadata === "function") {
    pageMeta = await pageModule.metadata(props);
  } else if (pageModule.metadata) {
    pageMeta = pageModule.metadata;
  }
  const metadata = mergeMetadata([...layoutMetas, pageMeta]);

  // Resolve viewport: `generateViewport` or static `viewport`, merged over layouts.
  let pageViewport: Viewport = {};
  if (typeof pageModule.generateViewport === "function") {
    pageViewport = await pageModule.generateViewport(props);
  } else if (pageModule.viewport) {
    pageViewport = pageModule.viewport;
  }
  const viewport = mergeViewport([...wrapped.layoutViewports, pageViewport]);

  return { tree, metadata, viewport, config, staticParamsNotFound };
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
    if (head.title !== undefined) metadata.title = head.title; // in-tree title wins
    if (head.tags.length > 0) metadata.head = (metadata.head ?? "") + head.tags.join("");
    // Hoist imperative SSR resource hints (preload/preinit/preconnect/prefetchDNS).
    const hints = currentContext()?.resourceHints;
    if (hints && hints.length > 0) metadata.head = (metadata.head ?? "") + hints.join("");
    // Emit any @font-face / font stylesheet links registered by next/font
    // (localFont/google fonts register at module load; this injects their CSS).
    const fontCss = renderFontStyles();
    if (fontCss) metadata.head = (metadata.head ?? "") + fontCss;
    return { html, metadata, status: 200, config, flight, islands, signalState, viewport };
  } catch (err) {
    if (isNotFound(err)) {
      return renderSignalUI(match, load, metadata, config, match.route.notFound, {
        status: 404,
        title: "404 — Not Found",
        heading: "404",
        message: "This page could not be found.",
      });
    }
    if (isForbidden(err)) {
      return renderSignalUI(match, load, metadata, config, match.route.forbidden, {
        status: 403,
        title: "403 — Forbidden",
        heading: "403",
        message: "You don't have access to this resource.",
      });
    }
    if (isUnauthorized(err)) {
      return renderSignalUI(match, load, metadata, config, match.route.unauthorized, {
        status: 401,
        title: "401 — Unauthorized",
        heading: "401",
        message: "You must be signed in to view this page.",
      });
    }
    throw err;
  }
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
  const ctx = prebuilt ?? await buildPageContext(match, request, load, options);
  const { tree, metadata, viewport, config } = ctx;
  options.signal?.throwIfAborted();
  const head: HeadCollector = { tags: [] };
  try {
    // dynamicParams:false with an unenumerated param → 404 (turned into the
    // buffered signal-UI page by the catch below, before any bytes flush).
    if (ctx.staticParamsNotFound) notFound();
    const shell = await renderShell(tree, head);
    if (head.title !== undefined) metadata.title = head.title; // in-tree title wins
    if (head.tags.length > 0) metadata.head = (metadata.head ?? "") + head.tags.join("");
    const hints = currentContext()?.resourceHints;
    if (hints && hints.length > 0) metadata.head = (metadata.head ?? "") + hints.join("");
    const fontCss = renderFontStyles();
    if (fontCss) metadata.head = (metadata.head ?? "") + fontCss;
    return { shell, metadata, viewport, config, status: 200 };
  } catch (err) {
    // A control signal thrown in the (non-suspended) shell becomes a buffered page
    // — we haven't flushed yet, so the status can still change. One inside a
    // Suspense boundary resolves after the flush and is handled as a failed hole.
    const signal = isNotFound(err)
      ? {
        route: match.route.notFound,
        status: 404,
        title: "404 — Not Found",
        heading: "404",
        message: "This page could not be found.",
      }
      : isForbidden(err)
      ? {
        route: match.route.forbidden,
        status: 403,
        title: "403 — Forbidden",
        heading: "403",
        message: "You don't have access to this resource.",
      }
      : isUnauthorized(err)
      ? {
        route: match.route.unauthorized,
        status: 401,
        title: "401 — Unauthorized",
        heading: "401",
        message: "You must be signed in to view this page.",
      }
      : null;
    if (!signal) throw err; // redirect() and real errors bubble to the caller
    const ui = await renderSignalUI(match, load, metadata, config, signal.route, {
      status: signal.status,
      title: signal.title,
      heading: signal.heading,
      message: signal.message,
    });
    return { html: ui.html, metadata: ui.metadata, viewport, config: ui.config, status: ui.status };
  }
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
  const bail = (): PrerenderedPage => ({
    dynamic: true,
    shellBody: "",
    holeIds: [],
    metadata,
    viewport,
    headExtras: "",
    status: 200,
    config,
  });

  // dynamicParams:false with an unenumerated param: fall back to the normal render,
  // which throws notFound() and serves the 404 UI.
  if (ctx.staticParamsNotFound) return bail();

  options.signal?.throwIfAborted();
  try {
    const head: HeadCollector = { tags: [] };
    const result = await withPrerender(() => prerenderToShell(tree, { head }));
    if (result.dynamic) return bail();
    // Track the STATIC head extras separately from generateMetadata's per-request
    // output, so a cache hit can re-merge them onto freshly-resolved metadata.
    let headExtras = "";
    const inTreeTitle = head.title;
    if (inTreeTitle !== undefined) metadata.title = inTreeTitle; // in-tree title wins
    if (head.tags.length > 0) {
      const tags = head.tags.join("");
      metadata.head = (metadata.head ?? "") + tags;
      headExtras += tags;
    }
    // Hoist SSR resource hints emitted during the (cached) shell prerender.
    const hints = currentContext()?.resourceHints;
    if (hints && hints.length > 0) {
      const joined = hints.join("");
      metadata.head = (metadata.head ?? "") + joined;
      headExtras += joined;
    }
    const fontCss = renderFontStyles();
    if (fontCss) {
      metadata.head = (metadata.head ?? "") + fontCss;
      headExtras += fontCss;
    }
    return {
      dynamic: false,
      shellBody: result.shell,
      holeIds: result.postponedIds,
      metadata,
      viewport,
      headExtras,
      inTreeTitle,
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
  const signalProps: PageProps = { params: match.params, searchParams: new URLSearchParams() };
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
  const layoutMetas: Metadata[] = [];
  const layoutViewports: Viewport[] = [];
  const layoutSlots = match.route.layoutSlots;
  const innermost = match.route.layoutChain.length - 1;
  for (let i = innermost; i >= 0; i--) {
    const layoutModule = (await load(match.route.layoutChain[i])) as LayoutModule;
    if (typeof layoutModule.default !== "function") {
      throw new Error(`Layout module ${match.route.layoutChain[i]} has no default.`);
    }
    // Each layout may contribute metadata/viewport via a generator (preferred) or
    // a static export; `unshift` keeps outer→inner order for the later merge.
    const lMeta = typeof layoutModule.generateMetadata === "function"
      ? await layoutModule.generateMetadata(props)
      : layoutModule.metadata;
    if (lMeta) layoutMetas.unshift(lMeta);
    const lViewport = typeof layoutModule.generateViewport === "function"
      ? await layoutModule.generateViewport(props)
      : layoutModule.viewport;
    if (lViewport) layoutViewports.unshift(lViewport);
    // Parallel-route slots declared at this layout's level render into it as
    // named props, matched against the current URL (so a slot spans children).
    const slotMap = layoutSlots?.[i];
    const slotProps = slotMap
      ? await renderSlotMap(slotMap, match.params, load, pathname, soft)
      : {};
    tree = h(layoutModule.default, {
      children: tree,
      params: match.params,
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
  const html = await renderToString(h(mod.default, { error: err, reset: () => {} }));
  return { html, metadata: { title: "Error" }, status: 500, config: DEFAULT_SEGMENT_CONFIG };
}

/** Merge metadata objects left-to-right (later entries override earlier). */
export function mergeMetadata(metas: Metadata[]): Metadata {
  const out: Metadata = {};
  // Next.js title semantics across the segment chain (outer→inner): a segment's
  // `title.template` applies to DESCENDANTS' string/default titles (not itself);
  // `title.default` is that segment's own title; `title.absolute` ignores any
  // ancestor template. The merged `out.title` is always the resolved string.
  let titleResolved: string | undefined;
  let titleTemplate: string | undefined;
  for (const m of metas) {
    if (m.title !== undefined) {
      const t = m.title;
      if (typeof t === "string") {
        titleResolved = titleTemplate ? titleTemplate.replace(/%s/g, t) : t;
      } else {
        if (t.absolute !== undefined) titleResolved = t.absolute;
        else if (t.default !== undefined) titleResolved = t.default;
        if (t.template !== undefined) titleTemplate = t.template;
      }
    }
    if (m.description !== undefined) out.description = m.description;
    if (m.keywords !== undefined) out.keywords = m.keywords;
    if (m.metadataBase !== undefined) out.metadataBase = m.metadataBase;
    if (m.robots !== undefined) out.robots = m.robots;
    if (m.canonical !== undefined) out.canonical = m.canonical;
    if (m.alternates) out.alternates = { ...out.alternates, ...m.alternates };
    if (m.openGraph) out.openGraph = { ...out.openGraph, ...m.openGraph };
    if (m.twitter) out.twitter = { ...out.twitter, ...m.twitter };
    if (m.icon !== undefined) out.icon = m.icon;
    if (m.icons) out.icons = { ...out.icons, ...m.icons };
    if (m.authors !== undefined) out.authors = m.authors;
    if (m.verification) out.verification = { ...out.verification, ...m.verification };
    if (m.meta) out.meta = { ...out.meta, ...m.meta };
    if (m.head) out.head = (out.head ?? "") + m.head;
  }
  if (titleResolved !== undefined) out.title = titleResolved;
  return out;
}

/** Merge viewport objects left-to-right (later entries override earlier). */
export function mergeViewport(viewports: Viewport[]): Viewport {
  return Object.assign({}, ...viewports);
}
