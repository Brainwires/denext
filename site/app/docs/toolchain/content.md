---
title: "denext's Deno toolchain"
slug: toolchain
lead: You install denext, nothing else — stock Deno is optional. The denext commands that run Deno run it on denext's own Deno build, which adds Deno.SQL and Vitest/Jest compatibility to deno test. It downloads on first need, is pinned by version and SHA-256, and never replaces a deno on your PATH.
---

## What you don't have to set up

Deno already bundles a runtime, TypeScript, a formatter, a linter and a test runner. denext
completes the picture for full apps (web, mobile, desktop): install the `denext` command, run
`denext create`, and every other tool arrives on its own, pinned to your denext release and
fetched the first time a command needs it.

| Instead of installing and configuring…                | denext provides                                                                                                            |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| A runtime and a version manager                       | denext's Deno build, SHA-256-verified into `<DENO_DIR>/denext-deno/` ([below](#where-it-lives-and-how-it-is-verified))     |
| A TypeScript compiler and a tsconfig                  | [Native TypeScript 7](#native-typescript-7-type-checking), shipped with the toolchain and pinned by hash                   |
| A bundler                                             | [esbuild 0.25.5](#esbuild), in the toolchain zip and hash-checked; its JS API vendored (no `npm:esbuild`)                  |
| A test runner, a linter, a formatter and their config | Deno's, with [Vitest/Jest compatibility](#denext-task-deno-task-and-tests) in `deno test`; no config file needed           |
| A CSS pipeline and a JSX/TS transpiler                | Lightning CSS and swc as denext's own wasm packages; `tailwind: { input, output }` fetches Tailwind v4's standalone binary |
| Database drivers                                      | SQLite through `node:sqlite`, Postgres through `Deno.SQL`, a zero-npm Redis client ([Database](/docs/database))            |
| A second runtime for single executables               | The toolchain's own `denort`, pinned and verified, behind `denext build --compile`                                         |
| A Gleam install                                       | The [pinned Gleam compiler](#gleam), fetched on first need; no Erlang                                                      |
| Ruby, Bundler and fastlane                            | [Managed fastlane](#fastlane) on a pinned portable Ruby with checksum-locked gems (macOS and Linux; a C compiler once)     |

Working offline? `denext toolchain install --with gleam,fastlane` fetches all of it ahead of time,
`denext toolchain status` shows what is cached, and `uninstall` / `prune` reclaim the space
([Commands](#commands)). The framework's runtime pulls nothing from npm (CI enforces it); your app
can still use `npm:` and `jsr:` libraries, and a `package.json` project brought over from Node.js
resolves its packages [as Node.js does](#npm-packages-as-on-nodejs). Less setup saves people hours,
and saves an AI agent the compute and tokens it would spend wiring a build.

## How it works

denext's Deno toolchain is the Deno CLI built from the public
[Brainwires/deno](https://github.com/Brainwires/deno) fork (`2.9.7-denext.N`, then its own
version from `3.0.0-rc.1`; see [Versions](#versions)): stock Deno plus
`Deno.SQL` (the Postgres client behind [`postgresClient()`](/docs/database#postgres)) and
Vitest/Jest compatibility in `deno test`. denext manages it the same way it manages the
[Deno Desktop runtime](/docs/desktop-runtime): each denext release pins one build per platform by
version and SHA-256, downloads it the first time a command needs it, verifies it, and reuses the
verified copy from then on.

There is nothing to install and nothing to configure. Install denext as usual; Deno itself is
optional.

## With no Deno installed

The `denext` binary (from [the installer](/docs/getting-started#install-the-cli)) is enough on its
own. A compiled binary has no `deno` of its own — its executable is denext — so before any verb
that may run Deno it resolves the toolchain (downloading it on first need) and hands it to
everything it starts: `DENO_BIN` names it, and `deno` on the children's PATH is it. That covers
`denext task …`, `test`, `fmt`, `lint`, `check`, `add`, the project-pinned re-exec of `dev` /
`build` / `start`, `create`, `migrate`, `generate`, `ui` and `mcp`; only `toolchain` and
`completions` never run Deno. A task that calls `deno …` therefore works on a machine with no
Deno.

The installer runs `denext toolchain install` right after installing the binary, and — only when
no `deno` is on your PATH — `denext toolchain link`, so `deno` is the toolchain for your editor,
git hooks and `.mcp.json` too (`DENEXT_NO_DENO_LINK=1` skips the link, `DENEXT_NO_TOOLCHAIN=1`
both steps). The link goes in the `bin/` of the install directory, `$DENEXT_INSTALL` when set
(the same variable the installers read) and `~/.denext` otherwise, so a custom-prefix install's
`deno` sits beside its `denext`. A `deno` you already have is never replaced.

The CLI's entrypoint is thin: it loads only the argument parser and a generated table of every
verb's name, flags and help, and imports a verb's own code when that verb runs, so `denext
--version` and `--help` never load the dev server, the bundler or `denext/server`. A CLI installed
from JSR (`deno install -A -g -n denext jsr:@denext/denext/cli`) therefore fetches each verb's code
the first time that verb runs. `denext toolchain install` also caches every verb's code together
with everything a verb loads by URL rather than by import: the framework modules a build bundles
or a server loads (the client runtime, the compat layers, every `denext/*` entry point) and the
helpers it runs in a child process (the desktop sidecar bundler, the MDX worker). The CLI's first
online run does the same in the background (a failed attempt retries after 10 minutes). After
either, `denext build`, `denext desktop …` and every other verb work offline (`--cached-only`,
`denext ui --offline`), so run `denext toolchain install` once after a JSR install. The binary
embeds every verb already.

When the toolchain can't be had (offline on first use, a host with no build, a failed or
mismatching download) the command stops with one error that names the fix — run
`denext toolchain install` once you are online — and the explicit opt-outs. denext never runs
another Deno on its own. With `DENEXT_DENO=stock` the binary runs a stock `deno` — `DENO_BIN`,
`~/.deno/bin/deno`, then `deno` on PATH — and with none of those it stops with the same kind of
error.

## Which commands use it

Every command that runs Deno runs it on the toolchain. The commands that execute your project's
code switch to it on their own, and the others hand it to the `deno` they start:

| Command                                                                       | On the toolchain      |
| ----------------------------------------------------------------------------- | --------------------- |
| `dev`, `build`, `export`, `start`                                             | yes                   |
| `test`, `check`, `job`                                                        | yes                   |
| `analyze`, `profile`, `doctor`                                                | yes                   |
| `desktop run \| dev \| build \| package`                                      | yes                   |
| `mobile dev \| build`                                                         | yes                   |
| a project's own verbs (`denext.config.ts` `commands`, plugins)                | yes                   |
| `task`, and every Deno verb denext forwards (`compile`, `run`, `x`, …)        | yes                   |
| `create`, `generate`, `migrate`, `upgrade`, `add`, `lint`, `fmt`, `ui`, `mcp` | the `deno` they start |
| help, `--version`, `toolchain`, `completions`                                 | no (they run no Deno) |

When one of them starts under stock Deno, denext re-runs the same invocation under the toolchain:
the same arguments, working directory, standard streams and exit code, with Ctrl-C and `SIGTERM`
forwarded. A `--config` the first process was started with is passed on (read from its command line on
Linux and macOS). Denied permissions stay denied (`--deny-net`), and
grants carry over whole: `-A` stays `-A`, and a path-scoped grant such as
`--allow-write=.denext` can't be read back, so only the whole-permission grants pass. Everything that command spawns (`deno test`, `deno bundle`,
`deno desktop`) runs on the toolchain too. The child carries `DENEXT_TOOLCHAIN_ACTIVE=<version>`,
so it never switches twice. Only the running version decides: a process whose `Deno.version.deno`
is not the pinned build (stock Deno that inherited the marker inside `denext task`, or an older
`-denext.N` that a `toolchain link` from before a denext upgrade still points at) switches to the
pinned one.

From runtime `3.0.0-rc.5`, `request.signal` aborts only when a response is not delivered (the
client went away or the request timed out) by default, and Deno prints no legacy-abort notice; code
that relied on the old abort after every delivered response opts back in with
`--unstable-legacy-abort`, `"unstable": ["legacy-abort"]` or `DENO_LEGACY_ABORT=1` (use the
handler's `info.completed` to learn that a response was delivered). An older toolchain needs
`--unstable-no-legacy-abort` for that, which the switch passes to it. A server verb (`dev`,
`start`, `profile`) started on such a toolchain directly (the `deno` that `toolchain link` puts on
PATH, or a `deno task` step running it) checks whether it has that flag, with one loopback
request, and re-runs once on the same binary with it when it does not. The `deno.json` that
`denext create` and `denext migrate` write carries `"unstable": ["no-legacy-abort"]`, which turns
the new behavior on for stock Deno 2.9 and older toolchains too (a least-privilege `start` task
included); `3.0.0-rc.5` and later accept it and do nothing. Add it to an older project's
`deno.json` (the Setup page of `denext ui` offers to), beside any features already listed.

A compiled `denext` binary can't change its own runtime. It hands the toolchain to the processes it
starts instead (through `DENO_BIN`, unless you set `DENO_BIN` yourself), and the project's pinned
denext then runs on it. Finding a project's own verbs (`denext commands`, a project verb) also
re-runs on the project's pinned denext, so the config resolves through the
project's import map rather than the binary's embedded one.

## Where it lives, and how it is verified

The binary is cached beside Deno's own cache:

```text
<DENO_DIR>/denext-deno/<version>/<platform>/deno      (deno.exe on Windows)
```

`DENO_DIR` defaults to `~/Library/Caches/deno` on macOS, `~/.cache/deno` on Linux and
`%LOCALAPPDATA%\deno` on Windows. The pinned platforms are `darwin-aarch64`, `darwin-x86_64`,
`linux-x86_64`, `linux-aarch64`, `windows-x86_64` and `windows-aarch64` (Windows on Arm, from
`2.9.7-denext.21`).

- The download goes to a temporary file in that same directory. Its SHA-256 is checked against
  the pin before it is extracted, made executable or renamed. A mismatch deletes the file
  unexecuted and the command stops with the refusal and the fix.
- The verified binary is renamed into place atomically, and a stamp file records its size,
  modification time and hash. Later runs trust it only while it still has that size and
  modification time; otherwise it is re-hashed, and a missing stamp means a fresh download. That
  fast path is the same trust Deno gives its own module cache: whoever can write to `DENO_DIR`
  can change what runs, so keep a shared or group-writable `DENO_DIR` to trusted users (or run
  `denext toolchain status --verify`).
- On a terminal the download prints one self-redrawing line with the megabytes received and the
  percent; in a log or CI it prints nothing.
- Two commands starting at once download it once: the second prints
  `Blocking waiting for file lock on Deno toolchain cache` and adopts the first one's binary.

## Opting out, and when it falls back

| Setting              | Effect                                                                  |
| -------------------- | ----------------------------------------------------------------------- |
| `DENEXT_DENO=stock`  | Everything runs on the Deno that started the CLI, silently.             |
| `DENEXT_DENO=<path>` | That binary is used as the toolchain, unverified (one warning per run). |

denext never falls back to another Deno on its own. On a platform with no pinned build, offline on
first use, or behind a failed or mismatching download, a command that needs the toolchain stops
with one error that says why, names the fix (`denext toolchain install`) and the two explicit
opt-outs above. A command that runs project code (`start`, `dev`, `build`, `job`, …) in a process
that lacks the grants to install and run the toolchain (`--allow-run`, and read/write on the cache
directory) stops too, rather than run on another Deno, where `Deno.SQL` (`postgresClient()`, the
Prisma adapter) and the toolchain's other changes would be missing. That is the case for the
least-privilege `start` task `denext create` scaffolds (`deno run --allow-net --allow-read
--allow-env --allow-write=.denext …`) when stock Deno runs it, so launch it on the toolchain
instead: `denext task start` (a task's `deno` is the toolchain), the binary `denext toolchain path`
prints, or the Dockerfile / systemd unit that [`denext deploy prepare`](/docs/deploy) writes, which
run the server on the toolchain directly. Started on the toolchain, that `start` spawns no child
process, so it needs no `--allow-run`. Running `start` with `-A` (or with `--allow-run` and write
access to the cache) also works: it re-runs itself on the toolchain. `DENEXT_DENO=stock` keeps the
command on the Deno that started it. `denext toolchain status` says which Deno a command runs on.

`DENO_BIN`, when you set it, still decides which `deno` the CLI's own child processes run.

## esbuild

denext's bundling (the SPA and compatibility builds, dev's dependency pre-bundle, `analyze`,
plugins) runs esbuild 0.25.5 through a copy of esbuild's own JavaScript API that denext vendors, so
there is no `npm:esbuild` import. The binary it starts is, in order:

1. `ESBUILD_BINARY_PATH`, when you set it. It must report `0.25.5`; any other version is refused
   by name.
2. The `esbuild` the toolchain ships beside `deno` (2.9.7-denext.17 and later). Each toolchain zip
   carries `esbuild` (`esbuild.exe` on Windows) and its `esbuild.LICENSE`; the pin records its
   version and SHA-256, the install extracts it from the already-verified zip, checks that hash,
   and records it in the stamp. Later runs re-hash it whenever its size or modification time
   changed.
3. Otherwise — `DENEXT_DENO=stock`, plain stock Deno, a toolchain from before denext.17, or a
   process that hasn't installed the toolchain — the official `@esbuild/<platform>` 0.25.5 npm
   package's binary, cached in `<DENO_DIR>/denext-esbuild/`. It is copied from Deno's npm cache
   when a copy there hashes to the pin, and otherwise downloaded from the registry
   (`NPM_CONFIG_REGISTRY`, default `registry.npmjs.org`) with the tarball checked against its
   pinned npm integrity and the binary against its pinned SHA-256 before it is made executable.

A toolchain esbuild that does not match its pin (or is missing from the zip) is never installed:
builds use the npm one and print one warning saying why. `denext toolchain status` shows which
esbuild the next build runs and where it comes from. An idle esbuild process never keeps a command
alive.

## Gleam

[Gleam](/docs/gleam) is pinned and fetched the same way: one Gleam release per denext release, a
SHA-256 per platform (macOS and Windows on arm64 and x64, Linux on arm64 and x64 as Gleam's static
musl builds), downloaded on first need — `denext add gleam:`, or the `gleam()` plugin at dev and
build — into `<DENO_DIR>/denext-deno/gleam/<version>/<platform>/`, verified before it is extracted
and installed atomically under the same cache lock. Gleam's JavaScript target needs no Erlang.

`denext toolchain install --with gleam` fetches it ahead of time, and `denext toolchain status`
lists its version and whether it is cached. Offline (or with `--deny-net`) before the first download,
a command that needs it stops with an error naming that command. `DENEXT_GLEAM=<path>` runs another
`gleam` instead, unverified; a `gleam` on `PATH` is never used unless you name it there.

## fastlane

`denext fastlane <args…>` runs a managed [fastlane](/docs/mobile-build#managed-fastlane): one
pinned fastlane release on a pinned portable Ruby (Homebrew's, the build `brew` runs), installed on
first use into `<DENO_DIR>/denext-deno/fastlane/<version>/<platform>/`. The Ruby tarball, from
denext's mirror or else Homebrew's registry, is verified against its pinned SHA-256 before it is
extracted, and the gems against the checksums in
denext's pinned `Gemfile.lock`. The install runs under the same cache lock, in a temporary
directory renamed into place. The gems build C extensions, so the first install needs a C
compiler (the Command Line Tools on macOS, `cc` and `make` on Linux). macOS and Linux (arm64, x64)
are supported, and Windows is not.

`denext toolchain install --with fastlane` installs it ahead of time, and `denext toolchain status`
lists it. `DENEXT_FASTLANE=<path>` runs another fastlane instead, unverified; a `fastlane` on `PATH`
is never used unless you name it there.

## `denext task`, `deno task` and tests

`denext task <name>` is Deno's `deno task`, run on the toolchain with every argument verbatim. Inside
it every `deno` is the toolchain: Deno's task shell runs its own executable for a `deno …` step, and
a shell script, `bash -c` or a Node tool the task starts that spawns `deno` finds the same binary
on `PATH`. Only `deno` changes: the toolchain's own cache directory (which holds nothing else) goes
first, and any other binary — stock Deno in `/usr/bin` or `~/.deno/bin`, a `DENEXT_DENO=<path>`
override — is reached through a directory in the toolchain cache that holds only a `deno` link to
it, so `node`, `npm` or `python` resolve exactly as before. When `PATH` already finds that binary,
nothing is added. Global flags before the verb go after it (`denext --config deno.json task p`
runs `deno task --config deno.json p`).

A plain `deno task` runs the `deno` inside a task's command on the Deno that started it — stock
Deno, without the toolchain's Vitest/Jest compatibility or `Deno.SQL`. Run tasks through denext
instead, or write the step itself as a denext verb:

```jsonc
{
  "tasks": {
    // denext's own test verb (`deno test -A` on the toolchain); what `denext create` scaffolds
    "test": "deno run -A jsr:@denext/denext@^4.0.0/cli test",
    // or run any deno subcommand on it, arguments verbatim
    "test:raw": "denext deno test -A"
  }
}
```

The Vitest/Jest layer needs no permission of its own (from `2.9.7-denext.16`): its reads of the
project (the config, `__mocks__`, automock) and of the environment variables Vitest reads take no
grant, so a `deno test` without `-A` lists only what its tests use (`denext deno test
--allow-read=tests/fixtures …`). `denext test` runs `deno test -A` and needs nothing more.

Coverage of a suite with Vitest files (from `2.9.7-denext.17`): `denext test --coverage[=<dir>]`
runs the `Deno.test` files and then the `*.vitest.ts` files into one directory and makes one report
from both (the summary, `<dir>/lcov.info`, `<dir>/html/`). By hand, run every pass on the toolchain
into one directory, each with `--coverage-raw-data-only` so no pass empties what another wrote,
then report that directory with the toolchain's `deno coverage`:

```sh
rm -rf cov
denext deno test -A --coverage=cov --coverage-raw-data-only               # the Deno.test files
denext deno test -A --coverage=cov --coverage-raw-data-only tests/**/*.vitest.ts
denext deno coverage cov --lcov --output=cov.lcov
```

The Vitest layer changes the code a module emits, so a module run by both passes has two
profiles of two different scripts; the toolchain's `deno coverage` reports each through its own
source map and merges the two reports line for line (a line run by either pass counts as covered).
Run every pass and the report on the toolchain: stock Deno's `deno coverage` merges such profiles
range by range, offsets into two different scripts, and under-reports the module (as the
toolchain's did before `2.9.7-denext.17`).

denext never rewrites the tasks in your existing `deno.json`; `denext doctor` names the tasks that
call `deno test` directly so you can change them, or run them with `denext task`.

## Every other Deno command

A verb denext does not define itself is Deno's, run on the toolchain exactly as
`denext deno <verb>` would — `denext compile`, `denext run`, `denext x`, `denext bench`,
`denext serve`, … — with the arguments verbatim and the exit code and signals passed back. Like
`denext deno`, a forwarded verb stops with the fix when the toolchain can't be had. A script or URL in the verb's place (`denext main.ts`,
`denext https://example.com/x.ts`) is `deno run`. denext's built-in verbs come first, then the
project's own verbs, then Deno's; the full list is in the [CLI reference](/docs/cli#deno-verbs).

Finding a project's verbs means importing its `denext.config.ts` (and running every plugin
`setup()`) with the CLI's own permissions, so denext does that only for a name that can be one:

- A script or URL (`denext main.ts`) never imports the config: Deno runs it with Deno's own
  permission rules, exactly as `deno run main.ts` would.
- `run`, `x`, `eval`, `serve`, `compile`, `install`, `uninstall`, `upgrade` and `task` always mean
  Deno's (or denext's own `upgrade`). A project verb or plugin `addCommand` with one of these
  names is refused when it is defined.
- Any other Deno verb (`bench`, `doc`, …) runs the project's verb of that name only when the
  project's last `denext commands` listing (`.denext/commands.json`, fingerprinted against the
  config, `deno.json` and `deno.lock`) names it — and prints one line saying it shadows Deno's.
  With no listing, or a stale one, Deno's verb runs and the config is not imported; inside a
  denext project one hint says to run `denext commands`.

## Commands

```sh
denext toolchain install       # download + verify now (fails when it can't)
denext toolchain install --with gleam   # …and the pinned Gleam compiler
denext toolchain install --with fastlane   # …and the managed fastlane (portable Ruby + gems)
denext toolchain status        # pinned versions (Deno, TypeScript, Gleam, fastlane), cache state, whether this run is on it, which esbuild builds use (--json, --verify)
denext toolchain path          # the binary's path (installs it first)
denext toolchain link          # opt-in: ~/.denext/bin/deno ($DENEXT_INSTALL/bin) → the toolchain, and the PATH line to add
denext toolchain unlink        # removes that link, and only a link it created
denext toolchain uninstall <version>   # remove a cached version: its Deno toolchain and Deno Desktop runtime
denext toolchain uninstall --all       # every cached version but the pinned one (--force: that one too)
denext toolchain prune         # every version but the pinned ones (this denext's, and the project's here)
denext deno <args…>            # run the toolchain's deno with <args…> verbatim; its exit code
denext <deno verb> <args…>     # the same for any verb denext doesn't define (falls through to Deno's verb)
```

`link` is the only command that puts the toolchain on your `PATH`, and only after you add the line
it prints. Windows gets a `deno.cmd` shim. `unlink` refuses to touch a `deno` it didn't create. After a denext
upgrade pins a newer toolchain, `denext toolchain status` warns that the link points at the old one
and `link` replaces it (commands switch to the pinned build either way).

Every version denext ever ran on stays cached until you remove it — each Deno toolchain is about
70 MB, a Deno Desktop runtime more. `uninstall <version>` removes that version's toolchain (its
esbuild, TypeScript compiler and `denort` live inside it) and the Deno Desktop runtime of the same
version. `prune` keeps only what is in use: the Deno toolchain, Deno Desktop runtime, Gleam and
fastlane this denext pins, and — inside a project that pins another denext — the ones that version
pins (read from its published pin files; offline, `prune` removes nothing unless `--force`). The
version this denext pins is refused unless you pass `--force`. Each prints what it removed and the
space freed; `--dry-run` only lists it, and `--json` reports it for scripts. They hold the cache
lock, so they never delete a download in progress.

`denext doctor` reports the toolchain as one check: the pinned version, whether it is cached and
verified, and whether the run is on it or on stock Deno, and why.

## Native TypeScript 7 type checking

From `2.9.7-denext.22` the toolchain's CLI archive ships the native TypeScript 7 compiler in
`typescript-check/` beside `deno`, so `denext check`, the dev type-check overlay, `denext test` and
every other command that type-checks run it. It is installed only when its binary and the whole
`typescript-check/` directory hash to the pin; a compiler that doesn't is refused, never installed,
and the toolchain type-checks with its in-process TypeScript 6.0.3 instead, with one warning.
`denext toolchain status` prints a `typescript` line: the version and `native, verified`, why it
was refused, or that it arrives with the toolchain.

`DENEXT_NATIVE_CHECK=0` (or `false` / `off`) keeps the in-process TypeScript 6.0.3, and a
`DENO_CHECK_ENGINE` you set yourself always wins. Before runtime 3.0.0-rc.1 the native check
doesn't resolve an absolute `file:` import (TS2307), so such a project sets
`DENEXT_NATIVE_CHECK=0` there ([known limitations](/docs/limitations)); runtime 3.0.0-rc.1+
resolves it, and also checks `--doc` code blocks and `deno bundle --check` natively; [the differences page](/docs/differences) lists how its
output differs, and the [explained type errors](/docs/error-handling#explained-type-errors) read
both checkers' wording.

The dev type-check overlay checks only the files an edit changed (and what they import). From
runtime `3.0.0-rc.2` the native check also:

- keeps the project it generates (`.deno/`) across edits that change only the app's own source,
  instead of generating it for every check (a change to `deno.json`, the lockfile, an installed
  `node_modules` or the external modules generates it again);
- checks an app whose `jsxImportSource` runtime comes through the import map (`"jsxImportSource":
  "denext"`, as every denext app has) natively under `denext test` and `run --check` too;
- reads a `tsconfig.json` as TypeScript 7 does: the options TypeScript 7 removed (`baseUrl`,
  `"moduleResolution": "node"`, `"target": "es5"`, …) are adapted rather than stopping the check,
  and the file's `paths` sit beside the import map's mappings rather than replacing them.

denext's own tooling reaches TypeScript in one place, `src/ts/`: the engine choice
(`engine.ts`), the type check the dev overlay runs (`check.ts`) and TypeScript's program API for
the parity extractors (`program-api.ts`, TypeScript 7.0's IPC client until 7.1's stable API).

## TypeScript 7 language server

The same CLI archive ships a second TypeScript 7 build in `typescript-lsp/`: the dated 7.1 nightly
(`7.1.0-dev.20261017.1` today) that `deno lsp` runs as its TypeScript 7 ("tsgo") language service.
The toolchain installs it beside `deno` under the same rule as the compiler (its binary and the
whole directory must hash to the pin's `tsgoLsp` entry, else it is refused and never installed),
and `denext toolchain status` prints a `typescript lsp` line for it.

It is the default editor backend. From runtime `3.0.0-rc.3` (so in the pinned build too) it is the runtime's
own default: its `deno lsp` runs TypeScript 7 with no setting at all, or with an empty
`deno.unstable` list (what editors send by default). denext still writes the entry, which earlier
runtimes need:

- `denext create` / `init` and `denext migrate` write `"deno.unstable": ["tsgo-lsp"]` into
  `.vscode/settings.json` beside `"deno.enable": true`;
- `denext upgrade` adds the same entry to an existing project whose `.vscode/settings.json` turns
  the Deno language server on and sets no `deno.unstable` of its own (`--dry-run` / `--check`
  report it without writing). The entry goes in right after the opening `{`; the rest of the file
  keeps its bytes.

A `deno.unstable` the project already sets, an empty list included, is never changed. To keep the
TypeScript 6 service:

| Where              | How                                                                                                                                             |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| One editor session | `DENO_UNSTABLE_TSGO_LSP=0` in the environment `deno lsp` starts with (it overrides the setting either way)                                      |
| One project        | a `deno.unstable` list in `.vscode/settings.json` that names other features but not `"tsgo-lsp"` (before `3.0.0-rc.3`, an empty list too)       |
| What denext writes | `DENEXT_TSGO_LSP=0` (or `false` / `off` / `no`) when running `create`, `migrate` or `upgrade` (from `3.0.0-rc.3` this alone keeps TypeScript 7) |

The editor runs whichever `deno` it finds, so point it at the toolchain: `denext toolchain link`
puts it on `PATH`, or set the Deno extension's `deno.path` to what `denext toolchain path` prints.
A `deno` that doesn't find `typescript-lsp/` beside itself downloads the same pinned build into
`DENO_DIR` on first use and checks it against the integrity compiled into the runtime. Stock Deno
has no TypeScript 7 backend and keeps its TypeScript 6 service.

The backend learns a project's import map, `jsr:` / `npm:` packages and Deno's own types from the
stock `tsconfig.json` + `.deno/` tree that `deno sync-types` generates, which it runs for each
workspace root: a project with no `tsconfig.json` gets one that only extends
`./.deno/tsconfig.json` (marked `"_deno_generated": true`; a new denext app's `.gitignore` lists
`/tsconfig.json`), and an existing one gets `"./.deno/tsconfig.json"` added to its `extends`.
denext's own `paths` reading skips the generated config. What the TypeScript 7 service doesn't do
yet, next to the TypeScript 6 one, is listed in [known limitations](/docs/limitations).

## npm packages as on Node.js

From `2.9.7-denext.22`, on the toolchain (`denext dev`, `build`, `start`, `test`, jobs), a project
with a `package.json` and **no `deno.json`** — an app brought over from Node.js — resolves npm
packages and TypeScript as Node.js and its tools do. A native denext app has a `deno.json` and
keeps Deno's resolution:

- `deno install` writes npm's hoisted `node_modules`, so a dependency's dependency (such as `ms`
  under `debug`) resolves from app code and from tools that walk `node_modules`. `node-linker=isolated`
  in `.npmrc`, `--node-modules-linker=isolated` or a `deno.json` keeps the isolated layout.
- Packages resolve with Node.js's export conditions, not Deno's `"deno"` condition (a package's
  Deno build can lack its Node.js API). `"denoCondition"` in `deno.json` / `package.json` chooses
  per package.
- TypeScript resolves as tsx and ts-node resolve it: extensionless, directory and `.js`-for-`.ts`
  relative imports, and `tsconfig.json` `compilerOptions.paths` at run time.
  `DENO_NO_SLOPPY_IMPORTS=1` / `DENO_NO_TSCONFIG_PATHS=1` opt out.

In every project, an untyped `.js` file that uses CommonJS (`require`, `module.exports`) and no ES
module syntax runs as CommonJS, as Node.js detects it (`DENO_NO_DETECT_CJS=1` opts out).
`better-sqlite3` is served over the built-in SQLite engine, so Drizzle, Knex and Kysely on it run
unchanged (`DENO_NO_BETTER_SQLITE3_COMPAT=1` loads the package's own code).

More dependencies install, too:

- git (`github:user/repo`, `git+https://…#tag`, `#semver:<range>`) and tarball URL dependencies
  install and are recorded in `deno.lock` (a tarball by its integrity, a git dependency by its
  commit).
- The project's own lifecycle scripts (`postinstall`, `prepare`) run on install with their output,
  as npm runs them; a dependency's still need approval. `.npmrc` `ignore-scripts=true` is honoured.
- `node` and `node-gyp` work inside lifecycle scripts, and `denext x --install-node-shims` writes
  `node`, `npx` and `npm` executables that map onto the toolchain.

## Windows as a dev host

Windows (x64 and Arm64) is a supported development machine. Install the CLI per user, with no
administrator rights, into `%USERPROFILE%\.denext\bin`:

```powershell
irm https://denext.dev/install.ps1 | iex
```

It installs the native Arm64 binary on Windows on Arm. Scoop (`scoop bucket add denext
https://github.com/Brainwires/scoop-denext`, then `scoop install denext/denext`) and winget
(`winget install Brainwires.denext`) work too; see [getting started](/docs/getting-started). The
toolchain is pinned for `windows-x86_64` and `windows-aarch64`.

CI runs denext's unit and integration suites on Windows x64 (`windows-tests`), module resolution on
every push (`windows-resolve`), and the desktop suites, installers and `install.ps1` on Windows x64
and Arm64 (`desktop-ci`). What works:

- `dev`, `build`, `export` (a ReFS Dev Drive included), `start`, `test` and `doctor`.
- `denext build --compile`, with `--sign` through `signtool` (a Windows binary can also be signed
  from macOS or Linux with `osslsigncode`).
- Tailwind; Windows on Arm runs Tailwind's x64 build under emulation (Tailwind publishes no Arm64
  one).
- `denext desktop run`, `dev` and `package` (the `.msi` needs WiX 5).

Not on Windows: `denext fastlane` and iOS builds (both need macOS).

A `deno.json` `file:` target on another drive (an app on `C:` importing a checkout on `D:`, as
`migrate --denext-local-path` writes) resolves on the toolchain from runtime `3.0.0-rc.3`, and a
workspace member's mapping to a module on another drive from `3.0.0-rc.5`. Stock
Deno 2.9 still resolves it as `file:///C:/D:/…`, so under `DENEXT_DENO=stock` keep the project and
its `file:` targets on one drive.

## Supply-chain hold

Deno holds a package version published less than its _minimum dependency age_ ago out of
resolution: a compromised release is refused while it is fresh. The window is the root
`deno.json`'s `minimumDependencyAge` (minutes, an ISO-8601 duration such as `"P3D"`, a fixed date,
or `{ "age": …, "exclude": [...] }`), else `.npmrc`'s `min-release-age`, else Deno's default
(Deno 2.9.7 holds two days, although its error hint says 24 hours). denext's own packages wait
like every other dependency: denext never switches the hold off on your behalf, and only forwards
a `--min-dep-age` you set yourself (`DENEXT_MIN_DEP_AGE`) to the Deno processes it starts.

`denext create`, `denext migrate` and `denext upgrade` pin the newest `@denext/*` versions the
hold already lets in, read from JSR's publish times. On the day of a release that can be the
previous version; the command says so in one line and pins it:

```text
denext 4.5.2 was published 3 h ago; your dependency-age rule allows it from Oct 22, 3:12 PM CDT. Pinned 4.5.1 for now — run "denext upgrade" after that.
```

Plugins and the other first-party packages get versions that are old enough and work with the
denext pinned. When no version is old enough the command stops with the same explanation instead
of Deno's resolver error; when JSR can't be reached it keeps the pins it would write and warns
that Deno may hold them.

Projects made by `denext create` / `migrate` from 3.0 to 4.5.1 exempted `jsr:@denext/*` in
`minimumDependencyAge.exclude`. `denext upgrade` removes that one entry (your other entries stay)
and says why. **If you publish denext yourself** and want your own releases resolved the moment
they are out, add it back to the project's `deno.json`, knowing it lets any just-published
`@denext/*` version in:

```json
"minimumDependencyAge": { "exclude": ["jsr:@denext/*"] }
```

## Supply chain: lifecycle-script jail

An approved dependency's lifecycle script (`preinstall`, `install`, `postinstall`, approved with
`--allow-scripts` or deno.json `allowScripts`) runs **jailed** on denext's Deno: a scrubbed
environment (no `GITHUB_TOKEN`, `NPM_TOKEN` or other credentials), a scratch `HOME` removed after
the script, writes only beneath `node_modules`, no credential files, no network, every `deno` it
starts clamped to the same limits, and the OS confining the whole process tree where it can
(Landlock and seccomp on Linux, `sandbox-exec` on macOS). A compromised package's install script
then can't read your tokens, phone home or rewrite your project. The project's own scripts (the
root `package.json`, workspace members) are your code and are not jailed.

- **The default.** From runtime `3.0.0-rc.5` the jail is on unless the project turns it off.
  Earlier runtimes (the `3.0.0-rc.3` and `rc.4` pins) jail only on request: `--jail-scripts`,
  `jail-scripts=true` in `.npmrc` (or `npm_config_jail_scripts=true`), deno.json
  `"supplyChain": { "jailScripts": true }`, or `paranoid`.
- **Opting out** (not recommended): `--no-jail-scripts`, `jail-scripts=false` in `.npmrc` or
  `npm_config_jail_scripts=false`, or deno.json `"supplyChain": { "jailScripts": false }`. Where
  sources disagree the stricter one wins, so a `.npmrc` can't quietly undo what deno.json asks for;
  under `paranoid` every opt-out is an error. denext never turns the jail off for you.
- **Per-package exceptions** keep the jail on and widen it for one package: environment variables
  passed through, extra writable directories (relative to deno.json; create them first, Linux
  skips a missing one) and the network. There is no per-host network list; a node-pre-gyp
  package's declared `binary.host` is allowed by itself.

```json
{
  "supplyChain": {
    "jailScripts": {
      "packages": {
        "puppeteer": {
          "net": true,
          "env": ["PUPPETEER_CACHE_DIR", "PUPPETEER_DOWNLOAD_BASE_URL", "PUPPETEER_SKIP_DOWNLOAD"]
        },
        "msw": { "write": ["public"] }
      }
    }
  }
}
```

An exceptions object counts as asking for the jail: on Windows, where the OS can't confine the
script's other programs, an install then prints a one-line warning saying so.

**denext writes the exceptions for you.** `denext migrate`, `denext create` / `init` (next to an
existing `package.json`) and `denext add` find the dependencies in denext's built-in list below
and, when the jail is on for the project, add the narrowest exception each needs to deno.json
(your comments and existing entries stay). On a runtime that jails only on request they say which
dependencies will need one and write nothing, since an exceptions object would itself turn the
jail on. `migrate` lists each exception in its review notes (`--check` too); when it keeps a
hand-authored deno.json it prints the JSON to add instead. `denext doctor` flags a listed
dependency whose exception is missing while the jail is on, and
`denext doctor --install-log install.log` (from `denext install 2>&1 | tee install.log`) explains
a dependency's failed script: which package, what the jail stopped (the network, a write outside
`node_modules`, a real `npm` / `npx`) and the exception to add.

| Package                                             | Why its script needs more                                                                                 | Exception                                                                                    |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `@prisma/client`                                    | postinstall runs `prisma generate` (may fetch the engines; writes the client to the generator's `output`) | `net`, Prisma's env, `write`: each `output` outside `node_modules`                           |
| `@prisma/engines` (with `prisma`, `@prisma/client`) | postinstall downloads the engines from binaries.prisma.sh                                                 | `net`, `PRISMA_*` mirror and engine-path env                                                 |
| `@sentry/cli`                                       | downloads the binary when the platform package is missing                                                 | `net`, `SENTRYCLI_*`                                                                         |
| `@tensorflow/tfjs-node`                             | downloads libtensorflow                                                                                   | `net`                                                                                        |
| `better-sqlite3`                                    | `prebuild-install` from GitHub, else node-gyp                                                             | `net` (or leave it unapproved: the toolchain serves better-sqlite3 over the built-in SQLite) |
| `canvas`                                            | `prebuild-install` from GitHub (canvas 3), else node-gyp                                                  | `net`                                                                                        |
| `chromedriver`                                      | downloads chromedriver into its package                                                                   | `net`, `CHROMEDRIVER_*`                                                                      |
| `cypress`                                           | downloads the Cypress app into `~/.cache/Cypress`                                                         | `net`, `CYPRESS_CACHE_FOLDER` / `_INSTALL_BINARY` / `_DOWNLOAD_MIRROR`                       |
| `electron`                                          | downloads Electron and unpacks it into its package                                                        | `net`, `ELECTRON_*` mirror / skip env                                                        |
| `ffmpeg-static`                                     | downloads ffmpeg into its package                                                                         | `net`, `FFMPEG_BINARIES_URL`                                                                 |
| `keytar`                                            | `prebuild-install` from GitHub, else node-gyp                                                             | `net`                                                                                        |
| `lefthook`                                          | `lefthook install` writes `.git/hooks`                                                                    | `write`: the repository's `.git/hooks`                                                       |
| `msw`                                               | copies `mockServiceWorker.js` into `msw.workerDirectory`                                                  | `write`: those directories                                                                   |
| `node-pty`                                          | node-gyp build when no prebuilt binary matches                                                            | `net`                                                                                        |
| `node-sass`                                         | downloads the libsass binding from GitHub                                                                 | `net`, `SASS_BINARY_*`                                                                       |
| `playwright-chromium`, `-firefox`, `-webkit`        | download their browser into the Playwright cache                                                          | `net`, `PLAYWRIGHT_BROWSERS_PATH` / `_DOWNLOAD_HOST` / `_SKIP_BROWSER_DOWNLOAD`              |
| `puppeteer`                                         | downloads Chrome for Testing into `~/.cache/puppeteer`                                                    | `net`, `PUPPETEER_CACHE_DIR` / `_DOWNLOAD_BASE_URL` / `_SKIP_DOWNLOAD`                       |
| `re2`                                               | downloads a prebuilt binding from GitHub, else node-gyp                                                   | `net`                                                                                        |
| `sharp`                                             | before 0.33 downloads libvips; later only a build from source needs the network                           | `net`, `SHARP_*_GLOBAL_LIBVIPS`                                                              |
| `simple-git-hooks`                                  | writes `.git/hooks`                                                                                       | `write`: the repository's `.git/hooks`                                                       |
| `sqlite3`                                           | `prebuild-install` from GitHub, else node-gyp                                                             | `net`                                                                                        |

The packages that download a browser or app into a cache under your home (puppeteer, Playwright's
browser packages, Cypress) get the network, but the jail's scratch `HOME` is removed after the
script: point the cache variable (`PUPPETEER_CACHE_DIR`, `PLAYWRIGHT_BROWSERS_PATH`,
`CYPRESS_CACHE_FOLDER`) at a directory in the project and add it to `write`, or skip the download
there and fetch the browser afterwards with the tool's own command (`playwright install`,
`puppeteer browsers install chrome`). A build from source with
node-gyp downloads the Node.js headers (`npm_config_nodedir` points it at local ones). Not listed,
because they need nothing: `esbuild` (its binary is an optional dependency), `bcrypt`, `playwright`
(no install script), `husky` 9 (the project's own `prepare`) and `bufferutil`.

## Notes: how denext's Deno build is kept current

<a id="versions"></a>**Versions.** Up to `2.9.7-denext.22` each build was named after the Deno release it
was built from plus `-denext.N`. From `3.0.0-rc.1` (then `3.0.0-rc.2`, …) the fork has its own
version, which names no Deno release; `3.0.0` final carries Deno's planned 3.0 milestone. The two
schemes sort in release order by semver (`2.9.7-denext.22` < `3.0.0-rc.1` < `3.0.0-rc.10` <
`3.0.0`), and denext accepts both: a pin, a `Deno.version.deno` and a `DENO_BIN` are compared that
way. The Deno release a build is made from is the pin's `deno` field (2.9.7 up to `3.0.0-rc.3`,
2.9.8 from `3.0.0-rc.4`): it is what a `Dockerfile`'s `denoland/deno` tag, `setup-deno` and the
[Deno Desktop runtime](/docs/desktop-runtime)'s "Deno 2.9.8 exactly" check use. Releases are tagged
`denext-runtime-v<version>` on [Brainwires/deno](https://github.com/Brainwires/deno/releases). The
toolchain's own `deno upgrade` is off from `3.0.0-rc.1` (it would replace denext's build with
stock Deno): `denext upgrade` moves the pin, or `denext toolchain install` fetches it.

<a id="identity"></a>**Telling denext's Deno from upstream Deno.** Upstream Deno releases a
`3.0.0` too, so a version such as `3.0.0-rc.3` does not say whose runtime it is. From `3.0.0-rc.3`
denext's Deno carries an identity marker: `Deno.build.denext` (its version, a string; absent on
upstream Deno) and a last line in `deno --version`:

```
deno 3.0.0-rc.5 (stable, release, aarch64-apple-darwin)
v8 15.0.245.2-rusty
typescript 6.0.3
denext 3.0.0-rc.5 (Brainwires)
```

denext recognises its toolchain and the `deno` a desktop build runs by that marker (in its own
process by `Deno.build.denext`, for another binary by the `--version` line): whether a command
already runs on the toolchain, `denext toolchain status`, `denext doctor`, the native type check,
the Deno release a Dockerfile or CI workflow is generated for, the desktop runtime's "Deno 2.9.8
exactly" check and the direction-split network flags. An upstream `3.0.0-rc.N` or `3.0.0` is stock
Deno whatever its number. A build from before the marker is recognised by its version only:
`2.9.7-denext.N`, or exactly the pinned toolchain while the pin predates the marker (`3.0.0-rc.2`
and earlier). A runtime release from `3.0.0-rc.3` must record the marker in its manifest
(`cli.identity`), or `deno task desktop:pin-runtime` refuses it.

**Tracking Deno.** The toolchain is Deno's latest release (2.9.8) plus denext's patches — `Deno.SQL`,
Vitest/Jest compatibility in `deno test` and the [Deno Desktop runtime](/docs/desktop-runtime) work —
published (as `2.9.7-denext.N`, then `3.0.0-rc.N`) with SHA-256 sums and build attestations. Between Deno releases we
review what Deno's main branch has gained and take the fixes that matter: `2.9.7-denext.16` took the
read-permission check for a compiled program's dynamic import, two Node-API fixes, coverage runs
skipping V8's code cache, the HTTP connection-pool fix and the `rand` security update, and
`2.9.7-denext.19` took deno_core's fix for an intermittent crash at exit. From `2.9.7-denext.20`
each release also ships its own `denort` per platform (the standalone runtime `deno compile`
builds onto), pinned and verified beside the CLI, so a binary from `denext build --compile` (or
the toolchain's own `deno compile`) carries the same patches, `Deno.SQL` included.
`2.9.7-denext.21` adds Windows on Arm (`aarch64-pc-windows-msvc`) builds of the CLI and `denort`,
and a compiled program keeps `--unstable-no-legacy-abort`. `2.9.7-denext.22` type-checks with the native TypeScript 7 compiler, shipped in the CLI zip and pinned
like the binary, and runs npm packages more as Node.js does; that check doesn't resolve an absolute
`file:` import (runtime 3.0.0-rc.1+ does), so such a project sets `DENEXT_NATIVE_CHECK=0`
([known limitations](/docs/limitations)). Each new Deno
release is adopted by rebasing the patches onto it and cutting a new release (`-denext.N` up to
`2.9.7-denext.22`, the fork's own `3.0.0-rc.N` from then on). `3.0.0-rc.2` adds
`--max-memory` / `--max-cpu-time` / `--max-time` and `--allow-net-connect` /
`--allow-net-listen`, and takes the rustls / rustls-webpki / webpki-roots security fixes.
`3.0.0-rc.3` adds the identity marker above, makes TypeScript 7 the
language server's own default, keeps a `--watch` child's IPC channel across restarts, resolves a
`file:` link on another Windows drive, checks the files after `deno check --`, and gives the native
check's TS2307 Deno's `deno add` hint. `3.0.0-rc.4` is built from Deno 2.9.8 (X.509 v1 TLS
certificates handled as OpenSSL does, safer npm symlinking, zsh completions, `mock.reset()`, the
distrusted eMudhra CAs removed). `3.0.0-rc.5` (the build denext pins today) makes two Deno 3.0
behaviors the default: `request.signal` aborts only when a response is not delivered
(`--unstable-legacy-abort` or `DENO_LEGACY_ABORT=1` restores the old abort), and an approved
dependency's lifecycle script runs [jailed](#supply-chain-lifecycle-script-jail). It adds
type-aware lint rules (`deno lint --type-aware`, or `"lint": { "typeAware": true }`: typescript-eslint's
`no-floating-promises`, `no-misused-promises`, `await-thenable` and others through a pinned tsgolint
shipped in the CLI zip; off by default) and `--unstable-idle-trim` (a full GC and `malloc_trim`
when the event loop goes idle, so a server's memory returns to the OS after a burst; glibc Linux
only). On Windows a spawned child inherits only its own handles, so a concurrent spawn no longer
keeps another's output pipe open (`.output()` waited for the unrelated process to exit), and a
workspace member's import map can map a module on another drive. Deno's next minor
replaces its TypeScript fork with stock TypeScript 6, so that move is a larger rebase than usual.

**Support across denext releases.** The patches are carried forward from release to release. Each
denext release pins exactly one build (a SHA-256 per target, checked on download), so a project
always runs the build its denext version was tested with, and upgrading denext moves the build with
it. `DENEXT_DENO=stock` always works: what needs the build (`Deno.SQL`, Vitest/Jest compatibility,
the bundled esbuild) falls back or says why it can't.

**Bootstrapping.** The first command that runs project code — or the installer, ahead of time —
downloads the pinned build for the platform into `<DENO_DIR>/denext-deno/`, verifies its SHA-256
against the pin, records a stamp and re-runs itself on it. Every child process it starts (tasks,
the UI, the MCP server, builds) finds that `deno` first on `PATH`. The `deno` on your `PATH` is never
replaced (`denext toolchain link` opts in), and a failed download stops the command with the fix
(earlier versions fell back to stock Deno with one warning). From `2.9.7-denext.17` the same download also carries esbuild 0.25.5.
