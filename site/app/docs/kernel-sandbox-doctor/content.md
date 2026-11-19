---
title: "Kernel sandbox: doctor and dry run"
slug: kernel-sandbox-doctor
lead: Two commands answer "what would the kernel sandbox do here?" without running your app. denext doctor has one line for it. denext kernel-sandbox prints the whole picture — the kernel features this machine has, what applies to the project, and a dry run of the start task's grant.
---

> [!IMPORTANT]
> **Both commands ship with the denext release that has this page**, and read what the runtime
> reports about itself, so they work on every runtime that has the kernel sandbox. Nothing here
> changes how an app runs.

## `denext doctor`: one line

`denext doctor` has a `kernel sandbox` check among its others:

```text
✔ kernel sandbox       Landlock ABI 4, seccomp on linux; no setting: nothing is applied in this release (opt in with --kernel-sandbox=enforce on the start command); a later release applies warn to a run with no terminal; every rule of the start task's grant can be held here (run `denext kernel-sandbox check` to see what the app needs under enforce)
```

It has three parts:

1. **The machine.** The kernel mechanisms found: `Landlock ABI <n>` and `seccomp` on Linux,
   `Seatbelt` on macOS, `job object` and `low integrity level` on Windows.
2. **What applies.** The mode a run with no terminal gets in this project, and where it comes
   from (`deno.json`, `DENO_KERNEL_SANDBOX`, or no setting).
3. **The `start` task's grant.** A [dry run](#the-dry-run) of the permission flags of the
   project's `start` task. Either every rule can be held on this machine, or the check **fails**
   and names each rule `enforce` would refuse to start over:

```text
✖ kernel sandbox       Landlock ABI 4, seccomp on linux; no setting: nothing is applied in this release …; enforce would refuse to start the start task here: --allow-net=api.example.com:443 (needs Mode B: …); fix: change those grants, or run `denext kernel-sandbox` for the whole policy
```

The check is never critical: it doesn't change `denext doctor`'s exit code. It is left out on a
runtime that reports no kernel sandbox (stock Deno). With `--json` it is one entry of the checks
array, `{ "name": "kernel sandbox", "ok": …, "detail": …, "critical": false }`.

When the `start` task runs with `-A`, the line says so instead of a dry run: `-A` grants
everything, so there is nothing for the kernel to hold, and the sandbox stays off for that run. A
scoped grant is what gets enforced.

## `denext kernel-sandbox`: the whole picture

```sh
denext kernel-sandbox              # the same as: denext kernel-sandbox status
denext kernel-sandbox --task build # read another task's grant
denext kernel-sandbox --json       # the same data for a script
```

This is the output on a Mac for a project whose `start` task is
`deno run --allow-net=example.com:443 --allow-read=. main.ts`:

```text
  denext kernel-sandbox  ▸  /Users/me/app

  This machine (macos):
    ✓ Seatbelt: file, network, program and code-loading rules, denies inside allows held exactly; port rules can't tell hosts apart

  What applies: no setting: nothing is applied in this release (opt in with --kernel-sandbox=enforce on the start command); a later release applies warn to a run with no terminal
    note: the supervising broker (Mode B) is not built in yet; --kernel-sandbox=broker refuses to start, and enforce refuses rules only the broker can hold

  Defaults at this runtime's stage (preview), with no setting:
    off      A compiled program (deno compile, denext build --compile)
    off      A packaged desktop app with desktop.permissions: "strict"
    off      denext start (and the Docker image / systemd unit that run it)
    off      auto written out (--kernel-sandbox=auto, "kernelSandbox": "auto")
    off      A bare deno run / serve with no terminal (CI, a pipe) or --no-prompt
    off      A run that can prompt (a terminal, prompting on)
    off      -A with no --deny-*
    off      --watch, HMR, denext dev, an external permission broker

  The `start` task's grant:
    --allow-net=example.com:443 --allow-read=.

  Dry run (the policy the kernel would get; nothing of the app ran):

    kernel sandbox (preview): warn (--kernel-sandbox); applies: warn; would apply: off
      permission set: fixed (no prompt can widen it)
      machine: macos, Seatbelt, enforcer built: yes
      policy 7b60fc4346891872 (mode A, self-confined)
        read:       /Users/me/app + implicit set (26)
        deny read:  none
        write:      only the implicit set (2)
        deny write: none
        exec:       no programs
        load code:  /Users/me/app + implicit set (26)
        net:        TCP ports only: connect 443; bind 443
        unix:       denied
        sys:        narrows kern.proc*, vm.loadavg, hw.memsize
        env:        not scrubbed
        implicit:   DENO_DIR, DNS, devices, locale and time zones, runtime, shared libraries, working directory
        skipped:    /Users/me/.npmrc (may hold registry tokens; never readable under enforce; grant it with --allow-read=/Users/me/.npmrc if you accept the exposure)
        list only:  /Users/me/app (the folders' names, never what is beneath them)
      gaps: 4 (0 refused by enforce, marked !)
        net [documented] --allow-net=example.com:443: coarser: the kernel holds the ports, not the hosts; native code and children may reach any host on them and resolve any name
        import [fail-closed] --allow-import=jsr.io:443,…: fail closed: remote modules not cached before start (a dynamic import, an npm auto-install) can't be fetched; run `deno cache` first
        sys [documented] no --allow-sys: sys is enforced by Deno; the kernel narrows: kern.proc*, vm.loadavg, hw.memsize
        env [documented] no --allow-env: env is enforced by Deno: native code reads the process environment directly (scrubbed only under --kernel-sandbox=enforce where the runtime re-executes)

  ✓ every rule of this grant can be held here: enforce would start. Run `denext kernel-sandbox check` to see what the app does under it.
```

### This machine

Each line is a kernel mechanism the sandbox uses, marked present (`✓`) or absent (`✗`), with what
that means.

**Linux:**

| Line                             | Present means                                                                                          | Absent means                                                                                                                                                                                                              |
| -------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Landlock ABI <n>`               | File rules can be held. The line lists what this ABI gives and the first thing the next one would add. | No Landlock: a kernel before 5.13, Landlock missing from the kernel's `lsm=` list, or a container whose seccomp profile refuses the `landlock_*` calls. `enforce` refuses to start. Check `cat /sys/kernel/security/lsm`. |
| `Landlock ABI <m>` (a later one) | —                                                                                                      | What that ABI would add, and the kernel version that has it. Nothing is wrong; that rule is held more coarsely or by Deno's checks here.                                                                                  |
| `seccomp`                        | Socket families, the refused system-call list and "no programs without `--allow-run`" can be held.     | This runtime has no seccomp program for the CPU architecture (x86_64 and aarch64 have one).                                                                                                                               |
| `unprivileged user namespaces`   | A read deny inside a read allow can hide the denied path exactly.                                      | Not allowed here (Ubuntu 23.10 and later with AppArmor's default, Docker's default profile). That deny is held by expansion instead, where files created after start are unreadable.                                      |

What each Landlock ABI adds is in [Linux](/docs/kernel-sandbox-linux).

**macOS:** one line, `Seatbelt`. Absent means it can't be applied in this process: it already runs
inside a sandbox (an app sandbox, an agent's, `sandbox-exec`), which macOS doesn't nest.

**Windows:** `job object` and `low integrity level`. Reads and the network stay with Deno's checks
on Windows ([Windows](/docs/kernel-sandbox-windows)).

To check a Linux machine by hand: `cat /sys/kernel/security/lsm` lists `landlock` when it is
enabled, and `uname -r` gives the kernel version to read against the
[Landlock table](/docs/kernel-sandbox-linux). The [guarantee matrix](/docs/kernel-sandbox-guarantees)
says what each mechanism holds.

### What applies

One sentence: the mode a run with no terminal gets in this project and why. The `note:` lines are
the runtime's own warnings about this machine or build (no enforcer for the OS, the Mode B
supervisor not built in, no Landlock).

### The defaults table

What a run gets with **no setting**, by context, at the rollout stage this runtime is at
(`preview`, `r3` or `r4`). It is the column of the [defaults table](/docs/kernel-sandbox-rollout#the-defaults)
that applies to you today.

### The dry run

The dry run answers "would `enforce` start my app here, and what would the kernel hold?" without
starting the app:

- It takes the permission flags of the task's `deno run` or `deno serve` (`--allow-*`,
  `--deny-*`, `--ignore-*`, `--no-prompt`), as written in `deno.json`.
- It runs the runtime with those flags on an **empty program**, in warn mode with the observer
  off. The runtime compiles the kernel policy for the grant and prints its
  [report](/docs/kernel-sandbox-modes#--kernel-sandbox-report). Nothing of the app is loaded or run,
  and nothing is applied to any process.
- It reads back the rules `enforce` would refuse to start over on this machine (the `!` lines of
  the report).

So the result is exact for the question "can this kernel hold this grant", and silent on what the
app does at run time. For that, use
[`denext kernel-sandbox check`](/docs/kernel-sandbox-migrating#2-find-what-would-be-refused).

When the grant can't be read, the command says why:

| It says                                     | Because                                                                                                                                 |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `deno.json has no start task`               | Name the task with `--task <name>`.                                                                                                     |
| `it starts no deno run / deno serve itself` | The task delegates (`denext start`, a shell script, `cd apps/web && deno task start`). Run `denext kernel-sandbox check` on it instead. |
| `-A: every permission …`                    | Nothing to hold. The sandbox stays off for a run with every permission.                                                                 |
| `the dry run failed`                        | The runtime refused one of the flags, or timed out. Run the task's command with `--kernel-sandbox-report` added to see the error.       |

### `--json`

```json
{
  "kernelSandbox": {
    "mode": "auto",
    "source": "default",
    "effective": "off",
    "wouldApply": "warn",
    "stage": "preview",
    "…": "…"
  },
  "features": [{ "name": "Seatbelt", "present": true, "detail": "…" }],
  "verdict": "no setting: nothing is applied in this release …",
  "task": {
    "name": "start",
    "grant": {
      "flags": ["--allow-net=example.com:443", "--allow-read=."],
      "allowAll": false,
      "mode": null
    },
    "dryRun": { "report": "kernel sandbox (preview): …", "startup": [] }
  }
}
```

`kernelSandbox` is the runtime's own `deno info --json` object
([its fields](/docs/kernel-sandbox-modes#deno-info---json--kernelsandbox)), or `null` on a runtime
without the sandbox. `task.dryRun.startup` lists the rules `enforce` would refuse to start over,
each `{ "class": "startup", "target": "<the rule as a flag>", "note": "<what the kernel would do instead>" }`.

## What the two commands don't do

- They don't run the app, and they don't tell you what the app's native code or child processes
  would be refused. [`denext kernel-sandbox check`](/docs/kernel-sandbox-migrating#2-find-what-would-be-refused)
  does.
- They describe **this machine**. Run them where the app runs: the answer on a Linux 5.15 host
  differs from the answer on a laptop.
- They read the `start` task as written in `deno.json`. A deployment that starts the server
  another way (a Dockerfile `CMD`, a systemd unit) has its own flags; check that command with
  `denext kernel-sandbox check -- <command>`.
