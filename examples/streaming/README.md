# streaming — denext Suspense & streaming SSR

Demonstrates asynchronous rendering three ways: async Server Components inside
Suspense, a `loading.tsx` route fallback, and true out-of-order streaming SSR.

## What it shows

- **Async Server Components + `<Suspense>`** (`/dashboard`) — two widgets each
  `await` their own data source at different latencies, each in its own Suspense
  boundary, resolved in parallel on the server.
- **`loading.tsx`** (`/dashboard/loading.tsx`) — the route-level Suspense
  fallback shown during a client navigation to the route.
- **Streaming SSR** (`/stream`) — a route handler using
  `renderToReadableStream`: the shell (including each Suspense fallback) is
  flushed in the first chunk, then each boundary is streamed in via a
  `<template>` + swap script as its data resolves (out-of-order reveal).

## Buffered pages vs streamed responses

denext renders **pages buffered**: the page path awaits every Suspense boundary
and delivers complete HTML, so `/dashboard`'s markup already contains the
resolved widgets (great for SEO and a flash-free first paint). When you
specifically want progressive, out-of-order delivery, use
`renderToReadableStream` from a route handler — that's what `/stream` does.
(Streaming responses don't carry a framework-generated CSP; set one at the edge
if you need it for those routes.)

## Run

```sh
# from this directory
deno task dev             # http://localhost:3000
deno task build && deno task start
```
