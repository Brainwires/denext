/**
 * `next/head` compat — Next's `<Head>` collects its children and hoists them into the
 * document `<head>`. denext's renderer already hoists in-tree `<title>`/`<meta>`/`<link>`
 * from the rendered shell into the document metadata/head (see
 * {@link ../../server/render-page.ts}), deduping by `key` and collapsing the
 * `charSet`/viewport singletons; `<Head>` renders those straight into the tree. The
 * remaining head-only tags (`<base>`, `<script>`, `<style>`, `<noscript>`) are routed
 * through `useServerInsertedHTML` so they too end up in `<head>` on the server.
 * @module
 */
import { Fragment, h } from "../../../mod.ts";
import type { VNode, VNodeChild, VNodeChildren } from "../../jsx/types.ts";
import { useServerInsertedHTML } from "../../runtime/server-inserted-html.ts";

/** Tags the renderer hoists on its own (React 19 document metadata). */
const RENDERER_HOISTS = new Set(["title", "meta", "link"]);
/** The other tags Next's `<Head>` moves into `<head>`; routed through the inserted-HTML sink. */
const SINK_HOISTS = new Set(["base", "script", "style", "noscript"]);

/** A host-element vnode (`<meta>`, `<script>`, …). */
function isHostElement(c: VNodeChild): c is VNode {
  return typeof c === "object" && c !== null && typeof (c as VNode).type === "string";
}

/** Flatten `children` one level at a time into a list of leaves. */
function leaves(children: VNodeChildren, out: VNodeChild[] = []): VNodeChild[] {
  if (Array.isArray(children)) { for (const c of children) leaves(c, out); }
  else if (children != null && typeof children !== "boolean") out.push(children as VNodeChild);
  return out;
}

/**
 * `next/head`'s `<Head>`. `<title>`/`<meta>`/`<link>` render into the tree and the renderer
 * hoists them (SSR + hydration safe, `key`-deduped). `<base>`/`<script>`/`<style>`/`<noscript>`
 * — which Next also moves into `<head>` — go through the server-inserted-HTML sink on the
 * server so they land in the document head instead of inline in the body; on the client
 * they render nothing (the server already placed them).
 */
export default function Head(props: { children?: VNodeChildren }): VNode {
  const all = leaves(props?.children);
  const sunk = all.filter((c) => isHostElement(c) && SINK_HOISTS.has(c.type as string));
  const inline = all.filter((c) => !sunk.includes(c));
  useServerInsertedHTML(() => sunk);
  return h(Fragment, null, ...inline);
}

/** Whether `child` is a head tag the renderer hoists (for callers that inspect `<Head>`). */
export function isRendererHoisted(child: VNodeChild): boolean {
  return isHostElement(child) && RENDERER_HOISTS.has(child.type as string);
}

/**
 * `next/head`'s `defaultHead` — the baseline `<head>` elements Next seeds every page
 * with: the UTF-8 charset and (outside AMP) the responsive viewport meta.
 *
 * @param inAmpMode When true, the viewport meta is omitted (AMP supplies its own).
 * @returns The default head elements.
 */
export function defaultHead(inAmpMode = false): VNode[] {
  const tags: VNode[] = [h("meta", { charSet: "utf-8" })];
  if (!inAmpMode) {
    tags.push(h("meta", { name: "viewport", content: "width=device-width" }));
  }
  return tags;
}
