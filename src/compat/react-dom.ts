/**
 * React-compatible `react-dom` entrypoint for denext.
 *
 * Alias `react-dom` to this module in your import map:
 *
 * ```jsonc
 * "imports": { "react-dom": "jsr:@denext/denext/react-dom" }
 * ```
 *
 * It exposes the React 18+ client API (`createRoot`, `hydrateRoot`, `flushSync`),
 * legacy `render`/`hydrate` wrappers, and a working client-side `createPortal`.
 *
 * @module
 */

import { createRoot, flushSync, hydrateRoot, type Root } from "../client/mod.ts";
import { Fragment, h, useEffect, useRef } from "../../mod.ts";
import type { VNode, VNodeChild } from "../jsx/types.ts";

export { createRoot, flushSync, hydrateRoot };

/** The React version denext reports for compatibility. */
export const version = "19.0.0";

/**
 * Legacy `ReactDOM.render` — wraps `createRoot(container).render(element)`.
 *
 * @param element The element to render.
 * @param container The mount container.
 * @returns The created root.
 */
export function render(element: VNode, container: Element): Root {
  const root = createRoot(container);
  root.render(element);
  return root;
}

/**
 * Legacy `ReactDOM.hydrate` — wraps `hydrateRoot(container, element)`.
 *
 * @param element The element to hydrate.
 * @param container The container holding server markup.
 * @returns The created root.
 */
export function hydrate(element: VNode, container: Element): Root {
  return hydrateRoot(container, element);
}

/**
 * A denext component that renders its `children` into a separate DOM
 * `target`, on the client. It appends its own wrapper node so the target's
 * existing children are left intact, and tears the wrapper down on unmount.
 */
function Portal(props: { target: Element; children: VNodeChild }): VNode {
  const state = useRef<{ host: Element; root: Root } | null>(null);
  // Mount into (and later clean up from) the target container.
  useEffect(() => {
    const owner = props.target.ownerDocument ?? (globalThis as { document?: Document }).document;
    const host = owner!.createElement("div");
    props.target.appendChild(host);
    const root = createRoot(host);
    root.render(h(Fragment, null, props.children as VNode));
    state.current = { host, root };
    return () => {
      root.unmount();
      host.remove();
      state.current = null;
    };
  }, [props.target]);
  // Keep the portal content up to date as `children` changes.
  useEffect(() => {
    state.current?.root.render(h(Fragment, null, props.children as VNode));
  });
  return h(Fragment, null); // renders nothing in place
}

/**
 * `ReactDOM.createPortal` — render `children` into a different DOM `container`.
 * Client-side (via `useEffect`); the content is not server-rendered into the
 * container. The container's existing children are preserved.
 *
 * @param children The portal content.
 * @param container The DOM node to render into.
 * @returns An element that mounts the portal when rendered.
 */
export function createPortal(children: VNodeChild, container: Element): VNode {
  return h(Portal, { target: container, children });
}

/** The default `ReactDOM` namespace object (`import ReactDOM from "react-dom"`). */
export default { createRoot, hydrateRoot, flushSync, render, hydrate, createPortal, version };
