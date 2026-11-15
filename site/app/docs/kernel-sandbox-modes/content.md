---
title: Kernel sandbox modes and configuration
slug: kernel-sandbox-modes
lead: How to choose what the kernel sandbox does — the --kernel-sandbox flag, the deno.json key, the value baked in by deno compile, the emergency environment switch — and how to read what applied, from --kernel-sandbox-report and deno info --json.
---

> [!IMPORTANT]
> **In development. An opt-in preview lands in denext 4.20; the full sandbox, with automatic
> enforcement, lands in denext 5.0.** This page is an outline, filled in as each part lands in
> denext's Deno fork. The [overview](/docs/kernel-sandbox) has the design. Nothing here applies to
> a released denext yet. **Status:** the 4.20 preview accepts only `enforce` and `warn`, from the
> flag or the `deno.json` key, on Linux and macOS, off unless asked for.

## The five modes

_Being written as this lands._ A reference entry for each of `off`, `warn`, `auto`, `enforce` and
`broker`: what it applies, what it reports, what makes it refuse to start, and when it's the
default. The short version is in the [overview](/docs/kernel-sandbox#modes).

## How the mode is chosen

_Being written as this lands._ The precedence order: a compiled binary's baked mode, then the
command-line flag, then `deno.json`, then the automatic rule for the context. The automatic rule
is "on only when the permission set is fixed" (no prompt possible, `-A` without denies off,
`--watch` / HMR / `denext dev` off), with one row per subcommand (`run`, `serve`, `test`, `bench`,
`eval`, `repl`, `x`, `jupyter`, `task`) and what each does inside an already-confined tree.

## The `--kernel-sandbox` flag

_Being written as this lands._ Syntax, the subcommands that accept it, and how it combines with
`--allow-*`, `--deny-*`, `--no-prompt` and `-A`.

## `permissions.kernelSandbox` in `deno.json`

_Being written as this lands._ The key inside a `permissions` set, how it combines with named
permission sets, and how it shows up in `denext.config.ts`-generated tasks and the deploy outputs
(`denext start`, Docker, systemd).

## `deno compile --kernel-sandbox`

_Being written as this lands._ How the mode is baked into a standalone binary, why the binary
ignores the run-time flag and environment (its permissions are the author's), the build-time
warning for a partial grant that still allows prompting, and the run-time line printed the first
time a would-be prompt is refused. `denext build --compile` and `compile.permissions` are covered
on [Desktop and compiled apps](/docs/kernel-sandbox-desktop-and-compiled).

## The emergency switch: `DENO_KERNEL_SANDBOX`

_Being written as this lands._ `DENO_KERNEL_SANDBOX=off` or `=warn` for the CLI family only: it
prints a line whenever it's used, isn't read from an `--env-file`, is ignored by compiled binaries
and desktop apps, and can never widen a sandbox the process is already inside.

## Warn mode

_Being written as this lands._ What `warn` can and can't see on each platform. On macOS a
reporting profile logs each access that would be refused to the unified log
(`log stream --predicate 'sender == "Sandbox"'`) and lets it through. On Linux, seccomp's logging
action covers refused system calls, but Landlock has no permissive mode, so warn mode can't see
what native code would have been refused there. On Linux 6.15 and later, kernel audit records fill
that gap. Also: the one stderr line per program and policy.

## `--kernel-sandbox-report`

_Being written as this lands._ An annotated example of the report: the resolved mode and the
reason, the mechanisms in use (Landlock ABI, seccomp, Seatbelt, job object, Mode A or B), the
compiled policy, the implicit set with the reason for each entry, and every gap, each marked
`kernel`, `kernel (coarser)` or `Deno only`.

## `deno info --json` → `kernelSandbox`

_Being written as this lands._ The JSON shape, field by field, with an example. This is also how a
tool detects the feature: a runtime that has the kernel sandbox reports a `kernelSandbox` object,
and one that doesn't omits it. It sits next to the existing `lifecycleJail` object, which has the
same layout.

## Mode B (`broker`) in detail

_Being written as this lands._ When Mode B is chosen automatically (host-scoped network, a write
deny inside a write allow, a Unix socket grant, remote imports under a network-denied policy), what
goes through the supervisor and what stays in-process, the cost per brokered call, and how children
reach the network through the supervisor's proxy.
