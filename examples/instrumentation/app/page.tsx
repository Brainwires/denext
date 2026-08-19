// Intro page: links that let you (and the e2e) trigger the two error paths that
// reach onRequestError, plus the /telemetry view of what instrumentation recorded.

import { boomAction } from "./actions.ts";

export default function Home() {
  return (
    <main>
      <h1>Instrumentation</h1>
      <p class="lede">
        A root <code>instrumentation.ts</code> runs <code>register()</code>{" "}
        once at boot and receives every server-side request error via{" "}
        <code>onRequestError</code>. Trigger one, then check the log.
      </p>
      <ul>
        <li>
          <a href="/boom">/boom</a> — a Server Component that throws (render error)
        </li>
        <li>
          <form action={boomAction}>
            <button type="submit">Trigger an action error</button>
          </form>
        </li>
        <li>
          <a href="/telemetry">/telemetry</a> — what instrumentation recorded
        </li>
      </ul>
    </main>
  );
}
