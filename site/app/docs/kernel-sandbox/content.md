---
title: Kernel sandbox
slug: kernel-sandbox
lead: Kernel-enforced permissions. When a run's --allow-* grant can't change, the operating system enforces it too, so FFI, Node-API addons, native code in npm packages and subprocesses are held to the same grant as your JavaScript. Deno's own checks stay in place, and the kernel sits underneath them as a backstop.
---

> [!IMPORTANT]
> **An opt-in preview ships in denext 4.20; the full sandbox, with automatic enforcement, lands
> in denext 5.0.** The pages in this section describe the full design. The preview enforces
> when you ask it to: `--kernel-sandbox=enforce` confines `deno run` and `deno serve` on Linux and
> macOS ([What `enforce` does today](#what-enforce-does-today)). With no setting nothing changes:
> the default, `auto`, applies nothing in denext 4.x. `--kernel-sandbox=warn` (or the `deno.json`
> key) prints how many rules only Deno's checks would hold, `--kernel-sandbox-report` prints the
> policy and its gaps, and `broker` (Mode B) still refuses to start. A run that doesn't enforce
> keeps Deno's permissions as
> [least-privilege guardrails](/docs/permissions#least-privilege-guardrails-not-a-sandbox). Flag names, defaults and the per-kernel details can still change. Where a
> point is still open, the page says so.

## What `enforce` does today

Most of this section describes the full design. This is the part that runs now, when a run asks
for it with `--kernel-sandbox=enforce`:

- **Where.** `deno run` and `deno serve`, on Linux (x86_64 and aarch64, with Landlock: kernel
  5.13 or later) and on macOS. `deno info --json` reports `kernelSandbox.enforcerBuilt: true`
  where the runtime has an enforcer. Windows has none yet.
- **Mode A only.** The process confines itself. The Mode B supervisor isn't built yet, so a rule
  only it could hold refuses to start: on Linux, a host-scoped `--allow-net`
  (`--allow-net=api.example.com:443`) and a write deny inside a write allow.
  `--kernel-sandbox=broker` refuses to start.
- **What refuses to start.** Only a rule the kernel would hold _more loosely_ than Deno's own
  check, a `fail-open` gap. The error names each rule.
- **What runs with a documented gap.** A rule the kernel holds, but more coarsely than Deno does,
  runs, and `--kernel-sandbox-report` lists it as `documented`. Read those lines before relying on
  a port list or an `--allow-ffi` scope:
  - **macOS `--allow-net=<host>:<port>`**: the kernel holds the port, not the host. Native code
    and children may reach any host on that port, and resolve any name.
  - **A port list of IP addresses or `localhost`** (Linux and macOS): any address on those ports,
    `169.254.169.254` (the cloud metadata address) included.
  - **A scoped `--allow-ffi=<paths>`** (Linux and macOS): native code may load any library it can
    read. Library loading is bounded by the read scope, not by the `--allow-ffi` list.
- **Commands that refuse under `enforce`.** `deno test` (before type-checking), `deno bench`, the
  REPL, Jupyter, `deno eval` with a deny rule, a package's native executable under `deno x`, and
  (on Linux) a program read from stdin. They refuse to start rather than run unconfined. `deno
  lint` and the language server's lint plugins are neither covered nor refused: they run with no
  kernel sandbox (`deno lint` warns when `deno.json` sets the key), until confining them lands
  before 5.0. `deno compile --kernel-sandbox=enforce` is refused for a desktop app: its process
  hosts a browser engine, and that part hasn't landed.

> [!WARNING]
> **Don't put `"kernelSandbox": "enforce"` in `deno.json`.** The key applies to every command that
> runs your code in the project (lint plugins aside, which it doesn't cover), so `deno test`, `deno bench`, `deno repl` and `denext dev` refuse to start there.
> Put the flag on the command that starts the app instead, for example a `start` task of
> `deno run --kernel-sandbox=enforce --allow-read=. main.ts`. `"kernelSandbox": "warn"` is safe in
> `deno.json`.

What changes inside an `enforce` run on Linux:

- **The environment is scrubbed.** Without an unscoped `--allow-env`, the process keeps only the
  `--allow-env` names plus a short runtime list (`PATH`, `HOME`, `TMPDIR`, `DENO_DIR`, `LANG`,
  `LC_*`, `TZ`, the proxy variables, `NO_COLOR`, `TERM`). Child processes inherit only that set,
  so `SSH_AUTH_SOCK`, `USER`, `CI`, `NODE_ENV` and tokens are gone unless granted
  (`--allow-env=CI,NODE_ENV`). macOS keeps the environment.
- **chmod, chown, utime and extended-attribute writes by path are refused, inside the write scope
  too.** `Deno.chmod`, `Deno.utime`, `cp -p`, `tar` and git setting a file's executable bit fail
  with `EPERM`. The forms that take an open file descriptor still work.
- **A read deny inside a read allow** is held by expansion: each entry beside the denied path gets
  its own rule at startup. A file created there after start is unreadable, a symlink there gets no
  rule, and a folder of more than 20,000 entries or 64 levels deep refuses to start.
- **A TCP port list** needs Landlock ABI 4 (Linux 6.7). On an older kernel it refuses to start.
- **Remote modules come from the cache only.** The program's static module graph is loaded first;
  a dynamic `import()` of a remote module that wasn't cached fails with the usual "not found in
  cache" error.
- **`.npmrc` isn't readable**, because it can hold registry tokens. It's treated as absent, with a
  one-time warning, and the report names it on a `skipped:` line. Run once without `enforce` to
  cache the packages, or grant the file with `--allow-read=<path>/.npmrc` if you accept the
  exposure.

On macOS the profile is applied in place, with no re-exec, where the system's sandbox call is
available, and otherwise the process re-executes under `/usr/bin/sandbox-exec`. Inside another
Seatbelt sandbox (App Sandbox, an agent's sandbox, `sandbox-exec`) it refuses to start. See
[macOS](/docs/kernel-sandbox-macos).

**The default costs nothing.** With no setting (`auto`) or `off`, and no
`--kernel-sandbox-report`, no policy is compiled and nothing is applied.

The [troubleshooting](/docs/kernel-sandbox-troubleshooting) page lists each of these with its
symptom and fix.

## The gap this closes

Deno's `--allow-read`, `--allow-write`, `--allow-net`, `--allow-run` and the rest are **checks
inside Deno's own functions**. `Deno.readFile`, `fetch`, `node:fs` and the others check the
permission state before they do anything. The operating system knows nothing about those flags,
so any code that reaches the OS without going through Deno's functions also skips the checks:

- **FFI.** A library loaded with `Deno.dlopen` is native code inside the process. It can open
  files and sockets with ordinary system calls.
- **Node-API addons.** A `.node` file an npm package loads is FFI by another name.
- **Native code in npm packages.** Prebuilt binaries and compiled extensions run with the
  user's full rights.
- **Subprocesses.** A program started under `--allow-run` is a normal OS process. Deno's flags
  don't follow it.

That's why the [Permissions](/docs/permissions) page calls `--allow-run` and `--allow-ffi`
"full trust" today. The kernel sandbox fixes this by having the operating system enforce the
same grant, so code that skips Deno's checks still runs into the kernel's.

## What it is, and what it isn't

The kernel sandbox is a **backstop underneath Deno's existing permission checks. It doesn't
replace them.**

- Deno's checks run exactly as they do now. Your own code still gets the same precise
  `NotCapable` errors that name the permission it needs.
- Underneath, the kernel gets a policy compiled from the same grant, plus the files and devices
  the runtime itself needs to start (shared libraries, time zone data, `/dev/urandom` and so on).
  That set of runtime needs is called the **implicit set**. `--kernel-sandbox-report` prints it,
  with each entry and the reason it's there.
- These mechanisms can **only narrow** what a process may do. Once a process is confined, it and
  everything it starts stay confined. Nothing inside can widen the policy, and no setting can
  undo it from inside.
- When a kernel can't express one of your rules exactly, denext doesn't quietly drop it. In
  `auto` and `warn` modes the rule stays enforced by Deno alone and the report names it. In
  `enforce` mode Deno refuses to start when the kernel would allow more than the rule (a
  `fail-open` gap), and runs with the gap listed in the report when the kernel holds the rule more
  coarsely (a `documented` gap; see [Modes](#modes)).

denext already uses the same machinery in one place: an approved dependency's install script
runs in the
[lifecycle-script jail](/docs/toolchain#supply-chain-lifecycle-script-jail). The kernel sandbox
takes that jail's Linux and macOS enforcers and points them at your running program, which
needs a narrower policy built from your actual grant.

## The mechanisms

Each operating system offers different tools, and none covers everything on its own. The
sandbox combines the ones each platform has:

| Platform | Mechanism                      | What it holds                                                                                                                                   |
| -------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux    | **Landlock**                   | Which files and folders the process and its children may read, write or execute. On newer kernels, which TCP ports they may connect to or bind. |
| Linux    | **seccomp**                    | A system-call filter. It refuses dangerous calls outright, and refuses networking or starting programs entirely when no grant allows them.      |
| macOS    | **Seatbelt**                   | Files, network and program execution in one sandbox profile.                                                                                    |
| Windows  | **Job object + low integrity** | Children stay contained, and writes are limited by integrity level. Reads and network are still enforced by Deno only.                          |
| All      | **Mode B supervisor** (design) | Rules too fine for any kernel, such as one host name or a folder with an exception, handled by a small unconfined helper process.               |

What the terms mean:

- **Landlock** is a Linux security module that an unprivileged process can apply to itself.
  The process lists the folders it may still use and which operations it may perform in each.
  From then on the kernel refuses everything else, for that process and every process it starts.
  It needs no root, no container and no setup.
- **seccomp** (secure computing mode) lets a process install a filter that the kernel runs on
  every system call. The filter sees the call's number and its integer arguments, not the data
  behind pointers, so it can say "no `ptrace`", "no `bpf`", "no `mount`" or "no IPv4 sockets",
  but it can't tell one file path or one host from another. Landlock handles paths. seccomp
  handles the calls that should never happen at all: raw mounts, `ptrace`, `bpf`, kernel
  keyrings, `io_uring`. It also refuses network sockets or `execve` outright when no grant
  allows them.
- **Seatbelt** is the macOS sandbox, the same engine the App Store sandbox and Safari's content
  processes use. denext generates a profile from your grant: which paths may be read or written,
  which network endpoints may be reached, and whether programs may be started. On macOS a single
  profile covers files, network and execution. Code loads from the read scope plus the system
  libraries, as on Linux.
- **Job objects and integrity levels** are the Windows tools a process can apply to itself without
  administrator rights. A job object keeps every child in the job (a child can't break away, and the
  job can forbid children altogether). Lowering the process's integrity level to _Low_ means it can
  only write to objects labelled Low. Neither one limits reads or network, which is why on Windows
  those stay with Deno's checks. See [Windows](/docs/kernel-sandbox-windows).
- **The Mode B supervisor** (not built yet) is what this section calls **Mode B**. When a rule is finer
  than the kernel can express, such as "only `api.example.com`", "this folder except `.env`" or
  "this one Unix socket", `deno` splits in two. A small unconfined **supervisor** with no
  JavaScript engine and no user code stays outside the sandbox. The confined process asks it to
  open a file or connect a socket. The supervisor checks the request against the same policy,
  performs the operation, and passes back the already-opened file or connected socket. Native
  code in the confined process can use only the handles it has been given. It can't open new
  ones the kernel would refuse.

### Mode A and Mode B

- **Mode A (self-confinement).** The process confines itself and keeps running as one process.
  Nothing unconfined is left over, and it costs nothing at run time. This is used whenever the
  kernel can express the grant exactly: a folder list, no network, all network, no programs.
- **Mode B (supervisor + broker).** As described above. It's chosen automatically when the
  policy needs it, or explicitly with `--kernel-sandbox=broker`. Mode B behaves the same on every
  kernel, which is how host-scoped network and "folder except X" rules are held consistently,
  even where Landlock is old or missing its port rules.

The supervisor isn't a yes-man. It holds the compiled policy, never asks the confined side what
is allowed, never prompts, and never widens anything. Native code can write any bytes it likes
to the socket between them, so the supervisor treats every request as untrusted.

**Status:** Mode B is design. It isn't built yet, so `--kernel-sandbox=broker` refuses to start,
and under `enforce` a rule only Mode B could hold refuses to start too.

**Two different "brokers".** The `broker` mode and "Mode B supervisor" on these pages are the
kernel sandbox's own helper process. They are unrelated to the **external permission broker**, a
program you run yourself and name with `DENO_PERMISSION_BROKER_PATH`, which answers Deno's
permission checks (see [Permissions](/docs/permissions#the-external-permission-broker)). A run
with an external permission broker can't use `enforce`: its grant isn't fixed.

## When it switches on

**Status:** in denext 4.x nothing switches on by itself. The preview's settings take effect only
when you opt in with the flag or the `deno.json` key ([Modes](#modes)), and `enforce` confines a
`run` or `serve` that asks for it. The table below is the design: automatic enforcement for the
fixed contexts below, bare CI runs included, comes with the full sandbox in denext 5.0.

The kernel layer can only narrow. If a prompt could widen the grant halfway through a run, a
kernel policy fixed at startup would be wrong. So the sandbox switches on by itself **only when
the permission set can't change during the run**: nobody can be prompted, and the author has
fixed the grant.

| How the program runs                                                         | With the full sandbox                                                                                                    |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| A compiled binary (`deno compile`, `denext build --compile`)                 | On (`auto`). The mode is baked in at compile time.                                                                       |
| A packaged desktop app with `desktop.permissions: "strict"`                  | On (`enforce`). See [Desktop and compiled apps](/docs/kernel-sandbox-desktop-and-compiled).                              |
| `denext start`, the generated Docker image, the generated systemd unit       | On (`auto`).                                                                                                             |
| A bare non-interactive run: CI, a pipe, `--no-prompt`, no TTY                | On (`auto`).                                                                                                             |
| An interactive run that can prompt                                           | Off, as today. Prompts keep working.                                                                                     |
| `-A` / `--allow-all` with no `--deny-*`                                      | Off. There's nothing to narrow, so nothing changes.                                                                      |
| `-A` with `--deny-*`                                                         | The denies are enforced where the kernel can express them exactly. The rest are reported.                                |
| `--watch`, HMR, `denext dev`                                                 | Off. They re-resolve modules after start, which a fixed policy can't serve.                                              |
| `deno task`, `install`, `add`, `cache`, `compile`, `fmt`, `lint`, `check`, … | Not sandboxed themselves. Each `deno run` a task starts decides for itself, and install scripts keep the lifecycle jail. |

"Can prompt" uses the same test as Deno's permission prompt: prompting isn't disabled and both
stdin and stderr are terminals. If any of those fails, no prompt can happen, and the set is
fixed.

Two consequences are worth knowing up front:

- **A compiled binary run on a terminal doesn't prompt.** Its author fixed its permissions, so
  under the kernel sandbox a permission it lacks is refused rather than asked for. `deno compile`
  warns when it bakes a partial grant without disabling prompts, and the binary prints a line
  naming the compile-time switch the first time it refuses something on a terminal. Compile with
  `--kernel-sandbox=off` to keep the old prompting behaviour.
- **Whether you redirect stderr changes whether a run can prompt.** That's already true of
  prompting today. Under the sandbox it also decides whether the kernel layer is on.

## Modes

**Status:** the denext 4.20 preview accepts all five modes, from the command-line flag or the
`deno.json` key, and changes nothing unless you ask for it. `warn` reports; `enforce` applies the
policy to `deno run` and `deno serve` on Linux and macOS (Mode A); `broker` still refuses to start,
because the Mode B supervisor isn't built yet; `auto` applies nothing in denext 4.x. Automatic
enforcement arrives with the full sandbox in denext 5.0.

One setting picks the behaviour:

| Where                      | How                                                                                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| In a compiled binary       | `deno compile --kernel-sandbox=<mode>`, baked in at build time. Always wins.                                                                                        |
| On the command line        | `--kernel-sandbox=<mode>` on `run`, `serve`, `test`, `bench`, `repl`, `compile` and `install -g`. Overrides `deno.json`. `enforce` runs only for `run` and `serve`. |
| In the environment         | `DENO_KERNEL_SANDBOX=off` or `warn`. Can only lower the mode.                                                                                                       |
| In a project's `deno.json` | `"permissions": { "kernelSandbox": "warn" }`. A workspace member's overrides the root's.                                                                            |

| Mode             | What it does                                                                                                                                                                                          |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `off`            | No kernel layer. Deno's checks only, as today.                                                                                                                                                        |
| `warn`           | Runs normally and prints one line saying how many rules would be held by Deno's checks only (see [Warn mode](/docs/kernel-sandbox-modes#warn-mode)). Nothing is refused.                              |
| `auto` (default) | Applies everything this kernel supports where the permission set is fixed; rules it can't express stay Deno-only and are reported. In the preview it applies nothing and records what it would apply. |
| `enforce`        | Applies the policy. A rule the kernel would hold more loosely than Deno (a `fail-open` gap) is a startup error; a rule it holds more coarsely runs, with a `documented` gap in the report.            |
| `broker`         | `enforce` plus the Mode B supervisor, even when Mode A would be enough. Not built yet: refuses to start.                                                                                              |

`DENO_KERNEL_SANDBOX` is the emergency switch that needs no command edit. It's read from the real
environment before any `--env-file`, so a `.env` file can't lower the mode. Compiled programs,
packaged desktop apps among them, ignore it, because their mode is the author's choice. No setting
can widen a sandbox you're already inside: `off` in a confined process means "don't add another
layer", never "escape".

The full reference, with the context rules, the report and the `deno info --json` shape, is on
[Modes and configuration](/docs/kernel-sandbox-modes).

## Every kernel denext runs on today keeps working

The kernel layer is added on top. It never removes a platform. On an older kernel the backstop
covers less, and denext tells you exactly what it didn't cover.

On Linux, what Landlock can enforce depends on the kernel's **Landlock ABI**, a version number
for the interface. Each new ABI adds rights, and a kernel supports every ABI up to its own. Deno
asks the kernel which ABI it has and uses everything available.

| Kernel                                   | Landlock ABI | What the kernel enforces                                                                                                                                             |
| ---------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| older than 5.13, or Landlock not enabled | none         | No kernel file confinement. seccomp still blocks the dangerous calls, and blocks network and program execution when they aren't granted. Deno's own checks as today. |
| 5.13 – 5.18                              | 1            | File read, write and execute scopes. Moving or linking a file between two separate write folders is refused, and the report says so.                                 |
| 5.19 – 6.1                               | 2            | Adds moving and linking files across folders.                                                                                                                        |
| 6.2 – 6.6                                | 3            | Adds truncation.                                                                                                                                                     |
| 6.7 – 6.9                                | 4            | Adds TCP port rules for `connect` and `bind`.                                                                                                                        |
| 6.10 – 6.11                              | 5            | Adds device `ioctl` scoping.                                                                                                                                         |
| 6.12 – 6.14                              | 6            | Adds scoping for abstract Unix sockets and signals, so the sandbox can't signal processes outside it.                                                                |
| 6.15 and later                           | 7            | Adds kernel audit records of refusals, which `warn` mode and CI can read.                                                                                            |

Some distributions, for orientation: Ubuntu 22.04 ships 5.15 (ABI 1, so no cross-folder moves);
Debian 12 ships 6.1 (ABI 2); RHEL 9 ships 5.14 (ABI 1 where Landlock is enabled in the kernel's
security-module list); Ubuntu 24.04 ships 6.8 (ABI 4). Hardware-enablement kernels are newer.
`deno info --json` reports what your machine has (`landlockAbi`, `capabilities`).

What that means in practice:

1. **Nothing breaks on an old kernel.** In `auto` and `warn` modes, Deno applies what the kernel
   supports. `--kernel-sandbox-report` lists each rule it couldn't hold.
2. **`enforce` fails loudly.** If the kernel would allow more than a rule you asked to enforce,
   Deno refuses to start and names the rule and the kernel feature it needs. A port list on a
   kernel before 6.7 (Landlock ABI 4) is one such rule.
3. **The supervisor evens things out (design).** Host-scoped network rules and "folder except X"
   rules are meant to go through Mode B, which works the same on every kernel. Landlock's port
   rules can't resolve host names and don't exist before 6.7, so they never carry a host-scoped
   grant on their own. Until Mode B is built, those rules refuse to start under `enforce` on
   Linux.
4. **Two gaps remain before 6.12.** On older kernels, confined code can still send signals to
   other processes of the same user, and abstract Unix sockets aren't scoped. Both are listed in
   the [guarantee matrix](/docs/kernel-sandbox-guarantees).

### Containers, WSL and macOS versions

- **Docker.** Docker's default seccomp profile allows the Landlock system calls and a nested seccomp
  filter, so enforcement works in a default container. Features that need a new user namespace
  (hiding denied paths by mounting over them, Chrome's own sandbox) don't, and Deno falls back.
  Landlock and seccomp stack with a container's own confinement and with a systemd unit's
  `NoNewPrivileges=` and `ProtectSystem=`. Details on the
  [Linux](/docs/kernel-sandbox-linux#containers) page.
- **gVisor and some Firecracker setups** don't offer Landlock, so the "older than 5.13" row
  applies there.
- **WSL2** depends on how its kernel was configured, and hasn't been verified yet. `deno info --json`
  says whether Landlock is present (`landlockAbi`).
- **macOS.** Seatbelt works on every macOS version denext supports. Apple has marked the
  programmatic sandbox interface deprecated for years, but it's still present and working, and
  browsers, build tools and package managers rely on it. denext calls it at run time rather
  than linking against it, falls back to `/usr/bin/sandbox-exec` if the call is missing, and a
  CI canary watches every new macOS beta. If neither is available, `auto` reports it and
  `enforce` refuses to start.
- **Already sandboxed.** A process that is already inside another sandbox (App Sandbox, an
  agent's sandbox, the lifecycle jail) is detected by measuring, not by trusting an environment
  variable. On macOS, `enforce` inside another Seatbelt profile refuses to start. Whatever the
  outer sandbox refuses stays refused: a sandbox can only narrow.

## Subprocesses inherit the sandbox

This is the point of the design. Landlock domains, seccomp filters and Seatbelt profiles all
carry across `fork` and `exec`. A program started under `--allow-run`, and everything _it_
starts, lives inside the grant.

- **No per-child widening, ever.** A helper that started unconfined children on request would be
  exactly the escape the sandbox closes. If `git` needs `~/.gitconfig`, grant it
  (`--allow-read=~/.gitconfig`).
- **Programs need system files.** When `run` is granted, the implicit set adds read access to the
  system folders ordinary programs need to start (`/usr`, `/bin`, `/lib*`, `/etc` minus the
  credential files, and the system and developer-tool paths on macOS). Your project's
  credentials and the home directory aren't part of it.
- **A nested `deno`** inside a confined tree is held by the inherited policy. Today it sees the
  kernel's raw `EPERM` / `EACCES` for what the policy refuses. (Design: a nested `deno` will
  intersect its own flags with the inherited policy and report `NotCapable` instead.)
- **When a child fails** under the sandbox, Deno prints one hint per run naming the kernel sandbox
  and `--kernel-sandbox-report`.
- **`--allow-run=git,node` limits which programs Deno starts, not what those programs start.**
  Restricting every descendant to the list would break `git` (it runs `ssh` and its helpers),
  compilers and shells. With a program list, files and network stay confined for the whole tree,
  but native code can execute any program it can read. With no `--allow-run` at all, nothing in
  the process can start a program, FFI included. A stricter opt-in mode that limits execution for
  the whole tree is planned.

## What changes for programs

Inside the sandbox, a program that relied on running with more than its flags said will see
errors where it used to succeed. That's the hole being closed, but it shows up as failures, so
here is what to expect:

- **setuid helpers don't elevate.** On Linux the sandbox sets `no_new_privs`, and on macOS
  Seatbelt has the same effect, so `sudo`, `su`, old setuid `ping`, `newuidmap` (rootless Podman
  and Docker) and `fusermount` fail inside it. This is intended.
- **Headless Chrome needs `--no-sandbox`**, exactly as it does inside Docker, because creating
  its own user-namespace sandbox is refused. The same applies to Puppeteer, Playwright and
  bubblewrap.
- **Debuggers don't attach.** `ptrace` is refused, so `strace` and `gdb` don't work inside.
- **macOS returns `EPERM`, not `EACCES`.** Most POSIX programs expect `EACCES` for a file they
  can't read and fall back gracefully. Some (git with an unreadable config, for one) treat
  `EPERM` differently. The [troubleshooting](/docs/kernel-sandbox-troubleshooting) page collects
  known cases.
- **Unix sockets need a grant.** `/var/run/docker.sock`, `ssh-agent` (`$SSH_AUTH_SOCK`), the
  session bus and other local daemons are refused unless the grant names them (on Linux,
  `--allow-net=unix:<path>`). A grant to the
  Docker socket is effectively root on most hosts, and the
  [Permissions](/docs/permissions) page already warns about it.
- **Remote imports are fetched before the sandbox starts.** `deno run` builds and caches the
  module graph first, then confines itself. A dynamic `import()` of a remote module that wasn't
  cached fails: on Linux with the usual "not found in cache" error (the confined process reads
  remote modules from the cache only), and on macOS because `DENO_DIR` is read-only inside the
  sandbox. Run `deno cache` on the module first. Compiled binaries and desktop apps have no remote
  imports, so they're unaffected.
- **Shared caches aren't a way up.** A confined run doesn't write the shared caches (compiled
  code, dependency analysis) that a later, less-confined run would trust. Otherwise confined code
  could plant code that runs with more permission next time.
- **A refusal says where it came from.** When a Deno operation fails because the kernel refused
  it, the error ends with "(refused by the kernel sandbox; see --kernel-sandbox-report)", so an
  implicit-set gap doesn't look like a Deno bug.
- **Environment variables are scrubbed on Linux.** Under `enforce`, without an unscoped
  `--allow-env`, the process and its children keep only the `--allow-env` names and a short
  runtime list ([above](#what-enforce-does-today)).
- **chmod and utime by path fail on Linux**, inside the write scope too: `cp -p`, `tar`, and git
  setting an executable bit.

## What stays outside the kernel layer

These are the honest limits. Each one is also a row in the
[guarantee matrix](/docs/kernel-sandbox-guarantees), and a limit listed there is a documented
gap, not a vulnerability.

- **Environment variables.** They live in the process's own memory, and native code can read
  them directly. On macOS, and on Linux outside `enforce`, `--allow-env` stays a Deno check
  (`--clean-run-env` controls what children inherit). On Linux under `enforce` the environment is
  scrubbed to the `--allow-env` names plus a short runtime list before the program starts, so
  what's left is what the grant names.
- **`sys` information.** The kernel can narrow some of it (load average, memory, network
  interfaces), but host name, user id and similar calls can't be refused without breaking libc.
  On Linux, `/proc/self`, `/proc/thread-self`, `/proc/cpuinfo`, `/proc/stat` and the cgroup limit
  files stay readable to native code whatever `--allow-sys` grants, because the runtime sizes
  itself from them. Under `enforce`, other processes' `/proc` entries stay unreadable even with
  `--allow-sys=processes`, because the kernel can't scope them (a `fail-closed` gap). The Linux
  `/proc` and `/sys` permission classes themselves ([Permissions](/docs/permissions#linux-proc-and-sys-files))
  are part of Deno's checks on every Linux run, not of the kernel sandbox.
- **Library loading under a scoped `--allow-ffi`.** On Linux and macOS, native code may load any
  library it can read: the read scope bounds it, the `--allow-ffi` list doesn't. A `documented`
  gap.
- **Port grants hold the port, not the host or address.** A macOS `host:port` grant lets native
  code reach any host on that port, and a port list of IP addresses or `localhost` lets it reach
  any address on those ports, `169.254.169.254` included. Both are `documented` gaps.
- **Workers and `Deno.permissions.revoke()`.** The kernel policy is per process and equals the
  top-level grant. A worker's narrower `permissions` and a run-time `revoke()` stay API-level.
  For a kernel boundary between components, run the component as a subprocess with narrower
  flags: it gets its own, narrower sandbox.
- **Windows reads and network.** On Windows, the kernel layer contains children and limits
  writes. Reads and network stay Deno-only. See [Windows](/docs/kernel-sandbox-windows).
- **Host names without the supervisor.** No kernel can filter by host name. Kernels can filter
  by port at most, so host-scoped grants need Mode B. Without it, a host-scoped rule is
  Deno-only and the report says so; on Linux `enforce` refuses to start over it, and on macOS it
  runs held by port.
- **Signals and abstract Unix sockets before Linux 6.12**, as above.
- **Changing file attributes on Linux.** Landlock doesn't restrict changing a file's mode,
  timestamps or extended attributes. Under `enforce`, seccomp refuses the path forms of those calls
  everywhere, inside the write scope too. The descriptor forms (`fchmod` and the like) still work
  on any file the process can open, which includes files in the read scope. macOS holds this in
  the kernel.
- **File metadata on macOS.** Path resolution needs to look up every parent folder, so the
  profile allows reading file metadata everywhere. That reveals whether a file exists and how
  big it is, not what it contains. Linux's Landlock doesn't control metadata reads either.
- **Name lookups on macOS in Mode A.** When network is allowed, any confined code can resolve any
  name through the system resolver, and a lookup can carry data out. Mode B moves name
  resolution into the supervisor.
- **A write grant to something that is executed later is still code execution.** If the grant
  lets the program write `deno.json`, `node_modules`, `.git/hooks` or a shell startup file, the
  _next_ run, outside this sandbox, executes what was written. The sandbox doesn't change that
  [footgun](/docs/permissions#write-access-to-config-files-is-code-execution). Scope writes to
  data folders.
- **Existing hard links.** A hard link to a protected file that already exists inside an allowed
  folder can be read through that folder, as with any path-based rule. Creating new links or
  renames that would gain rights is refused.
- **Desktop apps.** A browser engine limits what a packaged app gets. From the first experiments:
  WKWebView apps on macOS and WebKitGTK apps on Linux are confined in-process (though WKWebView's
  own processes sit outside the app's sandbox, and the Linux session bus is a gap); CEF apps are
  confined on Linux where user namespaces are allowed and get headless guarantees only on macOS;
  Windows desktop apps get the job object's containment. Compiled command-line apps get the full
  matrix everywhere. See [Desktop and compiled apps](/docs/kernel-sandbox-desktop-and-compiled).

## How it's proven

A sandbox claim is only as good as the tests behind it. Three things back this one:

- **An escape-test corpus.** 46 probes, each tried the four ways native code reaches the operating
  system (FFI, a Node-API addon, an addon inside an npm package, and an `--allow-run` child): 184
  checks across 27 cells of the matrix. The probes try each way out: opening, renaming, linking and
  changing files outside the grant, starting programs, opening sockets of each family, connecting by
  address, `io_uring`, `ptrace`, `/proc/<pid>/mem`, Unix sockets by path and abstract name, signals,
  mounts, user namespaces, the session bus, and on macOS LaunchServices and AppleEvents. It prints
  one line per attempt.
- **A kernel matrix.** The corpus runs on arm64 Linux virtual machines booting 5.15, 6.1, 6.8,
  6.12 and 7.3; on x86_64 Linux 6.8, both directly and inside Docker's default profile; and on
  macOS, arm64 and x86_64. A run with Landlock compiled in but turned off is planned. Each kernel
  has its expected results.
- **A published guarantee matrix.** A [draft](/docs/kernel-sandbox-guarantees) is up now.
  Platform × kernel × mode, each cell saying whether a permission is enforced by the kernel, by
  the kernel more coarsely (and how), or by Deno only. It's generated from the same policy data
  `--kernel-sandbox-report` prints, published with the release, and it's the definition of a
  vulnerability: a way out of a cell marked "kernel" is a security bug, to be reported as the
  [threat model](/docs/kernel-sandbox-threat-model#reporting-a-sandbox-escape) describes.

## Seeing what applies

You don't have to guess:

- **`--kernel-sandbox-report`** prints the resolved mode and where it came from, the machine
  (platform, kernel, Landlock ABI), the compiled policy line by line (read, write, exec, native
  code loading, network, Unix sockets, `sys`, `env`, and the implicit set), and every gap, then runs
  the program. Each gap is `fail-open` (the kernel would allow more than Deno's rule, so `enforce`
  refuses to start), `fail-closed` (the kernel would refuse something Deno allows) or `documented`
  (a limit the sandbox never claims, or a rule held more coarsely, such as `env`, `sys`, a port
  list or a scoped `--allow-ffi`; `enforce` runs with it).
  [Example](/docs/kernel-sandbox-modes#--kernel-sandbox-report).
- **`deno info --json`** carries a `kernelSandbox` object: the mode asked for, its `source`, the
  `effective` mode after the context rules, what `auto` `wouldApply`, whether this runtime has an
  enforcer (`enforcerBuilt`), the mechanism (`osSandbox`), the Landlock ABI, and the machine's
  capabilities. Its `enforced` field is always `false` in this runtime, even for a project whose
  `deno.json` sets `enforce`: read `effective` and `enforcerBuilt` instead. A runtime without the
  sandbox leaves the object out, so a tool can detect the feature by checking for it.
  [Field reference](/docs/kernel-sandbox-modes#deno-info---json--kernelsandbox).
- **`denext doctor`** (design: not built yet) will check the machine (Landlock ABI and whether
  it's enabled, seccomp, user namespaces, container or gVisor, Seatbelt availability, an outer
  sandbox) and list every gap for the project's own `start` grant, plus known npm packages that
  need extra grants. Until then, `deno info --json` and the report cover the machine.

Nothing is sent anywhere. The report and `deno info --json` (and later `denext doctor`) are the
whole interface.

## In this section

- [Modes and configuration](/docs/kernel-sandbox-modes): the flag, the `deno.json` key,
  `deno compile`, the report and `deno info --json`.
- [Guarantee matrix](/docs/kernel-sandbox-guarantees): what each platform, kernel and mode
  enforces.
- [Linux](/docs/kernel-sandbox-linux): Landlock, seccomp, ABI by ABI.
- [macOS](/docs/kernel-sandbox-macos): Seatbelt profiles.
- [Windows](/docs/kernel-sandbox-windows): job objects and integrity levels, and what stays
  Deno-only.
- [Desktop and compiled apps](/docs/kernel-sandbox-desktop-and-compiled): baked modes,
  `desktop.permissions: "strict"` and browser engines.
- [Troubleshooting](/docs/kernel-sandbox-troubleshooting): symptoms, causes and fixes.
- [Threat model](/docs/kernel-sandbox-threat-model): the attacker, the boundary, and how to
  report an escape.
