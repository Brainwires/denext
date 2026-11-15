---
title: Kernel sandbox on Linux
slug: kernel-sandbox-linux
lead: How the kernel sandbox holds a grant on Linux. Landlock for files and TCP ports, seccomp for system calls, and the supervisor for rules neither can express. What each Landlock ABI adds, and what changes in containers and on WSL.
---

> [!IMPORTANT]
> **In development. This lands in denext 4.20.** This page is an outline, filled in as the Linux
> enforcement lands in denext's Deno fork. The [overview](/docs/kernel-sandbox#every-kernel-denext-runs-on-today-keeps-working)
> has the per-kernel table.

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

_Being written as this lands._ The operations the kernel documentation lists as not restricted
by Landlock (changing a file's mode, owner, times or extended attributes, among others) and how
the sandbox treats each, per mode.

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

## Containers, systemd, WSL and gVisor

_Being written as this lands._ Results of running the sandbox inside Docker's default seccomp
profile, inside Podman, as root in a container, under a systemd unit with `NoNewPrivileges=`, on
WSL2's kernel, and on gVisor and Firecracker (no Landlock). How `denext doctor` detects each.

## Checking a machine

_Being written as this lands._ Reading the Landlock ABI and the security-module list, what
`/proc/<pid>/status` shows for a confined process (`NoNewPrivs`, `Seccomp`), and reading kernel
audit records of refusals on 6.15 and later.
