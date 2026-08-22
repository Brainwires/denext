# SPA example (`mode: "spa"`)

A **client-only React SPA** on denext — "React but **not** Next." There is no
`app/` directory: denext bundles a single entry (`src/main.tsx`), wraps it in an
HTML shell, and serves that shell for every navigation (history-API fallback).
The app owns its own routing and state; denext just provides the bundler, the
CSS pipeline, the dev server, and native packaging.

This is the on-ramp for hosting an existing Vite-style React SPA on denext's
toolchain and runtime without restructuring it into the App Router.

## Run it

```
deno task dev      # dev server + live reload
deno task build    # production build → .denext/
deno task start    # serve the production build
deno task export   # static export → out/  (what deno desktop packages)
```

Open http://localhost:3000. Toggle **Home/About** (a tiny client-owned
hashchange router) and click the counter — all client state, denext never
touches it.

## How it's wired

```ts
// denext.config.ts
export default {
  mode: "spa",
  spa: { entry: "./src/main.tsx", title: "denext SPA example" },
} satisfies DenextConfig;
```

- `src/main.tsx` mounts the app itself — a plain
  `createRoot(...).render(<App/>)`, exactly like a Vite entry. denext stays out
  of the mount, so you bring your own router (TanStack, etc.), store, and data
  layer.
- `src/styles.css` is a normal CSS import: denext's CSS pipeline runs in SPA
  mode too and serves it as one `<link>`ed stylesheet.
- No `app/`, no SSR, no Flight — just one bundle + a shell + history-API
  fallback.

## Package as a desktop app

The `out/` from `deno task export` is a static app any host can serve — and it's
byte-compatible with what [`deno desktop`](../native) wraps in a native window:

```
deno task export
deno desktop desktop.ts     # a `Deno.serve` over out/ (see examples/native)
```

## Bundle size vs React

Because denext ships its **own** small React-equivalent instead of React +
ReactDOM, the client download is a fraction of the size. Benchmarked on **this
example's app**, the same code bundled with the same bundler (`deno bundle`,
minified), gzipped:

| Client JS                    |     raw |    gzip |
| ---------------------------- | ------: | ------: |
| **denext** (own React-equiv) | 38.6 KB | 13.3 KB |
| React 19 + ReactDOM 19       |  190 KB | 60.1 KB |
| **denext is smaller by**     |    4.9× |    4.5× |

Reproduce it yourself:

```
deno run -A bench.ts
```

> React Compiler doesn't change this: it's a **re-render** optimization (a build
> pass that adds memoization + a small `react/compiler-runtime`), so it doesn't
> shrink the bundle — the size difference is a runtime story, not a compiler
> one. The ratio grows on larger apps, where React's fixed runtime is a smaller
> share and denext's per-component overhead stays low (see the repo's `bench/`).
