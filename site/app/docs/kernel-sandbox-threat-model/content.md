---
title: Kernel sandbox threat model
slug: kernel-sandbox-threat-model
lead: What the kernel sandbox defends against, what it doesn't, and where the boundary is. The attacker it assumes, what it protects, what is out of scope, and how to report a way out of it.
---

> [!IMPORTANT]
> **An opt-in preview ships in denext 4.20; the full sandbox, with automatic enforcement, lands
> in denext 5.0.** **Draft, being validated.** This threat model is checked
> against the escape-test corpus alongside the [guarantee matrix](/docs/kernel-sandbox-guarantees),
> and is finished before the release. Today the kernel holds the matrix only in a `deno run` or
> `deno serve` started with `--kernel-sandbox=enforce` on Linux or macOS, and the `documented` gaps
> that run lists (port grants held by port, library loading bounded by the read scope) are part of
> the boundary described here. The [overview](/docs/kernel-sandbox) has the design.

## The attacker

The kernel sandbox assumes **native code running as your user, inside a run whose permissions are
fixed**:

- a library loaded through FFI (`Deno.dlopen`);
- a Node-API addon;
- native code in an npm package;
- a program started under `--allow-run`, and every process it starts.

That code can make any system call, write any bytes to any socket or pipe it holds, and try to win
races against the runtime. It isn't assumed to have root, extra capabilities, or a way to change
the run's flags before it starts.

## What it protects

Within the cells the [guarantee matrix](/docs/kernel-sandbox-guarantees) marks **Kernel** or
**Kernel (coarser)** for your platform, kernel and mode:

- files outside the read and write grant;
- network destinations outside the net grant;
- starting programs when there is no `run` grant;
- other processes of the same user (reading their memory, and signalling them where the kernel
  supports it);
- the kernel's own attack surface, through the refused system calls.

## What is out of scope

- **Runs that can prompt, and `-A` runs.** A prompt can widen the grant, so there's no fixed policy
  to enforce. Plain `-A` has nothing to narrow.
- **`env` and `sys`.** Environment variables live in the process's memory, and system information
  comes from calls libc needs. (On Linux under `enforce` the environment is scrubbed to the
  `--allow-env` names and a short runtime list before the program starts, and `/proc/self`,
  `/proc/cpuinfo`, `/proc/stat` and the cgroup limit files stay readable.)
- **The `documented` gaps of an `enforce` run.** A macOS `host:port` grant reaches any host on the
  port; a port list of IP addresses or `localhost` reaches any address on those ports; a scoped
  `--allow-ffi` loads any library in the read scope; macOS's `sandbox-exec` fallback can start the
  runtime's own binary again, under the same profile.
- **Workers and `Deno.permissions.revoke()`.** The kernel policy is per process and equals the
  top-level grant. For a kernel boundary between components, run the component as a subprocess
  with narrower flags.
- **File descriptors opened before the sandbox.** Files and sockets the process held when it was
  confined stay usable. They're the launcher's, not the sandboxed code's.
- **Code a later, unconfined run executes.** If the grant lets the program write `deno.json`,
  `node_modules`, `.git/hooks` or a shell startup file, the next run outside the sandbox executes
  what was written. Keep write grants to data folders.
- **The kernel itself.** A kernel vulnerability is the kernel's to fix. The seccomp filter narrows
  the attack surface but doesn't defend against a compromised kernel.
- **Denial of service.** Confined code can still use CPU, memory and disk within its grant.
  [Resource limits](/docs/deployment-targets#resource-limits) are a separate, best-effort tool.

Platform gaps are listed cell by cell in the [guarantee matrix](/docs/kernel-sandbox-guarantees).

## The supervisor's trust boundary

_Design, being written as this lands (Mode B isn't built yet)._ How Mode B's supervisor is kept
small and strict: no JavaScript
engine, no user code, no configuration read after the split, the same compiled policy, one handle
per answer, a strict message format with size and rate limits, and the connection closed on any
malformed message. Why a policy passed from a parent can only narrow a child.

## Time-of-check races

_Being written as this lands._ Where checking a path and then opening it by name could be raced
(today's documented limit on [Permissions](/docs/permissions#symlinks-and-allow-scopes)), how
handing back the opened file instead of a yes/no closes it, and why it doesn't matter for rules the
kernel enforces itself. Outside the kernel sandbox, an external permission broker that speaks
[protocol v2](/docs/permissions#the-external-permission-broker) already hands back the opened file
on Unix.

Under `enforce` a swapped path only matters where Deno's rule is finer than the kernel's: for the
few paths the runtime itself needs readable without a grant. Some operations can't be handed an
opened file at all, because the thing that opens the file isn't Deno. They stay checked by path:

| Operation                                                                  | Why it takes a path                                                                 |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| SQLite databases (`node:sqlite`, `Deno.openKv`, SQLite through `Deno.SQL`) | SQLite opens the database and its `-wal`, `-shm` and journal files by name          |
| `Deno.watchFs`, `fs.watch`                                                 | The OS watch services take paths                                                    |
| `Deno.dlopen`, native addons                                               | The dynamic loader opens the library and its dependencies itself                    |
| `Deno.Command` (the program, `cwd`), `Deno.chdir`                          | `execve` and `chdir` take paths; a child's own opens are held by the kernel sandbox |
| Unix-socket paths                                                          | `connect` and `bind` on a Unix socket take a path                                   |
| `node:wasi` preopens                                                       | Resolved against the preopen's real location on every call                          |
| npm resolution (`package.json`, `node_modules`)                            | The resolver reads by path                                                          |
| Desktop: sharing and dragging files                                        | The paths go to the OS share and drag services                                      |

A hard link to a denied file, placed in an allowed folder, is the same file under an allowed
path: readable, as for Landlock and Seatbelt, which see paths too. Files read whole right after
the check (`Deno.connectTls({ certFile })`, `Deno.SQL` file reads) are checked a second time as the
file that actually opened, so a link swapped in between is refused.

## What counts as an escape

An escape means **breaking a Kernel cell on the platform, kernel and mode that cell names**: for
example, native code reading a file outside the read grant on Linux 6.8 with the sandbox on. Getting
past what a **Kernel (coarser)** cell still holds counts too. A gap the matrix already lists
(**Deno-only**, **By design**, or a note) is a documentation issue, not a vulnerability. If the docs
understate a gap, that's worth an ordinary issue.

## Reporting a sandbox escape

Report a suspected escape **privately**, through the repository's private vulnerability reporting
(GitHub Security Advisories), as the [security policy](/docs/policies#reporting-a-vulnerability)
describes. **Never open a public issue** for one. Include:

- the platform, and on Linux the output of `uname -r`;
- the Landlock ABI (see [Check your own system](/docs/kernel-sandbox-linux#check-your-own-system));
  on macOS, the output of `sw_vers`;
- the mode (`--kernel-sandbox=…` or the `deno.json` key) and the grant;
- a probe that reproduces it, ideally a small native library or program.

Each confirmed escape is fixed privately, released with an advisory, and gets its own probe in the
escape-test corpus. See also [Security posture](/docs/security).
