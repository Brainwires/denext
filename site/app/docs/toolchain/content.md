---
title: "denext's Deno toolchain"
slug: toolchain
lead: You install denext, nothing else — stock Deno is optional. The denext commands that run Deno run it on denext's own Deno build, which adds Deno.SQL and Vitest/Jest compatibility to deno test. It downloads on first need, is pinned by version and SHA-256, and never replaces a deno on your PATH.
---

denext's Deno toolchain is the Deno CLI built from the public
[Brainwires/deno](https://github.com/Brainwires/deno) fork (`2.9.7-denext.N`): stock Deno plus
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
both steps). A `deno` you already have is never replaced.

The CLI's entrypoint is thin: it loads only the argument parser and a generated table of every
verb's name, flags and help, and imports a verb's own code when that verb runs, so `denext
--version` and `--help` never load the dev server, the bundler or `denext/server`. A CLI installed
from JSR (`deno install -A -g -n denext jsr:@denext/denext/cli`) therefore fetches each verb's code
the first time that verb runs. `denext toolchain install` also caches every verb, and the CLI's
first online run does the same in the background (a failed attempt retries after 10 minutes), so a
verb used offline afterwards (`--cached-only`, `denext ui --offline`) still loads. The binary
embeds every verb already.

When the toolchain can't be had (offline on first use, `DENEXT_DENO=stock`, a host with no build)
the binary falls back to a stock `deno` — `DENO_BIN`, `~/.deno/bin/deno`, then `deno` on PATH —
and with none of those it stops with one error that names the fix: run `denext toolchain install`
once you are online, or install Deno.

## Which commands use it

The commands that execute your project's code switch to the toolchain on their own:

| Command                                                                                                       | On the toolchain                 |
| ------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `dev`, `build`, `export`, `start`                                                                             | yes                              |
| `test`, `check`, `job`                                                                                        | yes                              |
| `analyze`, `profile`, `doctor`                                                                                | yes                              |
| `desktop run \| dev \| build \| package`                                                                      | yes                              |
| `mobile dev \| build`                                                                                         | yes                              |
| a project's own verbs (`denext.config.ts` `commands`, plugins)                                                | yes                              |
| `task`, and every Deno verb denext forwards (`compile`, `run`, `x`, …)                                        | yes (stock when it can't be had) |
| help, `--version`, `create`, `generate`, `migrate`, `upgrade`, `add`, `lint`, `fmt`, `ui`, `mcp`, `toolchain` | no (yes under the binary)        |

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

The switch also passes the toolchain's runtime flag, `--unstable-no-legacy-abort`: `request.signal`
aborts only when a response is not delivered, and Deno prints no legacy-abort notice on the first
request. A server verb (`dev`, `start`, `profile`) started on the toolchain directly (the `deno`
that `toolchain link` puts on PATH, or a `deno task` step running it) checks whether it has that
flag, with one loopback request, and re-runs once on the same binary with it when it does not.
Without `--allow-run` it keeps serving in-process, so the `deno.json` that `denext create` and
`denext migrate` write carries `"unstable": ["no-legacy-abort"]`, which turns the flag on for every
`deno` that reads the config (a least-privilege `start` task included). Add it to an older
project's `deno.json` (the Setup page of `denext ui` offers to), beside any features already listed.

A compiled `denext` binary can't change its own runtime. It hands the toolchain to the processes it
starts instead (through `DENO_BIN`, unless you set `DENO_BIN` yourself), and the project's pinned
denext then runs on it. Finding a project's own verbs (`denext commands`, a project verb,
completions) also re-runs on the project's pinned denext, so the config resolves through the
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
  unexecuted and the command continues on stock Deno with a loud warning.
- The verified binary is renamed into place atomically, and a stamp file records its size,
  modification time and hash. Later runs trust it only while it still has that size and
  modification time; otherwise it is re-hashed, and a missing stamp means a fresh download. That
  fast path is the same trust Deno gives its own module cache: whoever can write to `DENO_DIR`
  can change what runs, so keep a shared or group-writable `DENO_DIR` to trusted users (or run
  `denext toolchain status --verify`).
- Two commands starting at once download it once: the second prints
  `Blocking waiting for file lock on Deno toolchain cache` and adopts the first one's binary.

## Opting out, and when it falls back

| Setting              | Effect                                                                  |
| -------------------- | ----------------------------------------------------------------------- |
| `DENEXT_DENO=stock`  | Everything runs on the Deno that started the CLI, silently.             |
| `DENEXT_DENO=<path>` | That binary is used as the toolchain, unverified (one warning per run). |

The toolchain never makes a command fail. On a platform with no pinned build, offline, or behind a
failed download, the command prints one warning saying why and continues on stock Deno. A process
that lacks the grants to install and run it (`--allow-run`, and read/write on the cache
directory) stays on the Deno that launched it without a warning: that is the least-privilege
`start` task `denext create` scaffolds (`deno run --allow-net --allow-read --allow-env
--allow-write=.denext …`), so production `start` runs on whichever `deno` started it. That
`start` spawns no child process (the build already wrote what it serves), so it needs no
`--allow-run` either. Run `start`
with `-A` (or add `--allow-run` and write access to the cache) to serve on the toolchain, or
start the server with `denext deno run …`. `denext toolchain status` says which Deno a command
runs on. Only `denext toolchain install` fails when the toolchain can't be had, since installing
it is all it does.

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
`denext deno`, a forwarded verb falls back to stock Deno (with the usual one warning) when the
toolchain can't be had. A script or URL in the verb's place (`denext main.ts`,
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
denext toolchain status        # pinned versions (Deno, Gleam, fastlane), cache state, whether this run is on it, which esbuild builds use (--json, --verify)
denext toolchain path          # the binary's path (installs it first)
denext toolchain link          # opt-in: ~/.denext/bin/deno → the toolchain, and the PATH line to add
denext toolchain unlink        # removes that link, and only a link it created
denext deno <args…>            # run the toolchain's deno with <args…> verbatim; its exit code
denext <deno verb> <args…>     # the same for any verb denext doesn't define (stock fallback)
```

`link` is the only command that puts the toolchain on your `PATH`, and only after you add the line
it prints. Windows gets a `deno.cmd` shim. `unlink` refuses to touch a `deno` it didn't create. After a denext
upgrade pins a newer toolchain, `denext toolchain status` warns that the link points at the old one
and `link` replaces it (commands switch to the pinned build either way).

`denext doctor` reports the toolchain as one check: the pinned version, whether it is cached and
verified, and whether the run is on it or on stock Deno, and why.

## Notes: how denext's Deno build is kept current

**Tracking Deno.** The toolchain is Deno's latest release (2.9.7) plus denext's patches — `Deno.SQL`,
Vitest/Jest compatibility in `deno test` and the [Deno Desktop runtime](/docs/desktop-runtime) work —
published as `2.9.7-denext.N` with SHA-256 sums and build attestations. Between Deno releases we
review what Deno's main branch has gained and take the fixes that matter: `2.9.7-denext.16` took the
read-permission check for a compiled program's dynamic import, two Node-API fixes, coverage runs
skipping V8's code cache, the HTTP connection-pool fix and the `rand` security update, and
`2.9.7-denext.19` took deno_core's fix for an intermittent crash at exit. From `2.9.7-denext.20`
each release also ships its own `denort` per platform (the standalone runtime `deno compile`
builds onto), pinned and verified beside the CLI, so a binary from `denext build --compile` (or
the toolchain's own `deno compile`) carries the same patches, `Deno.SQL` included.
`2.9.7-denext.21` (the build denext pins today) adds Windows on Arm (`aarch64-pc-windows-msvc`)
builds of the CLI and `denort`, and a compiled program keeps `--unstable-no-legacy-abort`. Each new Deno
release is adopted by rebasing the patches onto it and cutting a new `-denext.N`. Deno's next minor
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
replaced (`denext toolchain link` opts in), and a failed download falls back to stock Deno with one
warning. From `2.9.7-denext.17` the same download also carries esbuild 0.25.5.
