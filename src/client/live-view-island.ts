// The `denext#LiveView` island: the browser end of one `defineLiveView` on a page.
//
// On the server it renders the view's first paint (the children `defineLiveView` passes it), so
// the page works without JavaScript. In the browser it hydrates that markup, mounts the view
// over the Live socket and, from the first server render on, shows the server's tree. In both
// trees the `on*` props hold handler references (`{ __dnxlv: index }`, what `send(…)` returned
// on the server); the island turns each into a listener that sends the index and the event's
// payload. It is a framework client reference (tagged below, registered by the generated Flight
// entry when the app defines a live view), so an app without one bundles none of this.

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode, VNodeChild, VNodeChildren } from "../jsx/types.ts";
import { useEffect, useMemo, useRef, useState } from "../runtime/hooks.ts";
import { CLIENT_REF } from "../runtime/client-reference.ts";
import { eventPayload } from "../runtime/mvu.ts";
import { type LiveViewHandle, mountLiveView } from "./live-view-client.ts";

/** The island's props (written by `defineLiveView`'s server render). */
export interface LiveViewIslandProps {
  /** The view id. */
  view: string;
  /** The props `init` ran with, as the JSON text the server signed. */
  props: string;
  /** The server's signature over `view` + `props`. */
  token: string;
  /** `1` when `props` carries wire-codec tags. */
  enc?: 1;
  /** The server-rendered first paint. */
  children?: VNodeChildren;
}

/** The handler reference key (`LIVE_VIEW_HANDLER` in runtime/live-view.ts). */
const HANDLER = "__dnxlv";

const EVENT_PROP = /^on[A-Z]/;

/** The index a handler reference carries, or -1. */
function handlerIndex(value: unknown): number {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return -1;
  const n = (value as Record<string, unknown>)[HANDLER];
  return Number.isInteger(n) && (n as number) >= 0 ? n as number : -1;
}

/** `props` with every handler reference in an `on*` prop bound to `fire`; `null` when none. */
function bindProps(
  props: Record<string, unknown>,
  fire: (h: number, e: Event) => void,
): Record<string, unknown> | null {
  let bound: Record<string, unknown> | null = null;
  for (const [name, value] of Object.entries(props)) {
    const index = EVENT_PROP.test(name) ? handlerIndex(value) : -1;
    if (index < 0) continue;
    bound ??= { ...props };
    bound[name] = (e: Event) => fire(index, e);
  }
  return bound;
}

/**
 * Copy a tree with every host element's handler references turned into listeners that call
 * `fire(index, event)`. Subtrees without one are returned as they are.
 */
function bindHandlers(node: VNodeChildren, fire: (h: number, e: Event) => void): VNodeChildren {
  if (Array.isArray(node)) return node.map((c) => bindHandlers(c, fire) as VNodeChild);
  return isHostVNode(node) ? bindHost(node, fire) : node;
}

/** An element node (its `type` a tag name). */
function isHostVNode(node: unknown): node is VNode {
  return node !== null && typeof node === "object" && typeof (node as VNode).type === "string";
}

/** {@link bindHandlers} for one element: its props, then its children. */
function bindHost(vnode: VNode, fire: (h: number, e: Event) => void): VNode {
  const own = vnode.props ?? {};
  const children = own.children as VNodeChildren | undefined;
  const boundChildren = children === undefined ? undefined : bindHandlers(children, fire);
  const props = bindProps(own, fire);
  if (props === null && boundChildren === children) return vnode;
  const next = props ?? { ...own };
  if (children !== undefined) next.children = boundChildren;
  return { ...vnode, props: next } as VNode;
}

function LiveViewIslandImpl(props: LiveViewIslandProps): VNode {
  const handle = useRef<LiveViewHandle | null>(null);
  // Server trees, once the view is mounted (the page's own children until then).
  const [pushed, setPushed] = useState<VNodeChild | undefined>(undefined);
  const fire = useMemo(
    () => (index: number, e: Event) => handle.current?.event(index, eventPayload(e)),
    [],
  );
  useEffect(() => {
    const mounted = mountLiveView(
      { view: props.view, props: props.props, token: props.token, enc: props.enc },
      { onTree: (tree) => setPushed(() => tree) },
    );
    handle.current = mounted;
    return () => {
      handle.current = null;
      mounted.unmount();
      setPushed(undefined);
    };
    // A new token (other props, or a new signing key after a restart) is another view.
  }, [props.view, props.token]);
  const tree = useMemo(
    () => bindHandlers(pushed !== undefined ? pushed : props.children, fire),
    [pushed, props.children, fire],
  );
  return h("div", { "data-dnx-view": props.view }, tree);
}

/** Tag the island as the framework client reference `denext#LiveView`. */
function asClientReference<T extends object>(fn: T): T {
  Object.defineProperty(fn, CLIENT_REF, {
    value: { clientId: "denext", name: "LiveView", id: LIVE_VIEW_REF_ID },
    enumerable: false,
    configurable: true,
  });
  return fn;
}

/** The client-reference id the island is emitted under (and the Flight entry registers). */
const LIVE_VIEW_REF_ID = "denext#LiveView";

/**
 * The live-view island. Rendered by `defineLiveView`'s component, registered by the generated
 * Flight entry; not something to render by hand.
 */
export const LiveViewIsland: (props: LiveViewIslandProps) => VNode =
  /* @__PURE__ */ asClientReference(LiveViewIslandImpl);
