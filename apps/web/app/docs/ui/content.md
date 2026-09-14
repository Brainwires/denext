---
title: Project UI
slug: ui
lead: denext ui serves a loopback GUI for the project in front of you — a schema-driven denext.config.ts editor that preserves your comments, plugin management, a GUI over generate, Docker regeneration with diffs, a setup wizard, and your project's own CLI verbs.
---

`denext ui` is a browser GUI for the project you are standing in — the `vue ui` idea,
served by denext's own CLI. It ships inside the package, works on a fresh clone with
nothing installed, and binds loopback only.

```sh
denext ui                    # serve the current project and open a browser
denext ui ./my-app --port 6000
denext ui --read-only        # browse; every mutation is refused
denext ui --no-open --json   # print { url, port, token } and keep serving
```

The verb prints a URL carrying a one-time token, opens it, and serves until Ctrl+C
(or `SIGTERM`, which drains in-flight requests and releases the port).

## Flags

| Flag              | Default | What it does                                                           |
| ----------------- | ------- | ---------------------------------------------------------------------- |
| `[dir]`           | `.`     | The project directory to manage                                        |
| `--port <n>`      | `5177`  | Port to listen on; `0` picks a free one, and a busy port falls forward |
| `--no-open`       | off     | Don't launch a browser — print the URL instead                         |
| `--read-only`     | off     | Refuse every mutation with a `403` before it runs                      |
| `--token <t>`     | minted  | Use this session token instead of a fresh 256-bit one                  |
| `--json` (global) | off     | Print `{ url, port, token }` as one JSON line, then keep serving       |

`--json` is what a script drives the UI with: read the line, then talk to the
`/api/*` routes. `--quiet` suppresses the banner without the JSON line.

## The security model

The UI writes your project's files, so it is defended like a public server even though
it only ever listens on `127.0.0.1`. Six layers, all in
[`src/ui/security.ts`](https://github.com/Brainwires/denext/blob/main/src/ui/security.ts):

| Layer                   | What it enforces                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Bind                    | `127.0.0.1` only. There is no `--host` — see the note below                                                        |
| Host + `Sec-Fetch-Site` | The `Host` the browser sent must name a loopback interface, and a present `Sec-Fetch-Site` must read `same-origin` |
| Session token           | A per-launch 256-bit token, handed over once in `?t=` and exchanged for an `HttpOnly; SameSite=Strict` cookie      |
| CSRF                    | Every mutation needs a same-origin `Origin`/`Referer` plus a token derived as `HMAC-SHA256(sessionToken, "csrf")`  |
| Containment             | Every project-relative path goes through `uiSafeJoin` — lexical check, then a realpath re-check                    |
| Headers                 | A strict CSP plus COOP, CORP, `no-referrer`, `no-store`, `nosniff` on every response                               |

**Why no `--host`.** A project GUI that writes files is a remote-code-execution surface
by construction: it edits `denext.config.ts`, scaffolds modules, and spawns `deno`. There
is no configuration under which exposing that to a network is the right default, so the
bind address is not configurable. Reach it from another machine with an SSH tunnel
(`ssh -L 5177:127.0.0.1:5177 host`), which keeps authentication where it belongs.

**The token handshake.** The URL the verb prints ends in `?t=<token>`. The first request
carrying it gets a `302` to the same path with the query stripped and the token parked in
an `HttpOnly; SameSite=Strict; Path=/` cookie — so the secret never survives in the
address bar, in `document.referrer`, in history, or in a link you paste to someone. A
request without the cookie is a `401` before any route runs; a bad `Host` or a cross-site
caller is a `403` before the token is even consulted. Pages publish the derived CSRF token
as `<meta name="denext-csrf">`; forms post it in a hidden `_csrf` field and `fetch` sends
it in `x-denext-ui-csrf`.

**What the CSP forbids.** Every response carries:

```
default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline';
img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none';
form-action 'self'; frame-ancestors 'none'
```

No inline script, no third-party script or style, no remote fetch, no plugins, no
framing, and a form cannot post anywhere but back to the UI. The one client module is
served same-origin from `/_ui/ui.js`, and the stylesheet from `/_ui/ui.css`. Alongside it:
`referrer-policy: no-referrer`, `cross-origin-opener-policy: same-origin`,
`cross-origin-resource-policy: same-origin`, `cache-control: no-store`,
`x-content-type-options: nosniff`.

**The UI process never loads your code.** It does not import `denext.config.ts`, your
plugins, or your dependencies, and the bundler never enters its module graph (a test
asserts this with `deno info`). Everything that needs the project evaluated — `denext
doctor --json`, `deno task`, `deno add`/`deno remove`, `denext dev`, the `next.config`
evaluator — runs as a `deno` subprocess through
[`src/ui/proc.ts`](https://github.com/Brainwires/denext/blob/main/src/ui/proc.ts), always
with array argv and never through a shell. A name that came from the browser is never
interpolated into a command: a task name must appear in your own `deno.json` `tasks` map,
and a package name must be one of the catalog's own.

> [!NOTE]
> On a shared machine, loopback is not a boundary: any local user can reach
> `127.0.0.1:5177`, and the session cookie is the only thing between them and a write. The
> token is 256 bits and is never printed except on your own terminal, but if you don't
> control every account on the box, run `denext ui --read-only`, or don't run it at all.

## Configuration editor

`/config` is a form generated from
[`denext.config.schema.json`](https://github.com/Brainwires/denext/blob/main/denext.config.schema.json)
— the same schema your editor uses for completions — with one collapsible section per
top-level key. Each field gets the control its type deserves:

| Schema shape                    | Widget                                                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `enum` (≤ 4 short values)       | Segmented radio group                                                                                                           |
| `enum` (longer)                 | Select, with "— unset —" first when optional                                                                                    |
| `anyOf`                         | A branch picker, then the selected branch's form (`csp`, `hsts`, `compatibilityMode`)                                           |
| Array of `enum`                 | Checkbox group (`images.formats`)                                                                                               |
| Array of scalars                | Chips: add, remove, reorder (`publicEnv`, `i18n.locales`)                                                                       |
| Array of objects                | A typed sub-form per row with `↑` `↓` `✕` and `+ Add` (`redirects`, `rewrites`, `headers`, `images.remotePatterns`, `commands`) |
| `Record<string, T>`             | Key/value map rows (`scheduledTasks`, `experimental.features`)                                                                  |
| Object with properties          | A collapsible group                                                                                                             |
| `boolean` / `number` / `string` | Toggle / number (with the schema's bounds) / text                                                                               |
| Anything opaque                 | A read-only code cell                                                                                                           |

### The two buckets

A top-level key whose value is a **data literal** is editable through those widgets. A key
whose value is **code** — a call, a callback, an imported binding — is shown verbatim in a
read-only code cell, because a form that round-trips it would have to regenerate it, and
regenerating code destroys it. That is why `plugins` (each entry is a live `setup`
function), `cache.store` (an object of methods), `live.authorize` and the other Live
callbacks, `mdx.remarkPlugins`/`rehypePlugins`/`recmaPlugins`, and a `commands[].run`
handler are never editable here.

`plugins` is the one policy exception: it is data, but the [plugins panel](#plugins) owns
it, because adding an entry also means adding an import.

`redirects`, `rewrites` and `headers` are functions returning an array. The thunk is code,
so the wrapper is left exactly where it is — but the array it returns is unwrapped and its
rows edit like any other list. The `() => [ … ]` around them never moves.

### How a write happens

Nothing is regenerated. Every edit is a _splice_ through
[`src/build/config-edit.ts`](https://github.com/Brainwires/denext/blob/main/src/build/config-edit.ts):
locate the exact byte span of one value (or one array element), replace that span, leave
every other byte alone. Comments, imports, blank lines, factory calls and hand-written
helpers survive byte-for-byte.

Three module shapes are supported — `export default { … }`, `export default
defineConfig({ … })`, and the factory/named forms (`export default () => ({ … })`,
`export default function () { return { … } }`, `export const basePath = "/x"`). Anything
else is an honest **bail**: the panel says why, quotes the offending snippet, and hands
you a copyable unified diff to apply by hand. The file is left exactly as it was.

Every write is two steps, and both run the whole _proposed_ config through
`validateDenextConfig`:

1. The first `POST` computes the new source and answers with a unified diff. Nothing has
   touched disk.
2. A second `POST` carrying `confirm=1` applies it and answers `303` back to
   `/config#<section>`.

A value the validator rejects is a `422` with the message rendered against its own field,
never a broken config on disk. At the bottom of the panel there is a raw-file escape
hatch: the whole file in a textarea, saved only if it still parses as a denext config.

### The compat panel

`/config/next` reads a Next.js app's `next.config.*` and offers to translate it. It is
read-only by construction, and the reason matters: **denext never loads `next.config` at
runtime.** The drop-in path rewrites `next/*` imports; it does not adopt Next's config
file. Editing that file would change nothing, so the panel does not offer to.

The config is evaluated in a bounded subprocess rooted at the app's own directory (so its
npm plugin imports resolve), with read/env/sys and nothing else, and the result is shown
as three tables: keys denext honors under the same name (`cacheComponents`, `basePath`,
`trailingSlash`, `assetPrefix`, `images`, `i18n`), the `redirects`/`rewrites`/`headers`
thunks whose results can be inlined, and the keys with no denext equivalent, each with a
one-line pointer to where the behaviour went instead. "Translate" is not a second writer:
each button posts the honored value to `/config` as an ordinary section edit, so it lands
in the same diff-then-confirm path as everything else.

## Plugins

`/plugins` lists the first-party catalog —
[`src/plugin/catalog.json`](https://github.com/Brainwires/denext/blob/main/src/plugin/catalog.json),
generated from the workspace packages themselves (name, version, caret-pinned `jsr:`
spec, the factory export, the CLI verb it contributes, and one sentence from its README)
— next to what this project already has wired into `denext.config.ts` and pinned in
`deno.json`.

Adding is `deno add jsr:@denext/<pkg>@^<version>` plus the config wiring through the same
import-preserving injector `denext plugin add` uses; removing is the inverse, ending in
`deno remove`. Both are previewed first: the first `POST` shows the unified config diff
and the exact `deno` argv, and nothing runs until a `POST` carrying `confirm=1`. The
applied mutation answers `303 /plugins#<name>`, or streams the `deno` log over SSE when
the browser asks for it.

Only catalogued names are accepted — a package name from the browser is matched against
the catalog before it can reach an argv array. Third-party plugin discovery is not in this
release; wire those in by hand or with `denext plugin add` (see
[Writing a plugin](/docs/plugins)).

## Generate

`/generate` is a GUI over `denext generate`. Pick one of the thirteen kinds — `page`,
`route`, `layout`, `loading`, `error`, `not-found`, `component`, `api`, `action`,
`middleware`, `task`, `test`, `docker` — name it, and preview.

Preview is the real dry run: the same plan the write uses, showing every file it would
create with its full contents, so what you read is what lands. "Write files" answers `303`
with the result in the query, so a reload never re-scaffolds. **A file that already exists
is never overwritten** — it is reported as skipped. The verb's own rules are mirrored
exactly: the kinds that take no name here are the kinds that take no name there. See the
[CLI reference](/docs/cli) for the verb.

## Docker

`/docker` regenerates the `Dockerfile`, `docker-compose.yml` and `.dockerignore` with
options: image mode (`server` — build plus `deno task start`; `static` — `deno task
export` plus a file server), the exposed port, the `denoland/deno:` tag to pin, and
whether to emit a real Postgres service. The mode is auto-detected from `mode: "spa"` in
your config when you don't pick one.

Every file is shown with its state and a per-file unified diff against what is on disk
before anything is written:

| State       | Meaning                                                        |
| ----------- | -------------------------------------------------------------- |
| `absent`    | Not present — will be created                                  |
| `generated` | Still carries the generated-file sentinel — safe to regenerate |
| `edited`    | Hand-edited — will not be overwritten                          |

The sentinel is a header comment every generated file carries:

```
# Generated by `denext generate docker`
```

A file without it was written or edited by a human, so a write refuses to touch it — and
shows you its diff anyway, so the change can be copied across by hand. That is the same
never-clobber honesty `denext migrate` and the config writer apply.

> [!NOTE]
> This release _emits_ the compose file; it never parses one. Options are re-applied by
> regenerating, not by round-tripping YAML, so a hand-written `docker-compose.yml` is read
> as `edited` and left alone. Compose round-tripping needs a YAML parser and is deferred.

Deployment targets, images and platform notes are in the [deployment guide](/docs/deploy).

## Setup wizard

`/wizard` takes a fresh clone to a running dev server in nine steps. Each step inspects one
aspect of the project and offers operations; every operation that writes previews its
change as a unified diff and only writes on an explicit confirm.

| Step                  | What it checks                                                                                                                    | What it offers                                                                                                            |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Detect the project    | denext app, Next.js compat app, empty directory, or something else; whether a dev server is already publishing `.denext/dev.json` | Nothing — it's a reading                                                                                                  |
| Deno runtime          | The running Deno against denext's minimum                                                                                         | Reports `deno upgrade` when it's old                                                                                      |
| `deno.json`           | The denext imports, the JSX compiler options, and the `dev`/`build`/`start` tasks                                                 | Write `deno.json`, or merge only the missing keys                                                                         |
| Dependencies          | Whether `deno.lock` exists; warns when `nodeModulesDir: "manual"` needs your package manager too                                  | Run `deno install`                                                                                                        |
| Environment variables | Scans the source for `Deno.env.get("X")` / `process.env.X` and diffs against your `.env*` files                                   | Write `.env.example` — **never `.env`**, and values are never read                                                        |
| Doctor                | —                                                                                                                                 | Runs `denext doctor --json` as a subprocess and renders every check; offers `app/page.tsx` when there is no app directory |
| Features              | The feature list `denext create` offers                                                                                           | Scaffolds the project into an empty directory; on an existing project it only lists them                                  |
| Tasks                 | The tasks your `deno.json` declares                                                                                               | Runs one, streaming its output over SSE                                                                                   |
| Finish                | Whether the dev server is up                                                                                                      | Starts `denext dev` and waits for it to publish its address                                                               |

Nothing in the wizard imports a project module: detection is filesystem probing, and
doctor, `deno install` and `denext dev` all run as subprocesses. See
[Doctor & audit](/docs/doctor-audit) for what the checks mean.

## Project commands

`/commands` lists every verb available in this project — built-ins, verbs a plugin
contributed through `addCommand`, and your own `commands:` entries — and runs the ones it
can.

A project verb is a literal in `denext.config.ts`. No plugin, no `setup`; it is the
shorthand for a one-off project script:

```ts
// denext.config.ts
import type { DenextConfig } from "denext/server";

export default {
  commands: [
    {
      name: "seed",
      summary: "Load the development fixtures",
      usage: "  denext seed --rows 100",
      flags: [{ name: "rows", type: "number", default: 50, help: "How many rows" }],
      async run(ctx) {
        await seedDatabase(Number(ctx.flags.rows));
      },
    },
  ],
} satisfies DenextConfig;
```

`denext seed` then parses flags, renders `--help`, and suggests "did you mean" exactly
like a built-in verb. Ship a verb as a reusable package instead and it belongs in a
plugin's `addCommand` seam — see [Writing a plugin](/docs/plugins#project-commands).

Both kinds are listed under **Project commands** in `denext --help` and in `denext
completions <shell>`. Enumeration is budgeted at 1.5 s: a plugin's `setup` is arbitrary
code that may hit the network or hang, and `--help` must still answer promptly, so a
discovery that overruns leaves the registry untouched and says so. **A built-in verb
always wins a name collision** — a `commands:` entry named `dev` is ignored, never
shadowing the core verb.

In the panel, a project or plugin verb that declares no required positional gets a Run
button and streams its output. Built-ins never do: `denext dev` would never exit, and its
output belongs in your terminal. Running a verb is a mutation — a verb may write anything
— so it is refused under `--read-only`.

## Working without JavaScript

Every panel is a real `<form method="post">`, and every action completes with JavaScript
disabled. A write answers `303` back to the anchor it changed (POST/redirect/GET, so a
reload never re-applies it); a preview re-renders the page with the diff in place; list
editors submit real buttons (`op=add|remove|up|down` plus the row index) and the server
applies the operation, validates, and re-renders.

The one client module, `/_ui/ui.js`, is progressive enhancement only. It upgrades those
same submits to `fetch` with `Accept: text/html-fragment` and swaps the returned
`<section id="panel">` in place, so the server keeps exactly one rendering path. The
returned fragment is parsed with `DOMParser` and adopted as nodes — untrusted text is
never assigned to `innerHTML`. Long-running work (a `deno task`, a `deno add`, `denext
dev`) streams over SSE at `/_ui/events`.

## The JSON API

Every feature path has an `/api/*` twin served by the _same handler_ with JSON output, so
the browser and a machine client exercise identical code:

| Path           | Methods               | JSON twin              |
| -------------- | --------------------- | ---------------------- |
| `/`            | `GET`                 | `/api/overview`        |
| `/config`      | `GET` `POST`          | `/api/config`          |
| `/config/next` | `GET`                 | `/api/config/next`     |
| `/plugins`     | `GET` `POST` `DELETE` | `/api/plugins`         |
| `/generate`    | `GET` `POST`          | `/api/generate`        |
| `/docker`      | `GET` `POST`          | `/api/docker`          |
| `/wizard`      | `GET` `POST`          | `/api/wizard`          |
| `/commands`    | `GET` `POST`          | `/api/commands`        |
| `/tasks/run`   | `POST`                | `/api/tasks/run` (SSE) |

Reads answer `{ ok: true, … }`. A preview answers `{ ok: true, applied: false, diff }`; an
applied write answers `{ ok: true, applied: true, … }`. Every refusal — `401` no cookie,
`403` bad origin, bad CSRF token or `--read-only`, `404` unknown path, `405` wrong method,
`422` a value the config validator rejected, `500` an unexpected error — answers
`{ ok: false, reason }`, with the offending `field` and the would-be `diff` where there is
one.

```sh
denext ui --no-open --json --port 0
# {"url":"http://127.0.0.1:54321/?t=…","port":54321,"token":"…"}
curl -s "http://127.0.0.1:54321/?t=$TOKEN" -D - -o /dev/null   # 302 + Set-Cookie
curl -s http://127.0.0.1:54321/api/config -b "denext_ui_token=$TOKEN" | jq .
```

That envelope is deliberate: it is the shape an MCP tool would front. Driving the project
UI from an agent is **not** in this release — the surface is only the HTTP API above.

## What it does not do yet

| Not yet                      | Why                                                                                                                                 |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Compose YAML round-trip      | The Docker panel emits a compose file, never parses one; a hand-written file is left alone                                          |
| Per-plugin option schemas    | The catalog knows a plugin's factory and its option _keys_, not the shape of its options                                            |
| Third-party plugin discovery | Only the first-party catalog is browsable; wire others in by hand                                                                   |
| Agent / MCP control          | Deferred; the `{ ok, diff, reason }` envelope exists so it can be added without changing the wire                                   |
| A denext app                 | The UI is a zero-bundler server-rendered `.ts` surface, not an App Router app — which is what lets it start instantly with no build |

## See also

- [CLI reference](/docs/cli) — every verb, including `ui`, `generate`, `plugin` and `doctor`
- [Configuration](/docs/config) — what each `denext.config.ts` key means
- [Writing a plugin](/docs/plugins) — the six seams, and the `addCommand` verb seam
- [Doctor & audit](/docs/doctor-audit) — the checks the wizard's doctor step runs
- [Deployment](/docs/deploy) — what to do with the Dockerfile the UI regenerates
- [Troubleshooting](/docs/troubleshooting) — when something refuses and the reason isn't obvious
