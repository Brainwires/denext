# denext plugin example: path aliases

A ~40-line denext **plugin** — the smallest real one, and the first to use the
**route-synthesizer** seam (`@denext/pages-router` uses the request-handler +
build-step seams). See [PLUGINS.md](../../PLUGINS.md) for the full authoring guide.

`aliasesPlugin({ "/home": "/", "/about-us": "/about" })` makes each alias path
render the **same page** as its target — no file moved or duplicated. It works by
post-processing every scanned route manifest and pushing a clone of the target
route under the alias path (`plugin.ts`).

## Run it

```sh
cd examples/plugin-aliases
deno task dev            # http://localhost:3006
```

- <http://localhost:3006/> and <http://localhost:3006/home> render the same page.
- <http://localhost:3006/about> and <http://localhost:3006/about-us> too.

`deno task build` / `deno task start` and `deno task export` (static) all honor the
aliases — the synthesizer runs in every pipeline, and each alias is an ordinary
page route the core renders.

## What it demonstrates

| Seam                  | Used for                                                |
| --------------------- | ------------------------------------------------------- |
| `addRouteSynthesizer` | Injecting the alias routes into every scanned manifest. |
| `addTeardown`         | A shutdown disposer (logs on drain in dev).             |

The plugin is wired in [`denext.config.ts`](./denext.config.ts):

```ts
import { aliasesPlugin } from "./plugin.ts";
export default { plugins: [aliasesPlugin({ "/home": "/", "/about-us": "/about" })] };
```

It's exercised in CI by `tests/plugin-aliases.test.ts` (aliases resolve to the
target's module, the aliased route renders identical HTML, and `resetPlugins()`
clears the synthesizer — no cross-run leak).
