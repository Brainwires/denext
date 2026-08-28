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
