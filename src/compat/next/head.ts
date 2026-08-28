/**
 * `next/head` compat — Next's `<Head>` collects its children (`<title>`/`<meta>`/
 * `<link>`) and hoists them into the document `<head>`. denext's renderer already
 * hoists in-tree `<title>`/`<meta>`/`<link>` from the rendered shell into the document
 * metadata/head (see {@link ../../server/render-page.ts}), so `<Head>` is a transparent
 * passthrough: it renders its children into the tree and the renderer floats them to
 * `<head>` (SSR + hydration safe). Lets Pages-era code using `next/head` build and set
 * the title/metadata without change.
 * @module
 */
import { Fragment, h } from "../../../mod.ts";
import type { VNode, VNodeChildren } from "../../jsx/types.ts";

/** `next/head`'s `<Head>` — renders children into the tree; the renderer hoists head tags. */
export default function Head(props: { children?: VNodeChildren }): VNode {
  return h(Fragment, null, props?.children);
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
