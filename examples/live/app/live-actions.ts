import { liveReadable, serverAction } from "denext";

// Shared in-memory value — a stand-in for a database read behind a cache tag.
let count = 0;

/** Increment the shared count (called by the `bump` mutation, server-side). */
export function incr(): void {
  count += 1;
}

// A READ action, marked `liveReadable` so it may be streamed over the Live socket
// (`useLive`). Marking is required: a registered action is HTTP-dispatchable but is
// NOT exposed to the live channel until you opt it in (or authorize it with an
// `experimental.live.canSubscribe` policy). This module has NO server-only imports,
// so the client bundles only the action's stub. Never mark a mutation `liveReadable`.
export const getCount = liveReadable(
  serverAction("live-example#getCount", () => count),
);
