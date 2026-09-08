import { getCount } from "./live-actions.ts";
import { announcementCount } from "./notifications.ts";
import { LiveCount } from "./live-count.tsx";
import { Notifications } from "./notifications.tsx";
import { Presence } from "./presence.tsx";

// A Server Component: it reads the initial values on the server (the same sources the
// client subscribes to for live updates) and renders the client islands.
export default async function Home() {
  const initial = await getCount();
  const initialAnnouncements = await announcementCount();

  return (
    <section>
      <h1>Live data &amp; presence</h1>
      <p class="lead">
        Four client hooks over one WebSocket: <code>useLive</code>{" "}
        streams a server value that updates when a cache tag is invalidated,{" "}
        <code>usePresence</code> shows who else is on the page, <code>useChannel</code>{" "}
        receives server-pushed events, and <code>useSubscription</code>{" "}
        runs a typed, gated live query. All are secured by the <code>live</code> policy in{" "}
        <code>denext.config.ts</code>.
      </p>

      <div class="grid">
        <section class="card">
          <h2>Live shared count</h2>
          <LiveCount initial={initial} />
        </section>

        <section class="card">
          <h2>Who&#39;s here</h2>
          <Presence />
        </section>

        <section class="card">
          <h2>Announcements</h2>
          <Notifications initialCount={initialAnnouncements} />
        </section>
      </div>

      <p class="foot-note">
        Open a second browser tab: clicking <strong>+1</strong>{" "}
        updates the count in both, and each tab appears in the other&#39;s presence list — all
        pushed from the server, no polling.
      </p>
    </section>
  );
}
