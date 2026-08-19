/**
 * `next/head` for the Pages Router — the {@linkcode Head} component. Render
 * `<title>`, `<meta>`, and `<link>` inside it from any page or component and they
 * land in the document `<head>`:
 *
 * ```tsx
 * import Head from "@denext/pages-router/head";
 *
 * export default function Page() {
 *   return (
 *     <>
 *       <Head>
 *         <title>My Page</title>
 *         <meta name="description" content="…" />
 *       </Head>
 *       <h1>Hello</h1>
 *     </>
 *   );
 * }
 * ```
 *
 * On the server the tags are hoisted into `<head>` by the renderer; on the client
 * they are applied to `document.head` and **kept in sync across soft navigation**
 * (the previous page's tags are removed). Children should be plain `<title>` /
 * `<meta>` / `<link>` elements.
 *
 * @module
 */

import { Fragment, h, useLayoutEffect } from "@denext/denext";
import type { VNode, VNodeChildren } from "@denext/denext";
import { applyHead } from "./src/head-manager.ts";

export type { VNode, VNodeChildren } from "@denext/denext";

/** Props for {@linkcode Head}. */
export interface HeadProps {
  /** `<title>` / `<meta>` / `<link>` elements to place in the document head. */
  children?: VNodeChildren;
}

/**
 * Collect `<title>`/`<meta>`/`<link>` children into the document `<head>`. SSR
 * renders the children (the renderer hoists them); the client applies them to
 * `document.head` via an effect and reconciles them across navigation.
 */
export function Head(props: HeadProps): VNode {
  // Client only: effects don't run during SSR (where the renderer already hoists
  // the children), so this is a no-op on the server.
  useLayoutEffect(() => {
    if (typeof document === "undefined") return;
    return applyHead(props.children);
  });
  // Server: render children so the renderer hoists them. Client: render an empty
  // fragment — the effect owns document.head. Both leave the body empty (no
  // hydration mismatch).
  return typeof document === "undefined" ? h(Fragment, null, props.children) : h(Fragment, null);
}

export default Head;
