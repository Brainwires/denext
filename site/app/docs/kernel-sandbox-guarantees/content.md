---
title: Kernel sandbox guarantee matrix
slug: kernel-sandbox-guarantees
lead: What the kernel sandbox promises, cell by cell. For each permission, platform, kernel and mode, whether the kernel enforces it exactly, enforces it more coarsely, or leaves it to Deno's own checks. This matrix is what decides whether a report counts as a vulnerability.
---

> [!IMPORTANT]
> **In development. An opt-in preview lands in denext 4.20; the full sandbox, with automatic
> enforcement, lands in denext 5.0.** The matrix is published with the release and generated from
> the same policy data `--kernel-sandbox-report` prints. Until it's generated, this page is an
> outline. The [overview](/docs/kernel-sandbox) lists the known limits in prose.

## How to read the matrix

_Being written as this lands._ Every cell holds one of three values:

- **kernel**: the operating system enforces the rule exactly, for native code and children too.
- **kernel (coarser: …)**: the operating system enforces a wider version of the rule (for
  example, ports rather than hosts), and the cell says how much wider.
- **Deno only**: the rule holds for code that goes through Deno's functions, and nothing else.
  That's today's guardrail behaviour.

Rows are the permission kinds (`read`, `write`, `net` connect, `net` listen, `run`/exec, `ffi`,
`env`, `sys`, `import`) plus the cross-cutting items (signals, Unix sockets, file metadata, name
resolution). Columns are macOS, Linux by Landlock ABI (none, 1, 2–3, 4–5, 6+) and Windows, for
each of Mode A and Mode B.

## The matrix

_Being written as this lands._ The generated tables go here, one per mode.

## Known gaps, by platform

_Being written as this lands._ Each documented gap with the reason and the workaround, generated
from the same data. From the design, these include: environment variables and most `sys`
information (all platforms); Windows reads and network; signals and abstract Unix sockets before
Linux 6.12; file metadata (existence and size) on macOS and Linux; name lookups on macOS in Mode A;
host-scoped network without Mode B; worker-level and `revoke()` narrowing (API-level by design).

## What each cell is tested by

_Being written as this lands._ The probe in the escape-test corpus behind each cell, and the
kernel matrix (Linux 5.15, 6.1, 6.8 and 6.12 or newer on x86_64 and aarch64; every macOS version
the CI runners have; Windows) that runs it before each release.

## Vulnerability or documented gap?

_Being written as this lands._ A way out of a cell marked **kernel** or **kernel (coarser)**
beyond what the cell states is a security vulnerability. A gap listed here is not. How to report
one: [Threat model → Reporting a sandbox escape](/docs/kernel-sandbox-threat-model#reporting-a-sandbox-escape).
