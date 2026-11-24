---
title: Kernel sandbox on Windows
slug: kernel-sandbox-windows
lead: What the kernel sandbox holds on Windows, and what it doesn't. A job object contains children and a lowered integrity level limits writes, but reads and network stay enforced by Deno only. The reasons, and what comes later.
---

> [!IMPORTANT]
> **An opt-in preview ships in denext 4.x; automatic enforcement lands in denext 5.0.**
> **Status:** a program compiled with `deno compile --kernel-sandbox=enforce` for Windows gets the
> small tier below. `deno run` on Windows has no enforcer (`enforcerBuilt: false`), so
> `--kernel-sandbox=enforce` and `broker` refuse to start there: by the time `deno run` could lower
> its integrity level it has already opened its caches, and it can't re-execute in place. The
> settings and the report work on Windows as on other systems. The
> [overview](/docs/kernel-sandbox) has the design.

## What Windows gets

A program compiled with `enforce` applies the small tier at the top of its startup:

- **Children are contained.** The process puts itself in a job object that children can't leave
  (a child created to break away is refused) and that ends the whole tree when the program ends.
  With no `--allow-run`, the job allows one active process, so starting any program fails, native
  code's attempts included. A process that can't be put in a job refuses to start.
- **Writes are limited.** With a scoped `--allow-write`, the process first labels each write folder
  Low (inherited by what's inside), then lowers its own integrity level to Low. Windows then
  refuses its writes to everything labelled Medium or higher. An unscoped `--allow-write` leaves the
  level alone.
- **Reads and network stay Deno-only on Windows.** The guarantee matrix says so cell by cell.

`broker` is refused for Windows programs: no supervisor runs there.

### Limits of the small tier

- Reads and the network aren't confined.
- A folder that is already labelled Low stays writable, wherever it is.
- A write folder that doesn't exist yet can't be created by the confined program: create it first.
- A nested `deno` started by the program gets no description of the policy, so its own checks
  don't intersect with it (the job and the integrity level still hold it).
- Deno's own file checks don't hand back the opened handle on Windows, so a link swapped between a
  check and an open isn't caught there.

## Why reads and network aren't kernel-held yet

The Windows tools that confine reads and network (restricted tokens, AppContainer) can only be set
when a process is created, can't take a dynamic list of paths without editing the access-control
lists on your files, or stop native code from opening even the granted paths. Doing it properly
means splitting the program into a confined child and a broker that performs every file and
network operation for it. _Being written as this lands._

## What the integrity label changes

Labelling a write folder Low is a persistent change to that folder: the label stays after the
program ends, and every Low-integrity process of the user may then write there. So the program
refuses to start, rather than label it, when a write grant names a drive root, the profile folder
or a folder that holds it, the Windows folder or a system-wide program folder. A folder already
labelled Low is left as it is. Grant narrow data folders. _Being written as this lands:_ what else
becomes read-only to the confined process (the temp folder, `HKCU`, `DENO_DIR`) and how to remove
a label.

## Desktop apps on Windows

A packaged desktop app hosts WebView2 or CEF, which must start their own helper processes and
can't run from a Low-integrity, child-limited process. Desktop apps on Windows have no kernel layer
(`platformFeatures().kernelSandbox` is `"none"`). See
[Desktop and compiled apps](/docs/kernel-sandbox-desktop-and-compiled).

## Checking a machine

_Being written as this lands._ What `--kernel-sandbox-report`, `deno info --json` and
`denext doctor` show on Windows.
