// <Image> demos. Passing `loader={denextImageLoader}` routes every source through
// denext's built-in optimizer at `/_denext/image?url=…&w=…&q=…`, which resizes and
// re-encodes the image to WebP on the fly. A `widths` list turns into a responsive
// `srcSet`; `priority` opts an above-the-fold image out of lazy loading; and
// `placeholder="blur"` paints `blurDataURL` behind the image until it loads.

import { denextImageLoader, Image } from "denext";

// A 1x1 blurred placeholder (base64) shown until the real image decodes.
const BLUR = "data:image/gif;base64,R0lGODlhAQABAPAAAMzMzwAAACH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==";

export default function ImageDemo() {
  return (
    <section>
      <h1>Image optimization</h1>
      <p class="lede">
        Each image below is served through{" "}
        <code>/_denext/image</code>, which resizes the source and re-encodes it to WebP. View source
        on any <code>&lt;img&gt;</code> to see the generated <code>srcset</code>.
      </p>

      <Figures />

      <p class="note">
        Remote sources (e.g. an Unsplash URL) work too, but must be allowlisted in{" "}
        <code>denext.config.ts</code> under <code>images.remotePatterns</code>{" "}
        — the SSRF defense for the optimizer.
      </p>
    </section>
  );
}

/** The three `<Image>` variants: optimized + priority, optimized + blur, and plain. */
function Figures() {
  return (
    <div class="grid">
      <figure>
        <Image
          loader={denextImageLoader}
          src="/photo.png"
          alt="A cat, optimized and served as WebP"
          width={256}
          height={251}
          widths={[128, 256, 384]}
          quality={80}
          priority
        />
        <figcaption>
          <strong>priority + responsive srcSet</strong>
          <br />
          eager load, <code>widths={"{[128, 256, 384]}"}</code>, q=80
        </figcaption>
      </figure>

      <figure>
        <Image
          loader={denextImageLoader}
          src="/photo.png"
          alt="The same cat with a blurred placeholder while loading"
          width={256}
          height={251}
          widths={[128, 256]}
          placeholder="blur"
          blurDataURL={BLUR}
        />
        <figcaption>
          <strong>lazy + blur placeholder</strong>
          <br />
          deferred load behind a <code>blurDataURL</code>
        </figcaption>
      </figure>

      <figure>
        {/* No loader → a plain, layout-stable <img> (no optimization). */}
        <Image
          src="/photo.png"
          alt="An unoptimized img with explicit dimensions"
          width={256}
          height={251}
        />
        <figcaption>
          <strong>no loader</strong>
          <br />
          plain <code>&lt;img&gt;</code>, lazy + async-decoded
        </figcaption>
      </figure>
    </div>
  );
}
