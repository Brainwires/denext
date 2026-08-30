import { Callout, Code, DocsShell } from "../../../components/ui.tsx";

export const metadata = { title: "Metadata & SEO" };

export default function Metadata() {
  return (
    <DocsShell
      active="metadata"
      title="Metadata & SEO"
      lead="Titles, Open Graph tags, sitemaps, and robots — the same file conventions as Next.js, rendered into the document head on the server."
    >
      <h2>Static metadata</h2>
      <p>
        Export a <code>metadata</code>{" "}
        object from a layout or page. Layout and page metadata merge, with the page winning.
      </p>
      <Code lang="tsx">
        {`// app/blog/[slug]/page.tsx
export const metadata = {
  title: "My post",
  description: "A great read.",
  openGraph: { title: "My post", images: ["/og/post.png"] },
};`}
      </Code>

      <h2>Dynamic metadata</h2>
      <p>
        Export an async <code>generateMetadata</code>{" "}
        to compute tags from params or data. It runs on the server during render.
      </p>
      <Code lang="tsx">
        {`export async function generateMetadata({ params }) {
  const post = await getPost(params.slug);
  return { title: post.title, description: post.excerpt };
}`}
      </Code>

      <h2>Structured data (JSON-LD)</h2>
      <p>
        Add a <code>jsonLd</code> field — one object or an array — and denext serializes each into a
        {" "}
        <code>&lt;script type="application/ld+json"&gt;</code>{" "}
        in the head, escaped so a payload can never break out of the script. Layout and page JSON-LD
        accumulate, so a site-wide <code>Organization</code> and a per-page <code>Article</code>
        {" "}
        both ship.
      </p>
      <Code lang="tsx">
        {`export const metadata = {
  jsonLd: {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: "My post",
    author: { "@type": "Person", name: "Ada" },
  },
};`}
      </Code>

      <h2>Automatic hreflang</h2>
      <p>
        When i18n is configured, denext emits <code>&lt;link rel="alternate" hreflang&gt;</code>
        {" "}
        alternates for every locale — plus an <code>x-default</code> — and a per-locale{" "}
        <code>&lt;link rel="canonical"&gt;</code>{" "}
        on every page, built from your locale list. No per-page setup. A page that sets its own{" "}
        <code>alternates.languages</code>{" "}
        always wins, so custom or translated URLs stay in your control.
      </p>
      <Code lang="ts">
        {`// your i18n config
i18n: {
  locales: ["en", "fr", "de"],
  defaultLocale: "en",
  // hreflang: false  // opt out of automatic alternates
}`}
      </Code>
      <Callout kind="note">
        Generated URLs are absolute, so set <code>metadataBase</code>{" "}
        (or a canonical origin) — required for correct <code>hreflang</code>{" "}
        in a static export, where there is no request host to derive one from.
      </Callout>

      <h2>File conventions</h2>
      <p>
        These special files are auto-detected and served at their canonical paths:
      </p>
      <ul>
        <li>
          <code>app/sitemap.ts</code> → <code>/sitemap.xml</code>
        </li>
        <li>
          <code>app/robots.ts</code> → <code>/robots.txt</code>
        </li>
        <li>
          <code>app/manifest.ts</code> → <code>/manifest.webmanifest</code>
        </li>
        <li>
          <code>favicon.ico</code>, <code>icon.*</code>, <code>apple-icon.*</code> — icon links
        </li>
        <li>
          <code>opengraph-image.*</code> / <code>twitter-image.*</code> — auto-wired{" "}
          <code>og:image</code>
        </li>
      </ul>
      <Code lang="ts">
        {`// app/sitemap.ts
export default function sitemap() {
  return [
    { url: "https://example.com/", changeFrequency: "weekly" },
    { url: "https://example.com/blog", changeFrequency: "daily" },
  ];
}`}
      </Code>
      <p>
        For large sites, export <code>generateSitemaps</code> to shard: <code>/sitemap.xml</code>
        {" "}
        becomes an index over <code>/sitemap/0.xml</code>, <code>/sitemap/1.xml</code>, … and your
        {" "}
        <code>default</code> export receives each shard's{" "}
        <code>id</code>. Entries may also carry per-URL{" "}
        <code>alternates.languages</code>, emitted as <code>xhtml:link</code>{" "}
        hreflang alternates inside the sitemap.
      </p>
      <Code lang="ts">
        {`// app/sitemap.ts
export function generateSitemaps() {
  return [{ id: 0 }, { id: 1 }];
}

export default async function sitemap({ id }) {
  const posts = await getPostPage(id);
  return posts.map((p) => ({
    url: \`https://example.com/blog/\${p.slug}\`,
    alternates: { languages: { en: p.enUrl, fr: p.frUrl } },
  }));
}`}
      </Code>

      <h2>Dynamic OG images</h2>
      <p>
        Render an Open Graph image from JSX with <code>ImageResponse</code>{" "}
        (next/og-compatible) — no headless browser, no external service.
      </p>
      <Code lang="tsx">
        {`// app/og/route.tsx
import { ImageResponse } from "denext/server";

export function GET() {
  return new ImageResponse(
    <div style={{ fontSize: 64, color: "white", background: "#0a0c11",
      width: "100%", height: "100%", display: "flex",
      alignItems: "center", justifyContent: "center" }}>
      Hello denext
    </div>,
    { width: 1200, height: 630 },
  );
}`}
      </Code>

      <Callout kind="note">
        A dynamic <code>opengraph-image</code> route auto-populates the page's <code>og:image</code>
        {" "}
        meta tag — unless the page sets its own image, which always wins. Place{" "}
        <code>opengraph-image.*</code> in any route folder (e.g.{" "}
        <code>app/blog/opengraph-image.tsx</code>) and it applies to that section, inherited by
        nested routes.
      </Callout>
    </DocsShell>
  );
}
