import { Callout, Code, DocsShell } from "../../../components/ui.tsx";

export const metadata = {
  title: "Images",
  description:
    "An optimizing Image component with a built-in, self-hosted optimization endpoint — modern formats, correct sizing, no external service.",
};

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
        optimizer, which decodes the source and re-encodes it to a modern raster format (WebP by
        default; AVIF too when <code>images.formats</code> lists <code>"image/avif"</code>{" "}
        and the browser advertises it) at the requested width.
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

      <h2>Priority images (LCP)</h2>
      <p>
        Mark your largest above-the-fold image{" "}
        <code>priority</code>. It loads eagerly (no lazy loading), gets{" "}
        <code>fetchpriority="high"</code>, and — during SSR — denext emits a{" "}
        <code>&lt;link rel="preload" as="image"&gt;</code> into the head (carrying the responsive
        {" "}
        <code>imagesrcset</code>) so the browser starts the Largest Contentful Paint fetch before it
        even reaches the{" "}
        <code>{"<img>"}</code>. Use it on one image per view — the hero, not every thumbnail.
      </p>
      <Code lang="tsx">
        {`<Image src="/hero.jpg" width={1600} height={900} sizes="100vw" alt="Hero" priority />`}
      </Code>

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
        AVIF encoding is heavier than WebP, so it is opt-in (<code>images.formats</code>). Once
        enabled it's negotiated per-request from the <code>Accept</code>{" "}
        header, so only browsers that ask for it pay the cost; everyone else gets WebP.
      </Callout>
    </DocsShell>
  );
}
