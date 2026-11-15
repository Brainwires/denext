---
title: Kernel sandbox threat model
slug: kernel-sandbox-threat-model
lead: What the kernel sandbox defends against, what it doesn't, and where the boundary is. The attacker it assumes, what it protects, what is out of scope, and how to report a way out of it.
---

> [!IMPORTANT]
> **In development. An opt-in preview lands in denext 4.20; the full sandbox, with automatic
> enforcement, lands in denext 5.0.** This page is an outline, finished before the release
> together with the [guarantee matrix](/docs/kernel-sandbox-guarantees). The
> [overview](/docs/kernel-sandbox) has the design.

## The attacker

_Being written as this lands._ The sandbox assumes hostile code running as your user, inside a
program whose grant is fixed: native code loaded through FFI, a Node-API addon, native code in an
npm package, or a program started under `--allow-run`, or any of their descendants. That code can
make any system call, write any bytes to any socket or pipe it holds, and try to race the runtime.

## What it protects

_Being written as this lands._ Files outside the read and write grant, network destinations
outside the net grant, the ability to start programs when `run` isn't granted, other processes of
the same user (signals and debugging, where the kernel supports it), and the kernel's own attack
surface (the refused system calls).

## What is out of scope

_Being written as this lands._ Stated plainly: environment variables and most `sys` information
(in the process's memory); worker-level and `revoke()` narrowing (API-level by design); runs where
a prompt could widen the grant; code running as root or with capabilities the sandbox doesn't
drop; a compromised kernel or OS; side channels; and anything written to a file a later,
unconfined run executes. Platform residuals are listed per cell in the
[guarantee matrix](/docs/kernel-sandbox-guarantees).

## The supervisor's trust boundary

_Being written as this lands._ How Mode B's supervisor is kept small and strict: no JavaScript
engine, no user code, no configuration read after the split, the same compiled policy, one handle
per answer, a strict message format with size and rate limits, and the connection closed on any
malformed message. Why a policy passed from a parent can only narrow a child.

## Time-of-check races

_Being written as this lands._ Where checking a path and then opening it by name could be raced
(today's documented limit on [Permissions](/docs/permissions#symlinks-and-allow-scopes)), how
handing back the opened file instead of a yes/no closes it, and why it doesn't matter for rules the
kernel enforces itself.

## Reporting a sandbox escape

_Being written as this lands._ A way out of a cell the guarantee matrix marks **kernel**, beyond
what the cell states, is a security vulnerability. A documented gap is not. Report a suspected
escape privately, as the [security policy](/docs/policies#reporting-a-vulnerability) describes
(GitHub Security Advisories on the repository), never in a public issue. Include the platform,
kernel version and Landlock ABI (or macOS version), the mode, the grant, the
`--kernel-sandbox-report` output, and a minimal native probe. Each confirmed escape is fixed
privately, released with an advisory, and gets its own probe in the escape-test corpus. See also
[Security posture](/docs/security).
