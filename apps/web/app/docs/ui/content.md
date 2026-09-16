---
title: Project UI
slug: ui
lead: denext ui serves a loopback GUI for the project in front of you — a schema-driven denext.config.ts editor that preserves your comments, plugin management with per-plugin option forms and JSR search, a GUI over generate, Docker regeneration plus an in-place compose editor, a setup wizard, and your project's own CLI verbs.
---

`denext ui` is a browser GUI for the project you are standing in — the `vue ui` idea,
served by denext's own CLI. It ships inside the package, works on a fresh clone with
nothing installed, and binds loopback only.

```sh
denext ui                    # serve the current project and open a browser
denext ui ./my-app --port 6000
denext ui --read-only        # browse; every mutation is refused
denext ui --offline          # nothing the UI starts reaches the network
denext ui --no-open --json   # print { url, port, token } and keep serving
```

The verb prints a URL carrying a one-time token, opens it, and serves until Ctrl+C
(or `SIGTERM`), which drains in-flight requests and releases the port. **One** Ctrl+C is
enough with pages open: the shutdown closes every `/_ui/events` stream first, so an open
tab's SSE connection cannot hold the drain.

## Flags

| Flag              | Default | What it does                                                                                                      |
| ----------------- | ------- | ----------------------------------------------------------------------------------------------------------------- |
| `[dir]`           | `.`     | The project directory to manage                                                                                   |
| `--port <port>`   | `5177`  | Port to listen on. `0` picks a free one                                                                           |
| `--no-open`       | off     | Don't launch a browser — print the URL instead                                                                    |
| `--read-only`     | off     | Refuse every mutation with a `403` before it runs                                                                 |
| `--offline`       | off     | Nothing the UI starts reaches the network — see [Working offline](#working-offline) (combines with `--read-only`) |
| `--token <token>` | minted  | Use this session token instead of a fresh 256-bit one (at least 22 characters)                                    |
| `--ui-dev`        | off     | Internal: watch `src/ui` and reload open pages on change (a checkout only)                                        |
| `--json` (global) | off     | Print `{ url, port, token }` as one JSON line, then keep serving                                                  |

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
| Headers                 | A strict CSP plus COOP, CORP, a `same-origin` referrer policy, `no-store`, `nosniff` on every response             |

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
`referrer-policy: same-origin`, `cross-origin-opener-policy: same-origin`,
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
and a package name must be one of the catalog's own — or, for a
[JSR add](#finding-third-party-plugins), a name that passes JSR's own naming rules, installed
at the version the registry reports, never one the browser sent.

`--read-only` prevents writes **by the UI**; it does not stop your own config from
executing inside that short-lived discovery child, which is precisely why the child is
where it runs.

**The one outbound request.** The UI process reaches the network for exactly one feature —
[JSR plugin search](#finding-third-party-plugins) — and only two pinned origins,
`https://api.jsr.io` and `https://jsr.io`. Each request carries no credentials, refuses every
redirect, has a five-second deadline that also covers reading the body, and reads at most
64 KiB of `application/json`; what comes back is normalised and escaped like any other
untrusted text. `denext ui --offline` turns it off (and keeps every process the UI starts off
the network too — see [Working offline](#working-offline)), and so does a process that does not
already hold net permission for the host a request needs (`api.jsr.io` to search, `jsr.io` to
add a package) — the UI queries that permission and never prompts for it. The page's CSP is unchanged: the browser still talks only to the UI
(`connect-src 'self'`), and the registry is called by the server.

**How containment is enforced.** A path the browser named is refused outright when it is
absolute, then joined and checked lexically, and then the deepest ancestor that actually
exists is `realpath`ed and must still resolve inside the project — so a `denext.config.ts`
or an `app/` that is a symlink pointing out of the project is neither read nor written.
The same realpath gate (`uiSafeUnder`) is applied to the **absolute paths a planner
resolved for itself** — `generateArtifact`'s dry run — because a lexical check alone would
have passed `<project>/app/x` while `app` pointed elsewhere. Every write — the config, a
plugin's options, the Docker files, a compose edit — goes back through `uiSafeJoin` and is a
sibling `.tmp` file followed by one rename, so a reader never sees a half-written file and a
failed write leaves the previous bytes exactly as they were.

> [!NOTE]
> On a shared machine, loopback is not a boundary: any local user can reach
> `127.0.0.1:5177`, and the session cookie is the only thing between them and a write. The
> token is 256 bits and is never printed except on your own terminal, but if you don't
> control every account on the box, run `denext ui --read-only`, or don't run it at all.

### Working offline

`denext ui --offline` keeps the UI **and every process it starts** off the network. The UI's
own JSR search is off, the denext-CLI children it starts are sandboxed, and an operation no
flag can sandbox is refused:

| Operation                                             | Under `--offline`                                                                                                                                    |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| JSR plugin search, a JSR add                          | The search box renders disabled with a note; `op=add-jsr` is a `503`                                                                                 |
| The commands listing, a verb run, the wizard's doctor | Runs as `deno run -A --deny-net --cached-only …`: no socket (a deny flag wins over `-A`, and it covers listening too) and no module download         |
| The wizard's `deno install`                           | Runs as `deno install --cached-only`: a fully cached project installs; anything else fails without fetching                                          |
| `deno task` (the wizard's Tasks step)                 | Refused with a `503` — a task is arbitrary shell, and no flag can keep it off the network                                                            |
| The wizard's "Start denext dev"                       | Refused with a `503` — a dev server needs net permission to listen                                                                                   |
| Plugin add and remove                                 | Refused with a `503`, preview included — `deno add` needs the registry, and `deno remove` can re-resolve the remaining dependencies over the network |

`--cached-only` is there because the net permission does not govern Deno's module loader: a
child denied net would still download an uncached import. A refused control renders disabled
with a short note, and the `503` (`{ ok: false, reason }` from a JSON twin) is the real gate.
What needs no network — the config editor, `generate`, Docker, the wizard's file writes —
works as usual. `--offline` combines with `--read-only`; a mutation under both is the
read-only `403`.

## Configuration editor

`/config` is a form generated from
[`denext.config.schema.json`](https://github.com/Brainwires/denext/blob/main/denext.config.schema.json)
— the same schema your editor uses for completions — with one collapsible section per
top-level key. Each field gets the control its type deserves:

| Schema shape                       | Widget                                                                                                                                                      |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enum` (≤ 4 short values)          | Segmented radio group                                                                                                                                       |
| `enum` (longer)                    | Select, with "— unset —" first when optional                                                                                                                |
| `anyOf`                            | A branch picker, then the selected branch's form (`csp`, `hsts`, `compatibilityMode`)                                                                       |
| Array of `enum`                    | Checkbox group (`images.formats`)                                                                                                                           |
| Array of scalars                   | Chips: add, remove, reorder (`publicEnv`, `i18n.locales`)                                                                                                   |
| Array of objects                   | A typed sub-form per row with `↑` `↓` `✕` and `+ Add` (`redirects`, `rewrites`, `headers`, `images.remotePatterns`, `images.localPatterns`, `i18n.domains`) |
| `Record<string, T>`                | Key/value map rows (`scheduledTasks`, `experimental.features`)                                                                                              |
| Object with properties             | A collapsible group                                                                                                                                         |
| `boolean` / `number` / `string`    | Toggle / number (with the schema's bounds) / one-line text                                                                                                  |
| `string` tagged `@widget textarea` | A multi-line textarea (`spa.head`, `spa.loading`)                                                                                                           |
| Anything opaque                    | A read-only code cell                                                                                                                                       |

The textarea is a JSDoc hint on the config type (`@widget textarea`) that the schema
generator records as `x-denext.widget`, so a multi-line string gets room without a
hand-written override. A value that starts with a newline keeps it: a browser drops the first
newline after `<textarea>`, so the control writes one back in front of the value (the raw-file
editor below goes through the same control).

### The two buckets

A top-level key whose value is a **data literal** is editable through those widgets. A key
whose value is **code** — a call, a callback, an imported binding — is shown verbatim in a
read-only code cell, because a form that round-trips it would have to regenerate it, and
regenerating code destroys it. That is why `plugins` (each entry is a live `setup`
function), `cache.store` (an object of methods), `live.authorize` and the other Live
callbacks, `mdx.remarkPlugins`/`rehypePlugins`/`recmaPlugins`, and `commands` (every entry
carries a `run` function, so the whole key is code) are never editable here. The schema still
describes `commands` in full — each entry's `flags` and `positionals` item by item — so your
editor completes them; the panel just won't rewrite a key that holds code.

The bucket is decided **per top-level key**, on the value as it is written in your file —
so one code-valued field makes its whole top-level key a read-only cell. A `cache` object
that names a custom `cache.store` is shown verbatim in full, `cache.ttl` included.

`plugins` is the one policy exception: it is data, but the [plugins panel](#plugins) owns
it, because adding an entry also means adding an import — and each wired first-party
plugin's options are edited on its own [options form](#plugin-options).

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

Each section's form carries three controls. **Save** is inert until you actually change
something: `ui.js` snapshots the form when the page renders and wakes Save on the first edit,
adding a **Discard** button beside it that puts the section back the way the server rendered it.
**Remove key** is a submit, not a form reset — it deletes that key from the config, which is why
it only appears when the key is set (it was called "Clear", which read like "clear the field").
With JavaScript off none of the tracking runs and Save simply works, so the server never renders
it disabled; under `--read-only` every one of them is disabled regardless.

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
spec, the factory export, the CLI verb it contributes, its README's first paragraph cut to
200 characters, and each plugin's options schema)
— next to what this project already has wired into `denext.config.ts` and pinned in
`deno.json`. A wired plugin the catalog does not know is listed under **Third-party**, with an
**Options** link when it comes from a JSR package.

Adding is `deno add jsr:@denext/<pkg>@^<version>` plus the config wiring through the same
import-preserving injector `denext plugin add` uses; removing is the inverse, ending in
`deno remove`. Both are previewed first: the first `POST` shows the unified config diff
and the exact `deno` argv, and nothing runs until a `POST` carrying `confirm=1`. The
applied mutation answers `303 /plugins#<name>`, or streams the `deno` log over SSE when
the browser asks for it. The `deno add` / `deno remove` child gets a five-minute deadline
(a package server that never answers must not wedge the panel), and every child the UI
spawns dies with the request that started it and with the UI itself — nothing is
orphaned.

Only catalogued names are accepted by `op=add` — a package name from the browser is matched
against the catalog before it can reach an argv array. A package found on JSR takes its own,
equally strict path: see [Finding third-party plugins](#finding-third-party-plugins).

### Plugin options

A wired first-party plugin gets an **Options** link to `/plugins/options?name=<package>`
(`/plugins/options` on its own lists every plugin that has an options form, linking the wired
ones). The form is built from the plugin's `optionsSchema` in the catalog — generated from
the options interface the package exports (see
[the first-party catalog](/docs/plugins#the-first-party-catalog)) — with the same widgets as
`/config`, each option's JSDoc as its help text, and the values your config passes today
filled in.

The plugin's call is read and written through
[`src/build/call-args-edit.ts`](https://github.com/Brainwires/denext/blob/main/src/build/call-args-edit.ts):
the same swc splice as the config writer, so the config is never evaluated and every byte an
edit does not touch — comments, the other plugins, the code around the call — stays.
`openapi()` becomes `openapi({ path: "/spec.json" })`; an existing `openapi({ … })` has
single keys set, changed or deleted in place.

- **Per-field writes.** The form is diffed against the file field by field and only what you
  changed is written, so keys the schema does not declare and options the form does not show
  are never touched. Clearing a field deletes its key. An untouched toggle or an empty list
  over an option your config does not set writes nothing — a toggle over an unset option is
  written only when you switch it on.
- **Code stays code.** An option whose value is code — a callback, a variable, a call — is
  listed under _Code-valued options_ with its source, read-only, and never rewritten. So is
  any part of the schema a form cannot round-trip: a `{}` (a type the generator could not
  describe) or a function-wrapped list (openapi's `tags`) renders as a disabled cell.
- **An honest bail.** A call the writer cannot own — spread arguments, a variable or a call as
  the argument, an options object that spreads another, more than one argument, two calls to
  the same factory, a member call like `x.openapi()` — is a `422` with the reason and the
  offending source, and nothing is written. Pass the plugin one object literal to edit it
  here.
- **Preview, then confirm.** The first `POST` answers with the unified diff and a confirm
  form carrying the exact writes; the second (`confirm=1`) re-reads the file and re-applies
  them. Both carry `_base`, the SHA-256 of the source the form was rendered from: a stale one
  is a `409` and writes nothing.

A plugin that is not catalogued with an options schema, or not wired into the config, is a
`404`. The panel knows a plugin is wired by its import: a plain
`import { openapi } from "@denext/openapi"`, an aliased one (`import { openapi as oa } …`, whose
options are then written into `oa(…)`) or one from a full `jsr:` specifier. The JSON twin, `/api/plugins/options?name=…`, reads
`{ ok, name, callee, values, codeKeys, schema }` and takes `sets: [{ path, value }]` (a set
with no `value` deletes the key), plus `confirm: true` to write.

### Finding third-party plugins

The bottom of `/plugins` searches JSR. The search box is a plain `GET` form
(`/plugins?q=…`), so it works with JavaScript disabled and under `--read-only`; the
`/api/plugins` twin carries the outcome as `jsr: { available, query, search? }`. Each hit
shows its scope and name, its latest version, an _archived_ badge when JSR says so, its
description as plain text (control, zero-width and bidi characters removed, cut to 300
characters), and an **Add** form naming the factory export to wire — the camelCased package
name unless you change it.

Adding one posts `op=add-jsr`, and the browser supplies exactly two values, both validated
before any request or subprocess:

- `spec` — `@scope/name` under JSR's own naming rules: a 2–20-character scope and a
  2–58-character name of `[a-z0-9-]`, with no leading, trailing or doubled hyphen. Anything
  else is a `400`.
- `export` — the factory to import, which must be a JavaScript identifier and not a
  reserved word (`400` otherwise).

The version never comes from the form. The UI reads the package's `latest` from
`https://jsr.io/@scope/name/meta.json` in the same request — the preview and the confirm each
look it up — and plans `deno add jsr:@scope/name@^<latest>` plus the same import-preserving
wiring as a catalog add: a zero-argument `factory()` call in `plugins`. A registry that cannot
be reached, or answers with anything but a valid version, is a `502`; a UI that may not query
JSR answers `503`. From there it is the catalog's path — preview, confirm, `303` or a
streamed `deno` log.

A third-party JSR plugin gets an options form when its package publishes one — a
`denext.catalog.optionsSchema` (a plain JSON Schema) in its `deno.json` or `jsr.json`; see
[Publishing an options schema](/docs/plugins#publishing-an-options-schema). The UI reads that
file from `jsr.io` for the version `deno.lock` resolved (else the latest), keeps only the keys
the form reads, and caches it for five minutes. Offline, or for a package that publishes none,
its options stay in `denext.config.ts`.

**Offline.** Under `denext ui --offline` the search box renders disabled with a note, nothing
is fetched, and `op=add-jsr` is a `503` — as is a catalog add or remove (see
[Working offline](#working-offline)). Search degrades the same way on its own when the process
does not hold net permission for `api.jsr.io`, and adding a JSR package when it lacks `jsr.io` —
the UI checks the permission and never prompts.

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

`/docker` does two things with the Docker files: it **regenerates** `Dockerfile`, the compose
file and `.dockerignore` from a few options, and it **edits** an existing compose file in
place, service by service. The compose file is the one Docker Compose would pick —
`compose.yaml`, `compose.yml`, `docker-compose.yaml`, then `docker-compose.yml` — and a new one
is written as `docker-compose.yml`.

### Regenerating

The options are the image mode (`server` — build plus `deno task start`; `static` — `deno task
export` plus a file server), the exposed port, the `denoland/deno:` tag to pin, and
whether to emit a real Postgres service. The mode is auto-detected from `mode: "spa"` in
your config when you don't pick one. A generated Postgres service publishes
`127.0.0.1:5432:5432`, not `5432:5432` — a development database is reachable from your
machine and from nowhere else on the network.

Every file is shown with its state and a per-file unified diff against what is on disk
before anything is written:

| State       | Meaning                                                                                  |
| ----------- | ---------------------------------------------------------------------------------------- |
| `absent`    | Not present — will be created                                                            |
| `generated` | Still carries the generated-file sentinel — safe to regenerate                           |
| `edited`    | Hand-edited — will not be overwritten                                                    |
| `opaque`    | A hand-edited compose file the editor cannot follow — read-only, will not be overwritten |

The sentinel is a header comment every generated file carries:

```
# Generated by `denext generate docker`
```

A file without it was written or edited by a human, so a write refuses to touch it — and
shows you its diff anyway, so the change can be copied across by hand. That is the same
never-clobber honesty `denext migrate` and the config writer apply.

### Editing the compose file in place

Below the regeneration form, every service in the compose file gets its own form, in
source order: `image` (text), `restart` (`no`, `always`, `on-failure`, `unless-stopped`, or the
file's own value — `on-failure:<n>` is accepted too), `build` (its context path, plus a
`dockerfile` and a `target` — setting either writes a mapping `build:` — and a row editor for
the build args), and row editors for `ports`,
`environment`, `depends_on` (a picker of the file's other services, and for each dependency the
`condition` it waits for), `volumes` and `networks` (one the top-level `networks:` doesn't
declare gets a warning, like an undeclared named volume). A long-syntax port or volume (a
mapping such as `target: 80` / `published: "8080"`) is edited key by key: a text input per key
the form knows, and a picker where Compose fixes the choices (`protocol`, `mode`, `type`,
`read_only`). Keys it doesn't know are kept as written.

A service can be removed (refused while another service depends on it) or commented out. A
commented-out block — the Postgres example the generated file carries, say — can be enabled
again or removed, and those are the only edits it accepts. Below the services, **Add a service**
takes a name and an image, a build context or both. **Named volumes and networks** declares and
drops the top-level `volumes:` and `networks:` entries; dropping one a service still uses is
refused.

Nothing is regenerated. [`src/build/compose-edit.ts`](https://github.com/Brainwires/denext/blob/main/src/build/compose-edit.ts)
parses the file with `@std/yaml` to validate it, locates each service and field line by line
with an indentation-aware scan keyed on the parsed names, splices only the lines an edit
touches, then re-parses the result and compares it with the same change applied to the
parsed model — a mismatch is a refusal, never a write. Comments, blank lines, quoting and
every untouched line stay byte for byte. `environment` keeps the form it was written in (a
`- KEY=value` list or a `KEY: value` map); a new port mapping is always double-quoted
(`5432:5432` unquoted is a number to a YAML 1.1 reader). A long-form `depends_on` or
`networks:` (a mapping) gains and loses entries in that form, and choosing a `condition` on a
short `depends_on` list rewrites it in the long form. A flow-style field (`ports: ["80:80"]`,
`environment: { A: "1" }`) is edited in place and keeps its style, even across lines; a
flow-style `services:` is rewritten as block mappings by the first edit.

Each submit is one edit set for one service — every field that differs from the file, every
filled add row, and the button you pressed — and it takes the usual two steps. The first
`POST` answers with the unified diff, plus a warning when an enabled service mounts a named
volume or joins a network that the top-level `volumes:` or `networks:` does not declare
(`docker compose up` refuses such a file). The confirm re-posts the same operations — never the edited text — re-reads the file,
and writes only when they still apply. Both carry `_base`, the SHA-256 of the file the page
was rendered from: a stale one is a `409` and writes nothing. Every service, variable, row
and dependency a request names is checked against the parsed file first, so the editor never
writes one the file did not report (a `400` otherwise).

Anchors, aliases and merge keys are followed:

- A service lists the fields it takes from a merge key (`<<`), and setting one writes an
  override into the service.
- Editing a list or map that an alias (`ports: *shared`) or a merge key supplies gives the
  service its own copy of it, with the edit applied.
- A service written as an alias (`web2: *web`) or as a flow mapping (`web: { image: x }`) is
  rewritten as a block mapping by its first edit.
- Editing a node that an alias repeats elsewhere is allowed, and the preview names what else it
  changes.

Every line keeps the line ending it had, so a file that mixes LF and CRLF stays exactly as mixed.
A single document may open with `---` and close with `...`, and Compose's `!reset` and
`!override` tags are read.

A file the editor cannot follow line by line is **opaque**. It gets the regeneration view it
always had: the file shown read-only next to the regeneration diff, with no edit form, and the
reason. That is a file that:

- does not parse (two YAML documents in one file do not);
- has a top level that is not a mapping, or a `services:` that is not a mapping of services;
- puts content on a document marker (`--- {…}`).

A file that still carries the sentinel is editable as well, with a note: **Write files**
regenerates it and discards edits made here, so delete the header line to keep them.

`GET /api/docker` returns the parsed `model` (`null` for a missing or opaque file) and its
`base` alongside the regeneration view. A compose edit on the twin is a `POST` with
`editor: "compose"` and `ops`, at most 100 per request, plus `base` and `confirm: true` to
write. The ops come from a closed set:

- `set`: `image`, `restart` or `build`;
- `ports`;
- `entry`: one key of a long-syntax port or volume;
- `env`;
- `dependsOn`, optionally with a `condition`;
- `condition`;
- `volumes`;
- `networks`;
- `toggleService`;
- `addService` and `removeService`;
- `build`: a mapping `build:`'s `context`, `dockerfile` or `target`;
- `buildArg`;
- `declare`: a top-level volume or network.

Deployment targets, images and platform notes are in the [deployment guide](/docs/deploy).

## Desktop

`/desktop` sets up code signing for a packaged desktop build: macOS, Windows and Linux as three
views of one panel (`?tab=`). It reads what your machine has and composes the command — it runs
no build and writes no file.

The packaging scripts `denext create --desktop` writes (`scripts/package-*.ts`) have always been
driven by `DENEXT_*` environment variables, and nothing told you what to put in them. A project
without those scripts is told so, rather than shown controls that cannot do anything.

**macOS.** The panel lists the Developer ID Application identities actually in your keychain, so
`DENEXT_CODESIGN_IDENTITY` becomes a value you copy rather than a string you have to know. Only
Developer ID Application certificates are listed: a developer Mac usually also holds an
`Apple Development` certificate, and a build signed with that one neither distributes nor keeps
its permission grants. That last point is the reason to bother — macOS keys **TCC** grants
(Screen Recording, Accessibility, Input Monitoring) to the signing identity, so an unsigned or
ad-hoc-signed app changes identity on every rebuild and has to be re-approved every time.
Gatekeeper and TCC are different mechanisms: notarization (`DENEXT_NOTARY_PROFILE`) is what
quiets Gatekeeper on someone else's Mac; a stable identity is what keeps permissions.

**Windows.** `DENEXT_WINDOWS_CERT` (a `.pfx` path), `DENEXT_SIGN_TIMESTAMP_URL` and whether
`signtool` is on `PATH`.

**Linux.** Nothing to configure — packaging produces a `.tar.gz` (optionally an AppImage) and
there is no signing step.

**One value this panel will never take.** Of the six variables the scripts read, exactly one is a
true secret: `DENEXT_WINDOWS_CERT_PASSWORD`. It has **no field** here, its value is never read —
only whether it is set, via `Deno.env.has` — and it is absent from the JSON twin as well. The
macOS identity and notary profile are _names_: the private key and the notary credentials stay in
your keychain, so those values are safe to show, and showing them is the point. Set the password
in your own shell or CI.

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
| Finish                | Whether the dev server is up                                                                                                      | Starts `denext dev`, shows its console, offers **Stop**                                                                   |

Nothing in the wizard imports a project module: detection is filesystem probing, and
doctor, `deno install` and `denext dev` all run as subprocesses. Under `--offline`, doctor
runs without net, `deno install` runs `--cached-only`, and the Tasks and Finish buttons are
disabled ([Working offline](#working-offline)). See [Doctor & audit](/docs/doctor-audit) for
what the checks mean.

**The dev server, and stopping it.** Starting `denext dev` answers _in place_ rather than
redirecting, and the step keeps a `<pre class="out">` that the server's output streams into over
SSE. Those lines are also retained in the UI's memory, so a reload, a second tab, or a panel swap
shows what has been printed so far instead of an empty box. A redirect used to discard all of it: it
rebuilt the document and took `ui.js`'s single `EventSource` and the output block with it, which is
what made starting a dev server look like it did nothing at all.

While a server is running the step offers **Stop**, and that works even after `denext ui` has itself
been restarted: the dev server records its own pid in `.denext/dev.json`, so stopping never needs
the child's process handle. Nothing is signalled until the address that file names answers as a
denext dev server — a stale file is cleared instead, because the pid it carries may since have been
handed to an unrelated process. Stopping asks the server to drain first and kills the process tree
only if it will not; on Windows, which has no such signal, it is a hard kill and says so.

## Cron

`/config/cron` is the Config panel's Cron tab: every cron schedule this project registers at
server startup, when each next fires, and which of them will not fire at all.

A schedule reaches the scheduler from one of two places, and the tab is explicit about which:

| Source                                          | Shown | Editable                                        |
| ----------------------------------------------- | ----- | ----------------------------------------------- |
| `scheduledTasks` in `denext.config.ts`          | yes   | yes — through the `scheduledTasks` editor       |
| `schedule:` inside a task's `defineTask({ … })` | yes   | no — it is code, and the UI never rewrites code |

The listing comes from one subprocess (`denext task --list --json`), never from this process:
listing tasks means importing the project's task modules. The child returns the schedule
`collectSchedules` computes — the same function the server calls at boot — so the tab shows what
will really happen rather than re-deriving the merge.

Two kinds of entry are flagged **never fires**, because the scheduler skips them at startup with
nothing more than a log line: a malformed cron expression, and a schedule naming a task that is
not defined. Times are UTC, which is what `Deno.cron` and the userland scheduler both use.

The config half is editable here: one row per schedule — the expression, the task it runs, and a
box that drops it — plus a blank row to add another. Every expression is parsed before anything is
written and every task name is checked against the tasks that actually exist, so a schedule that
could never fire is refused rather than saved. The write is the same one the
[configuration editor](#configuration-editor) performs: `setConfigValue` splices the key, you get
a unified diff to review, and only a confirm writes — atomically, and refused with a `409` if the
file changed since the form was rendered.

**The preview follows what you type.** With JavaScript on, editing an expression asks the server
what it means and when it next fires, and puts the answer beside the field. The field itself is
never replaced, so it keeps focus and whatever you have typed so far — which is why the client
fetches that one block rather than re-rendering the panel. The reading is the server's own
`describeCron` and `nextRuns`, fetched from `/_ui/cron-preview`; the client module parses no cron
expressions at all, and that is the only way the live preview and the page you eventually save
cannot disagree. With JavaScript off the same block is rendered on load and after every submit, so
nothing is missing — only the round trip.

Removing every schedule is its own button. An empty form is refused instead, because a dropped
field or a stale tab would otherwise read as "delete them all". See
[Scheduled tasks](/docs/tasks) for the feature itself.

### Run history

The tab can also answer what actually ran, and whether it worked — but only if the project asks.
Run history is **off by default**: denext records nothing and writes no file until you turn it on,
so upgrading never gives an app a side effect nobody requested.

Turning it on from this tab writes `tasks: { history: true }` to your denext config through the
same diff-then-confirm as everything else here — you see the exact change before anything lands.
From then on every run is recorded, scheduled and manual alike, into `.denext/tasks.db`, and the
tab shows each task's last result, how long it took, and its successes and failures over the last
seven days.

Two things are worth knowing. It takes effect **the next time the app starts**, including under
`denext dev`: the recorder is installed at server boot, and the dev server's watcher re-bundles
routes without re-running task boot. And recording can never fail or delay a run — a read-only
filesystem, a full disk or a locked file degrades to no history rather than to a broken job.

The tab distinguishes four states rather than showing one empty table: history off, on but nothing
recorded yet, on with no runs inside the window, and on with results. "Off" and "on but nothing
yet" are different facts, and reading one as the other is how you end up waiting for data that was
never going to arrive.

Clearing is its own button, and its own two steps: the first press says how many runs will go and
asks you to confirm, the second deletes them. It is a `DELETE`, not a file unlink — the running app
may hold that database open — so the database survives and recording simply continues. Your denext
config is not touched, and nothing about the schedules changes.

On Deno Deploy it records and says so: `.denext/tasks.db` is per-isolate and ephemeral there, so
what you see is one isolate's fragment that resets when it cycles. A history that is quietly wrong
is worse than none, so the caveat is printed at boot rather than the setting being ignored.

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
becomes a notice on the panel, never an empty page with no explanation. The whole discovery
child gets 8 seconds; `DENEXT_UI_DISCOVERY_TIMEOUT_MS` raises that on a slow or busy machine.

`denext --help` lists them too, and still imports nothing: `denext commands` records what it
found in `.denext/commands.json`, with a fingerprint of `denext.config.*`, `deno.json` and
`deno.lock`, and help prints that listing while the fingerprint holds. Before the first run — or
once one of those files changes — help prints a one-line pointer at `denext commands` instead.
A plugin that changes which verbs it contributes without any of those files changing is the one
case a listing can be stale, so the footer under it says where it came from.
`denext completions bash|zsh|fish` enumerates them live instead (a shell can only complete a
name it was handed) under the same 1.5 s budget, then exits. **A built-in verb always wins a
name collision** — a `commands:` entry named `dev` is ignored, never shadowing the core
verb.

In the panel, every project or plugin verb gets a run form built from what it declares: a
checkbox per boolean flag, a number input per number flag, a text input per string flag, one
input per positional, and a row editor (`+ Add`, `✕`) for a variadic one. A required
positional is a required field, so a verb that needs an argument runs from the panel too.
Built-ins never get a run form — `denext dev` would never exit, and its output belongs in your
terminal — so the panel lists their arguments and flags instead. A run streams its output.

The argv is built on the server from the **refreshed** listing, never from the form's idea of
which flags exist: a field the verb does not declare is ignored, every value is its own argv
element (no shell, and no `--name=value` built from browser text), and a flag that shares a
name with one of the CLI's global flags (`--cwd`, `--config`, `--json`, `--verbose`,
`--quiet`) or with `--help` / `--version` is never offered — the UI pins `--cwd` itself. A
positional may not start with `-`, a number must be finite, and a required positional left
blank is refused: each is a `422` naming the field (`pos:0`, `flag:rows`), and nothing is
spawned. A JSON client posts the same names as keys:
`{ "verb": "seed", "flag:rows": 5, "pos:0": "users" }`.

Running a verb is a mutation — a verb may write anything — so it is refused under
`--read-only`. Each run is its own `deno` child, which costs the same plugin discovery as
running the verb in your terminal: the panel never runs your code in the UI's process, every run
starts from fresh module state, and a run can be cancelled by killing that child. Under `--offline` both
children — the listing and every run — start with `--deny-net --cached-only`, so a verb that
needs the network fails rather than reaching it.

## Working without JavaScript

Every panel is a real `<form method="post">`, and every action completes with JavaScript
disabled. A write answers `303` back to the anchor it changed (POST/redirect/GET, so a
reload never re-applies it); a preview re-renders the page with the diff in place; list
editors submit real buttons (`op=add|remove|up|down` plus the row index) and the server
applies the operation, validates, and re-renders.

The one deliberate exception is the Finish step's dev-server actions, which re-render in place: a
redirect there would rebuild the document and take the output sink with it, so the server's console
would stream to a page that no longer exists. Re-posting them is harmless — starting is idempotent,
and stopping an already-stopped server simply says so.

The one client module, `/_ui/ui.js`, is progressive enhancement only. It upgrades those
same submits to `fetch` with `Accept: text/html-fragment` and swaps the returned
`<section id="panel">` in place, so the server keeps exactly one rendering path. The
returned fragment is parsed with `DOMParser` and adopted as nodes — untrusted text is
never assigned to `innerHTML`. Long-running work (a `deno task`, a `deno add`, `denext
dev`) streams over SSE at `/_ui/events`.

**Navigation, when JavaScript is on.** A click on a same-origin link — the sidebar, a panel's
tabs, a filter — is taken over: the panel is fetched as a fragment, swapped in place, and the
address updated with `history.pushState`, so Back and Forward work and no page is ever rebuilt.
The fragment is only the `<section id="panel">`, so the two things that live outside it are
carried separately: `aria-current` moves to the sidebar entry for the path now on screen, and the
document title rides along in an `x-ui-title` header (URI-encoded, because a header is a byte
string and a title is not always latin-1). Anything the browser should own is declined — a
modified click, a new tab, a download, a cross-origin address, a jump to an anchor on this same
page — and a response that is not a panel hands the address straight back to the browser, so the
enhancement can never strand you on a page that will not move. With JavaScript off these are
ordinary links, and every one of them still works.

A search or filter box is the same idea with fields attached: submitting one builds its `?q=`
address and swaps the results in place instead of navigating. That swap replaces the whole panel —
the box included — so the caret is put back where it was, and a second keystroke lands where you
expect it to. The filtering itself stays on the server: `matchesTerms` is the only implementation
of how a query matches, and a copy in the client module could only ever come to disagree with it.

**How the views are built.** Every panel is a component tree built with `h()` from denext's
own JSX runtime, in plain `.ts` modules, and rendered once to a string on the server. That
changes nothing on the wire: there is still no client bundle, no hydration and no island,
`/_ui/ui.js` is the only script, and every page works with it switched off.

## The JSON API

Every feature path has an `/api/*` twin served by the _same handler_ with JSON output, so
the browser and a machine client exercise identical code:

| Path               | Methods               | JSON twin              |
| ------------------ | --------------------- | ---------------------- |
| `/`                | `GET` `HEAD`          | `/api/overview`        |
| `/config`          | `GET` `POST`          | `/api/config`          |
| `/config/next`     | `GET`                 | `/api/config/next`     |
| `/config/cron`     | `GET` `POST`          | `/api/config/cron`     |
| `/plugins`         | `GET` `POST` `DELETE` | `/api/plugins`         |
| `/plugins/options` | `GET` `POST`          | `/api/plugins/options` |
| `/generate`        | `GET` `POST`          | `/api/generate`        |
| `/docker`          | `GET` `POST`          | `/api/docker`          |
| `/desktop`         | `GET`                 | `/api/desktop`         |
| `/wizard`          | `GET` `POST`          | `/api/wizard`          |
| `/commands`        | `GET` `POST`          | `/api/commands`        |
| `/tasks/run`       | `POST`                | `/api/tasks/run` (SSE) |

Every answer carries `ok`. Beyond that the payload is the panel's own — a JSON twin
describes what its panel does, it does not flatten every panel into one shape:

| Twin                   | A read answers                                                                        | A mutation answers                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `/api/config`          | `{ ok, file, form, keys, schema? }`                                                   | `{ ok, applied, diff }` (a write adds `file`)                                                    |
| `/api/config/next`     | `{ ok, … }` the read next.config view                                                 | — (read-only)                                                                                    |
| `/api/config/cron`     | `{ ok, tasks, schedules, configScheduled, denoCron }`                                 | `{ ok, applied, diff, scheduledTasks }` — the diff-then-confirm envelope                         |
| `/api/plugins`         | `{ ok, installed, catalog, config, jsr }`                                             | `{ ok, applied, diff, name, op, command, bailed, … }`                                            |
| `/api/plugins/options` | `{ ok, name, callee, values, codeKeys, schema }` (`{ ok, plugins }` with no `?name=`) | `{ ok, applied, diff, values }`                                                                  |
| `/api/generate`        | `{ ok, kinds }`                                                                       | `{ ok, written, skipped, preview? }`                                                             |
| `/api/docker`          | `{ ok, mode, files, model, base }`                                                    | `{ ok, mode, files, written, refused }`; a compose edit `{ ok, applied, model, warnings, diff }` |
| `/api/commands`        | `{ ok, timedOut, error?, commands }`                                                  | `{ ok, verb, code, output }`                                                                     |
| `/api/wizard`          | `{ ok, … }` the step view                                                             | `{ ok, … }` the step outcome                                                                     |

So `{ ok, applied, diff }` — the diff-then-confirm envelope — is what the writers that
splice a file answer: `/api/config`, `/api/plugins`, `/api/plugins/options`, and a compose
edit on `/api/docker`. Each of those checks `_base` (`base` on the compose twin) when it is
posted, and a JSON client may opt out of the stale-file check by posting none.

Every refusal — `400` a malformed request (an unknown plugin, operation or compose service, a
bad JSR name or export), `401` no cookie, `403` bad origin, bad CSRF token or `--read-only`,
`404` unknown path or a plugin with no options form, `405` wrong method, `409` the file
changed on disk since the form was rendered, `422` a value the config validator rejected, a
plugin call the options writer cannot own, or a command argument the run refused, `500` an
unexpected error, `502` a JSR lookup that failed, `503` JSR discovery unavailable — answers
`{ ok: false, reason }`, with the offending `field` and the would-be `diff` where there is
one.

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

| Not yet                      | Why                                                                                                                                                                                                      |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compose edits beyond the set | A service field outside the editor's set — `command`, `healthcheck`, `labels`, `env_file`, `deploy` and the rest — is edited by hand                                                                     |
| YAML the editor can't follow | Several YAML documents in one file make the file opaque: read-only, with the reason and the regeneration diff                                                                                            |
| Code-valued options          | A callback, a variable, a `{}` schema part or a function-wrapped list is shown read-only, never rewritten                                                                                                |
| Capacitor / mobile signing   | `denext` scaffolds a Capacitor project and opens it in Xcode or Android Studio; everything past `cap open` — provisioning profiles, keystores — is yours. There is no mobile signing seam to surface yet |
| Agent / MCP control          | Deferred; every panel already answers a JSON twin so it can be added without changing the wire                                                                                                           |
| A denext app                 | The UI is server-rendered components built with `h()` — no bundler, no hydration — not an App Router app, which is what lets it start instantly with no build                                            |

## See also

- [CLI reference](/docs/cli) — every verb, including `ui`, `generate`, `plugin` and `doctor`
- [Configuration](/docs/config) — what each `denext.config.ts` key means
- [Writing a plugin](/docs/plugins) — the six seams, and the `addCommand` verb seam
- [Doctor & audit](/docs/doctor-audit) — the checks the wizard's doctor step runs
- [Deployment](/docs/deploy) — what to do with the Dockerfile the UI regenerates
- [Troubleshooting](/docs/troubleshooting) — when something refuses and the reason isn't obvious
