---
title: Kernel sandbox on Linux
slug: kernel-sandbox-linux
lead: How the kernel sandbox holds a grant on Linux. Landlock for files and TCP ports, seccomp for system calls, and the supervisor for rules neither can express. What each Landlock ABI adds, and what changes in containers and on WSL.
---

> [!IMPORTANT]
> **An opt-in preview ships in denext 4.20; the full sandbox, with automatic enforcement, lands
> in denext 5.0.** This page is an outline, filled in as the Linux enforcement
> lands in denext's Deno fork. The
> [overview](/docs/kernel-sandbox#every-kernel-denext-runs-on-today-keeps-working) has the
> per-kernel table.

## How a Linux process confines itself

_Being written as this lands._ How `deno run` resolves the grant and fetches the module graph,
then re-executes itself and applies `no_new_privs`, Landlock and seccomp while it has a single
thread, so every thread and child it ever has is inside the sandbox. The process ID stays the
same, so signals, supervisors and `$!` keep working. Compiled binaries and desktop apps know their
grant before any thread starts, so they confine themselves without the extra exec. Includes the
measured startup cost.

## Files: Landlock

_Being written as this lands._ How `--allow-read`, `--allow-write` and execution map to Landlock
rules, ABI by ABI, and how symlinks are handled (Landlock checks the real file, not the name).

### Deny rules inside an allowed folder

_Being written as this lands._ Landlock rights only add up down the tree, so "this folder except
`.env`" can't be written as one rule. How each case is handled: when it's enforced, when it's
reported as Deno-only (`auto`) or refused (`enforce`), and how Mode B makes it exact.

### What Landlock doesn't cover

The kernel documentation lists operations Landlock doesn't restrict. The one that matters most
here: changing a file's mode, timestamps or extended attributes. seccomp can't help, because it
sees only that `chmod` was called, not which file it names. So with any write grant, native code
can change those attributes on files the user owns outside the grant; it still can't read them or
change their contents. The [guarantee matrix](/docs/kernel-sandbox-guarantees) marks this
Deno-only on Linux.

_Being written as this lands:_ the rest of the list, and whether `enforce` refuses the path-based
forms of these calls.

## System calls: seccomp

_Being written as this lands._ The list of refused calls and why each is refused (`ptrace`,
`process_vm_*`, `bpf`, `perf_event_open`, `userfaultfd`, the keyring calls, the mount family, new
user namespaces, `kexec`, module loading, `io_uring`, terminal injection `ioctl`s, the 32-bit
compatibility interfaces), based on Docker's default profile. Refused calls return an error (never
kill the process), so they surface as catchable errors in JavaScript.

## Network

_Being written as this lands._ No network: sockets refused by seccomp. All network: allowed. A
port list of IP addresses or `localhost` on ABI 4 and later: Landlock port rules. Host names: Mode
B, where the supervisor resolves the name, checks it, connects and passes the socket back. Includes
how private and loopback addresses are handled when a granted name resolves to one.

## Unix sockets and signals

_Being written as this lands._ Why pathname Unix sockets need an explicit grant (or Mode B), what
ABI 6 adds for abstract sockets and signals, and what stays open before it.

## Subprocesses on Linux

_Being written as this lands._ What children inherit, the system folders added when `run` is
granted, and what no longer works inside (setuid helpers, rootless containers, Chrome's own
sandbox, `strace`).

## Containers

Docker's default seccomp profile allows the Landlock system calls and a nested seccomp filter, so
**enforcement works in a default Docker container**. Landlock and seccomp stack with the
container's own confinement, and with a systemd unit's `NoNewPrivileges=` and `ProtectSystem=`.

What doesn't work in a default container is anything that needs a new **user namespace**, because
the default profile refuses to create one:

- hiding denied paths by mounting over them, the exact method for a read deny inside a read allow
  (Deno falls back, as below);
- Chrome's own namespace sandbox (run headless Chrome with `--no-sandbox`, as you already do in
  Docker).

The same applies on distributions that restrict unprivileged user namespaces (Ubuntu 24.04 does
this through AppArmor by default). There the overmount method is unavailable and Deno falls back:
the deny is enforced where the kernel can express it exactly, reported as Deno-only in `auto`, and
refused in `enforce`.

gVisor and some Firecracker setups don't offer Landlock at all, so the "no Landlock" case applies:
seccomp only, and files Deno-only. WSL2 depends on how its kernel is built and **hasn't been
verified yet**. `denext doctor` will say what it finds on each.

## Check your own system

Until `deno info --json` and `denext doctor` report these directly, you can check by hand.

The kernel version:

```sh
uname -r
```

Whether Landlock is enabled (look for `landlock` in the list):

```sh
cat /sys/kernel/security/lsm
```

The Landlock ABI. This calls `landlock_create_ruleset` with the flag that asks for the version.
`444` is that system call's number on x86_64 (aarch64 uses the same number). It prints the ABI, or
`-1` when Landlock isn't available:

```sh
python3 -c 'import ctypes;l=ctypes.CDLL(None);print(l.syscall(444,None,0,1))'
```

Whether unprivileged user namespaces are restricted (an AppArmor restriction of `1`, or a
`max_user_namespaces` of `0`, means the overmount method is unavailable):

```sh
sysctl kernel.apparmor_restrict_unprivileged_userns user.max_user_namespaces
```

For a confined process, `/proc/<pid>/status` shows `NoNewPrivs: 1` and a non-zero `Seccomp:` line.

_Being written as this lands:_ reading kernel audit records of refusals on 6.15 and later.
