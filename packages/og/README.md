# @denext/og

A Deno-native **`ImageResponse`** — denext's first-party, zero-npm replacement for
the `@cf-wasm/og` peer codec its `next/og` implementation used to lazily import. It
renders JSX-shaped elements to **PNG** (or SVG) for `opengraph-image` /
`ImageResponse` routes.

It vendors the full **[satori](https://github.com/vercel/satori)** (flexbox layout →
SVG, via **yoga**) + **[resvg](https://github.com/thx/resvg-js)** (SVG → PNG) stack as
a single self-contained bundle, generated with esbuild from
[`@cf-wasm/og`](https://github.com/fineshopdesign/cf-wasm)'s `node` entry — whose
`yoga.wasm`, `resvg.wasm` and default **Noto Sans** font are all inlined as base64. So
rendering plain-Latin text needs **zero npm dependencies and no runtime permissions**.

```ts
import { ImageResponse } from "@denext/og";

const res = new ImageResponse(
  {
    type: "div",
    props: {
      style: {
        display: "flex",
        width: "100%",
        height: "100%",
        alignItems: "center",
        justifyContent: "center",
        background: "#0b1020",
        color: "white",
        fontSize: 64,
      },
      children: "Hello denext",
    },
  },
  { width: 1200, height: 630 },
);
// res is a Response subclass — res.arrayBuffer() yields the PNG bytes.
```

`element` is a **satori element** (`{ type, props: { style, children } }`); denext's
`ImageResponse` produces it from your JSX. Only satori's layout subset is supported
(flexbox + inline `style`; no `className`/CSS).

## Permissions & fonts

The bundled **Noto Sans** covers Latin, and rendering it is fully offline (no FS/net).
Characters outside it — emoji, CJK, other scripts — trigger satori's **dynamic asset
loading**, which fetches fonts/emoji from Google at render time (needs `--allow-net`)
and degrades to a fallback glyph offline. This matches upstream `@cf-wasm/og` exactly.
To stay fully offline for non-Latin text, pass your own `fonts: [new CustomFont(...)]`.

It is a **server-only** codec and is never shipped to the browser.

## Versioning

`@denext/og` uses **independent semver** (starting at 0.1.0). The wrapped upstream
versions are recorded here and in the CHANGELOG, not encoded in the package version:

| `@denext/og` | vendored from                                                          |
| ------------ | ---------------------------------------------------------------------- |
| 0.1.0        | `@cf-wasm/og@0.5.0` (satori@0.29.0 · resvg-wasm@2.4.1 · Noto Sans v27) |

## Vendoring / updating the bundle

The publishable artifact is the committed `lib/og.bundle.js`. It is **generated, not
hand-edited**. To reproduce or refresh it against newer upstreams:

```sh
# 1. install the target versions into a scratch dir
npm install @cf-wasm/og@0.5.0 esbuild@0.24

# 2. bundle @cf-wasm/og's `node` entry (wasm + font inline) into one browser-target ESM.
#    - platform=browser: resolve satori's deps' browser/module fields (they're not node CJS)
#    - define process.env: satori aliases `process.env` then reads a key, which would
#      otherwise trip Deno's env permission; replacing it with a literal avoids any env read.
echo 'export * from "@cf-wasm/og/node";' > entry.mjs
npx esbuild entry.mjs --bundle --format=esm --platform=browser \
  '--define:process.env={"NODE_ENV":"production"}' \
  --outfile=lib/og.bundle.js
```

Then bump this package's version, update the table above + CHANGELOG, refresh
`THIRD-PARTY-LICENSES.md` if the dependency set changed, and re-publish.

## License

The `@denext/og` wrapper (`mod.ts`) is **MIT** (see `LICENSE`). The vendored
`lib/og.bundle.js` bundles third-party code under **MIT**, **MPL-2.0**, **ISC**, and
the **SIL Open Font License 1.1** (Noto Sans) — see `THIRD-PARTY-LICENSES.md` for the
full inventory, license texts, and MPL-2.0 source pointers.
