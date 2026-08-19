# denext × concurrent rendering

A runnable demo of denext's **fiber concurrency** — the things the earlier
cooperative scheduler could _not_ do: **time-slicing** and **mid-flight
interruption**.

```sh
deno task example:concurrency          # build once, serve
deno task example:concurrency --dev    # rebuild on each request
```

Open <http://localhost:3003>.

## What to try

Drag the slider — it re-renders a grid of up to 5,000 cells.

- **Concurrent mode (default):** the grid re-renders inside a `useTransition`,
  so the render is **sliced across frames**. The spinner keeps spinning, the FPS
  counter keeps climbing, and the text field stays typable _while the grid
  renders_. The main thread is never blocked for a whole render.
- **Blocking mode (toggle):** the same update runs as a plain `setState`. Now
  each drag blocks the frame until the whole grid re-renders — the spinner
  **freezes** and typing stalls. This is the before/after in one page.

Watch the counter:

```
transition renders started:   N
transition renders committed: M   (interrupted/coalesced N−M)
```

Dragging fast starts many transition renders; only the latest **commits**. The
difference is the work the reconciler discarded by **interrupting** in-flight
renders when a newer value (or an urgent update) arrived — no partial grid is
ever shown, because the next tree is built off-DOM and committed atomically.

## What it exercises

- **Time-slicing** — a transition render yields to the browser (~5 ms budget,
  via `MessageChannel`) between units of work, so rAF/paint/input run between
  slices.
- **Interruption + restart** — a newer slider value abandons the in-flight
  transition and restarts from the committed state.
- **Atomic commit** — the huge grid never appears half-rendered.
- **Lane separation** — the slider, checkbox, and text input are urgent (sync
  lane) and commit immediately; the grid is the transition (low priority).

The spinner, FPS, and started/committed readouts are driven straight from the
`requestAnimationFrame` loop (not React state), so they are an honest probe of
whether the main thread stayed free — not themselves part of the transition.

See [`README-NEXT-MIGRATION.md` §10](../../README-NEXT-MIGRATION.md) for the
full concurrency model, and `examples/transitions` for the classic typeahead
variant.
