---
title: Preparing an app for kernel enforcement
slug: kernel-sandbox-migrating
lead: The upgrade guide for the kernel sandbox. Which of your commands become kernel-enforced and when, how to find what each would be refused before that happens, the grants to add, and the switches that turn enforcement down for a command that isn't ready.
---

> [!IMPORTANT]
> **Nothing on this page changes in denext 4.x.** There the kernel sandbox is opt-in, and with no
> setting nothing is applied. This guide is for the releases after it, where the sandbox switches
> on by itself in [two steps](/docs/kernel-sandbox-rollout#the-defaults). Everything here can be
> done today, and an app that follows it is unaffected when the defaults change.
> `denext kernel-sandbox` ships with the denext release that has this page; its `check` reports
> what native code and child processes do on a runtime with
> [warn mode's observer](/docs/kernel-sandbox-warn).

## Who is affected

The kernel sandbox holds **native code and child processes** to the grant your JavaScript already
runs under. A run is affected only if all three are true:

1. **Its permissions are fixed and partial.** It runs with some `--allow-*` flags, not `-A`, and no
   prompt can widen them: it has no terminal (CI, a service, a container, a pipe), or it uses
   `--no-prompt`, or it is a compiled program. A run with plain `-A` is never confined. A run on a
   terminal that can still prompt isn't either.
2. **It runs native code or other programs:** `--allow-run` (anything it spawns: `git`, a
   compiler, a browser, `npm`), `--allow-ffi`, or an npm package with a native addon.
3. **That code reaches outside the grant.** It reads a file, opens a socket or starts a program the
   flags don't cover. Until now nothing stopped it; that is the gap the sandbox closes.

Most `denext start` deployments are not affected: the server's default grant has no `--allow-run`
and no `--allow-ffi`, so there is no native code or child to hold. Check anyway; it takes a
minute.

### When each command changes

The sandbox switches on by itself in two steps. The first (stage `r3` in the runtime's own
reports) confines programs whose author fixed their permissions; the second (stage `r4`) also
confines scripts that run with no terminal.

| Your command                                                                                        | First step                                                                                         | Second step  |
| --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------ |
| A compiled program (`deno compile`, `denext build --compile`) with partial permissions              | **enforced**                                                                                       | enforced     |
| A packaged desktop app with `desktop.permissions: "strict"`                                         | **enforced**                                                                                       | enforced     |
| `denext start`, and the Docker image and systemd unit that run it                                   | **enforced**                                                                                       | enforced     |
| A command that says `--kernel-sandbox=auto`, or a project with `"kernelSandbox": "auto"`            | **enforced**                                                                                       | enforced     |
| A bare `deno run` / `deno serve` with partial permissions and no terminal (a CI script, a cron job) | warns ([one notice](/docs/kernel-sandbox-warn#the-warning-auto-prints-for-a-run-with-no-terminal)) | **enforced** |
| The same on a terminal, where it can prompt                                                         | unchanged                                                                                          | unchanged    |
| Anything with `-A` and no `--deny-*`                                                                | unchanged                                                                                          | unchanged    |
| `denext dev`, `--watch`, HMR, `deno test`, `deno bench`, the REPL                                   | unchanged                                                                                          | unchanged    |

"Enforced" by a default never means "refuses to start". Where the kernel can't hold a rule of the
grant on that machine, a default falls back to warn mode for that run and says why. Only an
`enforce` you write yourself refuses to start. The
[rollout page](/docs/kernel-sandbox-rollout) has the whole table and what has to be true before
each step ships.

## The five steps

### 1. See what this machine and this project would get

```sh
denext kernel-sandbox
```

It prints the kernel features this machine has, what the sandbox does for the project today, and a
**dry run** of the `start` task's grant: the policy the kernel would get, compiled without running
anything of the app. If a rule of the grant can't be held here, it says which
([doctor and dry run](/docs/kernel-sandbox-doctor)). `denext doctor` has the same result as one
line.

Run it where the app runs. The answer depends on the kernel: a laptop on macOS, a CI runner on
Linux 6.8 and a production host on Linux 5.15 each hold a different set of rules.

### 2. Find what would be refused

```sh
denext kernel-sandbox check
```

This runs the `start` task with the sandbox in **warn mode**: the app runs as it always does,
nothing is refused, and every access `enforce` would refuse is collected. Use the app while it
runs (load the pages, run the job that shells out, upload a file), then stop it with Ctrl-C. For a
command that isn't the `start` task, put it after `--`:

```sh
denext kernel-sandbox check -- deno run --allow-run --allow-read=. scripts/release.ts
denext kernel-sandbox check --task build
denext kernel-sandbox check --timeout 60        # stop a server after a minute
```

The result is sorted into what to do:

```text
  denext kernel-sandbox check  ▸  /Users/me/app

  Grants to add (each allows something this run did that enforce would refuse):
    --allow-net=<host>:5432   # needed by deno
    --allow-read=/Users/me/.gitconfig,/Users/me/app-data   # needed by deno, git

    or, in deno.json "permissions" (add to the set the command uses):
      "net": ["<host>:5432"]
      "read": ["/Users/me/.gitconfig","/Users/me/app-data"]

    <host>: the kernel reports the port, not the name. Put the host the program connects to there.

  Refused whatever is granted (change the program, or keep this command out of enforce):
    - mach-lookup com.apple.windowserver.active (Chrome): no permission grants this: the kernel sandbox refuses it for native code and child processes

  Programs this run starts:
    - git: it reads its configuration (grant --allow-read=<home>/.gitconfig) and, for SSH remotes, the agent socket (--allow-net=unix:$SSH_AUTH_SOCK)
```

It exits 1 when it found anything, so it can gate a CI job. `--json` prints the same data for a
script.

**On Linux** the check reports the rules the kernel can't hold and the advisories for the programs
the run starts, but not what native code and child processes do: Linux has no report-only mode
for file rules. The check says so, and tells you to do one of
[two things](/docs/kernel-sandbox-warn#finding-them-on-linux): run the command once with
`--kernel-sandbox=enforce` where a failure is harmless, or run the check on a Mac.

### 3. Add the grants

For each line under "Grants to add", decide:

- **Grant it.** Add the value to the flag on the command, or to the permission set in `deno.json`.
  Widen a file to its folder when the program reads many files there. Prefer the narrowest thing
  that is still stable (a cache folder, not your home directory).
- **Don't grant it.** If the program shouldn't have that access (a build script reading
  `~/.aws`), the sandbox just told you something useful. Change the program or its configuration
  so it stops asking: point a tool at a config file inside the project, pass a token in an
  environment variable you grant with `--allow-env`.

A grant with a **caution** is a path that usually holds credentials (`~/.ssh`, `~/.npmrc`,
`~/.netrc`). Granting it lets every program the run starts read it. That was already true without
the sandbox; granting it keeps it true on purpose.

The common ones:

| The run uses                       | It needs                                                                                                                        |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `git` (any command)                | `--allow-read=<repo>,<home>/.gitconfig`; for writes, `--allow-write=<repo>`                                                     |
| `git` over SSH, `ssh`, `scp`       | also `--allow-read=<home>/.ssh` and `--allow-net=unix:$SSH_AUTH_SOCK` for the agent                                             |
| `npm`, `pnpm`, `yarn` as a child   | `--allow-read=<home>/.npmrc` if it should use your registry tokens, and write on its cache folder                               |
| `docker`, `podman`                 | `--allow-net=unix:/var/run/docker.sock` (that socket is usually root on the host)                                               |
| A browser (Puppeteer, Playwright)  | start it with `--no-sandbox`, as in a container: a browser's own sandbox can't start inside another one                         |
| A compiler (`cc`, `rustc`, `go`)   | write on its temp and cache folders (`--allow-write=<tmp>,<cache>`)                                                             |
| A native addon that unpacks itself | read and `--allow-ffi` on the folder it unpacks to (`~/.cache/<package>`)                                                       |
| `sudo`, `ping` on old systems      | nothing helps: a confined process tree never gains privileges. Run that step outside the confined command.                      |
| A database or API by host name     | the host and port in `--allow-net`. On Linux a host name needs the Mode B supervisor; until a runtime has it, grant by address. |

[Troubleshooting](/docs/kernel-sandbox-troubleshooting) has the symptom for each, and the full
list of what changes for programs is in the
[overview](/docs/kernel-sandbox#what-changes-for-programs).

### 4. Run it enforced

Once the check is clean, run the command enforced yourself, before a default does it for you:

```json
{
  "tasks": {
    "start": "deno run --kernel-sandbox=enforce --allow-net --allow-read --allow-env --allow-write=.denext jsr:@denext/denext/cli start ."
  }
}
```

Put the flag on the command, not in `deno.json`'s `"kernelSandbox"`: that key applies to every
command in the project, and `deno test`, `deno bench` and `denext dev` refuse to start under
`enforce`.

An enforced run that hits something the check missed fails loudly: a Deno operation gets an error
ending in `(refused by the kernel sandbox; see --kernel-sandbox-report)`, and a child that exits
non-zero prints a hint that names the sandbox. Add the grant and run again.

### 5. Choose what the project says

Write the decision down, so the defaults changing later changes nothing for you:

| You want                                                                       | Write                                                       |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| This command enforced now, and to fail if the kernel can't hold a rule         | `--kernel-sandbox=enforce` on the command                   |
| This command enforced wherever the runtime can, falling back to warn elsewhere | `--kernel-sandbox=auto` on the command                      |
| The whole project reported on, never refused                                   | `"permissions": { "kernelSandbox": "warn" }` in `deno.json` |
| The whole project left alone                                                   | `"permissions": { "kernelSandbox": "off" }` in `deno.json`  |
| A compiled program left alone                                                  | `deno compile --kernel-sandbox=off …`                       |

`off` in `deno.json` is a visible, reviewable decision, and better than `-A`, which turns Deno's own
checks off as well.

## Turning it down in a hurry

A deploy that breaks at 2 a.m. needs a switch that doesn't involve editing a command line:

```sh
DENO_KERNEL_SANDBOX=warn denext task start     # report, refuse nothing
DENO_KERNEL_SANDBOX=off  denext task start     # no kernel layer
```

- It takes `off` or `warn` and **only lowers** the mode. It can't turn the sandbox on.
- It is read from the real environment before any `--env-file`, so a project's `.env` can't set it.
- A `--kernel-sandbox` flag on the command wins over it; remove the flag instead.
- **A compiled program ignores it.** Its mode is its author's. Rebuild with
  `deno compile --kernel-sandbox=warn` (or `off`).
- It can't widen a sandbox a process is already inside: a child of an enforced process stays
  confined whatever the variable says.

Then find the missing grant with `denext kernel-sandbox check`, add it, and remove the variable.

## Compiled programs: prompts become refusals

A compiled program's permissions are baked in by its author, so it counts as fixed even on a
terminal. If you ship a program that relied on **prompting** for a permission it doesn't bake in,
that prompt becomes a refusal once compiled programs are enforced. Either bake the permission in
(`deno compile --allow-read=…`), or keep prompting by compiling with `--kernel-sandbox=off`.

## Continuous integration

A CI job has no terminal, so its bare `deno run` commands are the ones the second step enforces.
Three things to do now:

1. Add the check to the pipeline for the commands that spawn programs or load native code:

   ```sh
   denext kernel-sandbox check --timeout 120 -- deno run --allow-run --allow-read=. scripts/ci.ts
   ```

   On macOS runners it reports everything; on Linux runners it reports the startup refusals and
   the advisories.
2. On Linux runners, run the same command with `--kernel-sandbox=enforce` in a job that is allowed
   to fail, and read its output.
3. Keep `DENO_KERNEL_SANDBOX=warn` ready as a pipeline variable. It turns a broken pipeline back on
   in one setting while you add the grant.

The one notice a bare run prints in the first step tells you a command is on this list. It prints
once per policy per machine, and only for a run that grants `--allow-run` or `--allow-ffi` or has
a rule the kernel can't hold. Setting any mode, in the flag, `deno.json` or the variable, makes the
choice yours and the notice goes away.

## What `denext upgrade` tells you

`denext upgrade` looks at the project's tasks. When a task's `deno run` or `deno serve` grants
`--allow-run` or `--allow-ffi` under a partial grant, and neither the task nor `deno.json` chooses a
mode, it prints a note naming those tasks and the check to run:

```text
Kernel sandbox: the `release` task starts programs or native code under a fixed grant. A later release holds such runs' child processes and native code to that grant with the kernel.
  See what would be refused, with nothing refused: denext kernel-sandbox check --task release
  Guide: https://denext.dev/docs/kernel-sandbox-migrating
```

It doesn't edit your permissions or choose a mode for you. Choosing one (step 5) makes the note go
away.

## Checklist

- [ ] `denext kernel-sandbox` on each kind of machine the app runs on: every rule of the grant can
      be held, or you know which can't.
- [ ] `denext kernel-sandbox check` on the `start` task and on each script that spawns programs or
      loads native code, with the app exercised.
- [ ] On Linux: one enforced run of each of those where a failure is harmless.
- [ ] Each reported grant added, or the program changed so it doesn't need it.
- [ ] A browser started with `--no-sandbox`; no `sudo` inside a confined command.
- [ ] The mode written down: on the command, or in `deno.json`.
- [ ] `DENO_KERNEL_SANDBOX=warn` known to whoever is on call.
