---
title: "denext's Deno toolchain"
slug: toolchain
lead: You install stock Deno and denext, nothing else. The denext commands that run your project's code run it on denext's own Deno build, which adds Deno.SQL and Vitest/Jest compatibility to deno test. It downloads on first need, is pinned by version and SHA-256, and never replaces the deno on your PATH.
---

denext's Deno toolchain is the Deno CLI built from the public
[Brainwires/deno](https://github.com/Brainwires/deno) fork (`2.9.7-denext.N`): stock Deno plus
`Deno.SQL` (the Postgres client behind [`postgresClient()`](/docs/database#postgres)) and
Vitest/Jest compatibility in `deno test`. denext manages it the same way it manages the
[Deno Desktop runtime](/docs/desktop-runtime): each denext release pins one build per platform by
version and SHA-256, downloads it the first time a command needs it, verifies it, and reuses the
verified copy from then on.

There is nothing to install and nothing to configure. Install Deno and denext as usual.

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
| help, `--version`, `create`, `generate`, `migrate`, `upgrade`, `add`, `lint`, `fmt`, `ui`, `mcp`, `toolchain` | no                               |

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

A compiled `denext` binary can't change its own runtime. It hands the toolchain to the processes it
starts instead (through `DENO_BIN`, unless you set `DENO_BIN` yourself), and the project's pinned
denext then runs on it.

## Where it lives, and how it is verified

The binary is cached beside Deno's own cache:

```text
<DENO_DIR>/denext-deno/<version>/<platform>/deno      (deno.exe on Windows)
```

`DENO_DIR` defaults to `~/Library/Caches/deno` on macOS, `~/.cache/deno` on Linux and
`%LOCALAPPDATA%\deno` on Windows. The pinned platforms are `darwin-aarch64`, `darwin-x86_64`,
`linux-x86_64`, `linux-aarch64` and `windows-x86_64`.

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
--allow-write=.denext …`), so production `start` runs on whichever `deno` started it. Run `start`
with `-A` (or add `--allow-run` and write access to the cache) to serve on the toolchain, or
start the server with `denext deno run …`. `denext toolchain status` says which Deno a command
runs on. Only `denext toolchain install` fails when the toolchain can't be had, since installing
it is all it does.

`DENO_BIN`, when you set it, still decides which `deno` the CLI's own child processes run.

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
    "test": "deno run -A jsr:@denext/denext@^3/cli test",
    // or run any deno subcommand on it, arguments verbatim
    "test:raw": "denext deno test -A"
  }
}
```

The Vitest/Jest layer reads environment variables (`FORCE_TTY` and the others Vitest reads), so
a `deno test` without `-A` needs `--allow-env` too: `denext deno test --allow-env --allow-read
…`. `denext test` runs `deno test -A` and needs nothing more.

denext never rewrites the tasks in your existing `deno.json`; `denext doctor` names the tasks that
call `deno test` directly so you can change them, or run them with `denext task`.

## Every other Deno command

A verb denext does not define itself is Deno's, run on the toolchain exactly as
`denext deno <verb>` would — `denext compile`, `denext run`, `denext x`, `denext bench`,
`denext serve`, … — with the arguments verbatim and the exit code and signals passed back. Like
`denext deno`, a forwarded verb falls back to stock Deno (with the usual one warning) when the
toolchain can't be had. A script or URL in the verb's place (`denext main.ts`,
`denext https://example.com/x.ts`) is `deno run`. denext's built-in verbs come first, then the
project's own verbs (a project verb that shadows a Deno verb prints one line saying so), then
Deno's; the full list is in the [CLI reference](/docs/cli#deno-verbs).

## Commands

```sh
denext toolchain install       # download + verify now (fails when it can't)
denext toolchain status        # pinned version, cache state, whether this run is on it (--json, --verify)
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
