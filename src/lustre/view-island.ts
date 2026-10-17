// The browser end of one `defineLustreView` on a page. The Gleam build writes it into the app as
// `.denext/lustre-view.ts`, a `"use client"` module holding
// `export const LustreView = lustreViewIsland(Reconciler)` with Lustre's reconciler imported from
// the app's own build: so it is an ordinary island of the app (its chunk loads only on pages that
// render a Lustre view, as a file, never an inline script) and it uses the one copy of Lustre the
// app has.
//
// On the server it renders the view's first paint (the HTML `defineLustreView` passes it) inside
// its root, so the page works without JavaScript. In the browser it mounts the view over the Live
// socket; the server's first message replaces the root's contents with Lustre's own render, and
// from then on Lustre's reconciler owns them (denext renders the root once and never its children).

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode } from "../jsx/types.ts";
import { useEffect, useRef, useState } from "../runtime/hooks.ts";
import { type LustreReconcilerClass, mountLustreView } from "./view-client.ts";

/** The island's props (written by `defineLustreView`'s server render). */
export interface LustreViewIslandProps {
  /** The view id. */
  view: string;
  /** The props the flags came from, as the JSON text the server signed. */
  props: string;
  /** The server's signature over `view` + `props`. */
  token: string;
  /** `1` when `props` carries wire-codec tags. */
  enc?: 1;
  /** The server-rendered first paint. */
  html: string;
}

/**
 * The browser island for `defineLustreView`, bound to Lustre's reconciler. The Gleam build calls
 * this in the generated `.denext/lustre-view.ts`; apps don't.
 *
 * @param Reconciler `Reconciler` from the app's `@gleam/lustre/lustre/vdom/reconciler.ffi.mjs`.
 * @returns The island component.
 */
export function lustreViewIsland(
  Reconciler: LustreReconcilerClass,
): (props: LustreViewIslandProps) => VNode {
  return function LustreView(props: LustreViewIslandProps): VNode {
    const root = useRef<Element | null>(null);
    const [html] = useState(() => props.html);
    useEffect(() => {
      const el = root.current;
      if (!el) return;
      const spec = { view: props.view, props: props.props, token: props.token, enc: props.enc };
      const handle = mountLustreView(spec, el, Reconciler);
      return () => handle.unmount();
      // A new token (other props, or a new signing key after a restart) is another view.
    }, [props.view, props.token]);
    return h("div", {
      ref: root,
      "data-dnx-lustre-view": props.view,
      dangerouslySetInnerHTML: { __html: html },
    });
  };
}
