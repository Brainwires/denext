---
title: Fonts
slug: fonts
lead: Self-hosted fonts with no runtime request: denext's localFont, and the next/font/google and next/font/local compat with Next's metric-matched fallback faces.
---

denext has two font layers. `localFont` from `denext` is the native helper for
font files you already serve. The `next/font/google` and `next/font/local`
compat modules are Next's API, including the metric-matched fallback face that
keeps a font swap from shifting your layout.

## `localFont` — the native helper

`localFont({ family, src, display, weight, style, fallback })` builds the
`@font-face` CSS for a self-hosted file and returns
`{ fontFamily, style, css }`: `style` spreads onto an element, and the CSS
reaches the page when you render the font once through the `FontFace`
component, which emits a `<style>` tag. `src` is one URL or an array of
`{ url, weight, style }` sources; the `format()` hint is inferred from the file
extension, and `display` defaults to `swap`. Nothing is fetched — the file is
served by your app.

```tsx
import { FontFace, localFont } from "denext";

const inter = localFont({ family: "Inter", src: "/fonts/inter.woff2", fallback: ["system-ui"] });
// <head><FontFace font={inter} /></head>
// <body style={inter.style}>…</body>
```

## `next/font/google`, self-hosted at build time

`denext/next/font/google` exports a loader per popular family (plus a generic
`googleFont(family, options)`), taking Next's `weight`, `style`, `subsets`,
`display`, `variable`, `fallback`, `preload` and `adjustFontFallback`. Each
loader returns `{ className, style, variable }`. At build, denext executes your
page and layout modules to find the fonts they declare, downloads each
`@font-face` stylesheet plus its font files into `/_denext/fonts` under
hash-named filenames, keeps only the requested `subsets`, and rewrites
`src: url()` to those local paths. The server then inlines that CSS — the
browser never requests Google.

```tsx
import { Inter } from "denext/next/font/google";

const inter = Inter({ subsets: ["latin"], weight: ["400", "700"], variable: "--font-inter" });
// <body className={inter.className}>…</body>
```

> Self-hosting is best-effort: a font that can't be fetched at build time
> (offline or air-gapped CI) is skipped with a warning and falls back to a
> runtime `<link>` rather than failing the build.

## Metric-matched fallback faces

`adjustFontFallback` defaults to `true`, as in Next. Every Google font also
declares a `"<Family> Fallback"` face — `src: local("Arial")` or
`local("Times New Roman")`, chosen by the family's category — re-proportioned
with `size-adjust`, `ascent-override`, `descent-override` and
`line-gap-override`. The numbers come from a bundled table of real metrics
(Capsize's set, the one Next ships) run through Next's own
`calculateSizeAdjustValues`, so text laid out before the web font arrives takes
the same space: no font-swap layout shift, and a migrated app gets identical
overrides. The face is spliced in right after the web font. Pass `false` for a
plain stack.

```ts
const inter = Inter({ subsets: ["latin"] });
// font-family: 'Inter', 'Inter Fallback', sans-serif
```

Regenerate the metrics table with `deno task gen:font-metrics`.

## `next/font/local` and its one gap

`denext/next/font/local`'s default export takes `src` (a path, one source, or
several), `weight`, `style`, `display`, `variable`, `fallback` and `preload`,
and returns the same `{ className, style, variable }` handle. It is fully
synchronous — no network, no npm — because the font files are served statically
by your app.

```ts
import localFont from "denext/next/font/local";

const brand = localFont({ src: "/fonts/brand.woff2", variable: "--font-brand" });
```

> **`next/font/local`: no metric-matched fallback face.** A local font's metrics
> live in its file, which denext does not parse, so
> `localFont({ adjustFontFallback: "Arial" })` type-checks and keeps a stable
> class name but emits no fallback face — the stack falls straight through to
> your `fallback` list. See [Known limitations](/docs/limitations).

## Fonts in a migrated app

`denext migrate` writes an exact import-map entry for every `next/*` subpath
denext ships, `next/font/google` and `next/font/local` included, so a migrated
app's imports resolve unchanged; `--codemod` rewrites them to
`denext/next/font/google` and `denext/next/font/local`. Next exports a loader
for every family in its catalogue while denext's module hand-writes a curated
subset, so the compat bundler swaps the specifier for a virtual module that
defines a loader for every catalogued family on top — an import like
`Noto_Sans_Hebrew` keeps working, and the unused loaders are tree-shaken away.
See [Migrating from Next.js](/docs/migrating).

## `@denext/og` fonts

Dynamic OG images are a separate path: `@denext/og` fetches a missing non-Latin
font from `fonts.googleapis.com` at render time unless you supply a local
`fonts` option or set `offline: true` on the `ImageResponse` — see
[Known differences](/docs/differences) and [Metadata & SEO](/docs/metadata).
