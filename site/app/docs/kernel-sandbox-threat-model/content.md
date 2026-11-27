---
title: Kernel sandbox threat model
slug: kernel-sandbox-threat-model
lead: What the kernel sandbox defends against, what it doesn't, and where the boundary is. The attacker it assumes, what it protects, what is out of scope, and how to report a way out of it.
---

> [!IMPORTANT]
> **An opt-in preview ships in denext 4.x; automatic enforcement lands in denext 5.0.** **Draft,
> being validated.** This threat model is checked against the escape-test corpus alongside the
> [guarantee matrix](/docs/kernel-sandbox-guarantees), and is finished before the release. Today
> the kernel holds the matrix only in a run started with `--kernel-sandbox=enforce` (or `broker`)
> on Linux or macOS and in a program compiled with it, and the `documented` gaps that run lists
> (port lists of addresses held by port, library loading bounded by the read scope) are part of the
> boundary described here. The [overview](/docs/kernel-sandbox) has the design.

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
  comes from calls libc needs. (On Linux and macOS under `enforce` the environment is scrubbed to the
  `--allow-env` names and a short runtime list before the program starts, and `/proc/self`,
  `/proc/cpuinfo`, `/proc/stat` and the cgroup limit files stay readable.)
- **The `documented` gaps of an `enforce` run.** In Mode A a port list of IP addresses or
  `localhost` reaches any address on those ports; a scoped
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

Mode B's supervisor (Linux and macOS) stays outside the sandbox, so it is kept small and strict:

- **Nothing of the program runs in it.** It has one thread, no JavaScript engine, and loads no
  module or configuration. It can't be attached to by a debugger (not dumpable on Linux,
  `PT_DENY_ATTACH` on macOS).
- **It decides, the confined side only asks.** It holds the run's own compiled grant (never the
  runtime's implicit set), and the confined image checks that the policy the supervisor holds is
  the one it compiles itself. Native code can write any bytes to the channel, so every request is
  untrusted, and is decided against that grant alone (network requests by the same permission
  code Deno's own checks use, with prompting off).
- **Files.** It resolves every path itself, opens it beneath an allowed root and outside every
  deny, decides on the object it opened, and hands back only that descriptor. It hands out only
  regular files, folders and FIFOs, and never resolves the confined side's `/proc`, `/sys` or
  `/dev` paths for it.
- **Network.** It resolves names itself, refuses an answer on this machine or its networks unless
  the grant names that address, and connects each socket to exactly the address it checked.
- **The channel.** Fixed-size frames with a bounded length, at most one descriptor per answer, no
  descriptor ever sent toward the supervisor, and no request that refers to another, so it keeps no
  state per requester. A malformed frame closes the channel.
- **Children.** A `deno` started by the program gets a channel of its own only where it accepted
  the kernel-verified policy of a confined ancestor, and the supervisor answers it against the one
  policy it holds: the child gets no more than native code in its parent could already ask for.

A policy passed from a parent can only narrow a child: a nested `deno` intersects its own grant
with every layer it inherited.

## Time-of-check races

Checking a path and then opening it by name could be raced (the documented limit on
[Permissions](/docs/permissions#symlinks-and-allow-scopes)). Mode B's supervisor closes it for the
rules it holds by handing back the file it opened and checked, never a yes/no. Rules the kernel
enforces itself are checked by the kernel on every access, so a race doesn't reach past them.
_Being written as this lands:_ the race-safe opens Deno's own file operations use on Linux and
macOS. Outside the kernel sandbox, an external permission broker that speaks
[protocol v2](/docs/permissions#the-external-permission-broker) already hands back the opened file
on Unix.

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
