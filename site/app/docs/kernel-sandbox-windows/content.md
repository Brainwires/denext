---
title: Kernel sandbox on Windows
slug: kernel-sandbox-windows
lead: What the kernel sandbox holds on Windows, and what it doesn't. A job object contains children and a lowered integrity level limits writes, but reads and network stay enforced by Deno only. The reasons, and what comes later.
---

> [!IMPORTANT]
> **In development. An opt-in preview lands in denext 4.20; the full sandbox, with automatic
> enforcement, lands in denext 5.0.** This page is an outline, filled in as the Windows part lands
> in denext's Deno fork. **Status:** the 4.20 preview covers Linux and macOS only; Windows comes
> with the full sandbox in denext 5.0. The [overview](/docs/kernel-sandbox) has the design.

## What Windows gets

_Being written as this lands._ The scope, stated plainly:

- **Children are contained.** The process puts itself in a job object: children can't leave the
  job, they end when the program ends, and when there's no `--allow-run` the job forbids starting
  programs at all.
- **Writes are limited.** When the grant has a write scope, the process lowers its own integrity
  level to Low, so it can write only to objects labelled Low. The granted write folders get that
  label.
- **Checks hand back handles.** Deno's own file operations open the checked file and use that
  handle, so a link swapped between the check and the open can't redirect them.
- **Reads and network stay Deno-only on Windows.** The guarantee matrix says so cell by cell.

## Why reads and network aren't kernel-held yet

_Being written as this lands._ The Windows tools that confine reads and network (restricted
tokens, AppContainer) can only be set when a process is created, can't take a dynamic list of
paths without editing the access-control lists on your files, or stop native code from opening
even the granted paths. Doing it properly means splitting the program into a confined child and
a broker that performs every file and network operation for it. That design is planned for a
later 4.x release.

## What the integrity label changes

_Being written as this lands._ Labelling a write folder Low is a persistent change to that folder.
What else becomes read-only to the confined process (the temp folder, `HKCU`, `DENO_DIR`), how the
label is applied and removed, and what that means for tools that share the folder.

## Desktop apps on Windows

_Being written as this lands._ A packaged desktop app hosts WebView2 or CEF, which must start
their own helper processes and can't run from a Low-integrity, child-limited process. Desktop
apps on Windows get the job object's containment only at first. See
[Desktop and compiled apps](/docs/kernel-sandbox-desktop-and-compiled).

## Checking a machine

_Being written as this lands._ What `--kernel-sandbox-report`, `deno info --json` and
`denext doctor` show on Windows.
