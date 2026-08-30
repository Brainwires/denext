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

import { Fragment, h, useLayoutEffect, useServerInsertedHTML } from "@denext/denext";
import type { VNode, VNodeChild, VNodeChildren } from "@denext/denext";
import { applyHead } from "./src/head-manager.ts";

export type { VNode, VNodeChildren } from "@denext/denext";

/** Props for {@linkcode Head}. */
export interface HeadProps {
  /**
   * Head elements to place in the document `<head>`: `<title>`/`<meta>`/`<link>`
   * plus `<script>` (e.g. JSON-LD), `<style>`, `<base>`, and `<noscript>`.
   */
  children?: VNodeChildren;
}

/** Non-metadata tags hoisted to `<head>` via the serverInserted sink (see below). */
const HOIST_EXTRA = new Set(["script", "style", "base", "noscript"]);

function isVNode(c: VNodeChild): c is VNode {
  return !!c && typeof c === "object" && "type" in c;
}

/**
 * Split `<Head>` children into `metadata` (`<title>`/`<meta>`/`<link>` — the renderer
 * hoists+dedupes these tree-wide, React-19 style) and `extra`
 * (`<script>`/`<style>`/`<base>`/`<noscript>` — which the renderer does NOT hoist, so
 * they are routed to `<head>` via {@link useServerInsertedHTML}, scoped to this
 * `<Head>`). Descends fragments; anything else falls to `metadata` (rendered inline).
 */
function splitChildren(
  children: VNodeChildren | undefined,
): { metadata: VNodeChild[]; extra: VNodeChild[] } {
  const metadata: VNodeChild[] = [];
  const extra: VNodeChild[] = [];
  const walk = (node: VNodeChildren | undefined): void => {
    for (const c of Array.isArray(node) ? node : [node]) {
      if (isVNode(c) && c.type === Fragment) {
        walk((c.props as { children?: VNodeChildren })?.children);
      } else if (isVNode(c) && typeof c.type === "string" && HOIST_EXTRA.has(c.type)) {
        extra.push(c);
      } else if (c != null && c !== false && c !== true) {
        metadata.push(c);
      }
    }
  };
  walk(children);
  return { metadata, extra };
}

/**
 * Collect head elements into the document `<head>`. On the server, `<title>`/`<meta>`/
 * `<link>` are rendered inline (the renderer hoists them) while
 * `<script>`/`<style>`/`<base>`/`<noscript>` are routed to `<head>` through the
 * serverInserted sink. On the client, all of them are applied to `document.head` via
 * an effect and reconciled across soft navigation.
 */
export function Head(props: HeadProps): VNode {
  // Client: apply to document.head and reconcile across navigation (no-op on the
  // server, where effects don't run).
  useLayoutEffect(() => {
    if (typeof document === "undefined") return;
    return applyHead(props.children);
  });
  const { metadata, extra } = splitChildren(props.children);
  // Route the non-metadata tags to <head> (scoped to this <Head>'s children, unlike
  // the renderer's tree-wide metadata hoist). No-op on the client — the sink is
  // server-only, and the effect above owns document.head there.
  useServerInsertedHTML(() => h(Fragment, null, ...extra));
  // Server: render the metadata inline so the renderer hoists+dedupes it. Client:
  // render nothing — the effect owns document.head. Both keep the body empty.
  return typeof document === "undefined" ? h(Fragment, null, ...metadata) : h(Fragment, null);
}

export default Head;
