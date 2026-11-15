---
title: Kernel sandbox troubleshooting
slug: kernel-sandbox-troubleshooting
lead: Something that worked before fails under the kernel sandbox. How to tell whether the sandbox refused it, what the common symptoms mean, and the grant or setting that fixes each one.
---

> [!IMPORTANT]
> **In development. An opt-in preview lands in denext 4.20; the full sandbox, with automatic
> enforcement, lands in denext 5.0.** This page collects symptoms as the sandbox is tested against
> real programs, packages and CI setups. The [overview](/docs/kernel-sandbox) has the design.

## Was it the kernel sandbox?

_Being written as this lands._ The first-failure hint ("refused by the kernel sandbox; see
--kernel-sandbox-report"), the child-failure hint, the report, `denext doctor`, and the quick test:
rerun with `DENO_KERNEL_SANDBOX=warn` (CLI runs) and see whether the failure goes away. How to read
refusals from the macOS unified log and from Linux kernel audit records.

## Turning it down safely

_Being written as this lands._ In order of preference: grant what the program needs; use
`"kernelSandbox": "warn"` in `deno.json` while you work it out; use `DENO_KERNEL_SANDBOX=warn` or
`off` for one CLI run; compile with `--kernel-sandbox=off`. Why reaching for `-A` is worse than any
of them.

## Common symptoms

_Being written as this lands._ One entry per symptom: symptom → cause → fix. Planned entries
include:

- `git` fails: it can't read `~/.gitconfig`, `~/.ssh/known_hosts` or its credential helper socket.
- `npm` or a package install inside a run fails: `.npmrc` isn't granted (and shouldn't be, by
  default).
- A compiler fails writing its temp files.
- `sudo`, `ping` or another setuid helper fails.
- Headless Chrome, Puppeteer or Playwright fails to start without `--no-sandbox`.
- Docker or Podman commands fail: the Docker socket or rootless helpers.
- `ssh` can't reach the agent (`$SSH_AUTH_SOCK`).
- A dynamic remote `import()` fails: the module wasn't cached before the sandbox started.
- A native addon fails to load: it extracts itself to a folder that isn't granted.
- Moving files between two write folders fails on an older Linux kernel (Landlock ABI 1).
- A file written or replaced after start isn't readable on Linux under a read deny.
- A program run on a terminal no longer prompts (compiled binary).
- `strace` or `gdb` can't attach.
- `enforce` refuses to start, naming a rule the kernel can't express.
- Running inside a container, WSL or gVisor reports no Landlock.

## npm packages that need extra grants

_Being written as this lands._ Known packages and the grant each needs (prebuilt native addons
that extract to a cache folder, tools that download browsers or engines, packages that spawn their
own binaries), shared with `denext doctor`'s list.

## Reporting a compatibility problem

_Being written as this lands._ What to include (the report output, `deno info --json`, the
platform and kernel), and the difference between a compatibility problem (an issue) and an escape
(a private security report: see the
[threat model](/docs/kernel-sandbox-threat-model#reporting-a-sandbox-escape)).
