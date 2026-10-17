# Lustre (Gleam) in a denext app

One Lustre counter, written in Gleam (`gleam/src/counter.gleam`), used three ways on one page:

- **an island** (`lustreIsland`, [`app/counter-island.tsx`](./app/counter-island.tsx)): the server
  renders the counter's first view, and the browser's Lustre adopts that markup and runs it;
- **a custom element** (`lustreElement`, [`app/counter-element.tsx`](./app/counter-element.tsx)):
  `<lustre-counter>`, its shadow root prerendered as Declarative Shadow DOM and adopted by Lustre
  once the element registers;
- **a server component** (`defineLustreView`, [`app/counter-view.ts`](./app/counter-view.ts)): the
  model lives on the server, and Lustre's patches travel over denext's Live socket.

The `gleam()` plugin in [`denext.config.ts`](./denext.config.ts) compiles `gleam/` at dev startup,
on every `.gleam` change and at build, with denext's pinned Gleam (downloaded on first use), and
writes the `.denext/lustre*.ts` modules the app imports. Lustre comes from Hex, so the first build
needs the network.

```sh
deno task dev     # or: deno task build && deno task start
```

The [Gleam guide](https://denext.dev/docs/gleam#lustre) explains each helper.
