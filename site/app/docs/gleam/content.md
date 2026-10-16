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
specifiers) needs the `gleam` CLI ([install it](https://gleam.run/getting-started/)).
It:

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

When `gleam` is not installed the plugin says so once and skips the compile,
and the app keeps the last compiled output; an app with no Gleam project is left
alone. A compile error fails the step and prints Gleam's diagnostics.

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
