---
title: Project layout
slug: project-layout
lead: Every file and folder a denext app can have, what each one does, and which page explains it — from deno.json to the generated .denext/ directory.
---

A denext project is a Deno project: a `deno.json` at the root, an `app/`
directory, and whichever optional files the features you use add. There is no
`package.json` and no `node_modules` — dependencies are URL, `jsr:` or `npm:`
specifiers in `deno.json`'s `imports` map.

Only `deno.json`, a root layout and one page are required. Everything else in
the table below is optional, and denext costs nothing for the ones you skip.

## Every file a denext app can have

| Path                                                                     | Purpose                                                                                                                                                                                                                               | Learn more                                              |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `deno.json`                                                              | The project manifest: `tasks` (`dev`, `build`, `start`), the `imports` map that resolves every dependency, `compilerOptions.jsxImportSource: "denext"` so JSX compiles against denext, and denext's lint plugin under `lint.plugins`. | [Getting started](/docs/getting-started)                |
| `denext.config.ts`                                                       | Optional framework config — routing, rendering mode, images, caching, security, compatibility, plugins. Every field is optional; an app runs with no config file at all.                                                              | [Configuration](/docs/config)                           |
| `app/`                                                                   | The App Router. Folders are URL segments, and the special files (`page.tsx`, `layout.tsx`, `loading.tsx`, `error.tsx`, `not-found.tsx`, dynamic `[slug]` segments, route groups) all live here.                                       | [Routing](/docs/routing)                                |
| `app/api/**/route.ts`                                                    | HTTP handlers — export `GET`, `POST`, … returning a `Response`. `defineApi` adds schema-validated handlers whose types flow into the generated client.                                                                                | [Routing](/docs/routing) · [Typed API](/docs/typed-api) |
| `public/`                                                                | Static files, served from the URL root: `public/logo.svg` is `/logo.svg`. The image optimizer resolves local `<Image src="/…">` sources from here too.                                                                                | [Images](/docs/images)                                  |
| `middleware.ts` (or `proxy.ts`)                                          | The root request hook, run before routing — rewrite, redirect, or set headers. `middleware.ts` is the canonical name; `proxy.ts` is an accepted alias for the same file.                                                              | [Middleware](/docs/middleware)                          |
| `instrumentation.ts`                                                     | Server observability: `register()` runs once at startup, `onRequestError()` receives reported errors with Next-shaped context.                                                                                                        | [Deployment](/docs/deploy)                              |
| `instrumentation-client.ts`                                              | Bundled into every browser entry and run before your client code starts.                                                                                                                                                              | [Deployment](/docs/deploy)                              |
| `tasks/<name>.ts`                                                        | A `defineTask({ handler })` module — run on a cron schedule (`scheduledTasks`, or a per-task `schedule`) and/or on demand via `runTask(name)` and `denext task <name>`.                                                               | [Scheduled tasks](/docs/tasks)                          |
| `content.config.ts` + your content files                                 | Declares typed MD/MDX/YAML/JSON collections with a Standard Schema and a loader; the `glob` loader reads from whatever `base` you point it at (commonly `content/`). Needs the `@denext/content-collections` plugin.                  | [Content collections](/docs/content-collections)        |
| `patches/<name>+<version>.patch`                                         | Recorded edits to an npm package — or to denext's own sources — re-applied at every `dev`, `build` and `start`. Commit the directory.                                                                                                 | [Patching packages](/docs/patches)                      |
| `desktop.ts` · `icons/` · `scripts/package-*.ts` · `capacitor.config.ts` | Native packaging: the `deno desktop` entry, app icons, the macOS/Linux/Windows packaging scripts, and the Capacitor config that bundles the export into the iOS/Android shells.                                                       | [Desktop & mobile](/docs/desktop)                       |
| `src/app`, `src/middleware.ts`, `src/instrumentation.ts`                 | The optional `src/` layout (Next.js parity): when `src/app` exists, denext looks for the app, middleware and instrumentation under `src/`. `public/`, the config files and `.denext/` stay at the project root.                       | [Configuration](/docs/config)                           |
| `.denext/`                                                               | Generated build output. Git-ignored, machine-written, never edited by hand.                                                                                                                                                           | —                                                       |
| `.denext/api.ts`                                                         | Generated from your route modules' types. Import it type-only and `createApiClient` / `useApi` type-check every call against this app's routes.                                                                                       | [Typed API](/docs/typed-api)                            |
| `.denext/routes.ts`                                                      | Generated route types. Importing the file makes `<Link href>`, `router.push` and `redirect()` accept only real paths.                                                                                                                 | [Features](/docs/features)                              |
| `.denext/content.ts`                                                     | Generated collection types. Import it once and `getCollection` / `getEntry` are typed to your schemas.                                                                                                                                | [Content collections](/docs/content-collections)        |
| `.denext/cache.db`                                                       | The default cache store — Deno's built-in `node:sqlite` — for Cache Components / ISR data and the page cache, picked at startup when the filesystem is writable.                                                                      | [Data & caching](/docs/data)                            |
| `out/`                                                                   | The static export written by `denext export` — plain HTML, and what the desktop and mobile shells package.                                                                                                                            | [Deployment](/docs/deploy)                              |
| `spa.entry` (SPA mode)                                                   | A client-only app has **no `app/` directory**: `mode: "spa"` plus `spa.entry` pointing at the module that mounts your app. denext bundles it and serves one HTML shell for every navigation.                                          | [SPA mode](/docs/spa)                                   |
| `package.json`, `node_modules/` (compat drop-in)                         | A migrated Next.js or Vite app keeps both — the compat build loads your npm React libraries straight from the installed `node_modules`, while `deno.json` sits alongside and aliases `next/*` and `react` to denext.                  | [Migrating from Next.js](/docs/migrating)               |

## What `denext create` scaffolds

The default template is deliberately small: `deno.json`, `.gitignore`,
`README.md`, `app/layout.tsx` and `app/page.tsx`, plus `public/styles.css` — or
`styles/tailwind.css` with `--tailwind`, which also writes a `denext.config.ts`
carrying the `tailwind` block. `--src-dir` moves the app under `src/`;
`--desktop` adds `desktop.ts`, `icons/` and the three `scripts/package-*.ts`
packaging scripts; `--capacitor` adds `capacitor.config.ts` and a minimal
`package.json` pinning Capacitor 8 (`^8.5.2`) for its Node CLI and native
platforms — the `ios/` and `android/` projects that `cap add` creates are meant
to be committed, so only their build outputs are gitignored. Nothing else is
generated — every other row above appears only when you add the feature.

> [!NOTE]
> `.denext/` and `out/` are generated, so keep them out of version control.
> `denext create` writes a `.gitignore` that already covers them (along with
> `.env*.local`, `*.local` and `patches/.work/`), and
> [`denext migrate`](/docs/migrating) appends the missing lines to an existing
> one rather than reordering your entries.
