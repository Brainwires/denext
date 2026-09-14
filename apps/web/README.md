# apps/web — the denext docs site (built in denext)

A small documentation site that is itself a denext app, **static-exported to
pure HTML**. It's dogfooding: every docs page is a Server Component with no
interactivity, so those routes ship **0 KB of client JavaScript** — the site is
the demo of the claim. The one exception is `/search`, whose results list is a
`"use client"` island, so only that route picks up a hydration bundle.

```sh
deno task dev           # http://localhost:3000
deno task export        # → out/  (pure HTML; client JS only under /search)
deno task search-index  # out/search-index.json from the exported HTML (+ public/ for dev)
deno task start         # serve the production build
```

When you run `deno task export`, the console reports each route it wrote and
finishes with the total (most of them are the generated `/docs/api/**` reference
pages):

```
  /docs/testing -> docs/testing/index.html
  /docs/typed-api -> docs/typed-api/index.html
  /search -> search/index.html
  / -> index.html

  Exported 1005 page(s) to out
```

1004 of those 1005 pages ship no client JS — view source on any docs page: no
`<script>` at all (the landing page's one `<script>` is JSON-LD structured data,
not code). `/search` is the single route with a bundle — its island fetches
`search-index.json` and ranks it in the browser.

## Structure

- `app/layout.tsx` — the site chrome (header, footer, stylesheet).
- `app/page.tsx` — the landing page.
- `app/docs/*/page.tsx` — one Server Component per doc page.
- `components/ui.tsx` — shared, server-only building blocks (`DocsShell`,
  `Code`, `Callout`). No `"use client"` anywhere, which is why the pages stay
  zero-JS.
- `components/search.tsx` — the header search **form** (plain HTML, 0 JS: Enter
  submits to `/search?q=`; on narrow screens a magnifier button takes over the
  header via CSS `:has()` while the field is focused).
- `app/search/` — the results page: `results.tsx` is the `"use client"` island;
  `scripts/search-index.ts` builds its index from the exported HTML (one entry
  per guide section and per API symbol).

Add interactivity to a page (a `"use client"` island) and only that route picks
up a hydration bundle — the rest stay static. That's the default, not a mode.
