---
title: Kernel sandbox on Windows
slug: kernel-sandbox-windows
lead: What the kernel sandbox holds on Windows, and what it doesn't. A job object contains children and a lowered integrity level limits writes, but reads and network stay enforced by Deno only. The reasons, and what comes later.
---

> [!IMPORTANT]
> **An opt-in preview ships in denext 4.20; the full sandbox, with automatic enforcement, lands
> in denext 5.0.** **Status:** a program built with `deno compile --kernel-sandbox=enforce` applies
> the small tier below at startup. `deno run --kernel-sandbox=enforce` still refuses to start on
> Windows (see [What isn't covered yet](/docs/kernel-sandbox-windows#what-isnt-covered-yet)), and the handle-returning file
> checks are not wired in yet. The [overview](/docs/kernel-sandbox) has the design.

## What Windows gets

Windows gets the **small tier**: what a process can apply to itself, in place, without
administrator rights and without being relaunched.

- **Children are contained.** The program puts itself in a job object. Processes it starts can't
  leave the job (a child that asks to break away isn't started), and every process still in the job
  ends when the program ends. With no `--allow-run` the job's process limit is 1: Windows refuses
  to start any program, for native code too.
- **Writes are limited.** When the grant has a write scope (anything but an unscoped
  `--allow-write`), the program lowers its own integrity level to Low. Windows then refuses writes
  to everything labelled Medium or higher, which is everything your user owns unless it was
  labelled Low. The granted write folders get that label first.
- **Reads and network stay Deno-only on Windows.** The
  [guarantee matrix](/docs/kernel-sandbox-guarantees) says so cell by cell, and
  `deno compile --kernel-sandbox=enforce` builds such a program without complaint: these two are
  documented limits, not rules the program refuses to start over.

```sh
deno compile --kernel-sandbox=enforce --allow-read --allow-write=.\out -o app.exe main.ts
.\app.exe   # native code and children can write only .\out; no program can be started
```

## Why reads and network aren't kernel-held yet

The Windows tools that confine reads and network (restricted tokens, AppContainer) can only be set
when a process is created, can't take a dynamic list of paths without editing the access-control
lists on your files, or stop native code from opening even the granted paths. Doing it properly
means splitting the program into a confined child and a broker that performs every file and
network operation for it. That design is planned for a later release.

## What the integrity label changes

Lowering the integrity level is a blunt tool, and it has side effects worth knowing before you
ship a program with it:

- **Labelling a write folder Low is a persistent change to that folder.** The label is inherited
  by everything in it, stays after the program exits (another instance may be running), and makes
  the folder writable to every other Low-integrity program of your user. `icacls <folder>` shows it
  (`Mandatory Label\Low Mandatory Level`), and `icacls <folder> /setintegritylevel (OI)(CI)M` puts
  the default back.
- **Some folders are never labelled.** A write grant on a drive root, your profile folder (or a
  folder that holds it), the Windows folder or a system-wide program folder would hand all of it to
  every Low-integrity program, so the program refuses to start, naming the grant. Grant the folder
  the program really writes.
- **A granted folder must exist when the program starts.** One that doesn't exist yet can't be
  labelled, and the program can't create it inside a parent it may not write.
- **Everything else your user owns becomes read-only to the program and its children**: the temp
  folder (`Deno.makeTempFile` needs a write grant on it, as on the other platforms), `HKCU` in the
  registry, `DENO_DIR`. The program's own cache folder
  (`%TEMP%\deno-compile-<name>.sandboxed\<policy>`) is labelled like a write grant.
- **Folders that were already labelled Low stay writable** (`%USERPROFILE%\AppData\LocalLow`):
  the level decides, not the grant list. Deno's own checks still refuse them.
- **Files opened before the level drops keep their access.** The program lowers the level first
  thing, before it opens anything of its own; a handle its parent passed in (redirected output)
  keeps working.
- **The tree ends with the program.** A child meant to outlive the program (a detached helper) is
  ended by the job when the program exits.

## What isn't covered yet

- **`deno run --kernel-sandbox=enforce` on Windows refuses to start.** `deno run` has fetched
  modules and opened its caches by the time it could lower its level, and Windows has no `exec` to
  start over in the same process. Compile the program, or use `warn`.
- **Nested `deno` processes don't get the parent's grant handed down** as they do on Linux and
  macOS; they run with their own permissions, inside the job and at the lowered level.
- **Checks that hand back handles.** Deno's own file operations will open the checked file and use
  that handle, so a link swapped between the check and the open can't redirect them. That lands
  with the race-safe file checks.

## Desktop apps on Windows

_Being written as this lands._ A packaged desktop app hosts WebView2 or CEF, which must start
their own helper processes and can't run from a Low-integrity, child-limited process. Desktop
apps on Windows get the job object's containment only at first. See
[Desktop and compiled apps](/docs/kernel-sandbox-desktop-and-compiled).

## Checking a machine

_Being written as this lands._ What `--kernel-sandbox-report`, `deno info --json` and
`denext doctor` show on Windows.
