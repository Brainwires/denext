// Renders the recorded instrumentation events (from lib/telemetry) — the same log
// instrumentation.ts writes to. force-dynamic so each request reflects the latest
// events (register at boot, plus any onRequestError since).

import { snapshot } from "../../lib/telemetry.ts";

export const dynamic = "force-dynamic";

export default function Telemetry() {
  const events = snapshot();
  return (
    <main>
      <h1>Telemetry</h1>
      <p>
        Events recorded by <code>instrumentation.ts</code>:
      </p>
      <pre id="telemetry">{JSON.stringify(events, null, 2)}</pre>
    </main>
  );
}
