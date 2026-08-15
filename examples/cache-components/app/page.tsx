// A Partial-Prerendered page. `revalidate` opts it into caching; with
// `experimental.cacheComponents` on, denext prerenders a request-independent
// STATIC SHELL (cached once — including the `use cache` island below) and turns
// any dynamic subtree (behind a Suspense boundary) into a PER-REQUEST HOLE that is
// re-rendered and spliced into the cached shell on every request.

import { Suspense } from "denext";
import { connection } from "denext/server";
import { getCachedStamp } from "../lib/data.ts";

// Opt this page into caching → PPR caches its shell (default `auto` pages are not
// cached, so PPR would have nothing to cache).
export const revalidate = 60;

/** Static shell content: an async server component reading the `use cache` helper. */
async function ShellStamp() {
  const stamp = await getCachedStamp();
  return (
    <p class="stamp cached" data-cached-stamp={stamp}>
      computed once, cached: <b>{stamp}</b>
    </p>
  );
}

/**
 * A dynamic hole: `connection()` is an explicit dynamic signal, so during the
 * prerender it postpones — this subtree becomes a per-request hole. `Date.now()`
 * therefore changes on every request (the shell around it does not).
 */
async function LiveTime() {
  await connection();
  const now = new Date().toISOString();
  return (
    <p class="stamp live" data-live-time={now}>
      served fresh, per request: <b>{now}</b>
    </p>
  );
}

export default function Home() {
  return (
    <section>
      <h1>Cache Components</h1>
      <p class="lede">
        One page, two lifetimes: a <b>static shell</b> served from cache, and a
        {" "}
        <b>dynamic hole</b> rendered on every request.
      </p>

      <div class="card">
        <h2>
          Static shell · <code>use cache</code>
        </h2>
        <ShellStamp />
        <p class="hint">
          Stable across requests — it lives in the cached shell.
        </p>
      </div>

      <div class="card">
        <h2>Dynamic hole · Suspense</h2>
        <Suspense fallback={<p class="stamp skeleton">loading live data…</p>}>
          <LiveTime />
        </Suspense>
        <p class="hint">Changes on every request — spliced into the shell.</p>
      </div>
    </section>
  );
}
