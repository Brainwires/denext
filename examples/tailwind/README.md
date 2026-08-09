# denext + Tailwind example

A minimal [denext](../../) app styled with **Tailwind CSS v4** — no npm, no
PostCSS config. denext downloads and runs the Tailwind standalone binary itself,
compiling `styles/tailwind.css` → `app/globals.css` on `dev`/`build`.

```sh
deno task dev      # → http://localhost:3000  (Tailwind recompiles on change)
deno task build    # compile Tailwind + bundle
deno task start    # serve the production build
```

## What it shows

- **Tailwind, zero-config** — one `@import "tailwindcss";` line in
  `styles/tailwind.css`; wired up in `denext.config.ts`.
- **`/` (home)** — uses `useState`, so it server-renders **and** hydrates into
  an interactive counter.
- **`/about`** — purely static (no hooks, no handlers), so denext ships it as
  **zero-JavaScript** HTML — still fully Tailwind-styled. View source: no
  `<script>` tags.

## Layout

```
denext.config.ts        tailwind: { input, output }
styles/tailwind.css     @import "tailwindcss";
app/layout.tsx          imports ./globals.css (compiled output)
app/page.tsx            interactive (hydrates)
app/about/page.tsx      static (zero JS)
```

`app/globals.css` is generated on build and git-ignored.
