// Compose a matched page with its layout chain plus the App Router special
// files (loading -> Suspense fallback, error -> error boundary, not-found ->
// 404 UI), render to HTML, and resolve metadata.

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode } from "../jsx/types.ts";
import { type HeadCollector, renderToString } from "../jsx/render-to-string.ts";
import { renderFontStyles } from "../compat/next/font/registry.ts";
import { renderToHtmlFlight } from "../jsx/render-to-html-flight.ts";
import type { FlightNode } from "../jsx/render-to-flight.ts";
import { Suspense } from "../runtime/suspense.ts";
import {
  ErrorBoundary,
  isForbidden,
  isNotFound,
  isUnauthorized,
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
}

/** Render a matched page (with layouts + boundaries) to an HTML fragment. */
export async function renderPage(
  match: PageMatch,
  request: Request,
  load: ModuleLoader,
  options: RenderPageOptions = {},
): Promise<RenderedPage> {
  const url = new URL(request.url);
  // `request` is intentionally NOT placed on props — per-request data flows
  // through cookies()/headers() (which mark the render dynamic). See PageProps.
  const props: PageProps = {
    params: match.params,
    searchParams: url.searchParams,
  };

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
    content = h(ErrorBoundary, { fallback: errorMod.default, children: content });
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

  try {
    // Hoist any in-tree <title>/<meta>/<link> into the document metadata.
    const head: HeadCollector = { tags: [] };
    let html: string;
    let flight: FlightNode | undefined;
    if (options.flight) {
      // Single-pass: emit HTML and Flight together so useId stays aligned.
      const r = await renderToHtmlFlight(tree, { head });
      html = r.html;
      flight = r.flight;
    } else {
      html = await renderToString(tree, { head });
    }
    if (head.title !== undefined) metadata.title = head.title; // in-tree title wins
    if (head.tags.length > 0) metadata.head = (metadata.head ?? "") + head.tags.join("");
    // Emit any @font-face / font stylesheet links registered by next/font
    // (localFont/google fonts register at module load; this injects their CSS).
    const fontCss = renderFontStyles();
    if (fontCss) metadata.head = (metadata.head ?? "") + fontCss;
    return { html, metadata, status: 200, config, flight, viewport };
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
  const err = error instanceof Error ? error : new Error(String(error));
  const html = await renderToString(h(mod.default, { error: err, reset: () => {} }));
  return { html, metadata: { title: "Error" }, status: 500, config: DEFAULT_SEGMENT_CONFIG };
}

/** Merge metadata objects left-to-right (later entries override earlier). */
export function mergeMetadata(metas: Metadata[]): Metadata {
  const out: Metadata = {};
  for (const m of metas) {
    if (m.title !== undefined) out.title = m.title;
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
  return out;
}

/** Merge viewport objects left-to-right (later entries override earlier). */
export function mergeViewport(viewports: Viewport[]): Viewport {
  return Object.assign({}, ...viewports);
}
