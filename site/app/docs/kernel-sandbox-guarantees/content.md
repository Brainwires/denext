---
title: Kernel sandbox guarantee matrix
slug: kernel-sandbox-guarantees
lead: What the kernel sandbox promises, cell by cell. For each permission, platform, kernel and mode, whether the kernel enforces it exactly, enforces it more coarsely, or leaves it to Deno's own checks. This matrix is what decides whether a report counts as a vulnerability.
---

> [!IMPORTANT]
> **An opt-in preview ships in denext 4.x; automatic enforcement lands in denext 5.0.** **Draft,
> being validated.** The matrix below comes from the
> design and the first runs of the escape-test corpus; cells can still change while the corpus is
> validated on every kernel. The final matrix is published with the release, generated from the
> same policy data `--kernel-sandbox-report` prints. Today the kernel holds these cells only in a
> run that asks for `--kernel-sandbox=enforce` (or `broker`) on Linux or macOS, and in a program
> compiled with it (the Windows column applies to compiled programs only); any other run is
> Deno-only throughout ([What `enforce` does today](/docs/kernel-sandbox#what-enforce-does-today)).

## How to read the matrix

The matrix covers **headless runs with fixed permissions**: a compiled binary, `denext start`, a
CI run with a fixed grant, or any run with the sandbox switched on. Desktop apps are covered on
[Desktop and compiled apps](/docs/kernel-sandbox-desktop-and-compiled). Each row is something
native code (FFI, a Node-API addon, native code in an npm package, or an `--allow-run` program and
its children) might try. Each cell says what stops it:

- **Kernel**: the operating system holds the rule, for native code and children too.
- **Kernel (coarser)**: the operating system holds the rule, but less precisely than Deno's own
  rule. The cell or the notes say how.
- **Deno-only**: Deno's own functions still check the rule, but native code isn't held to it.
  That's today's guardrail behaviour.
- **By design**: the sandbox deliberately doesn't restrict it, and the reason is given below.

The Linux columns follow the kernel version, because what Landlock can enforce depends on its ABI
(see the [kernel table](/docs/kernel-sandbox#every-kernel-denext-runs-on-today-keeps-working)). A
Linux kernel older than 5.13, or one with Landlock turned off, has no column: there, seccomp still
refuses networking and starting programs when they aren't granted, and refuses the dangerous
system calls, but files are Deno-only.

## The matrix (draft)

| Native code tries to…                                | macOS                        | Linux 5.13–5.18              | Linux 5.19–6.6               | Linux 6.7–6.11               | Linux 6.12+                  | Windows                                  |
| ---------------------------------------------------- | ---------------------------- | ---------------------------- | ---------------------------- | ---------------------------- | ---------------------------- | ---------------------------------------- |
| read outside the read grant                          | Kernel                       | Kernel                       | Kernel                       | Kernel                       | Kernel                       | Deno-only                                |
| write, create or remove outside the write grant      | Kernel                       | Kernel                       | Kernel                       | Kernel                       | Kernel                       | Kernel (coarser: labelled write folders) |
| change mode, times or xattrs outside the write grant | Kernel                       | Kernel (coarser: path forms) | Kernel (coarser: path forms) | Kernel (coarser: path forms) | Kernel (coarser: path forms) | Kernel (coarser)                         |
| use symlink tricks and races                         | Kernel                       | Kernel                       | Kernel                       | Kernel                       | Kernel                       | Deno-only                                |
| read another process (ptrace, memory)                | Kernel                       | Kernel                       | Kernel                       | Kernel                       | Kernel                       | Deno-only                                |
| signal another process                               | Kernel                       | Deno-only                    | Deno-only                    | Deno-only                    | Kernel                       | Kernel (coarser)                         |
| run programs with no run grant                       | Kernel                       | Kernel                       | Kernel                       | Kernel                       | Kernel                       | Kernel                                   |
| run unlisted programs with a run list                | By design                    | By design                    | By design                    | By design                    | By design                    | By design                                |
| use the network with no net grant                    | Kernel                       | Kernel                       | Kernel                       | Kernel                       | Kernel                       | Deno-only                                |
| connect to a port that isn't granted                 | Kernel                       | Kernel (Mode B)              | Kernel (Mode B)              | Kernel                       | Kernel                       | Deno-only                                |
| reach another host on a granted port                 | Kernel (Mode B)              | Kernel (Mode B)              | Kernel (Mode B)              | Kernel (Mode B)              | Kernel (Mode B)              | Deno-only                                |
| reach another address on a granted port              | Kernel (coarser)             | Kernel (Mode B)              | Kernel (Mode B)              | Kernel (coarser)             | Kernel (coarser)             | Deno-only                                |
| use Unix sockets                                     | Kernel                       | Kernel (Mode B)              | Kernel (Mode B)              | Kernel (Mode B)              | Kernel (Mode B)              | Deno-only                                |
| read environment variables                           | Kernel (coarser: scrubbed)   | Kernel (coarser: scrubbed)   | Kernel (coarser: scrubbed)   | Kernel (coarser: scrubbed)   | Kernel (coarser: scrubbed)   | Deno-only                                |
| read system information                              | Deno-only                    | Deno-only                    | Deno-only                    | Deno-only                    | Deno-only                    | Deno-only                                |
| load a library outside a scoped `--allow-ffi`        | Kernel (coarser: read scope) | Kernel (coarser: read scope) | Kernel (coarser: read scope) | Kernel (coarser: read scope) | Kernel (coarser: read scope) | Deno-only                                |

**Mode B makes the cells marked "Kernel (Mode B)" exact.** With the Mode B supervisor
([Mode B](/docs/kernel-sandbox#mode-a-and-mode-b)), host scoping, name resolution (DNS), Unix-socket
paths and write denies inside a write allow are exact on Linux and macOS: the supervisor checks
each request against Deno's own rule and hands back only the file or socket it checked. Under a
broker-held network, native code and children (other than `deno`) have no network socket at all,
which is what holds those cells for them. `--kernel-sandbox=broker` also makes the "another
address on a granted port" cells exact.

## Notes on the cells

- **Mode, times and extended attributes on Linux.** Landlock doesn't restrict changing a file's
  mode, timestamps or extended attributes, and seccomp can't see which file a call names. So under
  `enforce` seccomp refuses the path forms of these calls everywhere, inside the write scope too
  (`Deno.chmod`, `Deno.utime`, `cp -p`, `tar` and git's executable bit fail with `EPERM`). The
  descriptor forms still work, so native code can change these on any file it can open, files in
  the read scope included: Deno-only there. It can't read or change their contents outside the
  grant.
- **Signals before Linux 6.12.** Landlock gained signal scoping in ABI 6. On older kernels confined
  code can signal other processes of the same user.
- **Running unlisted programs with a run list (by design).** `--allow-run=git` limits which
  programs Deno starts. Limiting what those programs start would break `git`, compilers and shells,
  so with a run list, native code can execute any program it can read. Files and network stay
  confined for the whole tree. With no `--allow-run`, no program can start at all.
- **Ports on older Linux.** Landlock's TCP port rules arrive with Linux 6.7 (ABI 4). Before that,
  the kernel can allow all network or none, not a list of ports, so `enforce` holds a port list
  through Mode B there.
- **Another host on a granted port.** No kernel filters by host name, so `enforce` holds a grant of
  `example.com:443` through Mode B on Linux and macOS. The supervisor resolves the name and
  refuses an answer on this machine or its networks unless the grant names that address.
- **Another address on a granted port.** In Mode A a port list of IP addresses or `localhost` is
  held by port, on Linux (ABI 4 and later) and macOS: native code may reach any address on those
  ports, `169.254.169.254` (the cloud metadata address) included. A `documented` gap.
- **Libraries under a scoped `--allow-ffi`.** Neither Linux nor macOS can hold library loading to
  the `--allow-ffi` paths. Native code may load any library in the read scope. A `documented` gap.
- **Unix sockets.** The kernel refuses Unix sockets unless the grant calls for them. Linux can't
  tell one socket path from another, so a socket granted by path is connected by Mode B; abstract
  sockets are scoped only from 6.12.
- **Windows.** In a program compiled with `enforce`, the job object and a lowered integrity level
  contain children and limit writes to folders labelled for the purpose. Reads, network and other
  processes stay Deno-only. `deno run` on Windows has no kernel layer. See
  [Windows](/docs/kernel-sandbox-windows).
- **Environment variables.** They live in the process's memory, so no kernel can hold them. On
  Linux and macOS under `enforce` the process re-executes with its environment scrubbed to the `--allow-env`
  names plus a short runtime list (`PATH`, `HOME`, `TMPDIR`, `DENO_DIR`, `LANG`, `LC_*`, `TZ`, the
  proxy variables, `NO_COLOR`, `TERM`), and children inherit only that. An unscoped `--allow-env`
  keeps everything.
- **System information.** It comes from calls libc needs, so no platform's kernel can hold it. On
  Linux, `/proc/self`, `/proc/thread-self`, `/proc/cpuinfo`, `/proc/stat` and the cgroup limit
  files stay readable to native code whatever `--allow-sys` grants (the runtime sizes itself from
  them). Under `enforce`, `--allow-sys=processes` is `fail-closed`: other processes' `/proc` entries
  stay unreadable.
- **`.npmrc` under `enforce`.** It's never readable to the confined process, because it can hold
  registry tokens; it's treated as absent unless the grant names it.
- **Also outside every cell:** worker-level permissions and `Deno.permissions.revoke()` (the kernel
  policy is per process), file metadata reads (whether a file exists and its size), and files
  written for a later, unconfined run to execute. See the
  [threat model](/docs/kernel-sandbox-threat-model#what-is-out-of-scope).

## How it's tested

The matrix is checked by an **escape-test corpus**: 46 probes, each tried four ways native code
reaches the operating system:

1. through FFI (`Deno.dlopen`);
2. through a Node-API addon;
3. through an addon inside an npm package;
4. through an `--allow-run` child.

That's 184 checks across 27 matrix cells. Where it runs:

- **Linux on arm64:** lab virtual machines booting 5.15, 6.1, 6.8, 6.12 and 7.3.
- **Linux on x86_64:** 6.8 on the CI runners, both directly and inside a Docker container with
  Docker's default seccomp profile.
- **macOS:** arm64 and x86_64 on the CI runners.
- **Planned:** a Linux run with Landlock compiled into the kernel but turned off.

Each kernel has its expected results, and any difference from the matrix fails the run.

## Vulnerability or documented gap?

Breaking a **Kernel** cell, on the platform, kernel and mode that cell names, is a sandbox escape
and a security vulnerability. A **Kernel (coarser)** cell is broken only by getting past what the
coarser rule still holds. A gap the matrix lists (a **Deno-only** or **By design** cell, or a note
above) is a documentation matter, not a vulnerability. How to report an escape:
[Threat model → Reporting a sandbox escape](/docs/kernel-sandbox-threat-model#reporting-a-sandbox-escape).
