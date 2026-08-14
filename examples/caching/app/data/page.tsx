// Data cache demo. `unstable_cache` wraps an expensive async loader in a
// cross-request cache keyed by its key-parts + args, with an optional TTL and
// tags. Here the loader stamps the moment it actually ran, so a cache HIT shows a
// stable timestamp on reload — and only changes when the "products" tag is purged
// via revalidateTag (the form below posts to an API route that calls it).

import { unstable_cache } from "denext/server";

// Simulate an expensive upstream read (a DB query / third-party API). It records
// when it truly executed; the cache then serves that same value until invalidated.
const loadProducts = unstable_cache(
  () => {
    return {
      generatedAt: new Date().toISOString(),
      items: ["Widget", "Gadget", "Gizmo"],
    };
  },
  ["products"], // key parts
  { revalidate: 3600, tags: ["products"] }, // 1h TTL, purgeable by tag
);

export default async function DataCacheDemo() {
  const data = await loadProducts();
  const now = new Date().toISOString();

  return (
    <section>
      <h1>
        Data cache — <code>unstable_cache</code>
      </h1>

      <div class="row">
        <div class="stat">
          <span class="label">Cached “fetched at”</span>
          <span class="value" data-cached-at>{data.generatedAt}</span>
          <span class="hint">
            stable across reloads — it's the cached value
          </span>
        </div>
        <div class="stat">
          <span class="label">Live render time</span>
          <span class="value">{now}</span>
          <span class="hint">
            changes every request — proves the page re-rendered
          </span>
        </div>
      </div>

      <ul class="items">
        {data.items.map((it) => <li key={it}>{it}</li>)}
      </ul>

      <form action="/api/revalidate" method="post">
        <button type="submit">Revalidate the “products” tag</button>
      </form>
      <p class="note">
        Reload a few times: the cached timestamp holds. Submit the form and it
        jumps — <code>revalidateTag("products")</code>{" "}
        purged the entry, so the loader ran again.
      </p>
    </section>
  );
}
