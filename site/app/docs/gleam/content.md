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
