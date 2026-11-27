---
title: Kernel sandbox modes and configuration
slug: kernel-sandbox-modes
lead: How to choose what the kernel sandbox does — the --kernel-sandbox flag, the deno.json key, the value baked in by deno compile, the emergency environment switch — and how to read what applied, from --kernel-sandbox-report and deno info --json.
---

> [!IMPORTANT]
> **An opt-in preview ships in denext 4.x; automatic enforcement lands in denext 5.0.** The flags,
> the `deno.json` key, the report and the `deno info --json` shape on this page are in the Deno
> toolchain and Desktop runtime that denext pins. **Status:** the preview enforces when you ask it
> to. `auto` changes nothing in denext 4.x, `warn` reports, `enforce` confines `deno run`,
> `deno serve`, `deno test` and `deno bench` on Linux and macOS (taking Mode B where a rule needs
> it), and `broker` runs Mode B on Linux and macOS.

## What the preview does today

- With no setting, nothing changes: the default `auto` applies nothing in denext 4.x and only
  records what it would apply. It costs nothing: no policy is compiled.
- `warn` runs your program normally and reports what `enforce` would refuse: the rules it couldn't
  start with, and, where the platform can observe it, each access by native code and children
  ([warn mode](#warn-mode)).
- `--kernel-sandbox-report` prints the full policy and every gap, then runs your program.
- `enforce` applies the policy to `deno run`, `deno serve`, `deno test` and `deno bench` on Linux
  (x86_64 and aarch64, with Landlock) and macOS, where `deno info --json` reports
  `enforcerBuilt: true`. The process confines itself (Mode A) where the kernel can hold the grant,
  and starts under the supervising broker (Mode B) where only the broker holds a rule exactly. It
  refuses to start over a `fail-open` gap and runs with the `documented` ones listed in the report
  ([gap kinds](#gap-kinds)). `deno run` on Windows has no enforcer; a program compiled with
  `enforce` for Windows gets the [small tier](/docs/kernel-sandbox-windows).
- `broker` runs Mode B on Linux and macOS for every scoped network or file rule
  ([Mode B in detail](#mode-b-broker-in-detail)).

> [!WARNING]
> **`"kernelSandbox": "enforce"` in `deno.json` breaks `denext dev`.** The key applies to every
> command in the project, and the REPL, Jupyter and anything that isn't fixed (`--watch`, HMR,
> `denext dev`) refuse to start under `enforce`, as does a `deno test` that loads a Vitest or Jest
> config. Put `--kernel-sandbox=enforce` on the command that starts the app (the `start` task)
> instead.

## The five modes

| Mode             | What it does in the preview                                                                                                                                                                                                                                                                    | What it does in the full sandbox                                                                                                |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `auto` (default) | Applies nothing. Records what it would apply (`wouldApply` in `deno info --json`).                                                                                                                                                                                                             | Applies everything this kernel supports where the permission set is fixed. Rules it can't hold stay Deno-only and are reported. |
| `warn`           | Runs normally and [reports](#warn-mode) what `enforce` would refuse. Nothing is refused.                                                                                                                                                                                                       | Same.                                                                                                                           |
| `enforce`        | `run`, `serve`, `test` and `bench` on Linux and macOS: applies the policy, with Mode B for the rules the kernel can't hold. Refuses to start (exit code 1) over a `fail-open` gap, naming each rule; runs with `documented` gaps. Other commands, and `deno run` on Windows: refuses to start. | Same, on more commands.                                                                                                         |
| `broker`         | `enforce` plus the Mode B supervisor, which holds every scoped network rule (host names, address lists, Unix sockets by path) and, on Linux, write denies inside a write allow. Linux and macOS.                                                                                               | Same.                                                                                                                           |
| `off`            | No kernel layer, Deno's checks only.                                                                                                                                                                                                                                                           | Same.                                                                                                                           |

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
- `enforce` applies to `run`, `serve`, `test` and `bench`. `test` and `bench` type-check and find
  their modules first, then re-execute confined and run exactly the modules found, before any test
  code runs; coverage and JUnit files are still written. `Deno.test({ permissions })` and
  per-bench permissions stay API-level: the kernel holds the top-level grant. Under `enforce`, the
  REPL, Jupyter, `eval` with a deny rule (a plain `eval` grants everything, so there is nothing to
  enforce; its deny flags are applied), a program read from stdin, and a `test` that loads a
  Vitest or Jest config refuse to start with "not supported for this command yet". `deno x`
  refuses to run a package's native executable under `enforce`. They never run unconfined.
  `enforce` doesn't cover a `test` with `--update-snapshots`, or a `test` or `bench` whose
  workspace members bring permission sets of their own; `auto` runs those as `warn`.
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
- `enforce` here applies to `deno repl` and `denext dev` too, which refuse to start under it, and
  to `deno test` and `deno bench`. Use `warn` in `deno.json` and pass `--kernel-sandbox=enforce`
  on the start command.
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
- The binary ignores the `--kernel-sandbox` flag, `DENO_KERNEL_SANDBOX` and `deno.json` at run
  time.
- `enforce` is accepted for a command-line program for Linux, macOS and Windows. The program
  confines itself at startup with its baked grant; on Linux and macOS it runs its own supervising
  broker where the grant needs one, and on Windows it gets the
  [small tier](/docs/kernel-sandbox-windows). The policy is compiled for the target OS at build
  time, and a rule that OS could never hold is printed as a warning (the program would refuse to
  start there).
- `broker` is accepted for Linux and macOS programs, and refused for Windows and for desktop apps,
  whose compiled programs run no supervisor.
- `--kernel-sandbox-exec=strict` is baked too.
- A program compiled with `enforce` or `broker` doesn't prompt. The first permission it is refused
  on a terminal prints one line naming the access and `deno compile --kernel-sandbox=off`.
- A binary compiled with `warn` prints the [warning line](#warn-mode) when it starts.
- Desktop apps (`deno desktop`) take `enforce` and `auto`; see
  [Desktop and compiled apps](/docs/kernel-sandbox-desktop-and-compiled).

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

In the full sandbox, `auto` will choose `enforce` wherever the permission set is fixed, and the
broker where only Mode B holds a rule exactly. A run that can prompt keeps its prompts, and only
its `--deny-*` rules are enforced, as ceilings no prompt can lift (held by the kernel on macOS;
on Linux they stay Deno's checks for now, and the report says so). `-A` with `--deny-*` gets the
same treatment. A mode `auto` chose never refuses to start: where neither Mode A nor Mode B can
hold the grant, or the command isn't covered, it runs as `warn`. A packaged desktop app that isn't
strict stays off. In the preview `auto` applies none of this.

Jupyter builds its permissions separately, so the Jupyter kernel has no kernel sandbox layer yet,
and `enforce` refuses to start there.

## Warn mode

`warn` runs your program, refuses nothing, and starts with one line on stderr:

```text
Warning kernel sandbox (warn, preview): nothing is refused; 1 rule(s) would be held by Deno's checks only. Run with --kernel-sandbox-report for the policy.
```

The count is the number of rules `enforce` would refuse to start over on this machine (the
`fail-open` gaps in the report). After that line, warn mode reports each access `enforce` would
refuse, once per distinct access (the first 20 are printed), with the grant that would allow it.
It also names programs the run starts that are known to need a grant of their own or to fail
inside a sandbox (git, ssh, npm, docker, sudo, a browser, debuggers).

- **`DENO_KERNEL_SANDBOX_WARN_LOG=<file>`** appends every report to that file as JSON lines: a
  `run` line per process, then a `wouldDeny` line per access. Several processes of one run append
  to the same file.
- **The observer.** For a `warn` asked for by name (the flag, `deno.json` or
  `DENO_KERNEL_SANDBOX`) on `deno run` and `deno serve`, warn mode also watches what native code and
  child processes do. On macOS it applies a report-only Seatbelt profile that allows everything and
  logs what `enforce` would refuse. On Linux the run starts beneath a tracing supervisor whose
  seccomp filter hands it the opens, the calls that create, remove or rename a name, `execve`, and
  `connect` / `bind`; each is reported and then continues as it was made.
  `DENO_KERNEL_SANDBOX_WARN_OBSERVE=0` turns the observer off.
- **The observer changes the process.** It's an observer, never a boundary, but it isn't free:
  - On macOS a program that applies a sandbox of its own (headless Chrome, Puppeteer and
    Playwright browsers, `sandbox-exec`, a nested `enforce`) fails under the report-only profile,
    as it would under `enforce`.
  - On Linux the filter sets no-new-privileges, so setuid programs in the tree don't elevate; a
    program that installs a seccomp listener of its own fails with `EBUSY`; every traced call waits
    for the supervisor; and the program runs under the supervisor as it does in
    [Mode B](#mode-b-broker-in-detail).

  Set `DENO_KERNEL_SANDBOX_WARN_OBSERVE=0` for such runs, or leave `warn` to the commands that
  don't start such programs.

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
  gaps: 3 (0 refused by enforce, marked !)
    sys [documented] implicit /proc/self, /sys/fs/cgroup: documented: the runtime reads its own /proc/self entries and the cgroup CPU / memory limits ...
    sys [documented] no --allow-sys: sys is enforced by Deno; the kernel narrows: /proc/loadavg, /proc/meminfo, /proc/uptime, /proc/net
    env [documented] no --allow-env: env is enforced by Deno: native code reads the process environment directly ...
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
- **`gaps`** lists every rule the operating system wouldn't hold exactly, by kind. A rule `enforce`
  would refuse to start over is marked `!`; this policy has none, because the broker holds the
  host name and the write deny inside the write allow. Without those two rules, the policy is
  Mode A and `enforce` runs with no supervisor.

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

| Kind          | Meaning                                                                                                                                                                                                                                                | Under `enforce`        |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------- |
| `fail-open`   | Marked `!`. The kernel would allow more than Deno's rule, so the rule is held by Deno's checks only. Counted in the warning line.                                                                                                                      | Refuses to start.      |
| `fail-closed` | The kernel would refuse something Deno's rule allows, for example a file created after start in a folder whose deny had to be expanded.                                                                                                                | Applied, and reported. |
| `documented`  | A limit the sandbox never claims to hold (`env` outside `enforce`, `sys`, file metadata, what programs started under a scoped `--allow-run` may execute), or a rule the kernel holds more coarsely (a port list of addresses, a scoped `--allow-ffi`). | Runs, and reported.    |

The `documented` gaps `enforce` runs with, which are worth reading before you rely on a rule:

- **A port list of IP addresses or `localhost`** (Linux with Landlock ABI 4 or later, and macOS):
  any address on those ports, `169.254.169.254` included. `broker` holds it exactly.
- **A scoped `--allow-ffi=<paths>`** (Linux and macOS): any library in the read scope may load.
- **macOS's `sandbox-exec` fallback** without `--allow-run`: native code can start the runtime's
  own binary again, under the same profile.

How grants map today:

- **Network, Linux and macOS.** Port rules apply only to IP addresses and `localhost`, and on
  Linux need Landlock ABI 4; before it `enforce` holds a port list through Mode B. A host name, or
  a `--deny-net`, is held by Mode B. Under a broker-held network the confined process has no
  network socket of its own: native code and children other than `deno` have no network, and UDP
  is refused under a host-scoped grant.
- **Linux listen-only grants.** An `--allow-net-listen` list of addresses with ports is bound
  before the sandbox applies, and the listeners are handed to the program.
- **Linux Unix sockets** need an explicit `--allow-net=unix:<path>` grant, held through Mode B.
- **Linux read deny inside a read allow** is held by expansion: at startup each entry beside the
  denied path gets its own rule. A file created in that folder after start is unreadable
  (`fail-closed`), a symlink there gets no rule, and more than 20,000 entries or 64 levels refuses
  to start.
- **Linux write deny inside a write allow** is held by Mode B: exact for Deno's own operations,
  and fail-closed for native code and children, which can't create, rename or remove directly in
  the folders that lead to the deny or in folders made after start.
- **Linux chmod / utime by path** are refused under `enforce`, inside the write scope too
  (`fail-closed`).
- **Environment** (Linux and macOS) is scrubbed under `enforce` to the `--allow-env` names plus a
  short runtime list, unless `--allow-env` is unscoped.
- **macOS** holds denies inside allows exactly. Code loads from the read scope plus the system
  libraries.
- **Windows** reads and network are held by Deno's checks only.
- **`sys`** is held by Deno's checks only, everywhere; `env` too, except under `enforce`.

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
  "stage": "preview",
  "reason": "auto applies nothing yet (the kernel sandbox is an opt-in preview)",
  "enforced": false,
  "enforcerBuilt": true,
  "brokerBuilt": true,
  "brokerNetBuilt": true,
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
  "warnings": []
}
```

| Field            | Meaning                                                                                                                                                                                                   |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `preview`        | `true` while the sandbox is a preview.                                                                                                                                                                    |
| `mode`           | The mode that was asked for.                                                                                                                                                                              |
| `source`         | Where it came from: `default`, `flag`, `env`, `config` or `compiled`.                                                                                                                                     |
| `effective`      | What applies in this run after [the context rules](#how-the-mode-is-chosen).                                                                                                                              |
| `wouldApply`     | What `auto` would apply here once enforcement exists: `off`, `warn`, `enforce` or `broker`.                                                                                                               |
| `stage`          | How far `auto`'s rollout has come in this runtime. `preview`: `auto` applies nothing.                                                                                                                     |
| `reason`         | A short explanation of `effective`.                                                                                                                                                                       |
| `enforced`       | Always `false` in this runtime, whatever the mode, a `deno.json` that sets `enforce` included. To tell whether a run there would be confined, read `effective` (`enforce`) with `enforcerBuilt` (`true`). |
| `enforcerBuilt`  | Whether this runtime has an enforcer for this platform: `true` on Linux x86_64 / aarch64 and macOS.                                                                                                       |
| `brokerBuilt`    | Whether this runtime's Mode B supervisor holds file rules (a write deny inside a write allow on Linux).                                                                                                   |
| `brokerNetBuilt` | Whether its supervisor holds the network too (host names, Unix sockets by path).                                                                                                                          |
| `osSandbox`      | The mechanism this platform uses: `landlock`, `seccomp`, `seatbelt`, `job-object` or `none`.                                                                                                              |
| `landlockAbi`    | The Landlock ABI on Linux. Left out when there's no Landlock.                                                                                                                                             |
| `capabilities`   | What the machine offers, as detected (below).                                                                                                                                                             |
| `features`       | What this machine's mechanisms could hold (below).                                                                                                                                                        |
| `warnings`       | Anything worth knowing about this machine or configuration.                                                                                                                                               |

`capabilities`:

| Key              | Meaning                                                                                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `os`             | The platform: `linux`, `macos`, `windows` or `other`.                                                                                                                                 |
| `landlockAbi`    | The Landlock ABI the kernel reports, or `null` when there's no Landlock (macOS, Windows, or Linux without it). The top-level `landlockAbi` is left out then.                          |
| `seccomp`        | Whether a seccomp filter can be installed here: the runtime has one for this architecture (Linux x86_64 and aarch64) and the process may install it (an outer profile can refuse it). |
| `userNamespaces` | Whether an unprivileged user and network namespace can be created (Linux).                                                                                                            |
| `seatbelt`       | Whether Seatbelt can be applied here, through the system's sandbox call or `/usr/bin/sandbox-exec` (macOS).                                                                           |
| `jobObject`      | Always `true` on Windows: job objects are available on every supported Windows.                                                                                                       |
| `lowIntegrity`   | Always `true` on Windows: lowering the integrity level is available on every supported Windows.                                                                                       |
| `enforcerBuilt`  | Whether this runtime has an enforcer for the platform: `true` on Linux x86_64 / aarch64 and macOS, `false` on Windows.                                                                |

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

Mode B runs on Linux and macOS: `deno run`, `deno serve`, `deno test` and `deno bench`, and
programs compiled for those systems. `enforce` takes it where a rule needs it; `broker` takes it
for every scoped network or file rule.

**What goes through the supervisor.** A host name in a network grant, `--deny-net`, and on Linux a
write deny inside a write allow, Unix sockets by path, and a port list on a kernel without
Landlock's TCP rules. Under an explicit `broker` every scoped network list goes through it too, so
a port list of IP addresses or `localhost` is held exactly instead of by port. A network with
nothing to hold (unscoped, no deny) stays the process's own.

**How the process tree looks.** `deno` re-executes as a supervisor with one thread, no JavaScript
engine and no user code, which forks the confined program and serves its requests. A compiled
program forks in place before its engine starts. The supervisor:

- keeps the PID the program was started with, exits with the program's exit code (or by the signal
  that ended it), and passes on the signals a process sends it;
- as PID 1 of a container, handles every signal it passes on, reaps what it is handed, and exits
  with `128 + signal` when the program died of a signal an init can't die of;
- keeps only standard input, output and error and its channel to the program, so a pipe the
  program closes reaches its other end.

**The network under the broker.** The supervisor reads the grant with the same code as Deno's
checks. It resolves a granted name itself and refuses an answer on this machine or its networks
unless the grant names that address; `localhost` leads to loopback only. Each socket is connected
to exactly the address that was checked, and listening sockets are bound by the supervisor. The
confined process can't make a network socket of its own, and on Linux can't `connect` or `listen`
on one, so a socket it was handed can't be pointed elsewhere. UDP is handed out only when the
grant could send anywhere anyway; under a host-scoped grant `Deno.listenDatagram`, `node:dgram`,
QUIC and WebRTC's UDP candidates are refused, and a DNS query to a granted name server is made by
the supervisor.

**Not carried by the broker** (each fails under a broker-held network, none is a way out): a
module fetched after start, npm auto-install, the OpenTelemetry exporter, `Deno.cron`'s control
socket, the deploy tunnel, `node:net` named pipes, abstract Unix sockets, UDP under a host-scoped
grant, and the network of child processes other than `deno`.

**Children.** A `deno` or compiled Deno program that the confined program starts, directly or
through a shell, reaches the same supervisor: it asks for a channel of its own, and its own checks
(against its grant intersected with the inherited one) come first. A child that applies a kernel
sandbox of its own gives that channel up first. Other programs get the kernel's fail-closed view.

**Known differences for launchers.** A signal sent to the whole process group or control group
(`kill -TERM -<pgid>`, systemd's default `KillMode=control-group`) reaches the program twice.
`SIGTSTP` sent to the supervisor's PID alone isn't passed on. `sd_notify` from the program needs
`NotifyAccess=all`. A program that brings its own broker inside a brokered run has no network.

The Mode B supervisor isn't the **external permission broker** (`DENO_PERMISSION_BROKER_PATH`), a
program of your own that answers Deno's permission checks; see
[Permissions](/docs/permissions#the-external-permission-broker).
