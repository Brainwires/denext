---
title: "The runtime channel"
slug: runtime-channel
lead: A denext runtime (the Deno toolchain and the Deno Desktop runtime, from one build) can ship without a denext release. Every denext still bundles a tested runtime; the channel lets you move to a newer one on purpose, verified by a signature and locked by a hash.
---

> **Draft.** This page describes the runtime channel as it is being built. The resolver and the
> `denext runtime` commands are in place; the published channel and the installer's use of it
> follow. Until a channel is published, denext runs the runtime it bundles, as described in
> [denext's Deno toolchain](/docs/toolchain).

## Why there is a channel

Each denext release compiles in one runtime release (the _bundled pin_) and its predecessor (the
_rollback_). That keeps a fresh install working offline and reproducible, but it also means a fix
that lives only in the runtime used to wait for the next denext release. The channel removes that
wait: maintainers publish a runtime release once, and any denext that supports it can move to it.

Nothing moves on its own. A command never asks the network which runtime to run: it runs the
runtime your project pins, else the one you chose for your machine, else the bundled one. The
channel only matters when you run `denext runtime upgrade`, `denext runtime install`,
`denext runtime use` or the installer, and denext prints one line when a newer runtime is
available.

## What runs, and why

denext picks one release for `deno`, the `denort` inside `build --compile` binaries and the Deno
Desktop runtime together, so they can never disagree. The first match wins:

1. `DENEXT_DENO=<path>` or `DENEXT_TOOLCHAIN_PIN_FILE` (development overrides).
2. `DENEXT_RUNTIME=<version>` for one command (`DENEXT_RUNTIME=bundled` for the bundled one). The
   release must be installed or listed in the channel; a listed one's release document is fetched
   and verified on first use.
3. **The project pin**, in the workspace root `deno.json`:

   ```json
   {
     "denext": {
       "runtime": { "version": "3.0.0-denext.31", "integrity": "sha256-…" }
     }
   }
   ```

   The integrity is `sha256-` and the 64 hex digits of the release document's SHA-256 (the hash
   the index lists for it), which fixes every archive's hash. It is a lock: CI, Docker images and
   compiled apps get exactly that runtime, with or without the channel, and no key can change its
   binaries. A lock whose release document is not cached is fetched from either source and
   checked against the hash alone; a lock on the bundled runtime needs no download at all.
   `denext runtime use <version> --project` writes it. denext reads the pin as text, without
   running project code, and Deno itself ignores the `denext` key.
4. **Your machine's default**, set by `denext runtime upgrade`, `denext runtime use` and the
   installer. It applies only while it is at least as new as the bundled runtime, unless you chose
   it explicitly with `runtime use <version>`, so an old default never drags a newer denext back.
5. **The bundled runtime.**

`denext runtime version` shows which rung chose the runtime that runs (`env`, `project`, `default`
or `bundled`). The processes a command starts run the same release as the command, even from
another directory. `denext build` records the release in `.denext/deploy-manifest.json`
(`runtime`: version, source, integrity).

A machine with a default and a container without one run different runtimes for an unpinned
project: `denext doctor` says so when the project has a Dockerfile or a deploy adapter, and the fix
is a project pin.

### The "newer runtime available" line

A command that runs on the runtime prints `denext: runtime <version> is available: denext runtime
upgrade` (`--project` when the project pins its runtime) when the channel lists a newer release
this denext supports and the dependency-age hold lets it in. It is said once per command (not by
the processes the command starts) and once a day per release, read from the cached index, which
is refreshed at most every 12 hours within a short time budget: offline, it is simply not said.
Nothing is printed for an explicit `DENEXT_RUNTIME` or pin file. `DENEXT_RUNTIME_CHANNEL=0` turns
the channel off, the line with it.

## Commands

```text
denext runtime version [--json] [--verify]   what runs here and why (alias: info)
denext runtime list [--json] [--all]         installed; with the channel: available, held, yanked, incompatible
denext runtime install [<version>] [--with gleam,fastlane]
denext runtime upgrade [--project] [--dry-run] [--json]
denext runtime use <version|latest|bundled> [--project] [--json]
denext runtime path | link | unlink
denext runtime uninstall <version> | --all [--force] [--dry-run] [--json]
denext runtime prune [--dry-run] [--json]
```

- `version` names the release that runs, the rung that chose it (`DENEXT_RUNTIME`, the project
  pin and its file, your default, the bundled runtime), its integrity and any notice (a default
  that was skipped, a withdrawn release), then the bundled runtime and its rollback, the oldest
  runtime this denext supports, your default, the channel (from its cache, no network) with the
  newer release it offers, and the revocation list and the tools beside the runtime. It exits 1
  when the selection can't run (a malformed or incompatible project pin).
- `list` shows the installed releases and the ones in use (the one that runs is starred), the
  release `upgrade` would take and the one the hold keeps out, each with the channel's verdict:
  `available`, `held`, `yanked` (with the reason), `incompatible` (with why) or `unlisted`. `--all`
  adds every release the channel lists. Offline, the channel is shown as unavailable.
- `upgrade` takes the newest release this denext supports that the hold lets in, installs it and
  makes it your default (or the project pin with `--project`). A default `upgrade` writes gives way
  to a newer denext's bundled runtime; one you chose with `use` does not. It says when a newer
  release is held, and when the newest needs a newer denext. With nothing newer it changes nothing;
  without a verified channel it fails with the reason.
- `use <version>` installs that release and makes it your default (kept even under a newer
  denext), or with `--project` writes the project pin. `use latest` takes what `upgrade` would,
  `use bundled` removes your default (with `--project`, pins the bundled runtime).
- `install` with no version installs the release selected here; with a version, that release.

Offline, `version`, `list` (installed), `path`, and `use` / `install` of a release that is
bundled or that the project pin or your default already names (its release document cached) all
work; `upgrade` and installing anything else fail with the reason.

## Compatibility

Whatever selects it, a release runs only when it is at or above the oldest runtime this denext
supports, carries the esbuild version denext's build API speaks, and its Deno Desktop runtime
offers the API level denext's desktop support needs. Each release in the channel also declares
the oldest denext it was proven with. Before a release is
signed, it runs denext's test suites under the latest stable denext and the last patch of the
previous minor; the oldest passing one is recorded. Older denexts keep the runtime they bundle.

- **The newest runtime needs a newer denext:** `upgrade` picks the newest one yours supports and
  says which denext the newest needs (`run "denext upgrade"`). A project pin that names it is an
  error with the same fix.
- **Your denext needs a newer runtime:** a project pin below what this denext requires is an error
  naming `denext runtime use --project`; a machine default below it is skipped with one notice.

## The dependency-age hold

`upgrade`, `use latest` and the installer take the newest compatible release whose publication
is older than the dependency-age rule in force: the root `deno.json`'s
`minimumDependencyAge`, else `.npmrc`, else 24 hours. They print the same one-line explanation
`denext upgrade` prints. Naming a version (`runtime install <version>`, `runtime use <version>`)
is your choice and is not held. There is no exception for security releases: a flag that skipped
the hold would be the first thing a stolen key set.

## Trust

The channel is two kinds of file, served from `https://denext.dev/runtime/` and mirrored on GitHub;
denext asks both at once and takes the newest valid copy:

- **The index** (`channel.json`) lists every release with its version, publication date,
  compatibility range and the SHA-256 of its release document. It is signed with an ECDSA P-256
  key held offline by the maintainers, never in CI, and denext verifies it against public keys
  compiled into denext. It expires 45 days after signing, carries a sequence number that only
  grows (denext refuses one older than it has seen, and each denext release compiles in a floor),
  and is refused when dated in the future.
- **A release document** (`releases/<version>.json`) holds the runtime's archives and their
  SHA-256s. It is not signed; it is trusted only through the hash the index (or your project pin)
  names.

What a valid signature cannot do, whatever it says: point a download anywhere but this release's
GitHub download URLs or `https://denext.dev/runtime/`, name a version outside denext's runtime
line, or change what a command runs (only the commands above do). A signing key that leaks can be
withdrawn by the separate key that signs the [revoked-runtimes list](/docs/toolchain#revoked-runtimes);
a denext that sees its channel key withdrawn ignores the channel and runs its bundled runtime.

Anything wrong (no key, a bad or withdrawn signature, an expired index, a replayed one, an unknown
format, a document whose hash differs) and the channel counts as absent: `upgrade` and `install`
fail with the reason, and commands keep running what they ran before. Nothing is downloaded on the
word of an index that does not verify.

## Bad releases

- **Yanked** (broken, not dangerous): `upgrade` and the installer stop offering it; a machine that
  runs it gets one warning naming `denext runtime upgrade`.
- **Revoked** (a security problem): the [revoked-runtimes list](/docs/toolchain#revoked-runtimes)
  applies to whatever runtime was chosen. denext runs the newest installed release that is
  compatible and not revoked, else the bundled rollback, and the warning names
  `denext runtime upgrade`. `build --compile` and `desktop build | package` refuse a revoked
  runtime unless `DENEXT_ALLOW_REVOKED_RUNTIME=<version>` names it.

The archives of every release the channel lists stay published, so a project pin keeps working.
