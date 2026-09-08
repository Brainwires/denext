"use server";
import { createChannel, defineSubscription, revalidateTag } from "denext/server";

// A stateless server-push CHANNEL. `publish(key, payload)` fans the payload out to every
// authorized `useChannel` subscriber over the same socket — no cache tag, no re-render, just
// a push. `authorize` is REQUIRED (construction throws without it); it runs in each
// subscriber's own session, so a real app would gate by the signed-in user. Here every
// same-origin viewer may listen on the single "all" key.
export const announcements = createChannel<{ text: string; at: number }>({
  key: (key) => key === "all",
  authorize: () => true,
});

// A validated live QUERY. `useSubscription` re-runs `resolve` (and re-authorizes) whenever
// one of its `tags` is invalidated — the typed, server-derived-tags cousin of `useLive`.
// There is no input here, so no schema is needed.
let sent = 0;
export const announcementCount = defineSubscription({
  tags: ["announcements"],
  resolve: () => sent,
});

// A "use server" mutation that drives BOTH primitives at once: an immediate channel push
// (the text arrives with no refetch) and a tag invalidation (the subscription recomputes
// its count). The client imports only a stub, so `publish`/`revalidateTag` stay server-side.
export async function sendAnnouncement(text: string): Promise<void> {
  sent += 1;
  await announcements.publish("all", { text, at: Date.now() });
  revalidateTag("announcements");
}
