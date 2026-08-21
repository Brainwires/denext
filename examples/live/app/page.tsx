import { getCount } from "./live-actions.ts";
import { LiveCount } from "./live-count.tsx";
import { Presence } from "./presence.tsx";

// A Server Component: it reads the initial count on the server (the same action the
// client subscribes to for live updates) and renders the two client islands.
export default async function Home() {
  const initial = await getCount();

  return (
    <section>
      <h1>Live data &amp; presence</h1>
      <p class="lead">
        Two client hooks over one WebSocket: <code>useLive</code>{" "}
        streams a server value that updates when a cache tag is invalidated, and{" "}
        <code>usePresence</code> shows who else is on the page. Both are secured by the{" "}
        <code>experimental.live</code> policy in <code>denext.config.ts</code>.
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
      </div>

      <p class="foot-note">
        Open a second browser tab: clicking <strong>+1</strong>{" "}
        updates the count in both, and each tab appears in the other&#39;s presence list — all
        pushed from the server, no polling.
      </p>
    </section>
  );
}
