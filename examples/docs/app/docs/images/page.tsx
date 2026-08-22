import { Callout, Code, DocsShell } from "../../../components/ui.tsx";

export const metadata = { title: "Images" };

export default function Images() {
  return (
    <DocsShell
      active="images"
      title="Images"
      lead="An optimizing <Image> component with a built-in, self-hosted optimization endpoint — modern formats, correct sizing, no external service."
    >
      <h2>The Image component</h2>
      <p>
        Import <code>Image</code> from <code>denext</code> (or <code>next/image</code>{" "}
        in a migrated app). It lazy-loads, reserves space to avoid layout shift, and requests an
        optimized source.
      </p>
      <Code lang="tsx">
        {`import { Image } from "denext";

export default function Avatar() {
  return <Image src="/me.jpg" width={96} height={96} alt="Portrait" />;
}`}
      </Code>

      <h2>The optimization endpoint</h2>
      <p>
        <code>{"<Image>"}</code> points at the built-in <code>/_denext/image</code>{" "}
        optimizer, which decodes the source and re-encodes it to a modern raster format (WebP, and
        AVIF when the browser advertises it) at the requested width.
      </p>
      <ul>
        <li>
          Width is validated against an allowlist — arbitrary sizes are rejected.
        </li>
        <li>
          SVG sources are refused outright (no script-bearing SVG is ever echoed).
        </li>
        <li>
          Responses are cache-friendly and size-bounded to resist decompression bombs.
        </li>
      </ul>

      <h2>Remote images</h2>
      <p>
        To optimize images from other hosts, allowlist them. Remote fetches are SSRF-guarded (they
        can never reach internal/private addresses) and bounded in size and time.
      </p>
      <Code lang="ts">
        {`// denext.config.ts
export default {
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "cdn.example.com" },
    ],
  },
};`}
      </Code>

      <Callout kind="note">
        Set <code>width</code> and <code>height</code> (or use{" "}
        <code>fill</code>) so the browser reserves space — this is what removes cumulative layout
        shift.
      </Callout>

      <Callout kind="warn">
        AVIF encoding is heavier than WebP. It's negotiated per-request from the <code>Accept</code>
        {" "}
        header, so only browsers that ask for it pay the cost; everyone else gets WebP.
      </Callout>
    </DocsShell>
  );
}
