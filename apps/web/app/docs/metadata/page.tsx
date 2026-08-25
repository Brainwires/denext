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
        meta tag — unless the page sets its own image, which always wins.
      </Callout>
    </DocsShell>
  );
}
