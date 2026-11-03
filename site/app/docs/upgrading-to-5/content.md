---
title: Upgrading to denext 5.0
slug: upgrading-to-5
lead: denext 5.0 runs only on its own Deno runtime. The stock-Deno opt-outs are gone, and every way of running denext on another Deno now stops with one error that names the fix.
---

denext 4.x ran on [denext's Deno toolchain](/docs/toolchain) by default and let you opt out to the
Deno that started it, with a deprecation notice. 5.0 removes the opt-outs: every command, build,
test and desktop window runs on the pinned runtime (`3.0.0-rc.5` or later), and nothing else.

Most projects need one step: run `denext toolchain install` once (the installer already does), and
run tasks, builds and tests through `denext`.

## Upgrade in four steps

1. Move the pins: `denext upgrade --to 5.0.0` (`--dry-run` shows the plan). It also rewrites the
   `deno run -A scripts/package-*.ts` tasks an older `denext create --desktop` wrote, and removes
   `"no-legacy-abort"` from `deno.json`'s `unstable`.
2. Unset `DENEXT_DENO=stock` and `DENEXT_DESKTOP_RUNTIME=stock` wherever you set them: your shell
   profile, `.env` files, CI workflows, Dockerfiles, systemd units.
3. Install the toolchain once: `denext toolchain install`. It downloads the pinned build and
   checks its SHA-256. Commands download it on first need as well, so this step matters most on a
   machine that will be offline.
4. Run your project's commands through denext: `denext task <name>`, `denext test`,
   `denext desktop package`. A plain `deno task` or `deno test` runs the `deno` on your PATH, and a
   build or test it starts refuses unless that `deno` is denext's runtime.

## What breaks

| 4.x                                                                                                  | 5.0                                                                                                       |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `DENEXT_DENO=stock` runs every command on the Deno that started the CLI (with a deprecation notice). | Refused.                                                                                                  |
| `DENEXT_DESKTOP_RUNTIME=stock` builds desktop windows on the stock Deno Desktop runtime.             | Refused.                                                                                                  |
| `DENEXT_DENO=<path>` and a `DENO_BIN` of yours may name any `deno`.                                  | They must name a build of denext's runtime, `3.0.0-rc.5` or later, told by its `--version` identity line. |
| A compiled `denext` with no toolchain falls back to `~/.deno/bin/deno` or a `deno` on PATH.          | It refuses with `denext toolchain install`.                                                               |
| A build or `createTestApp()` under a plain `deno test` on upstream Deno runs, or fails later.        | `build()`, `createTestApp()` and `probeApp()` refuse up front; so does any bundle.                        |
| `denext desktop run` / `dev` fall back to the stock runtime when the `deno` doesn't match.           | They always build on the toolchain; another `deno` is refused.                                            |
| esbuild falls back to the npm `@esbuild/<platform>` binary.                                          | esbuild comes from the toolchain, or `ESBUILD_BINARY_PATH`.                                               |
| `DENEXT_NO_DEPRECATION_WARNINGS` hides the stock-Deno notice.                                        | Not read: there is no notice, each path is an error.                                                      |

The checks for an older or stock runtime are gone with them: the idle trim, the lifecycle-script
jail, the direction-split network grants and `start.limits` no longer depend on the runtime, and
`denext test` always runs `*.vitest.ts` files.

Delete `<DENO_DIR>/denext-esbuild/` if you have one: nothing reads it any more.

## What to do instead

**Use the pinned toolchain.** `denext toolchain install` fetches it, `denext toolchain status`
says whether a command runs on it, and `denext toolchain path` prints the binary. To make `deno` in
your shell and editor the toolchain too, run `denext toolchain link`.

**A runtime build of your own.** Point `DENEXT_DENO=<path>` at it. denext runs that binary after
checking its `deno --version` for the `denext <version> (Brainwires)` line (`3.0.0-rc.5` or later),
but does not pin or hash-check it. `DENO_BIN` works the same way when `DENEXT_DENO` is unset. For a
Deno Desktop runtime build, use `DENEXT_DESKTOP_RUNTIME_DIR=<an unpacked runtime build>`.

**Tasks and tests.** A task that runs `deno test` itself runs upstream Deno under a plain
`deno task`. Run it with `denext task <name>`, or make the task call denext:

```jsonc
{
  "tasks": {
    "test": "deno run -A jsr:@denext/denext@^5.0.0/cli test"
  }
}
```

`denext doctor` names the tasks that call `deno test` directly.

**Desktop packaging.** Package with `denext desktop package` (or the `desktop:package` task, which
runs it): it puts the toolchain first on the packaging script's PATH. Regenerate older scripts with
`denext desktop package --regenerate-scripts`.

**Platforms that run upstream Deno.** Deno Deploy still works. `Deno.SQL` is missing there, so give
Postgres a postgres.js client with [`fromPostgresJs`](/docs/database#postgres).

## CI

A CI job needs the toolchain, the same as your machine. Either install denext, or keep
`setup-deno` to bootstrap and run every step through the denext CLI.

With the installer (it installs the toolchain, and links `deno` to it when the runner has none):

```yaml
- uses: actions/checkout@v4
- run: curl -fsSL https://denext.dev/install.sh | sh -s -- --no-modify-path
- run: echo "$HOME/.denext/bin" >> "$GITHUB_PATH"
- run: denext task check
```

With `setup-deno`:

```yaml
- uses: actions/checkout@v4
- uses: denoland/setup-deno@v2
  with:
    deno-version: v2.9.8
    cache: true
- run: deno run -A jsr:@denext/denext@^5.0.0/cli task check
```

`denext generate ci` writes this second form: every step, `fmt --check` and `lint` included, runs
`deno run -A jsr:@denext/denext@^<version>/cli <verb>`. The toolchain downloads into
`<DENO_DIR>/denext-deno/`, so a job that caches `DENO_DIR` caches it too. Then check the workflow for:

- `DENEXT_DENO=stock` or `DENEXT_DESKTOP_RUNTIME=stock` in `env:`: remove it.
- `deno test` or `deno task` steps that start builds or `createTestApp()`: run them through denext.
- A step that runs `scripts/package-*.ts` with `deno run`: use `denext desktop package`.

Steps that never build, such as `deno fmt --check` and `deno lint`, still run on any Deno.

Docker images and systemd units from `denext generate docker` and `denext deploy prepare` already
run the server on the toolchain; nothing changes there.

## The errors you will see

Every refusal starts with `denext:`, says what it found, and ends with the same two lines:

```
denext 5.0 runs only on denext's own Deno runtime (stock Deno is no longer supported).
Fix: run `denext toolchain install`, then retry.
```

| Error starts with                                                                      | Cause                                                                                         |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `denext: DENEXT_DENO=stock is no longer supported.`                                    | The opt-out is set. Unset it.                                                                 |
| `denext: DENEXT_DESKTOP_RUNTIME=stock is no longer supported: …`                       | The desktop opt-out is set. Unset it.                                                         |
| `denext: DENEXT_DENO=<path> is upstream Deno 2.9.8 (no …), not denext's Deno runtime.` | The path names another Deno. Point it at a runtime build, or unset it.                        |
| `denext: DENEXT_DENO=<path> is not a file.`                                            | The path is wrong.                                                                            |
| `denext: there is no Deno to run — denext's Deno toolchain is not installed here.`     | A compiled `denext` with no toolchain cached.                                                 |
| `denext: bundling needs denext's Deno runtime, but …`                                  | A build started from a plain `deno run` / `deno test`.                                        |
| `denext: createTestApp() needs denext's Deno runtime, but this process runs …`         | A test under a plain `deno test`. Use `denext test`. `build()` and `probeApp()` say the same. |
| `denext: the Deno Desktop runtime … builds only with denext's Deno runtime …`          | A packaging task run by a plain `deno task`.                                                  |
| `denext: no usable esbuild 0.25.5: …`                                                  | No toolchain to take esbuild from, and no `ESBUILD_BINARY_PATH`.                              |

Offline on first use, on a host with no pinned build, or after a failed download, the command
stops with the reason and the same fix, `denext toolchain install` once you are online.
`denext doctor` reports the same as a failed toolchain check.

If you can't move yet, stay on denext 4.x: there the opt-outs still work, with a deprecation notice.
The [changelog](/docs/changelog) lists every 5.0 change.
