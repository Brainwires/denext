# denext × useTransition

A runnable demo of denext's **fiber concurrency** on the classic typeahead.
Typing filters 8,000 items: the input is an urgent update (stays responsive)
while the filtered list re-renders as a low-priority **transition** —
time-sliced and interruptible — so `isPending` shows and the browser
paints/handles keystrokes before the heavy re-render commits.

```sh
deno task example:transitions          # build once, serve
deno task example:transitions --dev    # rebuild on each request
```

Open <http://localhost:3002> and type quickly in the filter box.

## What it exercises

- `useTransition` — `startTransition(() => setQuery(v))` deprioritizes the list
  re-render; `isPending` stays true across the yield.
- The urgent `setInput(v)` commits first (responsive field), the transition
  commits on a later macrotask.

> denext renders on a fiber reconciler: transition renders are time-sliced and
> can be interrupted mid-tree by an urgent update, then restarted. For a demo
> that makes the time-slicing and interruption directly visible (a spinner that
> keeps moving while a huge grid re-renders, plus a started/committed counter),
> see `examples/concurrency`. Full model:
> [`README-NEXT-MIGRATION.md` §10](../../README-NEXT-MIGRATION.md).
