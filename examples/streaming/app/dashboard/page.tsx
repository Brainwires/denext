// Async Server Components inside Suspense boundaries. Each widget awaits its own
// (simulated) data source at a different latency. Under denext's buffered SSR the
// page render awaits all boundaries, so the HTML delivered already contains the
// resolved data — the Suspense fallbacks are what a CLIENT navigation shows while
// the route loads (see loading.tsx), and what the streaming route (/stream) flushes
// first. The two widgets await in parallel, so the page is ready in ~max(delays),
// not the sum.

import { Suspense } from "denext";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function Sales() {
  await delay(150);
  return (
    <div class="widget">
      <span class="label">Sales (last 24h)</span>
      <span class="metric">$48,210</span>
    </div>
  );
}

async function Signups() {
  await delay(300);
  return (
    <div class="widget">
      <span class="label">New signups</span>
      <span class="metric">1,204</span>
    </div>
  );
}

export default function Dashboard() {
  return (
    <section>
      <h1>Dashboard</h1>
      <p class="lede">
        Two async Server Components, each in its own{" "}
        <code>&lt;Suspense&gt;</code>{" "}
        boundary, resolved in parallel on the server.
      </p>
      <div class="grid">
        <Suspense fallback={<div class="widget skeleton">Loading sales…</div>}>
          <Sales />
        </Suspense>
        <Suspense
          fallback={<div class="widget skeleton">Loading signups…</div>}
        >
          <Signups />
        </Suspense>
      </div>
    </section>
  );
}
