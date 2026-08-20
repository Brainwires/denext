# Resumability demo

A route rendered with `export const resumable = true`: interactive with **no
up-front hydration**. Islands resume on demand — click one counter and only that
island hydrates.

## Run it

```sh
cd examples/resumability
deno task dev          # the CLI prints the local URL (e.g. http://localhost:3000)
# or a production build:
deno task build && deno task start
```

## What to watch

Open the browser **DevTools console**, then:

1. **On load** the console is silent — no counter component has executed. The
   page is already rendered and interactive.
2. **Click one counter.** The count updates (the click is replayed to the
   now-live handler) and the console logs **only that island** resuming. The
   other counters never ran.
3. **The clock** resumes on its own, on idle — it is interactive via
   `useEffect`, so the framework wakes it without a click (no directive needed).
   Its time is a `useSignal`, adopted from the server render.

The components render **identically** on the server and client, so resumption is
invisible and there is no hydration mismatch — the console and the working
buttons are the proof.

## How it works

- `counter.tsx` / `clock.tsx` are plain client components — `useState` +
  `onClick`, `useEffect`. No `qrl`, no `client:*` directive.
- `export const resumable = true` in `app/page.tsx` is the only change from a
  normal app.
- The server carves each island into a foreign `<dnx-island>` the page root
  never executes, and stamps handler hosts with `data-dnx-h`.
- A single delegated listener resumes the touched island synchronously and
  **replays** the event, so the real (closure-capturing) handler fires.
  Effect-only islands are auto-scheduled on idle instead.

`view-source:` the page: the counters are present as HTML with `data-dnx-h`,
wrapped in `<dnx-island …>`, and the resumability runtime is a separate
`lazy-*.js` chunk that a non-resumable app never loads.
