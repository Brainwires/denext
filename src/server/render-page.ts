// Compose a matched page with its layout chain, render to HTML, resolve metadata.

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode } from "../jsx/types.ts";
import { renderToString } from "../jsx/render-to-string.ts";
import type { PageMatch } from "../router/match.ts";
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
}

/** Render a matched page (wrapped in its layouts) to an HTML fragment. */
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

  // Innermost node is the page itself.
  let tree: VNode = h(pageModule.default, props as never);

  // Collect layout metadata (outer -> inner) while wrapping inner -> outer.
  const layoutMetas: Metadata[] = [];
  for (let i = match.route.layoutChain.length - 1; i >= 0; i--) {
    const layoutPath = match.route.layoutChain[i];
    const layoutModule = (await load(layoutPath)) as LayoutModule;
    if (typeof layoutModule.default !== "function") {
      throw new Error(`Layout module ${layoutPath} has no default export.`);
    }
    if (layoutModule.metadata) layoutMetas.unshift(layoutModule.metadata);
    tree = h(layoutModule.default, {
      children: tree,
      params: match.params,
    } as never);
  }

  const html = await renderToString(tree);

  // Resolve page metadata (may be a function of props).
  let pageMeta: Metadata = {};
  if (typeof pageModule.metadata === "function") {
    pageMeta = await pageModule.metadata(props);
  } else if (pageModule.metadata) {
    pageMeta = pageModule.metadata;
  }

  // Merge: outer layouts first, page metadata wins on conflicts.
  const metadata = mergeMetadata([...layoutMetas, pageMeta]);
  return { html, metadata };
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
