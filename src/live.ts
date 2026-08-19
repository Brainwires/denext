/**
 * # denext/live — Live Server Components
 *
 * `<Live tags={[...]}>` re-renders its server subtree and pushes it over a WebSocket
 * whenever one of its cache tags is invalidated (`revalidateTag`/`updateTag`), and
 * the client reconciles just that subtree in place — every other component's state is
 * preserved and no navigation happens. The same socket also powers the **live-data**
 * family — {@link useLive} (real-time server data), {@link usePresence} (who's-online
 * / cursors), and {@link useLiveOptimistic}. Next.js has no first-party equivalent.
 *
 * It is a **separate entrypoint** (not part of the main `denext` barrel) so an app
 * that never uses a live feature bundles none of the transport — the framework stays
 * tiny by default.
 *
 * @example A live order list
 * ```tsx
 * import { Live } from "@denext/denext/live";
 *
 * export default function Page() {
 *   return (
 *     <Live tags={["orders"]}>
 *       <OrderList />
 *     </Live>
 *   );
 * }
 * ```
 *
 * `configureLive` is called by the generated Flight client entry, not by app code.
 *
 * @module
 */

export { Live } from "./runtime/live-boundary.ts";
export type { LiveProps } from "./runtime/live-boundary.ts";
export { configureLive } from "./client/live-client.ts";

// Live-data hooks (real-time server data + presence over the same socket).
export { useLive, useLiveOptimistic, usePresence } from "./client/live-data.ts";
export type {
  LiveActionRef,
  Presence,
  UseLiveOptions,
  UsePresenceOptions,
} from "./client/live-data.ts";
