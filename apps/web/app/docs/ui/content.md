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
(or `SIGTERM`), which drains in-flight requests and releases the port. **One** Ctrl+C is
enough with pages open: the shutdown closes every `/_ui/events` stream first, so an open
tab's SSE connection cannot hold the drain.

## Flags

| Flag              | Default | What it does                                                                   |
| ----------------- | ------- | ------------------------------------------------------------------------------ |
| `[dir]`           | `.`     | The project directory to manage                                                |
| `--port <port>`   | `5177`  | Port to listen on. `0` picks a free one                                        |
| `--no-open`       | off     | Don't launch a browser — print the URL instead                                 |
| `--read-only`     | off     | Refuse every mutation with a `403` before it runs                              |
| `--token <token>` | minted  | Use this session token instead of a fresh 256-bit one (at least 22 characters) |
| `--ui-dev`        | off     | Internal: watch `src/ui` and reload open pages on change (a checkout only)     |
| `--json` (global) | off     | Print `{ url, port, token }` as one JSON line, then keep serving               |

**The port is a requirement when you name one.** Left to the default, `5177` falls
forward through at most ten ports when it is busy and the URL it prints says which one it
took. An **explicit** `--port` does not: a taken port is a clear error
(`port 6000 is already in use`) rather than a server quietly listening somewhere else.

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
| Containment             | Every project path goes through `uiSafeJoin` / `uiSafeUnder` — see below                                           |
| Headers                 | A strict CSP plus COOP, CORP, `no-referrer`, `no-store`, `nosniff` on every response                               |

**Why no `--host`.** A project GUI that writes files is a remote-code-execution surface
by construction: it edits `denext.config.ts`, scaffolds modules, and spawns `deno`. There
is no configuration under which exposing that to a network is the right default, so the
bind address is not configurable. Reach it from another machine with an SSH tunnel
(`ssh -L 5177:127.0.0.1:5177 host`), which keeps authentication where it belongs.

**The token handshake.** The URL the verb prints ends in `?t=<token>`. The first request
carrying it gets a `302` to the same path with the query stripped and the token parked in
an `HttpOnly; SameSite=Strict; Path=/` cookie — so the secret never survives in the
address bar, in `document.referrer`, in history, or in a link you paste to someone. The
exchange is **single-use**: once it has run, a `?t=` is honoured only for a caller that
already holds the session cookie (the same tab re-opening its own link), so replaying the
copied URL in another browser is a `401`, not a second session. A request without the
cookie is a `401` before any route runs; a bad `Host` or a cross-site caller is a `403`
before the token is even consulted. Pages publish the derived CSRF token as
`<meta name="denext-csrf">`; forms post it in a hidden `_csrf` field and `fetch` sends it
in `x-denext-ui-csrf`.

A `--token` you supply yourself must be at least 22 characters (base64url, ≥ 128 bits of
entropy); a shorter one is refused at launch rather than quietly weakening the only
credential there is. One caveat with the default `--open`: handing the URL to the
browser-launcher puts the token in that process's argv, which any local user can read.
Use `--no-open` and paste the URL yourself when that matters.

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

**Project code never runs in the UI's privileged process.** It does not import
`denext.config.ts`, your plugins, or your dependencies, and the bundler never enters its
module graph (a test asserts both — `deno info` over the verb's module graph, and a
runtime check that project code ran under a different pid). Every project-touching
operation — `denext doctor --json`, `deno task`, `deno add` / `deno remove`, `denext dev`,
the `next.config` evaluator, **and discovering the verbs your project contributes
(`denext commands --json`)** — runs as a `deno` subprocess through
[`src/ui/proc.ts`](https://github.com/Brainwires/denext/blob/main/src/ui/proc.ts), always
with array argv and never through a shell. A name that came from the browser is never
interpolated into a command: a task name must appear in your own `deno.json` `tasks` map,
and a package name must be one of the catalog's own.

`--read-only` prevents writes **by the UI**; it does not stop your own config from
executing inside that short-lived discovery child, which is precisely why the child is
where it runs.

**How containment is enforced.** A path the browser named is refused outright when it is
absolute, then joined and checked lexically, and then the deepest ancestor that actually
exists is `realpath`ed and must still resolve inside the project — so a `denext.config.ts`
or an `app/` that is a symlink pointing out of the project is neither read nor written.
The same realpath gate (`uiSafeUnder`) is applied to the **absolute paths a planner
resolved for itself** — `generateArtifact`'s dry run, a Docker plan — because a lexical
check alone would have passed `<project>/app/x` while `app` pointed elsewhere. Every write
is a sibling `.tmp` file followed by one rename, so a reader never sees a half-written
file and a failed write leaves the previous bytes exactly as they were.

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

| Schema shape                    | Widget                                                                                                                                                      |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enum` (≤ 4 short values)       | Segmented radio group                                                                                                                                       |
| `enum` (longer)                 | Select, with "— unset —" first when optional                                                                                                                |
| `anyOf`                         | A branch picker, then the selected branch's form (`csp`, `hsts`, `compatibilityMode`)                                                                       |
| Array of `enum`                 | Checkbox group (`images.formats`)                                                                                                                           |
| Array of scalars                | Chips: add, remove, reorder (`publicEnv`, `i18n.locales`)                                                                                                   |
| Array of objects                | A typed sub-form per row with `↑` `↓` `✕` and `+ Add` (`redirects`, `rewrites`, `headers`, `images.remotePatterns`, `images.localPatterns`, `i18n.domains`) |
| `Record<string, T>`             | Key/value map rows (`scheduledTasks`, `experimental.features`)                                                                                              |
| Object with properties          | A collapsible group                                                                                                                                         |
| `boolean` / `number` / `string` | Toggle / number (with the schema's bounds) / text                                                                                                           |
| Anything opaque                 | A read-only code cell                                                                                                                                       |

### The two buckets

A top-level key whose value is a **data literal** is editable through those widgets. A key
whose value is **code** — a call, a callback, an imported binding — is shown verbatim in a
read-only code cell, because a form that round-trips it would have to regenerate it, and
regenerating code destroys it. That is why `plugins` (each entry is a live `setup`
function), `cache.store` (an object of methods), `live.authorize` and the other Live
callbacks, `mdx.remarkPlugins`/`rehypePlugins`/`recmaPlugins`, and `commands` (every entry
carries a `run` function, so the whole key is code) are never editable here.

The bucket is decided **per top-level key**, on the value as it is written in your file —
so one code-valued field makes its whole top-level key a read-only cell. A `cache` object
that names a custom `cache.store` is shown verbatim in full, `cache.ttl` included.

`plugins` is the one policy exception: it is data, but the [plugins panel](#plugins) owns
it, because adding an entry also means adding an import.

`redirects`, `rewrites` and `headers` are functions returning an array. The thunk is code,
so the wrapper is left exactly where it is — but the array it returns is unwrapped and its
rows edit like any other list. The `() => [ … ]` around them never moves.

### How a write happens

Nothing is regenerated. Every edit is a _splice_ through
[`src/build/config-edit.ts`](https://github.com/Brainwires/denext/blob/main/src/build/config-edit.ts):
locate the exact byte span of one value (or one array element), replace that span, leave
every other byte alone. **Outside the spliced value span nothing moves** — comments,
imports, blank lines, factory calls and hand-written helpers are the same bytes they were.

Inside it, they are not. Editing a key whose value is an object or a list re-serialises
that value, so a comment written _inside_ the value being replaced is lost with it. List
operations are the exception worth knowing: when the array carries a comment or an element
the writer cannot decode, it is spliced element by element and every surviving element
keeps its own source text; only when nothing is at risk is the array re-rendered whole.

Four module shapes are editable — `export default { … }`, `export default
defineConfig({ … })`, the factory form (`export default () => ({ … })`,
`export default function () { return { … } }`) and named config exports
(`export const basePath = "/x"`). Anything else is an honest **bail**: the panel says why
and quotes the offending snippet, and the file is left exactly as it was. It hands you a
copyable unified diff **when it can compute one** — an edit that found its key but refused
to overwrite code shows the patch it would have written; a module whose shape the splicer
does not recognise at all has nothing to diff against, so it shows the reason and the head
of the file instead.

Every write is two steps, and both run the whole _proposed_ config through
`validateDenextConfig`:

1. The first `POST` computes the new source and answers with a unified diff. Nothing has
   touched disk.
2. A second `POST` carrying `confirm=1` applies it and answers `303` back to
   `/config#<section>`.

A value the validator rejects is a `422` with the message rendered against its own field,
never a broken config on disk. At the bottom of the panel there is a raw-file escape
hatch: the whole file in a textarea, saved only if it still parses as a denext config.

Two more guarantees around the file itself. Every form carries `_base`, a SHA-256 of the
source it was rendered from: a `POST` whose stamp no longer matches what is on disk is a
`409` and writes nothing, so an edit you made in a real editor (or in a second tab) is
never silently lost — the `/api/config` twin can opt out by posting no `_base` at all. And
the write is a sibling `.tmp` file plus one rename, so nothing ever reads a half-written
config and a spliced source that no longer parses is refused before it reaches disk.

### The compat panel

`/config/next` reads a Next.js app's `next.config.*` and offers to translate it. It is
read-only by construction, and the reason matters: **denext never loads `next.config` at
runtime.** The drop-in path rewrites `next/*` imports; it does not adopt Next's config
file. Editing that file would change nothing, so the panel does not offer to.

The config is evaluated in a bounded subprocess rooted at the app's own directory (so its
npm plugin imports resolve), with read/env/sys and nothing else, and the result is shown
as two tables: the keys denext honors — under the same name (`cacheComponents`,
`basePath`, `trailingSlash`, `assetPrefix`, `images`, `i18n`) or as the inlined result of
a `redirects`/`rewrites`/`headers` thunk, each with a Translate button — and the keys with
no denext equivalent, each with a one-line pointer to where the behaviour went instead. "Translate" is not a second writer:
each button posts the honored value to `/config` as an ordinary section edit, so it lands
in the same diff-then-confirm path as everything else.

## Plugins

`/plugins` lists the first-party catalog —
[`src/plugin/catalog.json`](https://github.com/Brainwires/denext/blob/main/src/plugin/catalog.json),
generated from the workspace packages themselves (name, version, caret-pinned `jsr:`
spec, the factory export, the CLI verb it contributes, and its README's first paragraph
cut to 200 characters)
— next to what this project already has wired into `denext.config.ts` and pinned in
`deno.json`.

Adding is `deno add jsr:@denext/<pkg>@^<version>` plus the config wiring through the same
import-preserving injector `denext plugin add` uses; removing is the inverse, ending in
`deno remove`. Both are previewed first: the first `POST` shows the unified config diff
and the exact `deno` argv, and nothing runs until a `POST` carrying `confirm=1`. The
applied mutation answers `303 /plugins#<name>`, or streams the `deno` log over SSE when
the browser asks for it. The `deno add` / `deno remove` child gets a five-minute deadline
(a package server that never answers must not wedge the panel), and every child the UI
spawns dies with the request that started it and with the UI itself — nothing is
orphaned.

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
your config when you don't pick one. A generated Postgres service publishes
`127.0.0.1:5432:5432`, not `5432:5432` — a development database is reachable from your
machine and from nowhere else on the network.

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

**How the panel finds them.** Listing a project's verbs means importing its
`denext.config.ts` and running every plugin `setup()`, which is exactly the work the UI
process must never do. So the panel shells out: one `denext commands --json` child per
project directory, parsed and rendered. Overlapping page loads share a single child (eight
concurrent `/api/commands` calls spawn one subprocess, not eight), a **successful** listing
is reused for five seconds, and a timeout or a failure is never cached — the next request
tries again. A child that cannot start, overruns its budget, or prints nothing parsable
becomes a notice on the panel, never an empty page with no explanation.

`denext --help` does **not** list them — it refuses to import your project to render a help
table, and prints a one-line pointer at `denext commands` instead when it sees a config.
`denext completions bash|zsh|fish` still enumerates them (a shell can only complete a name
it was handed) under the same 1.5 s budget, then exits. **A built-in verb always wins a
name collision** — a `commands:` entry named `dev` is ignored, never shadowing the core
verb.

In the panel, a project or plugin verb that declares no required positional gets a Run
button and streams its output. Built-ins never do: `denext dev` would never exit, and its
output belongs in your terminal. Running a verb is a mutation — a verb may write anything
— so it is refused under `--read-only`, and it pays plugin discovery again in its own
child.

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
| `/`            | `GET` `HEAD`          | `/api/overview`        |
| `/config`      | `GET` `POST`          | `/api/config`          |
| `/config/next` | `GET`                 | `/api/config/next`     |
| `/plugins`     | `GET` `POST` `DELETE` | `/api/plugins`         |
| `/generate`    | `GET` `POST`          | `/api/generate`        |
| `/docker`      | `GET` `POST`          | `/api/docker`          |
| `/wizard`      | `GET` `POST`          | `/api/wizard`          |
| `/commands`    | `GET` `POST`          | `/api/commands`        |
| `/tasks/run`   | `POST`                | `/api/tasks/run` (SSE) |

Every answer carries `ok`. Beyond that the payload is the panel's own — a JSON twin
describes what its panel does, it does not flatten every panel into one shape:

| Twin               | A read answers                        | A mutation answers                                    |
| ------------------ | ------------------------------------- | ----------------------------------------------------- |
| `/api/config`      | `{ ok, file, form, keys, schema? }`   | `{ ok, applied, diff }` (a write adds `file`)         |
| `/api/config/next` | `{ ok, … }` the read next.config view | — (read-only)                                         |
| `/api/plugins`     | `{ ok, … }` the catalogue             | `{ ok, applied, diff, name, op, command, bailed, … }` |
| `/api/generate`    | `{ ok, kinds }`                       | `{ ok, written, skipped, preview? }`                  |
| `/api/docker`      | `{ ok, mode, files }`                 | `{ ok, mode, files, written, refused }`               |
| `/api/commands`    | `{ ok, timedOut, error?, commands }`  | `{ ok, verb, code, output }`                          |
| `/api/wizard`      | `{ ok, … }` the step view             | `{ ok, … }` the step outcome                          |

So `{ ok, applied, diff }` — the diff-then-confirm envelope — is what the two writers that
splice a file answer: `/api/config` and `/api/plugins`. Every refusal — `401` no cookie,
`403` bad origin, bad CSRF token or `--read-only`, `404` unknown path, `405` wrong method,
`409` the config changed on disk since the form was rendered, `422` a value the config
validator rejected, `500` an unexpected error — answers `{ ok: false, reason }`, with the
offending `field` and the would-be `diff` where there is one.

```sh
denext ui --no-open --json --port 0
# {"url":"http://localhost:54321/?t=…","port":54321,"token":"…"}
curl -s "http://localhost:54321/?t=$TOKEN" -D - -o /dev/null   # 302 + Set-Cookie
curl -s http://localhost:54321/api/config -b "denext_ui_token=$TOKEN" | jq .
```

The bind is always `127.0.0.1`; the printed URL says `localhost` because that is what a
browser (and the `Host` gate, which accepts either) wants.

Those envelopes are deliberate: they are the shape an MCP tool would front. Driving the
project UI from an agent is **not** in this release — the surface is only the HTTP API
above.

## What it does not do yet

| Not yet                      | Why                                                                                                                                 |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Compose YAML round-trip      | The Docker panel emits a compose file, never parses one; a hand-written file is left alone                                          |
| Per-plugin option schemas    | The catalog knows a plugin's factory and its option _keys_, not the shape of its options                                            |
| Third-party plugin discovery | Only the first-party catalog is browsable; wire others in by hand                                                                   |
| Agent / MCP control          | Deferred; every panel already answers a JSON twin so it can be added without changing the wire                                      |
| A denext app                 | The UI is a zero-bundler server-rendered `.ts` surface, not an App Router app — which is what lets it start instantly with no build |

## See also

- [CLI reference](/docs/cli) — every verb, including `ui`, `generate`, `plugin` and `doctor`
- [Configuration](/docs/config) — what each `denext.config.ts` key means
- [Writing a plugin](/docs/plugins) — the six seams, and the `addCommand` verb seam
- [Doctor & audit](/docs/doctor-audit) — the checks the wizard's doctor step runs
- [Deployment](/docs/deploy) — what to do with the Dockerfile the UI regenerates
- [Troubleshooting](/docs/troubleshooting) — when something refuses and the reason isn't obvious
