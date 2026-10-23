---
title: Monorepos
slug: monorepo
lead: "denext create --monorepo scaffolds a Deno workspace: the app in apps/web and the packages it shares in packages/, imported by name from Server Components, islands and the client bundle alike."
---

A denext monorepo is a [Deno workspace](https://docs.deno.com/runtime/fundamentals/workspaces/):
a root `deno.json` that lists its members, each member a folder with its own
`deno.json`. denext adds nothing on top. The app is an ordinary denext app that
happens to be a member, and a package is an ordinary Deno package that the app
imports by its name.

```sh
denext create my-shop --monorepo
cd my-shop
denext task dev
```

`--monorepo` is also an entry in `denext create`'s interactive picker and on
`denext ui`'s Setup page.

## The layout

| Path                                  | What it is                                                                                                                                                                                                                                                                       |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deno.json`                           | The workspace: the members, the fields only a root may set (`unstable`, `allowScripts`), what every member shares (`compilerOptions`, `fmt`, `lint` with denext's lint plugin), and the root tasks.                                                                              |
| `apps/web/`                           | The denext app: `app/`, `denext.config.ts`, its own `deno.json` with its own tasks. Every other `denext create` option applies to it (`--tailwind`, `--src-dir`, `--template`, `--desktop`, `--capacitor`, …).                                                                   |
| `packages/ui/`                        | `@my-shop/ui`: a `Card` and a `Button`, and their `styles.css`. They hold no state and no effects, so a Server Component renders them on the server and a `"use client"` island renders and hydrates them in the browser. The stylesheet is the package's `./styles.css` export. |
| `packages/shared/`                    | `@my-shop/shared`: plain TypeScript with no denext (a `pluralize` helper), for code the server, the browser and tests all run.                                                                                                                                                   |
| `.vscode/`, `README.md`, `.gitignore` | At the root, for the whole repository. With `--mcp` and `--fallow`, `.mcp.json` and the fallow gate are at the root too, and the gate's patterns match every member.                                                                                                             |

The scope (`@my-shop`) comes from the folder's name. The page imports the
packages the way any Deno workspace member does:

```tsx
// apps/web/app/page.tsx — a Server Component
import { Card } from "@my-shop/ui";
import { Counter } from "./counter.tsx";

export default function Home() {
  return (
    <Card title="Shared components">
      <Counter />
    </Card>
  );
}
```

```tsx
// apps/web/app/counter.tsx — a client island
"use client";
import { useState } from "denext";
import { Button } from "@my-shop/ui";
import { pluralize } from "@my-shop/shared";

export function Counter() {
  const [count, setCount] = useState(0);
  return (
    <Button onClick={() => setCount((c) => c + 1)}>
      Clicked {count} {pluralize(count, "time")}
    </Button>
  );
}
```

The root layout imports `@my-shop/ui/styles.css`. denext compiles a package's
stylesheet like one of the app's own, so it ships in the app's CSS bundle.

## Tasks

Run these from the root:

| Command             | What it does                                                                     |
| ------------------- | -------------------------------------------------------------------------------- |
| `denext task dev`   | The app's dev server. The root task runs `deno task --cwd apps/web dev`.         |
| `denext task build` | The app's production build.                                                      |
| `denext task start` | Serve the app's production build.                                                |
| `denext task test`  | Every member's tests (`packages/ui/ui.test.tsx`, `packages/shared/mod.test.ts`). |
| `denext task check` | `deno fmt --check`, `deno lint` and the tests, over the whole workspace.         |

With `--desktop` or `--capacitor`, the root also has `desktop` and
`mobile:sync` tasks that run the app's own tasks. Every `denext` verb works on
the app directly: `denext dev apps/web`, `denext build apps/web`,
`denext doctor apps/web`. Run at the root itself, `denext dev`, `build` and
`doctor` name the workspace's apps and tell you how to run them.

`denext dev` treats the packages as part of the app. An edit in `packages/ui`
hot-updates the module in the browser and re-renders the server. You don't need
to restart anything.

## Native targets

A denext target (`--desktop`, `--capacitor`) is one app, so the native shells
live in `apps/web`: its `desktop.ts`, `capacitor.config.ts`, `package.json` and
packaging scripts. A second app with its own shell is a second member with its
own options.

## Adding a member

**An app.** `denext generate app admin`, run at the root, writes `apps/admin`
(an app that imports the shared packages, pinned to the denext version the
workspace already uses). It also adds `./apps/admin` to the `workspace` list and
a `dev:admin` task. Give each app its own port when two run at once:
`denext dev apps/admin --port 3001`.

**A package.** A folder under `packages/` with a `deno.json` that holds `name`
(`@my-shop/<name>`), `version` and `exports`. Then add its path to the root's
`workspace` list, and apps can import it by name.

List members one by one, as the scaffold does, not as a `packages/*` glob:
denext's client bundler resolves a member by name only when the root lists it.
denext also handles an app inside a workspace that doesn't list it: it builds
on its own config, as Deno runs it, but it can't import its siblings by name.

## Upgrading

`denext upgrade` at the root moves the denext pin in every member's `deno.json`
together, so the app and the packages always resolve the same denext. A package
and the app sharing one denext instance is what lets a component from
`packages/ui` use the same hooks and context as the app.

## Related

- [Project layout](/docs/project-layout): every file a single app can have.
- [Migrating](/docs/migrating): `denext migrate` handles pnpm workspaces and
  stylesheets imported from sibling packages.
- [Getting started](/docs/getting-started): `denext create`'s other options.
