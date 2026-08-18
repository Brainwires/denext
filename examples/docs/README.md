# examples/docs — the denext docs site (built in denext)

A small documentation site that is itself a denext app, **static-exported to pure
HTML**. It's dogfooding: every page here is a Server Component with no
interactivity, so the build ships **0 KB of client JavaScript** — the site is the
demo of the claim.

```sh
deno task dev       # http://localhost:3000
deno task export    # → out/  (pure HTML, no client JS)
deno task start     # serve the production build
```

When you run `deno task export`, the console reports:

```
8 static route(s) ship no client JS: /docs/auth, /docs/data, …, /
Exported 8 page(s) to out
```

and `out/_denext/client/` is empty — there is nothing to hydrate. View source on
any exported page and you'll find no `<script>` at all.

## Structure

- `app/layout.tsx` — the site chrome (header, footer, stylesheet).
- `app/page.tsx` — the landing page.
- `app/docs/*/page.tsx` — one Server Component per doc page.
- `components/ui.tsx` — shared, server-only building blocks (`DocsShell`, `Code`,
  `Callout`). No `"use client"` anywhere, which is why the pages stay zero-JS.

Add interactivity to a page (a `"use client"` island) and only that route picks up
a hydration bundle — the rest stay static. That's the default, not a mode.
