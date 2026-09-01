# denext + htmx example

An [htmx](https://htmx.org) app on denext via
[`@denext/htmx`](../../packages/htmx). The home page uses only `hx-*`
attributes, so denext classifies it static and ships **0 KB of denext client
JS** — htmx (served from this origin by the plugin) does all the interactivity.

## Run

```sh
deno task dev      # http://localhost:8000
deno task build    # static/prod build (emits the runtime into the output)
deno task start    # serve the build
```

## What it shows

- `denext.config.ts` — the whole setup: `plugins: [htmx()]`.
- `app/layout.tsx` — `<Htmx/>` loads the vendored runtime from `'self'`.
- `app/page.tsx` — raw `hx-*` attributes and the typed `hx({...})` helper.
- `app/clicked/route.ts` — a fragment endpoint via `htmlResponse(...)`.
- `app/search/route.ts` — active search returning an HTML fragment, reusing the
  page's `SearchResults` component.

## CLI

```sh
deno run -A ../../cli.ts htmx info    # print the vendored htmx version + runtime URL
```
