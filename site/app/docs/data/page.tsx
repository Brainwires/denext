import { Callout, Code, DocsShell } from "../../../components/ui.tsx";

export const metadata = {
  title: "Data & caching",
  description:
    "Fetch on the server in async components. Cache with fetch semantics, unstable_cache, ISR, and Cache Components.",
};

export default function Data() {
  return (
    <DocsShell
      active="data"
      title="Data & caching"
      lead="Fetch on the server in async components. Cache with fetch semantics, unstable_cache, ISR, and Cache Components."
    >
      <h2>Fetch in a Server Component</h2>
      <Code lang="tsx">
        {`export default async function Page() {
  const res = await fetch("https://api.example.com/products", {
    next: { revalidate: 3600, tags: ["products"] }, // 1h cache, purgeable by tag
  });
  const products = await res.json();
  return <List products={products} />;
}`}
      </Code>
      <Callout kind="note">
        A page component receives <code>{"{"} params, searchParams {"}"}</code>, not the raw{" "}
        <code>Request</code>. Read per-request data with <code>cookies()</code> /{" "}
        <code>headers()</code> from <code>denext/server</code>{" "}
        — both mark the render dynamic, so a personalized page is never served from the ISR cache.
        Route handlers get the <code>Request</code> directly.
      </Callout>
      <p>
        Fetches are uncached by default (Next 15/16 semantics) and opt into caching via{" "}
        <code>next: {"{"} revalidate, tags {"}"}</code> or{" "}
        <code>cache: "force-cache"</code>. Requests are deduped within a render.
      </p>

      <h2>Invalidation</h2>
      <Code lang="ts">
        {`import { revalidatePath, revalidateTag, unstable_cache } from "denext/server";

const getProducts = unstable_cache(fetchProducts, ["products"], { revalidate: 3600 });
revalidateTag("products"); // purge everything tagged "products"
revalidatePath("/blog");   // purge a route`}
      </Code>

      <h2>ISR</h2>
      <Code lang="tsx">
        {`// app/page.tsx
export const revalidate = 10; // regenerate at most every 10s (stale-while-revalidate)

export default function Feed() {
  return <Posts />;
}`}
      </Code>

      <h2 id="debugging-the-cache">Debugging the cache</h2>
      <p>
        <strong>Read the header.</strong>{" "}
        Every page response that went through the ISR cache carries <code>x-denext-cache</code>:
        {" "}
        <code>HIT</code> (served from the store), <code>STALE</code> (served from the store past its
        {" "}
        <code>revalidate</code> while one background regeneration runs), or <code>MISS</code>{" "}
        (rendered now and stored). <strong>No header at all</strong>{" "}
        means the response never entered the cache path — the route declares no{" "}
        <code>revalidate</code> /{" "}
        <code>dynamic = "force-static"</code>, or the render turned out dynamic. Only a{" "}
        <code>GET</code> is cacheable, so probe with a GET that dumps headers —{" "}
        <code>
          curl -s -o /dev/null -D - https://example.com/blog/hello | grep -i x-denext-cache
        </code>{" "}
        — twice; a <code>HEAD</code> (<code>curl -I</code>) never shows the header.
      </p>
      <p>
        <strong>Why a page went dynamic.</strong> A render is refused by the cache (and answers{" "}
        <code>cache-control: private, no-store</code>) when anything in it read per-request state:
      </p>
      <ul>
        <li>
          <code>cookies()</code>, <code>headers()</code>, <code>connection()</code> or{" "}
          <code>noStore()</code>{" "}
          anywhere in the tree — including inside a layout or a shared component (an auth check in
          the root layout makes every page dynamic).
        </li>
        <li>
          <code>export const dynamic = "force-dynamic"</code>, which is the explicit form.
        </li>
        <li>
          A <code>searchParams</code> read of a name outside <code>cacheKeyParams</code>{" "}
          when that allowlist is configured (the value would be baked into a body served to
          everyone; dev warns which param).
        </li>
        <li>
          Metadata that needs the request's host: an auto-populated <code>og:image</code>{" "}
          or canonical URL is absolutized from <code>Host</code> unless <code>canonicalOrigin</code>
          {" "}
          is set — so a page with no code that reads the request can still be dynamic. Pin{" "}
          <code>canonicalOrigin</code> and it caches.
        </li>
      </ul>
      <p>
        In <code>denext dev</code>{" "}
        the DevTools panel shows each route's render mode and cache outcome; in production, the
        header above plus a <code>cookies()</code>-shaped grep of the layout tree finds it.
      </p>
      <p>
        <strong>
          What <code>revalidate</code> and tags do.
        </strong>{" "}
        <code>export const revalidate = N</code> stores the rendered document and serves it for{" "}
        <code>N</code>{" "}
        seconds; the first request after that gets the stale copy and triggers exactly one
        regeneration in the background (stale-while-revalidate, with backoff when the regen fails).
        {" "}
        <code>force-static</code> caches with no expiry. A tag — from{" "}
        <code>fetch(url, {"{ next: { tags } }"})</code>, <code>unstable_cache</code> or{" "}
        <code>cacheTag</code> — is inherited by every page that read the data, so{" "}
        <code>revalidateTag(tag)</code> purges the data entry <em>and</em> every page built from it;
        {" "}
        <code>revalidatePath(path)</code>{" "}
        purges the pages rendered for that exact pathname. Both act on the store of the process that
        called them — see <a href="/docs/multi-instance">Multi-instance</a>.
      </p>

      <h2 id="cdn-headers">CDN headers</h2>
      <p>
        With <code>cdnCacheHeaders: true</code>{" "}
        (it is off by default), an ISR page tells a shared cache it may keep it. The render that
        stores the entry (
        <code>x-denext-cache: MISS</code>) and every later hit answer
      </p>
      <Code lang="http">
        {`Cache-Control: public, s-maxage=60, stale-while-revalidate=31536000`}
      </Code>
      <p>
        where <code>s-maxage</code>{" "}
        is how long the entry stays fresh in denext's own cache — the route's{" "}
        <code>revalidate</code> on the MISS, the seconds left on a hit, <code>0</code>{" "}
        once it is stale and regenerating — so the CDN never holds a page past the moment denext
        would refresh it. A <code>force-static</code> page is <code>public, s-maxage=31536000</code>
        {" "}
        — a year, and <code>revalidatePath</code> / <code>revalidateTag</code>{" "}
        do not reach the CDN's copy. Browsers keep nothing (<code>s-maxage</code>{" "}
        is for shared caches only).
      </p>
      <p>
        Turn it on only for pages every visitor may see. A CDN keys a page on its URL, so a page
        gated on anything else — an IP allow-list, an auth proxy's header, geolocation,{" "}
        <code>Accept-Language</code>{" "}
        — is served from the CDN to everyone once one allowed visitor fetched it; and most CDNs
        leave <code>Cookie</code>{" "}
        out of the key, so the cookie rule below does not keep cookie-based variants apart there
        either. That is why the header is also left off when a <code>middleware.ts</code>{" "}
        matched the request (<code>{"{ evenWithMiddleware: true }"}</code>{" "}
        sends it anyway, for middleware that decides nothing about who sees the page) and when the
        request's locale was negotiated (<code>detectLocale</code>,{" "}
        <code>localeMiddleware</code>, next-intl's middleware; <code>evenWithMiddleware</code>{" "}
        does not lift this).
      </p>
      <p>
        Nothing private is ever marked public. The header is left off when the request carried a
        {" "}
        <code>Cookie</code> or <code>Authorization</code>{" "}
        (middleware may have routed on it), when the response sets a cookie, when the status is not
        200, when the render read <code>cookies()</code>/<code>headers()</code> (it is{" "}
        <code>private, no-store</code> and never stored), and when middleware or a{" "}
        <code>headers()</code> rule already set <code>Cache-Control</code>{" "}
        — the app's own policy wins:
      </p>
      <Code lang="ts">
        {`// denext.config.ts
import type { DenextConfig } from "denext/server";

export default {
  headers: () => [
    {
      source: "/blog/:slug",
      // a longer stale window of your own on these routes only
      headers: [{ key: "Cache-Control", value: "public, s-maxage=60, stale-while-revalidate=600" }],
    },
  ],
  // shared-cache headers on every eligible ISR page (off by default):
  // cdnCacheHeaders: true,
} satisfies DenextConfig;`}
      </Code>
      <p>
        <code>revalidateTag</code> and <code>revalidatePath</code>{" "}
        purge denext's store, not the CDN's — pair them with the CDN's purge API when freshness
        after a mutation matters. A middleware that varies its rewrite on a request header other
        than the cookie should set its own <code>Cache-Control</code> (or <code>Vary</code>
        ). Responses already vary on <code>x-denext-nav</code>{" "}
        so a soft-navigation payload is never confused with the HTML document by an intermediary.
      </p>

      <h2>Cache Components & PPR</h2>
      <p>
        With <code>cacheComponents: true</code> in{" "}
        <code>denext.config.ts</code>, mark expensive work with <code>"use cache"</code>{" "}
        and control it with <code>cacheLife</code> /{" "}
        <code>cacheTag</code>. Partial Prerendering serves a cached static shell with per-request
        dynamic holes.
      </p>
      <Callout kind="note">
        Cache Components and PPR are a stable <strong>opt-in</strong>{" "}
        (off unless you set the flag — caching is a choice, not a default). The legacy{" "}
        <code>experimental.cacheComponents</code>{" "}
        still works and warns in dev. Its documented bounds — request data inside{" "}
        <code>use cache</code>{" "}
        throws; a streamed hole can't add to the already-flushed head — are listed in
        KNOWN-LIMITATIONS.
      </Callout>
    </DocsShell>
  );
}
