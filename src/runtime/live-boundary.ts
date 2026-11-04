/**
 * `<Live>` — a Live Server Component boundary. Wrap a server-rendered subtree that
 * reads cached data tagged with `tags`; when any of those tags is invalidated
 * (`revalidateTag`/`updateTag`), the server re-renders this boundary under the
 * viewer's own session and pushes the new subtree over a WebSocket, which is
 * reconciled in place — every other component's state is preserved and no
 * navigation occurs.
 *
 * `<Live>` is authored as a client island: on the server it is emitted as a Flight
 * reference whose children are server-rendered holes, and on the client it mounts,
 * subscribes its boundary, and swaps in patched children as they arrive. Next.js
 * has no equivalent — this is denext's real-time differentiator.
 *
 * **The subtree must be self-contained:** it and its descendants must derive their
 * output only from `tags`-keyed cached data, `params`, `cookies()`/`headers()`, and
 * the cache — never from mutable outer-closure state, because a push re-renders the
 * route afresh and won't carry that state.
 *
 * @module
 */

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode, VNodeChild, VNodeChildren } from "../jsx/types.ts";
import { useEffect, useRef, useState } from "./hooks.ts";
import { useId } from "./hooks/use-id.ts";
import { prefixFromId } from "../jsx/tree-id.ts";
import { registerLiveBoundary } from "./live-registry.ts";
import { CLIENT_REF } from "./client-reference.ts";
import { LIVE_REF_ID } from "./live-protocol.ts";

/** Props for {@linkcode Live}. */
export interface LiveProps {
  /**
   * Cache tags this boundary depends on. Invalidating any of them (via
   * `revalidateTag`/`updateTag`) pushes a fresh render of this subtree to the client.
   */
  tags: string[];
  /** The server-rendered subtree to keep live. */
  children?: VNodeChildren;
  /** The wrapper element tag (defaults to `"div"`). */
  as?: string;
  /** Any additional attributes forwarded to the wrapper element. */
  [key: string]: unknown;
}

/**
 * A real-time server-component boundary. See the {@link ./live-boundary.ts | module docs}.
 *
 * @param props {@linkcode LiveProps} — `tags`, `children`, an optional wrapper `as`.
 * @returns The wrapper element around the (possibly patched) live subtree.
 * @example Keep an order list live whenever the `"orders"` tag is revalidated:
 * ```tsx
 * import { Live } from "denext";
 *
 * export default function Page() {
 *   return (
 *     <Live tags={["orders"]}>
 *       <OrderList />
 *     </Live>
 *   );
 * }
 * ```
 */
export function Live(props: LiveProps): VNode {
  // The boundary's stable, server/client-agreed id is this island's scope prefix,
  // recovered from its first useId(). The server addresses the same boundary by the
  // `__dnxIdPath` it stamps on the emitted Flight reference.
  const boundaryId = prefixFromId(useId());
  const [, bump] = useState(0);

  // A push replaces the rendered children until the parent re-renders with its own
  // (a full-route refresh), at which point we drop the patch and follow the parent —
  // otherwise a coarse refresh and a boundary patch would fight over the subtree.
  const patched = useRef<VNodeChild | undefined>(undefined);
  const lastChildren = useRef<VNodeChildren | undefined>(props.children);
  if (lastChildren.current !== props.children) {
    lastChildren.current = props.children;
    patched.current = undefined;
  }

  const tags = props.tags ?? [];
  const tagsKey = tags.join("\0");
  useEffect(() => {
    // Registration is a no-op on the server / without a live runtime installed.
    return registerLiveBoundary(boundaryId, tags, (children) => {
      patched.current = children;
      bump((n) => n + 1);
    });
    // Re-subscribe when the boundary identity or its tag set changes.
  }, [boundaryId, tagsKey]);

  const { tags: _tags, children, as, ...rest } = props;
  const tree = patched.current !== undefined ? patched.current : children;
  return h(as ?? "div", { ...rest, "data-dnx-live": boundaryId }, tree);
}

// Tag <Live> as a framework client reference so the Flight renderer emits it as an
// island (children become server holes) instead of invoking it during the Flight
// pass; the client registry resolves LIVE_REF_ID back to this function. `<Live>`
// lives on the `denext/live` subpath (not the main barrel), so an app that never
// imports it never bundles it — this tagging cost is paid only when it is used.
Object.defineProperty(Live, CLIENT_REF, {
  value: { clientId: "denext", name: "Live", id: LIVE_REF_ID },
  enumerable: false,
  configurable: true,
});
