# Islands demo — the six `client:*` hydration directives

Each card on the page is the **same** `"use client"` component, carved out with a
different directive. denext hydrates each island on its own schedule instead of all
at once — full 6/6 Astro directive parity, plus resumability Astro lacks.

## Run it

```sh
cd examples/islands
deno task dev          # the CLI prints the local URL (e.g. http://localhost:3000)
# or a production build:
deno task build && deno task start
```

## The directives

| Directive                           | Hydrates when…                                         |
| ----------------------------------- | ------------------------------------------------------ |
| `client:load`                       | Immediately, but per-island.                           |
| `client:idle`                       | The main thread is idle (`requestIdleCallback`).       |
| `client:visible`                    | The island scrolls into view (`IntersectionObserver`). |
| `client:interaction`                | The first interaction inside it (the event replays).   |
| `client:media="(min-width: 600px)"` | A CSS media query matches (`matchMedia`).              |
| `client:only`                       | On the client only — **no SSR** (no first paint).      |

## What to watch

Open the **DevTools console**, then:

1. **On load** only `client:load` and `client:only` have logged. `client:only` had
   no server HTML — it appears only after its client-only mount.
2. **Idle** wakes `client:idle` without any interaction.
3. **Scroll down** to reveal the `client:visible` card — it hydrates the moment it
   enters the viewport, not before.
4. **Click** the `client:interaction` card — it hydrates on the first interaction and
   the triggering click is replayed to the now-live handler (the counter reaches 1).
5. A usage-site directive overrides a module's own `export const hydrate = "…"`
   default. Precedence: usage-site `client:*` > module default > eager.

Each island logs `island:<label> hydrated` exactly once, on its own schedule — proof
that hydration is per-island, not the whole page at once.
