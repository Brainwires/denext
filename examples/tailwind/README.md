# denext + Tailwind example

A minimal [denext](../../) app styled with **Tailwind CSS v4** — no npm, no
PostCSS config. denext downloads and runs the Tailwind standalone binary itself,
compiling `styles/tailwind.css` → `app/globals.css` on `dev`/`build`. The first
run downloads the binary, so it needs the network.

From this directory (or `denext task example:tailwind` for `dev`):

```sh
denext task dev      # → http://localhost:3000  (Tailwind recompiles on change)
denext task build    # compile Tailwind + bundle
denext task start    # serve the production build
```

## What it shows

- **Tailwind, zero-config** — one `@import "tailwindcss";` line in
  `styles/tailwind.css`; wired up in `denext.config.ts`.
- **`/` (home)** — a Server Component that renders a `"use client"` counter
  (`app/counter.tsx`): the page server-renders, and only the counter hydrates.
- **`/about`** — purely static (no hooks, no handlers), so denext ships it as
  **zero-JavaScript** HTML — still fully Tailwind-styled. View source: no
  `<script>` tags.

## Layout

```
denext.config.ts        tailwind: { input, output }
styles/tailwind.css     @import "tailwindcss";
app/layout.tsx          imports ./globals.css (compiled output)
app/page.tsx            server-rendered home page
app/counter.tsx         "use client" counter (hydrates)
app/about/page.tsx      static (zero JS)
```

`app/globals.css` is generated on build and git-ignored.
