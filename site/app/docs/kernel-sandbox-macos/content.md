---
title: Kernel sandbox on macOS
slug: kernel-sandbox-macos
lead: How the kernel sandbox holds a grant on macOS with Seatbelt, the same engine the App Store sandbox uses. One profile covers files, network and program execution.
---

> [!IMPORTANT]
> **An opt-in preview ships in denext 4.x; automatic enforcement lands in denext 5.0.**
> `--kernel-sandbox=enforce` confines `deno run`, `deno serve`, `deno test` and `deno bench` on
> macOS today, with the Mode B supervisor for host-scoped network, and so does a program compiled
> with it; the rest of this page is filled in as the remaining parts land. The
> [overview](/docs/kernel-sandbox) has the design.

## How a macOS process confines itself

Under `--kernel-sandbox=enforce`, `deno` resolves the grant and loads the module graph, then
re-executes itself; the new image applies the profile first thing, before it opens a cache or runs
any user code. The process ID stays the same. Like on Linux, the new image gets an environment
scrubbed to the `--allow-env` names plus a short runtime list (unless `--allow-env` is unscoped),
and a program read from stdin is refused. Two ways to apply the profile:

- **The system's sandbox interface** (`sandbox_init`), looked up at run time so a future removal
  degrades to "unavailable" instead of breaking the binary. The new image measures that the profile
  holds before it goes on.
- **The `sandbox-exec` fallback.** Where that call is missing, the process re-executes under
  `/usr/bin/sandbox-exec` with the same profile, and checks the profile it runs under before user
  code starts. The fallback's profile lets the process exec exactly the runtime's own binary, which
  runs under the same profile. Without `--allow-run` that is a `documented` gap, shown in the
  report as `--kernel-sandbox=enforce (sandbox-exec fallback)`: native code can start the runtime
  again, still confined.

A compiled program applies its profile in place, with no re-exec. A process already inside
another Seatbelt profile (App Sandbox, an agent's sandbox, `sandbox-exec`) can't apply a second
one, so `enforce` refuses to start there. Run it outside the outer sandbox, or use `warn`.

**Folders listed, never read.** Two folders' names (never their contents) are readable: the
working directory itself (spawning a child needs it), and `/` when `--allow-run` is granted (every
new process lists it while starting). The report prints them on a `list only:` line.

## The generated profile

_Being written as this lands._ An annotated example profile for a command-line program: deny by
default, then the grant's paths, then the denies (in Seatbelt the last matching rule wins, so the
order is tested), then the system services a runtime needs. Includes which system services are
allowed only when the grant needs them (certificate trust for the system certificate store, the
DNS service when network is allowed, file-system events for `Deno.watchFs`).

## Files

The profile denies by default, then allows the read and write scopes, then the exact denies, then
any re-allows beneath a deny, so a deny inside an allow is exact on macOS. File metadata (whether a
file exists, its size) is readable everywhere, because path resolution needs every parent folder:
a `documented` gap. _Being written as this lands:_ how symlinks and case-insensitive volumes are
handled.

## Loading native code

Code loads from the **read scope** plus the system libraries, as on Linux. Library loading is
**not** bounded by `--allow-ffi`: with a scoped `--allow-ffi=<paths>`, native code may load any
library it can read. That's a `documented` gap, and the report lists it under `ffi`. Testing showed
that a profile mapping only the `--allow-ffi` paths as executable still let other libraries load,
so the sandbox claims only what holds. To keep a library from loading, keep it out of the read
scope.

## Network

Seatbelt can express ports and `localhost`, not host names. Under `enforce`:

- **`--allow-net=<host>:<port>`** and `--deny-net` are held by the Mode B supervisor: it resolves
  the name, checks it, connects and passes the socket back. The profile then denies the confined
  process all network, so native code and children (other than `deno`) have no network, and UDP is
  refused under a host-scoped grant.
- **A port list of IP addresses or `localhost`** is held by port: any address on those ports,
  `169.254.169.254` included. A `documented` gap. `--kernel-sandbox=broker` holds it exactly.
- **Name lookups:** with network allowed by port or unscoped, any confined code can resolve any
  name through the system resolver, and a lookup can carry data out.

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

Under a `--kernel-sandbox=warn` asked for by name, `deno run` and `deno serve` apply a report-only
profile: the `enforce` profile for the same grant with every refusal turned into a logged allow.
The run reads those lines back from the unified log (`log stream`) and prints each access
`enforce` would refuse, with the grant that would allow it. A program that applies a sandbox of its
own (a browser, `sandbox-exec`) fails under that profile as it would under `enforce`;
`DENO_KERNEL_SANDBOX_WARN_OBSERVE=0` turns it off. See
[Warn mode](/docs/kernel-sandbox-modes#warn-mode). _Being written as this lands:_ what
`denext doctor` checks.

## Supported macOS versions

Check your macOS version and whether the `sandbox-exec` fallback is present:

```sh
sw_vers
ls -l /usr/bin/sandbox-exec
```

_Being written as this lands:_ the macOS versions the escape-test corpus runs on, and the status of
Apple's deprecation notice on the sandbox interface.
