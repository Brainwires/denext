# image — denext image optimization

Demonstrates the `<Image>` component (next/image ergonomics) driving denext's
built-in image optimizer at `/_denext/image`, plus a dynamic Open Graph image.

## What it shows

- **`<Image loader={denextImageLoader} …>`** — routes the source through
  `/_denext/image?url=…&w=…&q=…`, which resizes and re-encodes it to **WebP**.
- **Responsive `srcSet`** — a `widths={[…]}` list becomes a `srcset` of resized
  candidates the browser picks from.
- **`priority`** — eager-loads an above-the-fold image (skips lazy loading, sets
  `fetchpriority="high"`).
- **`placeholder="blur"`** — paints a `blurDataURL` behind the image until it
  loads.
- **No-loader `<Image>`** — a plain, layout-stable `<img>` (lazy +
  async-decoded) when you don't want optimization.
- **`opengraph-image.tsx`** — an `ImageResponse` (JSX → PNG via `@cf-wasm/og`)
  served at `/opengraph-image` and auto-wired into `og:image`.

## The width allowlist (a DoS defense)

`/_denext/image` only honors `w=` values drawn from
`images.deviceSizes ∪ images.imageSizes` (see `denext.config.ts`); any other
width is refused with `400`. Without this, an attacker could request thousands
of arbitrary widths, each forcing a fresh WASM decode/resize.

## Remote images

Remote sources must be allowlisted under `images.remotePatterns` in
`denext.config.ts` before the optimizer will fetch them — the SSRF defense for
the endpoint. `denext.config.ts` allowlists a couple of example hosts.

## Run

```sh
# from this directory
deno task dev      # http://localhost:3000
deno task build && deno task start
```

The source image is `public/photo.png`.
