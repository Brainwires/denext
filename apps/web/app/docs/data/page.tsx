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
