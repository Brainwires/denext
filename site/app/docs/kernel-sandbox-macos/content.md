---
title: Kernel sandbox on macOS
slug: kernel-sandbox-macos
lead: How the kernel sandbox holds a grant on macOS with Seatbelt, the same engine the App Store sandbox uses. One profile covers files, network, program execution and which libraries may be loaded as code.
---

> [!IMPORTANT]
> **In development. An opt-in preview lands in denext 4.20; the full sandbox, with automatic
> enforcement, lands in denext 5.0.** This page is an outline, filled in as the macOS enforcement
> lands in denext's Deno fork. The [overview](/docs/kernel-sandbox) has the design.

## How a macOS process confines itself

_Being written as this lands._ Seatbelt applies to the whole process at once, so `deno` applies
the profile once the grant is resolved and before any user code runs, with no re-exec. It calls
the sandbox interface at run time (so a future removal degrades to "unavailable" instead of
breaking the binary) and falls back to `/usr/bin/sandbox-exec`. What happens when the process is
already sandboxed. A CI canary on new macOS betas.

## The generated profile

_Being written as this lands._ An annotated example profile for a command-line program: deny by
default, then the grant's paths, then the denies (in Seatbelt the last matching rule wins, so the
order is tested), then the system services a runtime needs. Includes which system services are
allowed only when the grant needs them (certificate trust for the system certificate store, the
DNS service when network is allowed, file-system events for `Deno.watchFs`).

## Files

_Being written as this lands._ How read and write scopes map to `subpath` and `literal` rules,
why deny rules inside an allowed folder are exact on macOS, why metadata reads are allowed
everywhere, and how symlinks and case-insensitive volumes are handled.

## Loading native code

_Being written as this lands._ On macOS the profile also limits which files may be mapped as
executable code: the deno binary, the system libraries, the `--allow-ffi` paths, and the folders
programs need when `run` is granted. So FFI and Node-API loading is scoped by the kernel too.

## Network

_Being written as this lands._ What Seatbelt can express (ports and `localhost`, not host names),
the residual that any confined code can resolve any name through the system resolver in Mode A,
and how Mode B makes host-scoped grants exact.

## Programs and children

_Being written as this lands:_ execution rules, what children inherit, and the system and developer
tool paths added when `run` is granted (Command Line Tools, Homebrew, Nix).

### `EPERM`, not `EACCES`

When Seatbelt refuses a file, the call fails with `EPERM` ("operation not permitted"), and so does
`access()`. File modes produce `EACCES` ("permission denied"). Most programs treat the two alike,
but not all:

- **git exits** when it gets `EPERM` reading its config, where it would carry on past `EACCES`.
- **Shells warn and carry on.**

This is why child programs get a baseline of system paths when `run` is granted: a child that can't
read what it needs to start often fails outright instead of falling back.

## Seeing refusals

_Being written as this lands._ Reading Seatbelt's refusals from the unified log, which is how
`warn` mode reports on macOS, and what `denext doctor` checks.

## Supported macOS versions

Check your macOS version and whether the `sandbox-exec` fallback is present:

```sh
sw_vers
ls -l /usr/bin/sandbox-exec
```

_Being written as this lands:_ the macOS versions the escape-test corpus runs on, and the status of
Apple's deprecation notice on the sandbox interface.
