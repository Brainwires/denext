// Compose a matched page with its layout chain plus the App Router special
// files (loading -> Suspense fallback, error -> error boundary, not-found ->
// 404 UI), render to HTML, and resolve metadata.

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode } from "../jsx/types.ts";
import { renderToString } from "../jsx/render-to-string.ts";
import { Suspense } from "../runtime/suspense.ts";
import {
  ErrorBoundary,
  isForbidden,
  isNotFound,
  isUnauthorized,
} from "../runtime/error-boundary.ts";
import type { PageMatch } from "../router/match.ts";
import type { RouteManifest } from "../router/manifest.ts";
import type { LayoutModule, Metadata, ModuleLoader, PageModule, PageProps } from "./types.ts";
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
  /** HTTP status (200, or 404 when notFound() was called). */
  status: number;
  /** Effective route segment config (page merged over its layout chain). */
  config: SegmentConfig;
}

/** Render a matched page (with layouts + boundaries) to an HTML fragment. */
export async function renderPage(
  match: PageMatch,
  request: Request,
  load: ModuleLoader,
): Promise<RenderedPage> {
  const url = new URL(request.url);
  const props: PageProps = {
    params: match.params,
    searchParams: url.searchParams,
    request,
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

  const { tree, layoutMetas } = await wrapLayouts(match, content, load);

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

  try {
    const html = await renderToString(tree);
    return { html, metadata, status: 200, config };
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
  const { tree } = await wrapLayouts(match, content, load);
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
): Promise<{ tree: VNode; layoutMetas: Metadata[] }> {
  let tree = content;
  const layoutMetas: Metadata[] = [];
  // Parallel-route slots render into the innermost layout as named props.
  const slotProps = await renderSlots(match, load);
  const innermost = match.route.layoutChain.length - 1;
  for (let i = innermost; i >= 0; i--) {
    const layoutModule = (await load(match.route.layoutChain[i])) as LayoutModule;
    if (typeof layoutModule.default !== "function") {
      throw new Error(`Layout module ${match.route.layoutChain[i]} has no default.`);
    }
    if (layoutModule.metadata) layoutMetas.unshift(layoutModule.metadata);
    tree = h(layoutModule.default, {
      children: tree,
      params: match.params,
      ...(i === innermost ? slotProps : {}),
    } as never);
  }
  return { tree, layoutMetas };
}

/** Render each parallel-route slot's page into a VNode keyed by slot name. */
async function renderSlots(
  match: PageMatch,
  load: ModuleLoader,
): Promise<Record<string, VNode>> {
  const out: Record<string, VNode> = {};
  const slots = match.route.slots;
  if (!slots) return out;
  for (const [name, filePath] of Object.entries(slots)) {
    const mod = (await load(filePath)) as { default?: (p: unknown) => VNode };
    if (typeof mod.default === "function") {
      out[name] = h(mod.default, { params: match.params } as never);
    }
  }
  return out;
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
    if (m.robots !== undefined) out.robots = m.robots;
    if (m.canonical !== undefined) out.canonical = m.canonical;
    if (m.icon !== undefined) out.icon = m.icon;
    if (m.openGraph) out.openGraph = { ...out.openGraph, ...m.openGraph };
    if (m.meta) out.meta = { ...out.meta, ...m.meta };
    if (m.head) out.head = (out.head ?? "") + m.head;
  }
  return out;
}
