---
title: Migrating from Lustre
slug: migrating-lustre
lead: denext migrate runs a Lustre web app (Gleam, JavaScript target) on denext with its Gleam source unchanged. The gleam() plugin compiles it, and a page mounts the app's own main as an island.
---

This guide covers moving an existing **Lustre** single-page app (the Gleam UI framework, built
with lustre_dev_tools) to denext. It reflects what `denext migrate --from lustre` does today,
including its limits.

The short version: **your Gleam code is not rewritten or moved.** The [`gleam()` plugin](/docs/gleam)
compiles the project where it is, with denext's pinned Gleam, and a generated page calls the
entry module's `main` in the browser, as lustre_dev_tools' `index.html` did.

---

## 1. Detection

A Lustre app has a `gleam.toml` at the project root that depends on `lustre` and builds for
JavaScript: `target = "javascript"`, or `lustre_dev_tools` in its dev dependencies (which always
builds the browser bundle for JavaScript). The entry is `src/<name>.gleam`, `<name>` being the
package's `name`, with a `pub fn main()` that starts the app (lustre_dev_tools' convention).

Lustre apps are checked right after Fresh, before any `package.json` app. Pass `--from lustre` to
force the path.

```sh
denext migrate --check
denext migrate
denext task dev
```

The first `dev` / `build` downloads denext's pinned Gleam (SHA-256-verified) and Lustre from Hex.
`denext toolchain install --with gleam` fetches the compiler ahead, for offline work.

---

## 2. What it generates

| File                 | What it is                                                                                                                                                                                                |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deno.json`          | denext's tasks and import map, `denext/gleam`, and `"@gleam/": "./build/dev/javascript/"`, Gleam's JavaScript output.                                                                                     |
| `denext.config.ts`   | `plugins: [gleam()]`: compiles the project (`gleam.toml` at the root) at dev startup, on every `.gleam` change and at build, and writes the `.denext/lustre*.ts` kits.                                    |
| `app/layout.tsx`     | The document. Its title comes from `index.html`'s `<title>`, else `[tools.lustre.html] title`, else the package name.                                                                                     |
| `app/page.tsx`       | The page, rendering the island below.                                                                                                                                                                     |
| `app/lustre-app.tsx` | A `"use client"` island that renders the element `main` mounts on (the selector of its `lustre.start` call, `#app` by default) and calls `main()` from `@gleam/<name>/<name>.mjs` once it is in the page. |
| `public/`            | `priv/static/` moved here. lustre_dev_tools' own bundle (`priv/static/<name>.mjs`, `.min.mjs`) stays behind; denext bundles the app itself.                                                               |
| `.gitignore`         | `.denext/`, `out/`, `.deno/` and Gleam's `build/`, appended only when missing.                                                                                                                            |

A hand-written `deno.json`, `denext.config.ts` or `app/` file is left alone and listed for review.
Files `priv/static/` held are served from `/` now, not `/priv/static/`: update the paths the app
links them by.

### Rendering on the server

The generated island runs `main` in the browser only, as the original app did, so the page's first
paint is the empty mount element. For a server-rendered first paint, export the app value from
Gleam (`pub fn app() { lustre.simple(init, update, view) }`) and render it with `lustreIsland`
from `denext/gleam`; see [Gleam and Lustre](/docs/gleam).

---

## 3. Components and server components

Nothing is rewritten here either: a `lustre.component` registered with `lustre.register` keeps
working inside the app. `migrate --check` points at what denext adds, if you want it:

- **`lustreElement`** renders a Lustre component as a custom element with its shadow root
  prerendered on the server (Declarative Shadow DOM).
- **`defineLustreView`** runs a Lustre app as a server component (`lustre/server_component`),
  its DOM patches carried over denext's Live socket instead of a server of your own.

Both are covered in [Gleam and Lustre](/docs/gleam).

---

## 4. What `migrate --check` reports

`denext migrate --check` reports `source: "lustre"`.

| Won't migrate                                                                                 | What to do                                                                                                                |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| An Erlang-target package in `[dependencies]` (`mist`, `wisp`, `gleam_erlang`, `gleam_otp`, …) | denext compiles the JavaScript target only: move that code to a server of its own, or port it to a route handler.         |
| `.erl` / `.ex` FFI files in `src/`                                                            | The JavaScript build never loads them: give each external function a JavaScript implementation (`@external(javascript)`). |
| A `.gleam` module with Erlang-only `@external` functions                                      | Calling them from the JavaScript build fails to compile; add a JavaScript implementation.                                 |
| A Gleam server project in `server/` or `backend/`                                             | Not migrated: keep running it, or port its endpoints to `app/api/…/route.ts`.                                             |

| Review                                               | What to do                                                                                                    |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `index.html`                                         | No longer served: move its stylesheets and `<head>` tags into `app/layout.tsx`, then delete it.               |
| A stylesheet in `src/`                               | lustre_dev_tools bundled it: import it from `app/layout.tsx` (with Tailwind, set `tailwind: { input }`).      |
| `[tools.lustre.html]`                                | Carry its stylesheets, scripts and `<head>` tags into `app/layout.tsx` (the title is carried).                |
| `[tools.lustre.dev]`                                 | The dev server is `denext dev`: port a `proxy` to `rewrites` in `denext.config.ts` or a route handler.        |
| `[tools.lustre.build]`, `[tools.lustre.bin]`         | denext builds the bundle and runs its own pinned Gleam, esbuild and Tailwind; these settings do not apply.    |
| `main` mounting on another kind of selector, or none | The island renders `<div id="app">` (an `#id` or `.class` selector is carried); give it the element you need. |
| No `target = "javascript"`                           | The plugin builds the JavaScript target anyway; set it so `gleam build` / `gleam test` agree.                 |
| A `src/app/` directory                               | denext reads `src/app/` as the App Router directory before `app/`: rename that Gleam module directory.        |
| `lustre/server_component`, `lustre.component` usage  | They keep working; `defineLustreView` / `lustreElement` are there if you want them (see above).               |
| `priv/static/<name>.mjs`                             | lustre_dev_tools' bundle output: delete it.                                                                   |

---

## 5. Proof

[`tests/migrate-lustre.test.ts`](https://github.com/Brainwires/denext/blob/main/tests/migrate-lustre.test.ts)
migrates a Lustre app with a counter whose `init` runs an effect, a registered custom element and a
server component module, checks the generated files and the `migrate --check` report against a
golden one, then compiles the migrated app with denext's pinned Gleam and exports its page: the
island's client chunk carries the Gleam app.
