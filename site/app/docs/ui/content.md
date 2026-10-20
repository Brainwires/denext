---
title: Project UI
slug: ui
lead: denext ui serves a loopback GUI for the project in front of you — a schema-driven denext.config.ts editor that preserves your comments, a Cron page for schedules and run history, plugin management with per-plugin option forms and JSR search, a GUI over generate, Docker regeneration plus an in-place compose editor, a Desktop signing panel, a Setup page that readies a fresh clone, a Dev page for the dev server, a Tasks page for your deno.json scripts, a Services page for the supervised services/ tree, a Database section for a Postgres project (tables and rows, SQL, policies, migrations, storage, users, realtime, Edge Functions, logs and health, also served on its own as the password-gated denext dashboard), and your project's own CLI verbs.
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

| Layer                   | What it enforces                                                                                                                                                                                                                                   |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bind                    | `127.0.0.1` only, and the printed URL says `127.0.0.1` too — never `localhost`. There is no `--host` — see the note below                                                                                                                          |
| Host + `Sec-Fetch-Site` | The `Host` the browser sent must name a loopback interface. A present `Sec-Fetch-Site` must read `same-origin`, except that `none` — a navigation the user started themselves, which no other site's page can produce — is accepted for a **read** |
| Session token           | A per-launch 256-bit token, handed over once in `?t=` and exchanged for an `HttpOnly; SameSite=Strict` cookie holding a **second, freshly minted** secret — the token itself is never accepted as a cookie                                         |
| CSRF                    | Every mutation needs a same-origin `Origin`/`Referer` plus a token derived as `HMAC-SHA256(cookieSecret, "csrf")`                                                                                                                                  |
| Containment             | Every project path goes through `uiSafeJoin` / `uiSafeUnder` — see below                                                                                                                                                                           |
| Headers                 | A strict CSP plus COOP, CORP, a `same-origin` referrer policy, `no-store`, `nosniff` on every response                                                                                                                                             |

**Why no `--host`.** A project GUI that writes files is a remote-code-execution surface
by construction: it edits `denext.config.ts`, scaffolds modules, and spawns `deno`. There
is no configuration under which exposing that to a network is the right default, so the
bind address is not configurable. Reach it from another machine with an SSH tunnel
(`ssh -L 5177:127.0.0.1:5177 host`), which keeps authentication where it belongs.

**The token handshake.** The URL the verb prints ends in `?t=<token>`. The first request
carrying it gets a `302` to `/` — the overview, always, whatever path the link carried, so
nothing from the request reaches the `Location` header — with a **fresh** 256-bit secret
parked in an `HttpOnly; SameSite=Strict; Path=/` cookie. The cookie never holds the launch
token: a cookie set by a loopback host is sent to every port of that host, so whatever the
browser sends to the project's own `denext dev` (or anything else listening on the machine)
must not be the credential the launcher printed. Serving the UI at `127.0.0.1` rather than
`localhost` keeps even that second secret off the name every other local server shares.
The launch token itself never survives in the address bar, in `document.referrer`, in
history, or in a link you paste to someone, and takes part in nothing after the exchange.
The exchange is **single-use**: once it has run, a `?t=` is honoured only for a caller that
already holds the session cookie (the same tab re-opening its own link), so replaying the
copied URL in another browser is a `401`, not a second session. A request without the
cookie is a `401` before any route runs; a bad `Host` or a cross-site caller is a `403`
before the token is even consulted. Pages publish the CSRF token — derived from the cookie
secret — as `<meta name="denext-csrf">`; forms post it in a hidden `_csrf` field and `fetch`
sends it in `x-denext-ui-csrf`.

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
> launch token is 256 bits and is never printed except on your own terminal, and the cookie
> secret is another 256 bits that only your browser ever holds — but if you don't control
> every account on the box, run `denext ui --read-only`, or don't run it at all.

Every write also preserves the file's permission bits: the atomic write's temp file is given
the mode of the file it replaces, so a `0600` config stays `0600` after an edit (a new file
takes the default mode).

### Working offline

`denext ui --offline` keeps the UI **and every process it starts** off the network. The UI's
own JSR search is off, the denext-CLI children it starts are sandboxed, and an operation no
flag can sandbox is refused:

| Operation                                        | Under `--offline`                                                                                                                                    |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| JSR plugin search, a JSR add                     | The search box renders disabled with a note; `op=add-jsr` is a `503`                                                                                 |
| The commands listing, a verb run, Setup's doctor | Runs as `deno run -A --deny-net --cached-only …`: no socket (a deny flag wins over `-A`, and it covers listening too) and no module download         |
| Setup's `deno install`                           | Runs as `deno install --cached-only`: a fully cached project installs; anything else fails without fetching                                          |
| `deno task` (the Tasks page)                     | Refused with a `503` — a task is arbitrary shell, and no flag can keep it off the network                                                            |
| The Dev page's "Start denext dev"                | Refused with a `503` — a dev server needs net permission to listen                                                                                   |
| Plugin add and remove                            | Refused with a `503`, preview included — `deno add` needs the registry, and `deno remove` can re-resolve the remaining dependencies over the network |
| The Database section                             | Refused with a `503` — reaching a database, even one on this machine, is a network connection (Logs excepted: `docker compose logs` stays local)     |

`--cached-only` is there because the net permission does not govern Deno's module loader: a
child denied net would still download an uncached import. A refused control renders disabled
with a short note, and the `503` (`{ ok: false, reason }` from a JSON twin) is the real gate.
What needs no network — the config editor, `generate`, Docker, Setup's file writes —
works as usual. `--offline` combines with `--read-only`; a mutation under both is the
read-only `403`.

## Configuration editor

`/config` is a form generated from
[`denext.config.schema.json`](https://github.com/Brainwires/denext/blob/main/denext.config.schema.json)
— the same schema your editor uses for completions. **Configuration** is a section of the
sidebar rather than a single destination: each view — Routing, Rendering, Security, Advanced and
Cron — is its own page at `/config/<view>`. `/config` itself is an index of those views, a card
each, and is where the overview's **Configuration** card points; its `/api/config` twin is
unchanged and still answers with the editor's payload.

A view carries **one** strip of tabs, directly under its heading, listing the keys of that view —
the views themselves are the sidebar's job, so nothing on the page repeats them. The first tab,
**General**, holds the view's plain scalars together under one Save; every key that wants more
room follows with a tab of its own, and each tab says whether its key is set. **Nothing
collapses**, and nothing sits outside the tabs. A view opens on General.

General's shared Save writes several keys at once. The edits are chained through an evolving source and
diffed once, so you review one diff; if any one of them cannot be spliced the whole submit is
refused and nothing is written. Clearing a field you submitted removes its key — which is what
General offers instead of a per-key "Remove key", the button a grouping's own tab still has.

Three deliberate exceptions, all about not writing something you did not ask for. A key whose
field the submit never **carried** is left alone: a browser posts every control the band rendered,
but the `/api` twin takes whatever a caller sends, and a cleared field and an unsent one look
identical once decoded — so silence is never read as a deletion. A key that is not in the file
whose box is unchecked is left alone too, because `false` is what an absent boolean already
means. And a key the file never set posts **nothing** for its lists and toggles: the hidden marker
that tells the decoder "a list was here" and the hidden companion that turns an unticked box into
a real `false` are rendered only for a value the file actually holds. Without that rule a save of
Rendering wrote `images.deviceSizes: []` and `images.qualities: []` for a project that had never
set either — an empty allowlist, which refused every width — along with `false` for every boolean
the tab happened to show. A group save also carries the sub-keys the form does not render (a
legacy `experimental.cacheComponents`, an unknown key) through unchanged, an untouched save
answers "No change" and writes nothing, and a required field left empty is a field nobody filled
in, not a `""` to write.

A **superseded** key (`experimental.reactCompiler`, `images.domains`) carries a `deprecated` pill and the
sentence naming its replacement, and is shown only when your config actually sets it — offering
it otherwise would be an invitation to start using the old name. Hiding is inert: an unrendered
field posts nothing, and nothing for an absent key means "leave it alone".

Each field gets the control its type deserves:

| Schema shape                       | Widget                                                                                                                                                      |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enum` (≤ 4 short values)          | Segmented radio group                                                                                                                                       |
| `enum` (longer)                    | Select, with "— unset —" first when optional                                                                                                                |
| `anyOf`                            | A branch picker, then the selected branch's form (`csp`, `hsts`, `compatibilityMode`)                                                                       |
| Array of `enum`                    | Checkbox group (`images.formats`)                                                                                                                           |
| Array of scalars                   | Chips: add, remove, reorder (`publicEnv`, `i18n.locales`)                                                                                                   |
| Array of objects                   | A typed sub-form per row with `↑` `↓` `✕` and `+ Add` (`redirects`, `rewrites`, `headers`, `images.remotePatterns`, `images.localPatterns`, `i18n.domains`) |
| `Record<string, T>`                | Key/value map rows (`scheduledJobs`, `features`)                                                                                                            |
| Object with properties             | A named group of fields                                                                                                                                     |
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

Each tab's form carries three controls. **Save** is inert until you actually change
something: `ui.js` snapshots the form when the page renders and wakes Save on the first edit,
adding a **Discard** button beside it that puts the tab back the way the server rendered it.
**Remove key** is a submit, not a form reset — it deletes that key from the config, which is why
it only appears when the key is set (it was called "Clear", which read like "clear the field").
A **+ Add** row on a list hands the editor back with the new row in place; it is not a save, so it
is not validated as one. With JavaScript off none of the tracking runs and Save simply works, so
the server never renders it disabled; under `--read-only` every one of them is disabled regardless.

**Leaving a tab with unsaved edits asks first.** A panel swap replaces the section wholesale, so
with JavaScript on a sidebar, tab or filter click on a half-finished form stops and offers Save,
Discard or Cancel in a native `<dialog>` that `ui.js` builds at runtime (Discard is the same
discard the button beside Save runs; Save submits through Save, so the diff-then-confirm flow is
what follows, and the pending navigation is dropped rather than resumed behind a confirmation
nobody has given). Back and Forward are not guarded — the browser has already moved by the time
`popstate` fires, so a guard there could only pretend. With JavaScript off there is no swap to
intercept and the dialog does not exist.

Every write is two steps, and both run the whole _proposed_ config through
`validateDenextConfig`:

1. The first `POST` computes the new source and answers with a unified diff. Nothing has
   touched disk.
2. A second `POST` carrying `confirm=1` applies it and answers `303` back to the view and tab
   that show the change — `/config/<view>?key=<key>`, or `?key=general` for a scalar. A confirm
   carries exactly the change you reviewed, a cleared scalar included.

A value the validator rejects is a `422` with the message rendered against its own field,
never a broken config on disk. The raw-file escape hatch is the **The file itself** tab on
Advanced: the whole file in a textarea, saved only if it still parses as a denext config.

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

`/generate` is a GUI over `denext generate`. Pick one of the sixteen kinds — `page`,
`route`, `layout`, `loading`, `error`, `not-found`, `component`, `api`, `action`,
`middleware`, `job`, `test`, `docker`, `migration`, `seed`, `ci` — name it, and preview.

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
export` plus a file server), the exposed port, the `denoland/deno:` tag to pin, and the
**self-hosted stack**: a checkbox per service — Postgres 17, the pgvector image, a MinIO store
with its bucket bootstrap, a migrations service — plus "publish Postgres on loopback" and
"write `compose.dev.yml`". They are the `denext generate docker` flags
([Deployment › Self-hosted stack](/docs/deploy#self-hosted-stack-postgres-storage-migrations)),
and until you submit the form each box is checked as the project needs it, with the reason
detection gave next to it ("detected: @denext/backend in denext.config"). The mode is
auto-detected from `mode: "spa"` in your config when you don't pick one; the static image has no
server, so a stack service there is refused. The database publishes no host port unless asked,
and then only `127.0.0.1:5432` — reachable from your machine and from nowhere else on the
network. With any stack service on, the files include `.env.example` (every secret the stack
reads, the required ones empty) — never a `.env`.

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

`/desktop` sets up code signing for a packaged desktop build and for a compiled server binary:
macOS, Windows, Linux and Compiled binary as four tabs of one panel (`?tab=`). It reads what your
machine has and composes the command — it runs no build and writes no file.

The packaging scripts `denext create --desktop` writes (`scripts/package-*.ts`) have always been
driven by `DENEXT_*` environment variables, and nothing told you what to put in them. A project
without those scripts is told so, rather than shown controls that cannot do anything.

**macOS.** The panel lists the Developer ID Application identities actually in your keychain, so
`DENEXT_CODESIGN_IDENTITY` becomes a value you copy rather than a string you have to know — the
composed `export DENEXT_CODESIGN_IDENTITY='Developer ID Application: …'` line is single-quoted
(a `'` inside spelled `'\''`), because an identity's name is text the panel did not write, pasted
into a shell by the person reading it. Only
Developer ID Application certificates are listed: a developer Mac usually also holds an
`Apple Development` certificate, and a build signed with that one neither distributes nor keeps
its permission grants. That last point is the reason to bother — macOS keys **TCC** grants
(Screen Recording, Accessibility, Input Monitoring) to the signing identity, so an unsigned or
ad-hoc-signed app changes identity on every rebuild and has to be re-approved every time.
Gatekeeper and TCC are different mechanisms: notarization (`DENEXT_NOTARY_PROFILE`) is what
quiets Gatekeeper on someone else's Mac; a stable identity is what keeps permissions.
`DENEXT_INSTALLER_IDENTITY` is the separate Developer ID **Installer** identity that signs the
optional `.pkg` (`--format pkg`); an unsigned `.pkg` is rejected by MDM tools and Gatekeeper.

**Windows.** `DENEXT_WINDOWS_CERT` (a `.pfx` path), `DENEXT_SIGN_TIMESTAMP_URL` and whether
`signtool` is on `PATH`.

**Linux.** Nothing to configure — packaging produces a `.tar.gz` and a `.deb` (an `.rpm` or an
AppImage with `--format`) and there is no signing step.

**Compiled binary.** The signing readiness of
[`denext build --compile --sign`](/docs/deployment-targets#a-single-binary-with-denext-build---compile)
(or a configured `compile.sign`): the macOS identity (`DENEXT_CODESIGN_IDENTITY`, checked against
the keychain) and whether `codesign` is found, the notary credentials — a keychain profile
(`DENEXT_NOTARY_PROFILE`) or an App Store Connect API key (`DENEXT_NOTARY_KEY`,
`DENEXT_NOTARY_KEY_ID`, `DENEXT_NOTARY_ISSUER`) — and on Windows a `.pfx` (`DENEXT_WINDOWS_CERT`)
or a store certificate's thumbprint (`DENEXT_WINDOWS_CERT_THUMBPRINT`), with whether `signtool` or
`osslsigncode` is on `PATH`. No packaging script is needed: the build reads the variables itself.

**One value this panel will never take.** Of the twelve variables the four tabs show, exactly one is a
true secret: `DENEXT_WINDOWS_CERT_PASSWORD`. It has **no field** here, its value is never read —
only whether it is set, via `Deno.env.has` — and it is absent from the JSON twin as well. The
macOS identity and notary profile are _names_: the private key and the notary credentials stay in
your keychain, so those values are safe to show, and showing them is the point. Set the password
in your own shell or CI.

## Setup

`/setup` readies a project in seven steps. Each inspects one aspect of it and offers the
operation that moves it on; every operation that writes previews its change as a unified diff
and only writes on an explicit confirm. A completed write answers `303` back to
`/setup#step-<id>`, so a reload never re-applies it.

| Step                  | What it checks                                                                                                                    | What it offers                                                                                                            |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Detect the project    | denext app, Next.js compat app, empty directory, or something else; whether a dev server is already publishing `.denext/dev.json` | Nothing — it's a reading                                                                                                  |
| Deno runtime          | The running Deno against denext's minimum                                                                                         | Reports `deno upgrade` when it's old                                                                                      |
| `deno.json`           | The denext imports, the JSX compiler options, and the `dev`/`build`/`start` tasks                                                 | Write `deno.json`, or merge only the missing keys                                                                         |
| Dependencies          | Whether `deno.lock` exists; warns when `nodeModulesDir: "manual"` needs your package manager too                                  | Run `deno install`                                                                                                        |
| Environment variables | Scans the source for `Deno.env.get("X")` / `process.env.X` and diffs against your `.env*` files                                   | Write `.env.example` — **never `.env`**, and values are never read                                                        |
| Doctor                | —                                                                                                                                 | Runs `denext doctor --json` as a subprocess and renders every check; offers `app/page.tsx` when there is no app directory |
| Features              | The feature list `denext create` offers                                                                                           | Scaffolds the project into an empty directory; on an existing project it only lists them                                  |

Nothing in Setup imports a project module: detection is filesystem probing, and doctor and
`deno install` run as subprocesses. Under `--offline`, doctor runs without net and
`deno install` runs `--cached-only` ([Working offline](#working-offline)). See
[Doctor & audit](/docs/doctor-audit) for what the checks mean.

Setup was `/wizard`, which named the shape of the page rather than its job. Two of its nine
steps were places rather than steps, and they are pages of their own now.

## The dev server

`/dev` says whether a dev server is running, starts and stops it, and keeps the console its
output streams into. The JSON twin answers `{ ok, dir, running, origin, pid }`. That output is
what `denext dev` prints, so a type or build error arrives
[explained](/docs/error-handling#explained-type-errors), with Deno's original text under it.

**The dev server, and stopping it.** Starting `denext dev` answers _in place_ rather than
redirecting, and the step keeps a `<pre class="out">` that the server's output streams into over
SSE. Those lines are also retained in the UI's memory, so a reload, a second tab, or a panel swap
shows what has been printed so far instead of an empty box. A redirect used to discard all of it: it
rebuilt the document and took `ui.js`'s single `EventSource` and the output block with it, which is
what made starting a dev server look like it did nothing at all.

While a server is running the page offers **Stop**, and that works even after `denext ui` has itself
been restarted: the dev server records its own pid in `.denext/dev.json`, so stopping never needs
the child's process handle. That file is project content — a clone can commit one — so nothing in
it is trusted on its own. The pid must be a safe integer above 1 (never `-1`, which would signal
every process you may, `0`, or `init`) and is never the UI's own process or its parent, whatever
the file says. Then the origin the file names is asked who it is: `GET /_denext/dev-state`, which
only a denext dev server answers, reports its own `pid` and `projectDir`, and both must match — the
pid the file recorded, and this project's directory (compared by realpath, so a symlinked spelling
still matches). A stale file whose origin answers nothing is cleared instead, because the pid it
carries may since have been handed to an unrelated process; an origin that answers as some **other**
server (another project's dev server that took the port, say) is reported as a mismatch and neither
signalled nor cleaned up. Stopping asks the server to drain first and kills the process tree only
if it will not — and "gone" means the origin no longer answers as _that_ server; on Windows, which
has no such signal, it is a hard kill and says so.

## Tasks

`/tasks` lists the scripts your `deno.json` declares, each with the command it runs and a
button. The buttons post to `/tasks/run`, the SSE runner that is the only route which spawns:
it refuses any name the project does not declare, passes it as an argv element rather than
through a shell, and ties the child to the stream so closing the page takes the task with it.
A task runs exactly as `denext task <name>` would: on [denext's Deno toolchain](/docs/toolchain),
with that `deno` first on the task's `PATH`.

Not to be confused with the Cron page's scheduled jobs: those are `jobs/<name>.ts` modules
registered with `defineJob`; these are `deno.json` scripts.

## Services

`/services` shows the [supervised services](/docs/services): the files under `services/`, and
for each supervisor the state of every child (`running`, `restarting`, `failed`, …), its restart
count and its last error. The UI never runs project code, so it reads the snapshot a running
`denext dev` or `denext start` keeps in `.denext/services.json`, and says when that was written;
with no server running it is the last one. Read-only. The JSON twin answers
`{ ok, dir, files, snapshot }`.

## Database

`/database` is shown in the navigation when the project uses Postgres: `DATABASE_URL` is a
`postgres://` URL (in the environment, `.env` or `.env.local`), or the config declares
`postgres:` — `backend({ postgres })` from [`@denext/backend`](/docs/backend). Its tabs:

| Tab        | What it shows                                                                                                                                                                     | Writes                                                                                                         |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Tables     | Every table, view and materialized view: the planner's row estimate, row-level security, the primary key; a table's columns, indexes, foreign keys                                | —                                                                                                              |
| Rows       | A table's rows, 50 a page — sort by any column, filter `column = value` (or `IS NULL`), open one row                                                                              | Edit a value, insert a row, delete a row                                                                       |
| SQL        | The [SQL editor](#the-sql-editor): a statement or a script, and the last statement's rows                                                                                         | Whatever a read-write run does                                                                                 |
| Policies   | Each table's row-level security (enabled, forced) and every policy in `pg_policies`                                                                                               | "Enable RLS" writes a migration — it does not alter the table                                                  |
| Migrations | `migrations/*.sql` — applied, pending, or applied and since edited — and what applying would run                                                                                  | Apply the pending ones                                                                                         |
| Storage    | The buckets `backend({ storage })` declares and their objects (paged, size, type); download one (up to 10 MB)                                                                     | Upload an object (up to 10 MB); delete an object                                                               |
| Users      | denext auth's users from its Postgres tables: live sessions, a confirmed second factor, passkeys, a ban in force; one user's page                                                 | Create a user; ban, unban, set a password; revoke a user's sessions; delete a user and every row keyed by them |
| Realtime   | The publication tables opt in through, each table's triggers; the running app's live channels, subscribers, presence keys and `postgres_changes` bindings ([Realtime](#realtime)) | Add a table to the publication, or drop it                                                                     |
| Functions  | The Edge Functions under `functions/`, their `verifyJwt` and their recent invocations ([Edge Functions](#edge-functions))                                                         | —                                                                                                              |
| Logs       | The stack's [logs](#logs): one service or every one, a time window, a level, a text search                                                                                        | —                                                                                                              |
| Health     | Each service's health check, the app's `/_denext/health` checks and the `services/` supervision tree, refreshing itself ([Health](#health))                                       | —                                                                                                              |

**Where the work happens.** The UI process never opens the database: it would need the
project's config, and the UI never runs project code. Each page writes one JSON request to a
`denext db-admin` child (a hidden verb), which loads the project — its `.env`, its plugins, so
`backend({ postgres })`'s client (including a `sql` client the app passes on stock Deno) and the
storage driver are the app's own — answers, and exits. Without either a Postgres client or a
configured database the page says why, rather than failing.

**Every query** runs in a transaction of its own that first sets `statement_timeout` (5 s;
60 s for applying migrations) and `lock_timeout` with `SET LOCAL`, and a read is `READ ONLY`.
A page holds 50 rows; paging is keyset — the rows after the previous page's last one, on the
primary key (after the sort column, NULLs last), never `OFFSET`. Values are shown as Postgres
prints them (`::text`), cut at 200 characters in the list and 64 KB in the row view; a longer
value is not offered for editing.

**Who it reads as.** Rows are read as the connecting role — labelled **service role**: it is
the role `db.service()` uses, and row-level security does not apply to it. The "Read as"
control previews what someone else would see instead: `anon`, or a user by id (and optionally
email), with the role and `request.jwt.claims` that `db({ as: user })` sends, so `auth.uid()`
policies decide which rows come back. Writes always run as the service role.

**Every write is two steps**, and both work with JavaScript disabled. The first post builds
the statement and shows it — the exact SQL and each `$n` parameter — with a form carrying the
same fields; the second runs that statement (rebuilt from the same fields), answers `303`, and
the page it lands on says what happened. An update or delete must touch exactly one row or
nothing changes. Identifiers are never taken from a request: the table is looked up in
`pg_catalog`, and only a schema, table or column found there is quoted into SQL; every value is a
parameter cast to its column's type (`$1::integer`), so what is typed into a cell is a value
however it is spelled. Generated columns and `GENERATED ALWAYS` identity columns are never
written; a view, or a table without a primary key, is shown read-only.

**Enabling row-level security** writes `migrations/<stamp>_enable_rls_<schema>_<table>.sql`
through the same planner as `denext generate migration` (adding `jobs/migrate.ts` when the
project has none): an `ALTER TABLE … ENABLE ROW LEVEL SECURITY` and a commented example policy.
Add the policies the table needs — with RLS on and none, only its owner sees its rows — then
apply it from Migrations.

**Revoking sessions** deletes the user's rows in the session store (`auth_sessions`), marks
their native-app sessions revoked, and moves the user's "sessions valid after" mark to now, so a
stateless cookie session signed in before it ends too (it is not stored, so it is not counted).

**Users.** "Create a user" writes the `auth_users` row the adapter's `createUser` would, with a
`hashPassword` credential when a password is given (8 to 1024 characters; without one the user
signs in another way, a link or a provider), and can mark the address verified; an address
already taken is refused. A user's page bans them for a listed length (an hour up to "until
unbanned") by setting `banned_until`, the column the `/auth/v1` admin API's `ban_duration`
writes and every sign-in and token check reads, and ends every session; "Unban" clears it. "Set
password" stores a new hash and ends every session. A ban previews first, like every other
write. Creating a user and setting a password run on submit instead: a preview would have to
carry the password back into the page, and no password or hash is ever rendered (a statement's
hash parameter shows as `•••`).

**Uploading** goes through the storage plugin's own operation, as the service: the bucket's
size cap and type list apply, and the object's metadata row is written with its bytes. The key
is the one typed, or the listed prefix plus the file's name; an object already there is refused
unless "Replace" is ticked. It needs a `@denext/backend` from 0.5.0 on.

**Safety.** `--read-only` refuses every write in the server before any child runs — the
preview included — and the child refuses writes on its own as well. Every post carries the
CSRF token, like every other form. The connection is shown with its password masked
(`postgres://app:•••@db:5432/app`), and so is any URL an error message mentions. A downloaded
object is always served as an `application/octet-stream` attachment with `nosniff`, whatever
type it was stored with, so a stored HTML or SVG file can never run on the UI's origin.
`--offline` refuses the section (`503`), Logs, Functions and Health excepted.

### The SQL editor

`/database/sql` runs what you type as the connecting role, which is admin by design: in
`denext ui` you own the project, and the [dashboard](#the-stack-dashboard) is behind its password.
Row-level security does not apply to that role. Pick the transaction:

- **Read-only** runs ONE statement in a `READ ONLY` transaction, over the extended protocol, which
  refuses a second statement, so a `COMMIT;` cannot end the read-only transaction and run what
  follows outside it.
- **Read-write** runs a script (several statements, the simple protocol) in a transaction that
  commits when the last statement succeeds and rolls back otherwise.

Both carry a 30-second statement timeout. The page shows the last statement's rows as text (up to
500; JSON as JSON, `bytea` as `\x…`), keeps the text in the editor, and shows a failure the same
way. `--read-only` refuses every run. Everything else in the section builds its SQL from the
catalog and binds every value as a parameter; the editor is the one place that runs SQL it did not
build.

### Logs

`/database/logs` reads the stack's logs: one service or every one, the last 100 to 5000 lines,
within a window (5 minutes to 7 days), at a level and above (from a JSON or logfmt `level` field
or a level word, as `denext stack logs --level` reads it), containing some text. Every choice is a
fixed list; the search is plain text, never a pattern. Two sources:

- **`docker compose logs`** for the project's compose file, when Docker is on this machine
  (`denext ui`, or `denext dashboard` run next to the stack). Argv only, never a shell.
- **The stack's `dashboard-logs` relay**, inside the stack, where the dashboard's container has
  no Docker (see [the stack dashboard](#the-stack-dashboard)).

Every line is redacted before it is shown or searched: a `postgres://` password, and the value of
every secret-looking variable (`*PASSWORD*`, `*SECRET*`, `*TOKEN*`, `*_KEY`, …) in the process's
environment and the project's `.env`. A search runs on the redacted text, so it cannot find a
secret either.

### Realtime

`/database/realtime` shows realtime from both sides. From the database (the `db-admin` child):
the publication tables opt in through (`realtime({ publication })`, Supabase's
`supabase_realtime` by default), each table's place in it, the events its `denext_realtime`
triggers send, its primary key and row-level security. The one write here is that opt-in: "Add
to publication…" / "Remove from publication…" previews the `ALTER PUBLICATION` (and a `CREATE
PUBLICATION` when there is none yet) and runs it on the second post, like every other write; the
running app re-reads the publication and creates or drops the table's triggers itself. A table
needs a one-column primary key to opt in. Tables listed in `realtime({ tables })` are code and are
marked, not changed.

From the running app: its live channels with their subscriber counts, and every
`postgres_changes` binding's channel, table, filter (redacted like the Logs page) and events.
"Presence keys" lists a channel's presence keys and how many presences each has, never what they
tracked; a key's payloads are shown only when you expand that key.

**Reaching the running app.** Channels, presence, invocations and the supervision tree live in
the app's process, so the page asks it: `@denext/backend` serves `/_denext/backend/admin/*`,
which answers only the secret key (`DENEXT_SECRET_KEY`, sent as the `apikey` header and never
shown). `denext ui` asks the dev server `.denext/dev.json` names (a loopback address), with the
key from the environment or the project's `.env`; the stack's dashboard asks `DASHBOARD_APP_URL`.
Without a running app, or without the key, those parts say so and the rest of the page renders.

### Edge Functions

`/database/functions` lists the functions the running app serves: each one's name, whether it
requires a caller (`verifyJwt`) and when its entry file last changed, with how many of its recent
calls failed. Below, the recent invocations, newest first, for one function or all of them (a
fixed list): status, duration and time. The functions runtime keeps the last 200 in a ring in the
app's process; it records only those four facts, never a request's body, headers, query or
caller, so none can be shown. Without a running app the page lists the files under `functions/`,
`verifyJwt` unknown.

### Health

`/database/health` is what `denext stack health` prints: each service's compose health check (a
one-shot that exited 0 counts as done) from `docker compose ps`, or in the stack's dashboard from
the `dashboard-logs` relay; the app's own `/_denext/health` verdict and each readiness check (the
`services` supervision check among them); and the `services/` supervision tree, from the running
app, else the last snapshot a server wrote (`.denext/services.json`). Error messages are
redacted. The page refreshes itself every 15 seconds by default (a fixed list, `No refresh`
included): with scripting off through a `<noscript>` meta refresh, with it on by swapping the panel
in place.

### The stack dashboard

`denext dashboard` serves this same Database section — and nothing else: no configuration,
plugins, tasks, dev server or commands — behind a password instead of a launch token. The
self-hosted stack runs it as its `dashboard` service ([Deploy](/docs/deploy#the-dashboard)); it
runs next to the stack on the host as well:

```sh
denext dashboard                 # http://127.0.0.1:3100, password from DASHBOARD_PASSWORD
denext dashboard --read-only     # browse without offering any write
denext dashboard --host 0.0.0.0 --origin https://dash.example.com   # behind a TLS proxy
```

| Guard         | What it does                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Binding       | `127.0.0.1` unless `--host` says otherwise                                                                                                                                                                                                                                                                                                                                                                          |
| Host          | A loopback name, or the host of an `--origin` (a DNS-rebinding defence); a browser's `Sec-Fetch-Site` must be same-origin                                                                                                                                                                                                                                                                                           |
| Password      | `DASHBOARD_PASSWORD` from the environment, else the project's `.env`; never an argument. Under 12 characters, or unset, the dashboard is locked                                                                                                                                                                                                                                                                     |
| Sign-in       | A same-origin form carrying the login form's own token (double-submitted through a short-lived cookie); the password compared in constant time, as two HMAC-SHA256 digests                                                                                                                                                                                                                                          |
| Rate limit    | 5 failed sign-ins per client address and 30 overall per 15 minutes, then `429` with `Retry-After`; while limited even the right password waits, so the limit is no oracle. Through Docker's published port every client arrives from the gateway's one address, so 5 failures from anything that can reach the port lock everyone out for the window (brute force stays bounded); restart the dashboard to clear it |
| Session       | A fresh 256-bit id per sign-in, held in memory, in an `HttpOnly; SameSite=Strict` cookie — `__Host-`-named and `Secure` over https (directly or through an https `--origin`), plain on an http loopback address; it ends after 30 idle minutes, 12 hours, a restart, or "Sign out" (a POST)                                                                                                                         |
| Mutations     | Every write needs the session's CSRF token and a same-origin `Origin` — the dashboard's public `--origin` behind a proxy                                                                                                                                                                                                                                                                                            |
| What it shows | Connection strings masked, passwords never rendered, log lines redacted; a body over 16 MB is a `413` before anything parses it. Nothing writes project files: "Enable RLS" is not offered (add the migration in the project)                                                                                                                                                                                       |

Behind a reverse proxy, pass the Host through (nginx: `proxy_set_header Host $host;`) and
terminate TLS there. Over https the session cookie is `__Host-denext_dash` with `Secure`; on a
plain-http loopback address it is `denext_dash` without `Secure`, so no browser has to bend its
rules for it. An `--origin` that is plain http on another host is refused at startup: the password
would cross the network in the clear.

## Cron

`/config/cron` is the Configuration section's Cron page: every cron schedule this project
registers at
server startup, when each next fires, and which of them will not fire at all.

A schedule reaches the scheduler from one of two places, and the page is explicit about which:

| Source                                        | Shown | Editable                                        |
| --------------------------------------------- | ----- | ----------------------------------------------- |
| `scheduledJobs` in `denext.config.ts`         | yes   | yes — through the `scheduledJobs` editor        |
| `schedule:` inside a job's `defineJob({ … })` | yes   | no — it is code, and the UI never rewrites code |

The listing comes from one subprocess (`denext job --list --json`), never from this process:
listing jobs means importing the project's job modules. The child returns the schedule
`collectSchedules` computes — the same function the server calls at boot — so the page shows what
will really happen rather than re-deriving the merge. A successful listing is reused for a few
seconds, but only for the config file it was computed from: it is keyed on the file's stamp, so a
hand edit never has rows from before it proposed back at it. When the child fails, the page repeats
the child's own last meaningful line ("invalid denext.config.ts: `redirects` must be a function")
rather than "printed no listing".

Two kinds of entry are flagged **never fires**, because the scheduler skips them at startup with
nothing more than a log line: a malformed cron expression, and a schedule naming a job that is
not defined. Times are UTC, which is what `Deno.cron` and the userland scheduler both use, and
weekdays are POSIX — `0–6` with `0` (or `7`) for Sunday — which the server translates into names
for `Deno.cron` (see [Scheduled jobs](/docs/jobs#cron-syntax)).

The config half is editable here: one row per schedule — the expression, the job it runs, and a
box that drops it — plus a blank row to add another, whose job picker starts on "— choose a
job —" (a `<select>` always posts something, so without that blank option an untouched add row
posted the first job's name and every save was refused). Every expression is parsed before
anything is written and every job name is checked against the jobs that actually exist, so a
schedule that could never fire is refused rather than saved. The write is the same one the
[configuration editor](#configuration-editor) performs: `setConfigValue` splices the key, you get
a unified diff to review, and only a confirm writes — atomically, and refused with a `409` if the
file changed since the form was rendered.

**Pick a shape, and the server composes the expression.** Above the rows sits a builder: Every
minute, Hourly, Daily, Weekly, Monthly or Custom, showing only the fields that shape uses — a
minute for Hourly, an hour and minute for Daily, a weekday for Weekly, a day of the month for
Monthly. It is a `GET` form, so choosing a shape submits it, the server composes the expression
with `composeCron`, and the field below receives it. The builder never edits that field directly:
a picker, a row of selects and a free-text box all writing one value is three inputs that nothing
keeps in step once scripting is off, so only the field is ever written. Nothing is copied out of
the query either — an unrecognised shape composes nothing and every number is clamped into its
field's domain, so what reaches the field is only ever digits, spaces and asterisks. Under
**Custom** the builder steps aside: a range or a step is not a shape it can state, and the field
below is already the full editor.

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
[Scheduled jobs](/docs/jobs) for the feature itself.

### Run history

The page can also answer what actually ran, and whether it worked — but only if the project asks.
Run history is **off by default**: denext records nothing and writes no file until you turn it on,
so upgrading never gives an app a side effect nobody requested.

Turning it on from this page writes `jobs: { history: true }` to your denext config through the
same diff-then-confirm as everything else here — you see the exact change before anything lands.
From then on every run is recorded, scheduled and manual alike (`runJob`, the scheduler, and
`denext job <name>` from the command line), into `.denext/jobs.db`, and the page shows each
job's last result, how long it took, and its successes and failures over the last seven days.
Each row keeps the run's output in plain text — the tail of a string the handler returned, up to
2 KB, and for a failure the error's message and stack — so a job that would return a token or a
DSN should return nothing instead. The file is created owner-only (`0600`; its `-wal`/`-shm`
siblings inherit the mode). Retention is 14 days and `jobs.historyMaxRuns` runs per job (default
500; per job, so a minute-cron job cannot evict a daily job's history), applied on the first
recorded run of every process — a one-shot `denext job` prunes too. `historyMaxRuns` is not
offered here; set it in the config. See [Run history](/docs/jobs#run-history) for the key.

Two things are worth knowing. It takes effect **the next time the app starts**, including under
`denext dev`: the recorder is installed at server boot, and the dev server's watcher re-bundles
routes without re-running job boot. And recording can never fail or delay a run — a read-only
filesystem, a full disk or a locked file degrades to no history rather than to a broken job.

The page distinguishes four states rather than showing one empty table: history off, on but nothing
recorded yet, on with no runs inside the window, and on with results. "Off" and "on but nothing
yet" are different facts, and reading one as the other is how you end up waiting for data that was
never going to arrive.

A store your config constructs (`jobs: { history: { store } }`) is read through a
`denext job --history` child; under `--read-only` that child runs with `--read-only` too, which
the store receives as `read({ readOnly: true })`. Reading never creates or migrates anything —
the Postgres store answers "no history recorded yet" until its first run creates the table.

Clearing is its own button, and its own two steps: the first press says how many runs will go and
asks you to confirm, the second deletes them. It is a `DELETE`, not a file unlink — the running app
may hold that database open — so the database survives and recording simply continues. Your denext
config is not touched, and nothing about the schedules changes.

On Deno Deploy it records and says so: `.denext/jobs.db` is per-isolate and ephemeral there, so
what you see is one isolate's fragment that resets when it cycles. A history that is quietly wrong
is worse than none, so the caveat is printed at boot rather than the setting being ignored.

A project can keep its history somewhere else — `jobs: { history: { store } }`, such as
`postgresJobHistoryStore` (see [Where history is kept](/docs/jobs#history-store)). That store is
constructed by your config, which is project code, and project code never runs in the UI's process:
the page reads and clears it by running `denext job --history --json` and
`denext job --clear-history --json` in the project, as it lists jobs, and shows the same four
states. A store set in code is not offered as the on/off toggle, because the page never rewrites a
call expression in your config.

## Project commands

`/commands` lists every verb available in this project — built-ins, verbs a plugin
contributed through `addCommand`, and your own `commands:` entries — and runs the ones it
can. It is a reference listing of thirty-odd verbs, so it has a search box: `/commands?q=build`
narrows the page to the verbs whose name or summary matches (every term must match), with an
honest line when nothing does. It is a plain `GET` form, so it works with scripting off and the
query is in the URL; Clear is a link that drops `?q=`.

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
case a listing can be stale, so the footer under it says where it came from. That cache is project
content (a clone can commit one), so a name is accepted back only if it fits the verb-name grammar
(`^[a-z][a-z0-9-]*$`), and every name and summary the CLI prints has its control characters
removed — a summary is not a place to carry an escape sequence to your terminal.
`denext completions bash|zsh|fish` completes the same listing and never imports the project
either: its script is sourced from a shell rc file, so it runs in whatever directory a terminal
opens in. **A built-in verb always wins a
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

The one deliberate exception is the Dev page's actions, which re-render in place: a
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

**The sidebar.** Configuration is a heading with its views indented beneath it; every other
panel sits in an unlabelled run. The heading is a plain `<span>`, never a link — the UI ships no
inline script, so there is nothing for it to collapse, and it names the group rather than doing
anything.

**The navigation, on a phone.** Below 860px the sidebar becomes a bar holding the brand and one
button, and the navigation is what that button reveals — as the same vertical list the wide layout
shows, section headings included. The button is a `<label>` driving a hidden checkbox, not a
scripted control: opening the drawer involves no JavaScript at all, because a navigation you could
reach only with scripting on is not one this UI is allowed to have. The checkbox is hidden from
view but not from the keyboard, so it toggles with Space like any other. `ui.js` does exactly one
thing to it — unchecks it after a panel swap, since a swap has no reload to reset it and the drawer
would otherwise sit open on top of the panel you just asked for.

**A builder that navigates.** The Cron page's schedule builder works the same way: it is a `GET`
form, so choosing a shape is a navigation the server answers by composing an expression, and with
JavaScript on that submit is swapped in place like any other link. No client code of its own was
needed, and none parses a cron expression — the reading and the composing are both the server's.

**How the views are built.** Every panel is a component tree built with `h()` from denext's
own JSX runtime, in plain `.ts` modules, and rendered once to a string on the server. That
changes nothing on the wire: there is still no client bundle, no hydration and no island,
`/_ui/ui.js` is the only script, and every page works with it switched off. A panel's notes
carry a tone: a plain note is neutral — a fact ("No change", "None — this project contributes no
verbs"); `ok` is a result to be glad of ("Wrote denext.config.ts."); `warn` is a caution to weigh
(a mode that refuses writes, a lookup that failed). A `role="alert"` note is one the page
announces: a validation failure, an error.

## The JSON API

Every feature path has an `/api/*` twin served by the _same handler_ with JSON output, so
the browser and a machine client exercise identical code:

| Path               | Methods                 | JSON twin              |
| ------------------ | ----------------------- | ---------------------- |
| `/`                | `GET` `HEAD`            | `/api/overview`        |
| `/config`          | `GET` `POST`            | `/api/config`          |
| `/config/<view>`   | `GET` `POST`            | `/api/config/<view>`   |
| `/config/next`     | `GET`                   | `/api/config/next`     |
| `/config/cron`     | `GET` `POST`            | `/api/config/cron`     |
| `/plugins`         | `GET` `POST` `DELETE`   | `/api/plugins`         |
| `/plugins/options` | `GET` `POST`            | `/api/plugins/options` |
| `/generate`        | `GET` `POST`            | `/api/generate`        |
| `/docker`          | `GET` `POST`            | `/api/docker`          |
| `/desktop`         | `GET`                   | `/api/desktop`         |
| `/setup`           | `GET` `POST`            | `/api/setup`           |
| `/dev`             | `GET` `POST`            | `/api/dev`             |
| `/tasks`           | `GET`                   | `/api/tasks`           |
| `/services`        | `GET`                   | `/api/services`        |
| `/commands`        | `GET` `POST`            | `/api/commands`        |
| `/database/…`      | `GET` (`POST` to write) | `/api/database/…`      |
| `/tasks/run`       | `POST`                  | `/api/tasks/run` (SSE) |

Every answer carries `ok`. Beyond that the payload is the panel's own — a JSON twin
describes what its panel does, it does not flatten every panel into one shape:

| Twin                   | A read answers                                                                        | A mutation answers                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `/api/config`          | `{ ok, file, form, keys, schema? }`                                                   | `{ ok, applied, diff }` (a write adds `file`)                                                    |
| `/api/config/next`     | `{ ok, … }` the read next.config view                                                 | — (read-only)                                                                                    |
| `/api/config/cron`     | `{ ok, jobs, schedules, configScheduled, denoCron }`                                  | `{ ok, applied, diff, scheduledJobs }` — the diff-then-confirm envelope                          |
| `/api/plugins`         | `{ ok, installed, catalog, config, jsr }`                                             | `{ ok, applied, diff, name, op, command, bailed, … }`                                            |
| `/api/plugins/options` | `{ ok, name, callee, values, codeKeys, schema }` (`{ ok, plugins }` with no `?name=`) | `{ ok, applied, diff, values }`                                                                  |
| `/api/generate`        | `{ ok, kinds }`                                                                       | `{ ok, written, skipped, preview? }`                                                             |
| `/api/docker`          | `{ ok, mode, files, model, base }`                                                    | `{ ok, mode, files, written, refused }`; a compose edit `{ ok, applied, model, warnings, diff }` |
| `/api/commands`        | `{ ok, timedOut, error?, commands }`                                                  | `{ ok, verb, code, output }`                                                                     |
| `/api/setup`           | `{ ok, dir, kind, steps }` — one entry per step                                       | `{ ok, … }` the step outcome                                                                     |
| `/api/dev`             | `{ ok, dir, running, origin, pid }`                                                   | `{ ok, … }` the start/stop outcome                                                               |
| `/api/tasks`           | `{ ok, dir, tasks }` — the declared names                                             | — (runs go to `/api/tasks/run`)                                                                  |
| `/api/services`        | `{ ok, dir, files, snapshot }` — the last status snapshot, or `null`                  | — (read-only)                                                                                    |
| `/api/database/…`      | the child's reply: `{ ok, tables }`, `{ ok, rows, next?, statement }`, …              | `{ ok, statement, applied, affected? }` — `applied: false` for the preview                       |

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

The Database twins answer the child's own failure, `{ ok: false, code, reason }`, with a status
per `code`: `400` `bad_request`, `403` `read_only`, `404` `not_found`, `409` `not_configured`
(no database), `501` `unsupported` (no Postgres client on this Deno), `502` `query_failed`.

```sh
denext ui --no-open --json --port 0
# {"url":"http://127.0.0.1:54321/?t=…","port":54321,"token":"…"}
curl -s "http://127.0.0.1:54321/?t=$TOKEN" -c jar -o /dev/null   # 302 + Set-Cookie (a fresh secret)
curl -s http://127.0.0.1:54321/api/config -b jar | jq .
```

The bind is always `127.0.0.1`, and so is the printed URL: the `Host` gate accepts `localhost`
too, but a session cookie set on `localhost` would be sent to every other local server on that
name, so the UI is opened on the address only it uses. The cookie is not the token — keep the
jar the handshake filled rather than sending `denext_ui_token=$TOKEN`, which is refused.

Those envelopes are what the MCP tools front: see [Agent control (MCP)](#agent-control-mcp).

## Agent control (MCP)

`denext mcp` drives the same panels: `denext_ui_overview` and one `denext_ui_<panel>` tool per
panel (`setup`, `config`, `plugins`, `generate`, `docker`, `desktop`, `dev`, `tasks`,
`services`, `database`, `commands`). A tool takes the page (`path`, the panel's root by default),
the `method`, `query` parameters and the form `fields`, and answers with the panel's JSON twin
(a streamed run's lines, for a task or a verb).

The tools are a client of a real `denext ui`, not a second implementation. On first use the MCP
server starts `denext ui --no-open --port 0 --json` as a child process, presents its launch token
once (the handshake), and keeps the session cookie; every change is sent with a same-origin
`Origin` and the CSRF token derived from that cookie. So the loopback bind, the token handshake,
the origin and CSRF gates and `--read-only` apply exactly as they do to a browser, and project
code still never runs in the UI's process (nor the UI in the MCP server's).

On top of that, a change is sent in two steps:

- a read (`GET`) is sent as asked;
- a change (`POST`, `DELETE`) is sent only as a preview — `fields.op: "preview"`, which the panels
  that write a file or a database answer with the diff or the statement, without making it — or
  with `apply: true`. A change without either is refused before it reaches the UI, naming both.

`denext mcp --ui-read-only` starts that UI with `--read-only`, so every change is refused (`403`),
previews included; `--ui-offline` starts it with `--offline`. `--disable ui` hides the tools.
The UI child ends with the MCP server.

## What it does not do yet

| Not yet                      | Why                                                                                                                                                                                                      |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compose edits beyond the set | A service field outside the editor's set — `command`, `healthcheck`, `labels`, `env_file`, `deploy` and the rest — is edited by hand                                                                     |
| YAML the editor can't follow | Several YAML documents in one file make the file opaque: read-only, with the reason and the regeneration diff                                                                                            |
| Code-valued options          | A callback, a variable, a `{}` schema part or a function-wrapped list is shown read-only, never rewritten                                                                                                |
| Capacitor / mobile signing   | `denext` scaffolds a Capacitor project and opens it in Xcode or Android Studio; everything past `cap open` — provisioning profiles, keystores — is yours. There is no mobile signing seam to surface yet |
| A denext app                 | The UI is server-rendered components built with `h()` — no bundler, no hydration — not an App Router app, which is what lets it start instantly with no build                                            |

## See also

- [CLI reference](/docs/cli) — every verb, including `ui`, `generate`, `plugin` and `doctor`
- [Configuration](/docs/config) — what each `denext.config.ts` key means
- [Writing a plugin](/docs/plugins) — the six seams, and the `addCommand` verb seam
- [Doctor & audit](/docs/doctor-audit) — the checks Setup's doctor step runs
- [Deployment](/docs/deploy) — what to do with the Dockerfile the UI regenerates
- [Troubleshooting](/docs/troubleshooting) — when something refuses and the reason isn't obvious
