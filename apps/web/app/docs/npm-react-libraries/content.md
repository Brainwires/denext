---
title: npm React libraries
slug: npm-react-libraries
lead: Using shadcn/Radix, lucide-react, react-hook-form, TanStack, motion or any other npm React library in a native denext app — why it needs the compatibility (esbuild) build path, the exact setup, what changes, and what it costs.
---

A native denext app imports from `denext`, has no `package.json`, and builds
with `deno bundle`. An npm React library does its own `import "react"` inside
`node_modules`. Those two facts collide, and this page is about the seam between
them.

## Why a library needs the compat path

A Deno import map reaches the **app's own** bare specifiers: your
`import { useState } from "react"` can be aliased to denext. It does not reach a
specifier written _inside_ an npm package — when `lucide-react` imports `react`,
Node resolution hands it the real React from `node_modules`, and the page runs
**two Reacts**: denext renders the tree, the library's hooks call a React that
has no dispatcher, and you get `no dispatcher installed` or a component that
renders once and never updates.

`deno bundle` (esbuild without its plugin surface) has no hook to rewrite that
import. denext's **next-compat build** — the same pipeline that runs unmodified
Next.js apps — bundles with `npm:esbuild` and resolver plugins that redirect
`react`, `react-dom`, `react/jsx-runtime`, `react-is` and `next/*` for **every
module in the graph**, node_modules included, to denext's single prebuilt
runtime. That is the "one React" guarantee, and it is a build-time property: the
shipped bundle contains denext's runtime plus the library's code, never npm
React.

The native path folding that alias in without esbuild is tracked on the
[roadmap](https://github.com/Brainwires/denext/blob/main/ROADMAP.md) as an
upstream watch item (it needs `deno bundle` to expose esbuild's plugin seam).
Until then, **a native app that uses an npm React library is a compat-mode app
for the build step** — and only for the build step: your source still imports
from `denext`, Server Components, Server Actions, the typed API and every other
feature work unchanged.

## Setup

Three edits, then install.

**1. Declare the packages.** Add a `package.json` with the library **and**
`react` + `react-dom`. Real React is installed so every library's peer range is
satisfied and so denext's auto-detection switches on; it is never bundled.

```json
{
  "private": true,
  "dependencies": {
    "react": "19.1.0",
    "react-dom": "19.1.0",
    "lucide-react": "0.469.0",
    "@radix-ui/react-dialog": "1.1.14"
  }
}
```

**2. Let Deno populate `node_modules`.** In `deno.json`, set `nodeModulesDir`
and alias the React family so the type-checker resolves a library's
`import type … from "react"` against denext's compat types. `skipLibCheck` keeps
the libraries' own bundled `@types/react` copies from conflicting with each
other.

```jsonc
// deno.json
{
  "nodeModulesDir": "auto",
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "denext",
    "skipLibCheck": true
  },
  "imports": {
    "denext": "jsr:@denext/denext@^2",
    "denext/": "jsr:@denext/denext@^2/",
    "react": "jsr:@denext/denext@^2/react",
    "react/jsx-runtime": "jsr:@denext/denext@^2/react/jsx-runtime",
    "react-dom": "jsr:@denext/denext@^2/react-dom",
    "react-dom/client": "jsr:@denext/denext@^2/react-dom/client",
    "react-is": "jsr:@denext/denext@^2/react-is"
  }
}
```

`denext create --compatibility` writes this alias block (plus the `next/*`
ones a drop-in needs); `denext migrate` does the same for a migrated app.

**3. Turn compatibility mode on.** The default is `"auto"`, which enables it
when `node_modules/react` exists or `package.json` lists `react` or `next`.
Setting it explicitly costs nothing and survives a layout that hides those
signals (a monorepo whose `node_modules` lives one directory up):

```ts
// denext.config.ts
export default {
  compatibilityMode: true,
};
```

Then install and run as usual:

```sh
deno install          # populates node_modules from package.json
deno task dev
```

`denext add npm:zod` / `denext remove` / `denext update` wrap the matching
`deno` subcommands for `deno.json`-declared dependencies; a React library
belongs in `package.json` because its peers and `exports` map are what the
compat resolver reads.

## Using the library

Nothing special. A `"use client"` component imports it like any other module;
your own code keeps importing from `denext`:

```tsx
// app/dialog.tsx
"use client";
import { useState } from "denext";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";

export function Confirm({ title }: { title: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger>Delete</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Content>
          <Dialog.Title>{title}</Dialog.Title>
          <Dialog.Close aria-label="Close">
            <X size={16} />
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
```

A library that only renders (an icon set, a chart) can be used from a Server
Component too — it is server-rendered and ships no JavaScript for that route.
Anything with hooks or event handlers goes behind a `"use client"` boundary, as
in Next.

**shadcn/ui** is copy-in source, not a package: its generated components import
`react`, Radix primitives, `class-variance-authority`, `clsx`, `tailwind-merge`
and `lucide-react`. Add those to `package.json`, and either leave the `react`
imports to the alias map or rewrite them to `denext` (`denext codemod` does it
in one pass). Radix's `asChild` resolves through denext's own `Slot`, so the
`Button
asChild` pattern works as written.

### A library's CSS

Import the stylesheet as a side effect, exactly as the library's README says:

```tsx
// app/layout.tsx
import "react-day-picker/style.css";
```

The build walks the import graph, so a `.css` file that lives under
`node_modules` is discovered, compiled through the same lightningcss pipeline as
your own stylesheets and delivered as a `<link>` — no JavaScript carries it. A
library that ships Sass works the same way (`@import "pkg/…"` resolves along
`node_modules`). Tailwind-based libraries need their sources in your Tailwind
`@source` list, as they would anywhere.

### Class components

recharts 2.x and a few older libraries are class-based. They work with no
configuration: denext's class runtime is a separate chunk loaded on demand when
the server-rendered page contained a class component. `classComponents: true` in
`denext.config.ts` imports it statically (no round trip); `false` keeps it out
entirely and a class then throws a guided error.

## What changes

| Native                                                     | With an npm React library (compat build)                                                                                                           |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bundler: `deno bundle`, no npm anywhere                    | Bundler: `npm:esbuild` + the Deno loader, **at build time only**; the runtime stays npm-free                                                       |
| Dependencies: `deno.json` imports, no `node_modules`       | `package.json` + `nodeModulesDir: "auto"` + `deno install`; `node_modules` on disk                                                                 |
| `deno check` needs no extra flags                          | `skipLibCheck: true` and the `react` type aliases                                                                                                  |
| Dev: unbundled per-module HMR over your own modules        | The same loop, plus an on-demand pre-bundle of npm dependencies (Vite's optimizeDeps idea) with `react` external                                   |
| Client bundle: denext's runtime + your components          | Plus the library — an icon set tree-shakes to the icons you import (`"sideEffects": false` packages are pruned); a component library is what it is |
| Server-only leak check reads the `deno bundle` source maps | The `server-only` / `client-only` markers are enforced by the esbuild resolver instead                                                             |

What does **not** change: the App Router, Server Components and Flight, Server
Actions, streaming, the typed API, `denext/live`, islands and resumability, the
CSS pipeline, `denext export` and `denext desktop`. Compatibility mode is the
bundler, not a different framework.

## The cost, honestly

- **A build-time npm dependency.** esbuild is downloaded into Deno's cache on
  the first compat build. It never ships; the production image runs `deno` and
  the `.denext/` output only.
- **Slower builds** than the native path — esbuild resolves through
  `node_modules` and prebuilds denext's runtime once per project. A large
  component library (the shadcn/ui site, ~2 700 islands) builds in minutes, not
  seconds.
- **Bundle weight is the library's.** denext cannot make Radix smaller; it can
  only avoid shipping a second React. `denext analyze` shows what each chunk
  carries.
- **A second install step** (`deno install`) and a `node_modules` directory to
  ignore.
- **Type-checking leniency.** `skipLibCheck` is mandatory; a library's types
  that assume `@types/react` internals may need a cast.

## Known to work

Exercised in this repository's examples, e2e suites and migration beds:

- **Radix UI** (`examples/next-compat`: Collapsible; the shadcn/ui site through
  the Next migration bed) and **Base UI** (`@base-ui/react` dialog, menu,
  autocomplete — e2e fixtures).
- **lucide-react** and **react-hook-form**
  (`tests/e2e/next-compat-libs.test.ts`).
- **recharts 2.x** — class components (`examples/next-compat-recharts`).
- **motion** (framer-motion) and **@react-spring/web** together
  (`examples/animation`).
- **TanStack Router** (`examples/tanstack-router`) and **React Router** (the
  `@denext/react-router` plugin).
- The Next drop-in beds add dnd-kit, sonner, embla, cmdk, vaul,
  react-day-picker, react-markdown, katex, fumadocs and next-intl.

**Not verified here:** zustand, jotai, TanStack Query and SWR have not been run
in this repository's suites. They are plain hook-based libraries with no React
internals, so they are expected to work through the same alias — but treat that
as an expectation, not a claim, and smoke-test the one you pick.

## Troubleshooting

- `no dispatcher installed` / hooks throwing inside the library — compatibility
  mode is off, or the library was resolved outside the aliased graph. Set
  `compatibilityMode: true` and confirm `node_modules/react` exists.
- `deno check` reports `@types/react` conflicts — set `skipLibCheck: true`.
- `WorkspaceDiscoverError(ConfigNotWorkspaceMember)` — the app sits inside
  another Deno workspace; give it `"workspace": []`.

Each entry is expanded on the [Troubleshooting](/docs/troubleshooting) page; the
full drop-in story for an existing Next.js app is on
[Migrating from Next.js](/docs/migrating).
