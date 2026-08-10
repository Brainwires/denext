# next-compat example — real npm React libraries on denext

This app renders the **actual `@radix-ui/react-collapsible` npm package** on
denext's own React — server-rendered, then hydrated. It demonstrates the
`--next-compat` story: real npm React libraries (Radix, shadcn, react-hook-form,
…) run on denext because their `react`/`react-dom`/`react-is` imports are
rewritten to denext at **build time** (esbuild alias — the same mechanism Preact
uses for `preact/compat`), so there is a single React instance.

## Run it

```
deno run -A serve.ts          # build once, serve (production-like)
deno run -A serve.ts --dev    # rebuild on each request
```

Open <http://localhost:3000> and click **Toggle details** — the open/close is
real Radix Collapsible behavior, hydrated by denext.

## How it works

- `app/page.tsx` is a plain React component (default export) that imports the
  real npm Radix package.
- `serve.ts` calls `buildNextCompatPages()` (from `@denext/denext`'s build
  layer):
  - **prebuilds** denext's runtime once (one shared React/reconciler),
  - bundles the page into a **server** (SSR) and **client** (hydration) bundle,
    rewriting every `react*` import — including those _inside_ the npm package —
    to the one denext runtime.
- `renderNextCompatPage()` produces the SSR HTML document + the hydration
  script.

The client bundle contains **no npm React** — only denext's ~8 KB runtime plus
the Radix component code.

> This example imports denext's build layer by relative path because it lives in
> the denext repo. In a real project you'd use the published package.
