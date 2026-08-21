# fonts — self-hosted Google fonts (`next/font/google`)

A one-page app that loads a Google font through the `next/font/google` compat
module and **self-hosts it at build time** — no runtime request to Google.

## What it shows

- **`next/font/google`** (`app/layout.tsx`) —
  `Inter({ subsets, weight, variable })` returns `className` / `style` you apply
  to a wrapper; the font also exposes a CSS variable (`--font-inter`).
- **Build-time self-hosting** — `denext build` downloads the font's `@font-face`
  CSS + woff2 files and serves them from `/_denext/fonts`, so the browser never
  hits Google. (In `dev`, or if the build can't reach Google, it falls back to a
  runtime `<link>`.)
- **Zero client JS** (`app/page.tsx`) — the page is static; the only thing it
  demonstrates is the font CSS the layout emits into `<head>`.

## Run

```sh
# from this directory
deno task dev             # http://localhost:3000  (runtime <link> fallback)
deno task build && deno task start   # fonts self-hosted from /_denext/fonts
```

To confirm self-hosting, run the production build and check that the page's font
CSS points at `/_denext/fonts/…`, not `fonts.googleapis.com`.
