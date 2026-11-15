---
title: Kernel sandbox modes and configuration
slug: kernel-sandbox-modes
lead: How to choose what the kernel sandbox does — the --kernel-sandbox flag, the deno.json key, the value baked in by deno compile, the emergency environment switch — and how to read what applied, from --kernel-sandbox-report and deno info --json.
---

> [!IMPORTANT]
> **In development. An opt-in preview lands in denext 4.20; the full sandbox, with automatic
> enforcement, lands in denext 5.0.** The flags, the `deno.json` key, the report and the
> `deno info --json` shape on this page exist in denext's Deno fork today. Nothing here applies to
> a released denext yet. **Status:** the preview enforces nothing yet. `auto` changes nothing,
> `warn` reports, and `enforce` and `broker` refuse to start because no enforcer is built in yet.
> That changes as later stages land, and this page will say when.

## What the preview does today

The settings and the reporting are in place, so you can see what the sandbox _would_ hold for
your program before anything is enforced:

- With no setting, nothing changes: the default `auto` applies nothing yet and only records what
  it would apply.
- `warn` runs your program normally and prints one line saying how many rules would be left to
  Deno's checks.
- `--kernel-sandbox-report` prints the full policy and every gap, then runs your program.
- `enforce` and `broker` refuse to start, because the runtime has no enforcer built in yet. They
  list the rules the operating system can't hold, so you can see what they will check.

## The five modes

| Mode             | What it does in the preview                                                                                                                          | What it does in the full sandbox                                                                                                                        |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auto` (default) | Applies nothing. Records what it would apply (`wouldApply` in `deno info --json`).                                                                   | Applies everything this kernel supports where the permission set is fixed. Rules it can't hold stay Deno-only and are reported.                         |
| `warn`           | Runs normally and prints [one warning line](#warn-mode). Nothing is refused.                                                                         | Same, plus the platform's own refusal logging where it has one.                                                                                         |
| `enforce`        | Refuses to start, listing the rules the operating system can't hold exactly. Today that is every rule, because no enforcer is built in. Exit code 1. | Applies the policy, and refuses to start if any rule can't be held exactly.                                                                             |
| `broker`         | Refuses to start, as `enforce` does.                                                                                                                 | `enforce` plus the supervising broker (Mode B), which holds host-scoped network, Unix sockets by path and, on Linux, write denies inside a write allow. |
| `off`            | No kernel layer, Deno's checks only.                                                                                                                 | Same.                                                                                                                                                   |

## Where the mode comes from

The mode can come from five places. The `source` field of `deno info --json` says which one won.

| `source`   | Where                                                         | Notes                                                          |
| ---------- | ------------------------------------------------------------- | -------------------------------------------------------------- |
| `compiled` | baked into a compiled program by `deno compile`               | Always wins. The program ignores the flag and the environment. |
| `flag`     | `--kernel-sandbox=<mode>` on the command line                 | Overrides `deno.json`.                                         |
| `env`      | `DENO_KERNEL_SANDBOX=off` or `warn`                           | Can only lower the mode, never raise it.                       |
| `config`   | `"permissions": { "kernelSandbox": "<mode>" }` in `deno.json` |                                                                |
| `default`  | nothing set                                                   | `auto`.                                                        |

## The `--kernel-sandbox` flag

```sh
deno run --kernel-sandbox=warn --allow-read=. --allow-net=api.example.com:443 main.ts
```

- Accepted by `run`, `serve`, `test`, `bench`, `repl`, `compile` and `install -g`. Not by `eval`.
- The value is required: `--kernel-sandbox` alone is an error. The values are `off`, `warn`, `auto`,
  `enforce` and `broker`.
- It overrides the `deno.json` key.

## `permissions.kernelSandbox` in `deno.json`

```json
{
  "permissions": {
    "kernelSandbox": "warn",
    "default": {
      "read": ["."],
      "net": ["api.example.com:443"]
    }
  }
}
```

- `kernelSandbox` is a reserved key next to your named permission sets. It takes the same five
  values and applies to the whole project, whichever permission set a run uses.
- The command-line flag overrides it.
- In a workspace, a member's `deno.json` overrides the root's.
- An unknown value is a configuration error, so a typo can't silently turn the sandbox off.

## `DENO_KERNEL_SANDBOX`

```sh
DENO_KERNEL_SANDBOX=warn deno task start
```

- Takes `off` or `warn` only, and **only lowers** the mode: it can turn `enforce` into `warn` or
  `off`, never `off` into `enforce`.
- It's read from the real environment before any `--env-file` is loaded, so a `.env` file can't
  switch the sandbox down.
- **Compiled programs ignore it**: their mode is the author's.
- No setting can widen a sandbox a process is already inside.

## `deno compile --kernel-sandbox`

```sh
deno compile --kernel-sandbox=warn --allow-read=./data --allow-net=api.example.com:443 main.ts
```

- The mode is baked into the binary, from the flag or else from `deno.json`.
- The binary ignores the `--kernel-sandbox` flag and `DENO_KERNEL_SANDBOX` at run time.
- In the preview, `enforce` and `broker` are refused at compile time, because the binary would
  refuse to start anyway.
- A binary compiled with `warn` prints the [warning line](#warn-mode) when it starts.

## How the mode is chosen

Once the mode is known, the run's context decides what actually applies (`effective` in
`deno info --json`):

| Context                                                                                                             | `auto`               | `warn`  | `enforce` / `broker`            |
| ------------------------------------------------------------------------------------------------------------------- | -------------------- | ------- | ------------------------------- |
| A command that runs no user code (`fmt`, `lint`, `check`, `cache`, …), `-A` with no `--deny-*`, a desktop dev build | off                  | off     | off                             |
| Not fixed: `--watch`, HMR, `denext dev`, or an external permission broker                                           | off                  | applies | error                           |
| A prompt is possible (prompting on, and stdin and stderr are terminals)                                             | off                  | applies | applies; prompts become denials |
| Anything else: the permission set is fixed. A compiled program is always fixed.                                     | records `wouldApply` | applies | applies                         |

In the full sandbox, `auto` will choose `enforce` where the author fixed the permissions (a compiled
program, or `auto` set explicitly) and `warn` where only the missing terminal or `--no-prompt` fixes
them. In the preview it applies neither.

Jupyter builds its permissions separately, so the Jupyter kernel has no kernel sandbox layer yet.

## Warn mode

`warn` runs your program and prints one line to stderr:

```text
Warning kernel sandbox (warn, preview): nothing is refused; 2 rule(s) would be held by Deno's checks only. Run with --kernel-sandbox-report for the policy.
```

The count is the number of rules the operating system couldn't hold exactly on this machine
(the `fail-open` gaps in the report). In the full sandbox, warn mode also reads the platform's own
records of what it would have refused: Seatbelt's entries in the macOS unified log
(`log stream --predicate 'sender == "Sandbox"'`), and on Linux 6.15 and later the kernel's audit
records. Landlock has no permissive mode, so on older Linux kernels warn mode can't see what
native code would have been refused.

## `--kernel-sandbox-report`

`--kernel-sandbox-report` prints the resolved mode, the machine, the compiled policy and every gap
to stderr, then runs the program as usual. This is the output on a Linux machine with Landlock ABI
4, with no mode set, for:

```sh
deno run --kernel-sandbox-report --allow-read=. --allow-write=./out --deny-write=./out/keep \
  --allow-net=example.com:443 main.ts
```

```text
kernel sandbox (preview): auto (default); applies: off; would apply: warn
  why: auto applies nothing yet (the kernel sandbox is an opt-in preview)
  permission set: fixed (no prompt can widen it)
  machine: linux, Landlock ABI 4, seccomp, enforcer built: no
  policy 647d53aee64387a7 (mode B, with a broker)
    read:       /home/me/project + implicit set (47)
    deny read:  none
    write:      /home/me/project/out + implicit set (4)
    deny write: /home/me/project/out/keep (broker)
    exec:       no programs
    load code:  only the implicit set (6)
    net:        through the broker: connect example.com:443; bind example.com:443
    unix:       denied
    sys:        narrows /proc/loadavg, /proc/meminfo, /proc/uptime, /proc/net
    env:        not scrubbed
    implicit:   DENO_DIR, DNS, TLS roots, devices, locale and time zones, process info, runtime, shared libraries, user database
  gaps: 3 (1 refused by enforce, marked !)
    sys [documented] no --allow-sys: sys is enforced by Deno; the kernel narrows: /proc/loadavg, ...
    env [documented] no --allow-env: env is enforced by Deno: native code reads the process environment directly ...
  ! enforcer [fail-open] --kernel-sandbox: no kernel enforcer for linux is built into this runtime yet: every rule is held by Deno's checks only
```

Reading it from the top:

- **The first line** gives the mode and where it came from (`auto`, by default), what applies in this
  run (`off`), and what `auto` would apply once enforcement exists (`warn`, because only the missing
  terminal fixes the permission set here).
- **`permission set: fixed`** means no prompt can widen the grant in this run, so a kernel policy
  could hold it.
- **`machine`** is what was detected: the platform, the Landlock ABI, seccomp, and whether this
  runtime has an enforcer for it.
- **`policy`** is the compiled policy and its hash. It says `mode B, with a broker` because two
  rules need the supervisor: the write deny inside the write allow, and the host-scoped network
  grant. Each line is one kind of access. `+ implicit set (n)` counts the entries the runtime itself
  needs; the `implicit` line lists their categories.
- **`gaps`** lists every rule the operating system wouldn't hold exactly, by kind. The `!` line is
  the one `enforce` would refuse to start over: in the preview, the missing enforcer itself.

The gap kinds:

| Kind          | Meaning                                                                                                                                    | Under `enforce`        |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------- |
| `fail-open`   | Marked `!`. The kernel would allow more than Deno's rule, so the rule is held by Deno's checks only. Counted in the warning line.          | Refuses to start.      |
| `fail-closed` | The kernel would refuse something Deno's rule allows, for example a file created after start in a folder whose deny had to be expanded.    | Applied, and reported. |
| `documented`  | A limit the sandbox never claims to hold: `env`, `sys`, file metadata, and what programs started under a scoped `--allow-run` may execute. | Doesn't block.         |

How some grants map today, from the policy the preview computes:

- **Linux network.** Port rules apply only to IP addresses and `localhost`. A host name needs
  `broker`; without it, the rule is a `fail-open` gap.
- **Linux Unix sockets** need an explicit `--allow-net=unix:<path>` grant.
- **Linux read deny inside a read allow** is held only if nothing writes to that folder, or if user
  namespaces are available to hide the denied path. Otherwise it's held by Deno's checks only.
- **macOS** holds denies inside allows exactly. Its port rules can't tell hosts apart.
- **Windows** reads and network are held by Deno's checks only.
- **`env` and `sys`** are held by Deno's checks only, everywhere.

## `deno info --json` → `kernelSandbox`

`deno info --json` reports a `kernelSandbox` object. A runtime without the sandbox leaves it out,
so a tool can detect the feature by checking for it, and `enforcerBuilt` says whether the runtime
can enforce yet. This is the object on a Linux machine with Landlock ABI 4 and no mode set:

```json
{
  "preview": true,
  "mode": "auto",
  "source": "default",
  "effective": "off",
  "wouldApply": "warn",
  "reason": "auto applies nothing yet (the kernel sandbox is an opt-in preview)",
  "enforced": false,
  "enforcerBuilt": false,
  "osSandbox": "landlock",
  "landlockAbi": 4,
  "capabilities": {
    "os": "linux",
    "landlockAbi": 4,
    "seccomp": true,
    "userNamespaces": false,
    "seatbelt": false,
    "jobObject": false,
    "lowIntegrity": false,
    "enforcerBuilt": false
  },
  "features": [
    "fsRead",
    "fsWrite",
    "fsExec",
    "fsRefer",
    "fsTruncate",
    "tcpPorts",
    "socketFamilies",
    "execRefusal",
    "attackSurface"
  ],
  "warnings": [
    "kernel sandbox: no enforcer is built into this runtime yet; --kernel-sandbox=enforce and broker refuse to start"
  ]
}
```

| Field           | Meaning                                                                                        |
| --------------- | ---------------------------------------------------------------------------------------------- |
| `preview`       | `true` while the sandbox is a preview.                                                         |
| `mode`          | The mode that was asked for.                                                                   |
| `source`        | Where it came from: `default`, `flag`, `env`, `config` or `compiled`.                          |
| `effective`     | What applies in this run after [the context rules](#how-the-mode-is-chosen).                   |
| `wouldApply`    | What `auto` would apply here once enforcement exists.                                          |
| `reason`        | A short explanation of `effective`.                                                            |
| `enforced`      | Whether the operating system is holding the policy in this run. Always `false` in the preview. |
| `enforcerBuilt` | Whether this runtime has an enforcer for this platform.                                        |
| `osSandbox`     | The mechanism this platform uses: `landlock`, `seccomp`, `seatbelt`, `job-object` or `none`.   |
| `landlockAbi`   | The Landlock ABI on Linux, when there is one.                                                  |
| `capabilities`  | What the machine offers, as detected (below).                                                  |
| `features`      | What the sandbox can hold on this machine (below).                                             |
| `warnings`      | Anything worth knowing about this machine or configuration.                                    |

`capabilities`:

| Key              | Meaning                                                      |
| ---------------- | ------------------------------------------------------------ |
| `os`             | The platform: `linux`, `macos` or `windows`.                 |
| `landlockAbi`    | The Landlock ABI the kernel reports (Linux).                 |
| `seccomp`        | Whether seccomp filters are available (Linux).               |
| `userNamespaces` | Whether unprivileged user namespaces can be created (Linux). |
| `seatbelt`       | Whether the Seatbelt sandbox is available (macOS).           |
| `jobObject`      | Whether a job object can be applied (Windows).               |
| `lowIntegrity`   | Whether the process can lower its integrity level (Windows). |
| `enforcerBuilt`  | Whether this runtime has an enforcer for the platform.       |

`features`, each present when the machine supports it:

| Feature          | What the sandbox can hold                                           |
| ---------------- | ------------------------------------------------------------------- |
| `fsRead`         | read scopes                                                         |
| `fsWrite`        | write, create and remove scopes                                     |
| `fsExec`         | execute scopes                                                      |
| `fsRefer`        | moving and linking files between folders (Landlock ABI 2 and later) |
| `fsTruncate`     | truncation (Landlock ABI 3 and later)                               |
| `tcpPorts`       | TCP port rules for `connect` and `bind` (Landlock ABI 4 and later)  |
| `socketFamilies` | refusing socket families (IPv4, IPv6, Unix) that aren't granted     |
| `execRefusal`    | refusing to start any program when there's no `--allow-run`         |
| `attackSurface`  | refusing the dangerous system calls                                 |

More keys and features appear as later stages land.

## Mode B (`broker`) in detail

_Being written as this lands._ When Mode B is chosen automatically in the full sandbox, what goes
through the supervisor and what stays in-process, the cost per brokered call, and how children
reach the network through the supervisor's proxy. In the preview, `broker` refuses to start.
