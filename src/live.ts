/**
 * # denext/live — Live Server Components
 *
 * `<Live tags={[...]}>` re-renders its server subtree and pushes it over a WebSocket
 * whenever one of its cache tags is invalidated (`revalidateTag`/`updateTag`), and
 * the client reconciles just that subtree in place — every other component's state is
 * preserved and no navigation happens. Next.js has no equivalent.
 *
 * It is a **separate entrypoint** (not part of the main `denext` barrel) so an app
 * that never renders a `<Live>` boundary bundles none of the transport — the
 * framework stays tiny by default.
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
