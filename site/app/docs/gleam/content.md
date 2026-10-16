---
title: Gleam
slug: gleam
lead: Gleam compiles to JavaScript with TypeScript declarations, so a Gleam package — from Hex or your own — imports into a denext app typed. denext add gleam:<package> sets it up, and the optional gleam() plugin recompiles your Gleam code at dev and build.
---

[Gleam](https://gleam.run)'s JavaScript target writes ES modules
(`build/dev/javascript/<package>/<module>.mjs`) and, with
`typescript_declarations = true`, a `.d.mts` beside each one that the module
names in a `/// <reference types>` directive. Deno reads that directive, so a
Gleam module imported by path is typed from Gleam's own types. denext maps the
build under one import prefix, `@gleam/`:

```ts
// app/page.tsx (or any server or client module)
import { greet } from "@gleam/app/app.mjs";
import { List, Ok } from "@gleam/app/gleam.mjs"; // Gleam's List, Result, …

export default function Page() {
  return <p>{greet("denext")}</p>; // greet(name: string): string
}
```

## Adding a Gleam package

```sh
denext add gleam:gleam_json
```

`denext add gleam:<package>` (several at once, and mixed with `jsr:` / `npm:`
specifiers) needs nothing installed: it runs denext's pinned Gleam compiler (see
[The compiler](#the-compiler)). It:

1. creates a Gleam project in `gleam/` when the app has none (a `gleam.toml`
   with `target = "javascript"` and `typescript_declarations = true`; a
   `gleam.toml` at the app root is used as it is);
2. runs `gleam add <package>` there and compiles it with
   `gleam build --target javascript`;
3. maps `"@gleam/": "./gleam/build/dev/javascript/"` in `deno.json` and adds
   `gleam/build/` to `.gitignore`.

Import the package's modules as `@gleam/<package>/<module>.mjs`, and your own
Gleam modules (under `gleam/src/`) as `@gleam/<name>/<module>.mjs`, where
`<name>` is the `name` in `gleam.toml`.

## Compiling at dev and build: `gleam()`

The plugin is optional — without it, run `gleam build --target javascript`
yourself. With it, denext compiles the project at `denext dev` startup, again
whenever a `.gleam` file or `gleam.toml` changes, and at `denext build` /
`export`:

```ts
// denext.config.ts
import { gleam } from "denext/gleam";

export default {
  plugins: [gleam()], // or gleam({ dir: "gleam", gleam: "/opt/gleam/bin/gleam" })
};
```

An app with no Gleam project is left alone. A compile error fails the step and
prints Gleam's diagnostics. When no compiler can be had (offline before the
first download, below), the step fails with an error naming the fix, unless the
project already has compiled output: then the plugin keeps it and says why once.

## The compiler

denext manages Gleam like its [Deno toolchain](/docs/toolchain): each denext
release pins one Gleam release (1.18.1 today) with a SHA-256 per platform, and
the first command that needs it — `denext add gleam:`, or the plugin at
`denext dev` / `build` — downloads it into the toolchain cache:

```text
<DENO_DIR>/denext-deno/gleam/<version>/<platform>/gleam      (gleam.exe on Windows)
```

The pinned platforms are macOS (arm64, x64), Linux (arm64, x64; Gleam's static
musl builds, which run on any distribution) and Windows (arm64, x64). The
download is checked against its pinned SHA-256 before it is extracted, a
mismatch is refused and deleted, and the binary is renamed into place atomically
under the same cache lock as the Deno toolchain, so two commands starting at
once download it once. Gleam's JavaScript target needs no Erlang: this one
binary is all a denext app uses.

To work offline, fetch it ahead of time:

```sh
denext toolchain install --with gleam
denext toolchain status     # lists the pinned Gleam and whether it is cached
```

| Setting                      | Effect                                                   |
| ---------------------------- | -------------------------------------------------------- |
| `DENEXT_GLEAM=<path>`        | That `gleam` runs instead of the pinned one, unverified. |
| `gleam({ gleam: "<path>" })` | The same, for the plugin only.                           |

A `gleam` on your `PATH` is never used on its own: its version would decide what
the compiled JavaScript looks like, so a project builds the same on every
machine with the pinned one. To use your own anyway, name it
(`DENEXT_GLEAM=$(which gleam)`, or `gleam({ gleam: "gleam" })`).

## One fix-up after each build

Gleam writes `prelude.mjs` and each package's `gleam.mjs` without the
`/// <reference types>` directive its other modules carry. Deno would then infer
those two from their JavaScript, leaving `List` and `Result` untyped and the
package's declarations colliding with themselves (`TS2308`). Both the plugin and
`denext add gleam:` add the directive after every build (idempotently); if you
compile by hand, run the plugin or add the line yourself:

```js
/// <reference types="./prelude.d.mts" />
```

## Without the import prefix

The prefix is a plain import-map entry; nothing else depends on it. A project
that keeps its Gleam code elsewhere maps its own build directory:

```json
{ "imports": { "@gleam/": "./frontend/build/dev/javascript/" } }
```

## Lustre

[Lustre](https://hexdocs.pm/lustre/) is Gleam's UI framework (the Elm
architecture: `init`, `update`, `view`). denext runs a Lustre app three ways,
from the same Gleam code:

| Helper (`denext/gleam`) | What runs where                                                                              |
| ----------------------- | -------------------------------------------------------------------------------------------- |
| `lustreIsland`          | An island: the server renders the first view, Lustre runs it in the browser.                 |
| `lustreElement`         | A custom element (`lustre.register`), its shadow root prerendered as Declarative Shadow DOM. |
| `defineLustreView`      | A server component: the model lives on the server, DOM patches travel over Live.             |

```sh
denext add gleam:lustre
```

When the Gleam project depends on Lustre, every Gleam build (the `gleam()`
plugin, `denext add gleam:`) also writes three modules into `.denext/`, each
importing what denext needs from **your app's own Lustre build** (through
`@gleam/`, so your code and denext share one copy of Lustre):

| Module                     | Exports        | Used by                                                       |
| -------------------------- | -------------- | ------------------------------------------------------------- |
| `.denext/lustre.ts`        | `lustre`       | `lustreIsland`, `lustreElement`                               |
| `.denext/lustre-server.ts` | `lustreServer` | `defineLustreView`                                            |
| `.denext/lustre-view.ts`   | `LustreView`   | `defineLustreView`'s browser island (a `"use client"` module) |

Run the `gleam()` plugin so they stay current. The examples below use this
Gleam module (`gleam/src/counter.gleam`):

```gleam
pub fn app() -> lustre.App(Int, Model, Msg) {
  lustre.simple(init, update, view) // flags: the starting count
}

pub fn component() -> lustre.App(Nil, Model, Msg) {
  lustre.component(init, update, view, [
    component.on_attribute_change("start", fn(v) { int.parse(v) |> result.map(SetCount) }),
  ])
}
```

### An island: `lustreIsland`

```ts
// app/counter-island.tsx
"use client";
import { lustreIsland } from "denext/gleam";
import { lustre } from "../.denext/lustre.ts";
import * as counter from "@gleam/app/counter.mjs";

export const CounterIsland = lustreIsland(lustre, counter.app(), {
  flags: (props: { start: number }) => props.start, // typed from Gleam's .d.mts
});
// app/page.tsx: <CounterIsland start={3} client:visible />
```

The server renders the app's first view (`element.to_string` of
`view(init(flags))`) inside the island's root. In the browser Lustre starts on
that root and **adopts** the markup: it builds its first virtual DOM from the
nodes already there, so the server's nodes, the focus and anything typed before
the island booted are kept. Every `client:*` directive applies. From then on
Lustre owns the root's contents (denext never re-renders them); the root gets a
`lustre:mount` event when Lustre takes over. New props become new flags and
restart the app in the same root. Unmounting clears the root.

### A custom element: `lustreElement`

```ts
// app/counter-element.tsx
"use client";
import { lustreElement, type LustreElementAttributes } from "denext/gleam";
import { lustre } from "../.denext/lustre.ts";
import * as counter from "@gleam/app/counter.mjs";

export const CounterElement = lustreElement<{ start: string }>(
  lustre,
  "lustre-counter",
  counter.component(),
);

// Type the bare tag too, for <lustre-counter start="2" /> anywhere it is registered:
declare module "denext/jsx-runtime" {
  namespace JSX {
    interface IntrinsicElements {
      "lustre-counter": LustreElementAttributes<{ start: string }>;
    }
  }
}
```

`<CounterElement start="5" />` renders `<lustre-counter start="5">` with its
shadow root prerendered by Lustre's `component.prerender` as Declarative Shadow
DOM (`<template shadowrootmode>`, the attributes applied through the
component's attribute decoders), so the first paint is the component's view. The
browser registers the element lazily, once per tag, from the island's own chunk;
Lustre then adopts the declarative shadow root. Props are the element's
attributes, so a changed prop reaches the running component.

### A server component: `defineLustreView`

```ts
// app/counter-view.ts (a server module)
import { defineLustreView } from "denext/gleam";
import { auth } from "denext/server";
import { lustreServer } from "../.denext/lustre-server.ts";
import * as counter from "@gleam/app/counter.mjs";

export const CounterView = defineLustreView({
  id: "counter",
  kit: lustreServer,
  app: counter.app(),
  flags: (props: { start: number }) => props.start,
  authorize: async () => (await auth()) !== null,
});
// app/page.tsx: <CounterView start={7} />
```

It is `defineLiveView`'s Lustre twin. The page renders the first view as HTML
(it works with JavaScript disabled), with the props and an HMAC over them. In
the browser the view mounts over the [Live](/docs/live) socket: the server
checks the token and `authorize`, runs Lustre's server-component runtime with
the flags, one runtime per mounted view per connection, and streams Lustre's own
messages (the whole view, then patches). Lustre's own reconciler applies them,
from the app's island chunk, never an inline script, so the strict default CSP
holds. DOM events go back as Lustre's events and are checked before Lustre's
decoders see them: Lustre's `EventFired` message only, a bounded path and name,
a small plain-JSON event, then the view's optional `events` schema.

- **authorize** runs when the page renders, when the browser mounts or resumes
  the view, and again every `live.limits.channelAuthTtlSeconds` while it runs;
  `false` ends the view (`denied`).
- **limits**: `maxViewsPerConnection` Lustre views per connection, the view's
  size (its whole-view message) within `maxViewBytesPerConnection`, a bounded
  inbox of pending events per view, plus every Live socket limit.
- **back-pressure**: while the socket is backed up nothing is queued; once it
  drains the view is sent whole again.
- **resume**: Lustre's model is an arbitrary Gleam value, so it is never written
  to the shared view store. A reconnect to **the same server instance** within
  `live.limits.viewResumeSeconds` reattaches the running Lustre runtime; a
  reconnect that lands on another instance, or comes later, runs `init` again.
- **shutdown**: a view's runtime stops when the page leaves it, when its resume
  window ends, and when the server drains.

### Lustre 5.7.1's server runtime

Lustre's JavaScript server-component runtime has two bugs in 5.7.1:
`lustre.start_server_component` passes every argument one slot off, and three
lines read a binding in its own temporal dead zone, so every message throws
`Cannot access 'message' before initialization`. denext never calls
`start_server_component` (it builds the runtime directly), and after every Gleam
build it fixes the three lines in `lustre/runtime/server/runtime.ffi.mjs` —
only in Lustre 5.7.1, only when the file is byte for byte the published one,
and nothing else in it. Any other version or content is left as it is, with one
warning. See [Known limitations](/docs/limitations) for what Lustre itself
leaves running after a stop.
