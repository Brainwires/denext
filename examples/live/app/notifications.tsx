"use client";
import { useChannel, useSubscription } from "denext/live";
import { announcementCount, announcements, sendAnnouncement } from "./notifications.ts";

// `useChannel` receives every `publish("all", …)` as a new `data` — at-most-once,
// latest-wins, no history. `useSubscription` re-runs the server `resolve` whenever the
// "announcements" tag is invalidated. One button drives both: the channel push lands
// instantly, and the count recomputes from the tag — two different real-time paths.
export function Notifications({ initialCount }: { initialCount: number }) {
  const { data: latest, status } = useChannel(announcements, "all");
  const { data: count } = useSubscription(announcementCount, undefined, { initial: initialCount });

  return (
    <div class="notifications">
      <p class="count">{count ?? initialCount} sent</p>
      <p class="latest">
        {latest
          ? `“${latest.text}”`
          : status === "subscribed"
          ? "Listening…"
          : "No announcements yet"}
      </p>
      <button
        type="button"
        onClick={() => void sendAnnouncement(`Ping at ${new Date().toLocaleTimeString()}`)}
      >
        Send announcement
      </button>
      <p class="hint">Pushed to every open tab over the channel; the count updates via a tag.</p>
    </div>
  );
}
