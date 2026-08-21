"use client";
import { useLive } from "denext/live";
import { getCount } from "./live-actions.ts";
import { bump } from "./mutations.ts";

// Streams the shared count. `useLive` re-runs `getCount` (under this viewer's own
// session) and re-renders whenever the "count" tag is invalidated — which `bump`
// does on the server. `getCount` is `liveReadable` (see app/live-actions.ts), so the
// hub allows this subscription; an unmarked action would be refused in production.
export function LiveCount({ initial }: { initial: number }) {
  const count = useLive(getCount, [], { tags: ["count"], initial });

  return (
    <div class="live-count">
      <p class="count">{count ?? initial}</p>
      <button type="button" onClick={() => void bump()}>+1</button>
      <p class="hint">Every open tab updates live when anyone clicks.</p>
    </div>
  );
}
