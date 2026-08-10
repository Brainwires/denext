# next-compat: real `recharts` on denext (class components)

This example runs the actual [`recharts`](https://recharts.org) npm package — a
charting library built on React **class components** — on denext's single React,
server-rendered to SVG and hydrated on the client.

It is the real-world exercise of denext's **gated class-component runtime**: recharts
does not work without `classComponents: true`, and with it the chart renders end to
end (axes, grid, line, tooltip).

## Run

From the denext repo **root**:

```sh
deno task example:next-compat-recharts          # build once, serve (prod-like)
deno task example:next-compat-recharts --dev    # rebuild on each request
```

Then open <http://localhost:3001> and hover a data point for the tooltip.

## What it exercises

- `classComponents: true` threaded through `buildNextCompatPages` → the esbuild
  `define` gate compiles in denext's class runtime (lifecycle, `setState` batching,
  `getDerivedStateFromProps`, refs). With the flag off, recharts' class components
  would throw a guided error instead.
- React-compat details real libraries depend on: `defaultProps` resolution (recharts'
  `XAxis.xAxisId = 0`), `React.createRef`, and arbitrarily-nested children arrays
  (recharts' `renderByOrder`), all handled by denext's runtime.
- Real npm React resolution: `recharts` and its transitive deps resolve their
  `import "react"` to denext at bundle time (esbuild alias), on a single React
  instance across SSR + client.

> `recharts` 2.x is used here (its 3.x line drops some class components). It is a
> demo/test dependency of this example only — not a denext runtime dependency.
