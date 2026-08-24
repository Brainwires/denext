import { Callout, Code, DocsShell } from "../../../components/ui.tsx";

export const metadata = { title: "Rendering strategies" };

export default function Rendering() {
  return (
    <DocsShell
      active="rendering"
      title="Rendering strategies"
      lead="Every Next.js rendering strategy, on by default where Next is — plus denext's own islands and resumability that go beyond it."
    >
      <p>
        denext supports the whole App Router rendering spectrum, and adds a second axis of
        fine-grained hydration that Next.js doesn't have. Two axes:
      </p>
      <ul>
        <li>
          <strong>Parity</strong> — SSR, SSG/static, ISR, CSR/SPA, <strong>Streaming</strong>{" "}
          (on by default, CSP-carrying, Flight-capable), and <strong>PPR / Cache Components</strong>
          {" "}
          (a cached shell + per-request holes, now Flight-capable).
        </li>
        <li>
          <strong>Leadership</strong> — directive-based <strong>islands</strong>, progressive{" "}
          <strong>lazy hydration</strong>, and <strong>resumability</strong>{" "}
          (zero up-front hydration).
        </li>
      </ul>

      <h2>Parity axis</h2>

      <h3>SSR — dynamic, per request</h3>
      <p>
        The default for any route that reads request data. Layouts,{" "}
        <code>loading.tsx</code>, and error boundaries compose per request.
      </p>
      <Code lang="tsx">
        {`export default async function Page() {
  const user = await getUser(); // async Server Component — stays on the server
  return <Dashboard user={user} />;
}`}
      </Code>

      <h3>SSG / static</h3>
      <p>
        Pre-rendered at build time; a fully static route ships <strong>zero</strong> JavaScript.
        {" "}
        <code>generateStaticParams</code> expands dynamic segments.
      </p>
      <Code lang="tsx">
        {`export const dynamic = "force-static";
export function generateStaticParams() {
  return [{ slug: "hello" }, { slug: "world" }];
}`}
      </Code>

      <h3>ISR — incremental static regeneration</h3>
      <p>
        Time- and tag-based regeneration with stale-while-revalidate, backed by real cache stores.
        See <a href="/docs/data">Data &amp; caching</a>.
      </p>
      <Code lang="tsx">{`export const revalidate = 10; // regenerate at most every 10s`}</Code>

      <h3>CSR / SPA</h3>
      <p>
        Two routes to the client: whole-app <a href="/docs/spa">SPA mode</a>{" "}
        (<code>mode: "spa"</code>, no SSR/Flight), or <code>"use client"</code>{" "}
        islands inside the App Router.
      </p>

      <h3>Streaming SSR — on by default</h3>
      <p>
        A route with pending <code>&lt;Suspense&gt;</code>{" "}
        boundaries streams: the shell and fallbacks flush first, then each boundary's real content
        streams in as a <code>&lt;template&gt;</code>{" "}
        revealed by a single hashed swap-runtime script. A route with no holes buffers (so it stays
        cache-friendly). Streaming carries the same strict <strong>hash-based CSP</strong>{" "}
        as a buffered response, and works on <code>"use client"</code> (Flight) routes.
      </p>
      <Code lang="ts">
        {`// denext.config.ts — opt out if you need fully-buffered responses
export default { experimental: { streaming: false } };`}
      </Code>

      <h3>PPR / Cache Components</h3>
      <p>
        With{" "}
        <code>experimental.cacheComponents</code>, a cacheable page renders a request- independent
        {" "}
        <strong>static shell</strong> (cached once) with dynamic subtrees behind{" "}
        <code>&lt;Suspense&gt;</code> as{" "}
        <strong>per-request holes</strong>. A postpone-aware dual HTML+Flight renderer means this
        now works on routes with a <code>"use client"</code>{" "}
        boundary too — islands in the cached shell and inside resumed holes both hydrate.
      </p>
      <Callout kind="warn">
        Cache Components / PPR is experimental (flag-gated), matching Next's own posture. Streaming,
        SSR, SSG, ISR, and CSR are stable.
      </Callout>

      <h3>Route segment config</h3>
      <p>These exports are honored:</p>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Export</th>
              <th>Behavior</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>dynamic: "error"</code>
              </td>
              <td>Throws if a dynamic API (cookies/headers/connection) is read.</td>
            </tr>
            <tr>
              <td>
                <code>dynamic: "force-static"</code>
              </td>
              <td>Dynamic APIs return empty and the page caches (no silent no-cache conflict).</td>
            </tr>
            <tr>
              <td>
                <code>dynamicParams: false</code>
              </td>
              <td>
                Params outside <code>generateStaticParams</code> 404.
              </td>
            </tr>
            <tr>
              <td>
                <code>revalidate</code> / <code>fetchCache</code>
              </td>
              <td>ISR timing; segment-level fetch-cache default.</td>
            </tr>
            <tr>
              <td>
                <code>runtime</code> / <code>preferredRegion</code> / <code>maxDuration</code>
              </td>
              <td>Informational — one Deno runtime, so no separate edge/region.</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2>Leadership axis — islands, lazy hydration, resumability</h2>
      <p>
        denext ships fine-grained hydration Next.js doesn't have. A <code>client:*</code>{" "}
        directive turns a <code>"use client"</code> component into an <strong>island</strong>{" "}
        that hydrates on its own schedule instead of eagerly with the page — full 6/6 Astro
        directive parity, plus resumability Astro lacks. See the{" "}
        <a href="/docs/islands">Islands &amp; hydration</a>{" "}
        guide for the full per-directive reference.
      </p>

      <h3>The six island directives</h3>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Directive</th>
              <th>Hydrates when…</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>client:load</code>
              </td>
              <td>Immediately, but per-island (parity with eager).</td>
            </tr>
            <tr>
              <td>
                <code>client:idle</code>
              </td>
              <td>
                The main thread is idle (<code>requestIdleCallback</code>).
              </td>
            </tr>
            <tr>
              <td>
                <code>client:visible</code>
              </td>
              <td>
                The island scrolls into view (<code>IntersectionObserver</code>).
              </td>
            </tr>
            <tr>
              <td>
                <code>client:interaction</code>
              </td>
              <td>The first interaction inside it (the event is replayed).</td>
            </tr>
            <tr>
              <td>
                <code>client:media="(min-width:800px)"</code>
              </td>
              <td>
                A CSS media query matches (<code>matchMedia</code>).
              </td>
            </tr>
            <tr>
              <td>
                <code>client:only</code>
              </td>
              <td>On the client only — no SSR (no first paint; SEO/CLS tradeoff).</td>
            </tr>
          </tbody>
        </table>
      </div>
      <Code lang="tsx">
        {`import Counter from "./Counter.tsx"; // a "use client" island

export default function Page() {
  return (
    <>
      <Counter client:visible />
      <Chart client:media="(min-width: 800px)" />
      <Cart client:idle />
    </>
  );
}`}
      </Code>
      <p>
        A module can set its own default with{" "}
        <code>export const hydrate = "visible"</code>; a usage-site <code>client:*</code>{" "}
        overrides it. Precedence: <em>usage-site &gt; module default &gt; eager</em>.
      </p>

      <h3>Resumability</h3>
      <p>
        <code>export const resumable = true</code> makes a route interactive with{" "}
        <strong>no up-front hydration</strong>{" "}
        — plain state + event-handler components work unchanged, and only the touched island
        resumes. See <a href="/docs/resumability">Resumability</a> for <code>qrl()</code>{" "}
        and reactive serializable signals.
      </p>

      <Callout kind="note">
        Islands and resumability run on the Flight (RSC) path — a route with a{" "}
        <code>"use client"</code> boundary or <code>resumable</code>. A <code>client:*</code>{" "}
        directive on an island nested inside another island hydrates with its parent (it can't defer
        independently yet).
      </Callout>
    </DocsShell>
  );
}
