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
 * `defineLiveView` keeps a whole Model–View–Update program on the server instead: the model
 * lives per connection, the first paint is HTML, and each event bound with `send(…)` runs
 * `update` on the server and comes back as a DOM patch (see `denext/mvu` for the same program
 * in the browser).
 *
 * `configureLive` is called by the generated Flight client entry, not by app code.
 *
 * @module
 */

export { Live } from "./runtime/live-boundary.ts";
export type { LiveProps } from "./runtime/live-boundary.ts";
export { configureLive, subscribeLiveTags } from "./client/live-client.ts";
export { useApiLive } from "./client/use-api-live.ts";
export { useChannel, useSubscription } from "./client/live-typed.ts";
export type { UseChannelOptions } from "./client/live-typed.ts";
export { subscribeChannel } from "./client/live-client.ts";
export type { ChannelRef } from "./runtime/channel.ts";
export type {
  LiveSubscriptionError,
  SubscriptionRefLike,
  SubscriptionState,
  UseSubscriptionOptions,
} from "./client/live-typed.ts";
export type { LiveErrorInfo } from "./client/live-client.ts";

// Mark a server action readable over the live data channel (`useLive`). See the
// Live security model — data subscriptions are default-deny in production.
export { liveReadable } from "./runtime/server-action.ts";

// Server-held live views: a Model–View–Update program whose model lives on the server, per
// connection; events bound with `send(…)` run `update` there and come back as DOM patches.
export { defineLiveView } from "./runtime/live-view.ts";
export type { LiveViewComponent, LiveViewConfig, LiveViewContext } from "./runtime/live-view.ts";
// The framework island a live view renders through (registered by the generated Flight entry).
export { LiveViewIsland } from "./client/live-view-island.ts";
export type { LiveViewIslandProps } from "./client/live-view-island.ts";

// Live-data hooks (real-time server data + presence over the same socket).
export { useLive, useLiveOptimistic, usePresence } from "./client/live-data.ts";
export type {
  LiveActionRef,
  Presence,
  UseLiveOptions,
  UsePresenceOptions,
} from "./client/live-data.ts";
