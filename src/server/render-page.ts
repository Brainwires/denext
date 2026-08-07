// Compose a matched page with its layout chain plus the App Router special
// files (loading -> Suspense fallback, error -> error boundary, not-found ->
// 404 UI), render to HTML, and resolve metadata.

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode } from "../jsx/types.ts";
import { renderToString } from "../jsx/render-to-string.ts";
import { Suspense } from "../runtime/suspense.ts";
import { ErrorBoundary, isNotFound } from "../runtime/error-boundary.ts";
import type { PageMatch } from "../router/match.ts";
import type { RouteManifest } from "../router/manifest.ts";
import type {
  LayoutModule,
  Metadata,
  ModuleLoader,
  PageModule,
  PageProps,
} from "./types.ts";

export interface RenderedPage {
  /** HTML for the hydration root's inner content. */
  html: string;
  metadata: Metadata;
  /** HTTP status (200, or 404 when notFound() was called). */
  status: number;
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

  const { tree, layoutMetas } = await wrapLayouts(match, content, load);

  // Resolve page metadata (may be a function of props).
  let pageMeta: Metadata = {};
  if (typeof pageModule.metadata === "function") {
    pageMeta = await pageModule.metadata(props);
  } else if (pageModule.metadata) {
    pageMeta = pageModule.metadata;
  }
  const metadata = mergeMetadata([...layoutMetas, pageMeta]);

  try {
    const html = await renderToString(tree);
    return { html, metadata, status: 200 };
  } catch (err) {
    if (isNotFound(err)) {
      return await renderNotFound(match, load, metadata);
    }
    throw err;
  }
}

/** Wrap a content node in the page's layout chain (innermost -> outermost). */
async function wrapLayouts(
  match: PageMatch,
  content: VNode,
  load: ModuleLoader,
): Promise<{ tree: VNode; layoutMetas: Metadata[] }> {
  let tree = content;
  const layoutMetas: Metadata[] = [];
  for (let i = match.route.layoutChain.length - 1; i >= 0; i--) {
    const layoutModule = (await load(match.route.layoutChain[i])) as LayoutModule;
    if (typeof layoutModule.default !== "function") {
      throw new Error(`Layout module ${match.route.layoutChain[i]} has no default.`);
    }
    if (layoutModule.metadata) layoutMetas.unshift(layoutModule.metadata);
    tree = h(layoutModule.default, {
      children: tree,
      params: match.params,
    } as never);
  }
  return { tree, layoutMetas };
}

/** Render the not-found UI (within layouts) with a 404 status. */
async function renderNotFound(
  match: PageMatch,
  load: ModuleLoader,
  metadata: Metadata,
): Promise<RenderedPage> {
  let content: VNode;
  if (match.route.notFound) {
    const nf = (await load(match.route.notFound)) as { default: () => VNode };
    content = h(nf.default, {});
  } else {
    content = h("div", { class: "denext-not-found" }, [
      h("h1", null, "404"),
      h("p", null, "This page could not be found."),
    ]);
  }
  const { tree } = await wrapLayouts(match, content, load);
  const html = await renderToString(tree);
  return {
    html,
    metadata: { ...metadata, title: metadata.title ?? "404 — Not Found" },
    status: 404,
  };
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
  return { html, metadata, status: 404 };
}

/** Merge metadata objects left-to-right (later entries override earlier). */
export function mergeMetadata(metas: Metadata[]): Metadata {
  const out: Metadata = {};
  for (const m of metas) {
    if (m.title !== undefined) out.title = m.title;
    if (m.description !== undefined) out.description = m.description;
    if (m.meta) out.meta = { ...out.meta, ...m.meta };
    if (m.head) out.head = (out.head ?? "") + m.head;
  }
  return out;
}
