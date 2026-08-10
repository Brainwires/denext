# denext × useTransition

A runnable demo of denext's **cooperative priority scheduler**. Typing filters
8,000 items: the input is an urgent update (stays responsive) while the filtered
list re-renders as a low-priority **transition**, so `isPending` shows and the
browser paints/handles keystrokes before the heavy re-render commits.

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

> denext's scheduling is cooperative — it yields between urgent and transition
> work. It does not interrupt a render _mid-tree_ (that needs a fiber renderer).
> See [`README-NEXT-MIGRATION.md` §10](../../README-NEXT-MIGRATION.md) for the
> details.
