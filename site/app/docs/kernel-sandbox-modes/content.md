---
title: Kernel sandbox modes and configuration
slug: kernel-sandbox-modes
lead: How to choose what the kernel sandbox does — the --kernel-sandbox flag, the deno.json key, the value baked in by deno compile, the emergency environment switch — and how to read what applied, from --kernel-sandbox-report and deno info --json.
---

> [!IMPORTANT]
> **An opt-in preview ships in denext 4.20; the full sandbox, with automatic enforcement, lands
> in denext 5.0.** The flags, the `deno.json` key, the report and the
> `deno info --json` shape on this page are in the Deno toolchain and Desktop runtime that denext
> 4.20 pins. **Status:** the preview enforces when you ask it to. `auto` changes nothing in
> denext 4.x, `warn` reports, `enforce` confines `deno run` and `deno serve` on Linux and macOS,
> and `broker` refuses to start because the Mode B supervisor isn't built yet.

## What the preview does today

- With no setting, nothing changes: the default `auto` applies nothing in denext 4.x and only
  records what it would apply. It costs nothing: no policy is compiled.
- `warn` runs your program normally and prints one line saying how many rules would be left to
  Deno's checks.
- `--kernel-sandbox-report` prints the full policy and every gap, then runs your program.
- `enforce` applies the policy (Mode A) to `deno run` and `deno serve` on Linux (x86_64 and
  aarch64, with Landlock) and macOS, where `deno info --json` reports `enforcerBuilt: true`. It
  refuses to start over a `fail-open` gap and runs with the `documented` ones listed in the report
  ([gap kinds](#gap-kinds)). Windows has no enforcer yet.
- `broker` refuses to start: the Mode B supervisor isn't built yet. So does `enforce` when a rule
  only Mode B could hold (on Linux, a host-scoped `--allow-net` or a write deny inside a write
  allow).

> [!WARNING]
> **`"kernelSandbox": "enforce"` in `deno.json` breaks `deno test` and `denext dev`.** The key
> applies to every command in the project, and `test`, `bench`, the REPL, Jupyter and anything
> that isn't fixed (`--watch`, HMR, `denext dev`) refuse to start under `enforce`. Put
> `--kernel-sandbox=enforce` on the command that starts the app (the `start` task) instead.

## The five modes

| Mode             | What it does in the preview                                                                                                                                                                                             | What it does in the full sandbox                                                                                                              |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `auto` (default) | Applies nothing. Records what it would apply (`wouldApply` in `deno info --json`).                                                                                                                                      | Applies everything this kernel supports where the permission set is fixed. Rules it can't hold stay Deno-only and are reported.               |
| `warn`           | Runs normally and prints [one warning line](#warn-mode). Nothing is refused.                                                                                                                                            | Same, plus the platform's own refusal logging where it has one.                                                                               |
| `enforce`        | `run` and `serve` on Linux and macOS: applies the policy (Mode A). Refuses to start (exit code 1) over a `fail-open` gap, naming each rule; runs with `documented` gaps. Other commands, and Windows: refuses to start. | Applies the policy, with Mode B for the rules the kernel can't hold.                                                                          |
| `broker`         | Refuses to start: the Mode B supervisor isn't built yet.                                                                                                                                                                | `enforce` plus the Mode B supervisor, which holds host-scoped network, Unix sockets by path and, on Linux, write denies inside a write allow. |
| `off`            | No kernel layer, Deno's checks only.                                                                                                                                                                                    | Same.                                                                                                                                         |

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

- Accepted by `run`, `serve`, `test`, `bench`, `repl`, `compile` and `install -g`. `eval` refuses
  the flag (and `--kernel-sandbox-report`); it takes its mode from `deno.json` only.
- `enforce` applies only to `run` and `serve`. Under `enforce`, `test` (before it type-checks
  anything), `bench`, the REPL, Jupyter, `eval` with a deny rule (a plain `eval` grants everything,
  so there is nothing to enforce; its deny flags are applied) and, on Linux, a program read from
  stdin refuse to start with "not supported for this command yet". `deno x` refuses to run a
  package's native executable under `enforce`. They never run unconfined.
- **Not covered, and not refused either:** `deno lint` plugins and the language server's lint
  plugins run their code with no kernel sandbox, whatever `deno.json`'s `kernelSandbox` says
  (`deno lint` prints a warning when the key is set). Confining them is planned before 5.0; until
  then, review a lint plugin as you would any build-time code.
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
- `enforce` here applies to `deno test`, `deno bench`, `deno repl` and `denext dev` too, which
  refuse to start under it. Use `warn` in `deno.json` and pass `--kernel-sandbox=enforce` on the
  start command.
- An unknown value is a configuration error, so a typo can't silently turn the sandbox off.

## `DENO_KERNEL_SANDBOX`

```sh
DENO_KERNEL_SANDBOX=warn deno task start
```

- Takes `off` or `warn` only, and **only lowers** the mode: it can turn a `deno.json`
  `"enforce"` into `warn` or `off`, never `off` into `enforce`. The `--kernel-sandbox` flag wins
  over it, so it doesn't lower a mode given on the command line; drop the flag instead. Any other
  value is ignored with a warning.
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
- `enforce` and `broker` are refused at compile time: compiled programs have no kernel enforcer
  yet, so the binary couldn't start.
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

"error" means Deno refuses to start. So `denext dev`, `--watch` and a run with an external
permission broker (`DENO_PERMISSION_BROKER_PATH`) can't use `enforce`. A prompt that would be
possible doesn't stop `enforce`: it turns would-be prompts into denials.

In the full sandbox, `auto` chooses `enforce` where the author fixed the permissions (a compiled
program, or `auto` set explicitly) and, for one stage, `warn` where only the missing terminal or
`--no-prompt` fixes them; then `enforce` there too. In the preview it applies neither.
[Rollout and defaults](/docs/kernel-sandbox-rollout) has the table for each stage. A mode `auto`
chose never refuses to start: where `enforce` can't hold the grant, the run falls back to `warn`.

Jupyter builds its permissions separately, so the Jupyter kernel has no kernel sandbox layer yet,
and `enforce` refuses to start there.

## Warn mode

`warn` runs your program and refuses nothing. On the runtime denext 4.20 pins it prints one line
to stderr:

```text
Warning kernel sandbox (warn, preview): nothing is refused; 1 rule(s) would be held by Deno's checks only. Run with --kernel-sandbox-report for the policy.
```

The count is the number of rules `enforce` would refuse to start over on this machine (the
`fail-open` gaps in the report).

On a runtime with the full warn mode (one whose `deno info --json` has a `kernelSandbox.stage`
field), that line is followed by one line for each access `enforce` would refuse, each naming who
made it and the grant that would allow it, and a summary when the program ends. On macOS that
includes what native code and child processes do; Linux has no report-only mode for file rules,
so there it covers the policy and the programs the run starts.
[Warn mode](/docs/kernel-sandbox-warn) has the output, the JSON-lines log
(`DENO_KERNEL_SANDBOX_WARN_LOG`) and what each platform sees.

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
  machine: linux, Landlock ABI 4, seccomp, enforcer built: yes
  policy 1775641b2a5ce963 (mode B, with a broker)
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
    skipped:    /home/me/.npmrc (may hold registry tokens; never readable under enforce; grant it with --allow-read=/home/me/.npmrc if you accept the exposure)
  gaps: 4 (1 refused by enforce, marked !)
    sys [documented] implicit /proc/self, /sys/fs/cgroup: documented: the runtime reads its own /proc/self entries and the cgroup CPU / memory limits ...
    sys [documented] no --allow-sys: sys is enforced by Deno; the kernel narrows: /proc/loadavg, /proc/meminfo, /proc/uptime, /proc/net
    env [documented] no --allow-env: env is enforced by Deno: native code reads the process environment directly ...
  ! enforcer [fail-open] --kernel-sandbox (broker): the supervising broker (Mode B) is not built into this runtime yet: ... (needed for: --deny-write=/home/me/project/out/keep)
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
- **`skipped`** names a file the implicit set leaves out on purpose: `~/.npmrc` may hold registry
  tokens, so under `enforce` it isn't readable unless you grant it.
- **`gaps`** lists every rule the operating system wouldn't hold exactly, by kind. The `!` line is
  the one `enforce` would refuse to start over: here, the rules that need the Mode B supervisor,
  which isn't built yet. Without the host name and the write deny inside the write allow, the
  policy is Mode A and `enforce` runs.

Under `enforce` the report adds what the run changes. These lines are from a Linux run with
`--allow-env=API_KEY` and `--allow-net=127.0.0.1:8080` (an excerpt):

```text
env:        scrubbed to ALL_PROXY, API_KEY, DENO_DIR, HOME, HTTPS_PROXY, HTTP_PROXY, LANG, LC_*, NO_COLOR, NO_PROXY, PATH, TERM, TMPDIR, TZ, all_proxy, http_proxy, https_proxy, no_proxy
skipped:    /home/me/.npmrc (may hold registry tokens; never readable under enforce; grant it with --allow-read=/home/me/.npmrc if you accept the exposure)
metadata [fail-closed] --allow-write=/home/me/project/out: fail closed: chmod, chown, utime and extended-attribute writes by path are refused, inside the write scope too (Deno.chmod, Deno.utime, cp -p, tar); the descriptor forms work
net [documented] --allow-net=127.0.0.1:8080: coarser: the kernel holds the ports, not the addresses; native code and children may reach any address on these ports (169.254.169.254 included)
```

On macOS a `list only:` line names the folders whose names (never their contents) are readable:
the working directory, and `/` when `--allow-run` is granted, because starting a program lists it.

### Gap kinds

| Kind          | Meaning                                                                                                                                                                                                                                                              | Under `enforce`        |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `fail-open`   | Marked `!`. The kernel would allow more than Deno's rule, so the rule is held by Deno's checks only. Counted in the warning line.                                                                                                                                    | Refuses to start.      |
| `fail-closed` | The kernel would refuse something Deno's rule allows, for example a file created after start in a folder whose deny had to be expanded.                                                                                                                              | Applied, and reported. |
| `documented`  | A limit the sandbox never claims to hold (`env` outside Linux `enforce`, `sys`, file metadata, what programs started under a scoped `--allow-run` may execute), or a rule the kernel holds more coarsely (a port list, a macOS `host:port`, a scoped `--allow-ffi`). | Runs, and reported.    |

The `documented` gaps `enforce` runs with, which are worth reading before you rely on a rule:

- **macOS `--allow-net=<host>:<port>`**: any host on that port, and any name resolves.
- **A port list of IP addresses or `localhost`** (Linux with Landlock ABI 4 or later, and macOS):
  any address on those ports, `169.254.169.254` included.
- **A scoped `--allow-ffi=<paths>`** (Linux and macOS): any library in the read scope may load.
- **macOS's `sandbox-exec` fallback** without `--allow-run`: native code can start the runtime's
  own binary again, under the same profile.

How grants map today:

- **Linux network.** Port rules apply only to IP addresses and `localhost`, and need Landlock ABI
  4; before it a port list is a `fail-open` gap and `enforce` refuses to start. A host name needs
  Mode B, which isn't built: the rule is a `fail-open` gap, and `enforce` refuses to start.
- **Linux Unix sockets** need an explicit `--allow-net=unix:<path>` grant.
- **Linux read deny inside a read allow** is held by expansion: at startup each entry beside the
  denied path gets its own rule. A file created in that folder after start is unreadable
  (`fail-closed`), a symlink there gets no rule, and more than 20,000 entries or 64 levels refuses
  to start.
- **Linux write deny inside a write allow** needs Mode B: `enforce` refuses to start.
- **Linux chmod / utime by path** are refused under `enforce`, inside the write scope too
  (`fail-closed`).
- **Linux environment** is scrubbed under `enforce` to the `--allow-env` names plus a short runtime
  list, unless `--allow-env` is unscoped.
- **macOS** holds denies inside allows exactly. Its port rules can't tell hosts apart, and code
  loads from the read scope plus the system libraries.
- **Windows** reads and network are held by Deno's checks only.
- **`sys`** is held by Deno's checks only, everywhere; `env` too, except Linux under `enforce`.

## `deno info --json` → `kernelSandbox`

`deno info --json` reports a `kernelSandbox` object. A runtime without the sandbox leaves it out,
so a tool can detect the feature by checking for it, and `enforcerBuilt` says whether the runtime
can enforce on this platform. This is the object on a Linux machine with Landlock ABI 4 and no mode
set:

```json
{
  "preview": true,
  "mode": "auto",
  "source": "default",
  "effective": "off",
  "wouldApply": "warn",
  "reason": "auto applies nothing yet (the kernel sandbox is an opt-in preview)",
  "enforced": false,
  "enforcerBuilt": true,
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
    "enforcerBuilt": true
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
    "kernel sandbox: the supervising broker (Mode B) is not built in yet; --kernel-sandbox=broker refuses to start, and enforce refuses rules only the broker can hold"
  ]
}
```

| Field           | Meaning                                                                                                                                                                                                                                 |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `preview`       | `true` while the sandbox is a preview.                                                                                                                                                                                                  |
| `mode`          | The mode that was asked for.                                                                                                                                                                                                            |
| `source`        | Where it came from: `default`, `flag`, `env`, `config` or `compiled`.                                                                                                                                                                   |
| `effective`     | What applies in this run after [the context rules](#how-the-mode-is-chosen).                                                                                                                                                            |
| `wouldApply`    | What `auto` would apply here once enforcement exists.                                                                                                                                                                                   |
| `stage`         | How far the rollout of `auto` has come in this runtime: `preview` (`auto` applies nothing), `r3` or `r4` ([the defaults](/docs/kernel-sandbox-rollout#the-defaults)). Left out by a runtime before the stages: treat that as `preview`. |
| `reason`        | A short explanation of `effective`.                                                                                                                                                                                                     |
| `enforced`      | Always `false` in this runtime, whatever the mode, a `deno.json` that sets `enforce` included. To tell whether a run there would be confined, read `effective` (`enforce`) with `enforcerBuilt` (`true`).                               |
| `enforcerBuilt` | Whether this runtime has an enforcer for this platform: `true` on Linux x86_64 / aarch64 and macOS.                                                                                                                                     |
| `osSandbox`     | The mechanism this platform uses: `landlock`, `seccomp`, `seatbelt`, `job-object` or `none`.                                                                                                                                            |
| `landlockAbi`   | The Landlock ABI on Linux. Left out when there's no Landlock.                                                                                                                                                                           |
| `capabilities`  | What the machine offers, as detected (below).                                                                                                                                                                                           |
| `features`      | What this machine's mechanisms could hold (below).                                                                                                                                                                                      |
| `warnings`      | Anything worth knowing about this machine or configuration.                                                                                                                                                                             |

`capabilities`:

| Key              | Meaning                                                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `os`             | The platform: `linux`, `macos`, `windows` or `other`.                                                                                                        |
| `landlockAbi`    | The Landlock ABI the kernel reports, or `null` when there's no Landlock (macOS, Windows, or Linux without it). The top-level `landlockAbi` is left out then. |
| `seccomp`        | Whether the runtime has a seccomp filter for this architecture (Linux x86_64 and aarch64). It's a property of the build, not detected at run time.           |
| `userNamespaces` | Whether an unprivileged user and network namespace can be created (Linux).                                                                                   |
| `seatbelt`       | Whether Seatbelt can be applied here, through the system's sandbox call or `/usr/bin/sandbox-exec` (macOS).                                                  |
| `jobObject`      | Always `true` on Windows: job objects are available on every supported Windows.                                                                              |
| `lowIntegrity`   | Always `true` on Windows: lowering the integrity level is available on every supported Windows.                                                              |
| `enforcerBuilt`  | Whether this runtime has an enforcer for the platform: `true` on Linux x86_64 / aarch64 and macOS, `false` on Windows.                                       |

`features` lists what this machine's mechanisms could hold; it is applied only under `enforce`,
and never while `enforcerBuilt` is `false`. The list depends on the machine, so a value appears
only where its mechanism exists:

| Feature             | What the sandbox could hold                                                                                                                                                                                 |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fsRead`            | Read scopes.                                                                                                                                                                                                |
| `fsWrite`           | Write, create and remove scopes.                                                                                                                                                                            |
| `fsExec`            | Execute scopes.                                                                                                                                                                                             |
| `fsRefer`           | Moving and linking files between folders (Landlock ABI 2 and later; always on macOS). Without it, every cross-folder rename or link is refused.                                                             |
| `fsTruncate`        | Truncation (Landlock ABI 3 and later; always on macOS).                                                                                                                                                     |
| `fsIoctlDev`        | Device `ioctl`s held to the write scope (Landlock ABI 5 and later; macOS).                                                                                                                                  |
| `tcpPorts`          | TCP port rules for `connect` and `bind` (Landlock ABI 4 and later; always on macOS). Port rules match ports, never addresses.                                                                               |
| `socketFamilies`    | Gating socket family, type and protocol (seccomp on Linux, Seatbelt network rules on macOS): for example no UDP, or no `AF_UNIX`, when not granted.                                                         |
| `unixSocketPaths`   | Unix sockets scoped by path (macOS).                                                                                                                                                                        |
| `scopeAbstractUnix` | Abstract Unix sockets outside the sandbox can't be reached (Landlock ABI 6 and later; macOS).                                                                                                               |
| `scopeSignal`       | Signals can't reach processes outside the sandbox (Landlock ABI 6 and later; macOS).                                                                                                                        |
| `execRefusal`       | Refusing to start any program when there's no `--allow-run`; on Windows, a job object's limit of one active process.                                                                                        |
| `attackSurface`     | A Docker-derived list of kernel-attack-surface system calls refused (`bpf`, `perf_event_open`, `userfaultfd`, `keyctl`, `ptrace`, `mount`, `kexec`, module loading): seccomp, Linux only, never under `-A`. |
| `denyInsideAllow`   | A deny below an allow, held exactly (macOS).                                                                                                                                                                |
| `metadataRead`      | Path-scoped `stat` and other metadata reads (macOS). The command-line profile doesn't use it: it allows metadata reads everywhere.                                                                          |
| `sysctlNarrowing`   | System information narrowed by sysctl name (macOS).                                                                                                                                                         |
| `auditLog`          | Denials written to the audit log (Landlock ABI 7 and later).                                                                                                                                                |
| `overmount`         | Denied paths hidden by an empty mount in a user and mount namespace (Linux, with `userNamespaces`).                                                                                                         |
| `childContainment`  | The process tree can't escape and is killed together (Windows job object).                                                                                                                                  |
| `writeConfinement`  | Writes held to labelled folders (Windows low integrity).                                                                                                                                                    |

More keys and features appear as later stages land.

## Mode B (`broker`) in detail

_Design, being written as this lands._ When Mode B is chosen automatically in the full sandbox,
what goes through the supervisor and what stays in-process, the cost per brokered call, and how
children reach the network through the supervisor's proxy. Mode B isn't built yet: `broker`
refuses to start, and under `enforce` a rule only Mode B could hold refuses to start too.

The Mode B supervisor isn't the **external permission broker** (`DENO_PERMISSION_BROKER_PATH`), a
program of your own that answers Deno's permission checks; see
[Permissions](/docs/permissions#the-external-permission-broker).
